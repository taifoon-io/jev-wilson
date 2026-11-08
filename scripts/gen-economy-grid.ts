// node --experimental-strip-types scripts/gen-economy-grid.ts  →  tests/vectors/economy-grid.json
// Every expected value is computed by src/economy.ts quoteEconomy (never typed by hand); TypeScript, Python
// (tests/test_economy.py) and Solidity (solidity/test/EconomyQuote.t.sol) must return the same units on every row.
import { readFileSync, writeFileSync } from 'node:fs';
import { quoteEconomy, ECONOMY_VERSION, maxRatioE6Of } from '../src/economy.ts';
import { LP_DEFAULTS, type LpParams } from '../src/lp.ts';

/** A calibration decimal as the exact WAD integer of its shortest decimal form (0.1666 → 166600000000000000). */
export function wad(x: number): string {
  if (!(x >= 0) || !Number.isFinite(x)) throw new RangeError(`wad: ${x}`);
  const s = String(x);
  if (/e/i.test(s)) throw new RangeError(`wad: exponent form ${s}`);
  const [i, f = ''] = s.split('.');
  if (f.length > 18) throw new RangeError(`wad: more than 18 decimals ${s}`);
  return (BigInt(i!) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18))).toString();
}

const chains = [8453, 42161, 5042, 4663, 143];
const paramSets: LpParams[] = [{ ...LP_DEFAULTS }];
const same = (a: LpParams, b: LpParams) => JSON.stringify(a) === JSON.stringify(b);
let baseIdx = -1;
for (const c of chains) {
  const cal = JSON.parse(readFileSync(new URL(`../calibration/${c}.json`, import.meta.url), 'utf8'));
  let i = paramSets.findIndex((p) => same(p, cal.lp));
  if (i < 0) i = paramSets.push(cal.lp) - 1;
  if (c === 8453) baseIdx = i;
}
// a few off-default parameter sets, so the Solidity fixed point is checked away from the fitted prior too
paramSets.push({ a0: 1, b0: 1, lambda: 0, severity: 1, lpYield: 0.05, utilization: 1, opsUnits: 0, maxRatio: 0.5 });
paramSets.push({ a0: 0.5, b0: 3.25, lambda: 3, severity: 0.4, lpYield: 0.2, utilization: 0.1, opsUnits: 2500, maxRatio: 0.15 });

const records: ([number, number] | null)[] = [null, [0, 0], [0, 1], [0, 5], [1, 0], [19, 1], [95, 5], [950, 50], [9_500, 500],
  [30, 1], [70, 2], [2_735, 5], [11, 0], [100, 0], [10_000, 0], [1, 1], [3, 7], [500, 500], [999_999, 1], [123_456, 7_890]];
const prices = [1n, 7n, 100n, 9_999n, 10_000n, 158_640n, 1_000_000n, 10_000_000n, 100_000_000n, 123_456_789n, 10n ** 12n, 2n ** 53n - 1n, 10n ** 24n, 10n ** 30n];
const locks = [0, 1, 4_200, 86_400, 604_800, 31_536_000];
const multiples = [10_000, 15_000, 20_000];
const fees = [0n, 1n, 15_864n, 49_000n, 490_000n];

let seed = 0xec0n;
const rnd = (m: number) => Number((seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n) % BigInt(m));

const g = {
  price: [] as string[], correct: [] as number[], incorrect: [] as number[], lock: [] as number[], arbitrator: [] as boolean[],
  multiple: [] as number[], fee: [] as string[], param: [] as number[],
  insurable: [] as boolean[], covered: [] as boolean[], premium: [] as string[], to_backers: [] as string[], to_layer: [] as string[],
  deposit: [] as string[], compensation: [] as string[], cover_cap: [] as string[], ratio_e6: [] as number[], wilson: [] as string[],
  lp: [] as string[], priced: [] as string[], ub_loss_on_cap: [] as string[],
};

function row(price: bigint, rec: [number, number] | null, lock: number, arb: boolean, m: number, fee: bigint, pi: number) {
  const p = paramSets[pi]!;
  const record = rec ? { correct: rec[0], incorrect: rec[1] } : null;
  const q = quoteEconomy({ price, record, lockSeconds: lock, arbitrator: arb, coverMultipleBps: m, fee }, p);
  g.price.push(String(price)); g.correct.push(rec ? rec[0] : 0); g.incorrect.push(rec ? rec[1] : 0); g.lock.push(lock);
  g.arbitrator.push(arb); g.multiple.push(m); g.fee.push(String(fee)); g.param.push(pi);
  g.insurable.push(q.insurable); g.covered.push(q.covered); g.premium.push(String(q.premium)); g.to_backers.push(String(q.toBackers));
  g.to_layer.push(String(q.toLayer)); g.deposit.push(String(q.deposit)); g.compensation.push(String(q.compensation));
  g.cover_cap.push(String(q.coverCap)); g.ratio_e6.push(q.basis.ratioE6); g.wilson.push(String(q.basis.wilson));
  g.lp.push(String(q.basis.lp)); g.priced.push(String(q.basis.priced)); g.ub_loss_on_cap.push(String(q.basis.ubLossOnCap));
}

// 1. the structured core: every record × every price × both arbitrator settings, on the Base parameters, at the calibration
//    lock (4,200 s), 7 days and 0, cover 1×, fee 0 and 49,000
for (const rec of records) for (const price of prices) for (const arb of [false, true]) for (const lock of [0, 4_200, 604_800])
  for (const fee of [0n, 49_000n]) row(price, rec, lock, arb, 10_000, fee, baseIdx);
// 2. seeded random rows over every axis and every parameter set
for (let i = 0; i < 12_000; i++) {
  const rec: [number, number] | null = rnd(10) === 0 ? records[rnd(records.length)]! : [rnd(5) === 0 ? 0 : rnd(20_000), rnd(3) === 0 ? 0 : rnd(2_000)];
  const price = rnd(4) === 0 ? prices[rnd(prices.length)]! : BigInt(1 + rnd(1_000_000_000));
  row(price, rec, rnd(3) === 0 ? locks[rnd(locks.length)]! : rnd(40_000_000), rnd(2) === 0, multiples[rnd(multiples.length)]!,
    rnd(3) === 0 ? fees[rnd(fees.length)]! : BigInt(rnd(1_000_000)), rnd(paramSets.length));
}

const params = paramSets.map((p) => ({
  a0: wad(p.a0), b0: wad(p.b0), lambda: wad(p.lambda), severity: wad(p.severity), lpYield: wad(p.lpYield),
  utilization: wad(p.utilization), opsUnits: String(p.opsUnits), maxRatioE6: maxRatioE6Of(p), source: p,
}));
writeFileSync(new URL('../tests/vectors/economy-grid.json', import.meta.url),
  JSON.stringify({ v: `${ECONOMY_VERSION}.grid`, generated_by: 'scripts/gen-economy-grid.ts', rows: g.price.length, params, ...g }) + '\n');
console.log(`economy grid: ${g.price.length} rows, ${params.length} parameter sets, covered ${g.covered.filter(Boolean).length}`);
