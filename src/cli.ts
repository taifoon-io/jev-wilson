#!/usr/bin/env node
// npx @taifoon/jev-wilson mcp                 start the stdio MCP server
// npx @taifoon/jev-wilson premium <k> <n> [price]
// npx @taifoon/jev-wilson listing <k> <n>
// npx @taifoon/jev-wilson calibrate <base|arbitrum|arc|robinhood|monad|chainId|all> [--out dir] [--compare] …
// npx @taifoon/jev-wilson calibration check [dir] | show <chain> [dir]
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from './mcp.ts';
import { listing, premium } from './wilson.ts';
import { calibrate, chainIdOf, configChanges } from './calibrate.ts';
import { CALIBRATION_DIR, loadCalibration, verifyCalibration } from './calibration.ts';

const [cmd, ...rest] = process.argv.slice(2);
const out = (v: unknown) => console.log(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2));
const flag = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? (rest[i + 1] ?? '') : undefined; };
const has = (name: string) => rest.includes(`--${name}`);
const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1]!.startsWith('--') && !['--compare', '--no-razor', '--no-rotation', '--quiet'].includes(rest[i - 1]!)));
const PKG_DIR = fileURLToPath(CALIBRATION_DIR);
const usd = (units: string | null) => (units === null ? '—' : (Number(units) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, ''));
const CHAINS = ['base', 'arbitrum', 'arc', 'robinhood', 'monad'];

function table(dir: string, chain: string) {
  const c = loadCalibration(chain, dir);
  console.log(`${c.name} (${c.chainId}) calibration v${c.version}, ${c.status}, ${c.generated_at}  digest ${c.digest}`);
  console.log(`  fee = max(${c.fee.bps} bps, our ${c.table.profile} gas at the quoted gas price (buffer ${c.fee.gasBufferBps} bps) + ${c.fee.marginUsdc}); premium = lpPremium, ${c.premium.arbitrator ? 'with' : 'no'} arbitrator`);
  console.log(`  gas at block ${c.gas_snapshot.block}: base fee ${c.gas_snapshot.base_fee_wei} wei, tip ${c.gas_snapshot.tip_wei} wei, gas token ${usd(String(BigInt(c.gas_snapshot.gas_usd8) / 100n))} USD`);
  console.log('  price | our fee | premium | buyer pays');
  for (const r of c.table.rows) console.log(`  ${usd(r.price)} | ${r.served ? usd(r.fee) : 'refused'} | ${usd(r.premium)} | ${r.served ? usd(r.total) : '—'}`);
  if (c.x402) {
    const x = c.x402;
    console.log(`  x402 buyer leg on ${x.network} (${x.asset}): ${x.scheme} = EIP-3009, our gas ${x.our_gas_units}; no settle line, so the fee is our routing and grade fee and there is no cover`);
    console.log('  price | our fee | share of price | buyer pays | premium if a pool existed');
    for (const r of x.rows) console.log(`  ${usd(r.price)} | ${usd(r.fee)}${r.floored ? ' (margin)' : ''} | ${(r.share_bps / 100).toFixed(2)} % | ${usd(r.buyer_pays)} | ${usd(r.premium_indicative)}`);
    console.log(`  upto instead of exact: one Permit2 approval per payer, ${x.upto_setup.gas} gas, ${usd(x.upto_setup.cost_units)} USDC at this snapshot`);
  }
  console.log(`  smallest price served: direct ${usd(c.table.min_price.direct)}, stand-in ${usd(c.table.min_price['stand-in'])}, relayed ${usd(c.table.min_price.relayed)}`);
  const nl = c.checks.no_loss as { pass: boolean; samples: number; profiles: { profile: string; served_share: number; A: { losses: number; loss_share: number; worst_margin_usdc: number }; B: { losses: number; mean_margin_usdc: number; wait_p95_s: number; wait_max_s: number } }[] };
  console.log(`  no-loss Monte Carlo (${nl.samples} jobs per profile, legs capped at the quoted gas price): ${nl.pass ? 'no served job lost money' : 'FAILED'}`);
  for (const p of nl.profiles) console.log(`    ${p.profile}: served ${(p.served_share * 100).toFixed(1)} %, mean margin ${p.B.mean_margin_usdc.toFixed(6)}, wait p95 ${p.B.wait_p95_s} s, max ${p.B.wait_max_s} s; sent at once instead: ${p.A.losses} losses (${(p.A.loss_share * 100).toFixed(2)} %), worst ${p.A.worst_margin_usdc.toFixed(6)}`);
}

