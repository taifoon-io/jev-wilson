import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { grade, listing, premium, premiumAmount, wilson, wilsonLower, wilsonUpperFailure, RUBRIC_HASH, RUBRIC_V1, RUBRIC_ASKED, THRESHOLDS_V1, Z } from '../src/wilson.ts';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import type { JevClient } from '../src/wilson.ts';

// compile-time: the official client satisfies the structural type grade() takes
export const _clientFits = (c: TypeSafeClient): JevClient => c;

const load = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const V = load('./vectors.json');
const G = load('./grid.json');

test('z is the layer’s constant, not 1.96', () => {
  assert.equal(Z, 1.959963984540054);
  assert.equal(V.z, Z);
});

for (const v of V.vectors) {
  test(`vector ${v.id}: k=${v.k} n=${v.n} price=${v.price}`, () => {
    const p = premium({ k: v.k, n: v.n }, { price: v.price });
    if (!v.layer.insurable) {
      assert.equal(p.insurable, false);
      assert.equal(v.layer.premium, null);
      assert.equal(v.layer.premium_ratio, null);
      return;
    }
    assert.equal(p.insurable, true);
    assert.equal(p.ratio, v.layer.premium_ratio); // to the last bit
    assert.equal(String(p.amount), v.layer.premium); // to the last unit
    assert.deepEqual(wilson(v.n - v.k, v.n), v.layer.wilson_failure);
    assert.equal(wilsonUpperFailure(v.k, v.n), v.layer.premium_ratio);
  });
}

test('live fixtures are the raw quotes the vectors cite', () => {
  for (const v of V.vectors.filter((x: { fixture?: string }) => x.fixture)) {
    const q = load('../' + v.fixture);
    assert.equal(q.premium, v.layer.premium);
    assert.equal(q.premium_ratio, v.layer.premium_ratio);
    assert.equal(q.record.settled, v.k);
    assert.equal(q.record.settled + q.record.incorrect, v.n);
  }
});

test(`grid: ${G.rows.length} records, interval and premium equal the layer’s bit for bit`, () => {
  for (const [k, n, dl, dh, fl, fh, prem] of G.rows) {
    assert.deepEqual(wilson(k, n), [dl, dh], `wilson(${k},${n})`);
    assert.deepEqual(wilson(n - k, n), [fl, fh], `wilson(${n - k},${n})`);
    if (n > 0) {
      assert.equal(wilsonLower(k, n), dl);
      assert.equal(wilsonUpperFailure(k, n), fh);
    }
    const p = premium({ k, n }, { price: 100000000n });
    if (prem === null) assert.equal(p.insurable, false);
    else assert.equal(String(p.amount), prem, `premium(${k},${n})`);
  }
});

test('the plan’s rows: 0/0 is UNKNOWN, 10/10 is not free, 9/10 costs more than 90/100', () => {
  assert.equal(premium({ k: 0, n: 0 }).insurable, false);
  const ten = premium({ k: 10, n: 10 });
  assert.ok(ten.insurable && ten.ratio > 0.27 && ten.ratio < 0.28);
  const a = premium({ k: 9, n: 10 }), b = premium({ k: 90, n: 100 });
  assert.ok(a.insurable && b.insurable);
  assert.equal(a.ratio, 0.4041500267952385);
  assert.equal(b.ratio, 0.17436566150491348);
  assert.equal(a.covered, false); // above the 0.30 pool rule
  assert.equal(b.covered, true);
});

test('p_L form: 1 - p_L, equal to the record form only up to the last bits', () => {
  const pL = wilsonLower(60, 62);
  const viaPL = premium(pL, { price: 10n ** 19n });
  const viaRecord = premium({ k: 60, n: 62 }, { price: 10n ** 19n });
  assert.ok(viaPL.insurable && viaRecord.insurable);
  assert.ok(Math.abs(viaPL.ratio - viaRecord.ratio) < 1e-15);
  assert.equal(viaPL.basis, 'p_L');
  assert.equal(viaRecord.basis, 'record');
});

test('min floors the ratio, max decides cover', () => {
  const p = premium({ k: 2319, n: 2323 }, { min: 0.01 });
  assert.ok(p.insurable && p.ratio === 0.01 && p.covered);
  const q = premium({ k: 10, n: 10 }, { max: 0.25 });
  assert.ok(q.insurable && !q.covered);
});

test('premiumAmount rounds the ratio to millionths, then floors', () => {
  assert.equal(premiumAmount(10n ** 19n, 0.11020469594985441), 1102050000000000000n);
  assert.equal(premiumAmount(100000000n, 0.0000005), 100n); // Math.round(0.5) = 1, ties go up
  assert.throws(() => premiumAmount(0n, 0.1));
});

