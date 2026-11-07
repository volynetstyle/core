// @ts-check

/** @param {number[]} xs */
export function median(xs) {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length & 1 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * B/A throughput ratio from ABBA rounds, with a 95% bootstrap interval
 * that resamples whole rounds (a round's four samples share its noise).
 * @param {{ a: number[], b: number[] }[]} rounds
 * @param {number} [resamples]
 */
export function ratio(rounds, resamples = 4000) {
  const estimate = (/** @type {typeof rounds} */ rs) =>
    median(rs.flatMap(r => r.b)) / median(rs.flatMap(r => r.a))
  const value = estimate(rounds)
  if (rounds.length < 2) {
    return { value, low: value, high: value }
  }
  // fixed seed: the same samples give the same interval
  let seed = 0x2545f491
  const random = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 2 ** 32
  }
  const values = []
  for (let k = 0; k < resamples; k++) {
    const pick = rounds.map(() => rounds[Math.floor(random() * rounds.length)])
    values.push(estimate(pick))
  }
  values.sort((x, y) => x - y)
  return {
    value,
    low: values[Math.floor(resamples * 0.025)],
    high: values[Math.ceil(resamples * 0.975) - 1],
  }
}