if (cmd === 'mcp') serve();
else if (cmd === 'premium' && rest.length >= 2) out(premium({ k: Number(rest[0]), n: Number(rest[1]) }, rest[2] ? { price: rest[2] } : {}));
else if (cmd === 'listing' && rest.length >= 2) out(listing(Number(rest[0]), Number(rest[1])));
else if (cmd === 'calibrate' && positional.length >= 1) {
  const dir = flag('in') ?? PKG_DIR;
  // the bundled calibrations are read-only: with no --out, a run writes ./calibration in the working directory
  const outDir = flag('out') ?? (dir === PKG_DIR ? 'calibration' : dir);
  const chains = positional[0] === 'all' ? CHAINS : positional;
  let regime = false;
  for (const c of chains) {
    const t0 = Date.now();
    const { cal, changed, regime: reg, prev, file } = await calibrate(c, {
      dir, out: outDir, compare: has('compare'), days: flag('days') ? Number(flag('days')) : undefined, maxCalls: flag('max-calls') ? Number(flag('max-calls')) : undefined,
      samples: flag('samples') ? Number(flag('samples')) : undefined, sims: flag('sims') ? Number(flag('sims')) : undefined,
      receipts: flag('receipts'), plan: flag('plan'), historyFile: flag('history') ? flag('history')!.replace('{chain}', String(chainIdOf(c))) : undefined, razor: has('no-razor') ? null : undefined, rotation: has('no-rotation') ? null : undefined,
      log: has('quiet') ? undefined : (s) => console.error(s),
    });
    const what = changed ? configChanges(prev, cal) : [];
    regime ||= reg.length > 0;
    console.error(`${cal.name}: v${cal.version} ${changed ? `CHANGED (${what.join('; ')})` : 'unchanged'}${reg.length ? ` — gas-regime change: ${reg.join('; ')}` : ''}${has('compare') ? ' (compare: nothing written)' : ` → ${file}`} in ${Math.round((Date.now() - t0) / 1000)} s`);
    if (!has('compare')) table(outDir!, String(chainIdOf(c)));
  }
  process.exit(has('compare') && regime ? 2 : 0);
} else if (cmd === 'calibration' && rest[0] === 'check') {
  const dir = rest[1] ?? PKG_DIR;
  const files = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
  let bad = 0;
  for (const f of files) {
    const c = loadCalibration(f.replace('.json', ''), dir);
    const p = verifyCalibration(c);
    bad += p.length ? 1 : 0;
    console.log(`${p.length ? 'FAIL' : 'ok  '} ${c.name} (${c.chainId}) v${c.version} ${c.status}${p.length ? `\n     ${p.join('\n     ')}` : ''}`);
  }
  if (!files.length) { console.error(`no calibration in ${dir}`); process.exit(1); }
  process.exit(bad ? 1 : 0);
} else if (cmd === 'calibration' && rest[0] === 'show' && rest[1]) table(rest[2] ?? PKG_DIR, rest[1]);
else {
  console.error('usage: jev-wilson mcp | premium <k> <n> [price] | listing <k> <n>\n'
    + '       jev-wilson calibrate <base|arbitrum|arc|robinhood|monad|<chainId>|all> [--out <dir>, default ./calibration] [--compare] [--days 2] [--samples 20000] [--sims 1000] [--receipts f --plan f] [--history file-{chain}.json] [--no-razor]\n'
    + '       jev-wilson calibration check [dir] | show <chain> [dir]');
  process.exit(cmd ? 1 : 0);
}
