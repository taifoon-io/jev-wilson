# @taifoon/jev-wilson

Price assurance for agent jobs from a seller's record. This package takes how many of a seller's jobs were delivered and how many failed, computes the Wilson score interval, and turns its bound into a coverage premium for the next job. TypeScript and Python give the same numbers, bit for bit.

Grading is a separate, optional step: `grade()` asks TypeSafe's Jev (`jev-1.13.0`) through TypeSafe's own SDK. Jev judges the job; the premium is code, and Jev never sets it.

## Quick start

```sh
npm i @taifoon/jev-wilson        # also installs @taifoon/jev and @taifoon/n8n-nodes-typesafe
pip install "git+https://github.com/taifoon-io/jev-wilson#subdirectory=python"   # same functions, same bits (PyPI soon)
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

`premium({ k, n }, { price })` returns the same ratio and amount as `POST https://coord.taifoon.dev/v1/pools/quote`. The tests hold live quotes, the plan's rows, and a grid of records. TypeScript and Python agree bit for bit. See `schemas/wilson-premium-v1.md` for the curve and the four places it differs from the first plan (z, which bound, rounding, `0/0`).

## Grading is optional

Jev is called through TypeSafe AI's own SDK, `@typesafe-ai/sdk` (MIT), an optional peer dependency. `grade(state)` builds the four RUBRIC_v1 questions with the SDK's `choice()` and calls `client.systemOne()` pinned to `jev-1.13.0`. It returns every answer's full distribution, `rubric_hash` and a `cheat` flag. Your key stays in the SDK (`TYPESAFE_API_KEY`). This package has no HTTP client of its own.

```ts
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { grade, wilsonLower, premium } from '@taifoon/jev-wilson';

const g = await grade({ task, deliverable }, { client: new TypeSafeClient() });
g.answers.spec_met.probabilities;          // { yes: …, no: … }
premium({ k: 60, n: 62 }, { price: 10n ** 19n });
```

Python: `pip install "taifoon-jev-wilson[jev] @ git+https://github.com/taifoon-io/jev-wilson#subdirectory=python"` adds `typesafe-sdk`, and `grade(state, client=TypeSafeClient())` works the same way. See `examples/grade-and-price.ts`.

The rubric is frozen in `schemas/rubric-v1.json` (hash `0x129dfc81338f238adba7566c1f9c2a72769168edd0fd8251a34a81a90ea3eb97`).

## Solidity

`solidity/src/WilsonPremium.sol` is the same curve as a pure library (no storage, no external calls, integers only):
`premium(price, incorrect, total)`, `ratioE6`, `covered`, `upperBound` (WAD, rounded up) and a non-reverting `quote`. It
takes the record as a contract sees it, `incorrect` of `total`. A record with no delivered job reverts `WilsonUnknown()`,
the TypeScript's UNKNOWN. The library has not been audited: review it before it guards funds.

```sol
import {WilsonPremium} from "@taifoon/jev-wilson/solidity/src/WilsonPremium.sol";

WilsonPremium.premium(10e18, 2, 62);   // 1102050000000000000, the TypeScript's number to the wei
```

It evaluates the bound in fixed point at 1e30 with z exact, then rounds to millionths as the TypeScript does. On every
row of `tests/vectors/premium-grid.json` (every record with up to 300 jobs, the longer records of `tests/grid.json` and the live quotes,
prices from 1 unit to 1e27) the premium, the millionths ratio and the cover flag equal the TypeScript's: difference 0. The
same file is checked by the TypeScript and Python tests, so the three languages read one set of numbers.

```sh
npm test              # TypeScript, Python, then forge test (each skipped with a note if its tool is missing)
npm run test:ffi      # also fuzzes the Solidity against the TypeScript through vm.ffi
npm run vectors       # regenerates tests/vectors/premium-grid.json from src/wilson.ts
npm run vectors:fee   # regenerates tests/vectors/fee-grid.json and prior-fit.json from src/fee.ts and src/prior.ts
```

