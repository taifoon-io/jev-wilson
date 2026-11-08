// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {Margin} from "../src/Margin.sol";
import {VmTest} from "./Vm.sol";

contract MarginTest is VmTest {
    function test_marginGrid_equalsTypeScript() public view {
        string memory j = vm.readFile("../tests/vectors/margin-grid.json");
        uint256 rows = vm.parseJsonUint(j, ".rows");
        string[] memory u = vm.parseJsonStringArray(j, ".units");
        string[] memory f = vm.parseJsonStringArray(j, ".fee");
        string[] memory l = vm.parseJsonStringArray(j, ".list");
        string[] memory s = vm.parseJsonStringArray(j, ".seller_of_list");
        string[] memory fl = vm.parseJsonStringArray(j, ".fee_of_list");
        require(rows >= 100 && u.length == rows, "grid shape");
        eq(vm.parseJsonUint(j, ".margin_bps"), Margin.MARGIN_BPS, "margin_bps");
        for (uint256 i; i < rows; i++) {
            uint256 x = vm.parseUint(u[i]);
            eq(Margin.marginFee(x), vm.parseUint(f[i]), string.concat("fee row ", vm.toString(i)));
            eq(Margin.listPrice(x), vm.parseUint(l[i]), string.concat("list row ", vm.toString(i)));
            eq(Margin.sellerPart(x), vm.parseUint(s[i]), string.concat("seller_of_list row ", vm.toString(i)));
            eq(Margin.feeOfList(x), vm.parseUint(fl[i]), string.concat("fee_of_list row ", vm.toString(i)));
        }
    }

    function testFuzz_roundTrip(uint256 s) public pure {
        s = 1 + (s % 1e36);
        uint256 l = Margin.listPrice(s);
        require(Margin.sellerPart(l) == s, "the seller is paid its price");
        require(Margin.feeOfList(l) == Margin.marginFee(s), "our fee is the rest");
        require(Margin.marginFee(s) * Margin.BPS >= s * Margin.MARGIN_BPS, "never under 20 %");
    }
}
