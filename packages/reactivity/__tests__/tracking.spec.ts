import { type ComputedRef, type Ref, computed, effect, ref } from '../src'
import { resetStats, stats } from '../src/stats'
import type { ReactiveNode } from '../src/system'

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
      // one walk over the unread links per run at most: linear, not d²
      expect(stats.sweeps).toBeLessThanOrEqual(64)
      expectGraph(c as any)
    })

    it('should not mark a run that is not the first subscriber of its deps', () => {
      const sources = range(32).map(i => ref(i))
      computed(() => sources.reduce((sum, s) => sum + s.value, 0)).value
      const tick = ref(0)
      const orders = range(16).map(k => permutation(32, 55 + k))
      const c = ordered(sources, orders, tick)
      c.value
      resetStats()
      tick.value = 1
      c.value
      // marking would make every later lookup walk the other sub's links
      expect(stats.lookups).toBeGreaterThan(0)
      expect(stats.sweeps).toBe(0)
    })

    it.fails('should reuse every link when shared reads shuffle', () => {
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
      cs.forEach(c => expectGraph(c as any))
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

    it('should start over a marked run its effect runs again within', () => {
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
})
