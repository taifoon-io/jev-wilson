// jev-wilson/gas-source: where a calibration reads gas from. One small interface, two implementations:
//
//   razorSource      the razor gas service, GET <razor>/razor/v1/gas/:chain (+ /history?from_block=&to_block=)
//   feeHistorySource eth_feeHistory over JSON-RPC, through a rotation of public endpoints (the fallback, always present)
//
// gasSource() tries razor first and falls back per call, recording which one answered. Read-only: nothing here signs.
//
// What this adapter reads from razor (schema taifoon.razor.gas.v1):
//   GET /razor/v1/gas/:chain   → { chain_id, block, at, base_fee_wei, priority_fee_wei: { p10, p25, p50, p75, p90 }, stale,
//                                  l1: { model: 'op-stack', fee_upper_bound_wei_by_bytes } | { model: 'arbitrum', prices:
//                                  { perL2TxWei, perL1CalldataByteWei } } | { model: 'none' },
//                                  native: { usd8, usd_updated_at }, rise: { horizon_s, p95_bps } }
//   GET /razor/v1/gas/:chain/history?from_block=&to_block=   (not served yet; when it is:)
//                              → { cols: ["block","baseFee","tip25","tip50","tip75"], rows: [[…]] }
// Integers as decimal strings. Any other answer (404, another shape, stale) falls back to JSON-RPC.

/** [block, base fee, tip at p25, p50, and the quoted percentile (p75 unless the chain's policy says otherwise)] */
export type FeeRow = [block: number, baseFee: bigint, tip25: bigint, tip50: bigint, tipQ: bigint];
export type GasNow = { block: number; baseFeeWei: bigint; tips: { p25: bigint; p50: bigint; p75: bigint } };

/** razor's live answer, reduced to what a quote reads. */
export type RazorNow = {
  block: number; at: number; baseFeeWei: bigint; tips: Record<string, bigint>; l1Model: 'op-stack' | 'arbitrum' | 'none';
  l1ByBytes: Record<number, bigint>; arbPerTx: bigint | null; arbPerByte: bigint | null; usd8: bigint; usdUpdatedAt: number | null;
  rise: { horizonS: number; p95Bps: number } | null;
};

export interface GasSource {
  readonly name: string;
  /** razor's live gas, or null when razor is not configured or unavailable */ now?(chainId: number): Promise<RazorNow | null>;
  /** the newest block */ head(chainId: number): Promise<number>;
  /** fee rows for blocks [from, to] inclusive, ascending (base fee of each block + reward percentiles 25, 50 and `tipPct`) */
  history(chainId: number, from: number, to: number, tipPct?: number): Promise<FeeRow[]>;
  /** base fees of every `stride`-th block in [from, to] from block headers (no state needed): for a chain whose nodes
   *  answer eth_feeHistory only near the head. Tips read 0. */
  sampled?(chainId: number, from: number, to: number, stride: number): Promise<FeeRow[]>;
  /** a JSON-RPC read (eth_call, eth_getBlockByNumber, eth_feeHistory, eth_getTransactionReceipt) */
  rpc(chainId: number, method: string, params: unknown[]): Promise<any>;
}

export type SourceOpts = { rotation?: string; razor?: string | null; rpcs: Record<number, string[]>; timeoutMs?: number; log?: (s: string) => void };

const big = (x: unknown) => BigInt(x as string | number);

