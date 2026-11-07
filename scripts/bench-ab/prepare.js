// @ts-check
// The two bundles a CI benchmark run compares, built once from their commits
// and shared by every job: <out>/base.js and <out>/head.js, each with a
// .json of its commit next to it.
//
//   node scripts/bench-ab/prepare.js <base rev> <head rev> [--out dir] [--dev]

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { resolveBundle } from './bundles.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', default: 'temp/bench-ab/prepared' },
    dev: { type: 'boolean', default: false },
  },
})
if (positionals.length !== 2) {
  process.stderr.write(
    'usage: node scripts/bench-ab/prepare.js <base> <head>\n',
  )
  process.exit(2)
}
const log = (/** @type {string} */ s) => process.stderr.write(`${s}\n`)
const out = path.resolve(root, opts.out)
mkdirSync(out, { recursive: true })
for (const [name, spec] of [
  ['base', positionals[0]],
  ['head', positionals[1]],
]) {
  const b = resolveBundle(spec, {
    root,
    cache: path.join(root, 'temp/bench-ab'),
    dev: opts.dev,
    log,
  })
  const suffix = opts.dev ? '.dev' : ''
  copyFileSync(b.file, path.join(out, `${name}${suffix}.js`))
  const meta = b.file.replace(/\.js$/, '.json')
  if (existsSync(meta))
    copyFileSync(meta, path.join(out, `${name}${suffix}.json`))
  log(
    `${name}: ${spec} ${b.commit?.slice(0, 9) ?? ''} ${b.size} B ${b.sha256.slice(0, 12)}`,
  )
}
