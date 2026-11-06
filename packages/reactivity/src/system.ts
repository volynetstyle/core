// Ported from alien-signals. Diff against upstream main:
// https://github.com/stackblitz/alien-signals/compare/7e53655f40c3dd298168c278b3bf248a72f742d9...main
import type { ComputedRefImpl as Computed } from './computed.js'
import type { ReactiveEffect as Effect } from './effect.js'
import type { EffectScope } from './effectScope.js'
import { stats } from './stats.js'
import { warn } from './warning.js'

export interface ReactiveNode {
  deps?: Link
  depsTail?: Link
  subs?: Link
  subsTail?: Link
  flags: ReactiveFlags
}

export interface Link {
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
  /** The running sub has marked the links it has not read yet `UNREAD`. */
  Marked = 1 << 6,
}

/**
 * Links a bounded scan visits on each side of the cursor. A constant keeps
 * the cost of a read independent of how many deps its sub has.
 */
const SCAN_BUDGET = 8

/** `Link.version` of a link its sub's marked run has not read yet. */
const UNREAD = -1

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

let globalVersion = 0
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

export function link(dep: ReactiveNode, sub: ReactiveNode): void {
  if (__TEST__) stats.reads++
  const prevDep = sub.depsTail
  if (prevDep !== undefined && prevDep.dep === dep) {
    if (__TEST__) stats.repeats++
    return
  }
  const nextDep = prevDep !== undefined ? prevDep.nextDep : sub.deps
  if (nextDep !== undefined && nextDep.dep === dep) {
    if (__TEST__) stats.hits++
    nextDep.version = globalVersion
    sub.depsTail = nextDep
    return
  }
  linkMiss(dep, sub, prevDep, nextDep)
}

/**
 * The slow half of `link()`, kept out of line so the fast half stays small:
 * `dep` is neither the dep read just before nor the next one in the last
 * run's order.
 */
function linkMiss(
  dep: ReactiveNode,
  sub: ReactiveNode,
  prevDep: Link | undefined,
  nextDep: Link | undefined,
): void {
  // Only a running sub reconciles its reads with the last run (an effect
  // scope links the effects it owns without running), and only for a dep
  // that has subscribers: one without has no link to find.
  if (
    sub.flags & ReactiveFlags.RecursedCheck &&
    dep.subs !== undefined &&
    findLink(dep, sub, prevDep, nextDep)
  ) {
    return
  }
  const prevSub = dep.subsTail
  if (
    prevSub !== undefined &&
    prevSub.version === globalVersion &&
    prevSub.sub === sub
  ) {
    if (__TEST__) stats.tailRepeats++
    return
  }
  if (__TEST__) stats.links++
  const newLink =
    (sub.depsTail =
    dep.subsTail =
      {
        version: globalVersion,
        dep,
        sub,
        prevDep,
        nextDep,
        prevSub,
        nextSub: undefined,
      })
  if (nextDep !== undefined) {
    nextDep.prevDep = newLink
  }
  if (prevDep !== undefined) {
    prevDep.nextDep = newLink
  } else {
    sub.deps = newLink
  }
  if (prevSub !== undefined) {
    prevSub.nextSub = newLink
  } else {
    dep.subs = newLink
  }
}

/**
 * Looks for the link of a running `sub` to `dep`, moving it to the cursor if
 * this run has not read it yet. Near the cursor first: a few links ahead,
 * where the last run read `dep` later, or a few links behind, where this
 * run has read `dep` already. Then among the first subscribers of `dep`; a
 * link found there needs the run's unread links marked to tell whether it
 * was read. Returns false if the link does not exist, or if no bounded
 * search can find it.
 */
