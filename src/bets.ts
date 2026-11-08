// jev-wilson/bets: two-sided job assurance, priced and settled in one module.
//
// The machine is Taifoon's assurance machine (taifoon.assurance.machine.v1, not in this package). This file is its money:
//
//   price      p = max(p_min, mean + ceil(λ·sd) + capital), WAD fixed point, integers only (bigint). The Beta(a0, b0)
//              posterior of the seller's failure rate over its record in the market (k_eff delivered, counting at most
//              per_buyer_cap per distinct buyer; f failed; every resolved round counts), plus a risk loading in posterior standard deviations
//              (credibility: wide for a new seller, narrow for a long record), plus the backers' capital charge for the
//              seconds the round stays locked. The same operations, in the same order, as lpPremium's ratio — but in
//              integers so TypeScript, Python, Solidity (BetsPricing.sol) and the Solana program agree to the unit.
//   positions  FOR (backers; the job's seller is the junior first-loss tranche), AGAINST (challengers) and COVER (the
//              buyer). AGAINST and COVER are ONE instrument: pay x at p, receive G = floor(x·WAD/p) if the round fails.
//   fee        max(ceil(x · fee_bps / 1e4), min_fee) on top of every AGAINST/COVER x; to the treasury on Delivered or
//              Failed, refunded on Void. FOR pays none.
//   market     BetsMarket below is the reference model of the contract: every guard, every refusal error, every
//              payout. Contract tests and the devnet run assert their balances against it to the unit.
//   estimate   quoteBothSides(): fair odds, offered odds, expected return and variance per unit for FOR and AGAINST, the
//              premium split, our fee, and the checks: house never loses, no arbitrage between cover and AGAINST,
//              manipulation bounds (wash trading, self-hire, seller-challenger collusion).
//   simulate   betsMonteCarlo() in bets-mc.ts: seeded, over sellers drawn from the fitted prior.
// No imports: the Taifoon site vendors this file byte for byte (sha256 pinned).

export const WAD = 10n ** 18n;
export const YEAR_S = 31_536_000n;
export const BETS_SCHEMA = 'taifoon.assurance.machine.v1';

export type BetsParams = {
  /** Beta prior on the failure rate, WAD */ a0: bigint; b0: bigint;
  /** risk loading in posterior sds, WAD */ lambda: bigint;
  /** backers' required yield per year, WAD */ lpYield: bigint;
  /** share of backing locked on average, WAD */ utilization: bigint;
  /** a price above this refuses (not insurable), WAD */ maxRatio: bigint;
  /** price floor, WAD (bounds leverage G/x <= 1/p_min) */ pMin: bigint;
  /** our fee, bps of x */ feeBps: bigint;
  /** fee floor per AGAINST/COVER position, smallest units (gas floor + margin) */ minFee: bigint;
  /** GC <= price * this / 1e4 */ coverMultipleBps: bigint;
  /** GA <= price * this / 1e4 */ againstMultipleBps: bigint;
  /** delivered rounds one buyer adds to the record */ perBuyerCap: bigint;
  /** senior backing carries no exposure below this many distinct buyers */ minDistinctBuyers: bigint;
  /** senior_open <= this * k_eff, smallest units */ seniorPerRound: bigint;
  /** positions refuse within this many seconds of the job deadline */ lockCutoffS: bigint;
  /** a round with no job ending by deadline + windows + this may be voided */ voidGraceS: bigint;
};

/** Defaults: the jev-wilson LP fit of 2026-10-01 (Base, 73 sellers) and the fee-config rules (49 bps). min_fee and
 *  senior_per_round are per network (calibration); these are the 6-decimal USDC values on Base. */
export const BETS_DEFAULTS: Readonly<BetsParams> = Object.freeze({
  a0: 166_600_000_000_000_000n, b0: 929_700_000_000_000_000n, lambda: 2n * WAD, lpYield: WAD / 10n, utilization: WAD / 4n,
  maxRatio: 3n * WAD / 10n, pMin: 5n * WAD / 1000n, feeBps: 49n, minFee: 20_000n, coverMultipleBps: 10_000n,
  againstMultipleBps: 10_000n, perBuyerCap: 3n, minDistinctBuyers: 3n, seniorPerRound: 20_000n, lockCutoffS: 60n, voidGraceS: 604_800n,
});

