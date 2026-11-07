// @ts-check
// Every workload computes the same on both bundles: the checksum of its first
// steps, as runner.js folds it. Run before timing, so that no runner times
// two builds that do different work.
//
//   node scripts/bench-ab/verify.js <base bundle> <head bundle> [--steps n]

import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { workloads } from './workloads.js'

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: { steps: { type: 'string', default: '256' } },
})
if (positionals.length !== 2) {
  process.stderr.write('usage: node scripts/bench-ab/verify.js <base> <head>\n')
  process.exit(2)
}
const steps = Number(opts.steps)
const [a, b] = await Promise.all(
  positionals.map(file => import(pathToFileURL(file).href)),
)

/** @param {any} reactivity @param {string} name */
function checksum(reactivity, name) {
  const step = workloads[name].setup(reactivity)
  let sum = 0
  for (let k = 0; k < steps; k++) {
    const value = step()
    sum = (Math.imul(sum, 31) + (typeof value === 'number' ? value | 0 : 1)) | 0
  }
  return sum
}

let failed = 0
for (const name of Object.keys(workloads)) {
  const x = checksum(a, name)
  const y = checksum(b, name)
  const same = x === y
  if (!same) failed++
  console.log(`${same ? 'same' : 'DIFF'}  ${name}${same ? '' : `  ${x} ${y}`}`)
}
if (failed) {
  console.error(`${failed} workloads compute differently on the two bundles`)
  process.exit(1)
}
