// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {BetsPricing} from "../src/BetsPricing.sol";
import {VmTest} from "./Vm.sol";

/// tests/vectors/bets-grid.json (written by the TypeScript) read here: Solidity returns every number to the unit.
contract BetsPricingTest is VmTest {
    function _params(string memory j, string memory set) internal pure returns (BetsPricing.Params memory q) {
        string memory b = string.concat(".sets.", set, ".params.");
        q.a0 = vm.parseUint(vm.parseJsonString(j, string.concat(b, "a0")));
        q.b0 = vm.parseUint(vm.parseJsonString(j, string.concat(b, "b0")));
        q.lambda = vm.parseUint(vm.parseJsonString(j, string.concat(b, "lambda")));
        q.lpYield = vm.parseUint(vm.parseJsonString(j, string.concat(b, "lpYield")));
        q.utilization = vm.parseUint(vm.parseJsonString(j, string.concat(b, "utilization")));
        q.maxRatio = vm.parseUint(vm.parseJsonString(j, string.concat(b, "maxRatio")));
        q.pMin = vm.parseUint(vm.parseJsonString(j, string.concat(b, "pMin")));
        q.feeBps = vm.parseUint(vm.parseJsonString(j, string.concat(b, "feeBps")));
        q.minFee = vm.parseUint(vm.parseJsonString(j, string.concat(b, "minFee")));
    }

    function _grid(string memory set) internal view {
        string memory j = vm.readFile("../tests/vectors/bets-grid.json");
        BetsPricing.Params memory q = _params(j, set);
        string memory rows = string.concat(".sets.", set, ".rows");
        uint256 n;
        for (uint256 i; ; i++) {
            string memory key = string.concat(rows, "[", vm.toString(i), "]");
            if (!vm.keyExistsJson(j, key)) { n = i; break; }
            string[] memory r = vm.parseJsonStringArray(j, key);
            BetsPricing.Quote memory o = BetsPricing.price(vm.parseUint(r[0]), vm.parseUint(r[1]), vm.parseUint(r[2]), q);
            eq(o.p, vm.parseUint(r[3]), string.concat("p row ", vm.toString(i)));
            eq(o.mean, vm.parseUint(r[4]), "mean");
            eq(o.sd, vm.parseUint(r[5]), "sd");
            eq(o.risk, vm.parseUint(r[6]), "risk");
            eq(o.capital, vm.parseUint(r[7]), "capital");
            require(o.insurable == (vm.parseUint(r[8]) == 1), "insurable");
            eq(BetsPricing.gross(vm.parseUint(r[9]), o.p), vm.parseUint(r[10]), "G");
            eq(BetsPricing.fee(vm.parseUint(r[9]), q), vm.parseUint(r[11]), "fee");
        }
        require(n == 2184, "grid shape");
    }

    function test_betsGrid_defaults_equalsTypeScript() public view { _grid("defaults"); }
    function test_betsGrid_devnet_equalsTypeScript() public view { _grid("devnet"); }
}
