// node --experimental-strip-types scripts/gen-split-grid.ts  →  tests/vectors/split-grid.json (TS, Python, Solidity read it)
import { writeFileSync } from 'node:fs';
import { premiumSplit, noShowComp, MIN_BACKERS_SPLIT_BPS, BPS } from '../src/split.ts';

const amounts = [0n, 1n, 2n, 3n, 9n, 10n, 99n, 100n, 101n, 9_999n, 10_000n, 10_001n, 12_345n, 1_000_000n, 10n ** 6n + 1n,
  10n ** 18n - 1n, 10n ** 18n, 123_456_789_012_345_678_901n, 10n ** 27n, 2n ** 128n - 1n];
let seed = 0x5eedn;
const rnd = () => (seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n);
for (let i = 0; i < 80; i++) amounts.push(rnd() * rnd() % 10n ** 27n);
const splits = [MIN_BACKERS_SPLIT_BPS, 5_001, 6_000, 7_000, 7_500, 8_000, 8_500, 9_000, 9_500, 9_999, BPS];
const comps = [0, 1, 100, 1_000, 2_500, 5_000, 7_500, 9_999, BPS];
const s = { amount: [] as string[], split_bps: [] as number[], to_backers: [] as string[], to_layer: [] as string[] };
for (const a of amounts) for (const b of splits) { const l = premiumSplit(a, b); s.amount.push(String(a)); s.split_bps.push(b); s.to_backers.push(String(l.toBackers)); s.to_layer.push(String(l.toLayer)); }
const c = { deposit: [] as string[], comp_bps: [] as number[], to_buyer: [] as string[], to_seller: [] as string[] };
for (const a of amounts) for (const b of comps) { const l = noShowComp(a, b); c.deposit.push(String(a)); c.comp_bps.push(b); c.to_buyer.push(String(l.toBuyer)); c.to_seller.push(String(l.toSeller)); }
writeFileSync(new URL('../tests/vectors/split-grid.json', import.meta.url), JSON.stringify({ v: 'jev-wilson.split-grid.v1', split_rows: s.amount.length, ...s, comp_rows: c.deposit.length, ...c }) + '\n');
console.log(`split ${s.amount.length} rows, comp ${c.deposit.length} rows`);