/** JSON-RPC through a rotation: warmbed's ranked endpoints for the chain, then the static list; each failure moves on. */
export function rpcClient(opts: SourceOpts) {
  const lists = new Map<number, string[]>();
  const cursor = new Map<number, number>();
  async function urls(chainId: number): Promise<string[]> {
    if (lists.has(chainId)) return lists.get(chainId)!;
    let rot: string[] = [];
    if (opts.rotation) {
      try {
        const r = await fetch(opts.rotation.replace('{chain}', String(chainId)), { signal: AbortSignal.timeout(8_000) });
        if (r.ok) rot = ((await r.json()) as { url?: string }[]).map((x) => x.url!).filter(Boolean);
      } catch { /* the static list follows */ }
    }
    const all = [...new Set([...(opts.rpcs[chainId] ?? []), ...rot])];
    if (!all.length) throw new Error(`no RPC for chain ${chainId}`);
    lists.set(chainId, all);
    return all;
  }
  return async function rpc(chainId: number, method: string, params: unknown[]): Promise<any> {
    const us = await urls(chainId);
    let last = '';
    for (let a = 0; a < us.length * 3; a++) {
      const i = (cursor.get(chainId) ?? 0) % us.length;
      const url = us[i]!;
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000) });
        const j = (await r.json()) as { result?: unknown; error?: unknown };
        if (j.result !== undefined && j.result !== null) return j.result;
        last = JSON.stringify(j.error ?? 'null result').slice(0, 200);
        if (method === 'eth_getTransactionReceipt' && j.result === null) return null;
      } catch (e) { last = (e as Error).message.slice(0, 200); }
      cursor.set(chainId, i + 1);
      if (a >= us.length) await new Promise((res) => setTimeout(res, 400 * (a - us.length + 1)));
    }
    throw new Error(`${method} on ${chainId}: every endpoint failed (${last})`);
  };
}

/** Is this error a node refusing old state (not archive)? */
export const isNoHistory = (e: unknown) => /historical state|archive|not available|personal token|missing trie|pruned/i.test((e as Error)?.message ?? '');

/** eth_feeHistory in windows of 1,024 blocks. */
export function feeHistorySource(opts: SourceOpts): GasSource {
  const rpc = rpcClient(opts);
  return {
    name: 'eth_feeHistory',
    rpc,
    async sampled(chainId, from, to, stride) {
      const blocks: number[] = [];
      for (let b = from; b <= to; b += stride) blocks.push(b);
      const out: FeeRow[] = [];
      for (let i = 0; i < blocks.length; i += 100) {
        const part = blocks.slice(i, i + 100);
        const heads = await Promise.all(part.map((b) => rpc(chainId, 'eth_getBlockByNumber', ['0x' + b.toString(16), false])));
        heads.forEach((h, k) => out.push([part[k]!, big(h.baseFeePerGas ?? 0), 0n, 0n, 0n]));
        if (opts.log && (i / 100) % 40 === 0) opts.log(`  headers ${chainId}: ${out.length} of ${blocks.length}`);
      }
      return out;
    },
    head: async (chainId) => Number(await rpc(chainId, 'eth_blockNumber', [])),
    async history(chainId, from, to, tipPct = 75) {
      const out: FeeRow[] = [];
      for (let newest = to; newest >= from; newest -= 1024) {
        const count = Math.min(1024, newest - from + 1);
        const h = await rpc(chainId, 'eth_feeHistory', ['0x' + count.toString(16), '0x' + newest.toString(16), [25, 50, tipPct]]);
        const oldest = Number(h.oldestBlock);
        const bf: string[] = h.baseFeePerGas.slice(0, -1);
        const rw: string[][] = h.reward ?? bf.map(() => ['0x0', '0x0', '0x0']);
        for (let k = 0; k < bf.length; k++) out.push([oldest + k, big(bf[k]), big(rw[k]?.[0] ?? 0), big(rw[k]?.[1] ?? 0), big(rw[k]?.[2] ?? 0)]);
        if (opts.log && out.length % (1024 * 20) === 0) opts.log(`  history ${chainId}: ${out.length} blocks`);
      }
      return out.sort((a, b) => a[0] - b[0]);
    },
  };
}

