#!/usr/bin/env node
// npx @taifoon/jev-wilson mcp                 start the stdio MCP server
// npx @taifoon/jev-wilson premium <k> <n> [price]
// npx @taifoon/jev-wilson listing <k> <n>
import { serve } from './mcp.ts';
import { listing, premium } from './wilson.ts';

const [cmd, ...rest] = process.argv.slice(2);
const out = (v: unknown) => console.log(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2));

if (cmd === 'mcp') serve();
else if (cmd === 'premium' && rest.length >= 2) out(premium({ k: Number(rest[0]), n: Number(rest[1]) }, rest[2] ? { price: rest[2] } : {}));
else if (cmd === 'listing' && rest.length >= 2) out(listing(Number(rest[0]), Number(rest[1])));
else {
  console.error('usage: jev-wilson mcp | premium <k> <n> [price] | listing <k> <n>');
  process.exit(cmd ? 1 : 0);
}
