// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {WilsonPremium} from "./WilsonPremium.sol";
import {FixedPointMathLib} from "./vendor/FixedPointMathLib.sol";

/// @title EconomyQuote — every number of one assured job, from the seller's record (jev-wilson.economy.v1).
/// @notice The Solidity twin of src/economy.ts quoteEconomy and python/taifoon_jev_wilson/economy.py quote_economy: for
///         every row of tests/vectors/economy-grid.json it returns the same units (difference 0). The derivation of each
///         line is in src/economy.ts and the README ("The economy, from the record").
///
///   r            = round(u_F × 1e6)          WilsonPremium.ratioE6; 1e6 when nothing was ever delivered (correct = 0)
///   W            = floor(P × r / 1e6)
///   L            = lpPremium(...)            the backers' need (src/lp.ts), here in fixed point at 1e27, rounded up
///   priced       = max(W, L + F)             F = the job fee, an input (it is priced from live gas off chain)
///   covered      = correct > 0 && L > 0 && priced × 1e6 ≤ P × maxRatioE6
///   premium      = covered ? priced : 0;  toBackers = covered ? L : 0;  toLayer = premium − toBackers (≥ F)
///   coverCap     = floor(P × m / 10,000)
///   compensation = min(priced, P)
///   deposit      = P + max(compensation, ceil(coverCap × r / 1e6))
///
/// lpPremium: the TypeScript evaluates  ceil(s·C·μ + s·C·λ·σ + y·C·T/(YEAR·u) + o)  in doubles; this library evaluates the
/// same real number with every term floored at 1e-27 of a unit, then rounds up. The two agree unless the real sum sits
/// within the doubles' error (about 1e-16 relative) above an integer; the grid and the FFI fuzz check that they do.
/// Parameters are WAD (1e18) decimals as the calibration file writes them (0.1666 → 166600000000000000), except
/// opsUnits (token units) and maxRatioE6 (millionths). A pure library: no storage, no external calls.
library EconomyQuote {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant R = 1e27;
    uint256 internal constant E6 = 1e6;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant YEAR_S = 31_536_000;
    /// @dev The domain the overflow analysis covers (every product below stays under 2^256 inside it).
    uint256 internal constant MAX_PRICE = 1e30;
    uint256 internal constant MAX_MULTIPLE_BPS = 1_000_000;
    uint256 internal constant MAX_LOCK_SECONDS = 1e10;

    error EconomyBadInput();
    error EconomyBadParams();

    /// Backers' pricing parameters (calibration/<chainId>.json `lp`), WAD unless noted.
    struct LpParams {
        uint256 a0; // Beta prior on the failure rate
        uint256 b0;
        uint256 lambda; // risk loading, in posterior standard deviations
        uint256 severity; // share of the cap a payout takes, ≤ 1e18
        uint256 lpYield; // backers' required yield per year
        uint256 utilization; // share of a pool locked on average, (0, 1e18]
        uint256 opsUnits; // backers' gas per job, token units
        uint256 maxRatioE6; // cover only when premium ÷ price ≤ this, millionths
    }

    struct Input {
        uint256 price; // P, token units
        uint256 correct; // k
        uint256 incorrect; // f
        uint256 lockSeconds; // T
        bool arbitrator;
        uint256 coverMultipleBps; // m, ≥ 10,000
        uint256 fee; // F, token units
    }

    struct Quote {
        bool insurable;
        bool covered;
        uint256 premium;
        uint256 toBackers;
        uint256 toLayer;
        uint256 deposit;
        uint256 compensation;
        uint256 coverCap;
        uint256 ratioE6;
        uint256 wilson;
        uint256 lp;
        uint256 priced;
        uint256 ubLossOnCap;
    }

    /// @notice Every number of one assured job. Reverts EconomyBadInput outside the domain, EconomyBadParams on params
    ///         lpPremium refuses (utilization 0 or > 1, severity > 1, a0 + b0 = 0).
    function quote(Input memory i, LpParams memory p) internal pure returns (Quote memory q) {
        if (i.price == 0 || i.price > MAX_PRICE) revert EconomyBadInput();
        if (i.coverMultipleBps < BPS || i.coverMultipleBps > MAX_MULTIPLE_BPS) revert EconomyBadInput();
        if (i.lockSeconds > MAX_LOCK_SECONDS || i.fee > MAX_PRICE) revert EconomyBadInput();
        uint256 n = i.correct + i.incorrect;
        q.insurable = i.correct > 0;
        if (q.insurable) {
            q.ratioE6 = WilsonPremium.ratioE6(i.incorrect, n);
            q.wilson = (i.price * q.ratioE6) / E6;
        } else {
            q.ratioE6 = E6;
            q.wilson = i.price;
        }
        q.lp = lpPremium(i.price, i.correct, i.incorrect, i.lockSeconds, i.arbitrator, i.coverMultipleBps, p);
        uint256 need = q.lp + i.fee;
        q.priced = q.wilson > need ? q.wilson : need;
        q.covered = q.insurable && q.lp > 0 && q.priced * E6 <= i.price * p.maxRatioE6;
        uint256 cap = (i.price * i.coverMultipleBps) / BPS;
        q.ubLossOnCap = (cap * q.ratioE6 + E6 - 1) / E6;
        q.compensation = q.priced < i.price ? q.priced : i.price;
        q.deposit = i.price + (q.compensation > q.ubLossOnCap ? q.compensation : q.ubLossOnCap);
        if (q.covered) {
            q.premium = q.priced;
            q.toBackers = q.lp;
            q.toLayer = q.priced - q.lp;
            q.coverCap = cap;
        }
    }

    /// @notice The premium a cover pool's backers need for one job (src/lp.ts lpPremium), in token units, rounded up.
    function lpPremium(
        uint256 price,
        uint256 correct,
        uint256 incorrect,
        uint256 lockSeconds,
        bool arbitrator,
        uint256 m,
        LpParams memory p
    ) internal pure returns (uint256) {
        if (p.utilization == 0 || p.utilization > WAD || p.severity > WAD || p.a0 + p.b0 == 0) revert EconomyBadParams();
        if (p.lambda > 100 * WAD || p.lpYield > 10 * WAD || p.a0 + p.b0 > 1e36) revert EconomyBadParams();
        if (correct > WilsonPremium.MAX_TOTAL || incorrect > WilsonPremium.MAX_TOTAL) revert EconomyBadInput();
        uint256 pm = price * m; // C × 1e4
        uint256 sum; // units × R
        if (arbitrator) {
            uint256 w = p.a0 + p.b0 + (correct + incorrect) * WAD; // a0 + b0 + n, WAD
            uint256 meanR = mulDiv(p.a0 + incorrect * WAD, R, w); // μ at R
            // expected loss s·C·μ
            sum += mulDiv(p.severity * pm, meanR, WAD * BPS);
            // risk loading s·C·λ·σ, σ = sqrt(μ(1 − μ)/(w + 1))
            uint256 sdR = FixedPointMathLib.sqrt(mulDiv(meanR * (R - meanR), WAD, w + WAD));
            sum += mulDiv(p.severity * p.lambda * pm, sdR, WAD * WAD * BPS);
        }
        // capital y·C·T / (YEAR·u)
        sum += mulDiv(p.lpYield * pm * lockSeconds, R, YEAR_S * p.utilization * BPS);
        // operations o
        sum += p.opsUnits * R;
        return (sum + R - 1) / R;
    }

    /// @dev floor(x × y / d) with a 512-bit intermediate (the standard construction: Remco Bloemen, MIT; as in
    ///      OpenZeppelin Math.mulDiv). Reverts when d = 0 or the result does not fit 256 bits.
    function mulDiv(uint256 x, uint256 y, uint256 d) internal pure returns (uint256 result) {
        unchecked {
            uint256 prod0 = x * y;
            uint256 prod1;
            assembly ("memory-safe") {
                let mm := mulmod(x, y, not(0))
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }
            if (prod1 == 0) {
                require(d > 0, "mulDiv: zero");
                return prod0 / d;
            }
            require(d > prod1, "mulDiv: overflow");
            uint256 rem;
            assembly ("memory-safe") {
                rem := mulmod(x, y, d)
                prod1 := sub(prod1, gt(rem, prod0))
                prod0 := sub(prod0, rem)
            }
            uint256 twos = d & (~d + 1);
            assembly ("memory-safe") {
                d := div(d, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;
            uint256 inv = (3 * d) ^ 2;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            result = prod0 * inv;
        }
    }
}
