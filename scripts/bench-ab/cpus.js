// @ts-check
// Pins each sample to one logical CPU. On a hybrid processor the
// performance and efficiency cores run the same code faster or slower by
// different amounts, so results are only comparable within one class: each
// class gets its own measurement.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'

/**
 * @typedef {object} CpuClass
 * @property {string} name  `P`, `E`, `cpuN`, or `any` when unpinned
 * @property {number | null} cpu the logical CPU samples are pinned to
 */

/**
 * @param {string} cores `auto`, `none`, or a comma list of logical CPUs
 * @param {(s: string) => void} log
 * @returns {CpuClass[]}
 */
export function cpuClasses(cores, log) {
  if (cores === 'none') {
    return [{ name: 'any', cpu: null }]
  }
  if (cores !== 'auto') {
    return cores.split(',').map(s => ({ name: `cpu${s}`, cpu: Number(s) }))
  }
  if (!canPin()) {
    log(`warning: cannot pin processes here, samples run unpinned`)
    return [{ name: 'any', cpu: null }]
  }
  const hybrid = hybridClasses()
  if (hybrid) {
    return hybrid
  }
  // The last CPU: CPU 0 takes most interrupts and runner housekeeping.
  const cpu = os.availableParallelism() - 1
  return [{ name: `cpu${cpu}`, cpu }]
}

/**
 * Pins a running process to one logical CPU, before it starts measuring.
 * @param {number} pid
 * @param {number} cpu
 */
export function pin(pid, cpu) {
  if (process.platform === 'win32') {
    const mask = 2n ** BigInt(cpu)
    const affinity = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-Process -Id ${pid}; $p.ProcessorAffinity = [IntPtr]${mask}; ` +
          `$p.Refresh(); [string]$p.ProcessorAffinity`,
      ],
      { encoding: 'utf8', stdio: 'pipe' },
    ).trim()
    if (affinity !== String(mask)) {
      throw new Error(`could not pin ${pid} to cpu ${cpu}: ${affinity}`)
    }
    return
  }
  execFileSync('taskset', ['-p', '-c', String(cpu), String(pid)], {
    stdio: 'pipe',
  })
}

function canPin() {
  if (process.platform === 'win32') {
    return true
  }
  try {
    execFileSync('taskset', ['-V'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/**
 * Linux lists the CPUs of each class of a hybrid processor.
 * @returns {CpuClass[] | null}
 */
function hybridClasses() {
  const p = '/sys/devices/cpu_core/cpus'
  const e = '/sys/devices/cpu_atom/cpus'
  if (!existsSync(p) || !existsSync(e)) {
    return null
  }
  // not the first CPU of a class: the first two are often SMT siblings
  const pick = (/** @type {string} */ file) => {
    const cpus = parseRanges(readFileSync(file, 'utf8'))
    return cpus[Math.min(2, cpus.length - 1)]
  }
  return [
    { name: 'P', cpu: pick(p) },
    { name: 'E', cpu: pick(e) },
  ]
}

/** @param {string} text e.g. `0-3,8,10-11` */
function parseRanges(text) {
  return text
    .trim()
    .split(',')
    .flatMap(part => {
      const [from, to = from] = part.split('-').map(Number)
      return Array.from({ length: to - from + 1 }, (_, i) => from + i)
    })
}
