// @ts-check
// Memory scenarios. A `retained` scenario builds `n` units and keeps them
// alive: the worker reports heap bytes per unit. A `churn` scenario runs
// `step` repeatedly and keeps nothing: the worker reports heap growth per
// step between two equal halves (bytes; ~0 when nothing leaks).

// A `promotion` scenario runs `step` with only minor GCs: the old-space
// growth per step is what scavenges could not free, e.g. dead objects a dead
// but old link still points at (they live until a major GC).

/** @typedef {{ unit: string, retained?: (R: any) => { n: number, keep: unknown }, churn?: (R: any) => () => void, promotion?: (R: any) => () => void }} Scenario */

/** @type {Record<string, Scenario>} */
export const scenarios = {
  'ref (untracked)': {
    unit: 'B / ref',
    retained: R => {
      const n = 100_000
      const keep = Array.from({ length: n }, (_, i) => R.ref(i))
      return { n, keep }
    },
  },
  'ref read by an effect': {
    unit: 'B / ref+link',
    retained: R => {
      const n = 50_000
      const refs = Array.from({ length: n }, (_, i) => R.ref(i))
      const runner = R.effect(() => {
        for (const r of refs) r.value
      })
      return { n, keep: [refs, runner] }
    },
  },
  'reactive key read': {
    unit: 'B / dep+link',
    retained: R => {
      const n = 50_000
      /** @type {Record<string, number>} */
      const raw = {}
      for (let i = 0; i < n; i++) raw['k' + i] = i
      const state = R.reactive(raw)
      const runner = R.effect(() => {
        for (let i = 0; i < n; i++) state['k' + i]
      })
      return { n, keep: [state, runner] }
    },
  },
  'computed chain': {
    unit: 'B / computed',
    retained: R => {
      const n = 20_000
      const s = R.ref(0)
      const chain = [R.computed(() => s.value)]
      for (let i = 1; i < n; i++) {
        const prev = chain[i - 1]
        chain.push(R.computed(() => prev.value + 1))
        chain[i].value
      }
      const runner = R.effect(() => chain[n - 1].value)
      s.value++
      return { n, keep: [chain, runner] }
    },
  },
  'effect on one ref': {
    unit: 'B / effect',
    retained: R => {
      const n = 50_000
      const keep = Array.from({ length: n }, (_, i) => {
        const r = R.ref(i)
        return R.effect(() => r.value)
      })
      return { n, keep }
    },
  },
  'fanout (one ref)': {
    unit: 'B / effect+link',
    retained: R => {
      const n = 50_000
      const s = R.ref(0)
      const keep = Array.from({ length: n }, () => R.effect(() => s.value))
      return { n, keep: [s, keep] }
    },
  },
  'scope create/stop': {
    unit: 'B / step',
    churn: R => {
      const shared = Array.from({ length: 16 }, (_, i) => R.ref(i))
      let tick = 0
      return () => {
        const scope = R.effectScope()
        scope.run(() => {
          for (let k = 0; k < 20; k++) {
            const c = R.computed(() => shared[(k + tick) & 15].value + 1)
            R.effect(() => c.value + shared[k & 15].value)
            R.watch(
              () => shared[(k * 3) & 15].value,
              () => {},
            )
          }
        })
        shared[tick & 15].value++
        tick++
        scope.stop()
      }
    },
  },
  'branch toggle': {
    unit: 'B / step',
    churn: R => {
      const flag = R.ref(true)
      const a = Array.from({ length: 32 }, (_, i) => R.ref(i))
      const b = Array.from({ length: 32 }, (_, i) => R.ref(i))
      const c = R.computed(() =>
        (flag.value ? a : b).reduce((s, r) => s + r.value, 0),
      )
      R.effect(() => c.value)
      return () => {
        flag.value = !flag.value
      }
    },
  },
  'reorder (indexed runs)': {
    unit: 'B / step',
    churn: R => {
      const n = 64
      const sources = Array.from({ length: n }, (_, i) => R.ref(i))
      // other subscribers: lookups through the deps cannot decide
      for (let k = 0; k < 10; k++) R.effect(() => sources.forEach(s => s.value))
      const tick = R.ref(0)
      const c = R.computed(() => {
        const t = tick.value
        let sum = 0
        for (let i = 0; i < n; i++) sum += sources[(i * 17 + t * 29) % n].value
        return sum
      })
      R.effect(() => c.value)
      return () => {
        tick.value++
      }
    },
  },
  'failing computed': {
    unit: 'B / step',
    churn: R => {
      const pick = R.ref(0)
      const deps = Array.from({ length: 64 }, (_, i) => R.ref(i))
      const c = R.computed(() => {
        // every failed run reads another dep before it throws
        deps[pick.value & 63].value
        if (pick.value % 4 !== 0) throw new Error('c')
        return pick.value
      })
      R.effect(() => {
        try {
          c.value
        } catch {}
      })
      return () => {
        try {
          pick.value++
        } catch {}
      }
    },
  },
  'effect turnover (minor GC)': {
    unit: 'B promoted / step',
    promotion: R => {
      // an old source; effects subscribe and stop in a sliding window
      const s = R.ref(0)
      const live = Array.from({ length: 32 }, () => R.effect(() => s.value))
      return () => {
        const payload = { a: 1, b: [1, 2, 3, 4] }
        live.push(R.effect(() => s.value + payload.a))
        live.shift().effect.stop()
      }
    },
  },
  'branch turnover (minor GC)': {
    unit: 'B promoted / step',
    promotion: R => {
      // an old computed switches between fresh sources every step
      const flag = R.ref(0)
      /** @type {any[]} */
      let sources = [R.ref(0), R.ref(1)]
      const c = R.computed(() => sources[flag.value & 1].value)
      R.effect(() => c.value)
      return () => {
        sources = [R.ref(0), R.ref(1)]
        flag.value++
      }
    },
  },
}
