import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CALIBRATION_DIR, configDrift, contentDigest, legsOf, loadCalibration, priceTable, snapshotInputs, verifyCalibration, type Calibration } from '../src/calibration.ts';
import { FEE_PROFILES, jobFee } from '../src/fee.ts';

// Every calibration this package ships verifies offline: its digest, its config digest, its table recomputed from its own
// snapshot, its buffer = max(history, Monte Carlo), its no-loss check. A hand edit of any number fails here.
const DIR = fileURLToPath(CALIBRATION_DIR);
const files = readdirSync(DIR).filter((f) => /^\d+\.json$/.test(f));
const policy = JSON.parse(readFileSync(new URL('policy.json', CALIBRATION_DIR), 'utf8'));
const chains = JSON.parse(readFileSync(new URL('chains.json', CALIBRATION_DIR), 'utf8'));

test('a calibration ships for every chain in chains.json', () => {
  assert.deepEqual(files.map((f) => f.replace('.json', '')).sort(), Object.keys(chains.chains).sort());
});

for (const f of files) {
  const c = loadCalibration(f.replace('.json', '')) as Calibration;
  test(`${c.name} (${c.chainId}) v${c.version}: verifies offline`, () => {
    assert.deepEqual(verifyCalibration(c), []);
    assert.equal(c.version >= 1, true);
    for (const p of FEE_PROFILES) assert.ok(legsOf(c, p).length > 0);
  });
  test(`${c.name}: the fee block is the owner's policy plus the measured buffer (no number from anywhere else)`, () => {
    const { gasBufferBps, ...rest } = c.fee;
    assert.deepEqual(rest, { ...policy.fee, ...chains.chains[String(c.chainId)].policy });
    assert.equal(gasBufferBps, Math.max(c.history.buffer_bps_history, c.history.buffer_bps_montecarlo));
    assert.equal(c.premium.arbitrator, policy.premium.arbitrator);
    assert.deepEqual(c.table.rows.map((r) => Number(r.price) / 1e6), policy.table.prices);
  });
  test(`${c.name}: a tampered number fails the check, and configDrift names a disagreeing value`, () => {
    const t = structuredClone(c);
    t.fee.gasBufferBps += 100;
    assert.ok(verifyCalibration(t).length > 0);
    const u = structuredClone(c);
    u.table.rows[0]!.fee = '1';
    u.digest = contentDigest(u);
    assert.ok(verifyCalibration(u).some((x) => x.startsWith('table')));
    assert.deepEqual(configDrift(c, { bps: c.fee.bps, gasBufferBps: c.fee.gasBufferBps }), []);
    assert.equal(configDrift(c, { gasBufferBps: c.fee.gasBufferBps + 1 }).length, 1);
  });
  test(`${c.name}: the house never loses (fee ≥ our legs at the quoted gas + margin, at every price served)`, () => {
    for (const p of [50_000n, 100_000n, 250_000n, 500_000n, 1_000_000n, 2_000_000n, 10_000_000n, 100_000_000n]) {
      for (const pr of FEE_PROFILES) {
        const q = jobFee(p, snapshotInputs(c), legsOf(c, pr), c.fee);
        if (q.served) assert.ok(q.fee! >= q.gas.usdc + q.margin && q.fee! <= q.cap);
        else assert.ok(p < q.minPrice);
      }
    }
    void priceTable;
    assert.ok((c.checks.no_loss as { pass: boolean }).pass);
  });
}
