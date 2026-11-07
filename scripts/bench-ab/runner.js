// @ts-check
// One sample: one fresh process, one bundle, one workload. Prints JSON.
// Usage: node runner.js <bundle> <workload> <warmupMs> <sampleMs> <samples> [--wait] [--gc]

import { pathToFileURL } from 'node:url'
import { workloads } from './workloads.js'

const [bundle, name, warmupArg, sampleArg, samplesArg, ...flags] =
  process.argv.slice(2)

if (flags.includes('--wait')) {
  // the parent pins this process to a CPU, then says go
  await new Promise(resolve => process.stdin.once('data', resolve))
}

const reactivity = await import(pathToFileURL(bundle).href)
const step = workloads[name].setup(reactivity)

// What the first steps compute: every bundle must agree on it.
let checksum = 0
for (let k = 0; k < 256; k++) {
  const value = step()
  checksum =
    (Math.imul(checksum, 31) + (typeof value === 'number' ? value | 0 : 1)) | 0
}

let sink = 0
/** steps per second over `ms` milliseconds */
function sample(/** @type {number} */ ms) {
  let n = 0
  const start = performance.now()
  const end = start + ms
  let now
  do {
    for (let k = 0; k < 32; k++) sink ^= /** @type {number} */ (step()) | 0
    n += 32
  } while ((now = performance.now()) < end)
  return (n * 1000) / (now - start)
}

sample(Number(warmupArg))
if (flags.includes('--gc')) {
  // a compacted heap, so variants do not differ by allocation layout
  globalThis.gc?.()
  globalThis.gc?.()
}
const samples = []
for (let k = 0; k < Number(samplesArg); k++)
  samples.push(sample(Number(sampleArg)))
samples.sort((a, b) => a - b)

process.stdout.write(
  JSON.stringify({
    workload: name,
    hz: samples[samples.length >> 1],
    samples,
    checksum,
    sink: sink & 1,
  }) + '\n',
)
