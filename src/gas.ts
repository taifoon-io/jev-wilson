// jev-wilson/gas: the backers' gas per job (LpParams.opsUnits) from a per-chain gas reading.
//
// lpPremium() charges the backers' own deposit and withdraw gas, spread over the jobs one deposit backs, as `opsUnits`
// (the token's smallest unit). That cost is per chain: a Base deposit and an Arbitrum one cost different gas at different
// prices, and Arc pays gas in USDC. opsUnitsFromGas() turns one gas cost — the native amount, the native token's
// decimals and its USD price with 8 decimals (a Chainlink answer) — into opsUnits, in integers only, rounded up (the
// backers never under-charge their gas). gasCostFromRazor() reads that cost from a razor quote
// (GET /v1/gas/{chain}/quote?gas=<deposit + withdraw gas>&bytes=<size>&txs=2 → quote.total_wei | total_lamports,
// reading.native.decimals, reading.native.usd8), so the premium on any chain razor prices takes its live gas:
//
//   lpPremium(input, { opsUnits: opsUnitsFromGas(gasCostFromRazor(quote), jobsPerDeposit) })
//
// The Python twin (python/taifoon_jev_wilson/gas.py) returns the same integer on tests/vectors/gas-ops.json.

/** One gas cost: `amount` in the native token's smallest unit, its `decimals`, and its USD price × 1e8. */
export type GasCost = { amount: string | bigint; decimals: number; usd8: string | bigint };

/** The fields of a razor quote (schema taifoon.razor.quote.v1) this module reads. */
export type RazorQuote = {
  quote: { total_wei?: string; total_lamports?: string };
  reading: { native: { decimals: number; usd8: string | null } };
};

const big = (x: string | bigint, what: string): bigint => {
  if (typeof x === 'bigint') { if (x < 0n) throw new Error(`${what} must be ≥ 0`); return x; }
  if (!/^\d+$/.test(x)) throw new Error(`${what} must be a non-negative integer string`);
  return BigInt(x);
};

/** ceil(amount × usd8 × 10^tokenDecimals / (10^decimals × 1e8 × jobsPerDeposit)): the gas of one deposit cycle in the
 *  job token's smallest unit (a USD stablecoin), per job it backs. Integers only. */
export function opsUnitsFromGas(cost: GasCost, jobsPerDeposit: number, tokenDecimals = 6): number {
  if (!Number.isInteger(jobsPerDeposit) || jobsPerDeposit < 1) throw new Error('jobsPerDeposit must be an integer ≥ 1');
  if (!Number.isInteger(cost.decimals) || cost.decimals < 0 || cost.decimals > 36) throw new Error('decimals must be an integer in [0, 36]');
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 36) throw new Error('tokenDecimals must be an integer in [0, 36]');
  const num = big(cost.amount, 'amount') * big(cost.usd8, 'usd8') * 10n ** BigInt(tokenDecimals);
  const den = 10n ** BigInt(cost.decimals) * 100_000_000n * BigInt(jobsPerDeposit);
  const units = (num + den - 1n) / den;
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('opsUnits exceeds 2^53 - 1: check decimals and amount');
  return Number(units);
}

/** The gas cost a razor quote names (EVM total_wei or Solana total_lamports, priced by the reading's native USD). */
export function gasCostFromRazor(q: RazorQuote): GasCost {
  const amount = q.quote.total_wei ?? q.quote.total_lamports;
  if (amount == null) throw new Error('the razor quote has no total_wei or total_lamports');
  if (q.reading.native.usd8 == null) throw new Error('the razor reading has no USD price');
  return { amount, decimals: q.reading.native.decimals, usd8: q.reading.native.usd8 };
}