## The fee, the pool holder's premium, and one calibration per chain

Three more modules price a job that settles through an ERC-8183 evaluator. All three are integer or plain float maths, and
TypeScript and Python agree on shared vector files (`tests/vectors/fee-grid.json`, `lp-grid.json`, `prior-fit.json`).

- `@taifoon/jev-wilson/fee`: `jobFee(price, gas, legs, policy)`. The fee is the larger of `bps` of the price and the
  evaluator's own gas at the quoted gas price (base fee plus a buffer, plus the tip, plus the L1 data fee) converted to the
  job token, plus a margin. A job whose fee would exceed the hook's cap is refused, and the answer names the smallest price
  that is served. Python: `taifoon_jev_wilson.fee.job_fee`.
- `@taifoon/jev-wilson/lp`: `lpPremium()`, the premium a cover pool's backers need: expected loss and a risk loading from a
  Beta-Binomial posterior on the seller's record (both 0 when no arbitrator can find cheating), plus the capital the cover
  locks and the backers' gas.
- `@taifoon/jev-wilson/prior`: `fitPrior(records)`, the Beta prior fitted by maximum likelihood to every seller's record.

The numbers these modules take are measured, per chain, by one command:

```
npx @taifoon/jev-wilson calibrate base --out ./calibration
```

It reads only public data and signs nothing:

1. the chain's fee history over 7 days (the razor gas service, else `eth_feeHistory`, else block headers): the p95 rise of
   the base fee over the quote's validity plus the settle horizon, rounded up, is the gas buffer;
2. the gas of each of our legs on a job, from receipts (`calibration/legs/<chainId>.json`; a chain with no receipts of its
   own yet borrows Base's, marked `provisional`, with 25 % added);
3. the market prior, fitted to the chain's seller records (Base's when the chain has none yet);
4. a Monte Carlo of the fee over that history: each job is quoted at a random block and its legs pay the gas of the blocks
   where they would be sent, capped at the quoted gas price; the buffer rises until no served job loses money;
5. a Monte Carlo of a backer's year under `lpPremium`;
6. the price table, from a live read of today's gas.

The result is `calibration/<chainId>.json`, versioned: `version` moves when the fee, the legs or the premium parameters
change, `digest` covers the whole file and `config_digest` what a fee config reads. `jev-wilson calibration check` recomputes
every file's table and digests offline; `jev-wilson calibration show base` prints the table. `--compare` writes nothing and
exits 2 on a gas-regime change. Chains: `base`, `arbitrum`, `arc`, `robinhood`. The package ships the calibration it was
released with, and `.github/workflows/calibrate.yml` re-runs it weekly (and every 6 hours checks for a regime change),
publishing each result as a release of this repository.

## MCP

```sh
npx @taifoon/jev-wilson mcp
```

A stdio MCP server with three tools: `wilson_lower`, `premium`, `listing`. No network, no keys.

## Files

- `src/wilson.ts`, `src/lp.ts`, `src/fee.ts`, `src/prior.ts`, `python/taifoon_jev_wilson/`: the functions
- `src/calibrate.ts`, `src/montecarlo.ts`, `src/gas-source.ts`: the calibration command; `calibration/`: its inputs (`chains.json`, `policy.json`, `legs/`) and one result per chain
- `schemas/`: `rubric-v1.json`, `wilson-premium-v1.md`, `listing.schema.json`
- `examples/job-accept.json`: one real job on Base, and the premium for its seller's next job
- `examples/grade-and-price.ts`: `@typesafe-ai/sdk` grades, this package prices
- `solidity/`: `WilsonPremium.sol` and its Foundry tests (golden grid, fuzz, optional FFI against the TypeScript)
- `tests/`: TypeScript and Python, on the same vectors; `tests/vectors/premium-grid.json` is shared with the Solidity tests

## Licence

Independent project. Jev and TypeSafe are products of TypeSafe AI, Inc., which does not endorse this package.

Apache-2.0.
