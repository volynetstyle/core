// @ts-check
// Memory of @vue/reactivity between two revisions: heap retained per node
// and per link, and heap growth under churn (what a long-running app would
// leak). Each sample runs in a fresh `node --expose-gc` process.
//
//   node scripts/reactivity-mem [--base <rev>] [--head <rev>] [--samples n]
//
// Retained bytes are heapUsed after a full GC with the graph alive, minus
// before, per unit. Churn reports heapUsed growth per iteration between the
// first K and the next K iterations: ~0 means nothing is retained.

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { resolveBundle } from '../bench-ab/bundles.js'
import { scenarios } from './scenarios.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')

const { values: opts } = parseArgs({
  options: {
    base: { type: 'string', default: 'oracle/vue-alien' },
    head: { type: 'string', default: 'worktree' },
    samples: { type: 'string', default: '3' },
    filter: { type: 'string' },
    out: { type: 'string', default: 'temp/reactivity-mem' },
  },
})
const log = (/** @type {string} */ s) => process.stderr.write(`${s}\n`)
const cache = path.join(root, 'temp/bench-ab')
const [base, head] = [opts.base, opts.head].map(spec =>
  resolveBundle(spec, { root, cache, log }),
)

const names = Object.keys(scenarios).filter(
  n => !opts.filter || new RegExp(opts.filter).test(n),
)
const samples = Number(opts.samples)

/** @param {string} bundle @param {string} name */
function sample(bundle, name) {
  const out = execFileSync(
    process.execPath,
    ['--expose-gc', path.join(here, 'worker.js'), bundle, name],
    { encoding: 'utf8' },
  )
  return JSON.parse(out)
}

const median = (/** @type {number[]} */ xs) =>
  [...xs].sort((a, b) => a - b)[xs.length >> 1]

log(`oracle    ${base.label} (${base.size} B)`)
log(`candidate ${head.label} (${head.size} B)`)
const rows = []
for (const name of names) {
  const a = []
  const b = []
  for (let k = 0; k < samples; k++) {
    a.push(sample(base.file, name).value)
    b.push(sample(head.file, name).value)
  }
  const ma = median(a)
  const mb = median(b)
  rows.push({ name, unit: scenarios[name].unit, base: ma, head: mb })
  log(
    `${name.padEnd(28)} ${scenarios[name].unit.padEnd(16)} ` +
      `oracle ${ma.toFixed(1).padStart(8)}  candidate ${mb.toFixed(1).padStart(8)}` +
      (ma > 0 ? `  ×${(mb / ma).toFixed(2)}` : ''),
  )
}
const kind = (/** @type {string} */ name) =>
  scenarios[name].retained
    ? 'retained'
    : scenarios[name].promotion
      ? 'promotion'
      : 'churn'
const md = [
  `## Memory: ${head.commit?.slice(0, 9) ?? head.label} vs ${base.commit?.slice(0, 9) ?? base.label}`,
  '',
  'Production bundles, a fresh `node --expose-gc` process per sample, the ' +
    `median of ${samples}. Retained: heap per unit after a full GC with the ` +
    'graph alive. Churn: heap growth per step with nothing kept (~0: no ' +
    'leak). Promotion: old-space growth per step under minor GCs only ' +
    '(what scavenges could not free).',
  '',
  '| scenario | kind | unit | base | head |',
  '| --- | --- | --- | ---: | ---: |',
  ...rows.map(
    r =>
      `| ${r.name} | ${kind(r.name)} | ${r.unit} | ${r.base.toFixed(1)} | ${r.head.toFixed(1)} |`,
  ),
  '',
].join('\n')
const out = path.resolve(root, opts.out)
mkdirSync(out, { recursive: true })
writeFileSync(
  path.join(out, 'memory.json'),
  JSON.stringify({ base, head, samples, rows }, null, 2),
)
writeFileSync(path.join(out, 'memory.md'), md)
console.log(md)
