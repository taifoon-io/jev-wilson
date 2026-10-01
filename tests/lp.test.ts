import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lpPremium, lpExpectedMargin, failureRate, LP_DEFAULTS, YEAR_S } from '../src/lp.ts';

// tests/vectors/lp-grid.json is the one truth TypeScript and Python read (scripts/gen-lp-grid.ts writes it).
const G = JSON.parse(readFileSync(new URL('./vectors/lp-grid.json', import.meta.url), 'utf8'));
const rec = (c: number | null, i: number | null) => (c === null ? null : { correct: c, incorrect: i as number });

test('lp grid: TypeScript returns every row to the last bit and unit', () => {
  assert.deepEqual(G.params, { ...LP_DEFAULTS });
  for (const [price, c, i, lock, m, arb, premium, ratio, covered, mean, sd, el, risk, capital] of G.rows) {
    const q = lpPremium({ price, record: rec(c, i), lockSeconds: lock, arbitrator: arb, coverMultipleBps: m });
    assert.equal(q.premium, premium); assert.equal(q.ratio, ratio); assert.equal(q.covered, covered);
    assert.equal(q.rate.mean, mean); assert.equal(q.rate.sd, sd);
    assert.equal(q.parts.expectedLoss, el); assert.equal(q.parts.risk, risk); assert.equal(q.parts.capital, capital);
  }
});

test('no arbitrator: the premium is capital + ops only, whatever the record', () => {
  for (const r of [null, { correct: 0, incorrect: 9 }, { correct: 2735, incorrect: 5 }]) {
    const q = lpPremium({ price: 1_000_000, record: r, lockSeconds: 7_200, arbitrator: false });
    assert.equal(q.parts.expectedLoss, 0); assert.equal(q.parts.risk, 0);
    assert.equal(q.premium, Math.ceil((0.1 * 1_000_000 * 7_200) / (YEAR_S * 0.25) + 100));
  }
});

test('with an arbitrator the backer keeps a positive margin, and a worse record costs more', () => {
  let last = -1;
  for (const f of [0, 1, 2, 5, 10, 20]) {
    const q = lpPremium({ price: 1_000_000, record: { correct: 50, incorrect: f }, lockSeconds: 600, arbitrator: true });
    assert.ok(lpExpectedMargin(q, true) > 0, `margin at f=${f}`);
    assert.ok(q.premium > last, `monotone in failures at f=${f}`); last = q.premium;
  }
  // a longer clean record is cheaper; no record = the prior (the market's average seller)
  const fresh = lpPremium({ price: 1_000_000, record: null, lockSeconds: 600, arbitrator: true });
  const known = lpPremium({ price: 1_000_000, record: { correct: 2735, incorrect: 5 }, lockSeconds: 600, arbitrator: true });
  assert.ok(fresh.premium > 20 * known.premium);
  assert.equal(failureRate(null).mean, LP_DEFAULTS.a0 / (LP_DEFAULTS.a0 + LP_DEFAULTS.b0));
});

test('inputs are checked', () => {
  assert.throws(() => lpPremium({ price: 0, record: null, lockSeconds: 0, arbitrator: true }), /price/);
  assert.throws(() => lpPremium({ price: 1, record: { correct: -1, incorrect: 0 }, lockSeconds: 0, arbitrator: true }), /correct/);
  assert.throws(() => lpPremium({ price: 1, record: null, lockSeconds: 0, arbitrator: true }, { utilization: 0 }), /utilization/);
});
