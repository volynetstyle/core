import {
  type ComputedRef,
  type Ref,
  computed,
  effect,
  reactive,
  ref,
} from '../src'
import { resetStats, stats } from '../src/stats'
import { type ReactiveNode, isIndexIdle, isKernelIdle } from '../src/system'

// Dependency tracking as structure: which links a run keeps, reuses, creates
// and removes. An `it.fails` witness states a bound that the current
// reconciliation does not meet yet.

const range = (n: number) => Array.from({ length: n }, (_, i) => i)

/** A deterministic shuffle of 0..n-1. */
function permutation(n: number, seed: number): number[] {
  const order = range(n)
  let s = seed >>> 0 || 1
  for (let i = n - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    const j = s % (i + 1)
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  return order
}

function depsOf(sub: ReactiveNode): ReactiveNode[] {
  const deps: ReactiveNode[] = []
  for (let link = sub.deps; link !== undefined; link = link.nextDep) {
    deps.push(link.dep)
  }
  return deps
}

/** Each link of `sub` sits in both of its lists, and no dep is linked twice. */
function expectGraph(sub: ReactiveNode): void {
  let prev = undefined
  for (let link = sub.deps; link !== undefined; link = link.nextDep) {
    expect(link.sub).toBe(sub)
    expect(link.prevDep).toBe(prev)
    let subs = 0
    for (let s = link.dep.subs; s !== undefined; s = s.nextSub) {
      if (s === link) subs++
    }
    expect(subs).toBe(1)
    prev = link
  }
  expect(sub.depsTail).toBe(prev)
  const deps = depsOf(sub)
  expect(new Set(deps).size).toBe(deps.length)
}

/** No index outlives its run, and no dep still points into one. */
function expectReleased(deps: object[]): void {
  expect(isIndexIdle()).toBe(true)
  for (const dep of deps) {
    expect((dep as ReactiveNode).indexLink).toBeUndefined()
  }
}

/** Sources read by more subs than a subscriber lookup visits. */
function wide(n: number): Ref<number>[] {
  const sources = range(n).map(i => ref(i))
  for (let k = 0; k < 10; k++) {
    computed(() => sources.reduce((sum, s) => sum + s.value, 0)).value
  }
  return sources
}

/** A computed that reads `sources` in the order `orders[tick % length]`. */
function ordered(
  sources: Ref<number>[],
  orders: number[][],
  tick: Ref<number>,
  salt = 0,
): ComputedRef<number> {
  return computed(() => {
    const order = orders[(tick.value + salt) % orders.length]
    let sum = 0
    for (let i = 0; i < order.length; i++) {
      sum += sources[order[i]].value
    }
    return sum
  })
}

/** Run `passes` more passes of a warmed-up workload; count link churn. */
function churn(passes: number, pass: (i: number) => void) {
  pass(0)
  resetStats()
  for (let i = 1; i <= passes; i++) {
    pass(i)
  }
  return { links: stats.links, unlinks: stats.unlinks }
}

describe('reactivity/tracking', () => {
  it('should track exactly the deps of the last run', () => {
    const flag = ref(true)
    const a = ref(1)
    const b = ref(2)
    const c = computed(() => (flag.value ? a.value : b.value))
    c.value
    expect(depsOf(c as any)).toEqual([flag, a])
    flag.value = false
    c.value
    expect(depsOf(c as any)).toEqual([flag, b])
    expect((a as any).subs).toBeUndefined()
    expectGraph(c as any)
  })

  it('should keep deps in read order', () => {
    const sources = range(8).map(i => ref(i))
    const tick = ref(0)
    const reversed = range(8).reverse()
    const c = ordered(sources, [range(8), reversed], tick)
    c.value
    tick.value = 1
    c.value
    expect(depsOf(c as any)).toEqual([tick, ...reversed.map(i => sources[i])])
    expectGraph(c as any)
  })

  it('should reuse every link when reads keep their order', () => {
    const sources = range(256).map(i => ref(i))
    const c = ordered(sources, [range(256)], ref(0))
    expect(
      churn(64, i => {
        sources[i & 255].value = -i
        c.value
      }),
    ).toEqual({ links: 0, unlinks: 0 })
    expect(stats.hits).toBe(64 * 257)
    expectGraph(c as any)
  })

  describe('reordered reads', () => {
    it('should reuse every link when the read order rotates', () => {
      const sources = range(256).map(i => ref(i))
      const orders = range(256).map(r => range(256).map(k => (k + r) & 255))
      const tick = ref(0)
      const c = ordered(sources, orders, tick)
      expect(
        churn(64, i => {
          tick.value = i
          c.value
        }),
      ).toEqual({ links: 0, unlinks: 0 })
      expectGraph(c as any)
    })

    it('should reuse every link when shared reads swap neighbours', () => {
      const n = 256
      const sources = range(n).map(i => ref(i))
      const orders: number[][] = []
      let ranks = range(n)
      for (let k = 0; k < 64; k++) {
        ranks = [...ranks]
        const at = (k * 37) % (n - 1)
        ;[ranks[at], ranks[at + 1]] = [ranks[at + 1], ranks[at]]
        orders.push(ranks)
      }
      const tick = ref(0)
      const cs = range(32).map(() => ordered(sources, orders, tick))
      expect(
        churn(64, i => {
          tick.value = i
          cs.forEach(c => c.value)
        }),
      ).toEqual({ links: 0, unlinks: 0 })
      cs.forEach(c => expectGraph(c as any))
    })

    it('should reuse every link when private reads shuffle', () => {
      const sources = range(256).map(i => ref(i))
      const orders = range(16).map(k => permutation(256, 1234 + k))
      const tick = ref(0)
      const c = ordered(sources, orders, tick)
      expect(
        churn(64, i => {
          tick.value = i
          c.value
        }),
      ).toEqual({ links: 0, unlinks: 0 })
      // the run is its deps' first subscriber: one walk over its unread
      // links per run at most, and no index
      expect(stats.sweeps).toBeLessThanOrEqual(64)
      expect(stats.indexes).toBe(0)
      expectGraph(c as any)
    })

    it('should index a run whose deps other subs read too', () => {
      const sources = range(32).map(i => ref(i))
      computed(() => sources.reduce((sum, s) => sum + s.value, 0)).value
      const tick = ref(0)
      const orders = range(16).map(k => permutation(32, 55 + k))
      const c = ordered(sources, orders, tick)
      c.value
      resetStats()
      tick.value = 1
      c.value
      // the deps' subscribers cannot prove absence: one index, then exact
      expect(stats.lookups).toBeGreaterThan(0)
      expect(stats.indexes).toBe(1)
    })

    it('should reuse every link when shared reads shuffle', () => {
      const sources = range(64).map(i => ref(i))
      const orders = range(16).map(k => permutation(64, 0x9e3779b9 + k))
      const tick = ref(0)
      const cs = range(32).map(j => ordered(sources, orders, tick, j))
      expect(
        churn(64, i => {
          tick.value = i
          cs.forEach(c => c.value)
        }),
      ).toEqual({ links: 0, unlinks: 0 })
      // one walk over the links per run at most: linear, not d²
      expect(stats.indexes).toBeLessThanOrEqual(64 * 32)
      cs.forEach(c => expectGraph(c as any))
      expectReleased(sources)
    })
  })

  describe('repeated reads', () => {
    it('should link a dep read twice in a row once', () => {
      const a = ref(1)
      const c = computed(() => a.value + a.value)
      c.value
      expect(depsOf(c as any)).toEqual([a])
      expectGraph(c as any)
    })

    it('should link a dep once when a nested run reads it between', () => {
      const a = ref(1)
      const inner = computed(() => a.value)
      resetStats()
      const runner = effect(() => {
        a.value
        inner.value
        a.value
      })
      expect(depsOf(runner.effect)).toEqual([a, inner])
      // found a few links behind the cursor: no search of the subscribers
      expect(stats.lookups).toBe(0)
      expectGraph(runner.effect)
    })

    it('should start over a run of private deps its effect runs again within', () => {
      const sources = range(16).map(i => ref(i))
      const tick = ref(0)
      let reenter = false
      let pass = 0
      const runner = effect(() => {
        tick.value
        // each run, the nested one included, reads its own order
        const order = permutation(16, 7 + pass++)
        for (let k = 0; k < order.length; k++) {
          sources[order[k]].value
          if (reenter && k === 8) {
            reenter = false
            runner()
          }
        }
      })
      resetStats()
      reenter = true
      tick.value = 1
      expect(stats.sweeps).toBeGreaterThan(0)
      expect(new Set(depsOf(runner.effect))).toEqual(
        new Set([tick, ...sources]),
      )
      expectGraph(runner.effect)
    })
  })

  it('should find an array length read again in a loop without an index', () => {
    const arr = reactive(range(50))
    const tick = ref(0)
    const runner = effect(() => {
      tick.value
      for (let i = 0; i < arr.length; i++) arr[i]
    })
    resetStats()
    tick.value++
    // the length's first subscriber: the run marks its unread links once
    expect(stats.indexes).toBe(0)
    expect(stats.sweeps).toBe(1)
    expect(stats.links + stats.unlinks).toBe(0)
    expectGraph(runner.effect)
  })

  it('should link fresh deps without searching for their links', () => {
    const sources = range(64).map(i => ref(i))
    resetStats()
    effect(() => {
      for (const s of sources) {
        s.value
      }
    })
    expect(stats.links).toBe(64)
    expect(stats.lookups).toBe(0)
  })

  describe('indexed runs', () => {
    it('should keep the index of a run across a nested indexed run', () => {
      const n = 12
      const sources = wide(n)
      const tick = ref(0)
      const inner = computed(() => {
        let sum = 0
        for (const i of permutation(n, 300 + tick.value)) {
          sum += sources[i].value
        }
        return sum
      })
      const outer = computed(() => {
        const order = permutation(n, 900 + tick.value)
        let sum = 0
        for (const i of order) {
          sum += sources[i].value
        }
        sum += inner.value
        // Read again after the nested run indexed the same deps: one dep
        // linked before this run indexed, one linked after (in a first run).
        return sum + sources[order[0]].value + sources[order[n - 1]].value
      })
      for (let t = 0; t < 12; t++) {
        tick.value = t
        if (t === 1) {
          resetStats()
        }
        outer.value
        expect(depsOf(outer as any).length).toBe(n + 2)
        expectGraph(outer as any)
        expectGraph(inner as any)
        expectReleased(sources)
      }
      expect(stats.indexes).toBeGreaterThan(0)
      expect(stats.links).toBe(0)
    })

    it('should release the index of an effect stopped in its own run', () => {
      const sources = wide(16)
      const tick = ref(0)
      let stopSelf = false
      const runner = effect(() => {
        const order = permutation(16, 7 + tick.value)
        for (let k = 0; k < order.length; k++) {
          sources[order[k]].value
          if (stopSelf && k === 8) {
            runner.effect.stop()
          }
        }
      })
      resetStats()
      stopSelf = true
      tick.value = 1
      expect(stats.indexes).toBe(1)
      expectReleased(sources)
      sources.forEach(s => s.value++)
      expectReleased(sources)
    })

    it('should not give back the index cell of a link removed meanwhile', () => {
      const n = 16
      const sources = wide(n)
      const tick = ref(0)
      let stopOuter = false
      // eslint-disable-next-line prefer-const
      let runner: ReturnType<typeof effect>
      const inner = computed(() => {
        let sum = 0
        for (const i of permutation(n, 300 + tick.value)) {
          sum += sources[i].value
        }
        if (stopOuter) {
          runner.effect.stop()
        }
        return sum
      })
      runner = effect(() => {
        for (const i of permutation(n, 900 + tick.value)) {
          sources[i].value
        }
        inner.value
      })
      resetStats()
      stopOuter = true
      tick.value = 1
      expect(stats.indexes).toBe(2)
      expectReleased(sources)
      expectGraph(inner as any)
    })

    it('should keep the index of a run its effect runs again from a nested run', () => {
      const n = 16
      const sources = wide(n)
      const tick = ref(0)
      let pass = 0
      let reenter = false
      // eslint-disable-next-line prefer-const
      let runner: ReturnType<typeof effect>
      const inner = computed(() => {
        let sum = 0
        for (const i of permutation(n, 300 + tick.value)) {
          sum += sources[i].value
        }
        if (reenter) {
          reenter = false
          // a run of the effect above, inside this indexed run
          runner()
        }
        return sum
      })
      runner = effect(() => {
        tick.value
        const order = permutation(n, 900 + pass++)
        for (let k = 0; k < n; k++) {
          sources[order[k]].value
          if (k === n >> 1) {
            inner.value
          }
        }
      })
      resetStats()
      reenter = true
      tick.value = 1
      expect(stats.indexes).toBeGreaterThanOrEqual(3)
      expectReleased(sources)
      expect(new Set(depsOf(runner.effect))).toEqual(
        new Set([tick, inner, ...sources]),
      )
      expectGraph(runner.effect)
      expectGraph(inner as any)
    })

    it('should link a fresh dep of an indexed run once when read again', () => {
      const n = 16
      const sources = wide(n)
      const fresh = range(4).map(i => ref(i))
      const tick = ref(0)
      const c = computed(() => {
        let sum = 0
        for (const i of permutation(n, 40 + tick.value)) {
          sum += sources[i].value
        }
        if (tick.value === 1) {
          // never read before: linked after the index, then read again apart
          for (const f of fresh) sum += f.value
          for (const f of fresh) sum += f.value
        }
        return sum
      })
      c.value
      resetStats()
      tick.value = 1
      c.value
      expect(stats.indexes).toBe(1)
      expect(depsOf(c as any).length).toBe(n + 1 + fresh.length)
      expectGraph(c as any)
      expectReleased([...sources, ...fresh])
      tick.value = 2
      c.value
      expect(depsOf(c as any).length).toBe(n + 1)
      expectGraph(c as any)
    })

    it('should start over an indexed run its effect runs again within', () => {
      const sources = wide(16)
      const tick = ref(0)
      let reenter = false
      let pass = 0
      const runner = effect(() => {
        tick.value
        // each run, the nested one included, reads its own order
        const order = permutation(16, 7 + pass++)
        for (let k = 0; k < order.length; k++) {
          sources[order[k]].value
          if (reenter && k === 8) {
            reenter = false
            runner()
          }
        }
      })
      resetStats()
      reenter = true
      tick.value = 1
      expect(stats.indexes).toBeGreaterThan(0)
      expectReleased(sources)
      expect(new Set(depsOf(runner.effect))).toEqual(
        new Set([tick, ...sources]),
      )
      expectGraph(runner.effect)
    })
  })

  describe('shared stacks', () => {
    it('should leave no walk behind when a computed throws in a check', () => {
      const x = ref<any>({ y: 1 })
      const c1 = computed(() => x.value.y)
      const c2 = computed(() => c1.value + 1)
      const c3 = computed(() => c2.value + 1)
      const spy = vi.fn()
      effect(() => spy(c3.value))
      expect(isKernelIdle()).toBe(true)
      expect(() => (x.value = undefined)).toThrow(TypeError)
      expect(isKernelIdle()).toBe(true)
      x.value = { y: 2 }
      expect(isKernelIdle()).toBe(true)
      expect(c3.value).toBe(4)
    })

    it('should walk a deep chain without recursion', () => {
      const s = ref(0)
      let last: ComputedRef<number> = computed(() => s.value)
      for (let i = 0; i < 20_000; i++) {
        const prev = last
        last = computed(() => prev.value + 1)
        // first runs nest (a computed runs the one it reads): warm up in order
        last.value
      }
      const spy = vi.fn()
      effect(() => spy(last.value))
      s.value = 1
      expect(spy).toHaveBeenLastCalledWith(20_001)
      expect(isKernelIdle()).toBe(true)
    })
  })
})
