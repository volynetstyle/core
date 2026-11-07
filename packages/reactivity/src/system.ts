// Reactive kernel, being ported from reflex-runtime-quant
// (github.com/volynetstyle/reflex-quant, packages/reflex-runtime-quant,
// src/kernel.ts). Quant's host (its queue, batching and watcher lifecycle) is
// not ported: effects, effect scopes, batching and the notify buffer keep
// Vue's policy.
//
// A link is one edge threaded through two doubly linked lists: the sub's
// `deps`, in the order of its last run's reads, and the dep's `subs`, in
// birth order. A run reconciles its reads with the last run's links at a
// cursor (`depsTail`); a read that misses the cursor is found by bounded
// scans, then through the dep, then through an index of the run's links.
import type { ComputedRefImpl as Computed } from './computed.js'
import type { ReactiveEffect as Effect } from './effect.js'
import type { EffectScope } from './effectScope.js'
import { stats } from './stats.js'
import { warn } from './warning.js'

export interface ReactiveNode {
  deps?: Link
  /** In a run: the last link it has read. Otherwise: the last link. */
  depsTail?: Link
  subs?: Link
  subsTail?: Link
  flags: ReactiveFlags
  /** Of a dep: advances when its value changes. */
  version?: number
  /** Of a dep: its link into the run that indexed its deps last. */
  indexLink?: Link
}

export interface Link {
  /** `dep.version` at the last read; `UNREAD` for a link its indexed run has not read yet. */
  version: number
  dep: ReactiveNode | Computed | Effect | EffectScope
  sub: ReactiveNode | Computed | Effect | EffectScope
  prevSub: Link | undefined
  nextSub: Link | undefined
  prevDep: Link | undefined
  nextDep: Link | undefined
}

interface Stack<T> {
  value: T
  prev: Stack<T> | undefined
}

export const enum ReactiveFlags {
  None = 0,
  Mutable = 1 << 0,
  Watching = 1 << 1,
  RecursedCheck = 1 << 2,
  Recursed = 1 << 3,
  Dirty = 1 << 4,
  Pending = 1 << 5,
  /**
   * The sub has indexed its deps and that run has not ended.
   * (Bits 7, 8 and 10 are `EffectFlags`.)
   */
  Indexed = 1 << 6,
}

/**
 * Links a bounded scan visits on each side of the cursor, and subscribers a
 * search through a dep visits: a constant keeps every read linear.
 */
const SCAN_BUDGET = 8

/** `Link.version` of a link its indexed run has not read yet. */
const UNREAD = -1

/**
 * The running sub that indexed its deps last: each of them points at its
 * link through `indexLink`, until the run ends.
 */
let indexSub: ReactiveNode | undefined = undefined
/** Where the cells displaced by the current index start in `indexStack`. */
let indexBase = 0
let indexTop = 0
/**
 * Per index, LIFO like the runs: the enclosing index's sub and base, and
 * the sub's `Indexed` bit before; then the (dep, link) cells this index
 * displaced, to give back when it ends.
 */
const indexStack: (ReactiveNode | Link | number | undefined)[] = []

/** Deps whose last subscriber left: their own deps go next. */
const orphans: ReactiveNode[] = []

const notifyBuffer: (Effect | undefined)[] = []

export let batchDepth = 0
export let activeSub: ReactiveNode | undefined = undefined

let runDepth = 0

export function incRunDepth(): void {
  ++runDepth
}

export function decRunDepth(): void {
  --runDepth
}

let notifyIndex = 0
let notifyBufferLength = 0

export function setActiveSub(sub?: ReactiveNode): ReactiveNode | undefined {
  try {
    return activeSub
  } finally {
    activeSub = sub
  }
}

export function startBatch(): void {
  ++batchDepth
}

export function endBatch(): void {
  if (!--batchDepth && notifyBufferLength) {
    flush()
  }
}

// --------------------------------------------------------------- tracking

