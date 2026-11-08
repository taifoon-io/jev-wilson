import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { quoteEconomy, lpPremiumUnits, wad, isqrt, checkBounds, hookTerms, type EconomyQuote } from '../src/economy.ts';
import { quoteEconomyFor } from '../src/calibration.ts';
import { lpPremium, LP_DEFAULTS, type LpParams } from '../src/lp.ts';

// tests/vectors/economy-grid.json: written by scripts/gen-economy-grid.ts from quoteEconomy; Python and Solidity read it too.
const G = JSON.parse(readFileSync(new URL('./vectors/economy-grid.json', import.meta.url), 'utf8'));
const LP = JSON.parse(readFileSync(new URL('./vectors/lp-grid.json', import.meta.url), 'utf8'));
const BASE = JSON.parse(readFileSync(new URL('../calibration/8453.json', import.meta.url), 'utf8'));
const USDC = 1_000_000n;

test('economy grid: every leg of every row', () => {
  assert.ok(G.rows >= 10_000);
  for (let i = 0; i < G.rows; i++) {
    const p: LpParams = G.params[G.param[i]].source;
    const rec = G.correct[i] === 0 && G.incorrect[i] === 0 && i % 2 === 0 ? null : { correct: G.correct[i], incorrect: G.incorrect[i] };
    const q = quoteEconomy({ price: BigInt(G.price[i]), record: rec, lockSeconds: G.lock[i], arbitrator: G.arbitrator[i], coverMultipleBps: G.multiple[i], fee: BigInt(G.fee[i]) }, p);
    const at = `row ${i}`;
    assert.equal(q.covered, G.covered[i], at); assert.equal(q.insurable, G.insurable[i], at);
    assert.equal(String(q.premium), G.premium[i], at); assert.equal(String(q.toBackers), G.to_backers[i], at);
    assert.equal(String(q.toLayer), G.to_layer[i], at); assert.equal(String(q.deposit), G.deposit[i], at);
    assert.equal(String(q.compensation), G.compensation[i], at); assert.equal(String(q.coverCap), G.cover_cap[i], at);
    assert.equal(q.basis.ratioE6, G.ratio_e6[i], at); assert.equal(String(q.basis.lp), G.lp[i], at);
  }
});

test('the rules, on every row: legs sum, the layer never below the fee, compensation bounded, D > P', () => {
  for (let i = 0; i < G.rows; i++) {
    const [P, prem, b, l, d, c, fee] = [G.price[i], G.premium[i], G.to_backers[i], G.to_layer[i], G.deposit[i], G.compensation[i], G.fee[i]].map(BigInt) as bigint[];
    assert.equal(b! + l!, prem);
    assert.ok(d! > P!);
    assert.ok(c! <= P! && c! <= d! - P!);
    if (G.covered[i]) { assert.ok(l! >= fee!, `row ${i}: layer below the fee`); assert.ok(b! > 0n); assert.ok(prem! * 1_000_000n <= P! * BigInt(G.params[G.param[i]].maxRatioE6)); }
    else assert.equal(prem, 0n);
  }
});

test('lpPremiumUnits is lpPremium, exactly, wherever the doubles are exact (the whole lp grid)', () => {
  const [ip, ic, ii, il, im, ia, ipr] = ['price', 'correct', 'incorrect', 'lockSeconds', 'coverMultipleBps', 'arbitrator', 'premium'].map((k) => LP.cols.indexOf(k));
  let n = 0;
  for (const r of LP.rows) {
    if (!Number.isInteger(r[il])) continue; // the economy takes whole seconds
    const rec = r[ic] === null ? null : { correct: r[ic], incorrect: r[ii] };
    assert.equal(lpPremiumUnits({ price: BigInt(r[ip]), record: rec, lockSeconds: r[il], arbitrator: r[ia], coverMultipleBps: r[im] }), BigInt(r[ipr]));
    n++;
  }
  assert.ok(n > 1_000, `checked ${n}`);
  // and on the economy grid's rows below 1e9 units, against the double
  let m = 0;
  for (let i = 0; i < G.rows; i++) {
    if (BigInt(G.price[i]) > 1_000_000_000n) continue;
    const p = G.params[G.param[i]].source;
    const rec = { correct: G.correct[i], incorrect: G.incorrect[i] };
    const d = lpPremium({ price: Number(G.price[i]), record: rec, lockSeconds: G.lock[i], arbitrator: G.arbitrator[i], coverMultipleBps: G.multiple[i] }, p).premium;
    assert.equal(G.lp[i], String(d), `row ${i}`);
    m++;
  }
  assert.ok(m > 10_000, `checked ${m}`);
});

