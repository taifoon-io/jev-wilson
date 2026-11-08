// jev-wilson/calibration: the versioned calibration of the fee and the premium, one file per chain
// (calibration/<chainId>.json, written by `jev-wilson calibrate <chain>`). A fee config and a quote read their numbers from
// it; verifyCalibration() recomputes everything a file claims from what it recorded, offline, so a hand-edited or stale
// file fails; configDrift() names every config value that disagrees with it.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FEE_PROFILES, gasFloor, jobFee, x402Fee, type FeePolicy, type FeeProfile, type FeeQuote, type GasInputs, type Leg } from './fee.ts';
import { lpPremium, LP_DEFAULTS, type LpParams } from './lp.ts';
import { quoteEconomy, lpPremiumUnits, type EconomyInput, type EconomyQuote } from './economy.ts';

export const CALIBRATION_SCHEMA = 'taifoon.jev-wilson.calibration.v1';
export const CHAIN_ALIASES: Record<string, number> = { base: 8453, arbitrum: 42161, arb: 42161, arc: 5042, robinhood: 4663, monad: 143 };

export type CalLeg = Leg & { key: string; profiles: FeeProfile[]; tx: string | null };
export type Calibration = {
  schema: typeof CALIBRATION_SCHEMA;
  chainId: number; name: string;
  /** bumped whenever the config (fee, legs, premium parameters) changes */ version: number;
  /** measured: every leg's gas comes from a receipt of this chain's line; provisional: some leg stands in from another chain */ status: 'measured' | 'provisional';
  generated_at: string; library: string;
  /** what a fee config reads: the policy plus the measured buffer */ fee: FeePolicy;
  legs: { status: 'measured' | 'provisional'; source: string; measured_at: string | null; provisional_from?: number; provisional_buffer_bps?: number; legs: CalLeg[] };
  /** what lpPremium() reads */ lp: LpParams;
  premium: { lockSeconds: number; arbitrator: boolean; coverMultipleBps: number };
  chain: { fee_model: 'op-stack' | 'arbitrum' | 'none'; gas_token: string; /** percentile: the tip is read at fee.tipPercentile; none: the chain ignores tips */ tip: 'percentile' | 'none'; block_s: number; price: Record<string, unknown>; l1: Record<string, unknown> };
  history: Record<string, unknown> & { rise_bps: Record<string, number>; buffer_bps_history: number; buffer_bps_montecarlo: number; horizon_blocks: number };
  prior: Record<string, unknown> & { a0: number; b0: number };
  /** the live quote's inputs when the calibration ran: the table is computed from them */
  gas_snapshot: { source: string; block: number; at: number; base_fee_wei: string; tip_wei: string; live_buffer_bps: number; l1_fee_wei_by_bytes: Record<string, string>; gas_usd8: string; gas_usd_updated_at: number | null };
  checks: { no_loss: Record<string, unknown> & { pass: boolean }; backer: Record<string, unknown> };
  table: { profile: FeeProfile; rows: TableRow[]; min_price: Record<FeeProfile, string> };
  /** the x402 buyer leg, on a chain whose sellers take x402 (chains.json `x402`): what a hire paid to the seller costs us */
  x402?: X402Block;
  /** a line in another job token than USDC (calibration/<line>-<chainId>.json, e.g. the GRID line); absent on chain files */
  asset?: CalAsset;
  /** which line this file prices and where its gas and legs come from (a line file only) */
  line?: { key: string; chainId: number; borrowed_from: number; generated_by: string; policy: string; readiness?: string };
  config_digest: string;
  digest: string;
};
export type X402Row = { price: string; fee: string; by_bps: string; floored: boolean; share_bps: number; premium_indicative: string; buyer_pays: string };
export type X402Block = {
  network: string; asset: string; scheme: 'exact';
  /** what our side sends on chain for an exact payment: nothing (the seller's facilitator sends the EIP-3009 transfer) */ our_gas_units: '0';
  settle_line: boolean; cover: boolean; note: string;
  /** upto instead of exact: one Permit2 approval of the asset by the payer, priced at the snapshot (provisional approve leg) */
  upto_setup: { leg: string; gas: number; bytes: number; cost_units: string; once: 'per payer and network' };
  rows: X402Row[];
};
/** A line whose job token is not a 6-decimal dollar (the GRID line): its symbol, decimals and dollar peg. fee_decimals =
 *  decimals + log10(1 / peg_usd): the gas floor and the margin (USD) land in the token's smallest units at the peg
 *  (GRID: 18 + 2 = 20, so 1 USDC unit = 1e14 GRID wei). Absent = USDC-like (6 and 6), every chain file today. */