const ceilDiv = (a: bigint, b: bigint) => (a === 0n ? 0n : (a - 1n) / b + 1n);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** floor(sqrt(n)), Newton on bigint; the same value as OpenZeppelin Math.sqrt and Python math.isqrt. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError('isqrt of a negative');
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) { while (x * x > n) x -= 1n; while ((x + 1n) * (x + 1n) <= n) x += 1n; return x; }
    x = y;
  }
}

export type BetsRecord = { kEff: bigint; f: bigint };
export type BetsPrice = { p: bigint; mean: bigint; sd: bigint; risk: bigint; capital: bigint; insurable: boolean };

/** The price per unit of failure payout for a position opened now. Pure, integers. Rounds every term UP (in favour of the
 *  backers who hold the collateral). */
export function betsPrice(record: BetsRecord, lockS: bigint, params: BetsParams = BETS_DEFAULTS): BetsPrice {
  if (record.kEff < 0n || record.f < 0n || lockS < 0n) throw new RangeError('record and lock must be >= 0');
  const n = record.kEff + record.f;
  const w = params.a0 + params.b0 + n * WAD;
  const mean = ceilDiv((params.a0 + record.f * WAD) * WAD, w);
  const v = (mean * (WAD - mean)) / (w + WAD);
  const s2 = v * WAD;
  let sd = isqrt(s2);
  if (sd * sd !== s2) sd += 1n;
  const risk = ceilDiv(params.lambda * sd, WAD);
  const capital = ceilDiv(params.lpYield * lockS * WAD, YEAR_S * params.utilization);
  const p = max(params.pMin, mean + risk + capital);
  return { p, mean, sd, risk, capital, insurable: p <= params.maxRatio };
}

/** G: what an AGAINST or COVER position of x receives if the round fails (includes x). */
export const grossPayout = (x: bigint, p: bigint): bigint => (x * WAD) / p;
/** Our fee on an AGAINST or COVER position, paid on top of x. */
export const positionFee = (x: bigint, params: BetsParams = BETS_DEFAULTS): bigint => max(ceilDiv(x * params.feeBps, 10_000n), params.minFee);

// ---------------------------------------------------------------------------------------------------------------
// The reference market. One instance = one market contract (one asset). Mirrors AssuranceMarket.sol line for line.

export type Side = 'FOR' | 'AGAINST' | 'COVER';
export type RoundState = 'Open' | 'Locked' | 'Delivered' | 'Failed' | 'Void' | 'Settled';
export type JobView = { buyer: string; seller: string; price: bigint; deadline: bigint; reviewWindow: bigint; disputeWindow: bigint; arbitrationWindow: bigint; accepted: boolean };
export type Position = { id: number; round: string; owner: string; side: Side; stake: bigint; fee: bigint; p: bigint; G: bigint; junior: boolean; active: boolean; withdrawn: boolean };
export type Round = {
  id: string; book: string; buyer: string; seller: string; price: bigint; deadline: bigint; voidAt: bigint; state: RoundState;
  Fj: bigint; Fs: bigint; X: bigint; GA: bigint; GC: bigint; fees: bigint; seniorExposure: bigint; xCount: number; unclaimed: number; held: bigint;
};
export type Book = { kEff: bigint; f: bigint; distinctBuyers: bigint; seniorOpen: bigint; buyerRounds: Map<string, bigint> };

export class BetsError extends Error {
  code: string;
  constructor(code: string, detail = '') { super(detail ? `${code}: ${detail}` : code); this.code = code; }
}
const refuse = (code: string, detail = ''): never => { throw new BetsError(code, detail); };

export const bookKey = (seller: string, classId: string) => `${seller.toLowerCase()}|${classId}`;

export class BetsMarket {
  state: 'Active' | 'Paused' | 'Shutdown' = 'Active';
  rounds = new Map<string, Round>();
  positions: Position[] = [];
  books = new Map<string, Book>();
  treasury = 0n;
  /** what the market holds: the sum of every round's held */
  get held(): bigint { let s = 0n; for (const r of this.rounds.values()) s += r.held; return s; }
  params: BetsParams;
  owner: string;
  constructor(params: BetsParams = BETS_DEFAULTS, owner = 'owner') { this.params = params; this.owner = owner; }