/** A read of `dep` by the running `sub`. */
export function link(dep: ReactiveNode, sub: ReactiveNode): void {
  if (__TEST__) stats.reads++
  const cursor = sub.depsTail
  const next = cursor !== undefined ? cursor.nextDep : sub.deps
  // the next link in the last run's order is this dep's
  if (next !== undefined && next.dep === dep) {
    if (__TEST__) stats.hits++
    next.version = dep.version!
    sub.depsTail = next
    return
  }
  linkMiss(dep, sub, cursor, next)
}

/**
 * The slow half of `link()`, out of line so the fast half stays small. A
 * link found anywhere is the pair's only one; absence needs one side
 * searched completely: the sub's links on both sides of the cursor, or the
 * dep's subscribers. When neither bounded search decides, the run indexes
 * its deps and lookups are exact from then on.
 */
function linkMiss(
  dep: ReactiveNode,
  sub: ReactiveNode,
  cursor: Link | undefined,
  next: Link | undefined,
): void {
  if (cursor !== undefined && cursor.dep === dep) {
    if (__TEST__) stats.repeats++
    cursor.version = dep.version!
    return
  }
  // a computed reading itself in its own run
  if (dep === sub) {
    return
  }
  if (!(sub.flags & ReactiveFlags.Indexed && indexSub === sub)) {
    // a dep without subscribers has no link
    if (dep.subsTail === undefined) {
      insertLink(dep, sub, cursor, next)
      return
    }
    let ahead = next !== undefined ? next.nextDep : undefined
    let budget = SCAN_BUDGET
    while (ahead !== undefined && ahead.dep !== dep && --budget) {
      if (__TEST__) stats.scanned++
      ahead = ahead.nextDep
    }
    if (ahead !== undefined && ahead.dep === dep) {
      if (__TEST__) stats.skips++
      moveLink(ahead, sub, cursor, next!)
      ahead.version = dep.version!
      return
    }
    let behind = cursor !== undefined ? cursor.prevDep : undefined
    budget = SCAN_BUDGET
    while (behind !== undefined && behind.dep !== dep && --budget) {
      if (__TEST__) stats.scanned++
      behind = behind.prevDep
    }
    if (behind !== undefined && behind.dep === dep) {
      if (__TEST__) stats.dups++
      behind.version = dep.version!
      return
    }
    // both scans reached the ends of the list, or the dep's few
    // subscribers do not include this sub: there is no link
    if (
      (ahead === undefined && behind === undefined) ||
      unsubscribed(dep, sub)
    ) {
      insertLink(dep, sub, cursor, next)
      return
    }
    indexDeps(sub, next)
  }
  if (__TEST__) stats.lookups++
  const cell = dep.indexLink
  if (cell !== undefined && cell.sub === sub) {
    if (cell.version === UNREAD) {
      if (__TEST__) stats.moves++
      moveLink(cell, sub, cursor, next!)
    } else {
      if (__TEST__) stats.dups++
    }
    cell.version = dep.version!
    return
  }
  insertLink(dep, sub, cursor, next)
  claimLink(dep, sub.depsTail!)
}

/** Whether `dep` has fewer subscribers than the budget, and `sub` is not one. */
function unsubscribed(dep: ReactiveNode, sub: ReactiveNode): boolean {
  if (__TEST__) stats.lookups++
  let budget = SCAN_BUDGET
  for (let link = dep.subs; link !== undefined; link = link.nextSub) {
    if (link.sub === sub || !--budget) {
      return false
    }
  }
  return true
}

/** A new link at the cursor, as the newest subscriber of `dep`. */
function insertLink(
  dep: ReactiveNode,
  sub: ReactiveNode,
  cursor: Link | undefined,
  next: Link | undefined,
): void {
  if (__TEST__) stats.links++
  const prevSub = dep.subsTail
  const newLink: Link =
    (sub.depsTail =
    dep.subsTail =
      {
        version: dep.version!,
        dep,
        sub,
        prevDep: cursor,
        nextDep: next,
        prevSub,
        nextSub: undefined,
      })
  if (next !== undefined) {
    next.prevDep = newLink
  }
  if (cursor !== undefined) {
    cursor.nextDep = newLink
  } else {
    sub.deps = newLink
  }
  if (prevSub !== undefined) {
    prevSub.nextSub = newLink
  } else {
    dep.subs = newLink
  }
}