export type CalAsset = { symbol: string; decimals: number; peg_usd: string; fee_decimals: number };
/** the decimals a fee is computed in (fee.ts `decimals`) and the job token's own decimals */
export const feeDecimalsOf = (c: { asset?: CalAsset }): number => c.asset?.fee_decimals ?? 6;
export const tokenDecimalsOf = (c: { asset?: CalAsset }): number => c.asset?.decimals ?? 6;
export type TableRow = { price: string; fee: string | null; premium: string; total: string | null; served: boolean; floored: boolean };

/** Keys sorted, so the same content always hashes the same. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
const sha = (s: string) => '0x' + createHash('sha256').update(s).digest('hex');

/** The config a fee module and a premium module read: what `version` tracks. */
export function configOf(c: Pick<Calibration, 'fee' | 'legs' | 'lp' | 'premium'>) {
  return { fee: c.fee, legs: c.legs.legs.map((l) => ({ key: l.key, gas: l.gas, bytes: l.bytes, who: l.who, profiles: l.profiles })), lp: c.lp, premium: c.premium };
}
export const configDigest = (c: Pick<Calibration, 'fee' | 'legs' | 'lp' | 'premium'>) => sha(canonical(configOf(c)));
export function contentDigest(c: Calibration): string {
  const { digest: _d, generated_at: _g, ...rest } = c;
  return sha(canonical(rest));
}

/** The legs of a profile, in the file's order. */
export function legsOf(c: Pick<Calibration, 'legs'>, profile: FeeProfile): Leg[] {
  return c.legs.legs.filter((l) => l.profiles.includes(profile)).map(({ leg, who, gas, bytes }) => ({ leg, who, gas, bytes }));
}

/** The gas inputs recorded in the file (the live read when it ran). */
export function snapshotInputs(c: Pick<Calibration, 'chainId' | 'gas_snapshot'>): GasInputs {
  const s = c.gas_snapshot;
  return {
    chainId: c.chainId, block: s.block, baseFeeWei: BigInt(s.base_fee_wei), tipWei: BigInt(s.tip_wei), liveBufferBps: s.live_buffer_bps,
    l1FeeWeiByBytes: Object.fromEntries(Object.entries(s.l1_fee_wei_by_bytes).map(([b, v]) => [Number(b), BigInt(v)])), gasUsd8: BigInt(s.gas_usd8),
  };
}

const USDC = 1_000_000n;
const unitsOf = (usdc: number) => BigInt(Math.round(usdc * 1e6));

/** The price table: fee, premium and the buyer's total at each price (USDC), from the file's own snapshot. Pure. */
export function priceTable(c: Pick<Calibration, 'chainId' | 'fee' | 'legs' | 'lp' | 'premium' | 'gas_snapshot' | 'asset'>, prices: readonly number[], profile: FeeProfile = 'stand-in'): Calibration['table'] {
  const gas = snapshotInputs(c);
  const fd = feeDecimalsOf(c);
  // a line in another token (asset set): whole-token prices in its decimals, the premium in exact integers (lpPremiumUnits;
  // the doubles of lpPremium are not exact at 1e20 units). Chain files keep their USDC path byte for byte.
  const unitsOfLine = (p: number) => (c.asset ? BigInt(p) * 10n ** BigInt(c.asset.decimals) : unitsOf(p));
  const lpOf = (price: bigint) => (c.asset
    ? lpPremiumUnits({ price, record: null, lockSeconds: c.premium.lockSeconds, arbitrator: c.premium.arbitrator, coverMultipleBps: c.premium.coverMultipleBps }, c.lp)
    : BigInt(lpPremium({ price: Number(price), record: null, lockSeconds: c.premium.lockSeconds, arbitrator: c.premium.arbitrator, coverMultipleBps: c.premium.coverMultipleBps }, c.lp).premium));
  const rows = prices.map((p): TableRow => {
    const price = unitsOfLine(p);
    const q = jobFee(price, gas, legsOf(c, profile), c.fee, fd);
    const pi = lpOf(price);
    return { price: price.toString(), fee: q.fee?.toString() ?? null, premium: pi.toString(), total: q.fee === null ? null : (price + q.fee + pi).toString(), served: q.served, floored: q.floored };
  });
  const one = c.asset ? 10n ** BigInt(c.asset.decimals) : USDC;
  const min_price = Object.fromEntries(FEE_PROFILES.map((pr) => [pr, jobFee(one, gas, legsOf(c, pr), c.fee, fd).minPrice.toString()])) as Record<FeeProfile, string>;
  return { profile, rows, min_price };
}

/** The x402 buyer-leg table: our fee (max(bps, 0 gas + margin)), the premium a cover pool would charge if one existed
 *  (indicative: no settle line, no pool), and what the buyer pays (price + fee; no cover). Pure. */
