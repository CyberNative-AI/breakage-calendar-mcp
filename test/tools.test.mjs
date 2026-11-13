// Tools against a pinned copy of 12 calendar dates (read 2026-11-13) with the clock set to 2026-11-13.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDependencies, checkFiles, checkRepository, listUpcoming, getBreak, ToolError } from '../src/tools.mjs';
import { parseDep, synthesize } from '../src/deps.mjs';

const fx = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const store = { load: async () => ({ cal: fx('entries.json'), sigs: fx('signatures.json'), fetchedAt: Date.UTC(2026, 10, 13), stale: null }) };
const NOW = Date.UTC(2026, 10, 13, 12);
const ids = (r) => r.data.findings.map((f) => `${f.id}|${f.verdict}`);

test('parseDep reads each ecosystem and refuses what it cannot use', () => {
  assert.deepEqual(parseDep('npm:@scope/pkg@1.2.3'), { raw: 'npm:@scope/pkg@1.2.3', eco: 'npm', name: '@scope/pkg', version: '1.2.3' });
  assert.deepEqual(parseDep('pypi:celery[redis]>=5.4'), { raw: 'pypi:celery[redis]>=5.4', eco: 'pypi', name: 'celery', version: '>=5.4' });
  assert.deepEqual(parseDep('pip:Celery==5.4.0'), { raw: 'pip:Celery==5.4.0', eco: 'pypi', name: 'Celery', version: '==5.4.0' });
  assert.equal(parseDep('docker:postgres:16@sha256:abc').name, 'postgres:16@sha256:abc');
  assert.deepEqual(parseDep('maven:com.jcraft:jsch@0.1.55'), { raw: 'maven:com.jcraft:jsch@0.1.55', eco: 'maven', name: 'com.jcraft:jsch', version: '0.1.55' });
  assert.match(parseDep('express').error, /start with an ecosystem/);
  assert.match(parseDep('npm:a"b').error, /quotes/);
  assert.match(parseDep('npm:x\ny').error, /printable/);
  assert.match(parseDep(42).error, /not a string/);
});

test('synthesize writes lines the searches read, and maps each line back to its dependency', () => {
  const deps = ['npm:cron@3', 'docker:postgres', 'gem:rails@8.0.2', 'runner:ubuntu-latest', 'action:actions/setup-python@v5'].map(parseDep);
  const { files, origin } = synthesize(deps);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f.text]));
  assert.equal(JSON.parse(byPath['package.json']).dependencies.cron, '3');
  assert.match(byPath['compose.yaml'], /^ {4}image: postgres$/m);
  assert.match(byPath['Gemfile.lock'], /^ {4}rails \(8\.0\.2\)$/m);
  assert.match(byPath['.github/workflows/dependencies.yml'], /runs-on: ubuntu-latest[\s\S]*uses: actions\/setup-python@v5/);
  const line = byPath['compose.yaml'].split('\n').findIndex((l) => l.includes('postgres')) + 1;
  assert.equal(origin('compose.yaml', line), 'docker:postgres');
  assert.equal(origin('compose.yaml', 1), null);
});

test('check_dependencies: real hits, may-hits, a library default, and what it did not understand', async () => {
  const r = await checkDependencies(store, { dependencies: ['docker:postgres:latest', 'docker:postgres:18', 'pypi:celery==5.4.0', 'pypi:langsmith', 'gem:rails@8.0.2', 'runner:macos-14', 'express'] }, NOW);
  const got = ids(r);
  assert.ok(got.includes('2026-11-19-postgres-latest-becomes-19|match'), got.join('\n'));
  assert.ok(got.includes('2026-11-01-us-clocks-go-back-celery-beat|possible'));
  assert.ok(got.includes('2026-11-07-rails-8-0-security-support-ends|match'));
  assert.ok(got.includes('2026-11-02-github-macos-14-runner-retirement|match'));
  assert.ok(got.includes('2027-01-14-openai-removes-gpt-4o-gpt-4-1|package'), 'langsmith sends gpt-4o by default');
  const pg = r.data.findings.find((f) => f.id === '2026-11-19-postgres-latest-becomes-19');
  assert.deepEqual(pg.because, ['docker:postgres:latest'], 'a numbered tag does not move');
  assert.equal(pg.daysLeft, 6);
  assert.equal(pg.fix.kind, 'tested');
  assert.match(pg.fix.summary, /^Pin the major your database runs today/, 'a fix with no link carries its text');
  assert.equal(pg.related.url, 'https://cybernative.ai/guides/postgres-latest-19-docker-error-in-18-upgrade/');
  assert.equal(pg.link, 'https://cybernative.ai/breakage-calendar/#2026-11-19-postgres-latest-becomes-19');
  assert.deepEqual(r.data.notUnderstood.map((n) => n.raw), ['express']);
  assert.match(r.text, /postgres:latest becomes 19[^\n]*\[HITS\]/);
  assert.match(r.text, /Tested fix \(we ran it on \d{4}-\d\d-\d\d\)/);
  assert.match(r.text, /langsmith [\d.]+ \(read 2026-10-18\) sends gpt-4o by default/);
});

test('check_dependencies: a fix with no link shows its text, not an empty line', async () => {
  const r = await checkDependencies(store, { dependencies: ['pypi:celery'] }, NOW);
  assert.doesNotMatch(r.text, /Tested fix \([^)]*\): *\n/);
});

