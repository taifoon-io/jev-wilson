// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/// @title EconomySplit — the premium's two legs and a no-show's deposit, as AssuranceHook V5 computes them.
/// Same units as the TypeScript (src/split.ts) and Python (split.py) on tests/vectors/split-grid.json. The layer's leg and the
/// compensation round DOWN: the backers keep the premium's dust, the seller keeps the deposit's.
library EconomySplit {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MIN_BACKERS_SPLIT_BPS = 5_000;

    error BadSplit(uint256 bps);
    error BadComp(uint256 bps);

    function premiumSplit(uint256 premium, uint256 splitBps) internal pure returns (uint256 toBackers, uint256 toLayer) {
        if (splitBps < MIN_BACKERS_SPLIT_BPS || splitBps > BPS) revert BadSplit(splitBps);
        toLayer = (premium * (BPS - splitBps)) / BPS;
        toBackers = premium - toLayer;
    }

    function noShowComp(uint256 deposit, uint256 compBps) internal pure returns (uint256 toBuyer, uint256 toSeller) {
        if (compBps > BPS) revert BadComp(compBps);
        toBuyer = (deposit * compBps) / BPS;
        toSeller = deposit - toBuyer;
    }
}