  book(key: string): Book {
    let b = this.books.get(key);
    if (!b) { b = { kEff: 0n, f: 0n, distinctBuyers: 0n, seniorOpen: 0n, buyerRounds: new Map() }; this.books.set(key, b); }
    return b;
  }
  seniorCap(b: Book): bigint { return b.distinctBuyers >= this.params.minDistinctBuyers ? this.params.seniorPerRound * b.kEff : 0n; }

  // -- market
  pause(caller: string) { if (caller !== this.owner) refuse('NotOwner'); if (this.state !== 'Active') refuse('MarketNotActive'); this.state = 'Paused'; }
  unpause(caller: string) { if (caller !== this.owner) refuse('NotOwner'); if (this.state !== 'Paused') refuse('MarketShutdown'); this.state = 'Active'; }
  shutdown(caller: string) { if (caller !== this.owner) refuse('NotOwner'); if (this.state === 'Shutdown') refuse('MarketShutdown'); this.state = 'Shutdown'; }

  // -- rounds
  openRound(caller: string, jobId: string, classId: string, job: JobView, now: bigint): Round {
    if (this.state !== 'Active') refuse('MarketNotActive');
    if (this.rounds.has(jobId)) refuse('RoundExists');
    if (!job.accepted) refuse('JobNotAccepted');
    if (now >= job.deadline - this.params.lockCutoffS) refuse('AfterCutoff');
    const r: Round = {
      id: jobId, book: bookKey(job.seller, classId), buyer: job.buyer, seller: job.seller, price: job.price, deadline: job.deadline,
      voidAt: job.deadline + job.reviewWindow + job.disputeWindow + job.arbitrationWindow + this.params.voidGraceS, state: 'Open',
      Fj: 0n, Fs: 0n, X: 0n, GA: 0n, GC: 0n, fees: 0n, seniorExposure: 0n, xCount: 0, unclaimed: 0, held: 0n,
    };
    this.rounds.set(jobId, r);
    return r;
  }
  /** Open only while the job is Accepted and before the cutoff; anything else reads as Locked. */
  isOpen(r: Round, jobAccepted: boolean, now: bigint): boolean { return r.state === 'Open' && jobAccepted && now < r.deadline - this.params.lockCutoffS; }
  lock(jobId: string, jobAccepted: boolean, now: bigint) {
    const r = this.round(jobId);
    if (r.state !== 'Open') refuse('RoundNotOpen');
    if (this.isOpen(r, jobAccepted, now)) refuse('NotLockable');
    r.state = 'Locked';
  }
  round(jobId: string): Round { return this.rounds.get(jobId) ?? refuse('NoRound'); }

  private exposure(r: Round, Fj: bigint, Fs: bigint, GA: bigint, GC: bigint, X: bigint): { L: bigint; senior: bigint } {
    const L = GA + GC - X;
    if (L > Fj + Fs) refuse('Undercollateralised');
    return { L, senior: L > Fj ? L - Fj : 0n };
  }
  private applyExposure(r: Round, senior: bigint) {
    const b = this.book(r.book);
    const next = b.seniorOpen - r.seniorExposure + senior;
    if (senior > r.seniorExposure && next > this.seniorCap(b)) refuse('SeniorCap');
    b.seniorOpen = next; r.seniorExposure = senior;
  }

  openFor(caller: string, jobId: string, amount: bigint, jobAccepted: boolean, now: bigint): Position {
    if (this.state !== 'Active') refuse('MarketNotActive');
    const r = this.round(jobId);
    if (!this.isOpen(r, jobAccepted, now)) refuse('RoundNotOpen');
    if (amount <= 0n) refuse('ZeroAmount');
    const junior = caller === r.seller;
    if (junior) r.Fj += amount; else r.Fs += amount;
    // more backing never raises senior exposure; recompute so it can fall
    const { senior } = this.exposure(r, r.Fj, r.Fs, r.GA, r.GC, r.X);
    this.applyExposure(r, senior);
    r.held += amount; r.unclaimed += 1;
    const pos: Position = { id: this.positions.length, round: jobId, owner: caller, side: 'FOR', stake: amount, fee: 0n, p: 0n, G: 0n, junior, active: true, withdrawn: false };
    this.positions.push(pos);
    return pos;
  }

