// @ts-check
// Turns a revision into a frozen production bundle of @vue/reactivity.
//
// A git revision is built by the repository's own `scripts/build.js` in a
// throwaway worktree that shares this checkout's node_modules, so the bundle
// is exactly what `pnpm build` produces for that commit and the working tree
// is never touched. Bundles are cached by commit SHA.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

const BUNDLE = 'packages/reactivity/dist/reactivity.esm-browser.prod.js'

/**
 * @typedef {object} Bundle
 * @property {string} label  what the user asked for
 * @property {string} file   absolute path of the bundle
 * @property {string} sha256 content hash
 * @property {number} size   bytes
 * @property {string} [commit] full commit SHA, for git revisions
 * @property {string} [subject] commit subject, for git revisions
 */

/**
 * @param {string} spec a git revision, `worktree` (the current files,
 *   uncommitted changes included), or a path to a built bundle
 * @param {{ root: string, cache: string, rebuild?: boolean, log: (s: string) => void }} options
 * @returns {Bundle}
 */
export function resolveBundle(spec, { root, cache, rebuild, log }) {
  if (spec.endsWith('.js') && existsSync(spec)) {
    return describe(spec, path.resolve(spec))
  }

  if (spec === 'worktree') {
    log(`building the working tree`)
    build(root)
    const file = path.join(cache, 'bundles', `worktree.js`)
    mkdirSync(path.dirname(file), { recursive: true })
    copyFileSync(path.join(root, BUNDLE), file)
    return describe(spec, file)
  }

  const commit = git(root, ['rev-parse', '--verify', `${spec}^{commit}`])
  const subject = git(root, ['log', '-1', '--format=%s', commit])
  const file = path.join(cache, 'bundles', `${commit}.js`)
  if (rebuild || !existsSync(file)) {
    log(`building ${spec} (${commit.slice(0, 9)}) in a worktree`)
    buildCommit(root, cache, commit, file, log)
  }
  return { ...describe(spec, file), commit, subject }
}

/**
 * @param {string} root
 * @param {string} cache
 * @param {string} commit
 * @param {string} file
 * @param {(s: string) => void} log
 */
function buildCommit(root, cache, commit, file, log) {
  const dir = path.join(cache, 'worktrees', commit.slice(0, 12))
  const modules = path.join(dir, 'node_modules')
  if (existsSync(dir)) {
    removeWorktree(root, dir, modules)
  }
  git(root, ['worktree', 'add', '--detach', dir, commit])
  try {
    // The lockfile decides which toolchain builds the bundle. A commit with
    // another lockfile is built by this checkout's toolchain, not its own.
    const lock = readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8')
    if (readFileSync(path.join(dir, 'pnpm-lock.yaml'), 'utf8') !== lock) {
      log(
        `warning: ${commit.slice(0, 9)} has another pnpm-lock.yaml; ` +
          `it is built with the installed dependencies`,
      )
    }
    // A junction needs no privileges on Windows; elsewhere `type` is ignored.
    symlinkSync(path.join(root, 'node_modules'), modules, 'junction')
    build(dir)
    mkdirSync(path.dirname(file), { recursive: true })
    copyFileSync(path.join(dir, BUNDLE), file)
    writeFileSync(
      file.replace(/\.js$/, '.json'),
      JSON.stringify(
        {
          commit,
          subject: git(root, ['log', '-1', '--format=%s', commit]),
          builtAt: new Date().toISOString(),
          node: process.version,
        },
        null,
        2,
      ),
    )
  } finally {
    removeWorktree(root, dir, modules)
  }
}

/**
 * Removes the shared node_modules link first: a recursive delete must never
 * reach through it into this checkout's node_modules.
 * @param {string} root
 * @param {string} dir
 * @param {string} modules
 */
function removeWorktree(root, dir, modules) {
  if (isLink(modules)) {
    unlinkSync(modules)
  }
  if (existsSync(modules)) {
    throw new Error(`refusing to remove ${dir}: node_modules is not a link`)
  }
  git(root, ['worktree', 'remove', '--force', dir])
  git(root, ['worktree', 'prune'])
}

/** @param {string} file */
function isLink(file) {
  try {
    return lstatSync(file).isSymbolicLink()
  } catch {
    return false
  }
}

/** @param {string} cwd */
function build(cwd) {
  execFileSync(
    process.execPath,
    ['scripts/build.js', '-pf', 'esm-browser', 'reactivity'],
    { cwd, stdio: 'pipe' },
  )
}

/**
 * @param {string} label
 * @param {string} file
 * @returns {Bundle}
 */
function describe(label, file) {
  const code = readFileSync(file)
  return {
    label,
    file,
    sha256: createHash('sha256').update(code).digest('hex'),
    size: code.length,
  }
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim()
}
