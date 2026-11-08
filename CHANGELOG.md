# Changelog

All notable changes to `@taifoon/jev-wilson`. npm releases are published with provenance by
`.github/workflows/publish-npm.yml` on a `vX.Y.Z` tag; the Python package (`py-vX.Y.Z`, `publish-pypi.yml`) carries the
same version. 0.4.x was never published.

## 0.5.0

New modules, each in TypeScript, Python and Solidity, held to the unit on a shared vector file:

- **economy** (`@taifoon/jev-wilson/economy`, `taifoon_jev_wilson.economy`, `EconomyQuote.sol`): `quoteEconomy` returns every
  number of one assured job: the premium `max(Wilson premium, backers' need + job fee)`, the backers' and the layer's legs,
  the seller's deposit and the buyer's compensation on a no-show or a rejection that stands. `hookTerms` turns a quote into
  the terms an assurance hook (AssuranceHook V5.1) takes, and `checkBounds` runs the hook's bound check off chain.
  `lpPremiumUnits` computes the backers' need exactly above 1e9 units. Vectors: `tests/vectors/economy-grid.json`
  (15,360 rows).
- **GRID line**: `calibration/grid-3692781.json` (Taifoon mainnet, priced in GRID), generated from `calibration/lines/grid.json`
  by `npm run calibration:grid`; `loadLineCalibration('grid', 3692781)` and `quoteEconomyFor` price a GRID job. Status
  `provisional` (gas, legs and prior borrowed from Base). Vectors: `tests/vectors/economy-grid-line.json`.
- **split** (`@taifoon/jev-wilson/split`, `EconomySplit.sol`): where a premium and a no-show's deposit go on a hook with an
  economy. Vectors: `tests/vectors/split-grid.json`.
- **margin** (`@taifoon/jev-wilson/margin`, `Margin.sol`): the resale price, 20 % over the seller's price rounded up, the
  seller always paid its price. Vectors: `tests/vectors/margin-grid.json`.
- **bets** (`@taifoon/jev-wilson/bets`, `bets-scenarios`, `bets-mc`, `BetsPricing.sol`): two-sided job assurance (FOR,
  AGAINST and COVER at one price), the reference market, scenarios S01–S12 with their end balances, a seeded Monte Carlo.
  Anyone may open a round on an accepted job (no buyer-or-seller check). Vectors: `tests/vectors/bets-grid.json`, `bets-scenarios.json`.

Also:

- `src/wilson-core.ts`: the Wilson bound in one import-free file, shared by `wilson.ts` and the economy.
- package: author contact `builders@taifoon.io`; CHANGELOG.md ships in the tarball; search keywords; README with what you
  get, how it works and a 30-second CLI start.

## 0.3.1 (2026-10-01)

- Monad (143) calibration and the x402 buyer leg (`x402Fee`).

## 0.3.0 (2026-10-01)

- One calibration command per chain (`jev-wilson calibrate <chain>`): fee history → gas buffer, receipts → legs, seller
  records → prior, the no-loss and backer Monte Carlos, the price table; versioned `calibration/<chainId>.json` for Base
  (measured), Arbitrum One, Arc and Robinhood Chain. Fee and prior modules with Python twins on shared vectors.

Earlier versions: see the [releases](https://github.com/taifoon-io/jev-wilson/releases).
