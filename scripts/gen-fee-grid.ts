// Writes tests/vectors/fee-grid.json and tests/vectors/prior-fit.json: jobFee() over prices, gas inputs, policies and leg
// sets, windowRises() over base-fee series, and fitPrior() on a recorded set of seller records. TypeScript (tests/fee.test.ts)
// and Python (tests/test_fee.py) must return every fee row to the unit; the prior fit agrees to 1e-6.
//   node --experimental-strip-types --no-warnings scripts/gen-fee-grid.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { jobFee, riseQuantilesBps, x402Fee, type FeePolicy, type GasInputs, type Leg } from '../src/fee.ts';
import { fitPrior } from '../src/prior.ts';

const legsFile = JSON.parse(readFileSync(new URL('../calibration/legs/8453.json', import.meta.url), 'utf8')) as { legs: (Leg & { profiles: string[] })[] };
const legSets: Record<string, Leg[]> = Object.fromEntries(['direct', 'stand-in', 'relayed'].map((p) => [p, legsFile.legs.filter((l) => l.profiles.includes(p)).map(({ leg, who, gas, bytes }) => ({ leg, who, gas, bytes }))]));
const sizes = [...new Set(legsFile.legs.map((l) => l.bytes))];
const l1 = (k: number) => Object.fromEntries(sizes.map((b) => [b, BigInt(Math.round(k * b))]));
const gases: GasInputs[] = [
  { chainId: 8453, block: 1, baseFeeWei: 5_000_000n, tipWei: 1_100_000n, liveBufferBps: 0, l1FeeWeiByBytes: l1(8.9e6), gasUsd8: 269_348_000_000n },
  { chainId: 8453, block: 2, baseFeeWei: 9_460_924n, tipWei: 2_498_148n, liveBufferBps: 8_921, l1FeeWeiByBytes: l1(1.3e7), gasUsd8: 410_000_000_000n },
  { chainId: 42161, block: 3, baseFeeWei: 20_010_000n, tipWei: 0n, liveBufferBps: 376, l1FeeWeiByBytes: Object.fromEntries(sizes.map((b) => [b, 3_865_612_800n + 27_611_520n * BigInt(b)])), gasUsd8: 267_832_000_000n },
  { chainId: 5042, block: 4, baseFeeWei: 20_000_000_000n, tipWei: 1_000_000_000n, liveBufferBps: 0, l1FeeWeiByBytes: {}, gasUsd8: 100_000_000n },
  { chainId: 4663, block: 5, baseFeeWei: 20_052_000n, tipWei: 0n, liveBufferBps: 424, l1FeeWeiByBytes: Object.fromEntries(sizes.map((b) => [b, 0n])), gasUsd8: 267_832_000_000n },
  // Monad: base fee 100 gwei, tip 8 gwei (p75 median), no L1 fee, MON at 0.03176508 USD (Chainlink MON / USD, 2026-10-01)
  { chainId: 143, block: 6, baseFeeWei: 100_000_000_000n, tipWei: 8_000_000_000n, liveBufferBps: 0, l1FeeWeiByBytes: {}, gasUsd8: 3_176_508n },
];
const base: FeePolicy = { bps: 49, marginUsdc: 0.002, gasBufferBps: 1_900, ethMoveBps: 300, quoteTtlS: 300, settleHorizonS: 3_600, tipPercentile: 75, maxPriceAgeS: 3_600, capBps: 1_000 };
const policies: FeePolicy[] = [base, { ...base, bps: 0, marginUsdc: 0 }, { ...base, gasBufferBps: 0, ethMoveBps: 0 }, { ...base, bps: 100, marginUsdc: 0.01, capBps: 500 }];
const prices = [1n, 49n, 10_000n, 50_000n, 80_731n, 160_780n, 250_000n, 1_000_000n, 3_280_000n, 10_000_000n, 100_000_000n, 123_456_789_012n];
const rows: unknown[][] = [];
const s = (x: bigint | null) => (x === null ? null : x.toString());
gases.forEach((g, gi) => policies.forEach((p, pi) => Object.entries(legSets).forEach(([name, legs]) => prices.forEach((price) => {
  const q = jobFee(price, g, legs, p);
  rows.push([gi, pi, name, s(price), q.served, s(q.fee), s(q.byBps), s(q.floor), s(q.cap), s(q.minPrice), q.floored, s(q.gas.gasPrice), s(q.gas.l2), s(q.gas.l1), s(q.gas.usdc), q.gas.bufferBps]);
}))));
// the x402 buyer leg (no settle line): fee = max(bps, our gas + margin); our gas 0 on exact, and a few non-zero values
const x402Prices = [1n, 2_000n, 10_000n, 40_816n, 100_000n, 408_163n, 1_000_000n, 10_000_000n, 123_456_789_012n];
const x402Rows: unknown[][] = [];
policies.forEach((p, pi) => [0n, 1n, 1_234n].forEach((g) => x402Prices.forEach((price) => {
  const q = x402Fee(price, p, g);
  x402Rows.push([pi, s(g), s(price), s(q.fee), s(q.byBps), s(q.floor), q.floored, q.shareBps]);
})));
const ser = (g: GasInputs) => ({ ...g, baseFeeWei: g.baseFeeWei.toString(), tipWei: g.tipWei.toString(), gasUsd8: g.gasUsd8.toString(), l1FeeWeiByBytes: Object.fromEntries(Object.entries(g.l1FeeWeiByBytes).map(([k, v]) => [k, v.toString()])) });

