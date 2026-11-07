// @ts-check
// A/B benchmark of @vue/reactivity between two revisions.
// See README.md in this directory.

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { resolveBundle } from './bundles.js'
import { cpuClasses, pin } from './cpus.js'
import { median, ratio } from './stats.js'
import { workloads } from './workloads.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rounds: { type: 'string', default: '5' },
    'warmup-ms': { type: 'string', default: '400' },
    'sample-ms': { type: 'string', default: '100' },
    samples: { type: 'string', default: '7' },
    cores: { type: 'string', default: 'auto' },
    filter: { type: 'string' },
    gc: { type: 'boolean', default: false },
    rebuild: { type: 'boolean', default: false },
    out: { type: 'string', default: 'temp/bench-ab/report' },
    list: { type: 'boolean', default: false },
  },
})

const log = (/** @type {string} */ s) => process.stderr.write(`${s}\n`)

if (opts.list) {
  for (const [name, w] of Object.entries(workloads)) {
    console.log(`${name.padEnd(24)} ${w.note}`)
  }
  process.exit(0)
}
if (positionals.length !== 2) {
  log('usage: node scripts/bench-ab <base> <head> [options]  (see README.md)')
  process.exit(2)
}

const cache = path.join(root, 'temp/bench-ab')
const [base, head] = positionals.map(spec =>
  resolveBundle(spec, { root, cache, rebuild: opts.rebuild, log }),
)
if (base.sha256 === head.sha256) {
  log(`warning: ${base.label} and ${head.label} build to the same bundle`)
}

const rounds = Number(opts.rounds)
const filter = opts.filter ? new RegExp(opts.filter) : null
const names = Object.keys(workloads).filter(n => !filter || filter.test(n))
const classes = cpuClasses(opts.cores, log)
const runnerArgs = [
  opts['warmup-ms'],
  opts['sample-ms'],
  opts.samples,
  '--wait',
  ...(opts.gc ? ['--gc'] : []),
]

/**
 * One sample in a fresh process, pinned before it starts measuring.
 * @param {string} bundle
 * @param {string} workload
 * @param {number | null} cpu
 * @returns {Promise<{ hz: number, checksum: number }>}
 */
function sample(bundle, workload, cpu) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        ...(opts.gc ? ['--expose-gc'] : []),
        path.join(here, 'runner.js'),
        bundle,
        workload,
        ...runnerArgs,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    let out = ''
    let err = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (err += d))
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve(JSON.parse(out))
      else
        reject(new Error(`${workload} on ${bundle}: ${err || `exit ${code}`}`))
    })
    try {
      if (cpu !== null) pin(/** @type {number} */ (child.pid), cpu)
      child.stdin.end('go\n')
    } catch (e) {
      child.kill()
      reject(e)
    }
  })
}

const results = []
let mismatch = false
for (const cls of classes) {
  for (const workload of names) {
    /** @type {{ a: number[], b: number[] }[]} */
    const abba = []
    const sums = new Set()
    for (let r = 0; r < rounds; r++) {
      const a1 = await sample(base.file, workload, cls.cpu)
      const b1 = await sample(head.file, workload, cls.cpu)
      const b2 = await sample(head.file, workload, cls.cpu)
      const a2 = await sample(base.file, workload, cls.cpu)
      abba.push({ a: [a1.hz, a2.hz], b: [b1.hz, b2.hz] })
      sums.add(`${a1.checksum},${a2.checksum}|${b1.checksum},${b2.checksum}`)
    }
    const [aSum, bSum] = [...sums][0].split('|')
    const same = sums.size === 1 && aSum === bSum
    mismatch ||= !same
    const ab = ratio(abba)
    // The two A samples of a round frame it: their ratio is this machine's
    // noise and drift for this workload, the bar B/A has to clear.
    const aa = ratio(abba.map(r => ({ a: [r.a[0]], b: [r.a[1]] })))
    const bar = Math.max(0.02, Math.abs(aa.value - 1) + (aa.high - aa.low) / 2)
    const verdict = !same
      ? 'results differ'
      : ab.low > 1 + bar
        ? 'faster'
        : ab.high < 1 - bar
          ? 'slower'
          : 'within noise'
    const row = {
      cpu: cls.name,
      workload,
      base: median(abba.flatMap(r => r.a)),
      head: median(abba.flatMap(r => r.b)),
      ratio: ab,
      noise: bar,
      verdict,
    }
    results.push(row)
    log(
      `${cls.name.padEnd(5)} ${workload.padEnd(24)} ${fmt(ab.value)}x ` +
        `[${fmt(ab.low)}-${fmt(ab.high)}] noise ±${pct(bar)}  ${verdict}`,
    )
  }
}

const env = {
  node: process.version,
  v8: process.versions.v8,
  os: `${os.type()} ${os.release()} ${os.arch()}`,
  cpu: `${os.cpus()[0].model} x${os.availableParallelism()}`,
  ci: process.env.GITHUB_ACTIONS
    ? `${process.env.RUNNER_NAME} (${process.env.RUNNER_OS})`
    : undefined,
}
const options = {
  rounds,
  ...runnerArgsObject(),
  cores: opts.cores,
  gc: opts.gc,
}
const report = { base, head, env, options, results }
const out = path.resolve(root, opts.out)
mkdirSync(out, { recursive: true })
writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
const md = markdown(report)
writeFileSync(path.join(out, 'report.md'), md)
console.log(md)
process.exit(mismatch ? 1 : 0)

function runnerArgsObject() {
  return {
    warmupMs: Number(opts['warmup-ms']),
    sampleMs: Number(opts['sample-ms']),
    samples: Number(opts.samples),
  }
}

/** @param {number} x */
function fmt(x) {
  return x.toFixed(2)
}

/** @param {number} x */
function pct(x) {
  return `${(x * 100).toFixed(1)}%`
}

/** @param {typeof report} r */
function markdown(r) {
  const rev = (/** @type {typeof base} */ b) =>
    b.commit
      ? `\`${b.label}\` ${b.commit.slice(0, 9)} ${b.subject}`
      : `\`${b.label}\``
  const lines = [
    `## @vue/reactivity: ${r.head.label} vs ${r.base.label}`,
    '',
    `- base: ${rev(r.base)} (${r.base.size} B)`,
    `- head: ${rev(r.head)} (${r.head.size} B)`,
    `- ${r.env.cpu}, ${r.env.os}, Node ${r.env.node}${r.env.ci ? `, ${r.env.ci}` : ''}`,
    `- ${r.options.rounds} ABBA rounds per workload, a fresh process per ` +
      `sample (${r.options.warmupMs} ms warm-up, median of ` +
      `${r.options.samples} × ${r.options.sampleMs} ms), pinned: ${r.options.cores}`,
    '',
    'Throughput ratio head/base with a 95% bootstrap interval over rounds. ' +
      'Noise is the base-vs-base ratio of the two base samples framing each ' +
      'round; a change counts only beyond it.',
    '',
    '| cpu | workload | base ops/s | head ops/s | head/base | 95% interval | noise | verdict |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
    ...r.results.map(
      x =>
        `| ${x.cpu} | ${x.workload} | ${Math.round(x.base)} | ${Math.round(x.head)} | ` +
        `${fmt(x.ratio.value)} | ${fmt(x.ratio.low)}–${fmt(x.ratio.high)} | ` +
        `±${pct(x.noise)} | ${x.verdict} |`,
    ),
    '',
  ]
  return lines.join('\n')
}
