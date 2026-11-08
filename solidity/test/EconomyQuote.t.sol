// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {EconomyQuote} from "../src/EconomyQuote.sol";
import {VmTest} from "./Vm.sol";

/// tests/vectors/economy-grid.json (scripts/gen-economy-grid.ts, from src/economy.ts): every leg of every row equals the
/// TypeScript to the unit. Fuzz: the economy's own rules hold over the whole domain; behind WILSON_FFI=1 also against the
/// TypeScript through node.
contract EconomyQuoteTest is VmTest {
    struct Cols {
        string[] price;
        uint256[] correct;
        uint256[] incorrect;
        uint256[] lock;
        bool[] arb;
        uint256[] multiple;
        string[] fee;
        uint256[] param;
    }

    function _params(string memory j, uint256 i) internal pure returns (EconomyQuote.LpParams memory p) {
        string memory k = string.concat(".params[", vm.toString(i), "].");
        p.a0 = vm.parseUint(vm.parseJsonString(j, string.concat(k, "a0")));
        p.b0 = vm.parseUint(vm.parseJsonString(j, string.concat(k, "b0")));
        p.lambda = vm.parseUint(vm.parseJsonString(j, string.concat(k, "lambda")));
        p.severity = vm.parseUint(vm.parseJsonString(j, string.concat(k, "severity")));
        p.lpYield = vm.parseUint(vm.parseJsonString(j, string.concat(k, "lpYield")));
        p.utilization = vm.parseUint(vm.parseJsonString(j, string.concat(k, "utilization")));
        p.opsUnits = vm.parseUint(vm.parseJsonString(j, string.concat(k, "opsUnits")));
        p.maxRatioE6 = vm.parseJsonUint(j, string.concat(k, "maxRatioE6"));
    }

    function _input(Cols memory c, uint256 i) internal pure returns (EconomyQuote.Input memory) {
        return EconomyQuote.Input({
            price: vm.parseUint(c.price[i]), correct: c.correct[i], incorrect: c.incorrect[i], lockSeconds: c.lock[i],
            arbitrator: c.arb[i], coverMultipleBps: c.multiple[i], fee: vm.parseUint(c.fee[i])
        });
    }

    function test_economyGrid_equalsTypeScript() public view {
        string memory j = vm.readFile("../tests/vectors/economy-grid.json");
        uint256 rows = vm.parseJsonUint(j, ".rows");
        Cols memory c;
        c.price = vm.parseJsonStringArray(j, ".price");
        c.correct = vm.parseJsonUintArray(j, ".correct");
        c.incorrect = vm.parseJsonUintArray(j, ".incorrect");
        c.lock = vm.parseJsonUintArray(j, ".lock");
        c.arb = vm.parseJsonBoolArray(j, ".arbitrator");
        c.multiple = vm.parseJsonUintArray(j, ".multiple");
        c.fee = vm.parseJsonStringArray(j, ".fee");
        c.param = vm.parseJsonUintArray(j, ".param");
        require(rows >= 10_000 && c.price.length == rows && c.param.length == rows, "grid shape");
        EconomyQuote.LpParams[] memory ps = new EconomyQuote.LpParams[](8);
        for (uint256 i; i < 8; i++) {
            if (!vm.keyExistsJson(j, string.concat(".params[", vm.toString(i), "]"))) break;
            ps[i] = _params(j, i);
        }
        _check(j, c, ps, rows);
    }

    /// tests/vectors/economy-grid-line.json (scripts/gen-grid-calibration.ts): the GRID line's parameters (lpYield 1 %, ops
    /// 1e16 GRID wei) and GRID-wei prices up to 1e23, every leg equal to the TypeScript.
    function test_gridLine_equalsTypeScript() public view {
        string memory j = vm.readFile("../tests/vectors/economy-grid-line.json");
        uint256 rows = vm.parseJsonUint(j, ".rows");
        Cols memory c;
        c.price = vm.parseJsonStringArray(j, ".price");
        c.correct = vm.parseJsonUintArray(j, ".correct");
        c.incorrect = vm.parseJsonUintArray(j, ".incorrect");
        c.lock = vm.parseJsonUintArray(j, ".lock");
        c.arb = vm.parseJsonBoolArray(j, ".arbitrator");
        c.multiple = vm.parseJsonUintArray(j, ".multiple");
        c.fee = vm.parseJsonStringArray(j, ".fee");
        c.param = vm.parseJsonUintArray(j, ".param");
        require(rows > 100 && c.price.length == rows, "grid line shape");
        EconomyQuote.LpParams[] memory ps = new EconomyQuote.LpParams[](1);
        ps[0] = _params(j, 0);
        require(ps[0].lpYield == 0.01e18 && ps[0].opsUnits == 1e16, "the GRID line's parameters");
        _check(j, c, ps, rows);
    }

    struct Exp {
        bool[] covered;
        string[] premium;
        string[] toBackers;
        string[] toLayer;
        string[] deposit;
        string[] comp;
        string[] cap;
        string[] lp;
        string[] wilson;
        uint256[] e6;
    }

    function _check(string memory j, Cols memory c, EconomyQuote.LpParams[] memory ps, uint256 rows) internal pure {
        Exp memory x;
        x.covered = vm.parseJsonBoolArray(j, ".covered");
        x.premium = vm.parseJsonStringArray(j, ".premium");
        x.toBackers = vm.parseJsonStringArray(j, ".to_backers");
        x.toLayer = vm.parseJsonStringArray(j, ".to_layer");
        x.deposit = vm.parseJsonStringArray(j, ".deposit");
        x.comp = vm.parseJsonStringArray(j, ".compensation");
        x.cap = vm.parseJsonStringArray(j, ".cover_cap");
        x.lp = vm.parseJsonStringArray(j, ".lp");
        x.wilson = vm.parseJsonStringArray(j, ".wilson");
        x.e6 = vm.parseJsonUintArray(j, ".ratio_e6");
        for (uint256 i; i < rows; i++) _row(x, EconomyQuote.quote(_input(c, i), ps[c.param[i]]), i);
    }

    function _row(Exp memory x, EconomyQuote.Quote memory q, uint256 i) internal pure {
        string memory r = vm.toString(i);
        eq(q.lp, vm.parseUint(x.lp[i]), string.concat("lp row ", r));
        eq(q.wilson, vm.parseUint(x.wilson[i]), string.concat("wilson row ", r));
        eq(q.ratioE6, x.e6[i], string.concat("ratio_e6 row ", r));
        require(q.covered == x.covered[i], string.concat("covered row ", r));
        eq(q.premium, vm.parseUint(x.premium[i]), string.concat("premium row ", r));
        eq(q.toBackers, vm.parseUint(x.toBackers[i]), string.concat("to_backers row ", r));
        eq(q.toLayer, vm.parseUint(x.toLayer[i]), string.concat("to_layer row ", r));
        eq(q.deposit, vm.parseUint(x.deposit[i]), string.concat("deposit row ", r));
        eq(q.compensation, vm.parseUint(x.comp[i]), string.concat("compensation row ", r));
        eq(q.coverCap, vm.parseUint(x.cap[i]), string.concat("cover_cap row ", r));
    }

    function _base() internal pure returns (EconomyQuote.LpParams memory) {
        return EconomyQuote.LpParams({a0: 0.1666e18, b0: 0.9297e18, lambda: 2e18, severity: 1e18, lpYield: 0.1e18,
            utilization: 0.25e18, opsUnits: 100, maxRatioE6: 300_000});
    }

    /// The rules the hook relies on, over the whole domain: legs sum to the premium; the layer's leg is never below the
    /// fee (never negative for us); compensation ≤ min(P, D − P); D > P; the premium respects the max ratio.
    function testFuzz_economyRules(EconomyQuote.Input memory i) public pure {
        i.price = 1 + (i.price % 1e24);
        i.correct = i.correct % 1e9;
        i.incorrect = i.incorrect % 1e9;
        i.lockSeconds = i.lockSeconds % 400 days;
        i.coverMultipleBps = 10_000 + (i.coverMultipleBps % 90_001);
        i.fee = i.fee % (i.price + 1);
        EconomyQuote.Quote memory q = EconomyQuote.quote(i, _base());
        uint256 price = i.price;
        require(q.toBackers + q.toLayer == q.premium, "legs sum to the premium");
        require(q.deposit > price, "D > P");
        require(q.compensation <= price && q.compensation <= q.deposit - price, "compensation bounded");
        require(q.priced >= q.wilson && q.priced >= q.lp + i.fee, "priced is the max");
        if (q.covered) {
            require(q.toLayer >= i.fee, "layer >= fee: never negative for us");
            require(q.toBackers == q.lp && q.toBackers > 0, "backers get exactly their need");
            require(q.premium * 1e6 <= price * 300_000, "max ratio");
            require(i.correct > 0, "a record with a delivery");
            require(q.coverCap == price * i.coverMultipleBps / 10_000, "cap");
        } else {
            require(q.premium == 0 && q.toBackers == 0 && q.toLayer == 0 && q.coverCap == 0, "nothing sold");
        }
    }

    /// Behind WILSON_FFI=1 (forge test --ffi): random rows against the TypeScript through node (test/ffi/economy.ts).
    function testFuzz_ffi_equalsTypeScript(EconomyQuote.Input memory i) public {
        if (!vm.envOr("WILSON_FFI", false)) return;
        i.price = 1 + (i.price % 1e15);
        i.correct = i.correct % 1e7;
        i.incorrect = i.incorrect % 1e6;
        i.lockSeconds = i.lockSeconds % 400 days;
        i.coverMultipleBps = 10_000 + (i.coverMultipleBps % 30_001);
        i.fee = i.fee % 10_000_000;
        string[] memory cmd = new string[](11);
        cmd[0] = "node"; cmd[1] = "--experimental-strip-types"; cmd[2] = "--no-warnings"; cmd[3] = "test/ffi/economy.ts";
        cmd[4] = vm.toString(i.price); cmd[5] = vm.toString(i.correct); cmd[6] = vm.toString(i.incorrect);
        cmd[7] = vm.toString(i.lockSeconds); cmd[8] = i.arbitrator ? "1" : "0"; cmd[9] = vm.toString(i.coverMultipleBps);
        cmd[10] = vm.toString(i.fee);
        bytes memory out = vm.ffi(cmd);
        EconomyQuote.Quote memory q = EconomyQuote.quote(i, _base());
        (uint256 premium, uint256 toBackers, uint256 toLayer, uint256 deposit, uint256 comp) =
            abi.decode(out, (uint256, uint256, uint256, uint256, uint256));
        eq(q.premium, premium, "premium");
        eq(q.toBackers, toBackers, "toBackers");
        eq(q.toLayer, toLayer, "toLayer");
        eq(q.deposit, deposit, "deposit");
        eq(q.compensation, comp, "compensation");
    }
}
