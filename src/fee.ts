// jev-wilson/fee: the fee on a job settled through an ERC-8183 evaluator, priced from live gas so that the evaluator never
// pays more gas than it charges. Pure, integers only (bigint): the Python twin (python/taifoon_jev_wilson/fee.py) returns
// the same units on tests/vectors/fee-grid.json.
//
//   fee        = max( floor(P × bps / 10,000),  gas floor + margin )                     smallest units of the job token
//   gas floor  = Σ legs ( gas_i × (baseFee × (1 + buffer) + tip) + L1fee_i × (1 + buffer) ) × gasToken/USD × (1 + move)
//                rounded up
//   cap        = floor(P × capBps / 10,000)                                               the hook's evaluator-fee cap
//   served     = fee ≤ cap;  min_price = the smallest P whose cap holds the floor (below it the quote refuses)
//
// The legs are the evaluator side's own transactions on one job, measured from receipts (see calibration/legs/). The
// buffer is the p95 rise of the base fee over the quote's validity plus the settle horizon, measured from fee history
// (windowRiseBps). Every number that is a choice comes from a calibration file (calibration/<chainId>.json).

/** One of our transactions on a job: its gas (from a receipt), its signed size (for the L1 data fee) and who sends it. */
export type Leg = { leg: string; who: 'evaluator' | 'stand-in' | 'relayer'; gas: number; bytes: number };
export type FeeProfile = 'direct' | 'stand-in' | 'relayed';
export const FEE_PROFILES: readonly FeeProfile[] = ['direct', 'stand-in', 'relayed'];

/** The numbers of the fee rule. bps, margin, move, TTL and horizon are policy; the buffer is measured. */
export type FeePolicy = {
  /** the fee in bps of the price */ bps: number;
  /** added to the gas floor, in whole tokens (USDC) */ marginUsdc: number;
  /** headroom on the base fee and the L1 fee, bps */ gasBufferBps: number;
  /** headroom on the gas token's USD price between the quote and our legs, bps (0 when the gas token is the job token) */ ethMoveBps: number;
  /** how long a quote is valid, s */ quoteTtlS: number;
  /** how long after the quote our last leg may be sent, s */ settleHorizonS: number;
  /** the reward percentile the tip is read at */ tipPercentile: number;
  /** an older gas-token price refuses the quote, s */ maxPriceAgeS: number;
  /** the hook's cap on the evaluator fee, bps of the price */ capBps: number;
};

/** What a quote reads from the chain. */
export type GasInputs = {
  chainId: number; block: number;
  /** the next block's base fee */ baseFeeWei: bigint;
  /** the priority fee we pay */ tipWei: bigint;
  /** the p95 rise of the base fee over the horizon in the quote's own window, bps */ liveBufferBps: number;
  /** the L1 data fee per signed transaction size, in gas-token wei (empty when the chain has none) */ l1FeeWeiByBytes: Record<number, bigint>;
  /** USD per whole gas token, 8 decimals (ETH/USD; 1e8 on a chain whose gas token is USDC) */ gasUsd8: bigint;
};

export type FeeQuote = {
  served: boolean; fee: bigint | null; byBps: bigint; floor: bigint; cap: bigint; minPrice: bigint; floored: boolean; margin: bigint;
  gas: { units: number; bufferBps: number; gasPrice: bigint; l2: bigint; l1: bigint; total: bigint; usdc: bigint; l1Legs: bigint[] };
};

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** `x` whole tokens in smallest units, rounded up. */
export function tokenUnits(x: number, decimals = 6): bigint {
  return BigInt(Math.ceil(x * 10 ** decimals));
}

/** The gas floor of a set of legs in job-token units, with its working. Pure. */
export function gasFloor(gas: GasInputs, legs: readonly Leg[], policy: FeePolicy, decimals = 6) {
  const bufferBps = Math.max(policy.gasBufferBps, gas.liveBufferBps);
  const buf = (x: bigint) => (x * BigInt(10_000 + bufferBps)) / 10_000n;
  const gasPrice = buf(gas.baseFeeWei) + gas.tipWei;
  const units = legs.reduce((s, l) => s + l.gas, 0);
  const l2 = BigInt(units) * gasPrice;
  const l1Legs = legs.map((l) => {
    if (Object.keys(gas.l1FeeWeiByBytes).length === 0) return 0n;
    const f = gas.l1FeeWeiByBytes[l.bytes];
    if (f === undefined) throw new Error(`no L1 fee read for a ${l.bytes}-byte transaction`);
    return buf(f);
  });
  const l1 = l1Legs.reduce((s, x) => s + x, 0n);
  const total = l2 + l1;
  // wei × (USD × 1e8) × (1 + move) / 1e18 / 1e8 → USD; × 10^decimals → token units; rounded UP (never under-charge gas)
  const num = total * gas.gasUsd8 * BigInt(10_000 + policy.ethMoveBps) * 10n ** BigInt(decimals);
  const usdc = ceilDiv(num, 10n ** 18n * 10n ** 8n * 10_000n);
  return { usdc, bufferBps, gasPrice, units, l2, l1, total, l1Legs };
}

