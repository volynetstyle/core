// @ts-check
// Shrinks a program that tells two builds apart to a small one that still
// does: drops ops (in chunks, then one by one), drops nodes (renumbering
// what refers to them), and simplifies expressions, until nothing smaller
// still diverges.

/**
 * @param {any} program
 * @param {(p: any) => boolean} diverges
 * @param {number} [budget] candidate programs to try at most
 */
export function shrink(program, diverges, budget = 4000) {
  let best = clone(program)
  let tries = 0
  const attempt = (/** @type {any} */ p) => {
    if (tries++ >= budget) return false
    try {
      if (diverges(p)) {
        best = p
        return true
      }
    } catch {}
    return false
  }

  let progress = true
  while (progress && tries < budget) {
    progress = false
    // ops: chunks, halving, then single ops (nested batches included)
    for (let size = best.ops.length >> 1; size >= 1; size >>= 1) {
      for (let i = 0; i + size <= best.ops.length;) {
        const p = clone(best)
        p.ops.splice(i, size)
        if (attempt(p)) progress = true
        else i += size
      }
    }
    for (let i = 0; i < best.ops.length; i++) {
      const op = best.ops[i]
      if (op.o === 'batch') {
        // unwrap, or drop inner ops
        const p = clone(best)
        p.ops.splice(i, 1, ...op.ops)
        if (attempt(p)) {
          progress = true
          continue
        }
        for (let j = 0; j < best.ops[i].ops.length;) {
          const q = clone(best)
          q.ops[i].ops.splice(j, 1)
          if (attempt(q)) progress = true
          else j++
        }
      }
    }
    // nodes, last first: later nodes depend on earlier ones
    for (let n = best.nodes.length - 1; n >= 0; n--) {
      const p = removeNode(best, n)
      if (p && attempt(p)) progress = true
    }
    // node options and expressions
    for (let n = 0; n < best.nodes.length; n++) {
      for (const key of [
        'scheduler',
        'allowRecurse',
        'debug',
        'immediate',
        'deep',
        'detached',
      ]) {
        if (best.nodes[n][key]) {
          const p = clone(best)
          p.nodes[n][key] = false
          if (attempt(p)) progress = true
        }
      }
      if (best.nodes[n].scope >= 0) {
        const p = clone(best)
        p.nodes[n].scope = -1
        if (attempt(p)) progress = true
      }
      if (best.nodes[n].expr) {
        for (const simpler of simplifications(best.nodes[n].expr)) {
          const p = clone(best)
          p.nodes[n].expr = simpler
          if (attempt(p)) {
            progress = true
            break
          }
        }
      }
    }
  }
  return { program: best, tries }
}

/** Expressions one step simpler than `e`: a constant, or one of its parts. */
function* simplifications(/** @type {any} */ e) {
  if (e.t !== 'n') yield { t: 'n', v: 0 }
  if (e.t !== 'n' && e.t !== 'get') yield { t: 'n', v: 1 }
  for (const key of ['a', 'b', 'c', 'e']) {
    if (e[key]) yield e[key]
  }
  for (const key of ['a', 'b', 'c', 'e']) {
    if (e[key]) {
      for (const inner of simplifications(e[key])) yield { ...e, [key]: inner }
    }
  }
}

/** The program without node `n`: what read it reads 0, ops on it go. */
function removeNode(/** @type {any} */ program, /** @type {number} */ n) {
  const p = clone(program)
  p.nodes.splice(n, 1)
  const remap = (/** @type {number} */ i) => (i > n ? i - 1 : i)
  /** @returns {any} */
  const fix = (/** @type {any} */ e) => {
    if (!e || typeof e !== 'object') return e
    if (
      (e.t === 'get' || e.t === 'keys' || e.t === 'sum' || e.t === 'write') &&
      e.n === n
    )
      return e.t === 'write' ? fix(e.e) : { t: 'n', v: 0 }
    const out = { ...e }
    if (typeof out.n === 'number') out.n = remap(out.n)
    for (const key of ['a', 'b', 'c', 'e'])
      if (out[key]) out[key] = fix(out[key])
    return out
  }
  for (const node of p.nodes) {
    if (node.expr) node.expr = fix(node.expr)
    if (node.scope === n) node.scope = -1
    else if (node.scope > n) node.scope--
    if (node.source === n) node.source = -1
    else if (node.source > n) node.source--
  }
  /** @returns {any[]} */
  const fixOps = (/** @type {any[]} */ ops) =>
    ops.flatMap(op => {
      if (op.o === 'batch') return [{ ...op, ops: fixOps(op.ops) }]
      if (op.n === n) return []
      return [{ ...op, n: typeof op.n === 'number' ? remap(op.n) : op.n }]
    })
  p.ops = fixOps(p.ops)
  return p
}

