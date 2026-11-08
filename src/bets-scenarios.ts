// jev-wilson/bets-scenarios: the scenarios S01..S12 of schemas/assurance/machine.json as ONE chain-agnostic script on ONE
// market, in the order the devnet run executes them. Every op names the machine transition or refusal (`t`) it exercises,
// so coverage is checked against the machine, and the expected end balances come from runBetsScript (the reference
// market). The devnet runner builds the same script with the chain's own timestamps (buildBetsScript(times)).
import { BETS_DEFAULTS, WAD, paramsToStrings, type BetsOp, type BetsParams, type BetsScript, type JobDef } from './bets.ts';

/** Devnet parameters: the defaults with a devnet fee floor (0.001 dUSDC), short grace, and a senior unit that makes the
 *  senior tranche visible in a short run. On a network with value senior_per_round <= the cost of one counted round. */
export const DEVNET_BETS_PARAMS: Readonly<BetsParams> = Object.freeze({ ...BETS_DEFAULTS, minFee: 1_000n, seniorPerRound: 200_000n, lockCutoffS: 30n, voidGraceS: 120n });

export type Times = { open: bigint; deadline: bigint; review: bigint; dispute: bigint; arbitration: bigint };
export const VECTOR_TIMES: Times = { open: 1_000n, deadline: 10_000n, review: 60n, dispute: 60n, arbitration: 120n };

const PRICE = 1_000_000n; // 1.000000 of a 6-decimal token
const MAXP = (3n * WAD) / 10n;

