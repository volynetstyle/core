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
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

const PROD = 'packages/reactivity/dist/reactivity.esm-browser.prod.js'
const DEV = 'packages/reactivity/dist/reactivity.esm-browser.js'

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
 * @param {{ root: string, cache: string, rebuild?: boolean, dev?: boolean, log: (s: string) => void }} options
 *   `dev`: the development bundle (warnings, debug hooks) instead of the
 *   production one
 * @returns {Bundle}
 */
export function resolveBundle(spec, { root, cache, rebuild, dev, log }) {
  const bundle = dev ? DEV : PROD
  const suffix = dev ? '.dev' : ''
  if (spec.endsWith('.js') && existsSync(spec)) {
    return describe(spec, path.resolve(spec))
  }

  if (spec === 'worktree') {
    log(`building the working tree`)
    build(root, dev)
    const file = path.join(cache, 'bundles', `worktree${suffix}.js`)
    mkdirSync(path.dirname(file), { recursive: true })
    copyFileSync(path.join(root, bundle), file)
    return describe(spec, file)
  }

  const commit = git(root, ['rev-parse', '--verify', `${spec}^{commit}`])
  const subject = git(root, ['log', '-1', '--format=%s', commit])
  const file = path.join(cache, 'bundles', `${commit}${suffix}.js`)
  if (rebuild || !existsSync(file)) {
    log(`building ${spec} (${commit.slice(0, 9)}) in a worktree`)
    buildCommit(root, cache, commit, file, bundle, dev, log)
  }
  return { ...describe(spec, file), commit, subject }
}

/**
 * @param {string} root
 * @param {string} cache
 * @param {string} commit
 * @param {string} file
 * @param {string} bundle
 * @param {boolean | undefined} dev
 * @param {(s: string) => void} log
 */
function buildCommit(root, cache, commit, file, bundle, dev, log) {
  withWorktree(root, cache, commit, log, dir => {
    build(dir, dev)
    mkdirSync(path.dirname(file), { recursive: true })
    copyFileSync(path.join(dir, bundle), file)
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
  })
}

/**
 * Runs `fn` in a throwaway worktree of `commit` that shares this checkout's
 * node_modules (the root's and each package's), and removes it after.
 * @template T
 * @param {string} root
 * @param {string} cache
 * @param {string} commit
 * @param {(s: string) => void} log
 * @param {(dir: string) => T} fn
 * @returns {T}
 */
export function withWorktree(root, cache, commit, log, fn) {
  const dir = path.join(cache, 'worktrees', commit.slice(0, 12))
  if (existsSync(dir)) {
    removeWorktree(root, dir)
  }
  git(root, ['worktree', 'add', '--detach', dir, commit])
  try {
    // The lockfile decides which toolchain runs. A commit with another
    // lockfile runs with this checkout's dependencies, not its own.
    const lock = readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8')
    if (readFileSync(path.join(dir, 'pnpm-lock.yaml'), 'utf8') !== lock) {
      log(
        `warning: ${commit.slice(0, 9)} has another pnpm-lock.yaml; ` +
          `it runs with the installed dependencies`,
      )
    }
    for (const modules of moduleDirs(root)) {
      const target = path.join(dir, path.relative(root, modules))
      if (existsSync(path.dirname(target)) && !existsSync(target)) {
        // A junction needs no privileges on Windows; elsewhere `type` is ignored.
        symlinkSync(modules, target, 'junction')
      }
    }
    return fn(dir)
  } finally {
    removeWorktree(root, dir)
  }
}

/** The node_modules directories of this checkout: the root's and each package's. */
function moduleDirs(/** @type {string} */ root) {
  const dirs = [path.join(root, 'node_modules')]
  for (const group of ['packages', 'packages-private']) {
    const base = path.join(root, group)
    if (!existsSync(base)) continue
    for (const name of readdirSync(base)) {
      const modules = path.join(base, name, 'node_modules')
      if (existsSync(modules)) dirs.push(modules)
    }
  }
  return dirs
}

/**
 * Removes the shared node_modules links first: a recursive delete must never
 * reach through one of them into this checkout's node_modules.
 * @param {string} root
 * @param {string} dir
 */
function removeWorktree(root, dir) {
  for (const modules of moduleDirs(root)) {
    const link = path.join(dir, path.relative(root, modules))
    if (isLink(link)) {
      unlinkSync(link)
    }
    if (existsSync(link)) {
      throw new Error(`refusing to remove ${dir}: ${link} is not a link`)
    }
  }
  try {
    git(root, ['worktree', 'remove', '--force', dir])
  } catch {
    // Windows may still hold files of the build for a moment
    try {
      rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      })
    } catch (error) {
      process.stderr.write(`warning: could not remove ${dir}: ${error}\n`)
    }
  }
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

/**
 * @param {string} cwd
 * @param {boolean | undefined} dev
 */
function build(cwd, dev) {
  execFileSync(
    process.execPath,
    ['scripts/build.js', dev ? '-f' : '-pf', 'esm-browser', 'reactivity'],
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
  /** @type {Bundle} */
  const bundle = {
    label,
    file,
    sha256: createHash('sha256').update(code).digest('hex'),
    size: code.length,
  }
  // a bundle built from a commit carries its commit next to it
  const meta = file.replace(/\.js$/, '.json')
  if (existsSync(meta)) {
    const { commit, subject } = JSON.parse(readFileSync(meta, 'utf8'))
    Object.assign(bundle, { commit, subject })
  }
  return bundle
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
