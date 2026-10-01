// Writes tests/vectors/lp-grid.json: lpPremium() over prices, records, lock times, cover multiples and arbitrator on/off.
// TypeScript (tests/lp.test.ts) and Python (tests/test_lp.py) must both return every row to the last bit and unit.
//   node --experimental-strip-types --no-warnings scripts/gen-lp-grid.ts
import { writeFileSync } from 'node:fs';
import { lpPremium, LP_DEFAULTS } from '../src/lp.ts';

const prices = [1, 7, 10_000, 50_000, 123_457, 1_000_000, 10_000_000, 100_000_000];
const records: ([number, number] | null)[] = [null, [0, 0], [1, 0], [3, 0], [9, 0], [0, 1], [0, 5], [30, 1], [70, 2], [34, 15], [12, 46], [138, 0], [2735, 5], [10_000, 3]];
const locks = [0, 60, 3_600, 7_200, 7 * 86_400];
const multiples = [5_000, 10_000, 20_000];
const rows: unknown[][] = [];
for (const price of prices) for (const r of records) for (const lock of locks) for (const m of multiples) for (const arb of [false, true]) {
  const q = lpPremium({ price, record: r ? { correct: r[0], incorrect: r[1] } : null, lockSeconds: lock, arbitrator: arb, coverMultipleBps: m });
  rows.push([price, r ? r[0] : null, r ? r[1] : null, lock, m, arb, q.premium, q.ratio, q.covered, q.rate.mean, q.rate.sd, q.parts.expectedLoss, q.parts.risk, q.parts.capital]);
}
writeFileSync(new URL('../tests/vectors/lp-grid.json', import.meta.url), JSON.stringify({
  params: LP_DEFAULTS,
  cols: ['price', 'correct', 'incorrect', 'lockSeconds', 'coverMultipleBps', 'arbitrator', 'premium', 'ratio', 'covered', 'mean', 'sd', 'expectedLoss', 'risk', 'capital'],
  rows,
}) + '\n');
console.log(`lp-grid: ${rows.length} rows`);