export function x402Table(c: Pick<Calibration, 'chainId' | 'fee' | 'legs' | 'lp' | 'premium' | 'gas_snapshot' | 'asset'>, prices: readonly number[], meta: { network: string; asset: string }): X402Block {
  const approve = c.legs.legs.find((l) => l.key === 'approve');
  if (!approve) throw new Error('x402Table: the legs hold no approve leg (the upto setup is priced from it)');
  const setup = gasFloor(snapshotInputs(c), [{ leg: approve.leg, who: approve.who, gas: approve.gas, bytes: approve.bytes }], c.fee, feeDecimalsOf(c));
  return {
    network: meta.network, asset: meta.asset, scheme: 'exact', our_gas_units: '0', settle_line: false, cover: false,
    note: 'exact = EIP-3009 transferWithAuthorization: the seller\'s facilitator sends it and pays its gas, so our gas is 0. No settle line on this chain: the fee is our routing and grade fee (no evaluator fee, no hook cap), and no cover pool exists, so the premium is indicative only and the buyer pays price + fee',
    upto_setup: { leg: 'Permit2 approval of USDC (approve leg, provisional)', gas: approve.gas, bytes: approve.bytes, cost_units: setup.usdc.toString(), once: 'per payer and network' },
    rows: prices.map((p): X402Row => {
      const price = unitsOf(p);
      const q = x402Fee(price, c.fee, 0n, feeDecimalsOf(c));
      const pi = BigInt(lpPremium({ price: Number(price), record: null, lockSeconds: c.premium.lockSeconds, arbitrator: c.premium.arbitrator, coverMultipleBps: c.premium.coverMultipleBps }, c.lp).premium);
      return { price: price.toString(), fee: q.fee.toString(), by_bps: q.byBps.toString(), floored: q.floored, share_bps: q.shareBps, premium_indicative: pi.toString(), buyer_pays: (price + q.fee).toString() };
    }),
  };
}

/** Everything wrong with a file, recomputed offline from what it recorded. [] = it holds. */
export function verifyCalibration(c: Calibration): string[] {
  const bad: string[] = [];
  if (c.schema !== CALIBRATION_SCHEMA) bad.push(`schema ${c.schema} ≠ ${CALIBRATION_SCHEMA}`);
  if (contentDigest(c) !== c.digest) bad.push(`digest: the content hashes to ${contentDigest(c)}, the file says ${c.digest} (hand-edited?)`);
  if (configDigest(c) !== c.config_digest) bad.push(`config_digest: ${configDigest(c)} ≠ ${c.config_digest}`);
  const prices = c.table.rows.map((r) => (c.asset ? Number(BigInt(r.price) / 10n ** BigInt(c.asset.decimals)) : Number(r.price) / 1e6));
  const t = priceTable(c, prices, c.table.profile);
  if (canonical(t) !== canonical(c.table)) bad.push('table: recomputed from the snapshot, fee and legs, it differs from the file');
  if (c.asset) {
    const a = c.asset;
    const peg = Number(a.peg_usd);
    if (!(peg > 0) || Math.round(Math.log10(1 / peg)) + a.decimals !== a.fee_decimals || Math.abs(10 ** (a.fee_decimals - a.decimals) * peg - 1) > 1e-9) bad.push(`asset: fee_decimals ${a.fee_decimals} ≠ decimals ${a.decimals} + log10(1 / peg ${a.peg_usd})`);
    if (c.x402) bad.push('asset: a line file carries no x402 block');
  }
  if (c.x402) {
    const x = x402Table(c, c.x402.rows.map((r) => Number(r.price) / 1e6), c.x402);
    if (canonical(x) !== canonical(c.x402)) bad.push('x402: recomputed from the snapshot, fee and legs, it differs from the file');
  }
  const hist = c.history.buffer_bps_history, mc = c.history.buffer_bps_montecarlo;
  if (c.fee.gasBufferBps !== Math.max(hist, mc)) bad.push(`fee.gasBufferBps ${c.fee.gasBufferBps} ≠ max(history ${hist}, Monte Carlo ${mc})`);
  if (!c.checks.no_loss.pass) bad.push('checks.no_loss failed: a served job lost money in the Monte Carlo');
  if (c.status === 'measured' && c.legs.status !== 'measured') bad.push('status measured with provisional legs');
  for (const pr of FEE_PROFILES) if (!legsOf(c, pr).length) bad.push(`profile ${pr} has no legs`);
  return bad;
}

/** Where the bundled calibrations live (the package's calibration/ directory). */
export const CALIBRATION_DIR = new URL('../calibration/', import.meta.url);

