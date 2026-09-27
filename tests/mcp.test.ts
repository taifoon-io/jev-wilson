import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handle } from '../src/mcp.ts';

const call = (name: string, args: object) => {
  const r = handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) as { result: { content: { text: string }[]; isError?: boolean } };
  return { ...r.result, json: r.result.isError ? null : JSON.parse(r.result.content[0].text) };
};

test('initialize echoes a supported protocol version', () => {
  const r = handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) as { result: { protocolVersion: string; serverInfo: { name: string } } };
  assert.equal(r.result.protocolVersion, '2025-03-26');
  assert.equal(r.result.serverInfo.name, 'jev-wilson');
  assert.equal(handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('tools/list has exactly wilson_lower, premium, listing', () => {
  const r = handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as { result: { tools: { name: string }[] } };
  assert.deepEqual(r.result.tools.map((t) => t.name), ['wilson_lower', 'premium', 'listing']);
});

test('premium tool returns the live pilot quote to the last digit', () => {
  const r = call('premium', { k: 60, n: 62, price: '10000000000000000000' });
  assert.equal(r.json.ratio, 0.11020469594985441);
  assert.equal(r.json.amount, '1102050000000000000');
  assert.equal(r.json.covered, true);
});

test('wilson_lower and listing tools', () => {
  const w = call('wilson_lower', { k: 9, n: 10 });
  assert.equal(w.json.u_F, 0.4041500267952385);
  const l = call('listing', { k: 90, n: 100, cheat: true, grade_id: null });
  assert.equal(l.json.u_F, 0.17436566150491348);
  assert.equal(l.json.cheat, true);
});

test('errors come back as tool errors, unknown methods as JSON-RPC errors', () => {
  assert.equal(call('premium', {}).isError, true);
  assert.equal(call('listing', { k: 5, n: 2 }).isError, true);
  const r = handle({ jsonrpc: '2.0', id: 9, method: 'nope' }) as { error: { code: number } };
  assert.equal(r.error.code, -32601);
});

test('the stdio server answers over a real pipe', async () => {
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines: string[] = [];
  const done = new Promise<void>((resolve) => {
    let buf = '';
    child.stdout.on('data', (c: Buffer) => {
      buf += c.toString();
      const parts = buf.split('\n'); buf = parts.pop() ?? '';
      lines.push(...parts.filter(Boolean));
      if (lines.length >= 2) resolve();
    });
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'premium', arguments: { k: 2319, n: 2323, price: '100000000' } } }) + '\n');
  await done;
  child.kill();
  const second = JSON.parse(lines[1]);
  assert.equal(JSON.parse(second.result.content[0].text).amount, '441900');
});
