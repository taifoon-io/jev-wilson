<p align="center">
  <img src="https://raw.githubusercontent.com/taifoon-io/jev-wilson/main/assets/banner.svg" alt="Jev Wilson: price a job's cover from the seller's record" width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@taifoon/jev-wilson"><img src="https://img.shields.io/npm/v/@taifoon/jev-wilson?style=flat-square&labelColor=000000&color=3DA5FF&label=npm" alt="npm"></a>
  <a href="https://www.npmjs.com/package/@taifoon/jev-wilson#provenance"><img src="https://img.shields.io/badge/provenance-signed-00B5B8?style=flat-square&labelColor=000000" alt="provenance"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/@taifoon/jev-wilson?style=flat-square&labelColor=000000&color=E6F0F7" alt="licence"></a>
  <a href="https://www.npmjs.com/package/@taifoon/jev-wilson"><img src="https://img.shields.io/npm/dm/@taifoon/jev-wilson?style=flat-square&labelColor=000000&color=3DA5FF" alt="downloads"></a>
</p>

**Price the cover on an AI agent's next job from how many of its jobs were delivered and how many failed.**

The Wilson score bound on a seller's record becomes a coverage premium; around it sit the fee that never loses money
(the larger of bps and the evaluator's own gas), what a cover pool's backers need, every number of an assured job (premium,
both legs, deposit, compensation), the 20 % resale margin, and one calibration command per chain. TypeScript, Python and
Solidity return the same units on shared vector files. Integer maths, no network, no keys.

## 30 seconds

```sh
npx @taifoon/jev-wilson premium 90 100 100000000
```

A seller with 90 of 100 jobs delivered, a 100 USDC job (in 6-decimal units): the premium is `17436600` (17.4366 USDC) and a
pool covers it (`"covered": true`). The same rate on a shorter record costs 2.3 times more:

```sh
npx @taifoon/jev-wilson premium 9 10 100000000      # "amount": "40415000", "covered": false
```

In code:

```ts
import { wilsonLower, premium } from '@taifoon/jev-wilson';

wilsonLower(60, 62);                                        // p_L = 0.8897953040501456
premium({ k: 60, n: 62 }, { price: 10n * 10n ** 18n });
// { insurable: true, ratio: 0.11020469594985441, amount: 1102050000000000000n, covered: true, basis: 'record' }
```

```py
from taifoon_jev_wilson import premium
premium({"k": 60, "n": 62}, price=10 * 10**18)["amount"]   # 1102050000000000000
```

## What you get

| Import | What it prices |
|---|---|
| `@taifoon/jev-wilson` | the Wilson bound and the cover premium from a record (`wilsonLower`, `premium`), optional grading with Jev |
| `@taifoon/jev-wilson/fee` | `jobFee`: max(bps of the price, the evaluator's gas at the quoted gas price + margin); `x402Fee` for the x402 buyer leg |
| `@taifoon/jev-wilson/lp` | `lpPremium`: what a cover pool's backers need (Beta-Binomial posterior, capital, gas) |
| `@taifoon/jev-wilson/economy` | `quoteEconomy`: premium, the backers' and the layer's legs, the seller's deposit, the buyer's compensation |
| `@taifoon/jev-wilson/split` | where a premium and a no-show's deposit go on an assurance hook |
| `@taifoon/jev-wilson/margin` | the resale price: 20 % over the seller's price, the seller always paid its price |
| `@taifoon/jev-wilson/bets` | two-sided job assurance: FOR, AGAINST and COVER at one price, the reference market, scenarios, Monte Carlo |
| `@taifoon/jev-wilson/calibration` | the shipped per-chain calibrations (Base, Arbitrum One, Arc, Robinhood Chain, Monad, the GRID line) |
| `npx @taifoon/jev-wilson` | `premium`, `listing`, `calibrate <chain>`, `calibration check\|show`, and a stdio MCP server (`mcp`) |

## How it works

```
seller's record (k delivered of n graded)
        │ wilsonUpperFailure(k, n)          95 % upper bound on the failure rate
        ▼
premium ratio ── > 0.30 of the price ──▶ not covered
        │
        ▼
quoteEconomy: premium = max(Wilson premium, backers' need + job fee)
        ├─▶ toBackers (what the pool's capital needs)
        ├─▶ toLayer   (the rest, never below the job fee)
        └─▶ deposit = price + max(compensation, the record's loss bound on the cover cap)
                       compensation = min(premium, price), to the buyer on a no-show
```

The same functions run in TypeScript, Python (`python/taifoon_jev_wilson`) and Solidity (`solidity/src`), held to the unit
on the grids in `tests/vectors/`.

## Install

```sh
npm i @taifoon/jev-wilson        # also installs @taifoon/jev and @taifoon/n8n-nodes-typesafe
pip install "git+https://github.com/taifoon-io/jev-wilson#subdirectory=python"   # same functions, same units (not on PyPI yet)
```

Node.js 20 or later. Python 3.9 or later.

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

With no `--out`, the result goes to `./calibration` in the working directory.

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
exits 2 on a gas-regime change. Chains: `base`, `arbitrum`, `arc`, `robinhood`, `monad`. The package ships the calibration it was
released with, and `.github/workflows/calibrate.yml` re-runs it weekly (and every 6 hours checks for a regime change),
publishing each result as a release of this repository.

### Monad and the x402 buyer leg

```
npx @taifoon/jev-wilson calibrate monad
```

Monad (chain 143) has no settle line, so its legs are Base's, marked `provisional` with 25 % added (Monad charges the gas
limit a transaction sets, not the gas it uses). Its gas token is MON, priced by Chainlink's MON / USD feed on Monad
(`0xBcD78f76005B7515837af6b50c7C52BCf73822fb`). Fee history comes from four public Monad RPCs.

Sellers on Monad take x402 in USDC (`0x754704Bc059F8C67012fEd69BC8A327a5aafb603`), so the calibration also prices the
buyer leg, a hire paid to the seller by x402 (`x402` in the file, `x402Fee` in `@taifoon/jev-wilson/fee`,
`taifoon_jev_wilson.fee.x402_fee` in Python):

- `exact` is an EIP-3009 `transferWithAuthorization`. The seller's facilitator sends it and pays its gas, so our gas is 0.
- With no settle line there is no hook: the fee is our routing and grade fee, `max(bps of the price, margin)`. There is no
  evaluator fee, no hook cap, and no cover pool, so the buyer pays the price plus the fee. The premium column shows what a
  cover pool would charge if one existed.
- `upto` settles through Permit2 and needs one approval per payer; `upto_setup` prices it at the snapshot.

## The economy, from the record (`@taifoon/jev-wilson/economy`)

One function returns every number of one assured job: the premium, its two legs, the seller's deposit and the share of that
deposit the buyer receives when the job fails without a cheat finding. The assurance hook (Taifoon's AssuranceHook V5.1)
does not compute any of it: the buyer commits the quote's terms when it opens the job and the
hook checks them against bounds the owner sets. TypeScript `quoteEconomy`, Python `taifoon_jev_wilson.economy.quote_economy`
and Solidity `EconomyQuote.quote` return the same units on `tests/vectors/economy-grid.json` (15,360 rows, written by
`scripts/gen-economy-grid.ts` from the TypeScript; difference 0).

Inputs: the price P, the record (k delivered, f failed, n = k + f), the seconds T the cover stays locked, whether an
arbitrator can find cheating on the hook, the cover multiple m (1× by default) and the job fee F (`jobFee`, the layer's floor).

```
r            = round(u_F × 1e6)                u_F = wilsonUpperFailure(k, n); 1e6 when nothing was ever delivered
W            = floor(P × r / 1e6)              the Wilson premium
L            = lpPremium(P, record, T, arb, m) what the backers need (computed exactly: lpPremiumUnits)
priced       = max(W, L + F)
covered      = k > 0 and L > 0 and priced ≤ maxRatio × P          (maxRatio 0.30)
premium      = priced if covered, else 0
toBackers    = L                               the backers' leg
toLayer      = premium − L                     the layer's leg, ≥ F: never negative for the layer
coverCap     = floor(P × m / 10,000)
compensation = min(priced, P)                  to the buyer, from the deposit, on a no-show and on a rejection that stands
deposit      = P + max(compensation, ceil(coverCap × r / 1e6))
```

Why each line (whitepaper §6 "the fuzzed game", §7 "network economics"):

- **premium = max(W, L + F).** Neither bound alone is enough. The Wilson bound charges less than the backers need once a
  record is long (50 failed of 1,000 on a 10 USDC job: W = 0.653 against L = 0.716 plus F = 0.049); the backers' price alone
  ignores how little a short record proves (1 of 20: L = 1.602 against W = 2.361). §7 puts revenue where judgment or capital
  is consumed: the capital is the backers', so they take exactly L; the judgment (the evaluator leg, the record, the quote) is
  the layer's, so it takes the rest, which is at least F.
- **compensation = min(priced, P).** A buyer whose job fails without a cheat finding gets its escrow back and, from the
  seller's deposit, the price the record put on that failure: it buys the same assurance again on the re-hire, and on a
  standing rejection it has also paid the evaluator fee (F ≤ priced). It is capped at the price because compensation is not a
  slash: §6 T3's over-compensation (the whole deposit) stays reserved for an adjudicated cheat. It also extends §6 T1 to
  shirking: delivering junk is negative-EV for the seller once the rejection rate q ≥ P / (P + compensation), and a worse
  record costs more. Before V5 a no-show cost the seller nothing (§6 lists NoShow as a move; no theorem priced it).
- **deposit = P + max(compensation, ceil(coverCap × r / 1e6)).** D > P is the hook's T1 floor: the seller pays any loss up to
  the price first. On top the seller stakes the compensation it may forfeit, so every compensation is collateralised when the
  job is funded, or, if larger, the 95 % upper bound on the expected loss on the cover cap, so the pool is asked only for loss
  beyond what the record itself predicts. Both shrink as the record grows: §6, proof "collapses the bond every honest
  participant must lock".

The examples below are printed by `npm run examples:economy` (`scripts/economy-examples.ts`) from `calibration/8453.json`;
amounts in USDC.

**Base, cover locked 7 days, an arbitrator on the hook**

| record (failed/graded) | price | Wilson bound W | backers need L | fee F | premium | backers | layer | deposit | compensation | cover |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|
| 1/20 | 1 | 0.236131 | 0.160317 | 0.015864 | 0.236131 | 0.160317 | 0.075814 | 1.236131 | 0.236131 | sold |
| 1/20 | 10 | 2.361310 | 1.602269 | 0.049000 | 2.361310 | 1.602269 | 0.759041 | 12.361310 | 2.361310 | sold |
| 1/20 | 100 | 23.613100 | 16.021783 | 0.490000 | 23.613100 | 16.021783 | 7.591317 | 123.613100 | 23.613100 | sold |
| 5/100 | 1 | 0.111750 | 0.102466 | 0.015864 | 0.118330 | 0.102466 | 0.015864 | 1.118330 | 0.118330 | sold |
| 5/100 | 10 | 1.117500 | 1.023752 | 0.049000 | 1.117500 | 1.023752 | 0.093748 | 11.117500 | 1.117500 | sold |
| 5/100 | 100 | 11.175000 | 10.236614 | 0.490000 | 11.175000 | 10.236614 | 0.938386 | 111.175000 | 11.175000 | sold |
| 50/1,000 | 1 | 0.065314 | 0.071668 | 0.015864 | 0.087532 | 0.071668 | 0.015864 | 1.087532 | 0.087532 | sold |
| 50/1,000 | 10 | 0.653140 | 0.715771 | 0.049000 | 0.764771 | 0.715771 | 0.049000 | 10.764771 | 0.764771 | sold |
| 50/1,000 | 100 | 6.531400 | 7.156808 | 0.490000 | 7.646808 | 7.156808 | 0.490000 | 107.646808 | 7.646808 | sold |
| 500/10,000 | 1 | 0.054447 | 0.062142 | 0.015864 | 0.078006 | 0.062142 | 0.015864 | 1.078006 | 0.078006 | sold |
| 500/10,000 | 10 | 0.544470 | 0.620514 | 0.049000 | 0.669514 | 0.620514 | 0.049000 | 10.669514 | 0.669514 | sold |
| 500/10,000 | 100 | 5.444700 | 6.204232 | 0.490000 | 6.694232 | 6.204232 | 0.490000 | 106.694232 | 6.694232 | sold |

**Base, the calibration's own setting (lock 4200 s, arbitrator false)**

| record (failed/graded) | price | Wilson bound W | backers need L | fee F | premium | backers | layer | deposit | compensation | cover |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|
| 1/20 | 1 | 0.236131 | 0.000154 | 0.015864 | 0.236131 | 0.000154 | 0.235977 | 1.236131 | 0.236131 | sold |
| 1/20 | 10 | 2.361310 | 0.000633 | 0.049000 | 2.361310 | 0.000633 | 2.360677 | 12.361310 | 2.361310 | sold |
| 1/20 | 100 | 23.613100 | 0.005428 | 0.490000 | 23.613100 | 0.005428 | 23.607672 | 123.613100 | 23.613100 | sold |
| 5/100 | 1 | 0.111750 | 0.000154 | 0.015864 | 0.111750 | 0.000154 | 0.111596 | 1.111750 | 0.111750 | sold |
| 5/100 | 10 | 1.117500 | 0.000633 | 0.049000 | 1.117500 | 0.000633 | 1.116867 | 11.117500 | 1.117500 | sold |
| 5/100 | 100 | 11.175000 | 0.005428 | 0.490000 | 11.175000 | 0.005428 | 11.169572 | 111.175000 | 11.175000 | sold |
| 50/1,000 | 1 | 0.065314 | 0.000154 | 0.015864 | 0.065314 | 0.000154 | 0.065160 | 1.065314 | 0.065314 | sold |
| 50/1,000 | 10 | 0.653140 | 0.000633 | 0.049000 | 0.653140 | 0.000633 | 0.652507 | 10.653140 | 0.653140 | sold |
| 50/1,000 | 100 | 6.531400 | 0.005428 | 0.490000 | 6.531400 | 0.005428 | 6.525972 | 106.531400 | 6.531400 | sold |
| 500/10,000 | 1 | 0.054447 | 0.000154 | 0.015864 | 0.054447 | 0.000154 | 0.054293 | 1.054447 | 0.054447 | sold |
| 500/10,000 | 10 | 0.544470 | 0.000633 | 0.049000 | 0.544470 | 0.000633 | 0.543837 | 10.544470 | 0.544470 | sold |
| 500/10,000 | 100 | 5.444700 | 0.005428 | 0.490000 | 5.444700 | 0.005428 | 5.439272 | 105.444700 | 5.444700 | sold |

USDC. F = jobFee on the calibration's gas snapshot (block 52027751), stand-in profile; calibration v1, digest 0xe88cb8d6af8250bfc641cbcf48c3d8cd08c399e375f6b9f5e0a2bf57bb29ee4c.

**No arbitrator, no claim.** Base's calibration has `arbitrator: false` because the Base V4 line has no arbitrator: no
finding of cheating is possible there, so the pool can never pay, and L is only the capital the cover locks plus the
backers' gas. The second table shows the result: almost the whole premium is the layer's leg. Selling cover on a line with no
arbitrator is the hook owner's choice (an arbitrator is one more party to trust).

**The hook's bounds** (V5.1 `setEconomyBounds`, owner only): `maxPremiumBps` (premium × 10,000 ≤ P × maxPremiumBps), and
`minBackersAprBps` (toBackers × 10,000 × YEAR ≥ coverCap × minBackersAprBps × seconds to the deadline). Every job also
satisfies, by construction and by the hook: toBackers + toLayer = premium, toBackers > 0 on a covered job, both 0 on an
uncovered one, compensation ≤ min(P, deposit). A quote from `quoteEconomy` passes them whenever
maxPremiumBps ≥ maxRatio × 10,000 (3,000) and minBackersAprBps ≤ lpYield × 10,000 (1,000); `checkBounds` runs the hook's
check off chain.

```ts
import { hookTerms } from '@taifoon/jev-wilson/economy';
import { quoteEconomyFor } from '@taifoon/jev-wilson/calibration';
import base from '@taifoon/jev-wilson/calibration/8453.json' with { type: 'json' };

const q = quoteEconomyFor(base, { price: 10_000_000n, record: { correct: 95, incorrect: 5 }, lockSeconds: 7 * 86_400, arbitrator: true });
// q.premium 1117500n, q.toBackers 1023752n, q.toLayer 93748n, q.deposit 11117500n, q.compensation 1117500n
const { econ, job } = hookTerms(q); // openJobWithEconomy(salt, { ...terms, ...job }, econ, spec)
```

```python
from taifoon_jev_wilson.economy import quote_economy
q = quote_economy(10_000_000, {"correct": 95, "incorrect": 5}, 7 * 86_400, True, fee=49_000)
```

The doubles of `lpPremium` drift by a unit near an integer above about 1e9 units, so the economy computes L with
`lpPremiumUnits`: the same formula with every term floored at 1e-27 of a unit and the parameters read as the exact decimals
the calibration writes. It equals `lpPremium` on the whole lp grid; above 1e9 units it is the correct one (a 1e12 job whose
exact sum is …171.00036 rounds up to …172, where the double reads …171).

### A GRID line

A GRID job is priced in GRID, its premium is paid in GRID on top of the price, and its seller's deposit, the cover and the
buyer's compensation are all in GRID. A GRID pool covers GRID jobs only; it never pays anything for a job paid in USDC.
GRID has 18 decimals and a fixed $0.01 peg, so our gas and margin (in dollars) convert to GRID at the peg.

`calibration/grid-3692781.json` (Taifoon mainnet, GRID) is generated by `npm run calibration:grid`
(`scripts/gen-grid-calibration.ts`) from `calibration/lines/grid.json`. That file holds the line's choices and why: the
backers ask 1 % a year (earned GRID cost nothing, bought GRID cost the peg) and their gas is Base's at the peg. The gas,
legs and prior are borrowed from Base until the line's own receipts exist, so the status is `provisional`. The line
opens when GRID can be deposited into pools.

```ts
import { loadLineCalibration, quoteEconomyFor } from '@taifoon/jev-wilson/calibration';
const grid = loadLineCalibration('grid', 3692781);
const q = quoteEconomyFor(grid, { price: 1_000n * 10n ** 18n, record: { correct: 95, incorrect: 5 }, lockSeconds: 7 * 86_400, arbitrator: true });
// q.premium 111.75 GRID, q.toBackers 95.47 GRID, q.toLayer 16.28 GRID (F 4.9 GRID), q.deposit 1,111.75 GRID
```

The hook bounds for the line are `setEconomyBounds(3000, 100, payee)`: the backers' floor is 1 % rather than Base's 10 %.
The Python and Solidity versions return the same units on `tests/vectors/economy-grid-line.json`.

## The resale margin (`@taifoon/jev-wilson/margin`)

One price rule for every resale: our fee is 20 % over the seller's price, rounded up, so the seller is always paid its price.

```ts
import { marginFee, listPrice, sellerPart, feeOfList } from '@taifoon/jev-wilson/margin';
listPrice(1_000n);   // 1_200n  (fee 200n)
marginFee(0n);       // 2_000n  (our own product lists at the own floor, 0.002 of a 6-decimal token)
sellerPart(5_000n);  // 4_166n  (a list the market set: the seller's part rounds down)
feeOfList(5_000n);   // 834n
```

| function | rule |
|---|---|
| `marginFee(S)` | `ceil(S × 2000 / 10000)`; `S = 0` gives `OWN_FLOOR_UNITS` |
| `listPrice(S)` | `S + marginFee(S)` |
| `sellerPart(L)` | `floor(L × 10000 / 12000)`; `sellerPart(listPrice(S)) = S` for every `S > 0` |
| `feeOfList(L)` | `L − sellerPart(L)` |

Python: `margin_fee`, `list_price`, `seller_part`, `fee_of_list`. Solidity: `solidity/src/Margin.sol` (library `Margin`). All three return
the same units on `tests/vectors/margin-grid.json` (`scripts/gen-margin-grid.ts`). Any other copy of the rule is tested against that grid.

## Two-sided job assurance (`@taifoon/jev-wilson/bets`)

One job, two sides, one price. Backers (FOR) stake that the seller delivers; challengers (AGAINST) and the job's buyer (COVER)
pay `x` at price `p` and receive `G = floor(x·WAD/p)` if the job fails. Cover and AGAINST are the same instrument at the same
price, so they cannot be arbitraged against each other. The machine it implements is Taifoon's assurance machine (`taifoon.assurance.machine.v1`).

| Piece | What it is |
|---|---|
| `betsPrice(record, lockS)` | `p = max(pMin, mean + ceil(λ·sd) + capital)`: the Beta posterior over the seller's record in the market (deliveries capped per distinct buyer), a risk loading in posterior sds, the backers' capital charge. Integers, rounded in the backers' favour. |
| `positionFee(x)` | `max(ceil(x·49/1e4), minFee)`, paid on top, refunded on a void |
| `BetsMarket` | the reference market: every guard, refusal and payout (FOR pro rata on delivery; seller's own stake absorbs first on failure) |
| `runBetsScript(script)` | replays a chain-agnostic op list; `tests/vectors/bets-scenarios.json` holds S01–S12 and their end balances |
| `quoteBothSides(...)` | fair vs offered price, expected return and variance per unit for FOR / AGAINST / COVER, the premium split, the checks, the manipulation bound |
| `betsMonteCarlo()` | sellers drawn from the fitted prior, every round settled by the reference market, conservation checked |

TypeScript, Python (`taifoon_jev_wilson.bets`) and Solidity (`solidity/src/BetsPricing.sol`) return the same integers on
`tests/vectors/bets-grid.json`. Regenerate with `npm run vectors:bets`.

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
- `calibration/lines/grid.json`, `scripts/gen-grid-calibration.ts`, `calibration/grid-3692781.json`: the GRID line (`tests/vectors/economy-grid-line.json`)
- `src/economy.ts` (+ `src/wilson-core.ts`, `quoteEconomyFor` in `src/calibration.ts`), `python/taifoon_jev_wilson/economy.py`, `solidity/src/EconomyQuote.sol`: the economy (`tests/vectors/economy-grid.json`, `scripts/gen-economy-grid.ts`, `scripts/economy-examples.ts`)
- `solidity/`: `WilsonPremium.sol`, `EconomyQuote.sol` and their Foundry tests (golden grids, fuzz, optional FFI against the TypeScript)
- `src/margin.ts`, `python/taifoon_jev_wilson/margin.py`, `solidity/src/Margin.sol`: the resale margin (`tests/vectors/margin-grid.json`, `scripts/gen-margin-grid.ts`)
- `tests/`: TypeScript and Python, on the same vectors; `tests/vectors/premium-grid.json` is shared with the Solidity tests

## Links

- npm: [@taifoon/jev-wilson](https://www.npmjs.com/package/@taifoon/jev-wilson) · the grader: [@taifoon/jev](https://www.npmjs.com/package/@taifoon/jev) · n8n: [@taifoon/n8n-nodes-typesafe](https://www.npmjs.com/package/@taifoon/n8n-nodes-typesafe)
- The live quote this package matches: `POST https://coord.taifoon.dev/v1/pools/quote` ([OpenAPI](https://coord.taifoon.dev/v1/openapi.json)) · [taifoon.io](https://www.taifoon.io)
- Changes: [CHANGELOG.md](CHANGELOG.md) · issues: [github.com/taifoon-io/jev-wilson/issues](https://github.com/taifoon-io/jev-wilson/issues) · contact: info@taifoon.io

## Licence

Independent project. Jev and TypeSafe are products of TypeSafe AI, Inc., which does not endorse this package.

Apache-2.0.