  /** AGAINST (challenger) or COVER (the buyer): the same instrument, two caps. */
  openFailure(side: 'AGAINST' | 'COVER', caller: string, jobId: string, x: bigint, maxPrice: bigint, lockS: bigint, jobAccepted: boolean, now: bigint): Position {
    if (this.state !== 'Active') refuse('MarketNotActive');
    const r = this.round(jobId);
    if (!this.isOpen(r, jobAccepted, now)) refuse('RoundNotOpen');
    if (x <= 0n) refuse('ZeroAmount');
    if (side === 'AGAINST') { if (caller === r.seller) refuse('SellerCannotChallenge'); if (caller === r.buyer) refuse('BuyerUsesCover'); }
    else if (caller !== r.buyer) refuse('NotBuyer');
    const b = this.book(r.book);
    const q = betsPrice({ kEff: b.kEff, f: b.f }, lockS, this.params);
    if (!q.insurable) refuse('NotInsurable');
    if (q.p > maxPrice) refuse('PriceAboveMax');
    const G = grossPayout(x, q.p);
    const GA = side === 'AGAINST' ? r.GA + G : r.GA;
    const GC = side === 'COVER' ? r.GC + G : r.GC;
    if (GA > (r.price * this.params.againstMultipleBps) / 10_000n) refuse('AgainstCap');
    if (GC > (r.price * this.params.coverMultipleBps) / 10_000n) refuse('CoverCap');
    const { senior } = this.exposure(r, r.Fj, r.Fs, GA, GC, r.X + x);
    this.applyExposure(r, senior);
    const fee = positionFee(x, this.params);
    r.GA = GA; r.GC = GC; r.X += x; r.fees += fee; r.xCount += 1; r.unclaimed += 1; r.held += x + fee;
    const pos: Position = { id: this.positions.length, round: jobId, owner: caller, side, stake: x, fee, p: q.p, G, junior: false, active: true, withdrawn: false };
    this.positions.push(pos);
    return pos;
  }

  withdrawFor(caller: string, id: number, amount: bigint, jobAccepted: boolean, now: bigint): bigint {
    const pos = this.positions[id] ?? refuse('NoPosition');
    const r = this.round(pos.round);
    if (!this.isOpen(r, jobAccepted, now)) refuse('RoundNotOpen');
    if (pos.owner !== caller) refuse('NotOwner');
    if (pos.side !== 'FOR') refuse('NotFor');
    if (!pos.active) refuse('PositionNotActive');
    if (amount <= 0n || amount > pos.stake) refuse('BadAmount');
    const Fj = pos.junior ? r.Fj - amount : r.Fj;
    const Fs = pos.junior ? r.Fs : r.Fs - amount;
    const { senior } = this.exposure(r, Fj, Fs, r.GA, r.GC, r.X);
    this.applyExposure(r, senior);
    r.Fj = Fj; r.Fs = Fs; pos.stake -= amount; r.held -= amount;
    if (pos.stake === 0n) { pos.active = false; pos.withdrawn = true; r.unclaimed -= 1; }
    return amount;
  }

  // -- resolution (anyone)
  resolve(jobId: string, outcome: 'Delivered' | 'Failed' | null) {
    const r = this.round(jobId);
    if (r.state !== 'Open' && r.state !== 'Locked') refuse('AlreadyResolved');
    if (outcome === null) return refuse('NoOutcome');
    const b = this.book(r.book);
    b.seniorOpen -= r.seniorExposure; r.seniorExposure = 0n;
    // every resolved round counts (its job paid the evaluator fee and gas); a buyer adds at most per_buyer_cap deliveries
    if (outcome === 'Delivered') {
      const seen = b.buyerRounds.get(r.buyer) ?? 0n;
      if (seen === 0n) b.distinctBuyers += 1n;
      if (seen < this.params.perBuyerCap) b.kEff += 1n;
      b.buyerRounds.set(r.buyer, seen + 1n);
    } else b.f += 1n;
    r.state = outcome;
    this.treasury += r.fees; r.held -= r.fees;
  }
  /** `outcome`: the job's ending if it has one — a job that ended resolves, it is never voided (HasOutcome). */
  voidRound(jobId: string, now: bigint, sourceUnreadable = false, outcome: 'Delivered' | 'Failed' | null = null) {
    const r = this.round(jobId);
    if (r.state !== 'Open' && r.state !== 'Locked') refuse('AlreadyResolved');
    if (!sourceUnreadable && outcome !== null) refuse('HasOutcome');
    if (!sourceUnreadable && now <= r.voidAt) refuse('VoidTooEarly');
    const b = this.book(r.book);
    b.seniorOpen -= r.seniorExposure; r.seniorExposure = 0n;
    r.state = 'Void';
  }

