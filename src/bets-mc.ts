// jev-wilson/bets-mc: the Monte Carlo of two-sided job assurance (src/bets.ts), kept apart so bets.ts has no imports.
import { rng } from './montecarlo.ts';
import { BETS_DEFAULTS, BetsError, BetsMarket, WAD, betsPrice, bookKey, type BetsParams, type JobView, type Position } from './bets.ts';

// ---------------------------------------------------------------------------------------------------------------
// Monte Carlo over sellers drawn from the fitted prior. Each seller runs `rounds` jobs; each round has a junior stake, a
// senior stake, a buyer's cover and a challenger, sized within the caps; the market model settles every round.

export type BetsMc = { sellers: number; rounds: number; /** prior jobs each seller brings (distinct buyers), drawn from its own rate */ history: number; seed: number; price: bigint; lockS: bigint; juniorBps: bigint; /** share of the cover cap the buyer takes */ coverShareBps: bigint; /** share of the AGAINST cap the challenger takes */ againstShareBps: bigint; seniorStake: bigint };
export const BETS_MC_DEFAULTS: BetsMc = { sellers: 300, rounds: 60, history: 40, seed: 11, price: 10_000_000n, lockS: 4_200n, juniorBps: 10_000n, coverShareBps: 10_000n, againstShareBps: 5_000n, seniorStake: 20_000_000n };

export function betsMonteCarlo(params: BetsParams = BETS_DEFAULTS, mc: BetsMc = BETS_MC_DEFAULTS) {
  const r = rng(mc.seed);
  const a0 = Number(params.a0) / 1e18, b0 = Number(params.b0) / 1e18;
  const acc = { rounds: 0, refused: 0, delivered: 0, failed: 0, fees: 0n, inFor: 0n, outFor: 0n, inJ: 0n, outJ: 0n, inS: 0n, outS: 0n, inA: 0n, outA: 0n, inC: 0n, outC: 0n, held: 0n };
  const forReturns: number[] = [], againstReturns: number[] = []; const reasons: Record<string, number> = {};
  for (let s = 0; s < mc.sellers; s++) {
    const q = r.beta(a0, b0);
    const m = new BetsMarket(params);
    const seller = `seller${s}`;
    { // the record the seller arrives with: `history` jobs from distinct buyers, each counted once
      const b = m.book(bookKey(seller, 'class'));
      for (let h = 0; h < mc.history; h++) { if (r.u() < q) b.f += 1n; else { b.kEff += 1n; b.distinctBuyers += 1n; b.buyerRounds.set(`hist${h}`, 1n); } }
    }
    for (let i = 0; i < mc.rounds; i++) {
      const jobId = `${s}:${i}`, buyer = `buyer${i % 7}`;
      const job: JobView = { buyer, seller, price: mc.price, deadline: 10_000n, reviewWindow: 60n, disputeWindow: 60n, arbitrationWindow: 120n, accepted: true };
      m.openRound(seller, jobId, 'class', job, 0n);
      const junior = (mc.price * mc.juniorBps) / 10_000n;
      const pj = m.openFor(seller, jobId, junior, true, 0n);
      const ps = m.openFor('backer', jobId, mc.seniorStake, true, 0n);
      const xs: Position[] = [];
      // the buyer covers the whole price (G = C = price), the challenger takes half the AGAINST cap: x = G * p
      const bk = m.book(bookKey(seller, 'class'));
      const pNow = betsPrice({ kEff: bk.kEff, f: bk.f }, mc.lockS, params).p;
      const coverX = (((mc.price * params.coverMultipleBps * mc.coverShareBps) / 100_000_000n) * pNow) / WAD;
      const againstX = (((mc.price * params.againstMultipleBps * mc.againstShareBps) / 100_000_000n) * pNow) / WAD;
      for (const [side, who, x] of [['COVER', buyer, coverX], ['AGAINST', 'challenger', againstX]] as const) {
        if (x === 0n) continue;
        try { xs.push(m.openFailure(side, who, jobId, x, params.maxRatio, mc.lockS, true, 0n)); } catch (e) { if (e instanceof BetsError) { acc.refused++; reasons[e.code] = (reasons[e.code] ?? 0) + 1; } else throw e; }
      }
      const fail = r.u() < q;
      m.resolve(jobId, fail ? 'Failed' : 'Delivered');
      acc.rounds++; if (fail) acc.failed++; else acc.delivered++;
      const outJ = m.claim(pj.id), outS = m.claim(ps.id);
      acc.inJ += pj.stake; acc.outJ += outJ; acc.inS += ps.stake; acc.outS += outS;
      forReturns.push(Number(outS - ps.stake) / Number(ps.stake));
      for (const x of xs) {
        const out = m.claim(x.id);
        if (x.side === 'AGAINST') { acc.inA += x.stake + x.fee; acc.outA += out; againstReturns.push(Number(out - x.stake - x.fee) / Number(x.stake + x.fee)); }
        else { acc.inC += x.stake + x.fee; acc.outC += out; }
      }
      m.sweepDust(jobId);
    }
    acc.fees += m.treasury;
    acc.held += m.held;
  }
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };
  const conserved = acc.inJ + acc.inS + acc.inA + acc.inC === acc.outJ + acc.outS + acc.outA + acc.outC + acc.fees;
  return {
    sellers: mc.sellers, rounds: acc.rounds, delivered: acc.delivered, failed: acc.failed, refused_positions: acc.refused, refused_by: reasons,
    junior_net: (acc.outJ - acc.inJ).toString(), senior_net: (acc.outS - acc.inS).toString(), against_net: (acc.outA - acc.inA).toString(),
    cover_net: (acc.outC - acc.inC).toString(), treasury: acc.fees.toString(), left_in_market: acc.held.toString(), conserved,
    senior_return_mean: mean(forReturns), senior_return_p5: pct(forReturns, 0.05), against_return_mean: mean(againstReturns), against_win_share: againstReturns.filter((x) => x > 0).length / Math.max(1, againstReturns.length),
  };
}