/** Moves a link the run has not read yet from behind `next` to the cursor. */
function moveLink(
  link: Link,
  sub: ReactiveNode,
  cursor: Link | undefined,
  next: Link,
): void {
  const before = link.prevDep!
  const after = link.nextDep
  before.nextDep = after
  if (after !== undefined) {
    after.prevDep = before
  }
  link.prevDep = cursor
  link.nextDep = next
  next.prevDep = link
  if (cursor !== undefined) {
    cursor.nextDep = link
  } else {
    sub.deps = link
  }
  sub.depsTail = link
}

/**
 * An effect scope owns `node` (an effect, a computed or a scope): a link
 * appended without a run, unless `node` was just appended.
 */
export function own(node: ReactiveNode, scope: ReactiveNode): void {
  const tail = scope.depsTail
  if (tail !== undefined && tail.dep === node) {
    return
  }
  const prevSub = node.subsTail
  if (prevSub !== undefined && prevSub.sub === scope) {
    return
  }
  insertLink(node, scope, tail, undefined)
}

// ------------------------------------------------------------------ index

/**
 * Points each dep of `sub` at its link, and marks the links the run has not
 * read yet, from `next` on. The index lasts until the run ends.
 */
function indexDeps(sub: ReactiveNode, next: Link | undefined): void {
  if (__TEST__) stats.indexes++
  indexStack[indexTop++] = indexSub
  indexStack[indexTop++] = indexBase
  // an enclosing run of the same sub may own an index further down
  indexStack[indexTop++] = sub.flags & ReactiveFlags.Indexed
  sub.flags |= ReactiveFlags.Indexed
  indexSub = sub
  indexBase = indexTop
  let unread = false
  for (let link = sub.deps; link !== undefined; link = link.nextDep) {
    if (link === next) {
      unread = true
    }
    if (unread) {
      link.version = UNREAD
    }
    claimLink(link.dep, link)
  }
}

/** Points `dep` at `link`, keeping the cell of an enclosing index to give back. */
function claimLink(dep: ReactiveNode, link: Link): void {
  const cell = dep.indexLink
  if (cell !== undefined) {
    indexStack[indexTop++] = dep
    indexStack[indexTop++] = cell
  }
  dep.indexLink = link
}

/**
 * Ends the index of `sub`: clears its claims, gives back the cells it
 * displaced (unless their link was removed meanwhile), and restores the
 * enclosing index.
 */
function unindexDeps(sub: ReactiveNode): void {
  for (let link = sub.deps; link !== undefined; link = link.nextDep) {
    const dep: ReactiveNode = link.dep
    if (dep.indexLink === link) {
      dep.indexLink = undefined
    }
  }
  while (indexTop > indexBase) {
    const cell = indexStack[--indexTop] as Link
    const dep = indexStack[--indexTop] as ReactiveNode
    indexStack[indexTop] = indexStack[indexTop + 1] = undefined
    dep.indexLink = isLinked(cell) ? cell : undefined
  }
  sub.flags =
    (sub.flags & ~ReactiveFlags.Indexed) | (indexStack[--indexTop] as number)
  indexBase = indexStack[--indexTop] as number
  indexSub = indexStack[--indexTop] as ReactiveNode | undefined
  indexStack[indexTop] =
    indexStack[indexTop + 1] =
    indexStack[indexTop + 2] =
      undefined
}

/** Whether `link` is still in its sub's list: no removed link is given back. */
function isLinked(link: Link): boolean {
  const prevDep = link.prevDep
  return (prevDep !== undefined ? prevDep.nextDep : link.sub.deps) === link
}

/** No index is open: every run that indexed its deps has ended (tests). */
export function isIndexIdle(): boolean {
  return indexTop === 0 && indexSub === undefined
}

// ---------------------------------------------------------------- removal