  /** What a position receives now (0 before resolution). */
  payoutOf(pos: Position): bigint {
    const r = this.round(pos.round);
    const L = r.GA + r.GC - r.X;
    if (r.state === 'Void') return pos.side === 'FOR' ? pos.stake : pos.stake + pos.fee;
    if (r.state === 'Delivered') return pos.side === 'FOR' ? pos.stake + (pos.stake * r.X) / (r.Fj + r.Fs) : 0n;
    if (r.state === 'Failed') {
      if (pos.side !== 'FOR') return pos.G;
      if (pos.junior) return (pos.stake * (r.Fj - min(L, r.Fj))) / r.Fj;
      return (pos.stake * (r.Fs - (L > r.Fj ? L - r.Fj : 0n))) / r.Fs;
    }
    return refuse('NotResolved');
  }
  claim(id: number): bigint {
    const pos = this.positions[id] ?? refuse('NoPosition');
    const r = this.round(pos.round);
    if (r.state !== 'Delivered' && r.state !== 'Failed' && r.state !== 'Void') refuse('NotResolved');
    if (!pos.active) refuse('PositionNotActive');
    const out = this.payoutOf(pos);
    pos.active = false; r.unclaimed -= 1; r.held -= out;
    if (r.held < 0n) throw new Error('INVARIANT: a round paid more than it held');
    return out;
  }
  sweepDust(jobId: string): bigint {
    const r = this.round(jobId);
    if (r.state !== 'Delivered' && r.state !== 'Failed' && r.state !== 'Void') refuse('NotResolved');
    if (r.unclaimed !== 0) refuse('PositionsOutstanding');
    const dust = r.held;
    if (r.state === 'Void' && dust !== 0n) throw new Error('INVARIANT: a void round left dust');
    this.treasury += dust; r.held = 0n; r.state = 'Settled';
    return dust;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The estimate: both sides, priced holistically. Numbers (doubles) for display; the money is the integer code above.

export type SideEstimate = { expectedReturn: number; variance: number; sd: number; winProbability: number; ifWin: number; ifLose: number };
export type BothSides = {
  record: { kEff: string; f: string }; lockS: string;
  fairP: number; offeredP: number; insurable: boolean;
  /** decimal odds of a failure position: what 1 unit returns if the round fails */ againstOdds: number;
  /** what 1 unit of FOR returns on delivery when the round is fully used (L = F) */ forYieldFull: number;
  perUnit: { AGAINST: SideEstimate; COVER: SideEstimate; FOR: SideEstimate };
  cover: { premium: string; payout: string; fee: string } | null;
  premiumSplit: { toFor: string; toTreasury: string; toSeller: '0'; toBuyer: '0' } | null;
  checks: { noArbitrage: boolean; houseNeverLoses: boolean; fullCollateral: true };
  manipulation: ManipulationBound;
};

/** Per unit of x for a failure position, per unit of stake for FOR in a fully used round, under a true failure rate q. */
export function sideEstimates(q: number, p: number, feeRate: number): { AGAINST: SideEstimate; COVER: SideEstimate; FOR: SideEstimate } {
  const fail: SideEstimate = {
    winProbability: q, ifWin: 1 / p - 1 - feeRate, ifLose: -1 - feeRate,
    expectedReturn: q / p - 1 - feeRate, variance: (q * (1 - q)) / (p * p), sd: Math.sqrt(q * (1 - q)) / p,
  };
  const up = p / (1 - p); // X / F when L = F
  const back: SideEstimate = {
    winProbability: 1 - q, ifWin: up, ifLose: -1,
    expectedReturn: (1 - q) * up - q, variance: q * (1 - q) * (up + 1) ** 2, sd: Math.sqrt(q * (1 - q)) * (up + 1),
  };
  return { AGAINST: fail, COVER: { ...fail }, FOR: back };
}

export type ManipulationBound = {
  /** the most senior backers can lose to a coordinated set (seller + sybil buyers/challengers) across the book */ seniorCapacity: string;
  /** what building the record that unlocks it cost at least */ costToBuild: string;
  /** seniorCapacity - costToBuild; <= 0 means manipulation does not pay */ netGain: string; profitable: boolean;
  /** junior first loss: collusion paid from the seller's own stake is a transfer to itself minus fees */ juniorFirst: true;
};

/** costPerRound: the least a counted round costs (our min fee + the evaluator fee floor + gas), smallest units. */
export function manipulationBound(record: BetsRecord & { distinctBuyers: bigint }, costPerRound: bigint, params: BetsParams = BETS_DEFAULTS): ManipulationBound {
  const cap = record.distinctBuyers >= params.minDistinctBuyers ? params.seniorPerRound * record.kEff : 0n;
  const cost = costPerRound * record.kEff;
  return { seniorCapacity: cap.toString(), costToBuild: cost.toString(), netGain: (cap - cost).toString(), profitable: cap > cost, juniorFirst: true };
}

export function quoteBothSides(input: { record: BetsRecord & { distinctBuyers: bigint }; lockS: bigint; price?: bigint; coverX?: bigint; costPerRound?: bigint }, params: BetsParams = BETS_DEFAULTS): BothSides {
  const q = betsPrice(input.record, input.lockS, params);
  const P = Number(q.p) / 1e18, fair = Number(q.mean) / 1e18;
  const feeRate = Number(params.feeBps) / 1e4;
  let cover: BothSides['cover'] = null, split: BothSides['premiumSplit'] = null, noArb = true;
  if (input.coverX !== undefined) {
    const G = grossPayout(input.coverX, q.p);
    const fee = positionFee(input.coverX, params);
    noArb = G === grossPayout(input.coverX, q.p) && fee === positionFee(input.coverX, params); // one formula for both
    cover = { premium: input.coverX.toString(), payout: G.toString(), fee: fee.toString() };
    split = { toFor: input.coverX.toString(), toTreasury: fee.toString(), toSeller: '0', toBuyer: '0' };
  }
  return {
    record: { kEff: input.record.kEff.toString(), f: input.record.f.toString() }, lockS: input.lockS.toString(),
    fairP: fair, offeredP: P, insurable: q.insurable, againstOdds: 1 / P, forYieldFull: P / (1 - P),
    perUnit: sideEstimates(fair, P, feeRate), cover, premiumSplit: split,
    checks: { noArbitrage: noArb, houseNeverLoses: params.minFee > 0n, fullCollateral: true },
    manipulation: manipulationBound(input.record, input.costPerRound ?? params.seniorPerRound, params),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Scripts: a chain-agnostic op list (src/bets-scenarios.ts) run on the reference market. The devnet runner and the
// Solana tests replay the same ops on chain and compare every balance with what this returns.

export type JobDef = { buyer: string; seller: string; price: string; deadline: string; reviewWindow: string; disputeWindow: string; arbitrationWindow: string };
export type BetsOp = { s: string; t: string; expect?: string } & (
  | { op: 'job'; job: string; state: 'Submitted' | 'RejectPending' | 'Disputed' | 'Completed' | 'Rejected' | 'Cheated' | 'Expired' }
  | { op: 'openRound'; caller: string; job: string; classId: string; now: string }
  | { op: 'openFor'; caller: string; job: string; amount: string; now: string }
  | { op: 'openAgainst' | 'openCover'; caller: string; job: string; x: string; maxPrice: string; lockS: string; now: string }
  | { op: 'withdrawFor'; caller: string; pos: number; amount: string; now: string }
  | { op: 'lock'; job: string; now: string }
  | { op: 'resolve'; job: string }
  | { op: 'void'; job: string; now: string }
  | { op: 'claim'; pos: number }
  | { op: 'sweep'; job: string }
  | { op: 'pause' | 'unpause' | 'shutdown'; caller: string }
);
export type BetsScript = { name: string; params: Record<keyof BetsParams, string>; jobs: Record<string, JobDef>; ops: BetsOp[] };
export type StepResult = { i: number; s: string; t: string; op: string; ok: boolean; error: string | null; value: string | null };

export const paramsToStrings = (p: BetsParams) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.toString()])) as Record<keyof BetsParams, string>;
export const paramsFromStrings = (p: Record<string, string>) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, BigInt(v)])) as BetsParams;
const OUTCOME: Record<string, 'Delivered' | 'Failed' | null> = { Completed: 'Delivered', Rejected: 'Failed', Cheated: 'Failed', Expired: 'Failed' };

