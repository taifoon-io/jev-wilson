// node --experimental-strip-types scripts/gen-grid-calibration.ts [--check]
//   → calibration/grid-3692781.json          the GRID line's calibration (quoteEconomyFor prices a GRID job from it)
//   → tests/vectors/economy-grid-line.json  quoteEconomy on the GRID line's parameters, for the Python and Solidity twins
// Every number is computed (never typed by hand): the choices come from calibration/lines/grid.json, every measured input
// from the source chain's calibration (calibration/<borrowed_from>.json), the table and digests from src/calibration.ts.
// --check writes nothing and exits 1 when either file differs from what this script would write.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { CALIBRATION_SCHEMA, configDigest, contentDigest, loadCalibration, priceTable, quoteEconomyFor, verifyCalibration, type Calibration } from '../src/calibration.ts';
import { quoteEconomy, ECONOMY_VERSION, maxRatioE6Of, wad } from '../src/economy.ts';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const pol = JSON.parse(readFileSync(new URL('../calibration/lines/grid.json', import.meta.url), 'utf8'));
const src = loadCalibration(pol.borrowed_from) as Calibration;

const feeDecimals = pol.asset.decimals + Math.round(Math.log10(1 / Number(pol.asset.peg_usd)));
const lp = Object.fromEntries(pol.lp.from_source.map((k: string) => [k, (src.lp as Record<string, number>)[k]]));
const opsUnits = BigInt(src.lp.opsUnits) * BigInt(pol.lp.opsUnitsScale);
if (opsUnits > BigInt(Number.MAX_SAFE_INTEGER) * 2n ** 10n || BigInt(Number(opsUnits)) !== opsUnits) throw new Error(`opsUnits ${opsUnits} is not an exact double`);

const cal = {
  schema: CALIBRATION_SCHEMA,
  chainId: pol.chainId,
  name: pol.name,
  version: pol.version,
  status: 'provisional',
  generated_at: `${pol.decided}T00:00:00.000Z`,
  library: `${pkg.name}@${pkg.version}`,
  fee: src.fee,
  legs: { ...src.legs, status: 'provisional', provisional_from: src.chainId, source: `${src.name} (${src.chainId}) calibration v${src.version}, borrowed as-is until the line's own receipts exist: ${src.legs.source}` },
  lp: { a0: lp.a0, b0: lp.b0, lambda: lp.lambda, severity: lp.severity, lpYield: pol.lp.lpYield, utilization: lp.utilization, opsUnits: Number(opsUnits), maxRatio: lp.maxRatio },
  premium: src.premium,
  chain: src.chain,
  history: src.history,
  prior: src.prior,
  gas_snapshot: src.gas_snapshot,
  checks: {
    no_loss: { ...src.checks.no_loss, borrowed_from: src.chainId, note: 'the fee converts to GRID at the peg (fee_decimals), so the source chain\'s no-loss check in USD holds unit for unit' },
    backer: { note: `not run for the GRID line: the backers' Monte Carlo is the source chain's in USDC at lpYield ${src.lp.lpYield}; the GRID line's backers price at lpYield ${pol.lp.lpYield} (calibration/lines/grid.json)` },
  },
  table: null as unknown as Calibration['table'],
  asset: { symbol: pol.asset.symbol, decimals: pol.asset.decimals, peg_usd: pol.asset.peg_usd, fee_decimals: feeDecimals },
  line: { key: pol.line, chainId: pol.chainId, borrowed_from: src.chainId, generated_by: 'scripts/gen-grid-calibration.ts', policy: 'calibration/lines/grid.json', readiness: pol.readiness },
  config_digest: '',
  digest: '',
} as unknown as Calibration;
cal.table = priceTable(cal, pol.table.prices, pol.table.profile);
cal.config_digest = configDigest(cal);
cal.digest = contentDigest(cal);
const bad = verifyCalibration(cal);
if (bad.length) throw new Error(`the GRID calibration does not verify:\n${bad.join('\n')}`);
const calText = JSON.stringify(cal, null, 1) + '\n';

