import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LINE_CALIBRATIONS, loadCalibration, loadLineCalibration, quoteEconomyFor, verifyCalibration, contentDigest } from '../src/calibration.ts';
import { checkBounds, quoteEconomy, lpPremiumUnits } from '../src/economy.ts';

// The GRID line (calibration/grid-3692781.json, from scripts/gen-grid-calibration.ts and calibration/lines/grid.json): a job
// priced, covered and made whole in GRID (18 decimals, $0.01), the fee converted at the peg, the backers at lpYield 1 %.
const grid = loadLineCalibration('grid', 3692781);
const base = loadCalibration(8453);
const G = 10n ** 18n;
const WEEK = 7 * 86_400;

test('the GRID calibration verifies offline and is listed', () => {
  assert.deepEqual(verifyCalibration(grid), []);
  assert.deepEqual(LINE_CALIBRATIONS.grid, [3692781]);
  assert.deepEqual(grid.asset, { symbol: 'GRID', decimals: 18, peg_usd: '0.01', fee_decimals: 20 });
  assert.equal(grid.status, 'provisional');
  assert.equal(grid.legs.provisional_from, 8453);
  assert.equal(grid.lp.lpYield, 0.01);
  assert.equal(grid.lp.opsUnits, base.lp.opsUnits * 1e14);
  for (const k of ['a0', 'b0', 'lambda', 'severity', 'utilization', 'maxRatio'] as const) assert.equal(grid.lp[k], base.lp[k], k);
});

test('a hand edit fails, and the generator is a no-op (--check)', () => {
  const t = structuredClone(grid);
  t.lp.lpYield = 0.02;
  t.digest = contentDigest(t);
  assert.ok(verifyCalibration(t).length > 0, 'config digest');
  const u = structuredClone(grid);
  u.asset!.fee_decimals = 19;
  u.digest = contentDigest(u);
  assert.ok(verifyCalibration(u).some((x) => x.startsWith('asset')));
  execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(new URL('../scripts/gen-grid-calibration.ts', import.meta.url)), '--check']);
});

test('a 1,000 GRID job, record 95/5, an arbitrator, 7 days: covered, toLayer >= F, toBackers > 0, within the GRID bounds', () => {
  const q = quoteEconomyFor(grid, { price: 1_000n * G, record: { correct: 95, incorrect: 5 }, lockSeconds: WEEK, arbitrator: true });
  assert.equal(q.covered, true);
  assert.ok(q.toBackers > 0n && q.toLayer >= q.basis.fee && q.toBackers + q.toLayer === q.premium);
  assert.ok(q.deposit > 1_000n * G && q.compensation <= 1_000n * G);
  assert.equal(checkBounds({ price: 1_000n * G, premium: q.premium, deposit: q.deposit, coverCap: q.coverCap, pool: true, secondsToDeadline: WEEK, toBackers: q.toBackers, toLayer: q.toLayer, compensation: q.compensation },
    { maxPremiumBps: 3_000, minBackersAprBps: 100 }), null);
});

test('no arbitrator: the backers price capital + ops only (no expected loss, no risk loading)', () => {
  const price = 1_000n * G;
  const q = quoteEconomyFor(grid, { price, record: { correct: 95, incorrect: 5 }, lockSeconds: WEEK, arbitrator: false });
  // capital y × C × T / (YEAR × u) + ops, exactly
  const capOps = lpPremiumUnits({ price, record: null, lockSeconds: WEEK, arbitrator: false }, { ...grid.lp, opsUnits: 0 }) + BigInt(grid.lp.opsUnits);
  assert.ok(q.basis.lp === capOps || q.basis.lp === capOps - 1n, `${q.basis.lp} vs ${capOps}`);
  const withArb = quoteEconomyFor(grid, { price, record: { correct: 95, incorrect: 5 }, lockSeconds: WEEK, arbitrator: true });
  assert.ok(withArb.basis.lp > q.basis.lp);
});

test('F on the GRID line = the Base F in USDC units x 1e14, up to the rounding of the finer unit', () => {
  for (const usd of [1n, 10n, 100n, 1_000n]) {
    const b = quoteEconomyFor(base, { price: usd * 1_000_000n, record: null, lockSeconds: 0 });
    const g = quoteEconomyFor(grid, { price: usd * 100n * G, record: null, lockSeconds: 0 });
    const scaled = b.basis.fee * 10n ** 14n;
    assert.ok(g.basis.fee <= scaled && g.basis.fee > scaled - 10n ** 14n, `${usd} USD: ${g.basis.fee} vs ${scaled}`);
    assert.equal(g.served, b.served);
  }
});

test('every amount of a GRID job is in GRID wei: the cover cap is the price, the deposit above it', () => {
  const qg = quoteEconomy({ price: 1_000n * G, record: { correct: 95, incorrect: 5 }, lockSeconds: WEEK, arbitrator: true, fee: 0n }, grid.lp);
  assert.equal(qg.coverCap, 1_000n * G);
  assert.ok(qg.deposit > 1_000n * G);
});
