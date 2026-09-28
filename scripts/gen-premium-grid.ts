// Writes tests/vectors/premium-grid.json from the TypeScript implementation: the one vector file the TypeScript,
// Python and Solidity tests all read.
//   node --experimental-strip-types scripts/gen-premium-grid.ts
// Rows: every record with total 0..300 (incorrect 0..total), every record of tests/grid.json above 300, and every
// record in tests/vectors.json. Each row carries one price from PRICES (cycled, 1 unit .. 1e27) and the TypeScript's
// premium at that price. Columns are parallel arrays so Foundry's vm.parseJson* can read them directly.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { premium, Z, RATIO_SCALE, MAX_PREMIUM_RATIO } from '../src/wilson.ts';

const here = (p: string) => new URL(p, import.meta.url);
const load = (p: string) => JSON.parse(readFileSync(here(p), 'utf8'));

const PRICES = [
  '1', '3', '7', '999', '1000000', '1000001', '99999999', '100000000', '123456789', '1000000000000000000',
  '10000000000000000000', '123456789012345678901', '1000000000000000000000000000', '999999999999999999999999999',
];

const seen = new Set<string>();
const records: [number, number][] = []; // [incorrect, total]
const add = (incorrect: number, total: number) => {
  const key = `${incorrect}/${total}`;
  if (!seen.has(key)) { seen.add(key); records.push([incorrect, total]); }
};
for (let total = 0; total <= 300; total++) for (let incorrect = 0; incorrect <= total; incorrect++) add(incorrect, total);
for (const [k, n] of load('../tests/grid.json').rows as [number, number][]) add(n - k, n);
for (const v of load('../tests/vectors.json').vectors as { k: number; n: number }[]) add(v.n - v.k, v.n);

const cols = { incorrect: [] as number[], total: [] as number[], insurable: [] as boolean[], ratio: [] as (number | null)[], ratio_e6: [] as number[], covered: [] as boolean[], price: [] as string[], premium: [] as string[] };
records.forEach(([incorrect, total], i) => {
  const price = PRICES[i % PRICES.length];
  const p = premium({ k: total - incorrect, n: total }, { price });
  cols.incorrect.push(incorrect);
  cols.total.push(total);
  cols.price.push(price);
  if (!p.insurable) {
    cols.insurable.push(false); cols.ratio.push(null); cols.ratio_e6.push(0); cols.covered.push(false); cols.premium.push('0');
  } else {
    cols.insurable.push(true); cols.ratio.push(p.ratio); cols.ratio_e6.push(Math.round(p.ratio * RATIO_SCALE)); cols.covered.push(p.covered); cols.premium.push(String(p.amount));
  }
});

const out = {
  note: 'wilson-premium-v1, generated from src/wilson.ts by scripts/gen-premium-grid.ts. Row i is column[i] of every array. incorrect of total graded jobs (k = total - incorrect delivered). insurable false = UNKNOWN (no delivered job): ratio null, ratio_e6 0, premium "0". ratio_e6 = Math.round(ratio x 1e6); premium = floor(price x ratio_e6 / 1e6) in the token\'s smallest unit; covered = ratio <= 0.30. TypeScript, Python and Solidity must all return these numbers.',
  z: Z,
  ratio_scale: RATIO_SCALE,
  max_premium_ratio: MAX_PREMIUM_RATIO,
  rows: records.length,
  ...cols,
};
mkdirSync(here('../tests/vectors/'), { recursive: true });
// one column per line keeps the file diffable
const body = Object.entries(out).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n');
writeFileSync(here('../tests/vectors/premium-grid.json'), `{\n${body}\n}\n`);
console.log(`tests/vectors/premium-grid.json: ${records.length} rows`);
