// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {WilsonPremium} from "../src/WilsonPremium.sol";
import {VmTest} from "./Vm.sol";

/// External wrappers so reverts can be expected and gas measured.
contract Harness {
    function upperBound(uint256 i, uint256 n) external pure returns (uint256) { return WilsonPremium.upperBound(i, n); }
    function ratioE6(uint256 i, uint256 n) external pure returns (uint256) { return WilsonPremium.ratioE6(i, n); }
    function premium(uint256 p, uint256 i, uint256 n) external pure returns (uint256) { return WilsonPremium.premium(p, i, n); }
    function covered(uint256 i, uint256 n) external pure returns (bool) { return WilsonPremium.covered(i, n); }
    function quote(uint256 p, uint256 i, uint256 n) external pure returns (bool, uint256, uint256, bool) { return WilsonPremium.quote(p, i, n); }
}

contract WilsonPremiumTest is VmTest {
    Harness h = new Harness();

    uint256 constant GLMR_10 = 10e18;

    function _bound(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        return lo + (x % (hi - lo + 1));
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Golden vectors: tests/vectors/premium-grid.json, generated from the TypeScript, read by all three languages.

    function test_goldenGrid_equalsTypeScript() public view {
        string memory j = vm.readFile("../tests/vectors/premium-grid.json");
        uint256 rows = vm.parseJsonUint(j, ".rows");
        uint256[] memory inc = vm.parseJsonUintArray(j, ".incorrect");
        uint256[] memory tot = vm.parseJsonUintArray(j, ".total");
        bool[] memory ins = vm.parseJsonBoolArray(j, ".insurable");
        uint256[] memory e6 = vm.parseJsonUintArray(j, ".ratio_e6");
        bool[] memory cov = vm.parseJsonBoolArray(j, ".covered");
        string[] memory price = vm.parseJsonStringArray(j, ".price");
        string[] memory prem = vm.parseJsonStringArray(j, ".premium");
        require(rows >= 45_451 && inc.length == rows && prem.length == rows, "grid shape");
        for (uint256 i; i < rows; i++) {
            uint256 p = vm.parseUint(price[i]);
            (bool insurable, uint256 m, uint256 amount, bool c) = WilsonPremium.quote(p, inc[i], tot[i]);
            if (!ins[i]) {
                require(!insurable && inc[i] == tot[i], "UNKNOWN row");
                continue;
            }
            require(insurable, "insurable row");
            eq(m, e6[i], string.concat("ratio_e6 row ", vm.toString(i)));
            eq(amount, vm.parseUint(prem[i]), string.concat("premium row ", vm.toString(i))); // max difference: 0 wei
            require(c == cov[i], string.concat("covered row ", vm.toString(i)));
            // the WAD bound rounds (half up) to the same millionths
            eq((WilsonPremium.upperBound(inc[i], tot[i]) + 5e11) / 1e12, m, string.concat("upperBound row ", vm.toString(i)));
        }
    }

    /// Every quote in tests/vectors.json (live POST /v1/pools/quote answers and the plan's rows).
    function test_liveAndPlanVectors_equalTheLayer() public view {
        string memory j = vm.readFile("../tests/vectors.json");
        uint256 checked;
        for (uint256 i; ; i++) {
            string memory v = string.concat(".vectors[", vm.toString(i), "]");
            if (!vm.keyExistsJson(j, v)) break;
            uint256 k = vm.parseJsonUint(j, string.concat(v, ".k"));
            uint256 n = vm.parseJsonUint(j, string.concat(v, ".n"));
            uint256 p = vm.parseUint(vm.parseJsonString(j, string.concat(v, ".price")));
            (bool insurable,, uint256 amount,) = WilsonPremium.quote(p, n - k, n);
            if (!vm.parseJsonBool(j, string.concat(v, ".layer.insurable"))) {
                require(!insurable, "layer says not insurable");
            } else {
                eq(amount, vm.parseUint(vm.parseJsonString(j, string.concat(v, ".layer.premium"))), v);
            }
            checked++;
        }
        require(checked >= 20, "vectors");
    }

    /// The three live Moonbeam sellers, POST /v1/pools/quote tenant moonbeam, 10 GLMR, 2026-09-28
    /// (tests/fixtures/live/2026-09-28/), and the SDK's 1/0 row.
    function test_liveSellers_pinned() public pure {
        // 0x1112889be806840a66419ea1e8d4dd21852993e5: 88 delivered, 0 incorrect
        eq(WilsonPremium.premium(GLMR_10, 0, 88), 418270000000000000, "88/0");
        // 0x4b33758d85678ea86cd875af8caf318462268ba8: 2,740 graded, 5 incorrect
        eq(WilsonPremium.premium(GLMR_10, 5, 2740), 42650000000000000, "2740/5");
        // 0xfcf0b00f8352dd193a671e40940c9a32396adb49: 62 graded, 2 incorrect
        eq(WilsonPremium.premium(GLMR_10, 2, 62), 1102050000000000000, "62/2");
        // 0xdca0f0166bbc52a94073781d3971d8aa1938ef20: 1 delivered, 0 incorrect (not covered: 0.79 > 0.30)
        eq(WilsonPremium.premium(GLMR_10, 0, 1), 7934510000000000000, "1/0");
        require(!WilsonPremium.covered(0, 1) && WilsonPremium.covered(2, 62), "cover rule");
        // the plan's rows at 100 USDC
        eq(WilsonPremium.premium(100_000_000, 1, 10), 40_415_000, "9/10");
        eq(WilsonPremium.premium(100_000_000, 10, 100), 17_436_600, "90/100");
        eq(WilsonPremium.premium(100_000_000, 0, 10), 27_753_300, "10/10");
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Edges

    function test_unknown_reverts_and_quote_says_not_insurable() public {
        vm.expectRevert(abi.encodeWithSelector(WilsonPremium.WilsonUnknown.selector));
        h.premium(1e18, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(WilsonPremium.WilsonUnknown.selector));
        h.ratioE6(7, 7);
        (bool ins, uint256 m, uint256 a, bool c) = h.quote(1e18, 7, 7);
        require(!ins && m == 0 && a == 0 && !c, "quote UNKNOWN");
        require(!h.covered(0, 0), "0/0 not covered");
        eq(h.upperBound(0, 0), 1e18, "wilson(0,0) = [0,1]");
        eq(h.upperBound(7, 7), 1e18, "all incorrect");
    }

    function test_badInputs_revert() public {
        vm.expectRevert(abi.encodeWithSelector(WilsonPremium.WilsonBadRecord.selector, 3, 2));
        h.upperBound(3, 2);
        vm.expectRevert(abi.encodeWithSelector(WilsonPremium.WilsonBadRecord.selector, 0, 1e15 + 1));
        h.premium(1, 0, 1e15 + 1);
        vm.expectRevert(abi.encodeWithSelector(WilsonPremium.WilsonZeroPrice.selector));
        h.premium(0, 1, 10);
        vm.expectRevert(abi.encodeWithSelector(WilsonPremium.WilsonZeroPrice.selector));
        h.quote(0, 0, 0);
    }

    function test_maxTotal_noOverflow() public view {
        h.quote(type(uint256).max / 1e6, 0, 1e15);
        h.quote(1e30, 5e14, 1e15);
        h.quote(1e30, 1e15 - 1, 1e15);
        eq(h.upperBound(1e15, 1e15), 1e18, "all incorrect at max");
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Fuzz (10,000 runs each, foundry.toml)

    /// More incorrect jobs at the same total never lowers the bound or the premium.
    function testFuzz_monotonicInIncorrect(uint256 total, uint256 a, uint256 b, uint256 price) public view {
        total = _bound(total, 1, 1e12);
        a = _bound(a, 0, total);
        b = _bound(b, 0, total);
        if (a > b) (a, b) = (b, a);
        price = _bound(price, 1, 1e30);
        require(h.upperBound(a, total) <= h.upperBound(b, total), "upperBound monotonic");
        if (b < total) {
            require(h.ratioE6(a, total) <= h.ratioE6(b, total), "ratioE6 monotonic");
            require(h.premium(price, a, total) <= h.premium(price, b, total), "premium monotonic");
        }
    }

    /// A longer clean record (incorrect = 0) never costs more.
    function testFuzz_nonIncreasingInTotalWhenClean(uint256 n1, uint256 n2, uint256 price) public view {
        n1 = _bound(n1, 1, 1e12);
        n2 = _bound(n2, 1, 1e12);
        if (n1 > n2) (n1, n2) = (n2, n1);
        price = _bound(price, 1, 1e30);
        require(h.upperBound(0, n2) <= h.upperBound(0, n1), "upperBound");
        require(h.ratioE6(0, n2) <= h.ratioE6(0, n1), "ratioE6");
        require(h.premium(price, 0, n2) <= h.premium(price, 0, n1), "premium");
    }

    /// Ratio in [0, 1e18]; premium ≤ price; covered ⇒ premium ≤ price × 0.30; no overflow for price ≤ 1e30, total ≤ 1e12.
    function testFuzz_boundsAndCap(uint256 price, uint256 incorrect, uint256 total) public view {
        total = _bound(total, 0, 1e12);
        incorrect = _bound(incorrect, 0, total);
        price = _bound(price, 1, 1e30);
        uint256 u = h.upperBound(incorrect, total);
        require(u <= 1e18, "u <= 1");
        (bool ins, uint256 m, uint256 amount, bool c) = h.quote(price, incorrect, total);
        if (!ins) {
            require(incorrect == total, "UNKNOWN only with no delivered job");
            return;
        }
        require(m <= 1e6 && amount <= price, "premium <= price");
        eq(amount, (price * m) / 1e6, "premium = floor(price x ratio_e6 / 1e6)");
        eq(m, h.ratioE6(incorrect, total), "quote = ratioE6");
        eq((u + 5e11) / 1e12, m, "WAD bound rounds to ratio_e6");
        require(u > 0, "u > 0: z > 0 always leaves room for failure");
        if (c) {
            require(m <= WilsonPremium.MAX_PREMIUM_RATIO_E6, "covered => ratio <= 0.30");
            require(amount <= (price * WilsonPremium.MAX_PREMIUM_RATIO_E6) / 1e6, "covered => premium <= 0.30 P");
        }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // FFI parity with the TypeScript (opt in: WILSON_FFI=1 forge test --ffi; needs node >= 22.6).

    /// forge-config: default.fuzz.runs = 256
    function testFuzz_ffi_equalsTypeScript(uint256 price, uint256 incorrect, uint256 total, uint8 shape) public {
        if (!vm.envOr("WILSON_FFI", false)) return;
        // half the runs on short records (where the premium moves most), half up to 1e12 jobs
        total = shape % 2 == 0 ? _bound(total, 0, 500) : _bound(total, 0, 1e12);
        incorrect = shape % 4 < 2 ? _bound(incorrect, 0, total) : total - _bound(incorrect, 0, total < 5 ? total : 5);
        price = _bound(price, 1, 1e30);
        string[] memory cmd = new string[](7);
        cmd[0] = "node";
        cmd[1] = "--experimental-strip-types";
        cmd[2] = "--no-warnings";
        cmd[3] = "test/ffi/premium.ts";
        cmd[4] = vm.toString(incorrect);
        cmd[5] = vm.toString(total);
        cmd[6] = vm.toString(price);
        (bool tIns, uint256 tM, uint256 tAmount, bool tC) = abi.decode(vm.ffi(cmd), (bool, uint256, uint256, bool));
        (bool ins, uint256 m, uint256 amount, bool c) = h.quote(price, incorrect, total);
        require(ins == tIns && c == tC, "insurable/covered");
        eq(m, tM, "ratio_e6 vs TypeScript");
        eq(amount, tAmount, "premium vs TypeScript");
    }
}
