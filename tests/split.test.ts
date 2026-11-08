import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { premiumSplit, noShowComp, economyQuote, MIN_BACKERS_SPLIT_BPS } from '../src/split.ts';

// tests/vectors/split-grid.json: the one truth TypeScript, Python and Solidity read (scripts/gen-split-grid.ts writes it).
const G = JSON.parse(readFileSync(new URL('./vectors/split-grid.json', import.meta.url), 'utf8'));

test('premiumSplit equals the grid, and the legs always sum to the premium', () => {
  for (let i = 0; i < G.split_rows; i++) {
    const r = premiumSplit(BigInt(G.amount[i]), G.split_bps[i]);
    assert.equal(String(r.toBackers), G.to_backers[i], `row ${i}`);
    assert.equal(String(r.toLayer), G.to_layer[i], `row ${i}`);
    assert.equal(r.toBackers + r.toLayer, BigInt(G.amount[i]));
  }
});

test('noShowComp equals the grid, and never pays the buyer more than the deposit', () => {
  for (let i = 0; i < G.comp_rows; i++) {
    const r = noShowComp(BigInt(G.deposit[i]), G.comp_bps[i]);
    assert.equal(String(r.toBuyer), G.to_buyer[i], `row ${i}`);
    assert.equal(String(r.toSeller), G.to_seller[i], `row ${i}`);
    assert.ok(r.toBuyer <= BigInt(G.deposit[i]));
  }
});

test('dust: the layer rounds down (the backers keep it); the compensation rounds down (the seller keeps it)', () => {
  assert.deepEqual(premiumSplit(1n, 8_000), { toBackers: 1n, toLayer: 0n, toBuyer: 0n });
  assert.deepEqual(premiumSplit(3n, 5_000), { toBackers: 2n, toLayer: 1n, toBuyer: 0n });
  assert.deepEqual(noShowComp(3n, 2_500), { toBuyer: 0n, toSeller: 3n });
  assert.deepEqual(noShowComp(5n, 2_500), { toBuyer: 1n, toSeller: 4n });
});

test('a job no pool covered returns its premium to the buyer', () => {
  assert.deepEqual(premiumSplit(100n, 8_000, false), { toBackers: 0n, toLayer: 0n, toBuyer: 100n });
});

test('the hook bounds are refused here too', () => {
  assert.throws(() => premiumSplit(1n, MIN_BACKERS_SPLIT_BPS - 1), RangeError);
  assert.throws(() => premiumSplit(1n, 10_001), RangeError);
  assert.throws(() => noShowComp(1n, 10_001), RangeError);
  assert.throws(() => noShowComp(1n, 2.5), RangeError);
  assert.throws(() => premiumSplit(-1n, 8_000), RangeError);
});

test('economyQuote shows both legs of the premium and the no-show', () => {
  const q = economyQuote({ price: 100_000_000n, premium: 1_000_000n, deposit: 120_000_000n, evaluatorFee: 1_000_000n, splitBps: 8_000, noShowCompBps: 2_500, covered: true });
  assert.deepEqual(q.completed, { toSeller: 220_000_000n, toBackers: 800_000n, toLayer: 200_000n, toBuyer: 0n, toEvaluatorIfItDecided: 1_000_000n });
  assert.deepEqual(q.noShow, { toBuyer: 132_000_000n, toSeller: 90_000_000n, compensation: 30_000_000n });
  assert.deepEqual(q.escrow, { buyer: 102_000_000n, seller: 120_000_000n });
});
