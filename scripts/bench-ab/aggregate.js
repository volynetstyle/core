// @ts-check
// One report from the jobs of a CI benchmark run: timing replicas (each on
// its own runner), kernel counts, memory and size.
//
//   node scripts/bench-ab/aggregate.js --timing <dir> [--counts <file>]
//     [--memory <file>] [--sizes <file>] [--out <dir>]
//
// Timing: every report.json under <dir> is one job, and its ratios are only
// valid within it (runners differ from job to job). A workload is faster or
// slower only if every replica that timed it says so beyond its own noise;
// replicas that disagree make it unstable. The ratio shown is the geometric
// mean over replicas. Every replica must have timed the same two bundles.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

const { values: opts } = parseArgs({
  options: {
    timing: { type: 'string' },
    counts: { type: 'string' },
    memory: { type: 'string' },
    sizes: { type: 'string' },
    out: { type: 'string', default: 'temp/bench-ab/summary' },
  },
})

/** @param {string} dir @returns {string[]} */
function reports(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? reports(p) : e.name === 'report.json' ? [p] : []
  })
}

const read = (/** @type {string | undefined} */ f) =>
  f && existsSync(f) ? readFileSync(f, 'utf8') : undefined
const geomean = (/** @type {number[]} */ xs) =>
  Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length)
const fmt = (/** @type {number} */ x) => x.toFixed(2)

const lines = ['# @vue/reactivity benchmark', '']
const summary = /** @type {Record<string, any>} */ ({})
let failed = false

const files = opts.timing ? reports(opts.timing) : []
if (files.length) {
  const jobs = files.map(f => JSON.parse(readFileSync(f, 'utf8')))
  const shas = new Set(jobs.map(j => `${j.base.sha256} ${j.head.sha256}`))
  if (shas.size !== 1) {
    failed = true
    lines.push(
      '**Timing jobs timed different bundles:** ' + [...shas].join(', '),
      '',
    )
  }
  const { base, head } = jobs[0]
  const rev = (/** @type {any} */ b) =>
    b.commit ? `${b.commit.slice(0, 9)} ${b.subject ?? ''}` : b.label
  lines.push(
    `- base: ${rev(base)} (${base.size} B, sha256 ${base.sha256.slice(0, 12)})`,
    `- head: ${rev(head)} (${head.size} B, sha256 ${head.sha256.slice(0, 12)})`,
    `- ${jobs[0].options.rounds} ABBA rounds per workload, a fresh pinned ` +
      'process per sample; ratios are head/base throughput, compared ' +
      'within a job only',
    '',
  )
  /** @type {Map<string, { replica: string, row: any }[]>} */
  const byWorkload = new Map()
  const replicas = new Map()
  for (const [i, job] of jobs.entries()) {
    const id = `r${i + 1}`
    replicas.set(id, `${job.env.cpu}${job.env.ci ? ` (${job.env.ci})` : ''}`)
    for (const row of job.results) {
      const list = byWorkload.get(row.workload) ?? []
      list.push({ replica: id, row })
      byWorkload.set(row.workload, list)
    }
  }
  const rows = []
  for (const [workload, list] of byWorkload) {
    const verdicts = list.map(x => x.row.verdict)
    const n = list.length
    const count = (/** @type {string} */ v) =>
      verdicts.filter(x => x === v).length
    const verdict = workload.startsWith('failure.')
      ? 'different work'
      : verdicts.includes('results differ')
        ? 'results differ'
        : count('faster') === n
          ? 'faster'
          : count('slower') === n
            ? 'slower'
            : count('faster') && count('slower')
              ? 'unstable'
              : count('faster')
                ? `faster on ${count('faster')}/${n}`
                : count('slower')
                  ? `slower on ${count('slower')}/${n}`
                  : 'within noise'
    if (verdict === 'results differ') failed = true
    rows.push({
      workload,
      ratio: geomean(list.map(x => x.row.ratio.value)),
      replicas: list.map(x => ({
        replica: x.replica,
        ratio: x.row.ratio,
        noise: x.row.noise,
        verdict: x.row.verdict,
      })),
      verdict,
    })
  }
  const timed = rows.filter(r => !r.workload.startsWith('failure.'))
  summary.timing = { replicas: Object.fromEntries(replicas), rows }
  lines.push(
    '## Time',
    '',
    `Geometric mean of head/base over ${timed.length} workloads: ` +
      `**${fmt(geomean(timed.map(r => r.ratio)))}** ` +
      '(failure.* left out: the base serves stale values after a failure, ' +
      'the head runs again, so they do different work).',
    '',
    `| workload | head/base | ${[...replicas.keys()].join(' | ')} | verdict |`,
    `| --- | ---: | ${[...replicas.keys()].map(() => '---:').join(' | ')} | --- |`,
    ...rows.map(r => {
      const cells = [...replicas.keys()].map(id => {
        const x = r.replicas.find(y => y.replica === id)
        return x
          ? `${fmt(x.ratio.value)} [${fmt(x.ratio.low)}–${fmt(x.ratio.high)}] ±${(x.noise * 100).toFixed(0)}%`
          : ''
      })
      return `| ${r.workload} | ${fmt(r.ratio)} | ${cells.join(' | ')} | ${r.verdict} |`
    }),
    '',
    'Each replica: ratio [95% bootstrap interval over rounds] ±noise (the ' +
      'base-vs-base ratio of the samples framing each round). Replicas:',
    '',
    ...[...replicas].map(([id, cpu]) => `- ${id}: ${cpu}`),
    '',
  )
}

for (const [key, file] of /** @type {const} */ ([
  ['counts', opts.counts],
  ['memory', opts.memory],
  ['sizes', opts.sizes],
])) {
  const md = read(file && file.replace(/\.json$/, '.md'))
  const json = read(file)
  if (json) summary[key] = JSON.parse(json)
  if (md) lines.push(md.replace(/^## /m, '## '), '')
}

const out = path.resolve(opts.out)
mkdirSync(out, { recursive: true })
writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2))
writeFileSync(path.join(out, 'summary.md'), lines.join('\n'))
console.log(lines.join('\n'))
process.exit(failed ? 1 : 0)
