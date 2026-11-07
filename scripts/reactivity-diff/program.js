// @ts-check
// Generated reactive programs, and an interpreter that runs one against a
// build of @vue/reactivity and returns what it observably did.
//
// A program is plain data, so the same program runs against every build and
// a shrinker can take it apart. `nodes` are created in order (a node reads
// only nodes created before it, so the graph has no cycles); `ops` then
// write, read, batch, stop, pause and flush.
//
// The trace records every observable event: effect and watcher runs with
// the values they read, every run of a computed getter (so a build that
// computes more, or less, than another is caught), values read at the top,
// thrown errors, and, in dev builds, onTrack/onTrigger events.

/** @typedef {{ family: string, seed: number, nodes: any[], ops: any[] }} Program */

/** A deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    int: (/** @type {number} */ n) => Math.floor(next() * n),
    chance: (/** @type {number} */ p) => next() < p,
    pick: (/** @type {any[]} */ xs) => xs[Math.floor(next() * xs.length)],
  }
}

/** Families: what a generated program may do. */
export const families = {
  /** No throws, no writes from reactive code. */
  core: { throws: 0, writes: 0, debug: false, getterWrites: false },
  /** Effects and watchers write sources; allowRecurse effects. */
  recursion: { throws: 0, writes: 0.25, debug: false, getterWrites: false },
  /** Computed getters write sources too (side effects in getters). */
  getterWrites: { throws: 0, writes: 0.25, debug: false, getterWrites: true },
  /** Computeds and effects throw on some values. */
  failure: { throws: 0.3, writes: 0, debug: false, getterWrites: false },
  /** onTrack and onTrigger events (dev builds). */
  debug: { throws: 0, writes: 0, debug: true, getterWrites: false },
  /** All of the above but getter writes. */
  mixed: { throws: 0.15, writes: 0.15, debug: true, getterWrites: false },
}

const SOURCE_KINDS = ['ref', 'ref', 'shallowRef', 'custom', 'reactive', 'array']

/**
 * @param {number} seed
 * @param {keyof typeof families} familyName
 * @returns {Program}
 */