function findLink(
  dep: ReactiveNode,
  sub: ReactiveNode,
  prevDep: Link | undefined,
  nextDep: Link | undefined,
): boolean {
  let found: Link | undefined | null
  if (!(sub.flags & ReactiveFlags.Marked)) {
    let ahead = nextDep !== undefined ? nextDep.nextDep : undefined
    let budget = SCAN_BUDGET
    while (ahead !== undefined && ahead.dep !== dep && --budget) {
      ahead = ahead.nextDep
    }
    if (ahead !== undefined && ahead.dep === dep) {
      moveLink(ahead, sub, prevDep, nextDep!)
      return true
    }
    let behind = prevDep !== undefined ? prevDep.prevDep : undefined
    budget = SCAN_BUDGET
    while (behind !== undefined && behind.dep !== dep && --budget) {
      behind = behind.prevDep
    }
    if (behind !== undefined && behind.dep === dep) {
      if (__TEST__) stats.dups++
      return true
    }
    // both scans reached the ends of the list: there is no link
    if (ahead === undefined && behind === undefined) {
      return false
    }
    found = findSub(dep, sub)
    // Found as the first subscriber, later lookups through the deps'
    // subscribers likely end at once: mark. Found deeper, each would walk
    // other subs' links.
    if (found === undefined || found === null || found !== dep.subs) {
      return false
    }
    markUnread(sub, nextDep)
  } else {
    found = findSub(dep, sub)
    if (found === undefined || found === null) {
      return false
    }
  }
  if (found.version !== UNREAD) {
    if (__TEST__) stats.dups++
  } else {
    moveLink(found, sub, prevDep, nextDep!)
  }
  return true
}

/**
 * The link of `sub` among the first subscribers of `dep`: undefined if the
 * list ends first, null if the budget runs out first.
 */
function findSub(
  dep: ReactiveNode,
  sub: ReactiveNode,
): Link | undefined | null {
  if (__TEST__) stats.lookups++
  let budget = SCAN_BUDGET
  for (let link = dep.subs; link !== undefined; link = link.nextSub) {
    if (link.sub === sub) {
      return link
    }
    if (!--budget) {
      return null
    }
  }
  return undefined
}

/**
 * Marks the links the run has not read yet, from `nextDep` on, so that a
 * link found through its dep tells whether this run has read it. Once per
 * run: later reads keep the marks exact.
 */
function markUnread(sub: ReactiveNode, nextDep: Link | undefined): void {
  if (__TEST__) stats.sweeps++
  sub.flags |= ReactiveFlags.Marked
  for (let link = nextDep; link !== undefined; link = link.nextDep) {
    link.version = UNREAD
  }
}

/** Moves an unread link from behind `nextDep` to the cursor. */
function moveLink(
  link: Link,
  sub: ReactiveNode,
  prevDep: Link | undefined,
  nextDep: Link,
): void {
  if (__TEST__) stats.moves++
  const before = link.prevDep!
  const after = link.nextDep
  before.nextDep = after
  if (after !== undefined) {
    after.prevDep = before
  }
  link.prevDep = prevDep
  link.nextDep = nextDep
  nextDep.prevDep = link
  if (prevDep !== undefined) {
    prevDep.nextDep = link
  } else {
    sub.deps = link
  }
  link.version = globalVersion
  sub.depsTail = link
}

export function unlink(
  link: Link,
  sub: ReactiveNode = link.sub,
): Link | undefined {
  if (__TEST__) stats.unlinks++
  const dep = link.dep
  const prevDep = link.prevDep
  const nextDep = link.nextDep
  const nextSub = link.nextSub
  const prevSub = link.prevSub
  if (nextDep !== undefined) {
    nextDep.prevDep = prevDep
  } else {
    sub.depsTail = prevDep
  }
  if (prevDep !== undefined) {
    prevDep.nextDep = nextDep
  } else {
    sub.deps = nextDep
  }
  if (nextSub !== undefined) {
    nextSub.prevSub = prevSub
  } else {
    dep.subsTail = prevSub
  }
  if (prevSub !== undefined) {
    prevSub.nextSub = nextSub
  } else if ((dep.subs = nextSub) === undefined) {
    let toRemove = dep.deps
    if (toRemove !== undefined) {
      do {
        toRemove = unlink(toRemove, dep)
      } while (toRemove !== undefined)
      dep.flags |= ReactiveFlags.Dirty
    }
  }
  return nextDep
}

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

export function startTracking(sub: ReactiveNode): ReactiveNode | undefined {
  ++globalVersion
  sub.depsTail = undefined
  sub.flags =
    (sub.flags &
      ~(
        ReactiveFlags.Recursed |
        ReactiveFlags.Dirty |
        ReactiveFlags.Pending |
        ReactiveFlags.Marked
      )) |
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

  const depsTail = sub.depsTail
  let toRemove = depsTail !== undefined ? depsTail.nextDep : sub.deps
  while (toRemove !== undefined) {
    toRemove = unlink(toRemove, sub)
  }
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
