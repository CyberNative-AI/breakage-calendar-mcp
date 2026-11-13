// A Model Context Protocol server over stdio: one JSON-RPC message per line on stdin and stdout.
// No dependencies. Logs go to stderr only; stdout carries protocol messages and nothing else.
import { createInterface } from 'node:readline';
import { TOOLS, ToolError } from './tools.mjs';
import { createStore, VERSION } from './data.mjs';

export const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = 'Dated upstream breaks with tested fixes, from the CyberNative Breakage Calendar. Before upgrading, pinning or deploying a project, call check_repository (local folder) or check_dependencies / check_files, then show the user each date, what breaks and the fix link. list_upcoming_breaks and get_break read the calendar itself.';

export function createServer({ store = createStore(), tools = TOOLS, roots, write, log = (m) => process.stderr.write(`${m}\n`) } = {}) {
  let initialized = false;
  const send = (msg) => write(JSON.stringify(msg));
  const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  async function call(id, params) {
    const tool = tools.find((t) => t.name === params?.name);
    if (!tool) return fail(id, -32602, `Unknown tool: ${String(params?.name).slice(0, 100)}`);
    const args = params.arguments ?? {};
    if (typeof args !== 'object' || Array.isArray(args)) return fail(id, -32602, 'arguments must be an object');
    try {
      const { text, data } = await tool.run(store, args, { roots });
      return ok(id, { content: [{ type: 'text', text }], structuredContent: data, isError: false });
    } catch (err) {
      const msg = err instanceof ToolError ? err.message : `Failed: ${String(err?.message || err).slice(0, 300)}`;
      if (!(err instanceof ToolError)) log(`tool ${tool.name}: ${err?.stack || err}`);
      return ok(id, { content: [{ type: 'text', text: msg }], isError: true });
    }
  }

  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return fail(null, -32600, 'Invalid Request');
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    if (typeof method !== 'string') return isRequest ? undefined : fail(null, -32600, 'Invalid Request'); // a response to us: ignore
    if (!isRequest) { if (method === 'notifications/initialized') initialized = true; return undefined; }
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        return ok(id, {
          protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'breakage-calendar', title: 'Breakage Calendar', version: VERSION, websiteUrl: 'https://cybernative.ai/breakage-calendar/' },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping': return ok(id, {});
      case 'tools/list':
        return ok(id, { tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) });
      case 'tools/call': return call(id, params);
      default: return fail(id, -32601, `Method not found: ${method.slice(0, 100)}`);
    }
  }

  return {
    async receive(line) {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'Parse error'); }
      if (Array.isArray(msg)) { // JSON-RPC batch (2025-03-26); later revisions send none
        if (!msg.length) return fail(null, -32600, 'Invalid Request');
        for (const m of msg) await handle(m);
        return;
      }
      return handle(msg);
    },
    get initialized() { return initialized; },
  };
}

export function serveStdio({ roots } = {}) {
  const server = createServer({ roots, write: (s) => process.stdout.write(`${s}\n`) });
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  // Requests are answered as they finish; the line reader never waits on a slow tool. When stdin closes the
  // process ends by itself once running calls are done.
  rl.on('line', (line) => { server.receive(line).catch((e) => process.stderr.write(`${e?.stack || e}\n`)); });
}
