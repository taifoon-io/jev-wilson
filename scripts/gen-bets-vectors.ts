// Writes tests/vectors/bets-grid.json (price, fee and payout on a grid, default and devnet params) and
// tests/vectors/bets-scenarios.json (the scenario script and its expected result). TypeScript is the generator; Python,
// Solidity and the Solana programs read both files and must return every number to the unit.
import { writeFileSync } from 'node:fs';
import { BETS_DEFAULTS, betsPrice, grossPayout, positionFee, paramsToStrings, runBetsScript, type BetsParams } from '../src/bets.ts';
import { DEVNET_BETS_PARAMS, buildBetsScript } from '../src/bets-scenarios.ts';

const K = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100, 150, 200, 300, 500, 1000, 2735, 10000];
const F = [0, 1, 2, 3, 4, 5, 7, 10, 15, 25, 50, 100];
const LOCK = [0, 60, 600, 4200, 86400, 604800, 2592000];
const X = [1, 999, 1000, 20408, 20409, 100000, 1000000, 123456789, 10n ** 24n];

function grid(params: BetsParams) {
  const rows: string[][] = [];
  for (const k of K) for (const f of F) for (const l of LOCK) {
    const q = betsPrice({ kEff: BigInt(k), f: BigInt(f) }, BigInt(l), params);
    const x = BigInt(X[(k + f + l) % X.length]!);
    rows.push([k, f, l, q.p, q.mean, q.sd, q.risk, q.capital, q.insurable ? 1 : 0, x, grossPayout(x, q.p), positionFee(x, params)].map(String));
  }
  return { params: paramsToStrings(params), columns: ['kEff', 'f', 'lockS', 'p', 'mean', 'sd', 'risk', 'capital', 'insurable', 'x', 'G', 'fee'], rows };
}
writeFileSync(new URL('../tests/vectors/bets-grid.json', import.meta.url), JSON.stringify({ schema: 'taifoon.jev-wilson.bets-grid.v1', sets: { defaults: grid(BETS_DEFAULTS), devnet: grid(DEVNET_BETS_PARAMS) } }) + '\n');
const script = buildBetsScript();
writeFileSync(new URL('../tests/vectors/bets-scenarios.json', import.meta.url), JSON.stringify({ schema: 'taifoon.jev-wilson.bets-scenarios.v1', script, expected: runBetsScript(script) }, null, 1) + '\n');
console.log('wrote bets-grid.json, bets-scenarios.json');
