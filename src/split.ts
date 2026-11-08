// jev-wilson/split: where a premium and a no-show's deposit go on an assurance hook with an economy (AssuranceHook V5,
// Taifoon's assurance-v4 contracts). Pure, integers only (bigint). The Python twin (python/taifoon_jev_wilson/
// split.py) and the Solidity library (solidity/src/EconomySplit.sol) return the same units on tests/vectors/split-grid.json,
// and the hook's own arithmetic is fuzzed against the library (assurance-v4 test/Economy.t.sol).
//
//   covered completion   toLayer   = floor(pi × (10,000 − splitBps) / 10,000)     the layer's leg rounds DOWN
//                        toBackers = pi − toLayer                                  the backers take the dust
//   uncovered            the whole premium back to the buyer (no pool earned it)
//   no-show (accepted, never delivered by the deadline)
//                        toBuyer   = floor(D × compBps / 10,000)                   rounds DOWN: the seller keeps the dust
//                        toSeller  = D − toBuyer
// splitBps is the backers' share, bounded [MIN_BACKERS_SPLIT_BPS, 10,000] by the hook; compBps is bounded [0, 10,000].

export const BPS = 10_000;
/** the hook's floor on the backers' share (AssuranceHook.MIN_BACKERS_SPLIT_BPS) */
export const MIN_BACKERS_SPLIT_BPS = 5_000;

export type PremiumLegs = { toBackers: bigint; toLayer: bigint; toBuyer: bigint };
export type NoShowLegs = { toBuyer: bigint; toSeller: bigint };

function bps(x: number, lo: number, what: string): bigint {
  if (!Number.isInteger(x) || x < lo || x > BPS) throw new RangeError(`${what} must be an integer in [${lo}, ${BPS}], got ${x}`);
  return BigInt(x);
}

function amount(x: bigint, what: string): bigint {
  if (typeof x !== 'bigint' || x < 0n) throw new RangeError(`${what} must be a non-negative bigint`);
  return x;
}

/** The premium of a completed job as the hook splits it. `covered` false: a job no pool covered returns its premium. */
export function premiumSplit(premium: bigint, splitBps: number, covered = true): PremiumLegs {
  const pi = amount(premium, 'premium');
  const s = bps(splitBps, MIN_BACKERS_SPLIT_BPS, 'splitBps');
  if (!covered) return { toBackers: 0n, toLayer: 0n, toBuyer: pi };
  const toLayer = (pi * (BigInt(BPS) - s)) / BigInt(BPS);
  return { toBackers: pi - toLayer, toLayer, toBuyer: 0n };
}

/** The seller's deposit when it accepted a job and never delivered it by the deadline. */
export function noShowComp(deposit: bigint, compBps: number): NoShowLegs {
  const d = amount(deposit, 'deposit');
  const toBuyer = (d * bps(compBps, 0, 'compBps')) / BigInt(BPS);
  return { toBuyer, toSeller: d - toBuyer };
}

export type EconomyTerms = {
  price: bigint; premium: bigint; deposit: bigint; evaluatorFee?: bigint;
  splitBps: number; noShowCompBps: number; covered: boolean;
};

/** Both legs of every ending a quote shows: what each party gets when the job completes, and when the seller no-shows. */
export function economyQuote(t: EconomyTerms) {
  const fee = amount(t.evaluatorFee ?? 0n, 'evaluatorFee');
  const p = amount(t.price, 'price');
  const legs = premiumSplit(t.premium, t.splitBps, t.covered);
  const ns = noShowComp(t.deposit, t.noShowCompBps);
  return {
    escrow: { buyer: p + t.premium + fee, seller: t.deposit },
    completed: { toSeller: p + t.deposit, toBackers: legs.toBackers, toLayer: legs.toLayer, toBuyer: legs.toBuyer, toEvaluatorIfItDecided: fee },
    noShow: { toBuyer: p + t.premium + fee + ns.toBuyer, toSeller: ns.toSeller, compensation: ns.toBuyer },
    splitBps: t.splitBps, noShowCompBps: t.noShowCompBps,
  };
}