/** The razor gas service. Throws RazorUnavailable when it is absent or answers another shape. */
export class RazorUnavailable extends Error {}
export function razorSource(base: string, fallbackRpc: GasSource['rpc']): GasSource {
  const get = async (url: string) => {
    let r: Response;
    try { r = await fetch(url, { signal: AbortSignal.timeout(10_000) }); } catch (e) { throw new RazorUnavailable(`razor unreachable: ${(e as Error).message.slice(0, 120)}`); }
    if (!r.ok) throw new RazorUnavailable(`razor answered ${r.status}`);
    try { return await r.json(); } catch { throw new RazorUnavailable('razor answered no JSON'); }
  };
  return {
    name: 'razor',
    rpc: fallbackRpc,
    async now(chainId) {
      const j = await get(base.replace('{chain}', String(chainId)));
      if (j?.schema !== 'taifoon.razor.gas.v1' || j?.chain_id !== chainId || j?.stale) throw new RazorUnavailable(`razor /gas: ${j?.stale ? 'stale' : 'another shape'}`);
      const l1 = j.l1 ?? { model: 'none' };
      return {
        block: Number(j.block), at: Number(j.at), baseFeeWei: big(j.base_fee_wei),
        tips: Object.fromEntries(Object.entries(j.priority_fee_wei ?? {}).map(([k, v]) => [k, big(v)])),
        l1Model: l1.model, l1ByBytes: Object.fromEntries(Object.entries(l1.fee_upper_bound_wei_by_bytes ?? {}).map(([k, v]) => [Number(k), big(v)])),
        arbPerTx: l1.prices ? big(l1.prices.perL2TxWei) : null, arbPerByte: l1.prices ? big(l1.prices.perL1CalldataByteWei) : null,
        usd8: big(j.native?.usd8 ?? 0), usdUpdatedAt: j.native?.usd_updated_at ?? null,
        rise: j.rise ? { horizonS: Number(j.rise.horizon_s), p95Bps: Number(j.rise.p95_bps) } : null,
      };
    },
    async head(chainId) {
      const j = await get(base.replace('{chain}', String(chainId)));
      if (typeof j?.block !== 'number' || j?.base_fee_wei === undefined) throw new RazorUnavailable('razor /gas answered another shape');
      return j.block as number;
    },
    async history(chainId, from, to, tipPct = 75) {
      if (tipPct !== 75) throw new RazorUnavailable('razor /history serves the 75th-percentile tip only');
      const j = await get(`${base.replace('{chain}', String(chainId))}/history?from_block=${from}&to_block=${to}`);
      if (!Array.isArray(j?.rows) || !Array.isArray(j?.cols) || j.cols[1] !== 'baseFee') throw new RazorUnavailable('razor /history answered another shape');
      const rows = (j.rows as unknown[][]).map((r) => [Number(r[0]), big(r[1]), big(r[2]), big(r[3]), big(r[4])] as FeeRow);
      if (!rows.length || rows[0]![0] > from || rows[rows.length - 1]![0] < to) throw new RazorUnavailable('razor /history does not cover the range');
      return rows.sort((a, b) => a[0] - b[0]);
    },
  };
}

/** razor first, eth_feeHistory per call when razor is unavailable; `used` records who answered. */
export function gasSource(opts: SourceOpts): GasSource & { used: Set<string>; razorWhy: string[] } {
  const fh = feeHistorySource(opts);
  const rz = opts.razor ? razorSource(opts.razor, fh.rpc) : null;
  const used = new Set<string>();
  const razorWhy: string[] = [];
  const tryBoth = async <T>(f: (s: GasSource) => Promise<T>): Promise<T> => {
    if (rz) {
      try { const v = await f(rz); used.add('razor'); return v; } catch (e) {
        if (!(e instanceof RazorUnavailable)) throw e;
        if (!razorWhy.includes(e.message)) razorWhy.push(e.message);
      }
    }
    used.add('eth_feeHistory');
    return f(fh);
  };
  return {
    name: 'razor → eth_feeHistory', used, razorWhy, rpc: fh.rpc,
    sampled: async (c, a, b, k) => { used.add('block headers'); return fh.sampled!(c, a, b, k); },
    head: (c) => tryBoth((s) => s.head(c)),
    async now(c) {
      if (!rz) return null;
      try { const v = await rz.now!(c); used.add('razor'); return v; } catch (e) {
        if (!(e instanceof RazorUnavailable)) throw e;
        if (!razorWhy.includes(e.message)) razorWhy.push(e.message);
        return null;
      }
    },
    history: (c, a, b, p) => tryBoth((s) => s.history(c, a, b, p)),
  };
}

// ---- small ABI helpers (no dependencies) ----
export const word = (h: string, i: number) => BigInt('0x' + h.slice(2 + 64 * i, 2 + 64 * (i + 1)));
export const encUint = (n: number | bigint) => BigInt(n).toString(16).padStart(64, '0');
export const SEL = {
  latestRoundData: '0xfeaf968c',
  getL1FeeUpperBound: '0xf1c7a58b',
  getPricesInWei: '0x41b247a8',
} as const;
