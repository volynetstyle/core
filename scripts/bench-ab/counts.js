// @ts-check
// Structural counts of the bench-ab workloads, per step: what the kernel
// did besides taking time. Runs the workloads from source under vitest
// (counters are `__TEST__`-only) in this checkout and in an oracle checkout
// whose kernel carries the same counters.
//
//   node scripts/bench-ab/counts.js [--oracle <dir>] [--steps n] [--filter re]
//
// The oracle checkout (default ../core-oracle) must have
// packages/reactivity/src/stats.ts and counters in its system.ts; for an
// alien-signals kernel, scratchpad shims do that (they are never committed).

import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const { values: opts } = parseArgs({
  options: {
    oracle: { type: 'string', default: path.resolve(root, '../core-oracle') },
    steps: { type: 'string', default: '1000' },
    filter: { type: 'string', default: '' },
  },
})

const SPEC = `import * as R from '../../src'
import { resetStats, stats } from '../../src/stats'
import { workloads } from './workloads.js'
import { writeFileSync } from 'node:fs'

it('counts', () => {
  const steps = Number(process.env.COUNTS_STEPS)
  const filter = new RegExp(process.env.COUNTS_FILTER || '')
  const out: Record<string, Record<string, number>> = {}
  const warn = console.warn
  console.warn = () => {}
  try {
    for (const [name, w] of Object.entries(workloads)) {
      if (!filter.test(name)) continue
      const step = w.setup(R as any)
      for (let k = 0; k < 50; k++) step()
      resetStats()
      for (let k = 0; k < steps; k++) step()
      out[name] = Object.fromEntries(
        Object.entries(stats).map(([k, v]) => [k, (v as number) / steps]),
      )
    }
  } finally {
    console.warn = warn
  }
  writeFileSync(process.env.COUNTS_OUT!, JSON.stringify(out))
}, 600_000)
`

/** @param {string} tree */
function counts(tree) {
  const dir = path.join(tree, 'packages/reactivity/__tests__/__counts__')
  const outFile = path.join(
    os.tmpdir(),
    `counts-${process.pid}-${path.basename(tree)}.json`,
  )
  mkdirSync(dir, { recursive: true })
  try {
    writeFileSync(path.join(dir, 'counts.spec.ts'), SPEC)
    copyFileSync(
      path.join(here, 'workloads.js'),
      path.join(dir, 'workloads.js'),
    )
    execFileSync(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      [
        'vp',
        'test',
        'run',
        'packages/reactivity/__tests__/__counts__/counts.spec.ts',
      ],
      {
        cwd: tree,
        stdio: 'pipe',
        shell: process.platform === 'win32',
        env: {
          ...process.env,
          COUNTS_OUT: outFile,
          COUNTS_STEPS: opts.steps,
          COUNTS_FILTER: opts.filter,
        },
      },
    )
    return JSON.parse(readFileSync(outFile, 'utf8'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outFile, { force: true })
  }
}

const a = counts(opts.oracle)
const b = counts(root)

/** The columns: what a step allocates, removes and walks. */
const columns = {
  runs: (/** @type {any} */ s) => s.runs,
  reads: (/** @type {any} */ s) => s.reads,
  links: (/** @type {any} */ s) => s.links,
  unlinks: (/** @type {any} */ s) => s.unlinks,
  scans: (/** @type {any} */ s) => s.scanned + s.subScans + s.readWalk,
  index: (/** @type {any} */ s) => s.indexWalk,
  push: (/** @type {any} */ s) => s.marks + s.settles,
  pull: (/** @type {any} */ s) => s.checks,
  allocs: (/** @type {any} */ s) => s.links + (s.frames ?? 0),
}

const fmt = (/** @type {number} */ x) =>
  x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)
const rows = []
for (const name of Object.keys(b)) {
  const row = { workload: name }
  for (const [col, f] of Object.entries(columns)) {
    // @ts-ignore
    row[col] = { oracle: f(a[name] ?? {}), candidate: f(b[name]) }
  }
  rows.push(row)
}
const out = path.join(root, 'temp/bench-ab/counts.json')
mkdirSync(path.dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(rows, null, 2))

const head = [
  'workload'.padEnd(24),
  ...Object.keys(columns).map(c => c.padStart(15)),
].join('')
console.log(head)
console.log(
  ' '.repeat(24) +
    Object.keys(columns)
      .map(() => 'oracle→cand'.padStart(15))
      .join(''),
)
for (const row of rows) {
  console.log(
    // @ts-ignore
    row.workload.padEnd(24) +
      Object.keys(columns)
        // @ts-ignore
        .map(c => `${fmt(row[c].oracle)}→${fmt(row[c].candidate)}`.padStart(15))
        .join(''),
  )
}
console.log(`\n(per step; ${opts.steps} steps after 50 to warm up) ${out}`)
