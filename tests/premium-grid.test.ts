import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { premium, RATIO_SCALE, Z } from '../src/wilson.ts';

// tests/vectors/premium-grid.json is the one truth TypeScript, Python and Solidity read (solidity/test/WilsonPremium.t.sol).
const P = JSON.parse(readFileSync(new URL('./vectors/premium-grid.json', import.meta.url), 'utf8'));

test('premium grid: shape', () => {
  assert.equal(P.z, Z);
  assert.equal(P.ratio_scale, RATIO_SCALE);
  for (const c of ['incorrect', 'total', 'insurable', 'ratio', 'ratio_e6', 'covered', 'price', 'premium']) assert.equal(P[c].length, P.rows, c);
  assert.ok(P.rows >= 45_451); // every record with total 0..300, plus the grid and the live vectors
});

test('premium grid: TypeScript returns every row to the last bit and unit', () => {
  for (let i = 0; i < P.rows; i++) {
    const total = P.total[i], incorrect = P.incorrect[i];
    const p = premium({ k: total - incorrect, n: total }, { price: P.price[i] });
    if (!P.insurable[i]) {
      assert.equal(p.insurable, false, `row ${i}`);
      assert.equal(incorrect, total, `row ${i}: UNKNOWN only when no job was delivered`);
      continue;
    }
    assert.equal(p.insurable, true, `row ${i}`);
    if (!p.insurable) continue;
    assert.equal(p.ratio, P.ratio[i], `row ${i} ratio`);
    assert.equal(Math.round(p.ratio * RATIO_SCALE), P.ratio_e6[i], `row ${i} ratio_e6`);
    assert.equal(p.covered, P.covered[i], `row ${i} covered`);
    assert.equal(String(p.amount), P.premium[i], `row ${i} premium`);
    assert.equal(p.amount, (BigInt(P.price[i]) * BigInt(P.ratio_e6[i])) / 1_000_000n, `row ${i} premium = floor(price × ratio_e6 / 1e6)`);
  }
});