export function runBetsScript(script: BetsScript) {
  const m = new BetsMarket(paramsFromStrings(script.params));
  const jobState: Record<string, string> = Object.fromEntries(Object.keys(script.jobs).map((j) => [j, 'Accepted']));
  const balances: Record<string, bigint> = {};
  const add = (who: string, v: bigint) => { balances[who] = (balances[who] ?? 0n) + v; };
  const steps: StepResult[] = [];
  const view = (j: string): JobView => {
    const d = script.jobs[j]!;
    return { buyer: d.buyer, seller: d.seller, price: BigInt(d.price), deadline: BigInt(d.deadline), reviewWindow: BigInt(d.reviewWindow), disputeWindow: BigInt(d.disputeWindow), arbitrationWindow: BigInt(d.arbitrationWindow), accepted: jobState[j] === 'Accepted' };
  };
  script.ops.forEach((o, i) => {
    let value: bigint | null = null;
    try {
      switch (o.op) {
        case 'job': jobState[o.job] = o.state; break;
        case 'openRound': m.openRound(o.caller, o.job, o.classId, view(o.job), BigInt(o.now)); break;
        case 'openFor': { const p = m.openFor(o.caller, o.job, BigInt(o.amount), jobState[o.job] === 'Accepted', BigInt(o.now)); add(o.caller, -p.stake); value = BigInt(p.id); break; }
        case 'openAgainst': case 'openCover': {
          const p = m.openFailure(o.op === 'openAgainst' ? 'AGAINST' : 'COVER', o.caller, o.job, BigInt(o.x), BigInt(o.maxPrice), BigInt(o.lockS), jobState[o.job] === 'Accepted', BigInt(o.now));
          add(o.caller, -(p.stake + p.fee)); value = BigInt(p.id); break;
        }
        case 'withdrawFor': { const pos = m.positions[o.pos]; const r = pos ? jobState[pos.round] === 'Accepted' : false; value = m.withdrawFor(o.caller, o.pos, BigInt(o.amount), r, BigInt(o.now)); add(o.caller, value); break; }
        case 'lock': m.lock(o.job, jobState[o.job] === 'Accepted', BigInt(o.now)); break;
        case 'resolve': m.resolve(o.job, OUTCOME[jobState[o.job]!] ?? null); break;
        case 'void': m.voidRound(o.job, BigInt(o.now), false, OUTCOME[jobState[o.job]!] ?? null); break;
        case 'claim': { const pos = m.positions[o.pos]; value = m.claim(o.pos); add(pos!.owner, value); break; }
        case 'sweep': value = m.sweepDust(o.job); break;
        case 'pause': m.pause(o.caller); break;
        case 'unpause': m.unpause(o.caller); break;
        case 'shutdown': m.shutdown(o.caller); break;
      }
      if (o.expect) throw new Error(`step ${i} (${o.s} ${o.t}) expected ${o.expect} but succeeded`);
      steps.push({ i, s: o.s, t: o.t, op: o.op, ok: true, error: null, value: value === null ? null : value.toString() });
    } catch (e) {
      if (!(e instanceof BetsError)) throw e;
      if (o.expect !== e.code) throw new Error(`step ${i} (${o.s} ${o.t}) ${o.op}: ${e.code}${o.expect ? ` (expected ${o.expect})` : ''}`);
      steps.push({ i, s: o.s, t: o.t, op: o.op, ok: false, error: e.code, value: null });
    }
  });
  let paid = 0n;
  for (const v of Object.values(balances)) paid += v;
  return {
    steps, treasury: m.treasury.toString(), held: m.held.toString(), conserved: paid + m.treasury + m.held === 0n,
    balances: Object.fromEntries(Object.entries(balances).sort().map(([k, v]) => [k, v.toString()])),
    positions: m.positions.map((p) => ({ id: p.id, round: p.round, owner: p.owner, side: p.side, stake: p.stake.toString(), fee: p.fee.toString(), p: p.p.toString(), G: p.G.toString(), junior: p.junior, active: p.active })),
    rounds: Object.fromEntries([...m.rounds.values()].map((r) => [r.id, { state: r.state, Fj: r.Fj.toString(), Fs: r.Fs.toString(), X: r.X.toString(), GA: r.GA.toString(), GC: r.GC.toString(), fees: r.fees.toString(), held: r.held.toString() }])),
    books: Object.fromEntries([...m.books.entries()].map(([k, b]) => [k, { kEff: b.kEff.toString(), f: b.f.toString(), distinctBuyers: b.distinctBuyers.toString(), seniorOpen: b.seniorOpen.toString() }])),
    market: m.state,
  };
}
