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
  'fan-in.computed-1000': {
    note: 'one computed reads 1000 refs; each step writes one of them',
    setup(r) {
      const sources = range(1000).map(i => r.ref(i))
      const c = r.computed(() => {
        let sum = 0
        for (let i = 0; i < 1000; i++) sum += sources[i].value
        return sum
      })
      let out = 0
      r.effect(() => {
        out = c.value
      })
      let i = 0
      return () => {
        sources[(i * 7919) % 1000].value = ++i
        return out
      }
    },
  },
  'fan-in.check-1000': {
    note: 'an effect reads 1000 computeds of one ref each; one of them changes',
    setup(r) {
      const sources = range(1000).map(i => r.ref(i))
      const cs = sources.map(s => r.computed(() => s.value & 1))
      let out = 0
      r.effect(() => {
        let sum = 0
        for (let i = 0; i < 1000; i++) sum += cs[i].value
        out = sum
      })
      let i = 0
      return () => {
        // half the writes keep the parity: the check finds nothing
        sources[(i * 7919) % 1000].value += 1 + (i++ & 1)
        return out
      }
    },
  },
  'failure.recover': {
    // The oracle serves stale values after a failure where this kernel runs
    // again: the builds do different work, the step returns no checksum.
    note: 'a computed throws every other step; an effect catches and recovers',
    setup(r) {
      const s = r.ref(0)
      const c = r.computed(() => {
        if (s.value & 1) throw new Error('odd')
        return s.value
      })
      let out = 0
      r.effect(() => {
        try {
          out = c.value
        } catch {
          out = -1
        }
      })
      let i = 0
      return () => {
        try {
          s.value = ++i
        } catch {}
        return 0
      }
    },
  },
  'failure.check-throws': {
    // no checksum, as failure.recover
    note: 'the check of a watcher throws every other step (caught at the write)',
    setup(r) {
      const s = r.ref(0)
      const deps = range(16).map(i => r.ref(i))
      const c = r.computed(() => {
        let sum = 0
        for (const d of deps) sum += d.value
        if (s.value % 2) throw new Error('odd')
        return sum + s.value
      })
      let out = 0
      r.effect(() => {
        out = c.value
      })
      let i = 0
      return () => {
        try {
          s.value = ++i
        } catch {
          out = -1
        }
        return out & 0
      }
    },
  },
  'real.todos-1000': {
    note: 'a reactive list of 1000 todos, filters, a count and 100 row effects',
    setup(r) {
      const todos = r.reactive(
        range(1000).map(i => ({ id: i, text: 't' + i, done: i % 3 === 0 })),
      )
      const filter = r.ref('all')
      const visible = r.computed(() =>
        filter.value === 'all'
          ? todos
          : todos.filter(t => t.done === (filter.value === 'done')),
      )
      const left = r.computed(() => todos.filter(t => !t.done).length)
      let out = 0
      r.effect(() => {
        out = left.value
      })
      for (let k = 0; k < 100; k++) {
        r.effect(() => {
          const t = visible.value[k]
          out = (out + (t ? (t.done ? 1 : 0) + t.text.length : 0)) | 0
        })
      }
      let i = 0
      return () => {
        i++
        const t = todos[(i * 31) % todos.length]
        t.done = !t.done
        if (i % 50 === 0) filter.value = ['all', 'done', 'active'][(i / 50) % 3]
        return out
      }
    },
  },
  'real.components-200': {
    note: '200 components (scopes) on a store; updates, one remount per step',
    setup(r) {
      const store = r.reactive({
        user: { name: 'a', age: 1 },
        items: range(50).map(i => ({ id: i, price: i })),
        theme: 'light',
      })
      let out = 0
      /** @param {number} k */
      const mount = k => {
        const scope = r.effectScope()
        scope.run(() => {
          const item = r.computed(() => store.items[k % 50])
          const label = r.computed(
            () => `${store.user.name}:${item.value.price}:${store.theme}`,
          )
          r.effect(() => {
            out = (out + label.value.length) | 0
          })
          r.watch(
            () => item.value.price,
            v => {
              out = (out + v) | 0
            },
          )
        })
        return scope
      }
      const scopes = range(200).map(mount)
      let i = 0
      return () => {
        i++
        store.items[i % 50].price = i
        if (i % 7 === 0) store.user.name = 'n' + (i & 15)
        if (i % 97 === 0) store.theme = i & 1 ? 'dark' : 'light'
        const k = (i * 13) % 200
        scopes[k].stop()
        scopes[k] = mount(k)
        return out
      }
    },
  },
  'real.deep-watch': {
    note: 'a deep watcher over a nested object of 300 leaves; one leaf per step',
    setup(r) {
      const state = r.reactive({
        groups: range(30).map(g => ({
          name: 'g' + g,
          rows: range(10).map(k => ({ v: g * 10 + k })),
        })),
      })
      let out = 0
      r.watch(
        state,
        () => {
          out++
        },
        { deep: true },
      )
      let i = 0
      return () => {
        i++
        state.groups[i % 30].rows[(i * 7) % 10].v = i
        return out
      }
    },
  },
  'real.keyed-list-500': {
    note: 'effects over a keyed list of 500 rows; swaps rows and edits labels',
    setup(r) {
      const rows = r.reactive(range(500).map(i => ({ id: i, label: 'r' + i })))
      const selected = r.ref(-1)
      let out = 0
      // a list effect reading every row, and a row effect per visible row
      r.effect(() => {
        let sum = 0
        for (const row of rows) sum += row.id
        out = sum
      })
      for (let k = 0; k < 50; k++) {
        r.effect(() => {
          const row = rows[k]
          out =
            (out + row.label.length + (selected.value === row.id ? 1 : 0)) | 0
        })
      }
      let i = 0
      return () => {
        i++
        const a = (i * 17) % 500
        const b = (i * 29) % 500
        const tmp = rows[a]
        rows[a] = rows[b]
        rows[b] = tmp
        rows[i % 500].label = 'x' + i
        selected.value = i % 50
        return out
      }
    },
  },
}
