import {
  type ComputedRef,
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
})
