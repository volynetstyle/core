import { describe } from 'vite-plus/test'
import { test } from '../../../scripts/bench'
import type { ComputedRef, Ref } from '../src'
import * as reactivity from '../dist/reactivity.esm-browser.prod'

const { computed, ref } = reactivity

declare module '../dist/reactivity.esm-browser.prod' {
  function computed(...args: any[]): any
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i)

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

describe('tracking', () => {
  {
    const sources = range(256).map(i => ref(i))
    const c = ordered(sources, [range(256)], ref(0))
    c.value
    let i = 0
    test('stable: 256 deps in the same order', async ({ benchmark }) => {
      await benchmark(() => {
        sources[i++ & 255].value = -i
        c.value
      })
    })
  }

  {
    const sources = range(256).map(i => ref(i))
    const orders = range(256).map(r => range(256).map(k => (k + r) & 255))
    const tick = ref(0)
    const c = ordered(sources, orders, tick)
    c.value
    let i = 0
    test('rotate: 256 deps, order rotates by one', async ({ benchmark }) => {
      await benchmark(() => {
        tick.value = ++i
        c.value
      })
    })
  }

  {
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
    cs.forEach(c => c.value)
    let i = 0
    test('swap: 32 computeds share 256 deps, two neighbours swap', async ({
      benchmark,
    }) => {
      await benchmark(() => {
        tick.value = ++i
        for (let k = 0; k < cs.length; k++) cs[k].value
      })
    })
  }

  {
    const sources = range(256).map(i => ref(i))
    const orders = range(16).map(k => permutation(256, 1234 + k))
    const tick = ref(0)
    const c = ordered(sources, orders, tick)
    c.value
    let i = 0
    test('shuffle: 256 private deps, random order', async ({ benchmark }) => {
      await benchmark(() => {
        tick.value = ++i
        c.value
      })
    })
  }

  {
    const sources = range(64).map(i => ref(i))
    const orders = range(16).map(k => permutation(64, 0x9e3779b9 + k))
    const tick = ref(0)
    const cs = range(32).map(j => ordered(sources, orders, tick, j))
    cs.forEach(c => c.value)
    let i = 0
    test('shuffle: 32 computeds share 64 deps, random order', async ({
      benchmark,
    }) => {
      await benchmark(() => {
        tick.value = ++i
        for (let k = 0; k < cs.length; k++) cs[k].value
      })
    })
  }
})