test('the owner’s numbers (assurance-economy-decisions, 2026-10-06): Base, 10 USDC, 7-day lock, an arbitrator', () => {
  const at = (f: number, n: number) => quoteEconomyFor(BASE, { price: 10n * USDC, record: { correct: n - f, incorrect: f }, lockSeconds: 7 * 86_400, arbitrator: true });
  const want: [number, number, bigint, bigint, bigint][] = [
    // f, n, premium, backers (lpPremium), layer
    [1, 20, 2_361_310n, 1_602_269n, 759_041n],
    [5, 100, 1_117_500n, 1_023_752n, 93_748n],
    [50, 1_000, 764_771n, 715_771n, 49_000n],
    [500, 10_000, 669_514n, 620_514n, 49_000n],
  ];
  for (const [f, n, premium, backers, layer] of want) {
    const q = at(f, n);
    assert.equal(q.covered, true);
    assert.deepEqual([q.premium, q.toBackers, q.toLayer], [premium, backers, layer], `${f}/${n}`);
    assert.equal(q.basis.fee, 49_000n);
    assert.equal(q.compensation, premium);
    assert.equal(q.deposit, 10n * USDC + premium);
  }
});

test('never negative for us: a long clean record still pays the layer its fee', () => {
  for (const n of [1_000, 100_000, 10_000_000]) {
    const q = quoteEconomy({ price: 10n * USDC, record: { correct: n, incorrect: 0 }, lockSeconds: 4_200, arbitrator: true, fee: 49_000n });
    assert.ok(q.covered); assert.ok(q.toLayer >= 49_000n); assert.equal(q.toBackers, q.basis.lp);
  }
});

test('no delivered job: no cover, the full Wilson bound sizes the deposit and the compensation', () => {
  for (const rec of [null, { correct: 0, incorrect: 0 }, { correct: 0, incorrect: 4 }]) {
    const q = quoteEconomy({ price: 10n * USDC, record: rec, lockSeconds: 4_200, arbitrator: true, fee: 49_000n });
    assert.equal(q.covered, false); assert.equal(q.reason, 'UNKNOWN'); assert.equal(q.premium, 0n);
    assert.equal(q.basis.ratioE6, 1_000_000); assert.equal(q.compensation, 10n * USDC); assert.equal(q.deposit, 20n * USDC);
  }
});

test('above the max ratio: no cover sold, deposit and compensation still quoted', () => {
  const q = quoteEconomy({ price: 10n * USDC, record: { correct: 3, incorrect: 7 }, lockSeconds: 4_200, arbitrator: true, fee: 49_000n });
  assert.equal(q.covered, false); assert.equal(q.reason, 'OVER_MAX_RATIO'); assert.equal(q.toLayer, 0n);
  assert.ok(q.compensation > 0n && q.deposit > 10n * USDC);
});

test('below the line’s min price: the fee does not fit the hook cap, so no cover', () => {
  const q = quoteEconomyFor(BASE, { price: 10_000n, record: { correct: 100, incorrect: 0 } });
  assert.equal(q.served, false); assert.equal(q.covered, false); assert.equal(q.reason, 'BELOW_MIN_PRICE'); assert.equal(q.premium, 0n);
});

