// jev-wilson/economy: every number of one assured job, from the seller's record. The one place the assurance economy is
// defined (owner, 2026-10-06: "jev-wilson for all the math, sizing and assurance"). AssuranceHook V5.1 only BOUNDS what
// this returns; the TypeScript, the Python twin (python/taifoon_jev_wilson/economy.py) and the Solidity library
// (solidity/src/EconomyQuote.sol) return the same units on tests/vectors/economy-grid.json (difference 0).
//
// Inputs: the price P, the record (k delivered, f failed; n = k + f), the seconds T the cover stays locked, whether an
// arbitrator can find cheating on the hook, the cover multiple m, and the job fee F (fee.ts jobFee: max(bps, our gas +
// margin) at the quoted gas; the layer's floor).
//
//   r          = round(u_F × 1e6)                 u_F = wilsonUpperFailure(k, n), the 95 % Wilson upper bound on the failure
//                                                 rate; r = 1e6 (u_F = 1) when nothing was ever delivered (k = 0)
//   W          = floor(P × r / 1e6)               the Wilson premium (wilson.ts premiumAmount)
//   L          = lpPremium(P, record, T, arb, m)  what the backers need (lp.ts: expected loss + risk + capital + ops),
//                                                 computed exactly by lpPremiumUnits (the same formula in integers)
//   priced     = max(W, L + F)                    the premium the record prices
//   covered    = k > 0  and  L > 0  and  priced × 1e6 ≤ P × maxRatioE6   (maxRatioE6 = round(lp.maxRatio × 1e6): 300,000;
//                L = 0 only with zero ops and no lock: cover nobody is paid for is never sold)
//   premium    = priced if covered, else 0        an uncovered job carries no premium (no pool earns it)
//   toBackers  = L                                the backers' leg: exactly what they need
//   toLayer    = premium − L                      the layer's leg, ≥ F ≥ 0 by construction: never negative for us
//   coverCap   = floor(P × m / 10,000)            the hook's maxCoverFor(P) at multiple m
//   compensation = min(priced, P)                 paid to the buyer from the deposit on a no-show AND on a rejection that stands
//   deposit    = P + max(compensation, ceil(coverCap × r / 1e6))
//
// Why each choice (whitepaper §6 and §7; README "The economy, from the record"):
//   premium    max(·,·) so neither side is under-priced: the Wilson bound alone charged less than the backers need once a
//              record is long (50/1000 on 10 USDC: 0.653 vs 0.716 + 0.049 fee), and lpPremium alone ignores how little a
//              short record proves (1/20: 1.602 vs a 2.361 bound). §7: revenue sits where judgment or capital is consumed:
//              capital → L to the backers; judgment (the evaluator leg, the record, the quote) → at least F to the layer.
//   compensation  the buyer of a job that failed without a cheat finding gets its escrow back and, from the seller's deposit,
//              the price the record put on that failure: it re-buys the same assurance on the re-hire, and on a standing
//              rejection it has also paid the evaluator fee (F ≤ L + F ≤ priced). Capped at P: compensation is not a slash
//              (§6 T3's over-compensation, the whole deposit, stays reserved for an adjudicated cheat). It also extends §6 T1
//              to shirking: delivering junk is negative-EV once the rejection rate q ≥ P / (P + compensation), and the cost
//              grows with a bad record. Before V5 a no-show cost the seller nothing (§6 lists NoShow as a move, no theorem
//              priced it).
//   deposit    D > P is the hook's T1 floor (the seller pays any loss up to the price first). On top the seller stakes the
//              compensation it may forfeit (so every compensation is collateralised at funding) or, if larger, the 95 %
//              upper-bound expected loss on the cover cap (so the pool is asked only for loss beyond what the record itself
//              predicts). Both shrink with the record: the longer and cleaner it is, the cheaper it is to be trusted (§6, the
//              frontier "collapses the bond every honest participant must lock").
//
// quoteEconomyFor (calibration.ts) takes F from a chain's calibration. Imports only wilson-core.ts and lp.ts, so
// the three can be vendored as one self-contained file.
//
// Pure. Integers (bigint) throughout, except u_F, which is wilson.ts's own double (rounded to millionths exactly as the
// layer and WilsonPremium.sol round it). L is lpPremiumUnits: lp.ts's formula with every term floored at 1e-27 of a unit,
// the same integer steps as the Solidity library and the Python twin, so the three agree by construction.

import { wilsonUpperFailure, premiumAmount, RATIO_SCALE } from './wilson-core.ts';
import { LP_DEFAULTS, YEAR_S, type LpParams, type LpRecord } from './lp.ts';

