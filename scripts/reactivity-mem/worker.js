// @ts-check
// One sample in a fresh process: node --expose-gc worker.js <bundle> <scenario>
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