/** A chain's calibration from `dir` (default: the one this package ships). Throws when there is none. */
export function loadCalibration(chain: number | string, dir: URL | string = CALIBRATION_DIR): Calibration {
  const id = typeof chain === 'number' ? chain : CHAIN_ALIASES[chain.toLowerCase()] ?? Number(chain);
  const file = typeof dir === 'string' ? join(dir, `${id}.json`) : new URL(`${id}.json`, dir);
  if (!existsSync(file)) throw new Error(`no calibration for chain ${chain}: run jev-wilson calibrate ${chain}`);
  return JSON.parse(readFileSync(file, 'utf8')) as Calibration;
}

/** The lines priced in another job token than the chain's dollar: calibration/<line>-<chainId>.json (generated by
 *  scripts/gen-<line>-calibration.ts from calibration/lines/<line>.json; never by `calibrate`). */
export const LINE_CALIBRATIONS: Readonly<Record<string, readonly number[]>> = Object.freeze({ grid: Object.freeze([3692781]) });

/** A line's calibration (e.g. loadLineCalibration('grid', 3692781): the GRID line on Taifoon mainnet). Throws when there is none. */
export function loadLineCalibration(line: string, chainId: number, dir: URL | string = CALIBRATION_DIR): Calibration {
  const name = `${line.toLowerCase()}-${chainId}.json`;
  if (!/^[a-z0-9]+-\d+\.json$/.test(name)) throw new Error(`bad line ${line}`);
  const file = typeof dir === 'string' ? join(dir, name) : new URL(name, dir);
  if (!existsSync(file)) throw new Error(`no calibration for the ${line} line on chain ${chainId}`);
  return JSON.parse(readFileSync(file, 'utf8')) as Calibration;
}

/** The config values that disagree with the calibration (env overrides, a stale copy). [] = in step. */
export function configDrift(c: Pick<Calibration, 'fee'>, config: Partial<FeePolicy>): string[] {
  return (Object.keys(config) as (keyof FeePolicy)[]).filter((k) => config[k] !== undefined && config[k] !== c.fee[k]).map((k) => `${k}: config ${config[k]} ≠ calibration ${c.fee[k]}`);
}

/** lpPremium's parameters with a calibration's fitted prior. */
export function lpParamsOf(c: Pick<Calibration, 'lp'>): LpParams {
  return { ...LP_DEFAULTS, ...c.lp };
}

// ---------------------------------------------------------------------------------------------------------------------
// The economy on a chain's calibration (economy.ts quoteEconomy with F from jobFee on the calibrated legs).

export type CalibratedEconomy = EconomyQuote & {
  chainId: number;
  /** the fee quote F came from; covered is false (reason BELOW_MIN_PRICE) when the hook cap refuses the fee */
  feeQuote: FeeQuote;
  served: boolean;
  calibration: { version: number; digest: string; profile: FeeProfile };
};

/** quoteEconomy with F from the chain's calibration: jobFee on `gas` (default: the file's own snapshot) over the profile's
 *  legs, and lpPremium on the file's lp parameters. A price below the line's min_price (fee over the hook's cap) is not
 *  covered (reason BELOW_MIN_PRICE); deposit and compensation are still quoted with F = the fee floor. */
export function quoteEconomyFor(
  cal: Pick<Calibration, 'chainId' | 'version' | 'digest' | 'fee' | 'legs' | 'lp' | 'premium' | 'gas_snapshot' | 'asset'>,
  input: Omit<EconomyInput, 'fee' | 'lockSeconds' | 'arbitrator' | 'coverMultipleBps'> & Partial<Pick<EconomyInput, 'lockSeconds' | 'arbitrator' | 'coverMultipleBps'>> & { gas?: GasInputs; profile?: FeeProfile },
): CalibratedEconomy {
  const profile = input.profile ?? 'stand-in';
  // F in the job token's smallest units: USDC-like by default; a line in another token (GRID) converts our gas and margin
  // at its peg (fee_decimals)
  const fq = jobFee(input.price, input.gas ?? snapshotInputs(cal), legsOf(cal, profile), cal.fee, feeDecimalsOf(cal));
  const fee = fq.fee ?? fq.floor;
  const q = quoteEconomy({
    price: input.price, record: input.record, fee,
    lockSeconds: input.lockSeconds ?? cal.premium.lockSeconds,
    arbitrator: input.arbitrator ?? cal.premium.arbitrator,
    coverMultipleBps: input.coverMultipleBps ?? cal.premium.coverMultipleBps,
  }, cal.lp);
  const out: CalibratedEconomy = { ...q, chainId: cal.chainId, feeQuote: fq, served: fq.served, calibration: { version: cal.version, digest: cal.digest, profile } };
  if (!fq.served && q.insurable) {
    return { ...out, covered: false, reason: 'BELOW_MIN_PRICE', premium: 0n, toBackers: 0n, toLayer: 0n, coverCap: 0n };
  }
  return out;
}
