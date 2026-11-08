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

/** The Jev model the examples pin. */
export const JEV_MODEL = 'jev-1.13.0';
export { Z, MAX_PREMIUM_RATIO, RATIO_SCALE, wilson, wilsonLower, wilsonUpperFailure, premiumAmount } from './wilson-core.ts';
import { Z, MAX_PREMIUM_RATIO, checkRecord, wilsonLower, wilsonUpperFailure, premiumAmount } from './wilson-core.ts';

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