/** Removes `link` from both lists; returns the next link of its sub. */
export function unlink(
  link: Link,
  sub: ReactiveNode = link.sub,
): Link | undefined {
  const prevDep = link.prevDep
  const nextDep = link.nextDep
  if (sub.depsTail === link) {
    sub.depsTail = prevDep
  }
  if (nextDep !== undefined) {
    nextDep.prevDep = prevDep
  }
  if (prevDep !== undefined) {
    prevDep.nextDep = nextDep
  } else {
    sub.deps = nextDep
  }
  const base = orphans.length
  unsubscribe(link)
  if (orphans.length > base) {
    releaseOrphans(base)
  }
  return nextDep
}

/** Removes every link of `sub` after `last` (all of them when undefined). */
function cut(sub: ReactiveNode, last: Link | undefined): void {
  let link = last !== undefined ? last.nextDep : sub.deps
  if (link === undefined) {
    return
  }
  if (last !== undefined) {
    last.nextDep = undefined
  } else {
    sub.deps = undefined
  }
  sub.depsTail = last
  const base = orphans.length
  do {
    unsubscribe(link)
    link = link.nextDep
  } while (link !== undefined)
  if (orphans.length > base) {
    releaseOrphans(base)
  }
}

/** Removes every link of `sub`. */
export function unlinkDeps(sub: ReactiveNode): void {
  cut(sub, undefined)
}

/** Removes `link` from its dep's subscribers; a dep left with none is an orphan. */
function unsubscribe(link: Link): void {
  if (__TEST__) stats.unlinks++
  const dep: ReactiveNode = link.dep
  const prevSub = link.prevSub
  const nextSub = link.nextSub
  // e.g. an effect stopped during its own indexed run
  if (dep.indexLink === link) {
    dep.indexLink = undefined
  }
  if (nextSub !== undefined) {
    nextSub.prevSub = prevSub
  } else {
    dep.subsTail = prevSub
  }
  if (prevSub !== undefined) {
    prevSub.nextSub = nextSub
  } else if ((dep.subs = nextSub) === undefined && dep.deps !== undefined) {
    orphans.push(dep)
  }
}

/**
 * A computed nothing subscribes to lets go of its deps, so that it can be
 * collected, and must run again when read. Without recursion: its deps may
 * become orphans in turn. A running one keeps its deps until its run ends.
 */
function releaseOrphans(base: number): void {
  while (orphans.length > base) {
    const dep = orphans.pop()!
    if (
      dep.subs === undefined &&
      dep.deps !== undefined &&
      !(dep.flags & ReactiveFlags.RecursedCheck)
    ) {
      let link: Link | undefined = dep.deps
      dep.deps = dep.depsTail = undefined
      do {
        unsubscribe(link)
        link = link.nextDep
      } while (link !== undefined)
      dep.flags |= ReactiveFlags.Dirty
    }
  }
}

// ------------------------------------------------------------------- push

export function propagate(link: Link): void {
  let next = link.nextSub
  let stack: Stack<Link | undefined> | undefined

  top: do {
    const sub = link.sub
    let flags = sub.flags

    if (flags & (ReactiveFlags.Mutable | ReactiveFlags.Watching)) {
      if (
        !(
          flags &
          (ReactiveFlags.RecursedCheck |
            ReactiveFlags.Recursed |
            ReactiveFlags.Dirty |
            ReactiveFlags.Pending)
        )
      ) {
        sub.flags = flags | ReactiveFlags.Pending
        if (runDepth) {
          sub.flags |= ReactiveFlags.Recursed
        }
      } else if (
        !(flags & (ReactiveFlags.RecursedCheck | ReactiveFlags.Recursed))
      ) {
        flags = ReactiveFlags.None
      } else if (!(flags & ReactiveFlags.RecursedCheck)) {
        sub.flags = (flags & ~ReactiveFlags.Recursed) | ReactiveFlags.Pending
      } else if (
        !(flags & (ReactiveFlags.Dirty | ReactiveFlags.Pending)) &&
        isValidLink(link, sub)
      ) {
        sub.flags = flags | ReactiveFlags.Recursed | ReactiveFlags.Pending
        flags &= ReactiveFlags.Mutable
      } else {
        flags = ReactiveFlags.None
      }

      if (flags & ReactiveFlags.Watching) {
        notifyBuffer[notifyBufferLength++] = sub as Effect
      }

      if (flags & ReactiveFlags.Mutable) {
        const subSubs = sub.subs
        if (subSubs !== undefined) {
          link = subSubs
          if (subSubs.nextSub !== undefined) {
            stack = { value: next, prev: stack }
            next = link.nextSub
          }
          continue
        }
      }
    }

    if ((link = next!) !== undefined) {
      next = link.nextSub
      continue
    }

    while (stack !== undefined) {
      link = stack.value!
      stack = stack.prev
      if (link !== undefined) {
        next = link.nextSub
        continue top
      }
    }

    break
  } while (true)
}

