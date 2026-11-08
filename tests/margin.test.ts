import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { marginFee, listPrice, sellerPart, feeOfList, marginTerms, MARGIN_BPS, OWN_FLOOR_UNITS, BPS } from '../src/margin.ts';

// tests/vectors/margin-grid.json: the one truth every copy of the price rule reads (scripts/gen-margin-grid.ts writes it).
const G = JSON.parse(readFileSync(new URL('./vectors/margin-grid.json', import.meta.url), 'utf8'));

test('the grid carries the constants of the rule', () => {
  assert.equal(G.bps, BPS); assert.equal(G.margin_bps, MARGIN_BPS); assert.equal(G.own_floor_units, String(OWN_FLOOR_UNITS));
});

test('marginFee, listPrice, sellerPart and feeOfList equal the grid', () => {
  for (let i = 0; i < G.rows; i++) {
    const u = BigInt(G.units[i]);
    assert.equal(String(marginFee(u)), G.fee[i], `fee row ${i}`);
    assert.equal(String(listPrice(u)), G.list[i], `list row ${i}`);
    assert.equal(String(sellerPart(u)), G.seller_of_list[i], `seller_of_list row ${i}`);
    assert.equal(String(feeOfList(u)), G.fee_of_list[i], `fee_of_list row ${i}`);
  }
});

test('the seller is paid its price: the list round-trips and the fee never falls under 20 %', () => {
  for (let i = 0; i < G.rows; i++) {
    const s = BigInt(G.units[i]); if (s === 0n) continue;
    const l = listPrice(s);
    assert.equal(sellerPart(l), s, `row ${i}`);
    assert.equal(feeOfList(l), marginFee(s), `row ${i}`);
    assert.ok(marginFee(s) * BigInt(BPS) >= s * BigInt(MARGIN_BPS), `row ${i}`);
  }
});

test('the owner’s examples and the live walls (2026-10-24)', () => {
  assert.deepEqual(marginTerms(1_000n), { seller: 1_000n, fee: 200n, list: 1_200n });
  assert.deepEqual(marginTerms(0n), { seller: 0n, fee: 2_000n, list: 2_000n });
  assert.equal(marginFee(1n), 1n);
  for (const [list, seller, fee] of [[1_250n, 1_041n, 209n], [5_000n, 4_166n, 834n], [10_000n, 8_333n, 1_667n], [29_166n, 24_305n, 4_861n]]) {
    assert.equal(sellerPart(list), seller); assert.equal(feeOfList(list), fee);
  }
});

test('a negative or non-bigint amount is refused', () => {
  assert.throws(() => marginFee(-1n), RangeError);
  assert.throws(() => sellerPart(-1n), RangeError);
  assert.throws(() => listPrice(1 as unknown as bigint), RangeError);
});
