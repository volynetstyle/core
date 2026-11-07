import {
  type ComputedRef,
  computed,
  effect,
  effectScope,
  reactive,
  shallowRef as ref,
  toRaw,
} from '../src/index'
import { getDepFromReactive } from '../src/dep'

describe.skipIf(!global.gc)('reactivity/gc', () => {
  const gc = () => {
    return new Promise<void>(resolve => {
      setTimeout(() => {
        global.gc!()
        resolve()
      })
    })
  }

  // #9233
  it.todo('should release computed cache', async () => {
    const src = ref<{} | undefined>({})
    // @ts-expect-error ES2021 API
    const srcRef = new WeakRef(src.value!)

    let c: ComputedRef | undefined = computed(() => src.value)

    c.value // cache src value
    src.value = undefined // release value
    c = undefined // release computed

    await gc()
    expect(srcRef.deref()).toBeUndefined()
  })

  it.todo('should release reactive property dep', async () => {
    const src = reactive({ foo: 1 })

    let c: ComputedRef | undefined = computed(() => src.foo)

    c.value
    expect(getDepFromReactive(toRaw(src), 'foo')).not.toBeUndefined()

    c = undefined
    await gc()
    await gc()
    expect(getDepFromReactive(toRaw(src), 'foo')).toBeUndefined()
  })

  it('should not release effect for ref', async () => {
    const spy = vi.fn()
    const src = ref(0)

    effect(() => {
      spy()
      src.value
    })

    expect(spy).toHaveBeenCalledTimes(1)

    await gc()
    src.value++
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('should not release effect for reactive', async () => {
    const spy = vi.fn()
    const src = reactive({ foo: 1 })

    effect(() => {
      spy()
      src.foo
    })

    expect(spy).toHaveBeenCalledTimes(1)

    await gc()
    src.foo++
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('should release computed that untrack by effect', async () => {
    const src = ref(0)
    // @ts-expect-error ES2021 API
    const c = new WeakRef(computed(() => src.value))
    const scope = effectScope()

    scope.run(() => {
      effect(() => c.deref().value)
    })

    expect(c.deref()).toBeDefined()
    scope.stop()
    await gc()
    expect(c.deref()).toBeUndefined()
  })

  it('should release computed that untrack by effectScope', async () => {
    const src = ref(0)
    // @ts-expect-error ES2021 API
    const c = new WeakRef(computed(() => src.value))
    const scope = effectScope()

    scope.run(() => {
      c.deref().value
    })

    expect(c.deref()).toBeDefined()
    scope.stop()
    await gc()
    expect(c.deref()).toBeUndefined()
  })

  it('should release a computed whose run indexed its deps', async () => {
    const sources = Array.from({ length: 32 }, (_, i) => ref(i))
    const tick = ref(0)
    // @ts-expect-error ES2021 API
    const c = new WeakRef(
      computed(() => {
        // a new read order every run: the run indexes its deps
        const k = tick.value
        let sum = 0
        for (let i = 0; i < 32; i++) sum += sources[(i * 7 + k * 13) % 32].value
        return sum
      }),
    )
    const runner = effect(() => c.deref().value)
    tick.value++
    runner.effect.stop()
    await gc()
    expect(c.deref()).toBeUndefined()
  })

  it('should release a computed whose last run threw', async () => {
    const src = ref(0)
    const fail = ref(false)
    // @ts-expect-error ES2021 API
    const c = new WeakRef(
      computed(() => {
        src.value
        if (fail.value) throw new Error('c')
        return 1
      }),
    )
    const runner = effect(() => {
      try {
        c.deref().value
      } catch {}
    })
    expect(() => (fail.value = true)).toThrow('c')
    runner.effect.stop()
    await gc()
    expect(c.deref()).toBeUndefined()
    expect((src as any).subs).toBeUndefined()
  })

  it('should release a deep chain of computeds', async () => {
    const src = ref(0)
    // @ts-expect-error ES2021 API
    const first = new WeakRef(computed(() => src.value))
    let last: ComputedRef<number> = first.deref()
    for (let i = 0; i < 20_000; i++) {
      const prev = last
      last = computed(() => prev.value + 1)
      last.value
    }
    const runner = effect(() => last.value)
    last = undefined as any
    // releasing the chain must not recurse once per computed
    runner.effect.stop()
    await gc()
    expect(first.deref()).toBeUndefined()
    expect((src as any).subs).toBeUndefined()
  })

  it('should release an effect stopped in its own run', async () => {
    const src = ref(0)
    const other = ref(0)
    // @ts-expect-error ES2021 API
    const e = new WeakRef(
      effect(() => {
        src.value
        if (src.value > 0) e.deref()!.stop()
        other.value
      }).effect,
    )
    src.value++
    await gc()
    expect(e.deref()).toBeUndefined()
    expect((src as any).subs).toBeUndefined()
    expect((other as any).subs).toBeUndefined()
  })
})
