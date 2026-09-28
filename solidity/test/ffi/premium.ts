// FFI helper for solidity/test/WilsonPremium.t.sol: the TypeScript premium for one record, ABI-encoded as
// (bool insurable, uint256 ratioE6, uint256 amount, bool covered) and printed as 0x-hex for vm.ffi.
//   node --experimental-strip-types test/ffi/premium.ts <incorrect> <total> <price>
import { premium, RATIO_SCALE } from '../../../src/wilson.ts';

const [incorrect, total, price] = process.argv.slice(2).map((s) => BigInt(s));
const p = premium({ k: Number(total - incorrect), n: Number(total) }, { price });
const word = (v: bigint) => v.toString(16).padStart(64, '0');
const out = p.insurable
  ? [1n, BigInt(Math.round(p.ratio * RATIO_SCALE)), p.amount ?? 0n, p.covered ? 1n : 0n]
  : [0n, 0n, 0n, 0n];
process.stdout.write('0x' + out.map(word).join(''));