export const ECONOMY_VERSION = 'jev-wilson.economy.v1';
/** The largest price (token units) quoted: the Solidity library's domain (every product stays under 2^256). */
export const MAX_PRICE_UNITS = 10n ** 30n;
const WAD = 10n ** 18n;
const R = 10n ** 27n;
const BPS = 10_000n;
const E6 = BigInt(RATIO_SCALE);

export type EconomyInput = {
  /** the job's price in the token's smallest unit */ price: bigint;
  /** the seller's record under the seller-verdict rule; null = no record */ record: LpRecord | null;
  /** whole seconds the cover stays locked: the job's deadline from now plus the review window */ lockSeconds: number;
  /** whether an arbitrator can find cheating on the hook (no arbitrator ⇒ cover never pays ⇒ L = capital + ops) */ arbitrator: boolean;
  /** cover cap ÷ price in bps; 10,000 = 1× */ coverMultipleBps?: number;
  /** the job fee F in the token's smallest unit (fee.ts jobFee(...).fee): the layer's floor */ fee: bigint;
  /** the evaluator fee the job escrows beside the premium (JobTerms.evaluatorFee); default F, as the Base line's adapter
   *  charges the quoted fee. Only `legs` reads it. */ evaluatorFee?: bigint;
};

/** Who receives what at one money ending (the hook's arithmetic on the committed terms). */
export type EndingLegs = { buyer: bigint; seller: bigint; backers: bigint; layer: bigint; evaluator: bigint };
export type MoneyEnding = 'completed' | 'auto_completed' | 'rejected' | 'no_show' | 'expired_delivered' | 'unaccepted' | 'cheated';

export type EconomyReason = 'UNKNOWN' | 'OVER_MAX_RATIO' | 'BELOW_MIN_PRICE' | 'BACKERS_UNPAID' | null;

export type EconomyQuote = {
  v: typeof ECONOMY_VERSION;
  /** a record with at least one delivered job */ insurable: boolean;
  /** cover is sold: insurable and priced ≤ maxRatio × P */ covered: boolean;
  /** why cover is not sold (null when it is) */ reason: EconomyReason;
  /** what the buyer escrows as the premium (0 when not covered) */ premium: bigint;
  /** the backers' leg (the pool's), = L when covered */ toBackers: bigint;
  /** the layer's leg, = premium − L ≥ F when covered */ toLayer: bigint;
  /** the seller's deposit */ deposit: bigint;
  /** paid to the buyer from the deposit on a no-show and on a rejection that stands, ≤ min(P, deposit − P) */ compensation: bigint;
  /** the cover cap the job reserves in its pool (0 when not covered) */ coverCap: bigint;
  /** per money ending, who receives what: each sums to what the job holds (P + premium + evaluator fee, + the deposit once
   *  accepted; + the cover cap on a cheat, at the full-cap finding, the most a finding can pay) */
  legs: Record<MoneyEnding, EndingLegs>;
  /** the working: every intermediate, in units */
  basis: { ratioE6: number; wilson: bigint; lp: bigint; fee: bigint; need: bigint; priced: bigint; maxRatioE6: number; ubLossOnCap: bigint };
};

function checkInput(i: EconomyInput): void {
  if (typeof i.price !== 'bigint' || i.price <= 0n) throw new RangeError('price must be a positive bigint in the token’s smallest unit');
  if (typeof i.fee !== 'bigint' || i.fee < 0n) throw new RangeError('fee must be a non-negative bigint');
  if (i.evaluatorFee !== undefined && (typeof i.evaluatorFee !== 'bigint' || i.evaluatorFee < 0n)) throw new RangeError('evaluatorFee must be a non-negative bigint');
  if (!Number.isInteger(i.lockSeconds) || i.lockSeconds < 0) throw new RangeError('lockSeconds must be an integer >= 0');
  const m = i.coverMultipleBps ?? 10_000;
  if (!Number.isInteger(m) || m < 10_000) throw new RangeError('coverMultipleBps must be an integer >= 10,000');
  if (i.price > MAX_PRICE_UNITS) throw new RangeError(`price above ${MAX_PRICE_UNITS} units`);
  if (m > 1_000_000) throw new RangeError('coverMultipleBps above 1,000,000');
  if (i.lockSeconds > 1e10) throw new RangeError('lockSeconds above 1e10');
}

/** max ratio in millionths, as the comparison uses it (lp.maxRatio 0.30 → 300,000). */
export const maxRatioE6Of = (p: Pick<LpParams, 'maxRatio'>): number => Math.round(p.maxRatio * RATIO_SCALE);

/** A calibration decimal as the exact WAD integer of its shortest decimal form (0.1666 → 166600000000000000n). The double
 *  0.1666 is not 0.1666; the WAD is. Exponent forms (1e-7) are read exactly too. */
