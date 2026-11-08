// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {EconomySplit} from "../src/EconomySplit.sol";
import {VmTest} from "./Vm.sol";

contract EconomySplitTest is VmTest {
    function test_splitGrid_equalsTypeScript() public view {
        string memory j = vm.readFile("../tests/vectors/split-grid.json");
        uint256 rows = vm.parseJsonUint(j, ".split_rows");
        string[] memory a = vm.parseJsonStringArray(j, ".amount");
        uint256[] memory s = vm.parseJsonUintArray(j, ".split_bps");
        string[] memory b = vm.parseJsonStringArray(j, ".to_backers");
        string[] memory l = vm.parseJsonStringArray(j, ".to_layer");
        require(rows >= 1_000 && a.length == rows, "grid shape");
        for (uint256 i; i < rows; i++) {
            (uint256 tb, uint256 tl) = EconomySplit.premiumSplit(vm.parseUint(a[i]), s[i]);
            eq(tb, vm.parseUint(b[i]), string.concat("to_backers row ", vm.toString(i)));
            eq(tl, vm.parseUint(l[i]), string.concat("to_layer row ", vm.toString(i)));
        }
    }

    function test_compGrid_equalsTypeScript() public view {
        string memory j = vm.readFile("../tests/vectors/split-grid.json");
        uint256 rows = vm.parseJsonUint(j, ".comp_rows");
        string[] memory d = vm.parseJsonStringArray(j, ".deposit");
        uint256[] memory c = vm.parseJsonUintArray(j, ".comp_bps");
        string[] memory tb = vm.parseJsonStringArray(j, ".to_buyer");
        string[] memory ts = vm.parseJsonStringArray(j, ".to_seller");
        for (uint256 i; i < rows; i++) {
            (uint256 b, uint256 s) = EconomySplit.noShowComp(vm.parseUint(d[i]), c[i]);
            eq(b, vm.parseUint(tb[i]), string.concat("to_buyer row ", vm.toString(i)));
            eq(s, vm.parseUint(ts[i]), string.concat("to_seller row ", vm.toString(i)));
        }
    }

    function testFuzz_legsSum(uint256 pi, uint256 s, uint256 d, uint256 c) public pure {
        pi = pi % 1e36;
        d = d % 1e36;
        s = 5_000 + (s % 5_001);
        c = c % 10_001;
        (uint256 tb, uint256 tl) = EconomySplit.premiumSplit(pi, s);
        require(tb + tl == pi && tb >= tl, "legs sum; backers >= layer at the floor");
        (uint256 b, uint256 r) = EconomySplit.noShowComp(d, c);
        require(b + r == d && b <= d, "deposit sums");
    }
}
