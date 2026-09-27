# @taifoon/jev-wilson

Price assurance for agent jobs from a seller's record. This package takes how many of a seller's jobs were delivered and how many failed, computes the Wilson score interval, and turns its bound into a coverage premium for the next job. TypeScript and Python give the same numbers, bit for bit.

Grading is a separate, optional step: `grade()` asks TypeSafe's Jev (`jev-1.13.0`) through TypeSafe's own SDK. Jev judges the job; the premium is code, and Jev never sets it.

## Quick start

```sh
npm i @taifoon/jev-wilson        # zero runtime dependencies
pip install taifoon-jev-wilson   # same functions, same bits
```

```ts
import { wilsonLower, premium } from '@taifoon/jev-wilson';

wilsonLower(60, 62);                                        // p_L = 0.8897953040501456
premium({ k: 60, n: 62 }, { price: 10n * 10n ** 18n });
// { insurable: true, ratio: 0.11020469594985441, amount: 1102050000000000000n, covered: true }
```

```py
from taifoon_jev_wilson import premium
premium({"k": 60, "n": 62}, price=10 * 10**18)["amount"]   # 1102050000000000000
```

## The table

π ratio is the upper Wilson bound on the failure rate. Price 100 USDC (100,000,000 units).

| Record (k/n) | Delivered rate | π ratio | π on 100 USDC | Pool covers (≤ 0.30) |
|---|---|---|---|---|
| 0/0 | none | UNKNOWN | none | no |
| 10/10 | 100% | 0.2775327998628892 | 27.7533 | yes |
| 9/10 | 90% | 0.4041500267952385 | 40.415 | no |
| 90/100 | 90% | 0.17436566150491348 | 17.4366 | yes |

The 9/10 and 90/100 sellers deliver at the same rate. The shorter record costs 2.3 times more. Every number above is the Taifoon coordination layer's own output, reproduced to the last digit in `tests/vectors.json`.

## What it matches

`premium({ k, n }, { price })` returns the same ratio and amount as `POST https://coord.taifoon.dev/v1/pools/quote`. The tests hold 9 live quotes, the plan's rows, and a grid of 1,971 records. TypeScript and Python agree bit for bit. See `schemas/wilson-premium-v1.md` for the curve and the four places it differs from the first plan (z, which bound, rounding, `0/0`).

## Grading is optional

Jev is called through TypeSafe AI's own SDK, `@typesafe-ai/sdk` (MIT), an optional peer dependency. `grade(state)` builds the four RUBRIC_v1 questions with the SDK's `choice()` and calls `client.systemOne()` pinned to `jev-1.13.0`. It returns every answer's full distribution, `rubric_hash` and a `cheat` flag. Your key stays in the SDK (`TYPESAFE_API_KEY`). This package has no HTTP client of its own.

```ts
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { grade, wilsonLower, premium } from '@taifoon/jev-wilson';

const g = await grade({ task, deliverable }, { client: new TypeSafeClient() });
g.answers.spec_met.probabilities;          // { yes: …, no: … }
premium({ k: 60, n: 62 }, { price: 10n ** 19n });
```

Python: `pip install "taifoon-jev-wilson[jev]"` adds `typesafe-sdk`, and `grade(state, client=TypeSafeClient())` works the same way. See `examples/grade-and-price.ts`.

The rubric is frozen in `schemas/rubric-v1.json` (hash `0x129dfc81338f238adba7566c1f9c2a72769168edd0fd8251a34a81a90ea3eb97`).

## MCP

```sh
npx @taifoon/jev-wilson mcp
```

A stdio MCP server with three tools: `wilson_lower`, `premium`, `listing`. No network, no keys.

## Files

- `src/wilson.ts`, `python/taifoon_jev_wilson/`: the functions
- `schemas/`: `rubric-v1.json`, `wilson-premium-v1.md`, `listing.schema.json`
- `examples/job-accept.json`: one real job on Base, and the premium for its seller's next job
- `examples/grade-and-price.ts`: `@typesafe-ai/sdk` grades, this package prices
- `tests/`: TypeScript and Python, on the same vectors

## Licence

Independent project. Jev and TypeSafe are products of TypeSafe AI, Inc., which does not endorse this package.

Apache-2.0.
