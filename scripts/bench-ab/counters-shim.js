// @ts-check
// Counters for a checkout whose kernel has none: the alien-signals kernel of
// Vue 3.6 (minor). It writes packages/reactivity/src/stats.ts with the
// counters of this checkout's kernel and puts them at the places of the
// alien-signals system.ts that do the same work. counts.js applies it to a
// throwaway worktree of the base revision only; it is never committed.
//
// Every edit must match exactly once: a kernel that changed fails loudly
// instead of being counted wrong.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const STATS = `export const stats: Record<string, number> = {
  reads: 0, hits: 0, repeats: 0, skips: 0, dups: 0, moves: 0, lookups: 0,
  scanned: 0, indexes: 0, sweeps: 0, links: 0, unlinks: 0, marks: 0,
  checks: 0, runs: 0, subScans: 0, indexWalk: 0, readWalk: 0, settles: 0,
  frames: 0,
}
export function resetStats(): void {
  for (const key in stats) stats[key] = 0
}
`

/** [find, replace]: each find occurs exactly once in alien-signals' system.ts. */
const EDITS = [
  [
    "import { warn } from './warning.js'",
    "import { warn } from './warning.js'\nimport { stats } from './stats.js'",
  ],
  // a read
  [
    'export function link(dep: ReactiveNode, sub: ReactiveNode): void {\n',
    'export function link(dep: ReactiveNode, sub: ReactiveNode): void {\n  stats.reads++\n',
  ],
  // a link allocated
  ['  const newLink =\n', '  stats.links++\n  const newLink =\n'],
  // a link removed
  [
    '): Link | undefined {\n  const dep = link.dep\n',
    '): Link | undefined {\n  stats.unlinks++\n  const dep = link.dep\n',
  ],
  // a push visit
  [
    '  top: do {\n    const sub = link.sub\n',
    '  top: do {\n    stats.marks++\n    const sub = link.sub\n',
  ],
  // a stack frame allocated by push
  [
    '            stack = { value: next, prev: stack }',
    '            stats.frames++\n            stack = { value: next, prev: stack }',
  ],
  // a pull visit
  [
    '  top: do {\n    const dep = link.dep\n',
    '  top: do {\n    stats.checks++\n    const dep = link.dep\n',
  ],
  // a stack frame allocated by pull
  [
    '      stack = { value: link, prev: stack }',
    '      stats.frames++\n      stack = { value: link, prev: stack }',
  ],
  // a settle visit (shallowPropagate is alien-signals' settled())
  [
    'export function shallowPropagate(link: Link): void {\n  do {\n',
    'export function shallowPropagate(link: Link): void {\n  do {\n    stats.settles++\n',
  ],
  // the walk that tells whether a running sub has read a link
  [
    '  while (link !== undefined) {\n    if (link === checkLink) {',
    '  while (link !== undefined) {\n    stats.readWalk++\n    if (link === checkLink) {',
  ],
  // a run
  [
    'export function startTracking(sub: ReactiveNode): ReactiveNode | undefined {\n',
    'export function startTracking(sub: ReactiveNode): ReactiveNode | undefined {\n  stats.runs++\n',
  ],
]

/**
 * Gives the checkout at `dir` counters, if it has none.
 * @param {string} dir
 * @returns {boolean} whether it was patched
 */
export function applyCountersShim(dir) {
  const src = path.join(dir, 'packages/reactivity/src')
  if (existsSync(path.join(src, 'stats.ts'))) {
    return false
  }
  const file = path.join(src, 'system.ts')
  let code = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  for (const [find, replace] of EDITS) {
    const n = code.split(find).length - 1
    if (n !== 1) {
      throw new Error(
        `counters shim: ${JSON.stringify(find.slice(0, 60))} occurs ${n} times ` +
          `in ${file}; the kernel changed, update scripts/bench-ab/counters-shim.js`,
      )
    }
    code = code.replace(find, replace)
  }
  writeFileSync(file, code)
  writeFileSync(path.join(src, 'stats.ts'), STATS)
  return true
}
