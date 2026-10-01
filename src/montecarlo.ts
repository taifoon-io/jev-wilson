// jev-wilson/montecarlo: the two simulations a calibration runs. Seeded, so a rerun on the same inputs gives the same answer.
//
//   noLoss   does the evaluator ever lose money on a served job? Each sample quotes a job at a random block of the chain's
//            fee history (that block's base fee, the median tip of the 1,024 blocks before it, the window's own rise), then
//            sends our legs when the job would send them (open at once, accept after `acceptAfterS`, the rest at the job's
//            end: most within minutes, some after the review window, a few after review + dispute) and pays the base fee
//            and tip of THOSE blocks, the gas token's USD price moving by a normal draw. Two send policies:
//              A  send at once, whatever the gas;   B  each leg's maxFeePerGas = the quoted gas price (wait while above it)
//   backer   what a cover pool's backer earns in a year of jobs priced with lpPremium (the port of scripts/lp-montecarlo.py).
import { jobFee, windowRiseBps, type FeePolicy, type FeeProfile, type GasInputs, type Leg } from './fee.ts';
import { lpPremium, type LpParams } from './lp.ts';
import type { FeeRow } from './gas-source.ts';

/** mulberry32: a small, fast, seeded PRNG in [0, 1). */
export function rng(seed: number) {
  let a = seed >>> 0;
  const u = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const normal = () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
  const gamma = (k: number): number => {
    if (k < 1) return gamma(k + 1) * Math.pow(u() + 1e-300, 1 / k);
    const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number, v: number;
      do { x = normal(); v = 1 + c * x; } while (v <= 0);
      v = v * v * v;
      const w = u();
      if (w < 1 - 0.0331 * x * x * x * x || Math.log(w) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  };
  const beta = (a1: number, b1: number) => { const x = gamma(a1); return x / (x + gamma(b1)); };
  return { u, normal, beta };
}
type Rng = ReturnType<typeof rng>;

export type MixBand = [share: number, lo: number, hi: number];
export type McPolicy = { samples: number; seed: number; sizeMix: MixBand[]; acceptAfterS: number; endMix: [share: number, afterS: number][]; promptMedianS: number };

function pick<T extends [number, ...unknown[]]>(r: Rng, mix: T[]): T { let x = r.u(); for (const m of mix) { if ((x -= m[0]) < 0) return m; } return mix[mix.length - 1]!; }
const sizeOf = (r: Rng, mix: MixBand[]) => { const [, lo, hi] = pick(r, mix); return Math.exp(Math.log(lo) + r.u() * (Math.log(hi) - Math.log(lo))); };
const endOf = (r: Rng, p: McPolicy) => { const [, after] = pick(r, p.endMix); return after + Math.exp(Math.log(p.promptMedianS) + r.normal()); };

/** When a leg is sent: the relayer's open at once, the stand-in's approve + accept after acceptAfterS, everything else at the end. */
export const phaseOf = (key: string): 'open' | 'accept' | 'end' => (key.startsWith('relay-') ? 'open' : key === 'approve' || key === 'accept' ? 'accept' : 'end');

export type Segment = { rows: FeeRow[] };
export type NoLossInput = {
  chainId: number; segments: Segment[]; blockS: number; legs: (Leg & { key: string })[]; policy: FeePolicy; profile: FeeProfile;
  l1FeeWeiByBytes: Record<number, bigint>; gasUsd8: bigint; gasTokenVolPerHour: number; tip: 'percentile' | 'none'; /** a fixed tip when the history has none */ tipWei?: bigint; horizonBlocks: number;
};
export type NoLossResult = {
  profile: FeeProfile; samples: number; served_share: number; mean_fee_usdc: number;
  A: { losses: number; loss_share: number; mean_margin_usdc: number; worst_margin_usdc: number };
  B: { losses: number; loss_share: number; mean_margin_usdc: number; wait_p95_s: number; wait_max_s: number };
};

/** One run of the no-loss Monte Carlo. Pure (all randomness from the seed). */
export function noLoss(inp: NoLossInput, mc: McPolicy): NoLossResult {
  const r = rng(mc.seed);
  const tailBlocks = Math.ceil(8_000 / inp.blockS);
  const usable = inp.segments.map((s) => Math.max(0, s.rows.length - 1024 - tailBlocks));
  const totalUsable = usable.reduce((a, b) => a + b, 0);
  if (totalUsable <= 0) throw new Error(`fee history too short for the Monte Carlo on ${inp.chainId}: each segment needs 1,024 + ${tailBlocks} blocks`);
  const tipCache = new Map<string, bigint>();
  const st = { served: 0, feeSum: 0, lossA: 0, lossB: 0, mA: 0, mB: 0, worstA: Infinity, waits: [] as number[] };
  for (let s = 0; s < mc.samples; s++) {
    let x = Math.floor(r.u() * totalUsable), si = 0;
    while (x >= usable[si]!) { x -= usable[si]!; si++; }
    const rows = inp.segments[si]!.rows;
    const t = 1024 + x;
    const bf = (i: number) => rows[Math.min(i, rows.length - 1)]![1];
    let tip = inp.tipWei ?? 0n;
    if (inp.tip === 'percentile') {
      const ck = `${si}:${t >> 6}`; // the median tip moves slowly: cache per 64 blocks
      if (!tipCache.has(ck)) { const tips = rows.slice(t - 1024, t).map((q) => q[4]).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); tipCache.set(ck, tips[512]!); }
      tip = tipCache.get(ck)!;
    }
    const win = rows.slice(t - 1024, t + 1).map((q) => q[1]);
    const g: GasInputs = { chainId: inp.chainId, block: rows[t]![0], baseFeeWei: bf(t), tipWei: tip, liveBufferBps: windowRiseBps(win.slice(0, -1), inp.horizonBlocks), l1FeeWeiByBytes: inp.l1FeeWeiByBytes, gasUsd8: inp.gasUsd8 };
    const P = BigInt(Math.max(1, Math.round(sizeOf(r, mc.sizeMix) * 1e6)));
    const q = jobFee(P, g, inp.legs, inp.policy);
    const end = endOf(r, mc);
    if (!q.served) continue;
    st.served++;
    const fee = Number(q.fee) / 1e6; st.feeSum += fee;
    const quotedGp = q.gas.gasPrice;
    let weiA = 0n, weiB = 0n, waited = 0;
    for (const l of inp.legs) {
      const ph = phaseOf(l.key);
      const at = t + Math.ceil((ph === 'open' ? 0 : ph === 'accept' ? mc.acceptAfterS : end) / inp.blockS);
      const l1 = inp.l1FeeWeiByBytes[l.bytes] ?? 0n;
      weiA += BigInt(l.gas) * (bf(at) + tip) + l1;
      let k = at;
      while (bf(k) + tip > quotedGp && k < rows.length - 1) k++;
      waited = Math.max(waited, (k - at) * inp.blockS);
      weiB += BigInt(l.gas) * (bf(k) + tip) + l1;
    }
    const move = 1 + inp.gasTokenVolPerHour * Math.sqrt(Math.max(end, 30) / 3600) * r.normal();
    const usd = (w: bigint) => (Number(w) / 1e18) * (Number(inp.gasUsd8) / 1e8) * move;
    const mA = fee - usd(weiA), mB = fee - usd(weiB);
    st.mA += mA; st.mB += mB; if (mA < 0) st.lossA++; if (mB < 0) st.lossB++; st.worstA = Math.min(st.worstA, mA); st.waits.push(waited);
  }
  st.waits.sort((a, b) => a - b);
  const n = Math.max(1, st.served);
  return {
    profile: inp.profile, samples: mc.samples, served_share: st.served / mc.samples, mean_fee_usdc: st.feeSum / n,
    A: { losses: st.lossA, loss_share: st.lossA / n, mean_margin_usdc: st.mA / n, worst_margin_usdc: st.served ? st.worstA : 0 },
    B: { losses: st.lossB, loss_share: st.lossB / n, mean_margin_usdc: st.mB / n, wait_p95_s: st.waits[Math.floor(0.95 * st.waits.length)] ?? 0, wait_max_s: st.waits.at(-1) ?? 0 },
  };
}

