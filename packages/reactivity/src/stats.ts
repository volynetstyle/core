/**
 * Structural counters of the kernel, for tests. Every update is guarded by
 * `__TEST__`, so production builds drop the updates and this module with them.
 */
export const stats: {
  /** `link()` calls. */
  reads: number
  /** Reads of the next link in the last run's order. */
  hits: number
  /** Reads of the dep read just before. */
  repeats: number
  /** Unread links found by the scan ahead of the cursor, moved to it. */
  skips: number
  /** Reads of a dep this run has read already. */
  dups: number
  /** Unread links found through the index, moved to the cursor. */
  moves: number
  /** Searches through a dep: its subscribers, or its index cell. */
  lookups: number
  /** Links visited by the bounded scans around the cursor. */
  scanned: number
  /** Runs that indexed their deps. */
  indexes: number
  /** Runs that marked their unread links. */
  sweeps: number
  /** Links created. */
  links: number
  /** Links removed. */
  unlinks: number
  /** Links a push visited. */
  marks: number
  /** Links a check visited. */
  checks: number
  /** Runs started (effects and computeds). */
  runs: number
  /** Subscribers visited by searches through a dep. */
  subScans: number
  /** Links walked to index or mark the deps of a run, or to end the index. */
  indexWalk: number
  /** Links walked to tell whether a running sub has read a link. */
  readWalk: number
  /** Subscribers visited when a dep settles as changed. */
  settles: number
} = {
  reads: 0,
  hits: 0,
  repeats: 0,
  skips: 0,
  dups: 0,
  moves: 0,
  lookups: 0,
  scanned: 0,
  indexes: 0,
  sweeps: 0,
  links: 0,
  unlinks: 0,
  marks: 0,
  checks: 0,
  runs: 0,
  subScans: 0,
  indexWalk: 0,
  readWalk: 0,
  settles: 0,
}

export function resetStats(): void {
  for (const key in stats) {
    stats[key as keyof typeof stats] = 0
  }
}
