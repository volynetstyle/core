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
  /** Of a computed or a ref: brings its value up to date; whether it changed. */
  update?(): boolean
  /** Of a sub: runs that succeeded so far; links born since are tentative. */
  gen?: number
}

export interface Link {
  /** `dep.version` at the last read; `UNREAD` for a link its indexed run has not read yet. */
  version: number
  /** `sub.gen + 1` at birth: equal to it while no run of the sub succeeded since. */
  gen: number
  dep: ReactiveNode | Computed | Effect | EffectScope
  sub: ReactiveNode | Computed | Effect | EffectScope
  prevSub: Link | undefined
  nextSub: Link | undefined
  prevDep: Link | undefined
  nextDep: Link | undefined
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
 * `Link.version` of a read that threw: no version of the dep matches it, so
 * the sub runs again at the next push that reaches it.
 */
const FAILED = -2

/** Keeps versions and generations small integers. */
const VERSION_MASK = 0x3fffffff

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
/** Push: the subscriber lists to resume after a descent. */
const siblings: Link[] = []
/** Pull: the link each node being checked was descended through. */
const descent: Link[] = []

const notifyBuffer: (Effect | undefined)[] = []

export let batchDepth = 0
export let activeSub: ReactiveNode | undefined = undefined

let runDepth = 0

/**
 * Dev: set while flags are written to owe a run after a failure, which is
 * no trigger (the debug flags handler skips it).
 */
export let owingAfterFailure = false

/** Writes `flags` that owe a run after a failure. */
function owe(node: ReactiveNode, flags: ReactiveFlags): void {
  if (__DEV__) owingAfterFailure = true
  node.flags = flags
  if (__DEV__) owingAfterFailure = false
}

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
        // 0 for a link of an effect scope to what it owns
        version: dep.version! | 0,
        gen: (sub.gen! + 1) & VERSION_MASK,
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
 * A read of `dep` by the running `sub` that threw while bringing `dep` up to
 * date. It is a read still: the sub runs again once `dep` recovers, even
 * with the value it had before. (Cold path: the link is found by a walk.)
 */
export function linkFailed(dep: ReactiveNode, sub: ReactiveNode): void {
  link(dep, sub)
  for (let l = sub.depsTail; l !== undefined; l = l.prevDep) {
    if (l.dep === dep) {
      l.version = FAILED
      return
    }
  }
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

/** No run, index or walk is in progress, and the shared stacks are empty (tests). */
export function isKernelIdle(): boolean {
  return (
    isIndexIdle() &&
    activeSub === undefined &&
    orphans.length === 0 &&
    siblings.length === 0 &&
    descent.length === 0
  )
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

/** The version after `version`. */
export function nextVersion(version: number): number {
  return (version + 1) & VERSION_MASK
}

/**
 * `dep` changed: its version advances, the subs that read it must run, and
 * the subs below them may have to.
 */
export function propagate(dep: ReactiveNode): void {
  dep.version = nextVersion(dep.version!)
  push(dep, true)
}

/**
 * `dep` may have changed (a ref set, not compared yet): the subs that read
 * it settle that when they check.
 */
export function invalidate(dep: ReactiveNode): void {
  push(dep, false)
}

function push(dep: ReactiveNode, changed: boolean): void {
  for (let link = dep.subs; link !== undefined; link = link.nextSub) {
    const sub = link.sub
    const running = sub.flags & ReactiveFlags.RecursedCheck
    const flags = mark(link, sub)
    // A sub that read the old version must run. So must a running one that
    // has read it (it is Pending then), even if it reads it again: in Vue a
    // run that writes a dep it has read runs once more. (For a ref, once it
    // settles as changed: see settled().)
    if (changed && (!running || sub.flags & ReactiveFlags.Pending)) {
      sub.flags |= ReactiveFlags.Dirty
    }
    if (flags & ReactiveFlags.Mutable && sub.subs !== undefined) {
      markDeep(sub.subs)
    }
  }
}

/**
 * `dep` (a ref, a computed) settled as changed: the subs a push left Pending
 * through it must run. They would find out by versions; marked, a check
 * stops at once instead of bringing up to date the deps they read before.
 * A running sub among them runs once more, as after propagate().
 */
export function settled(dep: ReactiveNode): void {
  for (let link = dep.subs; link !== undefined; link = link.nextSub) {
    const sub = link.sub
    const flags = sub.flags
    if (
      (flags & (ReactiveFlags.Pending | ReactiveFlags.Dirty)) ===
      ReactiveFlags.Pending
    ) {
      sub.flags = flags | ReactiveFlags.Dirty
    }
  }
}

/** Whether the running `sub` has read `link` in this run: at or before the cursor. */
function isRead(link: Link, sub: ReactiveNode): boolean {
  for (let l = sub.depsTail; l !== undefined; l = l.prevDep) {
    if (l === link) {
      return true
    }
  }
  return false
}

/**
 * Marks everything below the subscriber list `first`: depth first, without
 * recursion; `siblings` holds where to resume after a descent.
 */
function markDeep(first: Link): void {
  const base = siblings.length
  let link: Link | undefined = first
  for (;;) {
    while (link !== undefined) {
      const sub: ReactiveNode = link.sub
      if (mark(link, sub) & ReactiveFlags.Mutable) {
        const subs = sub.subs
        if (subs !== undefined) {
          if (link.nextSub !== undefined) {
            siblings.push(link.nextSub)
          }
          link = subs
          continue
        }
      }
      link = link.nextSub
    }
    if (siblings.length === base) {
      return
    }
    link = siblings.pop()!
  }
}

/**
 * Marks `sub` Pending through `link`, handing a watcher to the notify
 * buffer; returns the flags the push goes on with: `Mutable` descends.
 */
function mark(link: Link, sub: ReactiveNode): ReactiveFlags {
  if (__TEST__) stats.marks++
  const flags = sub.flags
  if (!(flags & (ReactiveFlags.Mutable | ReactiveFlags.Watching))) {
    // an effect scope owning a computed
    return ReactiveFlags.None
  }
  if (flags & ReactiveFlags.RecursedCheck) {
    // Running: a push through a link this run has not read yet changes
    // nothing, the run reads the new state. Through one it has read, the
    // sub is Pending and Recursed: a watcher is not notified in its own run
    // (see ReactiveEffect.run()), a computed passes the push on.
    if (
      flags & (ReactiveFlags.Pending | ReactiveFlags.Dirty) ||
      !isRead(link, sub)
    ) {
      return ReactiveFlags.None
    }
    sub.flags = flags | ReactiveFlags.Pending | ReactiveFlags.Recursed
    return flags & ReactiveFlags.Mutable
  }
  if (!(flags & ReactiveFlags.Pending)) {
    // Pushed while some effect runs: a push may still have to pass through
    // here after this one was swallowed by a running watcher below.
    sub.flags = runDepth
      ? flags | ReactiveFlags.Pending | ReactiveFlags.Recursed
      : flags | ReactiveFlags.Pending
  } else if (flags & ReactiveFlags.Recursed) {
    sub.flags = flags & ~ReactiveFlags.Recursed
  } else {
    // marked already: so is everything below
    return ReactiveFlags.None
  }
  if (flags & ReactiveFlags.Watching) {
    notifyBuffer[notifyBufferLength++] = sub as Effect
  }
  return flags
}

// -------------------------------------------------------------------- run

export function startTracking(sub: ReactiveNode): ReactiveNode | undefined {
  // a run that starts inside its own indexed run starts over without it
  if (sub.flags & ReactiveFlags.Indexed && indexSub === sub) {
    unindexDeps(sub)
  }
  if (__TEST__) stats.runs++
  sub.depsTail = undefined
  sub.flags =
    (sub.flags &
      ~(ReactiveFlags.Recursed | ReactiveFlags.Dirty | ReactiveFlags.Pending)) |
    ReactiveFlags.RecursedCheck
  return setActiveSub(sub)
}

/**
 * Ends the run of `sub`. A run that succeeded keeps the links it read and
 * nothing else. A failed run owes a run: it keeps what woke it before
 * (the links of its last successful run) and what it read, and drops the
 * links earlier failed runs read that this one did not.
 */
export function endTracking(
  sub: ReactiveNode,
  prevSub: ReactiveNode | undefined,
  failed = false,
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
  const cursor = sub.depsTail
  if (!failed) {
    cut(sub, cursor)
    sub.gen = (sub.gen! + 1) & VERSION_MASK
    sub.flags &= ~ReactiveFlags.RecursedCheck
    return
  }
  owe(sub, (sub.flags & ~ReactiveFlags.RecursedCheck) | ReactiveFlags.Dirty)
  const tentative = (sub.gen! + 1) & VERSION_MASK
  const base = orphans.length
  let link = cursor !== undefined ? cursor.nextDep : sub.deps
  while (link !== undefined) {
    const next: Link | undefined = link.nextDep
    if (link.gen === tentative) {
      const prev = link.prevDep
      if (prev !== undefined) {
        prev.nextDep = next
      } else {
        sub.deps = next
      }
      if (next !== undefined) {
        next.prevDep = prev
      }
      unsubscribe(link)
    }
    link = next
  }
  if (orphans.length > base) {
    releaseOrphans(base)
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

// ------------------------------------------------------------------- pull

/**
 * Whether `sub` must run: Dirty, or Pending and some dep changed since it
 * read it. Existential, in read order: deps are checked first to last and
 * the first changed one decides, so a dep the last run read only because
 * of an earlier one is not brought up to date for nothing. A Pending dep
 * is descended into (`descent` holds the link to come back through), a
 * Dirty one is brought up to date, then versions decide. Without recursion
 * but the user's: bringing a computed up to date runs it.
 */
export function checkDirty(sub: ReactiveNode): boolean {
  const flags = sub.flags
  if (flags & ReactiveFlags.Dirty) {
    return true
  }
  if (!(flags & ReactiveFlags.Pending)) {
    return false
  }
  // Pending stays until decided: Dirty is set over it, as a push would
  const base = descent.length
  try {
    if (checkFrom(sub, base)) {
      sub.flags |= ReactiveFlags.Dirty
      return true
    }
    sub.flags &= ~ReactiveFlags.Pending
    return false
  } catch (error) {
    // every node still being checked owes a run; the root is handed back
    // so that the next push notifies it again
    const top = descent.length
    if (top > base) {
      const node: ReactiveNode = descent[top - 1].dep
      owe(node, node.flags | ReactiveFlags.Dirty)
      for (let i = base; i < top; i++) {
        const sub: ReactiveNode = descent[i].sub
        owe(sub, sub.flags | ReactiveFlags.Dirty)
      }
      descent.length = base
    }
    owe(sub, (sub.flags | ReactiveFlags.Dirty) & ~ReactiveFlags.Pending)
    throw error
  }
}

function checkFrom(root: ReactiveNode, base: number): boolean {
  let node = root
  let link = root.deps
  for (;;) {
    while (link !== undefined) {
      if (__TEST__) stats.checks++
      const dep: ReactiveNode = link.dep
      const flags = dep.flags
      if (flags & (ReactiveFlags.Dirty | ReactiveFlags.Pending)) {
        if (!(flags & ReactiveFlags.Dirty)) {
          // clearing Pending on the way down also ends a walk around a cycle
          dep.flags = flags & ~ReactiveFlags.Pending
          descent.push(link)
          node = dep
          link = dep.deps
          continue
        }
        // a computed runs, a ref compares its value
        dep.update!()
      }
      if (dep.version !== link.version) {
        break
      }
      link = link.nextDep
    }
    if (link !== undefined) {
      if (node === root) {
        return true
      }
      node.update!()
    } else if (node === root) {
      return false
    }
    // ascend: `node` is up to date; a node whose dep changed runs as well
    for (;;) {
      const up = descent.pop()!
      node = up.sub
      if ((up.dep as ReactiveNode).version === up.version) {
        link = up.nextDep
        break
      }
      if (node === root) {
        return true
      }
      node.update!()
    }
  }
}