export function generate(seed, familyName) {
  const family = families[familyName]
  const r = rng(seed)
  /** @type {any[]} */
  const nodes = []
  const nodeCount = 6 + r.int(12)
  const sources = () => nodes.flatMap((n, i) => (isSource(n) ? [i] : []))
  const readable = () =>
    nodes.flatMap((n, i) => (isSource(n) || n.kind === 'computed' ? [i] : []))
  const scopes = () => nodes.flatMap((n, i) => (n.kind === 'scope' ? [i] : []))

  let writable = true
  /** @returns {any} */
  const expr = (/** @type {number} */ depth) => {
    const ids = readable()
    if (!ids.length || depth > 3 || r.chance(0.15))
      return { t: 'n', v: r.int(4) }
    const roll = r.int(10)
    if (roll < 4) return read(r.pick(ids))
    if (roll < 6) return { t: 'add', a: expr(depth + 1), b: expr(depth + 1) }
    if (roll < 7) return { t: 'odd', a: expr(depth + 1) }
    if (roll < 9)
      return {
        t: 'if',
        c: expr(depth + 1),
        a: expr(depth + 1),
        b: expr(depth + 1),
      }
    if (family.throws && r.chance(family.throws * 2))
      return { t: 'throw', c: expr(depth + 1), id: r.int(100) }
    if (
      writable &&
      family.writes &&
      r.chance(family.writes * 3) &&
      sources().length
    )
      return write(r.pick(sources()), expr(depth + 1))
    return read(r.pick(ids))
  }
  const read = (/** @type {number} */ n) => {
    const node = nodes[n]
    if (node.kind === 'reactive') {
      if (r.chance(0.2)) return { t: 'keys', n }
      return { t: 'get', n, k: r.int(node.size + 1) }
    }
    if (node.kind === 'array') {
      if (r.chance(0.2)) return { t: 'sum', n }
      return { t: 'get', n, k: r.int(node.size + 1) - 1 }
    }
    return { t: 'get', n }
  }
  const write = (/** @type {number} */ n, /** @type {any} */ e) => {
    const node = nodes[n]
    const k =
      node.kind === 'reactive'
        ? r.int(node.size + 1)
        : node.kind === 'array'
          ? r.int(node.size)
          : undefined
    return { t: 'write', n, k, e }
  }

  for (let i = 0; i < nodeCount; i++) {
    const scope = scopes().length && r.chance(0.4) ? r.pick(scopes()) : -1
    // the last node observes, if nothing did
    const observed = nodes.some(n => n.kind === 'effect' || n.kind === 'watch')
    const roll = i === nodeCount - 1 && !observed ? 6 : r.int(10)
    if (i < 2 || roll < 3) {
      const kind = r.pick(SOURCE_KINDS)
      nodes.push(
        kind === 'reactive' || kind === 'array'
          ? { kind, size: 1 + r.int(3) }
          : { kind, init: r.int(3) },
      )
    } else if (roll < 6) {
      writable = family.getterWrites
      const e = expr(0)
      writable = true
      nodes.push({
        kind: 'computed',
        expr: e,
        scope,
        debug: family.debug && r.chance(0.4),
      })
    } else if (roll < 8) {
      nodes.push({
        kind: 'effect',
        expr: expr(0),
        scope,
        scheduler: r.chance(0.3),
        allowRecurse: family.writes > 0 && r.chance(0.3),
        debug: family.debug && r.chance(0.6),
      })
    } else if (roll < 9) {
      const ids = readable()
      const direct = ids.length && r.chance(0.3) ? r.pick(ids) : -1
      nodes.push({
        kind: 'watch',
        expr: expr(0),
        source: direct,
        scope,
        immediate: r.chance(0.3),
        deep: r.chance(0.2),
      })
    } else {
      nodes.push({ kind: 'scope', scope, detached: r.chance(0.2) })
    }
  }

  const op = (/** @type {number} */ depth) => {
    const roll = r.int(20)
    const ids = sources()
    const any = (/** @type {(n: any) => boolean} */ f) =>
      nodes.flatMap((n, i) => (f(n) ? [i] : []))
    if (roll < 9 && ids.length) {
      const n = r.pick(ids)
      const node = nodes[n]
      if (node.kind === 'array' && r.chance(0.3))
        return r.chance(0.5) ? { o: 'push', n, v: r.int(4) } : { o: 'pop', n }
      if (node.kind === 'reactive' && r.chance(0.2))
        return { o: 'del', n, k: r.int(node.size + 1) }
      if (node.kind === 'shallowRef' && r.chance(0.3))
        return { o: 'trigger', n }
      return { ...write(n, { t: 'n', v: r.int(4) }), o: 'set' }
    }
    if (roll < 11 && depth < 2)
      return {
        o: 'batch',
        ops: Array.from({ length: 1 + r.int(4) }, () => op(depth + 1)),
      }
    if (roll < 13) {
      const cs = any(n => n.kind === 'computed')
      if (cs.length) return { o: 'read', n: r.pick(cs) }
    }
    if (roll < 15) {
      const xs = any(n => ['effect', 'watch', 'scope'].includes(n.kind))
      if (xs.length)
        return { o: r.pick(['pause', 'resume', 'resume']), n: r.pick(xs) }
    }
    if (roll < 16) {
      const xs = any(n => ['effect', 'watch', 'scope'].includes(n.kind))
      if (xs.length) return { o: 'stop', n: r.pick(xs) }
    }
    if (roll < 17) {
      const xs = any(n => n.kind === 'effect')
      if (xs.length) return { o: 'run', n: r.pick(xs) }
    }
    if (roll < 19) return { o: 'flush' }
    return ids.length
      ? { ...write(r.pick(ids), { t: 'n', v: r.int(4) }), o: 'set' }
      : { o: 'flush' }
  }
  const ops = Array.from({ length: 6 + r.int(16) }, () => op(0))
  ops.push({ o: 'flush' })
  return { family: familyName, seed, nodes, ops }
}

/** @param {any} n */
function isSource(n) {
  return ['ref', 'shallowRef', 'custom', 'reactive', 'array'].includes(n.kind)
}

// ----------------------------------------------------------------- running

/** Runs of effects, watchers and computeds per program: a loop guard. */
const RUN_BUDGET = 2000
/** Writes from reactive code per program. */
const WRITE_BUDGET = 40

class Budget extends Error {}

/**
 * @param {any} R a build of @vue/reactivity
 * @param {Program} program
 * @returns {string[]} the trace
 */
