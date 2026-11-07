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
  rows.push({ name, unit: scenarios[name].unit, oracle: ma, candidate: mb })
  log(
    `${name.padEnd(28)} ${scenarios[name].unit.padEnd(16)} ` +
      `oracle ${ma.toFixed(1).padStart(8)}  candidate ${mb.toFixed(1).padStart(8)}` +
      (ma > 0 ? `  ×${(mb / ma).toFixed(2)}` : ''),
  )
}
console.log(JSON.stringify(rows, null, 2))