export function wad(x: number): bigint {
  if (!Number.isFinite(x) || x < 0) throw new RangeError(`wad: ${x}`);
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(x));
  if (!m) throw new RangeError(`wad: ${x}`);
  const digits = BigInt((m[1] ?? '') + (m[2] ?? ''));
  const exp = 18 - (m[2] ?? '').length + Number(m[3] ?? 0);
  if (exp < 0) {
    const d = 10n ** BigInt(-exp);
    if (digits % d !== 0n) throw new RangeError(`wad: more than 18 decimals ${x}`);
    return digits / d;
  }
  return digits * 10n ** BigInt(exp);
}

/** floor(sqrt(x)) for x ≥ 0. */
export function isqrt(x: bigint): bigint {
  if (x < 0n) throw new RangeError('isqrt of a negative');
  if (x < 2n) return x;
  // Newton from above: r0 = 2^ceil(bits/2) ≥ sqrt(x); the iterates decrease monotonically to floor(sqrt(x))
  let r = 1n << BigInt(Math.ceil(x.toString(2).length / 2));
  for (;;) {
    const next = (r + x / r) >> 1n;
    if (next >= r) return r;
    r = next;
  }
}

/** lpPremium (lp.ts) computed exactly: the same formula, every term floored at 1e-27 of a unit, the sum rounded up, with the
 *  parameters taken as the exact decimals the calibration writes. Equals lpPremium(...).premium wherever the doubles are
 *  exact (tests/economy.test.ts checks it on tests/vectors/lp-grid.json); above ~1e9 units the doubles drift by a unit
 *  near an integer and this is the one that is right. The Solidity library (EconomyQuote.lpPremium) and the Python twin
 *  (economy.lp_premium_units) run the same integer steps, so the three agree by construction. */
export function lpPremiumUnits(
  input: { price: bigint; record: LpRecord | null; lockSeconds: number; arbitrator: boolean; coverMultipleBps?: number },
  params: Partial<LpParams> = {},
): bigint {
  const p: LpParams = { ...LP_DEFAULTS, ...params };
  if (!(p.utilization > 0 && p.utilization <= 1) || p.severity > 1 || p.a0 + p.b0 <= 0) throw new RangeError('lp params out of range');
  if (!Number.isInteger(p.opsUnits) || p.opsUnits < 0) throw new RangeError('opsUnits must be an integer >= 0');
  const f = BigInt(input.record ? input.record.incorrect : 0);
  const k = BigInt(input.record ? input.record.correct : 0);
  const pm = input.price * BigInt(input.coverMultipleBps ?? 10_000); // C × 1e4
  const BPS_ = 10_000n;
  let sum = 0n; // units × R
  if (input.arbitrator) {
    const w = wad(p.a0) + wad(p.b0) + (k + f) * WAD;
    const meanR = ((wad(p.a0) + f * WAD) * R) / w;
    sum += (wad(p.severity) * pm * meanR) / (WAD * BPS_);
    const sdR = isqrt((meanR * (R - meanR) * WAD) / (w + WAD));
    sum += (wad(p.severity) * wad(p.lambda) * pm * sdR) / (WAD * WAD * BPS_);
  }
  sum += (wad(p.lpYield) * pm * BigInt(input.lockSeconds) * R) / (BigInt(YEAR_S) * wad(p.utilization) * BPS_);
  sum += BigInt(p.opsUnits) * R;
  return (sum + R - 1n) / R;
}

