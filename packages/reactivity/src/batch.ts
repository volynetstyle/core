// Vue's host for the watchers the kernel wakes: the notify buffer, batches
// and their flush. The kernel only calls wake(); what a woken watcher does
// (run, schedule, stay paused) is its notify().
import type { ReactiveNode } from './system'

interface Notified extends ReactiveNode {
  notify(): void
}

const notifyBuffer: (Notified | undefined)[] = []
let notifyIndex = 0
let notifyBufferLength = 0

export let batchDepth = 0

/** The kernel hands over a watcher a push reached. */
export function wake(sub: ReactiveNode): void {
  notifyBuffer[notifyBufferLength++] = sub as Notified
}

export function startBatch(): void {
  ++batchDepth
}

export function endBatch(): void {
  if (!--batchDepth && notifyBufferLength) {
    flush()
  }
}

export function flush(): void {
  // a throwing subscriber must not abort the batch: keep notifying the rest,
  // reset the queue, then rethrow the first error once the batch is drained.
  let hasError = false
  let error: unknown
  while (notifyIndex < notifyBufferLength) {
    const effect = notifyBuffer[notifyIndex]!
    notifyBuffer[notifyIndex++] = undefined
    try {
      effect.notify()
    } catch (err) {
      if (!hasError) {
        hasError = true
        error = err
      }
    }
  }
  notifyIndex = 0
  notifyBufferLength = 0
  if (hasError) {
    throw error
  }
}
