/**
 * Structural counters of dependency tracking, for tests. Every update is
 * guarded by `__TEST__`, so production builds drop the updates and this
 * module with them.
 */
export const stats: {
  /** `link()` calls. */
  reads: number
  /** Reads of the dep read just before. */
  repeats: number
  /** Reads of the next dep in the previous run's order. */
  hits: number
  /** Repeats proven by the dep's newest subscriber. */
  tailRepeats: number
  /** Repeats of a dep read earlier in the run, found by a lookup. */
  dups: number
  /** Unread links moved to the cursor. */
  moves: number
  /** Searches of a dep's subscribers. */
  lookups: number
  /** Walks that mark the unread links of a run. */
  sweeps: number
  /** Links created. */
  links: number
  /** Links removed. */
  unlinks: number
} = {
  reads: 0,
  repeats: 0,
  hits: 0,
  tailRepeats: 0,
  dups: 0,
  moves: 0,
  lookups: 0,
  sweeps: 0,
  links: 0,
  unlinks: 0,
}

export function resetStats(): void {
  for (const key in stats) {
    stats[key as keyof typeof stats] = 0
  }
}