export function run(R, program) {
  /** @type {string[]} */
  const trace = []
  const log = (/** @type {string} */ s) => trace.push(s)
  /** @type {any[]} */
  const live = []
  /** @type {Map<object, string>} */
  const names = new Map()
  /** @type {any[]} */
  const queue = []
  let runs = 0
  let writes = 0

  const tick = () => {
    if (++runs > RUN_BUDGET) throw new Budget('run budget')
  }
  const name = (/** @type {any} */ target) => {
    const raw = target && R.toRaw ? R.toRaw(target) : target
    return names.get(raw) ?? names.get(target) ?? '?'
  }
  const debugOptions = (/** @type {string} */ id) => ({
    onTrack: (/** @type {any} */ e) =>
      log(`${id} track ${name(e.target)} ${e.type} ${String(e.key)}`),
    onTrigger: (/** @type {any} */ e) =>
      log(`${id} trigger ${name(e.target)} ${e.type} ${String(e.key)}`),
  })

  /** @returns {number} */
  const evaluate = (/** @type {any} */ e) => {
    switch (e.t) {
      case 'n':
        return e.v
      case 'get': {
        const node = program.nodes[e.n]
        const x = live[e.n]
        if (node.kind === 'reactive') return x['k' + e.k] ?? -1
        if (node.kind === 'array') return e.k < 0 ? x.length : (x[e.k] ?? -1)
        return x.value
      }
      case 'keys': {
        let sum = 0
        for (const k in live[e.n]) sum += live[e.n][k]
        return sum
      }
      case 'sum': {
        let sum = 0
        for (const v of live[e.n]) sum += v
        return sum
      }
      case 'add':
        return (evaluate(e.a) + evaluate(e.b)) % 97
      case 'odd':
        return evaluate(e.a) & 1
      case 'if':
        return evaluate(e.c) & 1 ? evaluate(e.a) : evaluate(e.b)
      case 'throw': {
        const c = evaluate(e.c)
        if (c % 3 === 1) throw new Error('E' + e.id)
        return c
      }
      case 'write': {
        const v = evaluate(e.e)
        if (++writes <= WRITE_BUDGET) assign(e.n, e.k, v)
        return v
      }
    }
    throw new Error('bad expr ' + e.t)
  }

  const assign = (
    /** @type {number} */ n,
    /** @type {number | undefined} */ k,
    /** @type {number} */ v,
  ) => {
    const node = program.nodes[n]
    const x = live[n]
    if (node.kind === 'reactive') x['k' + k] = v
    else if (node.kind === 'array') x[k ?? 0] = v
    else x.value = v
  }

  const describeError = (/** @type {any} */ err) =>
    err instanceof Budget
      ? 'budget'
      : `${err && err.constructor ? err.constructor.name : typeof err}:${err && err.message}`

  const create = (/** @type {any} */ node, /** @type {number} */ i) => {
    switch (node.kind) {
      case 'ref':
        return R.ref(node.init)
      case 'shallowRef':
        return R.shallowRef(node.init)
      case 'custom': {
        let value = node.init
        return R.customRef(
          (/** @type {any} */ track, /** @type {any} */ trigger) => ({
            get() {
              track()
              return value
            },
            set(/** @type {any} */ v) {
              if (v !== value) {
                value = v
                trigger()
              }
            },
          }),
        )
      }
      case 'reactive': {
        /** @type {Record<string, number>} */
        const o = {}
        for (let k = 0; k < node.size; k++) o['k' + k] = k
        return R.reactive(o)
      }
      case 'array':
        return R.reactive(Array.from({ length: node.size }, (_, k) => k))
      case 'computed':
        return R.computed(
          () => {
            tick()
            log(`c${i}#`)
            return evaluate(node.expr)
          },
          node.debug ? debugOptions(`c${i}`) : undefined,
        )
      case 'effect': {
        const id = `e${i}`
        /** @type {any} */
        const options = node.debug ? debugOptions(id) : {}
        if (node.scheduler) {
          options.scheduler = () => {
            log(`${id} scheduled`)
            if (!queue.includes(runner)) queue.push(runner)
          }
        }
        /** @type {any} */
        let runner
        try {
          runner = R.effect(() => {
            tick()
            log(`${id}=${evaluate(node.expr)}`)
          }, options)
        } catch (err) {
          log(`${id} first run threw ${describeError(err)}`)
          if (err instanceof Budget) throw err
          return null
        }
        if (node.allowRecurse)
          runner.effect.flags |= R.EffectFlags.ALLOW_RECURSE
        return runner
      }
      case 'watch': {
        const id = `w${i}`
        const source =
          node.source >= 0
            ? live[node.source]
            : () => {
                tick()
                return evaluate(node.expr)
              }
        return R.watch(
          source,
          (/** @type {any} */ v, /** @type {any} */ old) => {
            tick()
            log(`${id} cb ${show(v)} ${show(old)}`)
          },
          { immediate: node.immediate, deep: node.deep },
        )
      }
      case 'scope':
        return R.effectScope(node.detached)
    }
  }

  const show = (/** @type {any} */ v) =>
    typeof v === 'object' && v !== null ? `{${name(v)}}` : String(v)

  const handleOf = (/** @type {number} */ n) => {
    const node = program.nodes[n]
    const x = live[n]
    if (!x) return null
    if (node.kind === 'effect') return x.effect
    return x
  }

  const apply = (/** @type {any} */ op) => {
    switch (op.o) {
      case 'set':
        return assign(op.n, op.k, op.e.v)
      case 'del':
        delete live[op.n]['k' + op.k]
        return
      case 'push':
        live[op.n].push(op.v)
        return
      case 'pop':
        live[op.n].pop()
        return
      case 'trigger':
        return R.triggerRef(live[op.n])
      case 'read':
        log(`read c${op.n}=${live[op.n].value}`)
        return
      case 'batch':
        R.startBatch()
        try {
          for (const inner of op.ops) step(inner)
        } finally {
          R.endBatch()
        }
        return
      case 'pause':
        return handleOf(op.n)?.pause()
      case 'resume':
        return handleOf(op.n)?.resume()
      case 'stop':
        return handleOf(op.n)?.stop()
      case 'run':
        if (live[op.n]) live[op.n]()
        return
      case 'flush':
        while (queue.length) {
          const runner = queue.shift()
          log(`flush ${name(runner)}`)
          if (runner.effect.dirty) runner()
        }
        return
    }
    throw new Error('bad op ' + op.o)
  }

  const step = (/** @type {any} */ op) => {
    try {
      apply(op)
    } catch (err) {
      if (err instanceof Budget) throw err
      log(`${op.o} threw ${describeError(err)}`)
    }
  }

  try {
    program.nodes.forEach((node, i) => {
      const scope = node.scope >= 0 ? live[node.scope] : null
      const make = () => create(node, i)
      log(`+${node.kind}${i}`)
      try {
        live[i] = scope && scope.active ? scope.run(make) : make()
      } catch (err) {
        if (err instanceof Budget) throw err
        log(`create ${i} threw ${describeError(err)}`)
        live[i] = null
      }
      if (live[i] && typeof live[i] === 'object')
        names.set(R.toRaw(live[i]), `n${i}`)
      if (live[i] && typeof live[i] === 'function') names.set(live[i], `n${i}`)
    })
    program.ops.forEach((op, i) => {
      log(`#${i}`)
      step(op)
    })
  } catch (err) {
    log(`aborted ${describeError(err)}`)
  }
  if (R.activeSub !== undefined) log('leak: activeSub')
  return trace
}

