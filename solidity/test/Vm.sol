// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/// The few Foundry cheatcodes these tests use, declared here so the project needs no dependency.
interface Vm {
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonUint(string calldata json, string calldata key) external pure returns (uint256);
    function parseJsonUintArray(string calldata json, string calldata key) external pure returns (uint256[] memory);
    function parseJsonStringArray(string calldata json, string calldata key) external pure returns (string[] memory);
    function parseJsonBoolArray(string calldata json, string calldata key) external pure returns (bool[] memory);
    function parseJsonBool(string calldata json, string calldata key) external pure returns (bool);
    function parseJsonString(string calldata json, string calldata key) external pure returns (string memory);
    function keyExistsJson(string calldata json, string calldata key) external view returns (bool);
    function parseUint(string calldata s) external pure returns (uint256);
    function toString(uint256 v) external pure returns (string memory);
    function envOr(string calldata name, bool defaultValue) external view returns (bool);
    function ffi(string[] calldata cmd) external returns (bytes memory);
    function expectRevert(bytes calldata revertData) external;
    function assume(bool condition) external pure;
}

abstract contract VmTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function eq(uint256 a, uint256 b, string memory what) internal pure {
        if (a != b) revert(string.concat(what, ": ", _s(a), " != ", _s(b)));
    }

    function _s(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        bytes memory b;
        while (v != 0) { b = abi.encodePacked(bytes1(uint8(48 + (v % 10))), b); v /= 10; }
        return string(b);
    }
}
