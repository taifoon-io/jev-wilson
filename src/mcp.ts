// A tiny MCP server over stdio (newline-delimited JSON-RPC 2.0). Zero dependencies.
// Tools: wilson_lower, premium, listing. Pure functions; no network, no keys.
import { listing, premium, wilson, wilsonLower, wilsonUpperFailure, MAX_PREMIUM_RATIO, Z } from './wilson.ts';

export const SERVER_INFO = { name: 'jev-wilson', version: '0.1.0' };
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const record = { k: { type: 'integer', minimum: 0, description: 'delivered jobs (completed and paid)' }, n: { type: 'integer', minimum: 0, description: 'graded jobs: delivered + undelivered' } };

export const TOOLS = [
  {
    name: 'wilson_lower',
    description: 'Wilson score bounds for k delivered of n graded jobs: p_L (lower bound on the delivered rate) and u_F (upper bound on the failure rate, the Taifoon layer’s premium ratio). z defaults to 1.959963984540054.',
    inputSchema: { type: 'object', properties: { ...record, z: { type: 'number', exclusiveMinimum: 0 } }, required: ['k', 'n'], additionalProperties: false },
  },
  {
    name: 'premium',
    description: 'The coverage premium for the next job. Pass k and n to price from the record (bit-for-bit with the Taifoon layer), or p_L to price 1 - p_L. price is an integer string in the token’s smallest unit. covered is false above max (default 0.30). k = 0 is UNKNOWN: not insurable.',
    inputSchema: { type: 'object', properties: { ...record, p_L: { type: 'number', minimum: 0, maximum: 1 }, price: { type: 'string', pattern: '^[0-9]+$' }, min: { type: 'number', minimum: 0, maximum: 1 }, max: { type: 'number', minimum: 0, maximum: 1 }, z: { type: 'number', exclusiveMinimum: 0 } }, additionalProperties: false },
  },
  {
    name: 'listing',
    description: 'One listing row for a seller (schemas/listing.schema.json): n, k, p_L, u_F, z, cheat, grade_id. cheat is a separate flag and never changes p_L or u_F.',
    inputSchema: { type: 'object', properties: { ...record, z: { type: 'number', exclusiveMinimum: 0 }, cheat: { type: 'boolean' }, grade_id: { type: ['string', 'null'] } }, required: ['k', 'n'], additionalProperties: false },
  },
] as const;

type Json = { [key: string]: unknown };
const text = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2) }] });
const toolError = (m: string) => ({ content: [{ type: 'text', text: m }], isError: true });

export function callTool(name: string, a: Json): unknown {
  try {
    switch (name) {
      case 'wilson_lower': {
        const k = a.k as number, n = a.n as number, z = (a.z as number | undefined) ?? Z;
        return text({ k, n, z, p_L: wilsonLower(k, n, z), u_F: wilsonUpperFailure(k, n, z), delivered_interval: wilson(k, n, z) });
      }
      case 'premium': {
        const opts = { price: a.price as string | undefined, min: a.min as number | undefined, max: (a.max as number | undefined) ?? MAX_PREMIUM_RATIO, z: a.z as number | undefined };
        if (typeof a.p_L === 'number') return text(premium(a.p_L, opts));
        if (typeof a.k !== 'number' || typeof a.n !== 'number') return toolError('pass k and n, or p_L');
        return text(premium({ k: a.k, n: a.n }, opts));
      }
      case 'listing':
        return text(listing(a.k as number, a.n as number, { z: a.z as number | undefined, cheat: a.cheat as boolean | undefined, grade_id: a.grade_id as string | null | undefined }));
      default:
        return toolError(`unknown tool: ${name}`);
    }
  } catch (e) {
    return toolError((e as Error).message);
  }
}

/** One JSON-RPC message in, at most one out. Notifications (no id) get no reply. */
export function handle(msg: Json): Json | null {
  const id = msg.id;
  const isNote = id === undefined || id === null;
  const ok = (result: unknown) => (isNote ? null : { jsonrpc: '2.0', id, result });
  const err = (code: number, message: string) => (isNote ? null : { jsonrpc: '2.0', id, error: { code, message } });
  const params = (msg.params ?? {}) as Json;
  switch (msg.method) {
    case 'initialize': {
      const asked = params.protocolVersion as string | undefined;
      const protocolVersion = asked && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      return ok({ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
    }
    case 'notifications/initialized':
      return null;
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call':
      return ok(callTool(String(params.name), (params.arguments ?? {}) as Json));
    default:
      return err(-32601, `method not found: ${String(msg.method)}`);
  }
}

export function serve(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): void {
  let buf = '';
  input.setEncoding('utf8');
  input.on('data', (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let reply: Json | null;
      try { reply = handle(JSON.parse(line) as Json); } catch { reply = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }; }
      if (reply) output.write(JSON.stringify(reply) + '\n');
    }
  });
}