test('bad records are refused', () => {
  assert.throws(() => wilsonLower(3, 2));
  assert.throws(() => wilsonLower(-1, 2));
  assert.throws(() => premium({ k: 1.5, n: 2 }));
  assert.throws(() => premium(1.2));
});

test('listing: cheat is a separate flag and does not move the bounds', () => {
  const a = listing(60, 62, { grade_id: 'g1' });
  const b = listing(60, 62, { cheat: true, grade_id: 'g1' });
  assert.equal(a.p_L, b.p_L);
  assert.equal(a.u_F, b.u_F);
  assert.equal(b.cheat, true);
  const schema = load('../schemas/listing.schema.json');
  for (const key of schema.required) assert.ok(key in a, key);
  for (const key of Object.keys(a)) assert.ok(key in schema.properties, key);
});

test('rubric-v1.json is RUBRIC_v1 and hashes to RUBRIC_HASH', () => {
  const r = load('../schemas/rubric-v1.json');
  assert.equal(r.rubric_hash, RUBRIC_HASH);
  assert.deepEqual(r.rubric, RUBRIC_V1);
  assert.deepEqual(r.thresholds, { ...THRESHOLDS_V1 });
  const h = '0x' + createHash('sha256').update(JSON.stringify(RUBRIC_V1)).digest('hex');
  assert.equal(h, RUBRIC_HASH);
  assert.deepEqual(r.asked, RUBRIC_ASKED.map((q) => q.id));
});

test('grade() goes through TypeSafe AI’s own client: POST /v1/systemone, the caller’s key, jev-1.13.0, the full distribution back', async () => {
  let url = '', auth = '', body: { model: string; state: unknown; questions: Record<string, { type: string; instructions: string; criteria: object }> } | null = null;
  const fakeFetch = async (input: string, init?: RequestInit) => {
    url = input; auth = new Headers(init?.headers).get('authorization') ?? ''; body = JSON.parse(String(init?.body));
    const a = (choice: string, yes: number) => ({ type: 'choice', choice, confidence: Math.max(yes, 1 - yes), probabilities: { yes, no: 1 - yes } });
    const answers = { spec_met: a('yes', 0.9), unsupported_claim: a('no', 0.1), ending: { type: 'choice', choice: 'complete', confidence: 0.8, probabilities: { complete: 0.8, reject: 0.1, expire: 0.05, needs_review: 0.05 } }, cheat_shaped: a('yes', 0.6) };
    return new Response(JSON.stringify({ model: body!.model, answers, usage: { input_tokens: 10, output_tokens: 4 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new TypeSafeClient({ apiKey: 'ts-test-key', fetch: fakeFetch, retry: { maxRetries: 0 } });
  const g = await grade({ task: 't', deliverable: 'd' }, { client });
  assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(auth, 'Bearer ts-test-key');
  assert.equal(body!.model, 'jev-1.13.0');
  assert.deepEqual(Object.keys(body!.questions), ['spec_met', 'unsupported_claim', 'ending', 'cheat_shaped']);
  assert.deepEqual(body!.questions.ending, { type: 'choice', instructions: RUBRIC_V1[2].text, criteria: { complete: 'complete', reject: 'reject', expire: 'expire', needs_review: 'needs_review' } });
  assert.equal(g.model, 'jev-1.13.0');
  assert.equal(g.rubric_hash, RUBRIC_HASH);
  assert.deepEqual(g.answers.ending.probabilities, { complete: 0.8, reject: 0.1, expire: 0.05, needs_review: 0.05 });
  assert.equal(g.cheat, true); // cheat_shaped 0.6 >= 0.5, and no premium field moved
});

test('examples/job-accept.json: the next premium and the contrast recompute exactly', () => {
  const ex = load('../examples/job-accept.json');
  for (const row of [ex.next_premium, ex.contrast]) {
    const p = premium({ k: row.k, n: row.n }, { price: row.price });
    assert.ok(p.insurable);
    assert.equal(String(p.amount), row.premium);
    assert.equal(p.ratio, row.u_F);
    assert.equal(p.covered, row.covered);
    assert.equal(wilsonLower(row.k, row.n), row.p_L);
    const q = load('../' + row.fixture);
    assert.equal(q.premium, row.premium);
  }
  const [fund, , complete] = ex.job.money_path;
  const inflow = fund.transfers.reduce((s: bigint, t: { amount: string }) => s + BigInt(t.amount), 0n);
  const outflow = complete.transfers.reduce((s: bigint, t: { amount: string }) => s + BigInt(t.amount), 0n);
  assert.equal(inflow, outflow); // the hook keeps nothing on the accept path
  assert.equal(BigInt(ex.job.price) + BigInt(ex.job.premium_paid), BigInt(fund.transfers[0].amount));
});
