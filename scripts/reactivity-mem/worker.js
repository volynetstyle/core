// @ts-check
// One sample in a fresh process: node --expose-gc worker.js <bundle> <scenario>
import v8 from 'node:v8'
import { pathToFileURL } from 'node:url'
import { scenarios } from './scenarios.js'

const [bundle, name] = process.argv.slice(2)
const R = await import(pathToFileURL(bundle).href)
const scenario = scenarios[name]
const gc = /** @type {() => void} */ (globalThis.gc)
/** Heap after a full GC on a fresh macrotask: nothing of the caller's stack survives. */
const heap = () =>
  new Promise(resolve =>
    setTimeout(() => {
      gc()
      gc()
      resolve(process.memoryUsage().heapUsed)
    }),
  )

/** @type {any} */
let keep
let value
if (scenario.retained) {
  // one graph from a clean heap: the code it compiles counts, alike for
  // every bundle (a warm-up graph does not reliably leave the heap first)
  const before = /** @type {number} */ (await heap())
  keep = scenario.retained(R)
  const after = /** @type {number} */ (await heap())
  value = (after - before) / keep.n
} else if (scenario.promotion) {
  const step = scenario.promotion(R)
  gc()
  gc()
  const old = () =>
    v8
      .getHeapSpaceStatistics()
      .filter(
        s =>
          s.space_name === 'old_space' || s.space_name === 'large_object_space',
      )
      .reduce((sum, s) => sum + s.space_used_size, 0)
  const steps = 40_000
  const before = old()
  const minor = /** @type {(o: { type: string }) => void} */ (
    /** @type {unknown} */ (gc)
  )
  for (let i = 0; i < steps; i++) {
    step()
    if ((i & 127) === 127) minor({ type: 'minor' })
  }
  minor({ type: 'minor' })
  minor({ type: 'minor' })
  value = (old() - before) / steps
} else {
  const step = /** @type {() => void} */ (scenario.churn?.(R))
  const K = Number(process.env.MEM_STEPS ?? 4000)
  for (let i = 0; i < 500; i++) step()
  const h1 = /** @type {number} */ (await heap())
  for (let i = 0; i < K; i++) step()
  const h2 = /** @type {number} */ (await heap())
  for (let i = 0; i < K; i++) step()
  const h3 = /** @type {number} */ (await heap())
  // the second half against the first: a leak grows both alike
  value = Math.min(h2 - h1, h3 - h2) / K
}
process.stdout.write(
  JSON.stringify({ name, value, alive: keep !== undefined }) + '\n',
)
