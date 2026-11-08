import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { BETS_DEFAULTS, WAD, betsPrice, grossPayout, positionFee, isqrt, paramsFromStrings, runBetsScript, quoteBothSides, sideEstimates, manipulationBound, BetsMarket, BetsError } from '../src/bets.ts';
import { betsMonteCarlo } from '../src/bets-mc.ts';
import { DEVNET_BETS_PARAMS, buildBetsScript } from '../src/bets-scenarios.ts';

const G = JSON.parse(readFileSync(new URL('./vectors/bets-grid.json', import.meta.url), 'utf8'));
const S = JSON.parse(readFileSync(new URL('./vectors/bets-scenarios.json', import.meta.url), 'utf8'));

test('bets grid: every row to the unit (defaults and devnet params)', () => {
  for (const set of Object.values(G.sets) as { params: Record<string, string>; rows: string[][] }[]) {
    const p = paramsFromStrings(set.params);
    for (const [k, f, l, pp, mean, sd, risk, cap, ins, x, g, fee] of set.rows) {
      const q = betsPrice({ kEff: BigInt(k!), f: BigInt(f!) }, BigInt(l!), p);
      assert.deepEqual([q.p, q.mean, q.sd, q.risk, q.capital].map(String), [pp, mean, sd, risk, cap]);
      assert.equal(q.insurable ? '1' : '0', ins);
      assert.equal(grossPayout(BigInt(x!), q.p).toString(), g);
      assert.equal(positionFee(BigInt(x!), p).toString(), fee);
    }
  }
});

test('scenarios: the script reproduces the vector file, conserves every unit, ends with nothing held', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(buildBetsScript())), S.script);
  const r = runBetsScript(S.script);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), S.expected);
  assert.equal(r.conserved, true);
  assert.equal(r.held, '0');
});

test('scenarios cover every round / position / market transition and refusal of the machine', { skip: !existsSync(new URL('../../../schemas/assurance/machine.json', import.meta.url)) && 'machine.json not beside this package (public mirror)' }, () => {
  const M = JSON.parse(readFileSync(new URL('../../../schemas/assurance/machine.json', import.meta.url), 'utf8'));
  const tags = new Set((S.script.ops as { t: string }[]).map((o) => o.t));
  const want = [...['market', 'round', 'position', 'job'].flatMap((k) => M.machines[k].transitions.map((t: { id: string }) => t.id)),
    ...M.refusals.map((r: { id: string }) => r.id).filter((id: string) => !/wrong_evaluator|wrong_asset|ref_rule_/.test(id))].filter((id: string) => id !== 'market_shutdown_paused'); // one market shuts down once: the contract tests cover it
  for (const id of want) assert.ok(tags.has(id), `no scenario op exercises ${id}`);
  for (const t of tags) assert.ok(want.includes(t) || /wrong_evaluator|wrong_asset|ref_rule_/.test(t), `scenario names unknown id ${t}`);
});

test('price: monotone in failures, falls with deliveries, floor and insurable cut', () => {
  let last = 0n;
  for (const f of [0n, 1n, 2n, 5n]) { const p = betsPrice({ kEff: 50n, f }, 600n).p; assert.ok(p > last); last = p; }
  assert.ok(betsPrice({ kEff: 10n, f: 0n }, 600n).p < betsPrice({ kEff: 3n, f: 0n }, 600n).p);
  assert.equal(betsPrice({ kEff: 100_000n, f: 0n }, 0n).p, BETS_DEFAULTS.pMin);
  assert.equal(betsPrice({ kEff: 0n, f: 0n }, 0n).insurable, false); // a new seller is priced from the prior: not insurable
  assert.equal(betsPrice({ kEff: 2n, f: 0n }, 600n).insurable, true);
});

test('isqrt equals floor(sqrt) on edges', () => {
  for (const n of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 10n ** 36n, 10n ** 36n - 1n, 2n ** 255n]) { const r = isqrt(n); assert.ok(r * r <= n && (r + 1n) * (r + 1n) > n); }
});