// -------------------------------------------------------------------- run

export function startTracking(sub: ReactiveNode): ReactiveNode | undefined {
  // a run that starts inside its own indexed run starts over without it
  if (sub.flags & ReactiveFlags.Indexed && indexSub === sub) {
    unindexDeps(sub)
  }
  sub.depsTail = undefined
  sub.flags =
    (sub.flags &
      ~(ReactiveFlags.Recursed | ReactiveFlags.Dirty | ReactiveFlags.Pending)) |
    ReactiveFlags.RecursedCheck
  return setActiveSub(sub)
}

export function endTracking(
  sub: ReactiveNode,
  prevSub: ReactiveNode | undefined,
): void {
  if (__DEV__ && activeSub !== sub) {
    warn(
      'Active effect was not restored correctly - ' +
        'this is likely a Vue internal bug.',
    )
  }
  activeSub = prevSub

  if (sub.flags & ReactiveFlags.Indexed && indexSub === sub) {
    unindexDeps(sub)
  }
  // the reads of this run end at the cursor
  cut(sub, sub.depsTail)
  sub.flags &= ~ReactiveFlags.RecursedCheck
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

// ------------------------------------------------------------------- pull

export function checkDirty(link: Link, sub: ReactiveNode): boolean {
  let stack: Stack<Link> | undefined
  let checkDepth = 0

  top: do {
    const dep = link.dep
    const depFlags = dep.flags

    let dirty = false

    if (sub.flags & ReactiveFlags.Dirty) {
      dirty = true
    } else if (
      (depFlags & (ReactiveFlags.Mutable | ReactiveFlags.Dirty)) ===
      (ReactiveFlags.Mutable | ReactiveFlags.Dirty)
    ) {
      const subs = dep.subs!
      if ((dep as Computed).update()) {
        if (subs.nextSub !== undefined) {
          shallowPropagate(subs)
        }
        dirty = true
      }
    } else if (
      (depFlags & (ReactiveFlags.Mutable | ReactiveFlags.Pending)) ===
      (ReactiveFlags.Mutable | ReactiveFlags.Pending)
    ) {
      stack = { value: link, prev: stack }
      link = dep.deps!
      sub = dep
      ++checkDepth
      continue
    }

    if (!dirty && link.nextDep !== undefined) {
      link = link.nextDep
      continue
    }

    while (checkDepth) {
      --checkDepth
      link = stack!.value
      stack = stack!.prev
      if (dirty) {
        const subs = sub.subs!
        if ((sub as Computed).update()) {
          if (subs.nextSub !== undefined) {
            shallowPropagate(subs)
          }
          sub = link.sub
          continue
        }
      } else {
        sub.flags &= ~ReactiveFlags.Pending
      }
      sub = link.sub
      if (link.nextDep !== undefined) {
        link = link.nextDep
        continue top
      }
      dirty = false
    }

    return dirty && !!sub.flags
  } while (true)
}

export function shallowPropagate(link: Link): void {
  do {
    const sub = link.sub
    const nextSub = link.nextSub
    const subFlags = sub.flags
    if (
      (subFlags & (ReactiveFlags.Pending | ReactiveFlags.Dirty)) ===
      ReactiveFlags.Pending
    ) {
      sub.flags = subFlags | ReactiveFlags.Dirty
    }
    link = nextSub!
  } while (link !== undefined)
}

function isValidLink(checkLink: Link, sub: ReactiveNode): boolean {
  let link = sub.depsTail
  while (link !== undefined) {
    if (link === checkLink) {
      return true
    }
    link = link.prevDep
  }
  return false
}
