// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {FixedPointMathLib} from "./vendor/FixedPointMathLib.sol";

/// @title WilsonPremium
/// @notice wilson-premium-v1 on chain: the 95% Wilson upper bound on a seller's incorrect rate, mapped to a premium.
///         The same curve as `src/wilson.ts` and `python/taifoon_jev_wilson/wilson.py`, and the same numbers:
///         for every record in `tests/vectors/premium-grid.json` the premium here equals the TypeScript premium to
///         the wei (difference 0), and so do the cover flag and the millionths ratio.
///
/// A pure library: no storage, no external calls, no floating point. Integers only.
///
/// Inputs are the record the way a contract sees it: `incorrect` failed jobs out of `total` graded jobs. The
/// TypeScript takes `k = total - incorrect` delivered jobs of `n = total`; the failure count is `n - k`.
///
/// The curve, for x = incorrect and n = total (z pinned to 1.959963984540054, not 1.96):
///
///     u_F = (x + z²/2 + z · sqrt(x(n − x)/n + z²/4)) / (n + z²)
///
/// This is the TypeScript's `wilson(n - k, n)[1]` multiplied through by n (the same real number; the TypeScript
/// evaluates it in doubles, this library in fixed point at 1e30, where z = 1959963984540054e-15 and z² are exact).
///
///     ratioE6 = round(u_F × 1e6)          ties up, as JavaScript Math.round
///     premium = floor(price × ratioE6 / 1e6)
///     covered = u_F ≤ 0.30                (compared exactly, not on the rounded ratio, as the TypeScript does)
///
/// UNKNOWN: a record with no delivered job (incorrect == total, including 0/0) has no rate to price. The
/// TypeScript returns { insurable: false, reason: 'UNKNOWN' }; here `ratioE6` and `premium` revert with
/// `WilsonUnknown()`, and `quote` returns insurable = false with zeros. `upperBound(0, 0)` is 1e18, the
/// TypeScript's wilson(0, 0) = [0, 1].
///
/// ROUNDING. The intermediate terms are floored at 1e-30, far below the millionths the premium is rounded to
/// (the closest record with total ≤ 300 sits 2.6e-11 relative from a rounding tie). So the premium is not rounded
/// "up" or "down" against anyone: it is the TypeScript's premium, exactly. `upperBound` (WAD) rounds UP, so it is
/// never below the true bound.
///
/// Range: total ≤ 1e15 (MAX_TOTAL; above it the TypeScript's doubles are no longer exact integers either), price up
/// to type(uint256).max / 1e6. Not in this library: the TypeScript's optional `min` floor and custom `z` (the
/// layer uses neither).
library WilsonPremium {
    /// @dev 1.0 in the WAD scale `upperBound` returns.
    uint256 internal constant WAD = 1e18;
    /// @dev The ratio is rounded to millionths before it multiplies the price (the TypeScript's RATIO_SCALE).
    uint256 internal constant RATIO_SCALE = 1e6;
    /// @dev The cover rule: no pool covers above π ÷ P = 0.30 (the TypeScript's MAX_PREMIUM_RATIO).
    uint256 internal constant MAX_PREMIUM_RATIO_E6 = 300_000;
    /// @dev z = 1.959963984540054 exactly, at 1e15.
    uint256 internal constant Z_E15 = 1_959_963_984_540_054;
    /// @dev The internal fixed-point scale.
    uint256 internal constant R = 1e30;
    /// @dev z² exactly, at 1e30 (Z_E15², divisible by 4).
    uint256 internal constant Z2 = Z_E15 * Z_E15;
    /// @dev The largest total accepted. Keeps every intermediate below 2^256.
    uint256 internal constant MAX_TOTAL = 1e15;

    /// @notice The record has no delivered job (incorrect == total): not insurable, no premium.
    error WilsonUnknown();
    /// @notice incorrect > total, or total > MAX_TOTAL.
    error WilsonBadRecord(uint256 incorrect, uint256 total);
    /// @notice A premium needs a positive price in the token's smallest unit.
    error WilsonZeroPrice();

    /// @dev u_F = num / den, both at scale R. Requires 0 < total ≤ MAX_TOTAL and incorrect ≤ total.
    function _fraction(uint256 incorrect, uint256 total) private pure returns (uint256 num, uint256 den) {
        uint256 t = incorrect * (total - incorrect); // x(n − x) ≤ 2.5e29
        uint256 q = t / total;
        uint256 r = t % total;
        // x(n − x)/n + z²/4 at scale R², floored: the quotient and remainder parts stay below 2^256 for total ≤ 1e15.
        uint256 inner = q * R * R + (r * R * R) / total + (Z2 * R) / 4;
        // z · sqrt(inner) at scale R: floor(sqrt) then × z (exact at 1e15), floored.
        uint256 s = (Z_E15 * FixedPointMathLib.sqrt(inner)) / 1e15;
        num = incorrect * R + Z2 / 2 + s;
        den = total * R + Z2;
    }

    function _check(uint256 incorrect, uint256 total) private pure {
        if (incorrect > total || total > MAX_TOTAL) revert WilsonBadRecord(incorrect, total);
    }

    /// @notice The 95% Wilson upper bound on the incorrect rate, in WAD, rounded UP, clamped to [0, 1e18].
    ///         total = 0 gives 1e18 (the TypeScript's [0, 1]). Defined for incorrect == total as well (= 1e18).
    function upperBound(uint256 incorrect, uint256 total) internal pure returns (uint256) {
        _check(incorrect, total);
        if (total == 0) return WAD;
        (uint256 num, uint256 den) = _fraction(incorrect, total);
        uint256 u = (num * WAD + den - 1) / den;
        return u > WAD ? WAD : u;
    }

    /// @notice round(u_F × 1e6), ties up: the TypeScript's Math.round(ratio × 1e6). Reverts WilsonUnknown when no job
    ///         was delivered (incorrect == total).
    function ratioE6(uint256 incorrect, uint256 total) internal pure returns (uint256) {
        _check(incorrect, total);
        if (incorrect == total) revert WilsonUnknown();
        (uint256 num, uint256 den) = _fraction(incorrect, total);
        uint256 m = (2 * num * RATIO_SCALE + den) / (2 * den);
        return m > RATIO_SCALE ? RATIO_SCALE : m;
    }

    /// @notice The premium for the next job at `price` (token's smallest unit): floor(price × ratioE6 / 1e6).
    ///         Reverts WilsonUnknown (no delivered job) and WilsonZeroPrice. Not capped: above 0.30 it is still
    ///         computed, as in the TypeScript; `covered` says whether a pool may cover it.
    function premium(uint256 price, uint256 incorrect, uint256 total) internal pure returns (uint256) {
        if (price == 0) revert WilsonZeroPrice();
        return (price * ratioE6(incorrect, total)) / RATIO_SCALE;
    }

    /// @notice u_F ≤ 0.30, compared exactly. False when no job was delivered.
    function covered(uint256 incorrect, uint256 total) internal pure returns (bool) {
        _check(incorrect, total);
        if (incorrect == total) return false;
        (uint256 num, uint256 den) = _fraction(incorrect, total);
        return num * 10 <= den * 3;
    }

    /// @notice Everything at once, without reverting on UNKNOWN: insurable = false with zeros, as the TypeScript's
    ///         { insurable: false, ratio: null, amount: null, covered: false }. Still reverts on a bad record or price 0.
    function quote(uint256 price, uint256 incorrect, uint256 total)
        internal
        pure
        returns (bool insurable, uint256 ratio_, uint256 amount, bool covered_)
    {
        _check(incorrect, total);
        if (price == 0) revert WilsonZeroPrice();
        if (incorrect == total) return (false, 0, 0, false);
        ratio_ = ratioE6(incorrect, total);
        amount = (price * ratio_) / RATIO_SCALE;
        covered_ = covered(incorrect, total);
        insurable = true;
    }
}
