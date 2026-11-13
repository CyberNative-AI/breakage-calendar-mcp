// Which folders the real binary reads: started with --roots it reads exactly the folders given (each one argument,
// whatever characters its name has), never its working folder or BREAKAGE_CALENDAR_ROOTS, and none if none are given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRepository } from '../src/tools.mjs';

const BIN = new URL('../bin/breakage-calendar-mcp.mjs', import.meta.url).pathname;
const PRELOAD = new URL('./fixtures/offline-fetch.mjs', import.meta.url).href;

function call(args, path, { cwd, env = {} }) {
  const p = spawn(process.execPath, ['--import', PRELOAD, BIN, ...args], { cwd, env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_repository', arguments: { path } } }) + '\n');
  return new Promise((resolve) => p.on('close', (code) => {
    assert.equal(code, 0, err);
    const r = JSON.parse(out).result;
    resolve({ isError: r.isError, text: r.content[0].text });
  }));
}

test('--roots: only the chosen folders, each kept whole; never the working folder or the environment list', async () => {
  const top = mkdtempSync(join(tmpdir(), 'bc-roots-'));
  try {
    const dirs = {};
    for (const name of ['ambient', 'env', 'project', 'project:one', 'with space', 'other']) {
      dirs[name] = join(top, name);
      mkdirSync(dirs[name]);
      writeFileSync(join(dirs[name], 'compose.yaml'), 'services:\n  db:\n    image: postgres:latest\n');
    }
    const opts = { cwd: dirs.ambient, env: { BREAKAGE_CALENDAR_ROOTS: dirs.env } };
    const ok = (r, base) => { assert.equal(r.isError, false, r.text); assert.ok(r.text.includes(`under ${base} `), r.text); };
    const refused = (r) => { assert.equal(r.isError, true, r.text); assert.ok(!r.text.includes('Read '), r.text); };

    // No folder chosen: nothing is read, not even the working folder.
    let r = await call(['--roots'], dirs.ambient, opts);
    refused(r);
    assert.match(r.text, /No project folder was chosen/);
    refused(await call(['--roots'], '.', opts));
    refused(await call(['--roots', ''], dirs.env, opts));

    // One chosen folder whose name holds the POSIX list separator: it is read, the folder named by its prefix is not.
    const colon = ['--roots', dirs['project:one']];
    ok(await call(colon, dirs['project:one'], opts), dirs['project:one']);
    ok(await call(colon, '.', opts), dirs['project:one']);
    refused(await call(colon, dirs.project, opts));
    refused(await call(colon, join(dirs['project:one'], '..', 'other'), opts));
    refused(await call(colon, dirs.ambient, opts));
    refused(await call(colon, dirs.env, opts));

    // Several chosen folders, one with a space: each is read, siblings are not.
    const two = ['--roots', dirs['with space'], dirs['project:one']];
    ok(await call(two, dirs['with space'], opts), dirs['with space']);
    ok(await call(two, dirs['project:one'], opts), dirs['project:one']);
    refused(await call(two, dirs.other, opts));
    refused(await call(two, top, opts));

    // Without --roots the documented behaviour stays: the working folder and BREAKAGE_CALENDAR_ROOTS.
    ok(await call([], dirs.ambient, opts), dirs.ambient);
    ok(await call([], dirs.env, opts), dirs.env);
    refused(await call([], dirs.other, opts));
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

test('an empty folder list refuses before loading the calendar or reading anything', async () => {
  let loads = 0;
  const store = { load: async () => { loads++; throw new Error('must not load'); } };
  await assert.rejects(checkRepository(store, { path: '.' }, { roots: [] }), /No project folder was chosen/);
  await assert.rejects(checkRepository(store, { path: tmpdir() }, { roots: [] }), /No project folder was chosen/);
  assert.equal(loads, 0);
});
