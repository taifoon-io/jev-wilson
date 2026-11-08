// jev-wilson/wilson-core: the Wilson bound and the premium amount, with no imports, so the economy can be vendored as one
// self-contained file. wilson.ts re-exports everything here; see it for the rules.

/** z for a two-sided 95% interval, as the layer pins it. */
export const Z = 1.959963984540054;
/** The layer's pool rule: no pool covers above this premium ratio. */
export const MAX_PREMIUM_RATIO = 0.3;
/** The premium ratio is rounded to millionths before it multiplies the price. */
export const RATIO_SCALE = 1_000_000;

export function checkRecord(k: number, n: number): void {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n < 0 || k > n) {
    throw new RangeError(`need integers 0 <= k <= n, got k=${k}, n=${n}`);
  }
}

/** The Wilson score interval for `successes` of `n`. [0, 1] when n = 0. Same operations, same order as the layer. */
export function wilson(successes: number, n: number, z: number = Z): [number, number] {
  if (n <= 0) return [0, 1];
  const p = successes / n, z2 = z * z;
  const d = 1 + z2 / n;
  const c = p + z2 / (2 * n);
  const s = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
}

/** p_L: the lower Wilson bound on the delivered rate, k delivered of n graded. */
export function wilsonLower(k: number, n: number, z: number = Z): number {
  checkRecord(k, n);
  return wilson(k, n, z)[0];
}

/** u_F: the upper Wilson bound on the failure rate, n - k failed of n. This is the layer's π ratio. */
export function wilsonUpperFailure(k: number, n: number, z: number = Z): number {
  checkRecord(k, n);
  return wilson(n - k, n, z)[1];
}

/** JavaScript Math.round, kept explicit so the Python twin can match it. */
const roundHalfUp = (x: number): number => Math.round(x);

/** floor(price × round(ratio × 1e6) / 1e6), exactly as the layer's pool-quote computes it. */
export function premiumAmount(price: bigint, ratio: number): bigint {
  if (price <= 0n) throw new RangeError('price must be a positive integer in the token’s smallest unit');
  return (price * BigInt(roundHalfUp(ratio * RATIO_SCALE))) / BigInt(RATIO_SCALE);
}
