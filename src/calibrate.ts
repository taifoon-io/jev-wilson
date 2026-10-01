// jev-wilson calibrate <chain>: the whole calibration of one chain in one command, written to calibration/<chainId>.json.
//
//   1. fee history       the chain's base fee and tips over `days` (razor gas service, else eth_feeHistory): the p95 rise of
//                        the base fee over the quote's validity + the settle horizon → the gas buffer
//   2. legs              gas per leg of a job, from receipts (a rehearsal's receipts file, or on-chain tx hashes re-read)
//   3. prior             Beta(a0, b0) fitted to the chain's seller records (the coordination layer's /v1/pools)
//   4. no-loss check     the Monte Carlo of the fee over the history; the buffer rises until no served job loses money
//   5. backer returns    the Monte Carlo of a cover pool's year under lpPremium
//   6. price table       fee, premium and the buyer's total at each price, from a live read of today's gas (and, on a chain
//                        whose sellers take x402, the buyer leg: a hire paid to the seller by x402, our gas 0 on exact)
//
// Read-only: it reads public RPCs and public APIs and signs nothing. `--compare` writes nothing and exits 2 when the
// config (fee, legs, premium parameters) would change: the scheduled run uses it to tell a gas-regime change.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FEE_PROFILES, windowRises, windowRiseBps, type FeePolicy, type FeeProfile } from './fee.ts';
import { LP_DEFAULTS } from './lp.ts';
import { fitPrior } from './prior.ts';
import { gasSource, isNoHistory, word, encUint, SEL, type FeeRow, type GasSource } from './gas-source.ts';
import { noLoss, backerReturns, type McPolicy, type BackerPolicy, type Segment } from './montecarlo.ts';
import {
  CALIBRATION_SCHEMA, CHAIN_ALIASES, configDigest, contentDigest, priceTable, verifyCalibration, x402Table,
  type Calibration, type CalLeg,
} from './calibration.ts';

type ChainProfile = {
  name: string; fee_model: 'op-stack' | 'arbitrum' | 'none'; gas_token: string; gas_token_vol_per_hour: number;
  price: { kind: 'chainlink'; chain: number; feed: string; pair: string } | { kind: 'fixed'; usd8: string; why: string };
  l1: { kind: 'op-gas-price-oracle' | 'arb-gas-info'; address: string } | { kind: 'none' };
  tip: 'percentile' | 'none'; rpcs: string[]; policy: Partial<FeePolicy>;
  /** the chain's sellers take x402: the buyer leg is calibrated too */ x402?: { network: string; asset: string };
};
type Chains = { chains: Record<string, ChainProfile>; rotation: string; razor: string; sellers: string };
type Policy = {
  fee: Omit<FeePolicy, 'gasBufferBps'>; buffer: { quantile: number; roundUpBps: number; regimeBps?: number };
  premium: { lockSeconds: number; arbitrator: boolean; coverMultipleBps: number }; table: { prices: number[]; profile: FeeProfile };
  history: { days: number; maxCalls: number; maxHeaders?: number }; montecarlo: McPolicy; backer: BackerPolicy; provisionalLegsBufferBps?: number;
  x402?: { prices: number[] };
};
type LegsFile = { chainId: number; status: 'measured' | 'provisional'; source: string; measured_at: string | null; provisional_from?: number; legs: CalLeg[] };

export type CalibrateOpts = {
  /** inputs: chains.json, policy.json, legs/ */ dir: string; /** where <chainId>.json is written (default: dir) */ out?: string; days?: number; maxCalls?: number; samples?: number; sims?: number; receipts?: string; plan?: string;
  compare?: boolean; /** keep the fee history here and reuse it when present (a rerun on the same history) */ historyFile?: string; rotation?: string | null; razor?: string | null; sellersUrl?: string; log?: (s: string) => void; now?: Date;
};

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const PROVISIONAL_LEGS_BUFFER_BPS = 2_500;

export function chainIdOf(arg: string): number {
  const id = CHAIN_ALIASES[arg.toLowerCase()] ?? Number(arg);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`unknown chain ${arg} (base, arbitrum, arc, robinhood, monad or a chain id)`);
  return id;
}