test('no arbitrage: cover and AGAINST at one block pay the same G for the same x', () => {
  const m = new BetsMarket(DEVNET_BETS_PARAMS);
  const job = { buyer: 'b', seller: 's', price: 1_000_000n, deadline: 10_000n, reviewWindow: 60n, disputeWindow: 60n, arbitrationWindow: 120n, accepted: true };
  const bk = m.book('s|c'); bk.kEff = 10n; bk.distinctBuyers = 5n;
  m.openRound('s', 'j', 'c', job, 0n); m.openFor('s', 'j', 2_000_000n, true, 0n);
  const c = m.openFailure('COVER', 'b', 'j', 50_000n, WAD, 600n, true, 0n);
  const a = m.openFailure('AGAINST', 'x', 'j', 50_000n, WAD, 600n, true, 0n);
  assert.equal(c.p, a.p); assert.equal(c.G, a.G); assert.equal(c.fee, a.fee);
});

test('house never loses: the treasury only receives; fee >= min fee', () => {
  for (const x of [1n, 100n, 10n ** 6n, 10n ** 20n]) assert.ok(positionFee(x) >= BETS_DEFAULTS.minFee);
  const r = runBetsScript(buildBetsScript());
  assert.ok(BigInt(r.treasury) >= 0n);
});

test('self-dealing: a seller-challenger pair only moves the seller junior stake (minus fees) when senior capacity is 0', () => {
  const m = new BetsMarket(DEVNET_BETS_PARAMS);
  const job = { buyer: 'b', seller: 's', price: 1_000_000n, deadline: 10_000n, reviewWindow: 60n, disputeWindow: 60n, arbitrationWindow: 120n, accepted: true };
  const bk = m.book('s|c'); bk.kEff = 10n; bk.distinctBuyers = 1n; // below min distinct buyers: no senior capacity
  m.openRound('s', 'j', 'c', job, 0n);
  const j = m.openFor('s', 'j', 300_000n, true, 0n);
  const h = m.openFor('honest', 'j', 5_000_000n, true, 0n);
  assert.throws(() => m.openFailure('AGAINST', 'sybil', 'j', 60_000n, WAD, 600n, true, 0n), (e) => e instanceof BetsError && e.code === 'SeniorCap');
  const a = m.openFailure('AGAINST', 'sybil', 'j', 20_000n, WAD, 600n, true, 0n);
  m.resolve('j', 'Failed');
  const outJ = m.claim(j.id), outH = m.claim(h.id), outA = m.claim(a.id);
  assert.equal(outH, h.stake, 'the honest senior backer loses nothing');
  assert.ok(outJ + outA < j.stake + a.stake + a.fee, 'the colluding pair ends with less than it put in');
});

test('estimate: fair < offered, AGAINST expectation negative at the fair rate, FOR positive; manipulation bound', () => {
  const e = quoteBothSides({ record: { kEff: 40n, f: 1n, distinctBuyers: 12n }, lockS: 4_200n, coverX: 100_000n, costPerRound: 20_000n });
  assert.ok(e.fairP < e.offeredP);
  assert.ok(e.perUnit.AGAINST.expectedReturn < 0 && e.perUnit.FOR.expectedReturn > 0);
  assert.deepEqual(e.perUnit.AGAINST.expectedReturn, e.perUnit.COVER.expectedReturn);
  assert.equal(e.checks.noArbitrage, true);
  const s = sideEstimates(0.1, 0.1, 0);
  assert.ok(Math.abs(s.AGAINST.expectedReturn) < 1e-12 && Math.abs(s.FOR.expectedReturn) < 1e-12, 'at p = q both sides are fair');
  const mb = manipulationBound({ kEff: 40n, f: 0n, distinctBuyers: 12n }, 20_000n, BETS_DEFAULTS);
  assert.equal(mb.profitable, false, 'senior_per_round <= cost per counted round: building the record never pays');
});

test('monte carlo: conserved, nothing left in the market, senior backers do not lose on average', () => {
  const r = betsMonteCarlo(BETS_DEFAULTS, { sellers: 60, rounds: 30, history: 40, seed: 3, price: 10_000_000n, lockS: 4_200n, juniorBps: 10_000n, coverShareBps: 10_000n, againstShareBps: 5_000n, seniorStake: 20_000_000n });
  assert.equal(r.conserved, true); assert.equal(r.left_in_market, '0');
  assert.ok(r.senior_return_mean >= 0);
});
