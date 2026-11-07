// @ts-check
// Differential testing of @vue/reactivity: generated programs run against
// an oracle build and a candidate build in one process; any difference in
// what they observably do is shrunk to a small program and reported.
//
//   node scripts/reactivity-diff [options]
//     --base <rev>        oracle (default: oracle/vue-alien)
//     --head <rev>        candidate (default: worktree, the current files)
//     --family <name>     core | recursion | failure | debug | mixed | all
//     --programs <n>      programs per family (default 2000)
//     --seed <n>          first seed (default 1)
//     --prod              production bundles (no debug hooks, no warnings)
//     --shrink <n>        divergences to shrink per class (default 1)
//     --out <dir>         report directory (default temp/reactivity-diff)
//     --strict            fail on order divergences too
//
// A divergence is of kind `order` when the two traces hold the same events
// op by op, in another order (subscribers notified in another order);
// `recovery:*` when the candidate recovers from a failure where the oracle
// does not (see recoveryKind()); `semantic` otherwise. Exit code 1 on a semantic divergence (on any with
// --strict).

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { resolveBundle } from '../bench-ab/bundles.js'
import {
  families,
  firstDifference,
  generate,
  recoveryKind,
  run,
  sameUpToOrder,
} from './program.js'
import { render, shrink } from './shrink.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')

const { values: opts } = parseArgs({
  options: {
    base: { type: 'string', default: 'oracle/vue-alien' },
    head: { type: 'string', default: 'worktree' },
    family: { type: 'string', default: 'all' },
    programs: { type: 'string', default: '2000' },
    seed: { type: 'string', default: '1' },
    prod: { type: 'boolean', default: false },
    shrink: { type: 'string', default: '1' },
    out: { type: 'string', default: 'temp/reactivity-diff' },
    rebuild: { type: 'boolean', default: false },
    strict: { type: 'boolean', default: false },
  },
})

const log = (/** @type {string} */ s) => process.stderr.write(`${s}\n`)
const cache = path.join(root, 'temp/bench-ab')
const dev = !opts.prod
const [base, head] = [opts.base, opts.head].map(spec =>
  resolveBundle(spec, { root, cache, dev, rebuild: opts.rebuild, log }),
)
log(`oracle    ${base.label} ${base.commit?.slice(0, 9) ?? ''} ${base.file}`)
log(`candidate ${head.label} ${head.commit?.slice(0, 9) ?? ''} ${head.file}`)

const A = await import(pathToFileURL(base.file).href)
const B = await import(pathToFileURL(head.file).href)

/** Runs `program` against a build, with its warnings in the trace. */
function traced(/** @type {any} */ R, /** @type {any} */ program) {
  const warn = console.warn
  /** @type {string[]} */
  const warnings = []
  console.warn = (/** @type {any[]} */ ...args) =>
    warnings.push(String(args[0]).slice(0, 80))
  try {
    const trace = run(R, program)
    return warnings.length
      ? [...trace, ...warnings.map(w => `warn ${w}`)]
      : trace
  } finally {
    console.warn = warn
  }
}

/** The kind of divergence `p` shows, or null. */
function kindOf(/** @type {any} */ p) {
  const a = traced(A, p)
  const b = traced(B, p)
  const at = firstDifference(a, b)
  return at < 0 ? null : classify(a, b, at)
}

function classify(
  /** @type {string[]} */ a,
  /** @type {string[]} */ b,
  /** @type {number} */ at,
) {
  if (sameUpToOrder(a, b)) return 'order'
  const recovery = recoveryKind(a, b, at)
  if (recovery) return `recovery:${recovery}`
  return 'semantic'
}

/** A divergence class: the shape of the first differing events. */
function signature(
  /** @type {string[]} */ a,
  /** @type {string[]} */ b,
  /** @type {number} */ at,
) {
  const shape = (/** @type {string | undefined} */ s) =>
    s === undefined ? '<end>' : s.replace(/\d+/g, '#').replace(/=.*/, '=…')
  return `${shape(a[at])} | ${shape(b[at])}`
}

const names =
  opts.family === 'all'
    ? /** @type {(keyof typeof families)[]} */ (Object.keys(families))
    : [/** @type {keyof typeof families} */ (opts.family)]
const programs = Number(opts.programs)
const firstSeed = Number(opts.seed)
const shrinkPerClass = Number(opts.shrink)

/** @type {any} */
const report = {
  oracle: { label: base.label, commit: base.commit, sha256: base.sha256 },
  candidate: { label: head.label, commit: head.commit, sha256: head.sha256 },
  dev,
  families: {},
}
let total = 0

for (const family of names) {
  /** @type {Map<string, { count: number, seeds: number[], examples: any[] }>} */
  const classes = new Map()
  let events = 0
  const started = performance.now()
  for (let k = 0; k < programs; k++) {
    const seed = firstSeed + k
    const program = generate(seed, family)
    const a = traced(A, program)
    const b = traced(B, program)
    events += a.length
    const at = firstDifference(a, b)
    if (at < 0) continue
    const kind = classify(a, b, at)
    const sig = `${kind}: ${signature(a, b, at)}`
    let c = classes.get(sig)
    if (!c) classes.set(sig, (c = { count: 0, seeds: [], examples: [] }))
    c.count++
    if (c.seeds.length < 20) c.seeds.push(seed)
    if (c.examples.length < shrinkPerClass) {
      // shrink within the kind: an order divergence must not shrink into
      // a semantic one, nor the other way round
      const { program: small, tries } = shrink(program, p => kindOf(p) === kind)
      const sa = traced(A, small)
      const sb = traced(B, small)
      const sat = firstDifference(sa, sb)
      c.examples.push({
        seed,
        tries,
        code: render(small),
        program: small,
        oracle: sa,
        candidate: sb,
        at: sat,
      })
    }
  }
  const divergent = [...classes.values()].reduce((n, c) => n + c.count, 0)
  const semantic = [...classes]
    .filter(([sig]) => sig.startsWith('semantic'))
    .reduce((n, [, c]) => n + c.count, 0)
  total += opts.strict ? divergent : semantic
  report.families[family] = {
    programs,
    events,
    divergent,
    semantic,
    ms: Math.round(performance.now() - started),
    classes: Object.fromEntries(classes),
  }
  log(
    `${family.padEnd(10)} ${programs} programs, ${events} events: ` +
      (divergent
        ? `${divergent} divergent (${semantic} semantic) in ${classes.size} classes`
        : 'no divergence'),
  )
  const sorted = [...classes].sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
  for (const [sig, c] of sorted) {
    log(`  ${String(c.count).padStart(5)}  ${sig}`)
    for (const ex of c.examples) {
      log(`         seed ${ex.seed}, shrunk in ${ex.tries} tries:`)
      log(ex.code.replace(/^/gm, '           '))
      log(
        `           oracle:    ${ex.oracle.slice(Math.max(0, ex.at - 2), ex.at + 3).join(' ; ')}`,
      )
      log(
        `           candidate: ${ex.candidate.slice(Math.max(0, ex.at - 2), ex.at + 3).join(' ; ')}`,
      )
    }
  }
}

const out = path.resolve(root, opts.out)
mkdirSync(out, { recursive: true })
writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
log(`report: ${path.join(out, 'report.json')}`)
process.exit(total ? 1 : 0)