/** Stage 1: fee history, as contiguous segments (the whole period when it fits in maxCalls windows, else evenly spread). */
async function readHistory(src: GasSource, chainId: number, days: number, maxCalls: number, maxHeaders: number, horizonS: number, tipPct: number, log: (s: string) => void) {
  const head = await src.head(chainId);
  const probe = 20_000;
  const [hb, ob] = await Promise.all([src.rpc(chainId, 'eth_getBlockByNumber', ['0x' + head.toString(16), false]), src.rpc(chainId, 'eth_getBlockByNumber', ['0x' + (head - probe).toString(16), false])]);
  const blockS = (Number(hb.timestamp) - Number(ob.timestamp)) / probe;
  const span = Math.ceil((days * 86_400) / blockS);
  const horizonBlocks = Math.ceil(horizonS / blockS);
  const tail = Math.ceil(8_000 / blockS);
  const ranges: [number, number][] = [];
  if (Math.ceil(span / 1024) <= maxCalls) ranges.push([head - span + 1, head]);
  else {
    const segLen = Math.ceil(Math.max(3 * horizonBlocks, 1024 + 2 * tail) / 1024) * 1024;
    const k = Math.max(1, Math.floor(maxCalls / (segLen / 1024)));
    const gap = Math.floor((span - segLen) / Math.max(1, k - 1));
    for (let i = 0; i < k; i++) { const to = head - i * gap; ranges.push([to - segLen + 1, to]); }
  }
  const segments: Segment[] = [];
  try {
    for (const [a, b] of ranges) {
      log(`  history ${chainId}: blocks ${a}–${b}`);
      segments.push({ rows: await src.history(chainId, a, b, tipPct) });
    }
  } catch (e) {
    if (!isNoHistory(e) || !src.sampled) throw e;
    // the chain's public nodes keep no old state: sample block headers instead, one contiguous span, ≤ maxHeaders headers
    const stride = Math.max(1, Math.ceil(span / maxHeaders));
    log(`  history ${chainId}: eth_feeHistory refused old blocks (${(e as Error).message.slice(0, 80)}): every ${stride}th block header instead`);
    const rows = await src.sampled(chainId, head - span + 1, head, stride);
    return { head, blockS, horizonBlocks, segments: [{ rows }], ranges: [[head - span + 1, head]] as [number, number][], stride };
  }
  return { head, blockS, horizonBlocks, segments, ranges, stride: 1 };
}

/** The live gas inputs, as the quote reads them: razor's answer when it is there and fresh, else JSON-RPC (feeHistory over
 *  1,024 blocks, the price feed, the L1 fee per leg size). */
