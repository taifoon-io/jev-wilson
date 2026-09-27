// jev-wilson: a Wilson bound on a seller's record, mapped to a coverage premium.
//
// Bit-for-bit with the Taifoon coordination layer (coordination-premium.ts + pool-quote.ts):
//   interval   the 95% Wilson score interval, no continuity correction, clamped to [0, 1]
//   z          1.959963984540054 (the layer's constant), not 1.96
//   π ratio    the UPPER bound on the failure rate = wilson(n - k, n)[1]
//   π amount   floor(price × round(ratio × 1e6) / 1e6), integer arithmetic on the token's smallest unit
//   UNKNOWN    no delivered job (k = 0) means no rate to price: not insurable
//   cover      only when π ÷ P ≤ 0.30
//
// Jev grades the job. This file prices the next premium. Jev does not set π.

export { RUBRIC_V1, RUBRIC_ASKED, RUBRIC_HASH, RUBRIC_VERSION, THRESHOLDS_V1 } from './rubric.ts';
export type { RubricQuestion } from './rubric.ts';
import { RUBRIC_ASKED, RUBRIC_HASH, RUBRIC_VERSION, THRESHOLDS_V1 } from './rubric.ts';
import type { RubricQuestion } from './rubric.ts';

/** z for a two-sided 95% interval, as the layer pins it. */
export const Z = 1.959963984540054;
/** The layer's pool rule: no pool covers above this premium ratio. */
export const MAX_PREMIUM_RATIO = 0.3;
/** The premium ratio is rounded to millionths before it multiplies the price. */
export const RATIO_SCALE = 1_000_000;
/** The Jev model the examples pin. */
export const JEV_MODEL = 'jev-1.13.0';

function checkRecord(k: number, n: number): void {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n < 0 || k > n) {
    throw new RangeError(`need integers 0 <= k <= n, got k=${k}, n=${n}`);
  }
}

/** The Wilson score interval for `successes` of `n`. [0, 1] when n = 0. Same operations, same order as the layer. */
export function wilson(successes: number, n: number, z: number = Z): [number, number] {
  if (n <= 0) return [0, 1];
  const p = successes / n, z2 = z * z;
  const d = 1 + z2 / n;
  const c = p + z2 / (2 * n);
  const s = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
}

/** p_L: the lower Wilson bound on the delivered rate, k delivered of n graded. */
export function wilsonLower(k: number, n: number, z: number = Z): number {
  checkRecord(k, n);
  return wilson(k, n, z)[0];
}

/** u_F: the upper Wilson bound on the failure rate, n - k failed of n. This is the layer's π ratio. */
export function wilsonUpperFailure(k: number, n: number, z: number = Z): number {
  checkRecord(k, n);
  return wilson(n - k, n, z)[1];
}

/** JavaScript Math.round, kept explicit so the Python twin can match it. */
const roundHalfUp = (x: number): number => Math.round(x);

/** floor(price × round(ratio × 1e6) / 1e6), exactly as the layer's pool-quote computes it. */
export function premiumAmount(price: bigint, ratio: number): bigint {
  if (price <= 0n) throw new RangeError('price must be a positive integer in the token’s smallest unit');
  return (price * BigInt(roundHalfUp(ratio * RATIO_SCALE))) / BigInt(RATIO_SCALE);
}

export type SellerRecord = { k: number; n: number };
export type PremiumOpts = {
  /** floor on the ratio; default 0 (the layer has none) */
  min?: number;
  /** cover only when ratio <= max; default 0.30 (the layer's pool rule) */
  max?: number;
  /** price in the token's smallest unit; when given, `amount` is computed */
  price?: bigint | number | string;
  /** z for the record form; default Z */
  z?: number;
};
export type Premium =
  | { insurable: false; reason: 'UNKNOWN'; ratio: null; amount: null; covered: false; basis: 'record' }
  | { insurable: true; ratio: number; amount: bigint | null; covered: boolean; basis: 'record' | 'p_L' };

/**
 * The premium for the next job.
 *
 * premium({ k, n }, opts)  prices from the record: ratio = u_F, bit-for-bit with the layer.
 * premium(pL, opts)        prices from a lower bound you already hold: ratio = 1 - p_L. Equal in real
 *                          arithmetic, but 1 - p_L can differ from u_F in the last bits of a double.
 *                          Use the record form when you need the layer's number to the last digit.
 */
