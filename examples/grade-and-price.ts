// Jev grades this job through TypeSafe AI's SDK. Wilson prices the next premium in code.
//   npm i @typesafe-ai/sdk @taifoon/jev-wilson
//   TYPESAFE_API_KEY=... node grade-and-price.ts
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { grade, listing, premium, wilsonLower } from '@taifoon/jev-wilson';

// 1. The job: Jev answers the four RUBRIC_v1 questions on the sealed deliverable, with your own key.
const g = await grade(
  { task: 'Report the GLMR held by pool 0x95951a4bF6F2f99131a5653060d5E8a24F6feb9e at block 51823378', deliverable: 'The pool holds 60 GLMR.' },
  { client: new TypeSafeClient(), model: 'jev-1.13.0' },
);
console.log(g.answers.spec_met.probabilities, 'cheat flag:', g.cheat);

// 2. The next premium: the seller's record after this job, from the layer's live quote (60 delivered of 62).
const k = 60, n = 62;
console.log('p_L', wilsonLower(k, n)); // 0.8897953040501456
console.log(premium({ k, n }, { price: 10n * 10n ** 18n })); // ratio 0.11020469594985441, amount 1102050000000000000n
console.log(listing(k, n, { cheat: g.cheat, grade_id: null }));