/** A program as code a reader can follow. */
export function render(/** @type {any} */ program) {
  /** @returns {string} */
  const ex = (/** @type {any} */ e) => {
    switch (e.t) {
      case 'n':
        return String(e.v)
      case 'get': {
        const node = program.nodes[e.n]
        if (node.kind === 'reactive') return `n${e.n}.k${e.k}`
        if (node.kind === 'array')
          return e.k < 0 ? `n${e.n}.length` : `n${e.n}[${e.k}]`
        return `n${e.n}.value`
      }
      case 'keys':
        return `sumOfKeys(n${e.n})`
      case 'sum':
        return `sum(n${e.n})`
      case 'add':
        return `(${ex(e.a)} + ${ex(e.b)}) % 97`
      case 'odd':
        return `(${ex(e.a)} & 1)`
      case 'if':
        return `(${ex(e.c)} & 1 ? ${ex(e.a)} : ${ex(e.b)})`
      case 'throw':
        return `throwIf(${ex(e.c)} % 3 === 1, 'E${e.id}')`
      case 'write': {
        const node = program.nodes[e.n]
        const target =
          node.kind === 'reactive'
            ? `n${e.n}.k${e.k}`
            : node.kind === 'array'
              ? `n${e.n}[${e.k}]`
              : `n${e.n}.value`
        return `(${target} = ${ex(e.e)})`
      }
    }
    return '?'
  }
  const lines = []
  program.nodes.forEach((/** @type {any} */ node, /** @type {number} */ i) => {
    const inScope = node.scope >= 0 ? `n${node.scope}.run(() => ` : ''
    const close = node.scope >= 0 ? ')' : ''
    let rhs
    switch (node.kind) {
      case 'ref':
      case 'shallowRef':
        rhs = `${node.kind}(${node.init})`
        break
      case 'custom':
        rhs = `customRef(${node.init})`
        break
      case 'reactive':
        rhs = `reactive({ ${Array.from({ length: node.size }, (_, k) => `k${k}: ${k}`).join(', ')} })`
        break
      case 'array':
        rhs = `reactive([${Array.from({ length: node.size }, (_, k) => k).join(', ')}])`
        break
      case 'computed':
        rhs = `computed(() => ${ex(node.expr)}${node.debug ? ', debug' : ''})`
        break
      case 'effect': {
        const opts = ['scheduler', 'allowRecurse', 'debug'].filter(k => node[k])
        rhs = `effect(() => log(${ex(node.expr)})${opts.length ? `, { ${opts.join(', ')} }` : ''})`
        break
      }
      case 'watch': {
        const opts = ['immediate', 'deep'].filter(k => node[k])
        const src =
          node.source >= 0 ? `n${node.source}` : `() => ${ex(node.expr)}`
        rhs = `watch(${src}, log${opts.length ? `, { ${opts.join(', ')} }` : ''})`
        break
      }
      case 'scope':
        rhs = `effectScope(${node.detached ? 'true' : ''})`
        break
    }
    lines.push(`const n${i} = ${inScope}${rhs}${close}`)
  })
  /** @returns {string[]} */
  const opLines = (/** @type {any[]} */ ops, /** @type {string} */ indent) =>
    ops.flatMap(op => {
      switch (op.o) {
        case 'set': {
          const node = program.nodes[op.n]
          const target =
            node.kind === 'reactive'
              ? `n${op.n}.k${op.k}`
              : node.kind === 'array'
                ? `n${op.n}[${op.k}]`
                : `n${op.n}.value`
          return [`${indent}${target} = ${op.e.v}`]
        }
        case 'del':
          return [`${indent}delete n${op.n}.k${op.k}`]
        case 'push':
          return [`${indent}n${op.n}.push(${op.v})`]
        case 'pop':
          return [`${indent}n${op.n}.pop()`]
        case 'trigger':
          return [`${indent}triggerRef(n${op.n})`]
        case 'read':
          return [`${indent}log(n${op.n}.value)`]
        case 'batch':
          return [
            `${indent}startBatch()`,
            ...opLines(op.ops, indent + '  '),
            `${indent}endBatch()`,
          ]
        case 'run':
          return [`${indent}n${op.n}()`]
        case 'flush':
          return [`${indent}flushScheduled()`]
        default:
          return [`${indent}n${op.n}.${op.o}()`]
      }
    })
  return [...lines, ...opLines(program.ops, '')].join('\n')
}

function clone(/** @type {any} */ x) {
  return JSON.parse(JSON.stringify(x))
}