/** Every number of one assured job, from the record. Pure. */
export function quoteEconomy(input: EconomyInput, params: Partial<LpParams> = {}): EconomyQuote {
  checkInput(input);
  const p: LpParams = { ...LP_DEFAULTS, ...params };
  const P = input.price;
  const m = input.coverMultipleBps ?? 10_000;
  const k = input.record ? input.record.correct : 0;
  const f = input.record ? input.record.incorrect : 0;
  const n = k + f;
  const insurable = k > 0;
  // r: the Wilson upper bound on the failure rate in millionths; 1e6 when nothing was ever delivered (no rate to bound)
  const ratioE6 = insurable ? Math.round(wilsonUpperFailure(k, n) * RATIO_SCALE) : RATIO_SCALE;
  const wilson = insurable ? premiumAmount(P, wilsonUpperFailure(k, n)) : P;
  const lp = lpPremiumUnits({ price: P, record: input.record, lockSeconds: input.lockSeconds, arbitrator: input.arbitrator, coverMultipleBps: m }, p);
  const need = lp + input.fee;
  const priced = wilson > need ? wilson : need;
  const maxRatioE6 = maxRatioE6Of(p);
  const withinMax = priced * E6 <= P * BigInt(maxRatioE6);
  const covered = insurable && lp > 0n && withinMax;
  const cap = (P * BigInt(m)) / BPS;
  const ubLossOnCap = (cap * BigInt(ratioE6) + E6 - 1n) / E6;
  const compensation = priced < P ? priced : P;
  const deposit = P + (compensation > ubLossOnCap ? compensation : ubLossOnCap);
  const premium = covered ? priced : 0n;
  const toBackers = covered ? lp : 0n;
  const coverCap = covered ? cap : 0n;
  const legs = endingLegs({ price: P, premium, toBackers, deposit, compensation, coverCap, evaluatorFee: input.evaluatorFee ?? input.fee });
  return {
    v: ECONOMY_VERSION,
    insurable,
    covered,
    reason: covered ? null : !insurable ? 'UNKNOWN' : lp === 0n ? 'BACKERS_UNPAID' : 'OVER_MAX_RATIO',
    premium,
    toBackers,
    toLayer: premium - toBackers,
    deposit,
    compensation,
    coverCap,
    legs,
    basis: { ratioE6, wilson, lp, fee: input.fee, need, priced, maxRatioE6, ubLossOnCap },
  };
}

/** The hook's payout at each money ending for committed terms (AssuranceHook V5.1): completed by the evaluator (fee to it),
 *  auto-completed (fee back), a rejection that stands (compensation; the evaluator's decision stood), a no-show
 *  (compensation, fee back), a delivered V1-V3 job that expired (walk-back), an offer never accepted, a full-cap finding. */
export function endingLegs(t: { price: bigint; premium: bigint; toBackers: bigint; deposit: bigint; compensation: bigint; coverCap: bigint; evaluatorFee: bigint }): Record<MoneyEnding, EndingLegs> {
  const { price: P, premium: pi, toBackers: b, deposit: D, compensation: c, coverCap: C, evaluatorFee: E } = t;
  const L = (buyer: bigint, seller: bigint, backers = 0n, layer = 0n, evaluator = 0n): EndingLegs => ({ buyer, seller, backers, layer, evaluator });
  // a premium with no backers' leg (no pool) goes back to the buyer on a completion
  const toPool = b, toLayer = pi - b, back = b === 0n ? pi - toLayer : 0n;
  return {
    completed: L(back, P + D, toPool, toLayer, E),
    auto_completed: L(back + E, P + D, toPool, toLayer),
    rejected: L(P + pi + c, D - c, 0n, 0n, E),
    no_show: L(P + pi + E + c, D - c),
    expired_delivered: L(P + pi + E, D),
    unaccepted: L(P + pi + E, 0n),
    cheated: L(P + pi + E + D + C, 0n),
  };
}

/** What AssuranceHook V5.1's openJobWithEconomy takes from a quote (EconTerms), plus the JobTerms amounts it must match. */
export function hookTerms(q: EconomyQuote) {
  return {
    econ: { toBackers: q.toBackers, toLayer: q.toLayer, compensation: q.compensation },
    job: { premium: q.premium, deposit: q.deposit, coverCap: q.coverCap },
  };
}

/** The bounds AssuranceHook V5.1 checks a committed quote against (owner-set; see the hook's setEconomyBounds). A quote from
 *  quoteEconomy passes them whenever maxPremiumBps ≥ maxRatio × 10,000 and minBackersAprBps ≤ lpYield × 10,000. */
export type EconomyBounds = { maxPremiumBps: number; minBackersAprBps: number };

/** The hook's check, off chain, so a caller sees a refusal before it signs. Returns the first failed bound or null. */
export function checkBounds(
  terms: { price: bigint; premium: bigint; deposit: bigint; coverCap: bigint; pool: boolean; secondsToDeadline: number; toBackers: bigint; toLayer: bigint; compensation: bigint },
  b: EconomyBounds,
): string | null {
  if (terms.toBackers + terms.toLayer !== terms.premium) return 'LegsNotPremium';
  if (!terms.pool && (terms.toBackers !== 0n || terms.toLayer !== 0n)) return 'LegsWithoutPool';
  if (terms.premium * BPS > terms.price * BigInt(b.maxPremiumBps)) return 'PremiumOverBound';
  if (terms.compensation > terms.deposit || terms.compensation > terms.price) return 'CompensationOverBound';
  if (terms.pool) {
    if (terms.toBackers === 0n) return 'BackersBelowFloor';
    const floorNum = terms.coverCap * BigInt(b.minBackersAprBps) * BigInt(terms.secondsToDeadline);
    if (terms.toBackers * BPS * BigInt(YEAR_S) < floorNum) return 'BackersBelowFloor';
  }
  return null;
}