export type BackerPolicy = { sims: number; jobs: number; capital: number; maxCoverShare: number; seed: number; book: number };
export const BACKER_SELLERS: [name: string, correct: number, incorrect: number][] = [
  ['new (no record)', 0, 0], ['30 correct / 1 incorrect', 30, 1], ['70 correct / 2 incorrect', 70, 2], ['2,735 correct / 5 incorrect', 2735, 5],
];

/** A backer's year: one seller's pool, `jobs` jobs, premiums from lpPremium on the record so far, cover paid on a failure
 *  only when an arbitrator exists. Returns the rows of scripts/lp-montecarlo.py. Pure (seeded). */
export function backerReturns(lp: LpParams, quoteLockS: number, mc: McPolicy, bp: BackerPolicy) {
  const r = rng(bp.seed);
  const lockOf = () => { const [, after] = pick(r, mc.endMix); return after + Math.exp(Math.log(mc.promptMedianS) + r.normal()); };
  const poolYear = (k0: number, f0: number, arbitrator: boolean) => {
    const q = r.beta(lp.a0 + f0, lp.b0 + k0);
    let k = k0, f = f0, prem = 0, paid = 0, uninsured = 0, locked = 0; const ratios: number[] = [];
    for (let i = 0; i < bp.jobs; i++) {
      const P = sizeOf(r, mc.sizeMix); const L = lockOf(); const fail = r.u() < q;
      const units = Math.max(1, Math.round(P * 1e6));
      const p = lpPremium({ price: units, record: { correct: k, incorrect: f }, lockSeconds: quoteLockS, arbitrator }, lp);
      if (!p.covered || P > bp.maxCoverShare * bp.capital) uninsured++;
      else { prem += p.premium / 1e6; ratios.push(p.ratio); locked += P * L; if (fail && arbitrator) paid += P; }
      if (fail) f++; else k++;
    }
    return { pnl: prem - paid, prem, paid, ratio: ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null, uninsured: uninsured / bp.jobs, util: locked / (bp.capital * 31_536_000) };
  };
  const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const rows: Record<string, unknown>[] = [];
  for (const arbitrator of [false, true]) {
    for (const [name, k0, f0] of BACKER_SELLERS) {
      const R = Array.from({ length: bp.sims }, () => poolYear(k0, f0, arbitrator));
      const ret = R.map((x) => x.pnl / bp.capital);
      const rat = R.map((x) => x.ratio).filter((x): x is number => x !== null);
      rows.push({ arbitrator, seller: name, mean_return: mean(ret), p5_return: q(ret, 0.05), loss_share: ret.filter((x) => x < 0).length / ret.length,
        mean_ratio: rat.length ? mean(rat) : null, uninsured_share: mean(R.map((x) => x.uninsured)), utilization: mean(R.map((x) => x.util)),
        premiums_usdc: mean(R.map((x) => x.prem)), payouts_usdc: mean(R.map((x) => x.paid)) });
    }
    const books = Array.from({ length: Math.max(100, Math.floor(bp.sims / 10)) }, () => {
      let s = 0; for (let i = 0; i < bp.book; i++) s += poolYear(0, 0, arbitrator).pnl; return s / (bp.book * bp.capital);
    });
    rows.push({ arbitrator, seller: `${bp.book} new sellers, one backer`, mean_return: mean(books), p5_return: q(books, 0.05), loss_share: books.filter((x) => x < 0).length / books.length });
  }
  return rows;
}
