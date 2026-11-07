// @ts-check
// Size of two bundles of @vue/reactivity: whole (minified, gzip, brotli), and
// what an app that imports part of the API keeps after tree-shaking, as
// Vue's builds shake (modules have no side effects).
//
//   node scripts/bench-ab/sizes.js <base bundle> <head bundle> [--out dir]

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { rolldown } from 'rolldown'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: 'string', default: 'temp/bench-ab/sizes' } },
})
if (positionals.length !== 2) {
  process.stderr.write('usage: node scripts/bench-ab/sizes.js <base> <head>\n')
  process.exit(2)
}

/** Parts of the API an app may import. */
const entries = {
  'ref, effect': ['ref', 'effect'],
  'ref, computed, effect': ['ref', 'computed', 'effect'],
  'reactive, watch': ['reactive', 'watch'],
  'effectScope, ref, computed, effect': [
    'effectScope',
    'ref',
    'computed',
    'effect',
  ],
}

/** @param {Buffer | string} code */
const measure = code => ({
  min: Buffer.byteLength(code),
  gzip: gzipSync(code, { level: 9 }).length,
  brotli: brotliCompressSync(code).length,
})

const tmp = path.join(root, 'temp/bench-ab/sizes-tmp')
mkdirSync(tmp, { recursive: true })

/** @param {string} bundle @param {string[]} names */
async function shaken(bundle, names) {
  const entry = path.join(tmp, `entry-${names.join('-')}.js`)
  writeFileSync(
    entry,
    `export { ${names.join(', ')} } from ${JSON.stringify(path.resolve(bundle))}\n`,
  )
  const build = await rolldown({
    input: entry,
    treeshake: { moduleSideEffects: false },
    logLevel: 'silent',
  })
  const { output } = await build.generate({ format: 'esm', minify: true })
  await build.close()
  return measure(output[0].code)
}

const report = []
try {
  for (const [label, file] of [
    ['base', positionals[0]],
    ['head', positionals[1]],
  ]) {
    /** @type {Record<string, any>} */
    const row = { label, file, bundle: measure(readFileSync(file)) }
    for (const [name, names] of Object.entries(entries)) {
      row[name] = await shaken(file, names)
    }
    report.push(row)
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

const [a, b] = report
const delta = (/** @type {number} */ x, /** @type {number} */ y) =>
  `${y - x >= 0 ? '+' : ''}${y - x} (${(((y - x) / x) * 100).toFixed(1)}%)`
const lines = [
  '## Size: head vs base',
  '',
  'Bytes. The whole production bundle, then what a tree-shaken app that',
  'imports only the listed exports keeps (minified).',
  '',
  '| | base min | head min | base gzip | head gzip | gzip Δ | base brotli | head brotli |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...['bundle', ...Object.keys(entries)].map(
    k =>
      `| ${k === 'bundle' ? 'whole bundle' : k} | ${a[k].min} | ${b[k].min} | ` +
      `${a[k].gzip} | ${b[k].gzip} | ${delta(a[k].gzip, b[k].gzip)} | ` +
      `${a[k].brotli} | ${b[k].brotli} |`,
  ),
  '',
]
const out = path.resolve(root, opts.out)
mkdirSync(out, { recursive: true })
writeFileSync(path.join(out, 'sizes.json'), JSON.stringify(report, null, 2))
writeFileSync(path.join(out, 'sizes.md'), lines.join('\n'))
console.log(lines.join('\n'))