// the vectors: quoteEconomy on the line's parameters, F from the line's calibration at each price
const P = 10n ** BigInt(pol.asset.decimals);
const prices = [P, 10n * P, 100n * P, 1_000n * P, 10_000n * P, 100_000n * P, 123_456_789n * 10n ** 12n];
const records: ([number, number] | null)[] = [null, [0, 3], [1, 0], [19, 1], [95, 5], [950, 50], [30, 1], [2_735, 5], [100, 0], [3, 7]];
const locks = [0, 660, 4_200, 604_800];
const g = {
  price: [] as string[], correct: [] as number[], incorrect: [] as number[], lock: [] as number[], arbitrator: [] as boolean[],
  multiple: [] as number[], fee: [] as string[], param: [] as number[],
  insurable: [] as boolean[], covered: [] as boolean[], premium: [] as string[], to_backers: [] as string[], to_layer: [] as string[],
  deposit: [] as string[], compensation: [] as string[], cover_cap: [] as string[], ratio_e6: [] as number[], wilson: [] as string[],
  lp: [] as string[], priced: [] as string[], ub_loss_on_cap: [] as string[],
};
for (const price of prices) {
  const fee = quoteEconomyFor(cal, { price, record: null, lockSeconds: 0, arbitrator: false }).basis.fee;
  for (const rec of records) for (const arb of [false, true]) for (const lock of locks) {
    const record = rec ? { correct: rec[0], incorrect: rec[1] } : null;
    const q = quoteEconomy({ price, record, lockSeconds: lock, arbitrator: arb, coverMultipleBps: 10_000, fee }, cal.lp);
    g.price.push(String(price)); g.correct.push(rec ? rec[0] : 0); g.incorrect.push(rec ? rec[1] : 0); g.lock.push(lock);
    g.arbitrator.push(arb); g.multiple.push(10_000); g.fee.push(String(fee)); g.param.push(0);
    g.insurable.push(q.insurable); g.covered.push(q.covered); g.premium.push(String(q.premium)); g.to_backers.push(String(q.toBackers));
    g.to_layer.push(String(q.toLayer)); g.deposit.push(String(q.deposit)); g.compensation.push(String(q.compensation));
    g.cover_cap.push(String(q.coverCap)); g.ratio_e6.push(q.basis.ratioE6); g.wilson.push(String(q.basis.wilson));
    g.lp.push(String(q.basis.lp)); g.priced.push(String(q.basis.priced)); g.ub_loss_on_cap.push(String(q.basis.ubLossOnCap));
  }
}
const l = cal.lp;
const params = [{ a0: String(wad(l.a0)), b0: String(wad(l.b0)), lambda: String(wad(l.lambda)), severity: String(wad(l.severity)),
  lpYield: String(wad(l.lpYield)), utilization: String(wad(l.utilization)), opsUnits: String(opsUnits), maxRatioE6: maxRatioE6Of(l), source: l }];
const vecText = JSON.stringify({ v: `${ECONOMY_VERSION}.grid-line`, generated_by: 'scripts/gen-grid-calibration.ts', line: pol.line, calibration_digest: cal.digest, rows: g.price.length, params, ...g }) + '\n';

const CAL = new URL(`../calibration/${pol.line}-${pol.chainId}.json`, import.meta.url);
const VEC = new URL('../tests/vectors/economy-grid-line.json', import.meta.url);
if (process.argv.includes('--check')) {
  const drift = [[CAL, calText], [VEC, vecText]].filter(([f, t]) => !existsSync(f as URL) || readFileSync(f as URL, 'utf8') !== t).map(([f]) => String(f));
  if (drift.length) { console.error(`differs from scripts/gen-grid-calibration.ts: ${drift.join(', ')}`); process.exit(1); }
  console.log(`GRID line calibration and vectors equal the generator (digest ${cal.digest})`);
} else {
  writeFileSync(CAL, calText);
  writeFileSync(VEC, vecText);
  console.log(`GRID line: calibration digest ${cal.digest}; vectors ${g.price.length} rows, covered ${g.covered.filter(Boolean).length}`);
}
