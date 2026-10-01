import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { jobFee, riseQuantilesBps, windowRises, type GasInputs } from '../src/fee.ts';
import { fitPrior } from '../src/prior.ts';

// tests/vectors/fee-grid.json is the one truth TypeScript and Python read (scripts/gen-fee-grid.ts writes it).
const G = JSON.parse(readFileSync(new URL('./vectors/fee-grid.json', import.meta.url), 'utf8'));
const gasOf = (g: Record<string, any>): GasInputs => ({ ...g, baseFeeWei: BigInt(g.baseFeeWei), tipWei: BigInt(g.tipWei), gasUsd8: BigInt(g.gasUsd8),
  l1FeeWeiByBytes: Object.fromEntries(Object.entries(g.l1FeeWeiByBytes as Record<string, string>).map(([k, v]) => [Number(k), BigInt(v)])) } as GasInputs);
const s = (x: bigint | null) => (x === null ? null : x.toString());

test('fee grid: TypeScript returns every row to the unit', () => {
  for (const [gi, pi, legs, price, served, fee, byBps, floor, cap, minPrice, floored, gasPrice, l2, l1, gasUsdc, bufferBps] of G.rows) {
    const q = jobFee(BigInt(price), gasOf(G.gases[gi]), G.legs[legs], G.policies[pi]);
    assert.deepEqual([q.served, s(q.fee), s(q.byBps), s(q.floor), s(q.cap), s(q.minPrice), q.floored, s(q.gas.gasPrice), s(q.gas.l2), s(q.gas.l1), s(q.gas.usdc), q.gas.bufferBps],
      [served, fee, byBps, floor, cap, minPrice, floored, gasPrice, l2, l1, gasUsdc, bufferBps], `row ${gi}/${pi}/${legs}/${price}`);
  }
});

test('the fee never charges less than our gas plus the margin, and never more than the cap', () => {
  for (const [gi, pi, legs, price] of G.rows) {
    const q = jobFee(BigInt(price), gasOf(G.gases[gi]), G.legs[legs], G.policies[pi]);
    if (!q.served) { assert.ok(q.floor > q.cap); continue; }
    assert.ok(q.fee! >= q.floor && q.fee! <= q.cap);
    assert.ok(jobFee(q.minPrice, gasOf(G.gases[gi]), G.legs[legs], G.policies[pi]).served);
    if (q.minPrice > 1n) assert.ok(!jobFee(q.minPrice - 1n, gasOf(G.gases[gi]), G.legs[legs], G.policies[pi]).served);
  }
});

test('windowRises: the deque equals the definition (max of the next w blocks ÷ now − 1)', () => {
  const naive = (bf: bigint[], w: number) => { const win = Math.max(1, Math.min(w, bf.length - 1)); const out: number[] = []; for (let i = 0; i + win < bf.length; i++) { let m = bf[i]!; for (let k = 1; k <= win; k++) if (bf[i + k]! > m) m = bf[i + k]!; out.push(Number(((m - bf[i]!) * 10_000n) / bf[i]!)); } return out; };
  G.series.forEach((ser: string[]) => { const bf = ser.map(BigInt); for (const w of [1, 2, 5, 13, 40, 1_000]) assert.deepEqual(windowRises(bf, w), naive(bf, w)); });
  for (const [si, w, ...q] of G.rises) assert.deepEqual(riseQuantilesBps(G.series[si].map(BigInt), w, [0.5, 0.9, 0.95, 0.99]), q);
});

test('prior fit: the recorded answer, and Beta(a0, b0) reproduces the sellers it was fitted to', () => {
  const V = JSON.parse(readFileSync(new URL('./vectors/prior-fit.json', import.meta.url), 'utf8'));
  const F = JSON.parse(readFileSync(new URL('./fixtures/sellers-8453.json', import.meta.url), 'utf8'));
  const fit = fitPrior(F.records);
  assert.deepEqual(fit, V.fit);
  assert.ok(fit.mean > fit.pooledRate, 'the per-seller mean sits above the pooled rate: a few sellers fail often');
});