async function readSnapshot(src: GasSource, chainId: number, ch: ChainProfile, fee: FeePolicy, sizes: number[], horizonBlocks: number) {
  const horizonS = fee.quoteTtlS + fee.settleHorizonS;
  const nowS = Math.floor(Date.now() / 1000);
  const checkAge = (usd8: bigint, updatedAt: number | null) => {
    if (ch.price.kind === 'fixed') return;
    const age = nowS - (updatedAt ?? 0);
    if (usd8 <= 0n || age > fee.maxPriceAgeS) throw new Error(`${ch.price.pair} is ${age} s old (limit ${fee.maxPriceAgeS})`);
  };
  const rz = await src.now?.(chainId);
  const pct = `p${fee.tipPercentile}`;
  if (rz && rz.l1Model === ch.fee_model && (ch.tip === 'none' || rz.tips[pct] !== undefined) && (ch.price.kind === 'fixed' ? rz.usd8 === BigInt(ch.price.usd8) : rz.usd8 > 0n)) {
    checkAge(rz.usd8, rz.usdUpdatedAt);
    const l1: Record<string, string> = {};
    for (const b of sizes) {
      if (ch.l1.kind === 'op-gas-price-oracle') l1[b] = (rz.l1ByBytes[b] ?? word(await src.rpc(chainId, 'eth_call', [{ to: ch.l1.address, data: SEL.getL1FeeUpperBound + encUint(b) }, 'latest']), 0)).toString();
      else if (ch.l1.kind === 'arb-gas-info') l1[b] = (rz.arbPerTx! + rz.arbPerByte! * BigInt(b)).toString();
    }
    let live = rz.rise && rz.rise.horizonS === horizonS ? rz.rise.p95Bps : null;
    if (live === null) {
      const fh = await src.rpc(chainId, 'eth_feeHistory', ['0x400', 'latest', []]);
      live = windowRiseBps(fh.baseFeePerGas.map((x: string) => BigInt(x)).slice(0, -1), horizonBlocks);
    }
    return {
      source: 'razor', block: rz.block, at: rz.at, base_fee_wei: rz.baseFeeWei.toString(), tip_wei: (ch.tip === 'none' ? 0n : rz.tips[pct]!).toString(),
      live_buffer_bps: live, l1_fee_wei_by_bytes: l1, gas_usd8: rz.usd8.toString(), gas_usd_updated_at: rz.usdUpdatedAt,
    };
  }
  const fh = await src.rpc(chainId, 'eth_feeHistory', ['0x400', 'latest', [fee.tipPercentile]]);
  const baseFees: bigint[] = fh.baseFeePerGas.map((x: string) => BigInt(x));
  const tips = ((fh.reward ?? []) as string[][]).map((r) => BigInt(r[0] ?? 0)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const tip = ch.tip === 'none' ? 0n : tips.length ? tips[Math.floor(tips.length / 2)]! : 0n;
  let gasUsd8: bigint, updatedAt: number | null = null;
  if (ch.price.kind === 'fixed') gasUsd8 = BigInt(ch.price.usd8);
  else {
    const h = await src.rpc(ch.price.chain, 'eth_call', [{ to: ch.price.feed, data: SEL.latestRoundData }, 'latest']);
    gasUsd8 = word(h, 1); updatedAt = Number(word(h, 3));
    checkAge(gasUsd8, updatedAt);
  }
  const l1: Record<string, string> = {};
  if (ch.l1.kind === 'op-gas-price-oracle') {
    for (const b of sizes) l1[b] = word(await src.rpc(chainId, 'eth_call', [{ to: ch.l1.address, data: SEL.getL1FeeUpperBound + encUint(b) }, 'latest']), 0).toString();
  } else if (ch.l1.kind === 'arb-gas-info') {
    const h = await src.rpc(chainId, 'eth_call', [{ to: ch.l1.address, data: SEL.getPricesInWei }, 'latest']);
    const perTx = word(h, 0), perByte = word(h, 1);
    for (const b of sizes) l1[b] = (perTx + perByte * BigInt(b)).toString();
  }
  return {
    source: 'json-rpc', block: Number(fh.oldestBlock) + baseFees.length - 1, at: nowS, base_fee_wei: baseFees[baseFees.length - 1]!.toString(), tip_wei: tip.toString(),
    live_buffer_bps: windowRiseBps(baseFees.slice(0, -1), horizonBlocks), l1_fee_wei_by_bytes: l1, gas_usd8: gasUsd8.toString(), gas_usd_updated_at: updatedAt,
  };
}

/** Stage 2: legs. A rehearsal's receipts (kms-exec plan + receipts) replace the manifest; on-chain tx hashes are re-read. */
async function readLegs(src: GasSource, chainId: number, ch: ChainProfile, file: LegsFile, opts: CalibrateOpts, policy: Policy, today: string) {
  const legs = file.legs.map((l) => ({ ...l }));
  let status = file.status, source = file.source, measuredAt = file.measured_at, from = file.provisional_from;
  if (opts.receipts) {
    if (!opts.plan) throw new Error('--receipts needs --plan (the plan the receipts belong to: it holds each transaction\'s calldata)');
    const rc = readJson<{ chainId: number; digest: string; txs: { i: number; signer: string; what: string; gas_used: string; status: number }[] }>(opts.receipts);
    const pl = readJson<{ chainId: number; digest: string; rpc_block: number; txs: { i: string | number; fn: string | null; data: string; signer: string }[] }>(opts.plan);
    if (rc.digest !== pl.digest) throw new Error('the receipts and the plan have different digests');
    const role = (s: string) => (/stand-?in/i.test(s) ? 'stand-in' : /evaluator/i.test(s) ? 'evaluator' : 'relayer');
    const fnOf = (w: string | null) => (w ?? '').split('(')[0]!.split('.').pop()!;
    const txs = pl.txs.map((t, i) => ({ who: role(t.signer), fn: fnOf(t.fn), bytes: (t.data.length - 2) / 2 + 120, gas: Number(rc.txs[i]!.gas_used), ok: rc.txs[i]!.status === 1 }));
    const find = (who: string, fn: string, after = -1) => txs.findIndex((t, i) => i > after && t.who === who && t.fn === fn && t.ok);
    const iOpen = find('relayer', 'openJobWithSpec');
    const iRelayApprove = iOpen > 0 && txs[iOpen - 1]!.who === 'relayer' && txs[iOpen - 1]!.fn === 'approve' ? iOpen - 1 : -1;
    const at: Record<string, number> = {
      'relay-approve': iRelayApprove, 'relay-open': iOpen, approve: find('stand-in', 'approve'), accept: find('stand-in', 'accept'),
      submit: find('stand-in', 'submitWithDelivery'), verdict: find('evaluator', 'postVerdict'), forward: find('stand-in', 'transfer'),
    };
    for (const l of legs) {
      const i = at[l.key];
      if (i === undefined || i < 0) throw new Error(`the receipts hold no ${l.key} leg`);
      l.gas = txs[i]!.gas; l.bytes = txs[i]!.bytes;
    }
    status = 'measured'; from = undefined; measuredAt = today;
    source = `${pl.chainId === chainId ? '' : `chain ${pl.chainId}: `}rehearsal at block ${pl.rpc_block.toLocaleString('en-US')} (plan digest ${pl.digest}); receipts re-read`;
    if (pl.chainId !== chainId) { status = 'provisional'; from = pl.chainId; }
  }
  for (const l of legs) {
    if (!l.tx) continue;
    const r = await src.rpc(chainId, 'eth_getTransactionReceipt', [l.tx]);
    if (!r || Number(r.status) !== 1) throw new Error(`leg ${l.key}: ${l.tx} has no successful receipt on ${chainId}`);
    // Arbitrum counts the L1 data charge as gas (gasUsedForL1); the fee prices L1 separately, so keep the execution gas
    l.gas = Number(r.gasUsed) - (ch.fee_model === 'arbitrum' ? Number(r.gasUsedForL1 ?? 0) : 0);
  }
  const bufBps = policy.provisionalLegsBufferBps ?? PROVISIONAL_LEGS_BUFFER_BPS;
  const out: CalLeg[] = legs.map((l) => (status === 'provisional' ? { ...l, measured_gas: l.gas, gas: Math.ceil((l.gas * (10_000 + bufBps)) / 10_000) } : l) as CalLeg);
  return { status, source, measured_at: measuredAt, ...(from ? { provisional_from: from, provisional_buffer_bps: bufBps } : {}), legs: out } as Calibration['legs'];
}

/** Stage 3: the sellers' records on this chain (or Base's, when the chain has none yet). */
async function readSellers(url: string, chainId: number) {
  const recs: { correct: number; incorrect: number }[] = [];
  let offset = 0, servedChain = chainId, total = 0, onChain = true;
  for (let guard = 0; guard < 50; guard++) {
    const r = await fetch(url.replace('{chain}', String(chainId)).replace('{offset}', String(offset)), { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`sellers: ${r.status}`);
    const j = (await r.json()) as { chain?: { chainId?: number; assuranceDeployed?: boolean }; pools?: { history?: { record?: { correct?: number; incorrect?: number } } }[]; next_offset?: number | null; total?: number };
    // the record is cross-chain: a chain with no assurance layer answers with the same sellers (their record is not its own)
    servedChain = j.chain?.chainId ?? chainId; total = j.total ?? 0; onChain = j.chain?.assuranceDeployed !== false;
    for (const p of j.pools ?? []) { const rec = p.history?.record; if (rec) recs.push({ correct: rec.correct ?? 0, incorrect: rec.incorrect ?? 0 }); }
    if (j.next_offset === null || j.next_offset === undefined) break;
    offset = j.next_offset;
  }
  return { recs, servedChain, total, onChain };
}

export async function calibrate(chainArg: string, opts: CalibrateOpts): Promise<{ cal: Calibration; changed: boolean; regime: string[]; prev: Calibration | null; file: string }> {
  const log = opts.log ?? (() => {});
  const chainId = chainIdOf(chainArg);
  const chains = readJson<Chains>(join(opts.dir, 'chains.json'));
  const ch = chains.chains[String(chainId)];
  if (!ch) throw new Error(`chain ${chainId} is not in ${join(opts.dir, 'chains.json')}`);
  const policy = readJson<Policy>(join(opts.dir, 'policy.json'));
  const legsFile = readJson<LegsFile>(join(opts.dir, 'legs', `${chainId}.json`));
  const outDir = opts.out ?? opts.dir;
  const file = join(outDir, `${chainId}.json`);
  const prevFile = [file, join(opts.dir, `${chainId}.json`)].find((f) => existsSync(f));
  const prev = prevFile ? readJson<Calibration>(prevFile) : null;
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const mc: McPolicy = { ...policy.montecarlo, samples: opts.samples ?? policy.montecarlo.samples };
  const bp: BackerPolicy = { ...policy.backer, sims: opts.sims ?? policy.backer.sims };
  const base: Omit<FeePolicy, 'gasBufferBps'> = { ...policy.fee, ...ch.policy };
  const src = gasSource({ rotation: opts.rotation === null ? undefined : opts.rotation ?? chains.rotation, razor: opts.razor === null ? null : opts.razor ?? chains.razor, rpcs: { [chainId]: ch.rpcs, ...(ch.price.kind === 'chainlink' ? { [ch.price.chain]: chains.chains[String(ch.price.chain)]?.rpcs ?? [] } : {}) }, log });

  log(`${ch.name} (${chainId}): 1/6 fee history`);
  src.used.clear();
  type Hist = Awaited<ReturnType<typeof readHistory>>;
  let H: Hist;
  if (opts.historyFile && existsSync(opts.historyFile)) {
    const j = readJson<Omit<Hist, 'segments'> & { segments: { rows: (string | number)[][] }[] }>(opts.historyFile);
    H = { ...j, segments: j.segments.map((sg) => ({ rows: sg.rows.map((r) => [Number(r[0]), BigInt(r[1]!), BigInt(r[2]!), BigInt(r[3]!), BigInt(r[4]!)] as FeeRow) })) };
    src.used.add(`a saved history (${opts.historyFile.split('/').pop()})`);
    log(`  history ${chainId}: reused ${H.segments.reduce((a, x) => a + x.rows.length, 0)} rows`);
  } else {
    H = await readHistory(src, chainId, opts.days ?? policy.history.days, opts.maxCalls ?? policy.history.maxCalls, policy.history.maxHeaders ?? 24_000, base.quoteTtlS + base.settleHorizonS, base.tipPercentile, log);
    if (opts.historyFile) writeFileSync(opts.historyFile, JSON.stringify({ ...H, segments: H.segments.map((sg) => ({ rows: sg.rows.map((r) => r.map(String)) })) }));
  }
  const rowS = H.blockS * H.stride; // seconds between two history rows
  const horizonRows = Math.ceil((base.quoteTtlS + base.settleHorizonS) / rowS);
  const rises = H.segments.flatMap((s) => windowRises(s.rows.map((r) => r[1]), horizonRows)).sort((a, b) => a - b);
  const qAt = (p: number) => rises[Math.min(rises.length - 1, Math.floor(p * rises.length))] ?? 0;
  const p95 = qAt(policy.buffer.quantile);
  const bufHistory = Math.ceil(p95 / policy.buffer.roundUpBps) * policy.buffer.roundUpBps;
  const allBf = H.segments.flatMap((s) => s.rows.map((r) => r[1])).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const allTip = H.segments.flatMap((s) => s.rows.map((r) => r[4])).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const bq = (a: bigint[], p: number) => a[Math.min(a.length - 1, Math.floor(p * a.length))]!.toString();

  const historySource = [...src.used].join(' + ');
  log(`${ch.name}: 2/6 legs`);
  const legs = await readLegs(src, chainId, ch, legsFile, opts, policy, today);

  log(`${ch.name}: 6/6 (first) live gas snapshot`);
  const sizes = [...new Set(legs.legs.map((l) => l.bytes))].sort((a, b) => a - b);
  const snapPolicy: FeePolicy = { ...base, gasBufferBps: bufHistory };
  const snapshot = await readSnapshot(src, chainId, ch, snapPolicy, sizes, H.horizonBlocks);

  log(`${ch.name}: 3/6 prior`);
  const url = opts.sellersUrl ?? chains.sellers;
  let sellers = await readSellers(url, chainId);
  let borrowed: number | undefined;
  const ownLayer = sellers.onChain;
  if (sellers.servedChain !== chainId || !sellers.onChain || sellers.recs.filter((r) => r.correct + r.incorrect > 0).length < 2) { borrowed = 8453; sellers = await readSellers(url, 8453); }
  const fit = fitPrior(sellers.recs);
  const round4 = (x: number) => Math.round(x * 1e4) / 1e4;
  const lp = { ...LP_DEFAULTS, a0: round4(fit.a0), b0: round4(fit.b0) };

  log(`${ch.name}: 4/6 no-loss Monte Carlo`);
  const l1 = Object.fromEntries(Object.entries(snapshot.l1_fee_wei_by_bytes).map(([b, v]) => [Number(b), BigInt(v)]));
  const gasUsd8 = BigInt(snapshot.gas_usd8);
  const legsFor = (pr: FeeProfile) => legs.legs.filter((l) => l.profiles.includes(pr));
  const trail: { buffer_bps: number; losses: number }[] = [];
  let buf = bufHistory, results: ReturnType<typeof noLoss>[] = [];
  for (let i = 0; i < 40; i++) {
    const fee: FeePolicy = { ...base, gasBufferBps: buf };
    results = FEE_PROFILES.map((pr) => noLoss({ chainId, segments: H.segments, blockS: rowS, legs: legsFor(pr), policy: fee, profile: pr, l1FeeWeiByBytes: l1, gasUsd8, gasTokenVolPerHour: ch.gas_token_vol_per_hour, tip: H.stride > 1 ? 'none' : ch.tip, tipWei: H.stride > 1 && ch.tip !== 'none' ? BigInt(snapshot.tip_wei) : undefined, horizonBlocks: horizonRows }, mc));
    // the pass criterion is policy B, the one the executor enforces (each leg's maxFeePerGas = the quoted gas price);
    // policy A (send at once) is reported: it shows what the cap is protecting against
    const losses = results.reduce((s, r) => s + r.B.losses, 0);
    trail.push({ buffer_bps: buf, losses, send_at_once_losses: results.reduce((s, r) => s + r.A.losses, 0) } as { buffer_bps: number; losses: number });
    if (!losses) break;
    buf += policy.buffer.roundUpBps;
  }
  const pass = trail[trail.length - 1]!.losses === 0;
  const fee: FeePolicy = { ...base, gasBufferBps: Math.max(bufHistory, buf) };

  log(`${ch.name}: 5/6 backer Monte Carlo`);
  const backer = backerReturns(lp, policy.premium.lockSeconds, mc, bp);

  log(`${ch.name}: 6/6 price table`);
  const tf = new Intl.NumberFormat('en-US');
  const cal: Calibration = {
    schema: CALIBRATION_SCHEMA, chainId, name: ch.name, version: 0, status: legs.status, generated_at: now.toISOString(),
    library: `@taifoon/jev-wilson@${readJson<{ version: string }>(new URL('../package.json', import.meta.url).pathname).version}`,
    fee, legs, lp, premium: policy.premium,
    chain: { fee_model: ch.fee_model, gas_token: ch.gas_token, tip: ch.tip, block_s: Math.round(H.blockS * 1e4) / 1e4, price: ch.price, l1: ch.l1 },
    history: {
      source: historySource, razor: src.razorWhy.length ? src.razorWhy.join('; ') : 'answered every call',
      segments: H.ranges, blocks: H.segments.reduce((s, x) => s + x.rows.length, 0), days: opts.days ?? policy.history.days,
      horizon_s: base.quoteTtlS + base.settleHorizonS, horizon_blocks: H.horizonBlocks, sampled_every_blocks: H.stride, horizon_rows: horizonRows,
      rise_bps: { p50: qAt(0.5), p90: qAt(0.9), p95, p99: qAt(0.99), max: rises[rises.length - 1] ?? 0 },
      base_fee_wei: { min: bq(allBf, 0), p50: bq(allBf, 0.5), p95: bq(allBf, 0.95), max: bq(allBf, 1) },
      tip_wei: { percentile: base.tipPercentile, p50: bq(allTip, 0.5), p95: bq(allTip, 0.95) },
      buffer_bps_history: bufHistory, buffer_bps_montecarlo: buf,
      note: `buffer = the p95 rise of the base fee over ${tf.format(H.horizonBlocks)} blocks${H.stride > 1 ? ` (block headers, every ${H.stride}th: the chain's public nodes answer eth_feeHistory only near the head)` : ''}, rounded up to ${policy.buffer.roundUpBps} bps, raised until the Monte Carlo finds no loss`,
    },
    prior: { a0: lp.a0, b0: lp.b0, fit_a0: fit.a0, fit_b0: fit.b0, mean: fit.mean, sellers: fit.sellers, jobs: fit.jobs, incorrect: fit.incorrect, over30: fit.over30,
      source: url.replace('{chain}', String(borrowed ?? chainId)).replace(/&?offset=\{offset\}/, ''), ...(borrowed ? { borrowed_from: borrowed, why: ownLayer ? `no seller with a decided job on ${ch.name} in the record yet` : `no assurance layer on ${ch.name}: the seller record served for it is the cross-chain one, read where the layer is (Base)` } : {}) },
    gas_snapshot: snapshot,
    checks: { no_loss: { pass, criterion: 'policy B: every leg capped at the quoted gas price (maxFeePerGas), as the executor sends them; A = sent at once, reported only', samples: mc.samples, seed: mc.seed, buffer_search: trail, profiles: results }, backer: { sims: bp.sims, jobs: bp.jobs, capital_usdc: bp.capital, rows: backer } },
    table: { profile: policy.table.profile, rows: [], min_price: { direct: '0', 'stand-in': '0', relayed: '0' } },
    config_digest: '', digest: '',
  };
  cal.table = priceTable(cal, policy.table.prices, policy.table.profile);
  if (ch.x402) cal.x402 = x402Table(cal, policy.x402?.prices ?? [0.01, 0.1, 1, 10], ch.x402);
  cal.config_digest = configDigest(cal);
  cal.version = !prev ? 1 : prev.config_digest === cal.config_digest ? prev.version : prev.version + 1;
  cal.digest = contentDigest(cal);
  const bad = verifyCalibration(cal);
  if (bad.length) throw new Error(`the new calibration does not verify: ${bad.join('; ')}`);
  const changed = !prev || prev.config_digest !== cal.config_digest;
  if (!opts.compare) { mkdirSync(outDir, { recursive: true }); writeFileSync(file, JSON.stringify(cal, null, 1) + '\n'); }
  return { cal, changed, regime: regimeChange(prev, cal, policy.buffer.regimeBps), prev, file };
}

/** A gas-regime change: the buffer moved by `regimeBps` or more, a leg's gas or size changed, or the prior moved (2 dp).
 *  [] = the same regime (a smaller config move waits for the weekly run). */
export function regimeChange(prev: Calibration | null, cal: Calibration, regimeBps = 500): string[] {
  if (!prev) return ['no calibration before'];
  const out: string[] = [];
  if (Math.abs(cal.fee.gasBufferBps - prev.fee.gasBufferBps) >= regimeBps) out.push(`buffer ${prev.fee.gasBufferBps} → ${cal.fee.gasBufferBps} bps`);
  const pl = new Map(prev.legs.legs.map((l) => [l.key, l]));
  for (const l of cal.legs.legs) { const p = pl.get(l.key); if (!p || p.gas !== l.gas || p.bytes !== l.bytes) out.push(`leg ${l.key}`); }
  const r2 = (x: number) => Math.round(x * 100) / 100;
  if (r2(prev.lp.a0) !== r2(cal.lp.a0) || r2(prev.lp.b0) !== r2(cal.lp.b0)) out.push(`prior Beta(${prev.lp.a0}, ${prev.lp.b0}) → Beta(${cal.lp.a0}, ${cal.lp.b0})`);
  for (const k of ['bps', 'marginUsdc', 'ethMoveBps', 'quoteTtlS', 'settleHorizonS', 'tipPercentile', 'maxPriceAgeS', 'capBps'] as const) if (prev.fee[k] !== cal.fee[k]) out.push(`policy ${k}`);
  return out;
}

/** What changed in the config between two calibrations, for the report. */
export function configChanges(prev: Calibration | null, cal: Calibration): string[] {
  if (!prev) return ['first calibration'];
  const out: string[] = [];
  for (const k of Object.keys(cal.fee) as (keyof FeePolicy)[]) if (prev.fee[k] !== cal.fee[k]) out.push(`fee.${k} ${prev.fee[k]} → ${cal.fee[k]}`);
  const pl = new Map(prev.legs.legs.map((l) => [l.key, l]));
  for (const l of cal.legs.legs) { const p = pl.get(l.key); if (!p || p.gas !== l.gas || p.bytes !== l.bytes) out.push(`leg ${l.key} ${p ? `${p.gas}/${p.bytes}` : 'new'} → ${l.gas}/${l.bytes}`); }
  if (prev.lp.a0 !== cal.lp.a0 || prev.lp.b0 !== cal.lp.b0) out.push(`prior Beta(${prev.lp.a0}, ${prev.lp.b0}) → Beta(${cal.lp.a0}, ${cal.lp.b0})`);
  return out;
}

export type { FeeRow };
