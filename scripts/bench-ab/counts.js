// @ts-check
// Structural counts of the bench-ab workloads, per step: what the kernel
// did besides taking time. Runs the workloads from source under vitest
// (counters are `__TEST__`-only) in this checkout and in a base checkout
// whose kernel carries the same counters. Counts do not depend on the
// machine: they are the part of a benchmark CI can compare exactly.
//
//   node scripts/bench-ab/counts.js --base <rev> [--steps n] [--filter re]
//   node scripts/bench-ab/counts.js --oracle <dir> ...
//
// --base runs in a throwaway worktree of <rev>; a kernel without counters
// (alien-signals) gets them from counters-shim.js there. --oracle runs in an
// existing checkout that has them. Writes temp/bench-ab/counts/counts.json
// and counts.md (or --out <dir>).

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
import { withWorktree } from './bundles.js'
import { applyCountersShim } from './counters-shim.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const { values: opts } = parseArgs({
  options: {
    base: { type: 'string' },
    oracle: { type: 'string' },
    steps: { type: 'string', default: '1000' },
    filter: { type: 'string', default: '' },
    out: { type: 'string', default: 'temp/bench-ab/counts' },
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
    // vp's own entry, run by node: no shell, on every platform
    execFileSync(
      process.execPath,
      [
        path.join(root, 'node_modules/vite-plus/bin/vp'),
        'test',
        'run',
        'packages/reactivity/__tests__/__counts__/counts.spec.ts',
      ],
      {
        cwd: tree,
        stdio: 'pipe',
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

const log = (/** @type {string} */ s) => process.stderr.write(`${s}\n`)
/** @type {{ label: string, commit?: string }} */
let baseInfo
/** @type {any} */
let a
if (opts.base) {
  const commit = execFileSync(
    'git',
    ['rev-parse', '--verify', `${opts.base}^{commit}`],
    {
      cwd: root,
      encoding: 'utf8',
    },
  ).trim()
  baseInfo = { label: opts.base, commit }
  a = withWorktree(root, path.join(root, 'temp/bench-ab'), commit, log, dir => {
    if (applyCountersShim(dir))
      log(`counters shim applied to ${commit.slice(0, 9)}`)
    return counts(dir)
  })
} else if (opts.oracle) {
  baseInfo = { label: opts.oracle }
  a = counts(path.resolve(opts.oracle))
} else {
  log('usage: node scripts/bench-ab/counts.js --base <rev> | --oracle <dir>')
  process.exit(2)
}
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
/** @type {Record<string, any>[]} */
const rows = []
for (const name of Object.keys(b)) {
  /** @type {Record<string, any>} */
  const row = { workload: name }
  for (const [col, f] of Object.entries(columns)) {
    row[col] = { base: f(a[name] ?? {}), head: f(b[name]) }
  }
  rows.push(row)
}
const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim()
const dirty =
  execFileSync('git', ['status', '--porcelain', '--', 'packages'], {
    cwd: root,
    encoding: 'utf8',
  }).trim() !== ''
const report = {
  base: baseInfo,
  head: { label: dirty ? 'worktree' : 'HEAD', commit: headCommit, dirty },
  steps: Number(opts.steps),
  rows,
}
const out = path.resolve(root, opts.out)
mkdirSync(out, { recursive: true })
writeFileSync(path.join(out, 'counts.json'), JSON.stringify(report, null, 2))

const cols = Object.keys(columns)
const md = [
  `## Kernel work per step: ${report.head.label} vs ${baseInfo.label}`,
  '',
  `Counted from source (\`__TEST__\` counters), ${opts.steps} steps after 50 ` +
    'to warm up; base → head. Machine independent: these compare exactly.',
  '',
  `| workload | ${cols.join(' | ')} |`,
  `| --- | ${cols.map(() => '---:').join(' | ')} |`,
  ...rows.map(
    row =>
      `| ${row.workload} | ` +
      cols
        .map(c => {
          const { base, head } = row[c]
          const cell = `${fmt(base)} → ${fmt(head)}`
          return head < base ? `**${cell}**` : cell
        })
        .join(' | ') +
      ' |',
  ),
  '',
  'Columns: runs of effects and computeds; reads (link() calls); links ' +
    'allocated and removed; scans (links and subscribers visited by searches, ' +
    'and by the read check of running subs); index (links walked to index, ' +
    'mark or unindex a run); push and pull visits; allocations (links, and ' +
    'stack frames of an allocating walk). Bold: less work.',
  '',
].join('\n')
writeFileSync(path.join(out, 'counts.md'), md)
console.log(md)