export function buildBetsScript(t: Times = VECTOR_TIMES, params: BetsParams = DEVNET_BETS_PARAMS): BetsScript {
  const jobs: Record<string, JobDef> = {};
  const ops: BetsOp[] = [];
  let pos = 0;
  const lockS = (t.deadline - t.open + t.review + t.dispute).toString();
  const now = t.open.toString();
  const job = (id: string, buyer: string, seller: string) => {
    jobs[id] = { buyer, seller, price: PRICE.toString(), deadline: t.deadline.toString(), reviewWindow: t.review.toString(), disputeWindow: t.dispute.toString(), arbitrationWindow: t.arbitration.toString() };
  };
  const after = (t.deadline + t.review + t.dispute + t.arbitration + params.voidGraceS + 1n).toString();
  const late = (t.deadline - params.lockCutoffS).toString();
  // op builders; each returns the position id it creates (or -1)
  const round = (s: string, j: string, caller: string, tr = 'round_open', expect?: string) => { ops.push({ s, t: tr, op: 'openRound', caller, job: j, classId: 'code.typed', now, ...(expect ? { expect } : {}) }); };
  const back = (s: string, j: string, caller: string, amount: bigint, tr = 'pos_open_for', expect?: string) => { ops.push({ s, t: tr, op: 'openFor', caller, job: j, amount: amount.toString(), now, ...(expect ? { expect } : {}) }); return expect ? -1 : pos++; };
  const fail = (s: string, kind: 'openAgainst' | 'openCover', j: string, caller: string, x: bigint, tr: string, expect?: string, maxPrice = MAXP) => { ops.push({ s, t: tr, op: kind, caller, job: j, x: x.toString(), maxPrice: maxPrice.toString(), lockS, now, ...(expect ? { expect } : {}) }); return expect ? -1 : pos++; };
  const jobTo = (s: string, j: string, state: Extract<BetsOp, { op: 'job' }>['state'], tr: string) => { ops.push({ s, t: tr, op: 'job', job: j, state }); };
  const resolve = (s: string, j: string, tr: string, expect?: string) => { ops.push({ s, t: tr, op: 'resolve', job: j, ...(expect ? { expect } : {}) }); };
  const lock = (s: string, j: string, tr = 'round_lock', expect?: string, at = now) => { ops.push({ s, t: tr, op: 'lock', job: j, now: at, ...(expect ? { expect } : {}) }); };
  const claim = (s: string, p: number, tr: string, expect?: string) => { ops.push({ s, t: tr, op: 'claim', pos: p, ...(expect ? { expect } : {}) }); };
  const sweep = (s: string, j: string, tr: string, expect?: string) => { ops.push({ s, t: tr, op: 'sweep', job: j, ...(expect ? { expect } : {}) }); };

  // ---- seller A: builds its record, then both sides, dispute, caps, failure with the senior tranche
  // S07 FOR only: a backer withdraws part, then all; the job auto-completes; the round resolves from Open
  job('j07', 'b1', 'sellerA');
  round('S07', 'j07', 'sellerA');
  const p07a = back('S07', 'j07', 'sellerA', 500_000n);
  const p07b = back('S07', 'j07', 'backer1', 400_000n);
  ops.push({ s: 'S07', t: 'pos_withdraw_for_part', op: 'withdrawFor', caller: 'backer1', pos: p07b, amount: '100000', now });
  ops.push({ s: 'S07', t: 'ref_withdraw_not_owner', op: 'withdrawFor', caller: 'backer2', pos: p07b, amount: '1', now, expect: 'NotOwner' });
  ops.push({ s: 'S07', t: 'pos_withdraw_for_all', op: 'withdrawFor', caller: 'backer1', pos: p07b, amount: '300000', now });
  claim('S07', p07a, 'ref_claim_unresolved', 'NotResolved');
  lock('S07', 'j07', 'ref_lock_too_early', 'NotLockable');
  jobTo('S07', 'j07', 'Submitted', 'job_submit');
  jobTo('S07', 'j07', 'Completed', 'job_auto_complete');
  resolve('S07', 'j07', 'round_resolve_delivered_open');
  claim('S07', p07a, 'pos_claim_for_delivered');
  sweep('S07', 'j07', 'round_settle_delivered');

  // S11a Jev completes a needs_review job (FOR only)
  job('j11a', 'b2', 'sellerA');
  round('S11', 'j11a', 'b2');
  const p11a = back('S11', 'j11a', 'sellerA', 1_000_000n);
  fail('S11', 'openCover', 'j11a', 'b2', 10_000n, 'ref_not_insurable', 'NotInsurable');
  jobTo('S11', 'j11a', 'Submitted', 'job_submit');
  jobTo('S11', 'j11a', 'Completed', 'job_complete_jev');
  lock('S11', 'j11a');
  resolve('S11', 'j11a', 'round_resolve_delivered');
  claim('S11', p11a, 'pos_claim_for_delivered');
  sweep('S11', 'j11a', 'round_settle_delivered');

  // S01 deliver, both sides: junior + senior backing, the buyer's cover, a challenger
  job('j01', 'b3', 'sellerA');
  round('S01', 'j01', 'b3');
  round('S01', 'j01', 'b3', 'ref_open_round_twice', 'RoundExists');
  const p01j = back('S01', 'j01', 'sellerA', 1_000_000n);
  const p01s = back('S01', 'j01', 'backer1', 500_000n);
  back('S01', 'j01', 'backer1', 0n, 'ref_position_zero', 'ZeroAmount');
  const p01c = fail('S01', 'openCover', 'j01', 'b3', 200_000n, 'pos_open_cover');
  const p01a = fail('S01', 'openAgainst', 'j01', 'ch1', 100_000n, 'pos_open_against');
  fail('S01', 'openAgainst', 'j01', 'sellerA', 1_000n, 'ref_against_by_seller', 'SellerCannotChallenge');
  fail('S01', 'openAgainst', 'j01', 'b3', 1_000n, 'ref_against_by_buyer', 'BuyerUsesCover');
  fail('S01', 'openCover', 'j01', 'stranger', 1_000n, 'ref_cover_by_stranger', 'NotBuyer');
  fail('S01', 'openAgainst', 'j01', 'ch2', 1_000n, 'ref_price_moved', 'PriceAboveMax', 1n);
  jobTo('S01', 'j01', 'Submitted', 'job_submit');
  lock('S01', 'j01');
  fail('S01', 'openAgainst', 'j01', 'ch2', 1_000n, 'ref_position_locked', 'RoundNotOpen');
  ops.push({ s: 'S01', t: 'ref_withdraw_locked', op: 'withdrawFor', caller: 'backer1', pos: p01s, amount: '500000', now, expect: 'RoundNotOpen' });
  resolve('S01', 'j01', 'ref_resolve_not_ended', 'NoOutcome');
  jobTo('S01', 'j01', 'Completed', 'job_complete_code');
  resolve('S01', 'j01', 'round_resolve_delivered');
  for (const p of [p01j, p01s]) claim('S01', p, 'pos_claim_for_delivered');
  claim('S01', p01c, 'pos_claim_against_delivered');
  sweep('S01', 'j01', 'ref_settle_unclaimed', 'PositionsOutstanding');
  claim('S01', p01a, 'pos_claim_against_delivered');
  claim('S01', p01a, 'ref_claim_twice', 'PositionNotActive');
  sweep('S01', 'j01', 'round_settle_delivered');

  // S03 dispute, Jev rules for the seller: the round resolves delivered
  job('j03', 'b4', 'sellerA');
  round('S03', 'j03', 'sellerA');
  const p03j = back('S03', 'j03', 'sellerA', 600_000n);
  const p03c = fail('S03', 'openCover', 'j03', 'b4', 100_000n, 'pos_open_cover');
  jobTo('S03', 'j03', 'Submitted', 'job_submit');
  jobTo('S03', 'j03', 'RejectPending', 'job_reject_jev');
  jobTo('S03', 'j03', 'Disputed', 'job_dispute');
  jobTo('S03', 'j03', 'Completed', 'job_rule_seller');
  resolve('S03', 'j03', 'round_resolve_delivered_open');
  claim('S03', p03j, 'pos_claim_for_delivered');
  claim('S03', p03c, 'pos_claim_against_delivered');
  sweep('S03', 'j03', 'round_settle_delivered');

  // S08 AGAINST alone is refused (nothing backs it), then backed
  job('j08', 'b5', 'sellerA');
  round('S08', 'j08', 'b5');
  fail('S08', 'openAgainst', 'j08', 'ch1', 50_000n, 'ref_collateral', 'Undercollateralised');
  const p08j = back('S08', 'j08', 'sellerA', 400_000n);
  const p08a = fail('S08', 'openAgainst', 'j08', 'ch1', 50_000n, 'pos_open_against');
  jobTo('S08', 'j08', 'Submitted', 'job_submit');
  jobTo('S08', 'j08', 'Completed', 'job_complete_code');
  resolve('S08', 'j08', 'round_resolve_delivered_open');
  claim('S08', p08j, 'pos_claim_for_delivered');
  claim('S08', p08a, 'pos_claim_against_delivered');
  sweep('S08', 'j08', 'round_settle_delivered');

  // S09 caps: cover cap, AGAINST cap, senior cap, a withdrawal that would break collateral
  job('j09', 'b1', 'sellerA');
  round('S09', 'j09', 'sellerA');
  const p09j = back('S09', 'j09', 'sellerA', 200_000n);
  const p09s = back('S09', 'j09', 'backer2', 3_000_000n);
  fail('S09', 'openCover', 'j09', 'b1', 400_000n, 'ref_cover_cap', 'CoverCap');
  fail('S09', 'openAgainst', 'j09', 'ch1', 400_000n, 'ref_against_cap', 'AgainstCap');
  const p09c = fail('S09', 'openCover', 'j09', 'b1', 140_000n, 'pos_open_cover');
  fail('S09', 'openAgainst', 'j09', 'ch1', 100_000n, 'ref_senior_cap', 'SeniorCap');
  const p09a = fail('S09', 'openAgainst', 'j09', 'ch1', 50_000n, 'pos_open_against');
  ops.push({ s: 'S09', t: 'ref_withdraw_breaks_collateral', op: 'withdrawFor', caller: 'sellerA', pos: p09j, amount: '200000', now, expect: 'SeniorCap' });
  ops.push({ s: 'S09', t: 'ref_withdraw_against', op: 'withdrawFor', caller: 'b1', pos: p09c, amount: '1', now, expect: 'NotFor' });
  jobTo('S09', 'j09', 'Submitted', 'job_submit');
  jobTo('S09', 'j09', 'Completed', 'job_auto_complete');
  resolve('S09', 'j09', 'round_resolve_delivered_open');
  for (const p of [p09j, p09s]) claim('S09', p, 'pos_claim_for_delivered');
  for (const p of [p09c, p09a]) claim('S09', p, 'pos_claim_against_delivered');
  sweep('S09', 'j09', 'round_settle_delivered');

  // S06 void: no ending in time, everyone refunded (locked first)
  job('j06', 'b2', 'sellerA');
  round('S06', 'j06', 'b2');
  const p06j = back('S06', 'j06', 'sellerA', 800_000n);
  const p06c = fail('S06', 'openCover', 'j06', 'b2', 50_000n, 'pos_open_cover');
  const p06a = fail('S06', 'openAgainst', 'j06', 'ch2', 40_000n, 'pos_open_against');
  lock('S06', 'j06', 'round_lock', undefined, late);
  ops.push({ s: 'S06', t: 'ref_void_too_early', op: 'void', job: 'j06', now: late, expect: 'VoidTooEarly' });
  ops.push({ s: 'S06', t: 'round_void', op: 'void', job: 'j06', now: after });
  for (const p of [p06j, p06c, p06a]) claim('S06', p, 'pos_refund_void');
  sweep('S06', 'j06', 'round_settle_void');

  // S02 fail, cover paid: the junior absorbs first, the senior pays the rest (seller A's last insurable round)
  job('j02', 'b5', 'sellerA');
  round('S02', 'j02', 'sellerA');
  const p02j = back('S02', 'j02', 'sellerA', 300_000n);
  const p02s = back('S02', 'j02', 'backer2', 1_000_000n);
  const p02c = fail('S02', 'openCover', 'j02', 'b5', 120_000n, 'pos_open_cover');
  const p02a = fail('S02', 'openAgainst', 'j02', 'ch1', 60_000n, 'pos_open_against');
  jobTo('S02', 'j02', 'Submitted', 'job_submit');
  jobTo('S02', 'j02', 'RejectPending', 'job_reject_code');
  jobTo('S02', 'j02', 'Rejected', 'job_finalize_reject');
  lock('S02', 'j02');
  // a job that ended resolves: voiding it (to dodge the failure) is refused even after the void time
  ops.push({ s: 'S02', t: 'ref_void_has_outcome', op: 'void', job: 'j02', now: after, expect: 'HasOutcome' });
  resolve('S02', 'j02', 'round_resolve_failed');
  claim('S02', p02j, 'pos_claim_for_failed_junior');
  claim('S02', p02s, 'pos_claim_for_failed_senior');
  claim('S02', p02c, 'pos_claim_against_failed');
  claim('S02', p02a, 'pos_claim_against_failed');
  sweep('S02', 'j02', 'round_settle_failed');

  // ---- seller B: two FOR-only deliveries make it insurable, then an accepted job expires with a challenger on it
  for (const [j, b] of [['jB1', 'b1'], ['jB2', 'b2']] as const) {
    job(j, b, 'sellerB');
    round('S05', j, 'sellerB');
    const p = back('S05', j, 'sellerB', 300_000n);
    jobTo('S05', j, 'Submitted', 'job_submit');
    jobTo('S05', j, 'Completed', 'job_complete_code');
    resolve('S05', j, 'round_resolve_delivered_open');
    claim('S05', p, 'pos_claim_for_delivered');
    sweep('S05', j, 'round_settle_delivered');
  }
  job('j05', 'b3', 'sellerB');
  round('S05', 'j05', 'b3');
  const p05j = back('S05', 'j05', 'sellerB', 800_000n);
  const p05a = fail('S05', 'openAgainst', 'j05', 'ch2', 100_000n, 'pos_open_against');
  jobTo('S05', 'j05', 'Expired', 'job_expire');
  resolve('S05', 'j05', 'round_resolve_failed_open');
  claim('S05', p05j, 'pos_claim_for_failed_junior');
  claim('S05', p05a, 'pos_claim_against_failed');
  sweep('S05', 'j05', 'round_settle_failed');

  // S04 dispute, Jev rules for the buyer (seller B, FOR only: one failure on record makes it uninsurable)
  job('j04', 'b4', 'sellerB');
  round('S04', 'j04', 'sellerB');
  const p04j = back('S04', 'j04', 'sellerB', 200_000n);
  fail('S04', 'openCover', 'j04', 'b4', 10_000n, 'ref_not_insurable', 'NotInsurable');
  jobTo('S04', 'j04', 'Submitted', 'job_submit');
  jobTo('S04', 'j04', 'RejectPending', 'job_reject_jev');
  jobTo('S04', 'j04', 'Disputed', 'job_dispute');
  jobTo('S04', 'j04', 'Rejected', 'job_rule_buyer');
  resolve('S04', 'j04', 'round_resolve_failed_open');
  claim('S04', p04j, 'pos_claim_for_failed_junior');
  sweep('S04', 'j04', 'round_settle_failed');

  // S12 a stale dispute and a cheat finding end Failed (seller C, FOR only)
  for (const [j, b, path] of [['j12s', 'b1', 'stale'], ['j12c', 'b2', 'cheat']] as const) {
    job(j, b, 'sellerC');
    round('S12', j, 'sellerC');
    const p = back('S12', j, 'sellerC', 100_000n);
    jobTo('S12', j, 'Submitted', 'job_submit');
    if (path === 'stale') {
      jobTo('S12', j, 'RejectPending', 'job_reject_code');
      jobTo('S12', j, 'Disputed', 'job_dispute');
      jobTo('S12', j, 'Rejected', 'job_stale_dispute');
    } else jobTo('S12', j, 'Cheated', 'job_cheat');
    resolve('S12', j, 'round_resolve_failed_open');
    claim('S12', p, 'pos_claim_for_failed_junior');
    sweep('S12', j, 'round_settle_failed');
  }
  // a round voided straight from Open
  job('j12v', 'b3', 'sellerC');
  round('S12', 'j12v', 'sellerC');
  const p12v = back('S12', 'j12v', 'sellerC', 100_000n);
  ops.push({ s: 'S12', t: 'round_void_open', op: 'void', job: 'j12v', now: after });
  claim('S12', p12v, 'pos_refund_void');
  sweep('S12', 'j12v', 'round_settle_void');

  // ---- S10 pause and shutdown (last: shutdown is final)
  job('j10', 'b4', 'sellerC');
  ops.push({ s: 'S10', t: 'ref_pause_not_owner', op: 'pause', caller: 'stranger', expect: 'NotOwner' });
  ops.push({ s: 'S10', t: 'market_pause', op: 'pause', caller: 'owner' });
  round('S10', 'j10', 'b4', 'ref_open_round_paused', 'MarketNotActive');
  ops.push({ s: 'S10', t: 'market_unpause', op: 'unpause', caller: 'owner' });
  round('S10', 'j10', 'stranger'); // _OPEN_BOOK_v1_: anyone lists an accepted job; the round's parties are the job's
  job('j10c', 'b4', 'sellerC'); // its own job: on a chain time never runs back, so j10 itself must open before its cutoff
  ops.push({ s: 'S10', t: 'ref_open_round_after_cutoff', op: 'openRound', caller: 'b4', job: 'j10c', classId: 'code.typed', now: late, expect: 'AfterCutoff' });
  job('j10n', 'b5', 'sellerC');
  jobTo('S10', 'j10n', 'Submitted', 'job_submit');
  round('S10', 'j10n', 'b5', 'ref_open_round_not_accepted', 'JobNotAccepted');
  ops.push({ s: 'S10', t: 'market_pause', op: 'pause', caller: 'owner' });
  back('S10', 'j10', 'sellerC', 100_000n, 'ref_position_paused', 'MarketNotActive');
  ops.push({ s: 'S10', t: 'market_unpause', op: 'unpause', caller: 'owner' });
  // the kill switch from Active (one market shuts down once; from Paused is covered by the contract tests)
  ops.push({ s: 'S10', t: 'market_shutdown_active', op: 'shutdown', caller: 'owner' });
  ops.push({ s: 'S10', t: 'ref_unpause_after_shutdown', op: 'unpause', caller: 'owner', expect: 'MarketShutdown' });
  job('j10s', 'b1', 'sellerC');
  round('S10', 'j10s', 'b1', 'ref_open_round_shutdown', 'MarketNotActive');
  // claims and voids keep working after shutdown (no lockout)
  ops.push({ s: 'S10', t: 'round_void_open', op: 'void', job: 'j10', now: after });
  sweep('S10', 'j10', 'round_settle_void');
  return { name: 'taifoon.assurance.scenarios.v1', params: paramsToStrings(params), jobs, ops };
}
