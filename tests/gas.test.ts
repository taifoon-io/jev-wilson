import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { opsUnitsFromGas, gasCostFromRazor } from '../src/gas.ts';
import { lpPremium } from '../src/lp.ts';

// tests/vectors/gas-ops.json is the one truth TypeScript and Python read.
const G = JSON.parse(readFileSync(new URL('./vectors/gas-ops.json', import.meta.url), 'utf8'));

test('gas vectors: TypeScript returns every row to the unit', () => {
  for (const [amount, decimals, usd8, jobs, tokenDecimals, want] of G.rows) {
    assert.equal(opsUnitsFromGas({ amount, decimals, usd8 }, jobs, tokenDecimals), want);
  }
});

test('a razor quote prices the backers’ gas into the premium', () => {
  const q = { quote: { total_wei: '746588449090620' }, reading: { native: { decimals: 18, usd8: '267866729079' } } };
  const ops = opsUnitsFromGas(gasCostFromRazor(q), 1);
  assert.equal(ops, G.rows[0][5]);
  const p = lpPremium({ price: 1_000_000, record: null, lockSeconds: 7_200, arbitrator: false }, { opsUnits: ops });
  assert.equal(p.parts.ops, ops);
  const sol = { quote: { total_lamports: '5000' }, reading: { native: { decimals: 9, usd8: '11735808417' } } };
  assert.equal(gasCostFromRazor(sol).amount, '5000');
});

test('bad input is refused, never priced', () => {
  assert.throws(() => opsUnitsFromGas({ amount: '1', decimals: 18, usd8: '1' }, 0), /jobsPerDeposit/);
  assert.throws(() => opsUnitsFromGas({ amount: '-1', decimals: 18, usd8: '1' }, 1), /amount/);
  assert.throws(() => opsUnitsFromGas({ amount: '1', decimals: 99, usd8: '1' }, 1), /decimals/);
  assert.throws(() => opsUnitsFromGas({ amount: '1' + '0'.repeat(40), decimals: 0, usd8: '1' }, 1), /2\^53/);
  assert.throws(() => gasCostFromRazor({ quote: {}, reading: { native: { decimals: 18, usd8: '1' } } }), /total_wei/);
  assert.throws(() => gasCostFromRazor({ quote: { total_wei: '1' }, reading: { native: { decimals: 18, usd8: null } } }), /USD/);
});
