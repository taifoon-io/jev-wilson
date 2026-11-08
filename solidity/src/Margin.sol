// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/// @title Margin — the one resale price rule: our fee is 20 % over the seller's price, rounded up; a seller price of 0 (our own
/// product) lists at OWN_FLOOR_UNITS; the seller's part of a market-set list rounds down. Same units as the TypeScript
/// (src/margin.ts) and Python (margin.py) on tests/vectors/margin-grid.json.
library Margin {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MARGIN_BPS = 2_000;
    uint256 internal constant OWN_FLOOR_UNITS = 2_000;

    function marginFee(uint256 sellerPrice) internal pure returns (uint256) {
        if (sellerPrice == 0) return OWN_FLOOR_UNITS;
        return (sellerPrice * MARGIN_BPS + BPS - 1) / BPS;
    }

    function listPrice(uint256 sellerPrice) internal pure returns (uint256) {
        return sellerPrice + marginFee(sellerPrice);
    }

    function sellerPart(uint256 list) internal pure returns (uint256) {
        return (list * BPS) / (BPS + MARGIN_BPS);
    }

    function feeOfList(uint256 list) internal pure returns (uint256) {
        return list - sellerPart(list);
    }
}