test('checkBounds: a quote passes the bounds the README recommends; each bound refuses its own breach', () => {
  const b = { maxPremiumBps: 3_000, minBackersAprBps: 1_000 };
  const q = quoteEconomyFor(BASE, { price: 10n * USDC, record: { correct: 95, incorrect: 5 }, lockSeconds: 7 * 86_400, arbitrator: true });
  const t = { ...hookTerms(q).econ, price: 10n * USDC, premium: q.premium, deposit: q.deposit, coverCap: q.coverCap, pool: true, secondsToDeadline: 7 * 86_400 };
  assert.equal(checkBounds(t, b), null);
  assert.equal(checkBounds({ ...t, toLayer: t.toLayer + 1n }, b), 'LegsNotPremium');
  assert.equal(checkBounds({ ...t, toBackers: 0n, toLayer: t.premium }, b), 'BackersBelowFloor');
  assert.equal(checkBounds({ ...t, compensation: t.deposit + 1n }, b), 'CompensationOverBound');
  assert.equal(checkBounds({ ...t, premium: 4n * USDC, toLayer: 4n * USDC - t.toBackers }, b), 'PremiumOverBound');
  assert.equal(checkBounds({ ...t, pool: false }, b), 'LegsWithoutPool');
});

test('wad and isqrt are exact', () => {
  assert.equal(wad(0.1666), 166_600_000_000_000_000n); assert.equal(wad(2), 2n * 10n ** 18n); assert.equal(wad(1e-7), 100_000_000_000n);
  assert.throws(() => wad(1e-19)); assert.throws(() => wad(-1));
  for (const x of [0n, 1n, 2n, 3n, 4n, 99n, 100n, 10n ** 54n - 1n, 10n ** 54n, 2n ** 255n]) { const r = isqrt(x); assert.ok(r * r <= x && (r + 1n) * (r + 1n) > x); }
});

test('inputs out of range are refused', () => {
  const ok = { price: USDC, record: null, lockSeconds: 0, arbitrator: false, fee: 0n };
  assert.throws(() => quoteEconomy({ ...ok, price: 0n }), RangeError);
  assert.throws(() => quoteEconomy({ ...ok, lockSeconds: 1.5 }), RangeError);
  assert.throws(() => quoteEconomy({ ...ok, coverMultipleBps: 9_999 }), RangeError);
  assert.throws(() => quoteEconomy({ ...ok, fee: -1n }), RangeError);
  const q: EconomyQuote = quoteEconomy(ok);
  assert.equal(q.v, 'jev-wilson.economy.v1');
  assert.deepEqual(LP_DEFAULTS, BASE.lp);
});

test('legs: every money ending pays out exactly what the job holds (P + premium + evaluator fee, + D once accepted)', () => {
  for (let i = 0; i < G.rows; i += 7) {
    const p = G.params[G.param[i]].source;
    const E = BigInt(G.fee[i]) / 2n;
    const q = quoteEconomy({ price: BigInt(G.price[i]), record: { correct: G.correct[i], incorrect: G.incorrect[i] }, lockSeconds: G.lock[i], arbitrator: G.arbitrator[i], coverMultipleBps: G.multiple[i], fee: BigInt(G.fee[i]), evaluatorFee: E }, p);
    const P = BigInt(G.price[i]);
    for (const [end, l] of Object.entries(q.legs)) {
      const held = P + q.premium + E + (end === 'unaccepted' ? 0n : q.deposit) + (end === 'cheated' ? q.coverCap : 0n);
      assert.equal(l.buyer + l.seller + l.backers + l.layer + l.evaluator, held, `row ${i} ${end}`);
      for (const v of Object.values(l)) assert.ok(v >= 0n);
    }
    assert.equal(q.legs.completed.layer, q.toLayer); assert.equal(q.legs.rejected.buyer, P + q.premium + q.compensation);
  }
});