// base-fee series: flat, a spike, a ramp, a sawtooth, a pseudo-random walk
let seed = 11; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const series: bigint[][] = [
  Array.from({ length: 50 }, () => 5_000_000n),
  Array.from({ length: 60 }, (_, i) => (i === 30 ? 9_460_924n : 5_000_000n)),
  Array.from({ length: 80 }, (_, i) => 5_000_000n + BigInt(i) * 37_111n),
  Array.from({ length: 90 }, (_, i) => 5_000_000n + BigInt(i % 7) * 400_003n),
  (() => { let x = 20_000_000; return Array.from({ length: 200 }, () => BigInt(Math.max(1, (x = Math.round(x * (0.97 + 0.07 * rnd())))))); })(),
];
const rises = series.flatMap((bf, si) => [1, 5, 13, 40, 1_000].map((w) => [si, w, ...riseQuantilesBps(bf, w, [0.5, 0.9, 0.95, 0.99])]));

writeFileSync(new URL('../tests/vectors/fee-grid.json', import.meta.url), JSON.stringify({
  gases: gases.map(ser), policies, legs: legSets,
  cols: ['gas', 'policy', 'legs', 'price', 'served', 'fee', 'byBps', 'floor', 'cap', 'minPrice', 'floored', 'gasPrice', 'l2', 'l1', 'gasUsdc', 'bufferBps'],
  rows,
  x402_cols: ['policy', 'ourGas', 'price', 'fee', 'byBps', 'floor', 'floored', 'shareBps'], x402: x402Rows,
  series: series.map((x) => x.map(String)), rise_cols: ['series', 'w', 'p50', 'p90', 'p95', 'p99'], rises,
}) + '\n');

const sellers = JSON.parse(readFileSync(new URL('../tests/fixtures/sellers-8453.json', import.meta.url), 'utf8')) as { records: { correct: number; incorrect: number }[] };
writeFileSync(new URL('../tests/vectors/prior-fit.json', import.meta.url), JSON.stringify({ fixture: 'tests/fixtures/sellers-8453.json', fit: fitPrior(sellers.records) }, null, 1) + '\n');
console.log(`fee-grid: ${rows.length} rows, ${x402Rows.length} x402 rows, ${rises.length} rise rows; prior-fit on ${sellers.records.length} records`);
