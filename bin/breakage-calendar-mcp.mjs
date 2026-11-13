#!/usr/bin/env node
// With no arguments: an MCP server on stdio. With a command: the same answers on the command line.
//   breakage-calendar-mcp check docker:postgres:latest pypi:celery==5.4.0 ...
//   breakage-calendar-mcp repo [folder]
//   breakage-calendar-mcp upcoming [days]
//   breakage-calendar-mcp --roots DIR...   MCP server that reads only these folders
const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  process.stderr.write(`breakage-calendar-mcp needs Node.js 18 or later (this is ${process.version}).\n`);
  process.exit(1);
}
let [cmd, ...rest] = process.argv.slice(2);
let roots;
if (cmd === '--roots') {
  // MCP server whose check_repository reads only these folders (an MCPB client passes the folders the user chose,
  // one argument each). This list replaces the working folder and BREAKAGE_CALENDAR_ROOTS; with no folders it reads none.
  const { resolve } = await import('node:path');
  roots = [...new Set(rest.filter(Boolean).map((p) => resolve(p)))];
  cmd = undefined;
}
if (!cmd) {
  const { serveStdio } = await import('../src/server.mjs');
  serveStdio({ roots });
} else {
  const { VERSION, createStore } = await import('../src/data.mjs');
  const tools = await import('../src/tools.mjs');
  const { resolve } = await import('node:path');
  const store = createStore();
  const run = async () => {
    if (cmd === '--version' || cmd === 'version') return { text: VERSION };
    if (cmd === 'check') return tools.checkDependencies(store, { dependencies: rest });
    if (cmd === 'repo') { const p = resolve(rest[0] || '.'); return tools.checkRepository(store, { path: p }, { roots: [p] }); }
    if (cmd === 'upcoming') return tools.listUpcoming(store, rest[0] ? { days_ahead: Number(rest[0]) } : {});
    if (cmd === 'get') return tools.getBreak(store, { id: rest[0] });
    return { text: 'Usage:\n  breakage-calendar-mcp                      MCP server on stdio\n  breakage-calendar-mcp --roots <folder>...  MCP server that reads only these folders\n  breakage-calendar-mcp check <ecosystem:name[@version]>...\n  breakage-calendar-mcp repo [folder]\n  breakage-calendar-mcp upcoming [days]\n  breakage-calendar-mcp get <id>', code: cmd === '--help' || cmd === 'help' ? 0 : 2 };
  };
  try {
    const r = await run();
    process.stdout.write(`${r.text}\n`);
    process.exitCode = r.code ?? 0;
  } catch (e) {
    process.stderr.write(`${e.message || e}\n`);
    process.exitCode = 1;
  }
}
