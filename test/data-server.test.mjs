// The data loader (with a fake fetch) and the JSON-RPC layer, plus one run of the real binary over stdio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createStore, checkData, UA } from '../src/data.mjs';
import { createServer, SUPPORTED } from '../src/server.mjs';

const raw = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const json = (f) => JSON.parse(raw(f));

function fakeFetch(handler) {
  const calls = [];
  const f = async (url, opts) => { calls.push({ url, opts }); return handler(url, opts, calls.length); };
  f.calls = calls;
  return f;
}
const resp = (body, { status = 200, etag = '"e1"' } = {}) => new Response(body, { status, headers: { etag, 'content-type': 'application/json' } });

test('checkData admits the live shape and refuses a bad search or date', () => {
  assert.equal(checkData(json('signatures.json'), json('entries.json')), null);
  const sigs = json('signatures.json');
  sigs.signatures[0].patterns = ['('];
  assert.match(checkData(sigs, json('entries.json')), /bad search/);
  const cal = json('entries.json');
  cal.entries[0].date = '2026-02-30';
  assert.match(checkData(json('signatures.json'), cal), /bad date/);
});

test('store: two GETs with our user agent, no redirects; 304 reuses the copy; a failure keeps the old copy, marked stale', async () => {
  let t = 0;
  let mode = 'ok';
  const f = fakeFetch((url, opts) => {
    if (mode === 'fail') throw new TypeError('fetch failed');
    if (mode === '304') { assert.ok(opts.headers['if-none-match']); return new Response(null, { status: 304 }); }
    return resp(url.endsWith('entries.json') ? raw('entries.json') : raw('signatures.json'));
  });
  const s = createStore({ fetchImpl: f, now: () => t });
  const a = await s.load();
  assert.equal(a.cal.entries.length, 12);
  assert.equal(f.calls.length, 2);
  for (const c of f.calls) {
    assert.match(c.url, /^https:\/\/cybernative\.ai\/breakage-calendar\//);
    assert.equal(c.opts.redirect, 'error');
    assert.equal(c.opts.headers['user-agent'], UA);
    assert.equal(c.opts.body, undefined);
  }
  await s.load();
  assert.equal(f.calls.length, 2, 'fresh for an hour');
  t += 61 * 60 * 1000; mode = '304';
  const b = await s.load();
  assert.equal(f.calls.length, 4);
  assert.equal(b.stale, null);
  assert.equal(b.cal, a.cal);
  t += 61 * 60 * 1000; mode = 'fail';
  const c = await s.load();
  assert.match(c.stale, /fetch failed/);
  assert.equal(c.cal, a.cal);
});

test('store: refuses an oversized, non-JSON or malformed answer on first load', async () => {
  const big = createStore({ fetchImpl: fakeFetch(() => resp('x'.repeat(5 * 1024 * 1024))) });
  await assert.rejects(big.load(), /larger than/);
  const notJson = createStore({ fetchImpl: fakeFetch(() => resp('<html>')) });
  await assert.rejects(notJson.load(), /not valid JSON/);
  const wrong = createStore({ fetchImpl: fakeFetch(() => resp('{"entries": []}')) });
  await assert.rejects(wrong.load(), /not in the expected form/);
  const http = createStore({ fetchImpl: fakeFetch(() => resp('no', { status: 503 })) });
  await assert.rejects(http.load(), /HTTP 503/);
});

function harness() {
  const out = [];
  const store = { load: async () => ({ cal: json('entries.json'), sigs: json('signatures.json'), fetchedAt: 0, stale: null }) };
  const server = createServer({ store, write: (s) => out.push(JSON.parse(s)), log: () => {} });
  return { out, send: (m) => server.receive(typeof m === 'string' ? m : JSON.stringify(m)) };
}

test('initialize negotiates the protocol version', async () => {
  const h = harness();
  await h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  await h.send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } });
  assert.equal(h.out[0].result.protocolVersion, '2025-03-26');
  assert.equal(h.out[1].result.protocolVersion, SUPPORTED[0]);
  assert.deepEqual(h.out[0].result.capabilities, { tools: { listChanged: false } });
  assert.equal(h.out[0].result.serverInfo.name, 'breakage-calendar');
});

test('JSON-RPC errors: parse error, unknown method, unknown tool; notifications get no answer; tool errors are results', async () => {
  const h = harness();
  await h.send('{nope');
  await h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await h.send({ jsonrpc: '2.0', id: 3, method: 'server/discover' });
  await h.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  await h.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'check_dependencies', arguments: { dependencies: [] } } });
  await h.send({ jsonrpc: '2.0', id: 6, method: 'ping' });
  assert.equal(h.out.length, 5);
  assert.equal(h.out[0].error.code, -32700);
  assert.equal(h.out[1].error.code, -32601);
  assert.equal(h.out[2].error.code, -32602);
  assert.equal(h.out[3].result.isError, true);
  assert.match(h.out[3].result.content[0].text, /dependencies is a list/);
  assert.deepEqual(h.out[4], { jsonrpc: '2.0', id: 6, result: {} });
});

test('tools/list: five read-only tools with object schemas', async () => {
  const h = harness();
  await h.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const tools = h.out[0].result.tools;
  assert.deepEqual(tools.map((t) => t.name), ['check_dependencies', 'check_files', 'check_repository', 'list_upcoming_breaks', 'get_break']);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.annotations.readOnlyHint, true);
    assert.ok(t.description.length > 50);
    assert.equal(t.run, undefined);
  }
});

test('the binary answers over stdio and writes nothing else to stdout', async () => {
  const p = spawn(process.execPath, [new URL('../bin/breakage-calendar-mcp.mjs', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  p.stdout.on('data', (d) => { stdout += d; });
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  p.stdin.end();
  const code = await new Promise((r) => p.on('close', r));
  assert.equal(code, 0);
  const lines = stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.id), [1, 2]);
  assert.equal(lines[0].result.protocolVersion, '2025-11-25');
});