/** The first index where two traces differ, or -1. */
export function firstDifference(
  /** @type {string[]} */ a,
  /** @type {string[]} */ b,
) {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return -1
}

/**
 * Whether two traces differ only in the order of events within an op: the
 * same events, op by op, as multisets. (Subscribers notified in another
 * order, with the same values.)
 */
export function sameUpToOrder(
  /** @type {string[]} */ a,
  /** @type {string[]} */ b,
) {
  const segments = (/** @type {string[]} */ t) => {
    /** @type {string[][]} */
    const out = [[]]
    for (const e of t) {
      if (e.startsWith('#')) out.push([e])
      else out[out.length - 1].push(e)
    }
    return out.map(s => s.sort().join('\u0000'))
  }
  const x = segments(a)
  const y = segments(b)
  return x.length === y.length && x.every((s, i) => s === y[i])
}

/**
 * Whether a divergence is the candidate recovering from a failure where the
 * oracle does not. A generated error was thrown (by either build) up to the
 * end of the op it is in, and there:
 * - `retry`: the candidate runs, or throws, again what failed where the
 *   oracle stays silent or serves a value it had;
 * - `kept-link`: the oracle runs again a computed that lost its subscriber
 *   in the failure, the candidate kept the link and serves its value;
 * - `quiet-release`: the oracle reports onTrigger for a computed released
 *   after the failure (no dep changed), the candidate does not.
 * @returns {'retry' | 'kept-link' | 'quiet-release' | null}
 */
export function recoveryKind(
  /** @type {string[]} */ a,
  /** @type {string[]} */ b,
  /** @type {number} */ at,
) {
  const failed = (/** @type {string[]} */ t) => {
    for (let i = 0; i < t.length; i++) {
      if (i > at && t[i].startsWith('#')) return false
      if (/threw Error:E\d+/.test(t[i])) return true
    }
    return false
  }
  if (!failed(a) && !failed(b)) return null
  const rerun =
    /^(c\d+#|e\d+=|e\d+ scheduled|w\d+ cb|[ce]\d+ (track|trigger) |.* threw Error:E\d+)/
  if (b[at] !== undefined && rerun.test(b[at])) return 'retry'
  if (
    a[at] !== undefined &&
    /^c\d+#$/.test(a[at]) &&
    /^read c\d+=/.test(b[at] ?? '')
  )
    return 'kept-link'
  if (a[at] !== undefined && /^c\d+ trigger /.test(a[at]))
    return 'quiet-release'
  return null
}
