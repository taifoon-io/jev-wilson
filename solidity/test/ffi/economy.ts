// FFI helper for solidity/test/EconomyQuote.t.sol: the TypeScript quoteEconomy for one row on the Base parameters,
// ABI-encoded as (premium, toBackers, toLayer, deposit, compensation) and printed as 0x-hex for vm.ffi.
//   node --experimental-strip-types test/ffi/economy.ts <price> <correct> <incorrect> <lock> <arb 0|1> <multipleBps> <fee>
import { quoteEconomy } from '../../../src/economy.ts';

const a = process.argv.slice(2);
const q = quoteEconomy({
  price: BigInt(a[0]!), record: { correct: Number(a[1]), incorrect: Number(a[2]) }, lockSeconds: Number(a[3]),
  arbitrator: a[4] === '1', coverMultipleBps: Number(a[5]), fee: BigInt(a[6]!),
});
const word = (v: bigint) => v.toString(16).padStart(64, '0');
process.stdout.write('0x' + [q.premium, q.toBackers, q.toLayer, q.deposit, q.compensation].map(word).join(''));