export function premium(input: number | SellerRecord, opts: PremiumOpts = {}): Premium {
  const min = opts.min ?? 0;
  const max = opts.max ?? MAX_PREMIUM_RATIO;
  let raw: number;
  let basis: 'record' | 'p_L';
  if (typeof input === 'number') {
    if (!(input >= 0 && input <= 1)) throw new RangeError(`p_L must be in [0, 1], got ${input}`);
    raw = 1 - input;
    basis = 'p_L';
  } else {
    checkRecord(input.k, input.n);
    if (input.k <= 0) return { insurable: false, reason: 'UNKNOWN', ratio: null, amount: null, covered: false, basis: 'record' };
    raw = wilsonUpperFailure(input.k, input.n, opts.z ?? Z);
    basis = 'record';
  }
  const ratio = raw < min ? min : raw;
  const amount = opts.price === undefined ? null : premiumAmount(BigInt(opts.price), ratio);
  return { insurable: true, ratio, amount, covered: ratio <= max, basis };
}

export type Listing = { n: number; k: number; p_L: number; u_F: number; z: number; cheat: boolean; grade_id: string | null };

/** One row a pool can publish for a seller: the record, both bounds, and the cheat flag kept apart from them. */
export function listing(k: number, n: number, opts: { z?: number; cheat?: boolean; grade_id?: string | null } = {}): Listing {
  const z = opts.z ?? Z;
  return { n, k, p_L: wilsonLower(k, n, z), u_F: wilsonUpperFailure(k, n, z), z, cheat: opts.cheat ?? false, grade_id: opts.grade_id ?? null };
}

// ---------------------------------------------------------------------------------------------------------------
// Optional. grade() asks Jev the four RUBRIC_v1 questions through TypeSafe AI's own SDK, @typesafe-ai/sdk
// (an optional peer dependency). It builds each question with the SDK's choice() and calls client.systemOne().
// Each option is its own description ({ yes: 'yes', no: 'no' }), the same input every Taifoon caller sends today.
// With no client it makes new TypeSafeClient(), which reads your TYPESAFE_API_KEY. This package has no HTTP
// client of its own and never sees your key.

/** One Choice answer as @typesafe-ai/sdk returns it: the label, its confidence, and the full distribution. */
export type ChoiceAnswer = { choice: string; confidence: number; probabilities: { readonly [label: string]: number } };
/** The part of TypeSafeClient that grade() uses. A TypeSafeClient from @typesafe-ai/sdk satisfies it. */
export type JevClient = {
  systemOne(req: { state: any; questions: any; model?: string }): PromiseLike<{ model: string; answers: { readonly [id: string]: any } }>;
};
export type Grade = {
  rubric: string;
  rubric_hash: string;
  model: string;
  answers: { [id: string]: ChoiceAnswer };
  /** cheat_shaped P(yes) >= THRESHOLDS_v1.cheatShapedMin. A flag, never an input to π. */
  cheat: boolean;
};

const SDK = '@typesafe-ai/sdk';

export async function grade(state: unknown, opts: { client?: JevClient; model?: string; questions?: readonly RubricQuestion[] } = {}): Promise<Grade> {
  let sdk: typeof import('@typesafe-ai/sdk');
  try {
    sdk = await import(SDK) as typeof import('@typesafe-ai/sdk');
  } catch {
    throw new Error('grade() needs TypeSafe AI’s SDK: npm i @typesafe-ai/sdk');
  }
  const qs = opts.questions ?? RUBRIC_ASKED;
  const questions = Object.fromEntries(qs.map((q) => [q.id, sdk.choice(q.text, Object.fromEntries(q.options.map((o) => [o, o])))]));
  const client: JevClient = opts.client ?? new sdk.TypeSafeClient();
  const res = await client.systemOne({ state: state as never, questions, model: opts.model ?? JEV_MODEL });
  const answers: { [id: string]: ChoiceAnswer } = {};
  for (const [id, a] of Object.entries(res.answers)) answers[id] = { choice: a.choice, confidence: a.confidence, probabilities: { ...a.probabilities } };
  const c = answers.cheat_shaped?.probabilities?.yes;
  return { rubric: RUBRIC_VERSION, rubric_hash: RUBRIC_HASH, model: res.model, answers, cheat: typeof c === 'number' && c >= THRESHOLDS_V1.cheatShapedMin };
}