test('check_dependencies: a pinned stack gets no postgres date, and the window bounds future dates', async () => {
  const pinned = await checkDependencies(store, { dependencies: ['docker:postgres:18.1@sha256:' + 'a'.repeat(64)] }, NOW);
  assert.ok(!ids(pinned).some((x) => x.startsWith('2026-11-19-postgres')));
  const near = await checkDependencies(store, { dependencies: ['model:gpt-4o'], days_ahead: 30 }, NOW);
  assert.ok(!ids(near).some((x) => x.startsWith('2027-01-14')), 'beyond 30 days');
  const far = await checkDependencies(store, { dependencies: ['model:gpt-4o'] }, NOW);
  assert.ok(ids(far).includes('2027-01-14-openai-removes-gpt-4o-gpt-4-1|match'));
});

test('check_dependencies refuses bad arguments', async () => {
  await assert.rejects(checkDependencies(store, { dependencies: [] }, NOW), ToolError);
  await assert.rejects(checkDependencies(store, {}, NOW), ToolError);
  await assert.rejects(checkDependencies(store, { dependencies: ['npm:x'], days_ahead: -1 }, NOW), ToolError);
  await assert.rejects(checkDependencies(store, { dependencies: ['npm:x'], days_ahead: 1.5 }, NOW), ToolError);
});

test('check_files: file lines as evidence, documents only as mentions, and the dates files cannot show', async () => {
  const r = await checkFiles(store, { files: [
    { path: 'compose.yaml', content: 'services:\n  db:\n    image: postgres\n' },
    { path: '.github/workflows/ci.yml', content: 'jobs:\n  b:\n    runs-on: macos-14\n' },
    { path: 'README.md', content: 'We call "gpt-4o" here.\n' },
  ] }, NOW);
  const pg = r.data.findings.find((f) => f.id === '2026-11-19-postgres-latest-becomes-19');
  assert.deepEqual(pg.evidence, [{ path: 'compose.yaml', line: 3, text: 'image: postgres' }]);
  assert.ok(ids(r).includes('2026-11-02-github-macos-14-runner-retirement|match'));
  assert.ok(!ids(r).some((x) => x.startsWith('2027-01-14')), 'README is not source');
  assert.deepEqual(r.data.cannotShowInFiles.map((b) => b.id), ['2027-03-15-tls-100-day-certificates']);
  await assert.rejects(checkFiles(store, { files: [{ path: 'a' }] }, NOW), ToolError);
});

test('check_repository reads a folder inside the allowed roots and nothing outside them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bcm-'));
  const outside = mkdtempSync(join(tmpdir(), 'bcm-out-'));
  try {
    mkdirSync(join(root, 'repo/.github/workflows'), { recursive: true });
    mkdirSync(join(root, 'repo/node_modules/x'), { recursive: true });
    writeFileSync(join(root, 'repo/Dockerfile'), 'FROM postgres:latest\n');
    writeFileSync(join(root, 'repo/.github/workflows/ci.yml'), 'jobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/setup-python@v5\n');
    writeFileSync(join(root, 'repo/node_modules/x/compose.yaml'), 'image: postgres\n');
    writeFileSync(join(outside, 'compose.yaml'), 'image: postgres\n');
    symlinkSync(outside, join(root, 'repo/link'));
    const r = await checkRepository(store, { path: 'repo' }, { now: NOW, roots: [root] });
    const pg = r.data.findings.find((f) => f.id === '2026-11-19-postgres-latest-becomes-19');
    assert.deepEqual(pg.evidence.map((h) => h.path), ['Dockerfile'], 'node_modules and the symlink are skipped');
    assert.ok(ids(r).includes('2026-10-19-ubuntu-latest-26-04-python-ruby-setup|possible'));
    assert.equal(r.data.stats.filesRead, 2);
    await assert.rejects(checkRepository(store, { path: outside }, { now: NOW, roots: [root] }), /only inside/);
    await assert.rejects(checkRepository(store, { path: '../' }, { now: NOW, roots: [join(root, 'repo')] }), /only inside/);
    await assert.rejects(checkRepository(store, { path: 'repo/link' }, { now: NOW, roots: [root] }), /only inside/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('list_upcoming_breaks and get_break', async () => {
  const r = await listUpcoming(store, { days_ahead: 60 }, NOW);
  const got = r.data.breaks.map((b) => b.id);
  assert.ok(got.includes('2026-11-19-postgres-latest-becomes-19'));
  assert.ok(got.includes('2026-11-02-macos-26-runners-openssl-4'), 'an overdue date is still to come');
  assert.ok(!got.includes('2027-01-14-openai-removes-gpt-4o-gpt-4-1'));
  assert.ok(!got.includes('2026-11-07-rails-8-0-security-support-ends'), 'already past');
  assert.equal(r.data.breaks.at(-1).id, '2026-11-02-macos-26-runners-openssl-4', 'overdue last');
  const ai = await listUpcoming(store, { days_ahead: 400, area: 'ai' }, NOW);
  assert.deepEqual(ai.data.breaks.map((b) => b.id), ['2027-01-14-openai-removes-gpt-4o-gpt-4-1']);
  const q = await listUpcoming(store, { days_ahead: 400, query: 'Postgres' }, NOW);
  assert.deepEqual(q.data.breaks.map((b) => b.id), ['2026-11-19-postgres-latest-becomes-19']);
  const g = await getBreak(store, { id: 'https://cybernative.ai/breakage-calendar/#2026-11-19-postgres-latest-becomes-19' }, NOW);
  assert.ok(g.data.break.sources.length > 0);
  assert.match(g.text, /Sources: /);
  await assert.rejects(getBreak(store, { id: 'nope' }, NOW), /No entry/);
});
