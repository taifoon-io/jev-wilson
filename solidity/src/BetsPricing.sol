// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {FixedPointMathLib} from "./vendor/FixedPointMathLib.sol";

/// @title BetsPricing
/// @notice jev-wilson `bets` on chain: the price per unit of failure payout for two-sided job assurance
///         (schemas/assurance/machine.json `pricing`). The same integers as src/bets.ts and python/.../bets.py: every row
///         of tests/vectors/bets-grid.json returns the same p, mean, sd, risk, capital, G and fee here (difference 0).
///
///   n = k + f;  w = a0 + b0 + n·WAD
///   mean    = ceil((a0 + f·WAD)·WAD / w)
///   var     = floor(mean·(WAD − mean) / (w + WAD));   sd = ceil(sqrt(var·WAD))
///   risk    = ceil(λ·sd / WAD);   capital = ceil(y·lock·WAD / (YEAR·u))
///   p       = max(pMin, mean + risk + capital);   insurable ⇔ p ≤ maxRatio
///   G       = floor(x·WAD / p);   fee = max(ceil(x·feeBps / 1e4), minFee)
/// Every rounding goes in favour of the backers who hold the collateral (a higher p, a smaller G).
library BetsPricing {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant YEAR_S = 31_536_000;

    struct Params {
        uint256 a0;
        uint256 b0;
        uint256 lambda;
        uint256 lpYield;
        uint256 utilization;
        uint256 maxRatio;
        uint256 pMin;
        uint256 feeBps;
        uint256 minFee;
    }

    struct Quote {
        uint256 p;
        uint256 mean;
        uint256 sd;
        uint256 risk;
        uint256 capital;
        bool insurable;
    }

    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    function price(uint256 k, uint256 f, uint256 lockS, Params memory q) internal pure returns (Quote memory o) {
        uint256 w = q.a0 + q.b0 + (k + f) * WAD;
        o.mean = _ceilDiv((q.a0 + f * WAD) * WAD, w);
        uint256 v = (o.mean * (WAD - o.mean)) / (w + WAD);
        uint256 s2 = v * WAD;
        o.sd = FixedPointMathLib.sqrt(s2);
        if (o.sd * o.sd != s2) o.sd += 1;
        o.risk = _ceilDiv(q.lambda * o.sd, WAD);
        o.capital = _ceilDiv(q.lpYield * lockS * WAD, YEAR_S * q.utilization);
        uint256 p = o.mean + o.risk + o.capital;
        o.p = p < q.pMin ? q.pMin : p;
        o.insurable = o.p <= q.maxRatio;
    }

    function gross(uint256 x, uint256 p) internal pure returns (uint256) {
        return (x * WAD) / p;
    }

    function fee(uint256 x, Params memory q) internal pure returns (uint256) {
        uint256 byBps = _ceilDiv(x * q.feeBps, 10_000);
        return byBps < q.minFee ? q.minFee : byBps;
    }
}