/** The fee on a job of `price` (job-token units). Pure. */
export function jobFee(price: bigint, gas: GasInputs, legs: readonly Leg[], policy: FeePolicy, decimals = 6): FeeQuote {
  if (price <= 0n) throw new RangeError('price must be positive');
  if (!legs.length) throw new RangeError('no legs');
  const g = gasFloor(gas, legs, policy, decimals);
  const margin = tokenUnits(policy.marginUsdc, decimals);
  const floor = g.usdc + margin;
  const byBps = (price * BigInt(policy.bps)) / 10_000n;
  const cap = (price * BigInt(policy.capBps)) / 10_000n;
  const minPrice = ceilDiv(floor * 10_000n, BigInt(policy.capBps));
  const want = byBps >= floor ? byBps : floor;
  const served = want <= cap;
  return {
    served, fee: served ? want : null, byBps, floor, cap, minPrice, floored: served && floor > byBps, margin,
    gas: { units: g.units, bufferBps: g.bufferBps, gasPrice: g.gasPrice, l2: g.l2, l1: g.l1, total: g.total, usdc: g.usdc, l1Legs: g.l1Legs },
  };
}

/** The p95 rise of the base fee over `w` blocks: for each block i, max(baseFees[i..i+w]) / baseFees[i] − 1, in bps (0 when
 *  it fell), then the 95th percentile (index floor(0.95 × count)). `w` is clamped to the series. Monotone deque: O(n). */
export function windowRiseBps(baseFees: readonly bigint[], w: number): number {
  return riseQuantilesBps(baseFees, w, [0.95])[0]!;
}

/** The rises of windowRiseBps at several quantiles. Pure. */
export function riseQuantilesBps(baseFees: readonly bigint[], w: number, qs: readonly number[]): number[] {
  const rises = windowRises(baseFees, w);
  if (!rises.length) return qs.map(() => 0);
  rises.sort((a, b) => a - b);
  return qs.map((q) => rises[Math.min(rises.length - 1, Math.floor(q * rises.length))]!);
}

/** Every block's rise over the next `w` blocks, bps (unsorted). Pure. */
export function windowRises(baseFees: readonly bigint[], w: number): number[] {
  const n = baseFees.length;
  if (n < 2) return [];
  const win = Math.max(1, Math.min(w, n - 1));
  const out: number[] = [];
  const dq: number[] = []; // indices, base fees decreasing
  let head = 0;
  // sweep from the right: at i, the deque holds the window (i, i + win]
  const mx = new Array<bigint>(n);
  for (let i = n - 1; i >= 0; i--) {
    while (dq.length > head && dq[head]! > i + win) head++;
    mx[i] = dq.length > head ? baseFees[dq[head]!]! : -1n;
    while (dq.length > head && baseFees[dq[dq.length - 1]!]! <= baseFees[i]!) dq.pop();
    dq.push(i);
    if (head > dq.length) head = dq.length;
  }
  for (let i = 0; i + win < n; i++) {
    const now = baseFees[i]!;
    const m = mx[i]! > now ? mx[i]! : now;
    out.push(now > 0n ? Number(((m - now) * 10_000n) / now) : 0);
  }
  return out;
}

/** The fee on a hire paid to the seller by x402 (the buyer leg), when there is no settle line on the chain: no hook, so no
 *  evaluator fee, no hook cap and no cover. On `exact` the payment is an EIP-3009 transferWithAuthorization that the seller's
 *  facilitator sends and pays the gas of, so our gas is 0 and the fee is our routing and grade fee:
 *
 *    fee = max( floor(P × bps / 10,000),  our gas + margin )        our gas = 0 on exact
 *
 *  `shareBps` = fee / P in bps (floored). Pure, integers only; the Python twin is fee.x402_fee. */
export type X402Fee = { fee: bigint; byBps: bigint; floor: bigint; floored: boolean; shareBps: number; ourGas: bigint };
export function x402Fee(price: bigint, policy: Pick<FeePolicy, 'bps' | 'marginUsdc'>, ourGasUnits = 0n, decimals = 6): X402Fee {
  if (price <= 0n) throw new RangeError('price must be positive');
  if (ourGasUnits < 0n) throw new RangeError('our gas cannot be negative');
  const floor = ourGasUnits + tokenUnits(policy.marginUsdc, decimals);
  const byBps = (price * BigInt(policy.bps)) / 10_000n;
  const fee = byBps >= floor ? byBps : floor;
  return { fee, byBps, floor, floored: floor > byBps, shareBps: Number((fee * 10_000n) / price), ourGas: ourGasUnits };
}
