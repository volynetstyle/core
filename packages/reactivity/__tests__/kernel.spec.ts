import {
  type ComputedRef,
  EffectFlags,
  computed,
  effect,
  reactive,
  ref,
  shallowRef,
  toRaw,
  triggerRef,
} from '../src'
import { getDepFromReactive } from '../src/dep'
import { resetStats, stats } from '../src/stats'
import {
  type ReactiveNode,
  endBatch,
  isKernelIdle,
  startBatch,
} from '../src/system'

// The kernel as structure: versions, and how far a push and a check walk.

const range = (n: number) => Array.from({ length: n }, (_, i) => i)

const versionOf = (node: object) => (node as ReactiveNode).version!

describe('reactivity/kernel', () => {
  describe('versions', () => {
    it('should advance the version of a dep once per change', () => {
      const state = reactive({ a: 1 })
      effect(() => state.a)
      const dep = getDepFromReactive(toRaw(state), 'a')!
      const before = versionOf(dep)
      state.a = 2
      state.a = 2
      expect(versionOf(dep)).toBe(before + 1)
    })

    it('should not advance a ref set back within a batch', () => {
      const r = ref(1)
      const spy = vi.fn(() => r.value)
      effect(spy)
      const before = versionOf(r)
      startBatch()
      r.value = 2
      r.value = 1
      endBatch()
      expect(spy).toHaveBeenCalledTimes(1)
      expect(versionOf(r)).toBe(before)
    })

    it('should advance a computed only when its value changes', () => {
      const r = ref(1)
      const c = computed(() => r.value % 2)
      effect(() => c.value)
      const before = versionOf(c)
      r.value = 3
      expect(versionOf(c)).toBe(before)
      r.value = 4
      expect(versionOf(c)).toBe(before + 1)
    })

    it('should advance a forced ref', () => {
      const r = shallowRef({ n: 1 })
      const spy = vi.fn(() => r.value.n)
      effect(spy)
      const before = versionOf(r)
      r.value.n = 2
      triggerRef(r)
      expect(spy).toHaveBeenCalledTimes(2)
      expect(versionOf(r)).toBe(before + 1)
    })
  })

  describe('push', () => {
    it('should prove a first read of a shared dep new without an index', () => {
      const sources = range(64).map(i => ref(i))
      // every source has one other subscriber
      effect(() => sources.forEach(s => s.value))
      resetStats()
      effect(() => sources.forEach(s => s.value))
      expect(stats.links).toBe(64)
      expect(stats.indexes).toBe(0)
    })

    it('should visit each link below a change at most once', () => {
      // a lattice: every node of a layer reads every node of the layer above
      const width = 8
      const depth = 6
      const s = ref(0)
      let layer: ComputedRef<number>[] = range(width).map(i =>
        computed(() => s.value + i),
      )
      let links = width
      for (let d = 1; d < depth; d++) {
        const above = layer
        layer = range(width).map(() =>
          computed(() => above.reduce((sum, c) => sum + c.value, 0)),
        )
        links += width * width
      }
      const last = layer
      effect(() => last.forEach(c => c.value))
      links += width
      resetStats()
      s.value++
      expect(stats.marks).toBeLessThanOrEqual(links)
      expect(isKernelIdle()).toBe(true)
    })

    it('should not walk below a node it has marked already', () => {
      const s = ref(0)
      const c = computed(() => s.value)
      const below = range(64).map(() => computed(() => c.value))
      effect(() => below.forEach(b => b.value))
      resetStats()
      startBatch()
      s.value++
      const first = stats.marks
      s.value++
      endBatch()
      // the second write stops at the computed the first one marked
      expect(stats.marks - first).toBe(1)
    })
  })

  describe('recursion', () => {
    it('should pass a later push through a computed a run left Pending', () => {
      const s = ref(0)
      const c = computed(() => s.value)
      const seen: number[] = []
      let first = true
      effect(() => {
        seen.push(c.value)
        // writes (without reading) a dep of a computed this run has read:
        // the push stops at the running effect, the computed stays Pending
        if (first) {
          first = false
          s.value = 1
        }
      })
      s.value = 10
      s.value = 20
      expect(seen).toEqual([0, 10, 20])
    })

    it('should not run again an allowRecurse effect whose run threw', () => {
      const s = ref(0)
      let runs = 0
      const runner = effect(() => {
        runs++
        if (s.value > 0) {
          s.value++
          throw new Error('e')
        }
      })
      runner.effect.flags |= EffectFlags.ALLOW_RECURSE
      expect(() => s.value++).toThrow('e')
      expect(runs).toBe(2)
    })
  })

  describe('pull', () => {
    it('should not bring up to date a dep read only behind a changed one', () => {
      const flag = ref(true)
      const s = ref(0)
      const getter = vi.fn(() => s.value)
      const c = computed(getter)
      const spy = vi.fn(() => (flag.value ? c.value : 0))
      effect(spy)
      expect(getter).toHaveBeenCalledTimes(1)
      startBatch()
      s.value++
      flag.value = false
      endBatch()
      // the flag decided first: the computed of the dropped branch never ran
      expect(spy).toHaveBeenCalledTimes(2)
      expect(getter).toHaveBeenCalledTimes(1)
    })

    it('should stop a check at the first dep that changed', () => {
      const s = ref(0)
      const first = computed(() => s.value)
      const rest = range(32).map(i => computed(() => s.value + i))
      let checksBeforeRun = -1
      const spy = vi.fn(() => {
        checksBeforeRun = stats.checks
        first.value
        rest.forEach(c => c.value)
      })
      effect(spy)
      resetStats()
      s.value++
      expect(spy).toHaveBeenCalledTimes(2)
      // the first dep changed: the check visited it and its one dep alone
      expect(checksBeforeRun).toBe(2)
      expect(isKernelIdle()).toBe(true)
    })

    it('should not run a computed again for a ref it settled itself', () => {
      const r = ref(0)
      const s = ref(0)
      const parity = computed(() => s.value % 2)
      // set before anything reads it: the first read settles it
      r.value = 1
      const getter = vi.fn(() => r.value + parity.value)
      const c = computed(getter)
      effect(() => c.value)
      s.value += 2
      expect(getter).toHaveBeenCalledTimes(1)
    })

    it('should not run a sub whose Pending deps did not change', () => {
      const s = ref(0)
      const parity = computed(() => s.value % 2)
      const chain = range(16).reduce<ComputedRef<number>>(
        prev => computed(() => prev.value),
        parity,
      )
      const spy = vi.fn(() => chain.value)
      effect(spy)
      resetStats()
      s.value += 2
      expect(spy).toHaveBeenCalledTimes(1)
      // one run: the parity; the chain above it is only checked
      expect(stats.runs).toBe(1)
      expect(isKernelIdle()).toBe(true)
    })
  })

  describe('failure', () => {
    it('should run a computed again after it threw', () => {
      const fail = ref(true)
      const getter = vi.fn(() => {
        if (fail.value) throw new Error('c')
        return 1
      })
      const c = computed(getter)
      expect(() => c.value).toThrow('c')
      // owes a run: it does not serve a value it never computed
      expect(() => c.value).toThrow('c')
      expect(getter).toHaveBeenCalledTimes(2)
      fail.value = false
      expect(c.value).toBe(1)
      expect(isKernelIdle()).toBe(true)
    })

    it('should keep the deps of the last success across a failed run', () => {
      const x = ref(0)
      const y = ref(0)
      let runs = 0
      effect(() => {
        runs++
        x.value
        if (runs === 2) throw new Error('e')
        y.value
      })
      expect(() => x.value++).toThrow('e')
      // y was not read by the failed run, it still wakes the effect
      y.value++
      expect(runs).toBe(3)
    })

    it('should drop the deps an earlier failed run read alone', () => {
      const mode = ref(0)
      const deps = [ref(0), ref(0), ref(0)]
      const getter = vi.fn(() => {
        const m = mode.value
        if (m > 0) {
          deps[m - 1].value
          throw new Error('c' + m)
        }
        return deps[2].value
      })
      const c = computed(getter)
      effect(() => {
        try {
          c.value
        } catch {}
      })
      // the effect's check runs the computed, outside its try
      expect(() => (mode.value = 1)).toThrow('c1')
      // the effect runs now: the failure is inside its try
      mode.value = 2
      expect(getter).toHaveBeenCalledTimes(3)
      const node = c as unknown as ReactiveNode
      const read = new Set<unknown>()
      for (let l = node.deps; l !== undefined; l = l.nextDep) read.add(l.dep)
      // the last success read mode and deps[2]; the last failure mode and
      // deps[1]; deps[0] was read by an earlier failure only
      expect(read).toEqual(new Set([mode, deps[1], deps[2]]))
      expect((deps[0] as unknown as ReactiveNode).subs).toBeUndefined()
    })

    it('should leave the node whose dep threw in a check owing a run', () => {
      const state = reactive<any>({ x: { y: 1 } })
      // a direct sub of a reactive key: Dirty, run in the check
      const c1 = computed(() => state.x.y)
      const c2 = computed(() => c1.value + 1)
      effect(() => c2.value)
      expect(() => (state.x = undefined)).toThrow(TypeError)
      // c2 does not serve the value it had before
      expect(() => c2.value).toThrow(TypeError)
      state.x = { y: 5 }
      expect(c2.value).toBe(6)
    })

    it('should leave every node of a throwing check owing a run', () => {
      const x = ref<any>({ y: 1 })
      const c1 = computed(() => x.value.y)
      const c2 = computed(() => c1.value + 1)
      const c3 = computed(() => c2.value + 1)
      const seen: unknown[] = []
      effect(() => seen.push(c3.value))
      expect(() => (x.value = undefined)).toThrow(TypeError)
      for (const c of [c1, c2, c3]) {
        expect((c as unknown as ReactiveNode).flags & 16).toBe(16)
      }
      expect(isKernelIdle()).toBe(true)
      // the effect whose check threw is notified again by the next push
      x.value = { y: 5 }
      expect(seen).toEqual([3, 7])
    })

    it('should run a reader that caught a failed read once the dep recovers', () => {
      const fail = ref(false)
      const poke = ref(0)
      const c = computed(() => {
        if (fail.value) throw new Error('c')
        return 1
      })
      const seen: unknown[] = []
      effect(() => {
        poke.value
        try {
          seen.push(c.value)
        } catch {
          seen.push('error')
        }
      })
      expect(() => (fail.value = true)).toThrow('c')
      poke.value++
      expect(seen).toEqual([1, 'error'])
      // back to the value it had before: only the computed wakes the reader,
      // which saw an error since
      fail.value = false
      expect(seen).toEqual([1, 'error', 1])
    })
  })
})
