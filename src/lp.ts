// jev-wilson/lp: the premium a cover pool's backers need, priced from their side.
//
// premium() in wilson.ts prices the next job at the Wilson 95 % upper bound on the seller's failure rate. That is a
// statement about the seller, not about what the pool's backers need: it charged a seller with 1 failure in 31 jobs
// 16.2 % of the price, and it cannot price a seller with no record at all. lpPremium() prices the same cover from the
// backer's side, in four parts:
//
//   expected loss   s × C × μ             μ = (a0 + f) / (a0 + b0 + n): the Beta-Binomial posterior mean of the failure
//                                          rate. The prior Beta(a0, b0) is fitted to every seller on record, so a seller
//                                          with no record is priced like the market's average seller, not refused.
//   risk loading    s × C × λ × σ         σ = sqrt(μ (1 − μ) / (a0 + b0 + n + 1)): the posterior standard deviation.
//                                          It is wide for a new seller and shrinks as the record grows (credibility).
//   capital         y × C × T / (YEAR × u) the backers' required yield y on the cover C, for the T seconds it is locked,
//                                          grossed up for the share u of the pool that is locked on average.
//   operations      o                      the backers' own deposit and withdraw gas, spread over the jobs a deposit backs.
//
//   C = P × m (the cover multiple, 1× by default); s = the share of C a payout takes (1 = the whole cap: the backer's
//   worst case under the hook, which pays the deposit first and the pool at most C).
//   No arbitrator ⇒ the hook can never pay cover ⇒ expected loss and risk loading are 0: the premium is capital + ops.
//   premium = ceil(sum) in the token's smallest unit; covered only when premium ÷ P ≤ max (0.30, the pool rule).
//
// Only + − × ÷ and sqrt, in a fixed order: the Python twin (python/taifoon_jev_wilson/lp.py) returns the same doubles and
// the same units on tests/vectors/lp-grid.json. The defaults are the fit of 2026-10-01 (73 Base sellers, 4,702 decided
// jobs on Base).

export const YEAR_S = 31_536_000;

export type LpParams = {
  /** Beta prior on the failure rate, fitted to every seller on record (method: maximum likelihood, Beta-Binomial) */
  a0: number; b0: number;
  /** risk loading in posterior standard deviations */ lambda: number;
  /** share of the cover cap a payout takes, 0..1 */ severity: number;
  /** the backers' required yield per year on locked cover */ lpYield: number;
  /** the share of a pool's capital locked on average, 0..1 */ utilization: number;
  /** the backers' gas per job, in the token's smallest unit */ opsUnits: number;
  /** cover only when premium ÷ price ≤ this */ maxRatio: number;
};

/** Fit of 2026-10-01: Beta(0.1666, 0.9297) (prior mean 15.2 %, median 1.7 %): most sellers fail almost never, about one
 *  in five fails more than 30 % of its jobs. λ 2 (a backer spread over 20 new sellers then earns about the 10 % it asks, with no losing year in the Monte Carlo), s 1, y 10 %, u 25 %, o 100 units (0.0001 USDC), max 30 %. */
export const LP_DEFAULTS: Readonly<LpParams> = Object.freeze({
  a0: 0.1666, b0: 0.9297, lambda: 2, severity: 1, lpYield: 0.1, utilization: 0.25, opsUnits: 100, maxRatio: 0.3,
});

export type LpRecord = { correct: number; incorrect: number };
export type LpInput = {
  /** the job's price in the token's smallest unit */ price: number;
  /** the seller's record under the seller-verdict rule; null or {0, 0} = no record */ record: LpRecord | null;
  /** seconds the cover stays locked: the job's deadline from now plus the review window (and the dispute window if priced) */ lockSeconds: number;
  /** whether an arbitrator can find cheating on this hook (no arbitrator ⇒ cover never pays) */ arbitrator: boolean;
  /** cover cap ÷ price in bps; 10,000 = 1× */ coverMultipleBps?: number;
};
export type LpPremium = {
  premium: number; ratio: number; covered: boolean;
  parts: { expectedLoss: number; risk: number; capital: number; ops: number };
  rate: { mean: number; sd: number; n: number };
  cover: number;
};

function checkCount(x: number, what: string): void {
  if (!Number.isInteger(x) || x < 0) throw new RangeError(`${what} must be an integer >= 0, got ${x}`);
}

/** The posterior mean and standard deviation of the failure rate. */
export function failureRate(record: LpRecord | null, p: Pick<LpParams, 'a0' | 'b0'> = LP_DEFAULTS): { mean: number; sd: number; n: number } {
  const f = record ? record.incorrect : 0;
  const k = record ? record.correct : 0;
  checkCount(f, 'incorrect');
  checkCount(k, 'correct');
  const n = k + f;
  const w = p.a0 + p.b0 + n;
  const mean = (p.a0 + f) / w;
  const sd = Math.sqrt((mean * (1 - mean)) / (w + 1));
  return { mean, sd, n };
}

/** The premium a backer needs for one job. Pure. */
export function lpPremium(input: LpInput, params: Partial<LpParams> = {}): LpPremium {
  const p: LpParams = { ...LP_DEFAULTS, ...params };
  if (!Number.isInteger(input.price) || input.price <= 0) throw new RangeError('price must be a positive integer in the token’s smallest unit');
  if (!(input.lockSeconds >= 0)) throw new RangeError('lockSeconds must be >= 0');
  if (!(p.utilization > 0 && p.utilization <= 1)) throw new RangeError('utilization must be in (0, 1]');
  const m = (input.coverMultipleBps ?? 10_000) / 10_000;
  const cover = input.price * m;
  const rate = failureRate(input.record, p);
  const expectedLoss = input.arbitrator ? p.severity * cover * rate.mean : 0;
  const risk = input.arbitrator ? p.severity * cover * p.lambda * rate.sd : 0;
  const capital = (p.lpYield * cover * input.lockSeconds) / (YEAR_S * p.utilization);
  const ops = p.opsUnits;
  const premium = Math.ceil(expectedLoss + risk + capital + ops);
  const ratio = premium / input.price;
  return { premium, ratio, covered: ratio <= p.maxRatio, parts: { expectedLoss, risk, capital, ops }, rate, cover };
}

/** What a backer expects to keep per job: the premium less the expected payout. */
export function lpExpectedMargin(q: LpPremium, arbitrator: boolean, params: Partial<LpParams> = {}): number {
  const p: LpParams = { ...LP_DEFAULTS, ...params };
  return q.premium - (arbitrator ? p.severity * q.cover * q.rate.mean : 0);
}
