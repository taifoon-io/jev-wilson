// node --experimental-strip-types scripts/gen-margin-grid.ts  →  tests/vectors/margin-grid.json (TS, Python, Solidity and every
// other copy of the price rule read it)
import { writeFileSync } from 'node:fs';
import { marginFee, listPrice, sellerPart, feeOfList, MARGIN_BPS, OWN_FLOOR_UNITS, BPS } from '../src/margin.ts';

const amounts = [0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n, 9n, 10n, 99n, 100n, 101n, 221n, 1_000n, 1_041n, 1_200n, 1_250n, 2_000n, 4_166n,
  5_000n, 8_000n, 8_333n, 9_999n, 10_000n, 10_001n, 12_345n, 24_305n, 29_166n, 1_000_000n, 10n ** 6n + 1n, 2n ** 53n - 1n,
  10n ** 18n - 1n, 10n ** 18n, 123_456_789_012_345_678_901n, 10n ** 27n, 2n ** 128n - 1n];
let seed = 0x5eedn;
const rnd = () => (seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n);
for (let i = 0; i < 60; i++) amounts.push(rnd() % 1_000_000_000n);
for (let i = 0; i < 60; i++) amounts.push(rnd() * rnd() % 10n ** 27n);
// one input column, units: read as a seller price (fee, list) and as a market-set list price (seller_of_list, fee_of_list)
const g = { units: [] as string[], fee: [] as string[], list: [] as string[], seller_of_list: [] as string[], fee_of_list: [] as string[] };
for (const a of amounts) {
  g.units.push(String(a)); g.fee.push(String(marginFee(a))); g.list.push(String(listPrice(a)));
  g.seller_of_list.push(String(sellerPart(a))); g.fee_of_list.push(String(feeOfList(a)));
}
writeFileSync(new URL('../tests/vectors/margin-grid.json', import.meta.url), JSON.stringify({
  v: 'jev-wilson.margin-grid.v1', rule: '_MARGIN_OVER_SELLER_v1_', bps: BPS, margin_bps: MARGIN_BPS, own_floor_units: String(OWN_FLOOR_UNITS),
  rows: amounts.length, ...g,
}) + '\n');
console.log(`margin ${amounts.length} rows`);
