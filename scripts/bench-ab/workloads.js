// @ts-check
// Benchmark workloads over the public @vue/reactivity API. `setup` builds
// the graph outside the measured region and returns one measured step; its
// numeric results are folded into a checksum that every bundle must match.

/** @typedef {typeof import('../../packages/reactivity/src/index')} Reactivity */
/** @typedef {{ note: string, setup: (r: Reactivity) => () => unknown }} Workload */

/** @param {number} n */
const range = n => Array.from({ length: n }, (_, i) => i)

/**
 * @param {number} n
 * @param {number} seed
 */
function permutation(n, seed) {
  const order = range(n)
  let s = seed >>> 0 || 1
  for (let i = n - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    const j = s % (i + 1)
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  return order
}

/**
 * A computed that reads `sources` in the order `orders[tick % length]`.
 * @param {Reactivity} r
 * @param {{ value: number }[]} sources
 * @param {number[][]} orders
 * @param {{ value: number }} tick
 * @param {number} [salt]
 */
function ordered(r, sources, orders, tick, salt = 0) {
  return r.computed(() => {
    const order = orders[(tick.value + salt) % orders.length]
    let sum = 0
    for (let i = 0; i < order.length; i++) sum += sources[order[i]].value
    return sum
  })
}

/** @type {Record<string, Workload>} */
export const workloads = {
  'stable.256': {
    note: 'a computed re-reads 256 refs in the same order; one write per step',
    setup(r) {
      const sources = range(256).map(i => r.ref(i))
      const c = ordered(r, sources, [range(256)], r.ref(0))
      c.value
      let i = 0
      return () => {
        sources[i++ & 255].value = -i
        return c.value
      }
    },
  },
  'rotate.256': {
    note: 'the read order of 256 refs rotates by one per step',
    setup(r) {
      const sources = range(256).map(i => r.ref(i))
      const orders = range(256).map(s => range(256).map(k => (k + s) & 255))
      const tick = r.ref(0)
      const c = ordered(r, sources, orders, tick)
      c.value
      let i = 0
      return () => {
        tick.value = ++i
        return c.value
      }
    },
  },
  'swap.256x32': {
    note: '32 computeds share 256 refs; each step swaps two neighbours',
    setup(r) {
      const n = 256
      const sources = range(n).map(i => r.ref(i))
      const orders = []
      let ranks = range(n)
      for (let k = 0; k < 64; k++) {
        ranks = [...ranks]
        const at = (k * 37) % (n - 1)
        ;[ranks[at], ranks[at + 1]] = [ranks[at + 1], ranks[at]]
        orders.push(ranks)
      }
      const tick = r.ref(0)
      const cs = range(32).map(() => ordered(r, sources, orders, tick))
      cs.forEach(c => c.value)
      let i = 0
      return () => {
        tick.value = ++i
        let sum = 0
        for (let k = 0; k < cs.length; k++) sum += cs[k].value
        return sum
      }
    },
  },
  'shuffle.256': {
    note: 'one computed reads its 256 refs in a random order per step',
    setup(r) {
      const sources = range(256).map(i => r.ref(i))
      const orders = range(16).map(k => permutation(256, 1234 + k))
      const tick = r.ref(0)
      const c = ordered(r, sources, orders, tick)
      c.value
      let i = 0
      return () => {
        tick.value = ++i
        return c.value
      }
    },
  },
  'shared-shuffle.64x32': {
    note: '32 computeds share 64 refs, each in its own random order per step',
    setup(r) {
      const sources = range(64).map(i => r.ref(i))
      const orders = range(16).map(k => permutation(64, 0x9e3779b9 + k))
      const tick = r.ref(0)
      const cs = range(32).map(j => ordered(r, sources, orders, tick, j))
      cs.forEach(c => c.value)
      let i = 0
      return () => {
        tick.value = ++i
        let sum = 0
        for (let k = 0; k < cs.length; k++) sum += cs[k].value
        return sum
      }
    },
  },
  'first-run.shared-32x16': {
    note: 'create, run and stop an effect over 32 refs that 16 effects read',
    setup(r) {
      const sources = range(32).map(i => r.ref(i))
      for (let k = 0; k < 16; k++) {
        r.effect(() => {
          for (let j = 0; j < sources.length; j++) sources[j].value
        })
      }
      return () => {
        const runner = r.effect(() => {
          for (let j = 0; j < sources.length; j++) sources[j].value
        })
        r.stop(runner)
      }
    },
  },
  'first-run.fresh-100': {
    note: 'create 100 refs, then create, run and stop an effect over them',
    setup(r) {
      return () => {
        const refs = []
        for (let i = 0; i < 100; i++) refs.push(r.ref(i))
        const runner = r.effect(() => {
          for (let i = 0; i < 100; i++) refs[i].value
        })
        r.stop(runner)
      }
    },
  },
  'branch.toggle-100': {
    note: 'an effect reads 100 refs behind a flag; each step toggles it',
    setup(r) {
      const refs = range(100).map(i => r.ref(i))
      const toggle = r.ref(true)
      let sum = 0
      r.effect(() => {
        sum = 0
        if (toggle.value) for (let i = 0; i < 100; i++) sum += refs[i].value
      })
      return () => {
        toggle.value = !toggle.value
        return sum
      }
    },
  },
  'write-read.computed': {
    note: 'write a ref, read the computed an effect depends on',
    setup(r) {
      const v = r.ref(0)
      const c = r.computed(() => v.value * 2)
      r.effect(() => c.value)
      let i = 0
      return () => {
        v.value = i++
        return c.value
      }
    },
  },
  'fan-out.effects-1000': {
    note: 'one ref read by 1000 effects; one write per step',
    setup(r) {
      const s = r.ref(0)
      let sum = 0
      for (let k = 0; k < 1000; k++) {
        r.effect(() => {
          sum = (sum + s.value) | 0
        })
      }
      let i = 0
      return () => {
        s.value = ++i
        return sum
      }
    },
  },
  'chain.computed-100': {
    note: 'a write propagates through 100 chained computeds to an effect',
    setup(r) {
      const s = r.ref(0)
      /** @type {{ value: number }} */
      let node = s
      for (let k = 0; k < 100; k++) {
        const prev = node
        node = r.computed(() => prev.value + 1)
      }
      const leaf = node
      let out = 0
      r.effect(() => {
        out = leaf.value
      })
      let i = 0
      return () => {
        s.value = ++i
        return out
      }
    },
  },
  'diamond.8x8': {
    note: '8 layers of 8 computeds, each reading two of the layer above',
    setup(r) {
      const s = r.ref(0)
      let layer = range(8).map(k => r.computed(() => s.value + k))
      for (let l = 1; l < 8; l++) {
        const prev = layer
        layer = range(8).map(k =>
          r.computed(() => prev[k].value + prev[(k + 1) & 7].value),
        )
      }
      const last = layer
      const sink = r.computed(() => last.reduce((sum, c) => sum + c.value, 0))
      sink.value
      let i = 0
      return () => {
        s.value = ++i & 0xffff
        return sink.value
      }
    },
  },
}
