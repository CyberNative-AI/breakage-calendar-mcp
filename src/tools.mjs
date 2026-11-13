// The five tools. Each returns { text, data }: text for the model to read, data as structured content.
// Every date and fix comes from the live calendar files; nothing here restates a date.
import { resolve, delimiter } from 'node:path';
import { SITE, isDate } from './data.mjs';
import { parseDep, synthesize, normName, ECOSYSTEMS } from './deps.mjs';
import { resolveRoot } from './walk.mjs';
import { runScan } from './scan.mjs';

const PAST_DAYS = 30; // a date that took effect in the last 30 days is still reported
const MAX_FILES_GIVEN = 500;
const MAX_TEXT_GIVEN = 8 * 1024 * 1024;

export class ToolError extends Error {}

const dayNum = (d) => { const [y, m, n] = d.split('-').map(Number); return Date.UTC(y, m - 1, n) / 864e5; };
export const todayUtc = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const absUrl = (href) => (typeof href === 'string' && href.startsWith('/') && !href.startsWith('//') ? SITE + href : typeof href === 'string' && /^https:\/\//.test(href) ? href : null);
export const pageLink = (e) => `${SITE}/breakage-calendar/#${encodeURIComponent(e.id)}`;
const firstPara = (s, max) => {
  if (!s) return null;
  const p = String(s).split(/\n\s*\n|(?=Update, \d)/)[0].trim();
  return p.length > max ? p.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : p;
};
const cap = (s, max) => (!s ? null : s.length > max ? s.slice(0, max - 1) + '…' : s);

function timing(e, today) {
  const t = dayNum(today), start = dayNum(e.date), end = dayNum(e.dateEnd || e.date);
  if (e.overdue) return { status: 'overdue', daysLeft: start - t, note: `announced for ${e.date}, not yet in effect when last checked (${e.overdue})` };
  if (t < start) return { status: 'upcoming', daysLeft: start - t, note: `in ${start - t} day${start - t === 1 ? '' : 's'}` };
  if (t <= end) return { status: 'under way', daysLeft: 0, note: `under way until ${e.dateEnd}` };
  return { status: 'in effect', daysLeft: start - t, note: `in effect since ${t - start} day${t - start === 1 ? '' : 's'} ago` };
}

const inWindow = (e, today, daysAhead) => {
  if (e.overdue) return true;
  const t = dayNum(today);
  return dayNum(e.dateEnd || e.date) >= t - PAST_DAYS && dayNum(e.date) <= t + daysAhead;
};

function fixOf(e) {
  const f = e.fix || {};
  return {
    kind: f.kind,
    tested: f.kind === 'tested',
    testedAt: f.kind === 'tested' && isDate(f.testedAt) ? f.testedAt : null,
    label: f.label || null,
    url: absUrl(f.href),
    text: f.text || null,
    code: f.code || null,
  };
}

export function brief(e, today, { full = false } = {}) {
  const tm = timing(e, today);
  const out = {
    id: e.id, date: e.date, dateEnd: e.dateEnd || null, time: e.time || null, ...tm,
    title: e.title, short: e.short || null, area: e.area || null,
    what: full ? e.what : firstPara(e.what, 900),
    affected: full ? e.affected : firstPara(e.affected, 700),
    check: full ? e.check : cap(e.check, 900),
    checkCode: e.checkCode || null,
    fix: fixOf(e),
    link: pageLink(e),
    related: e.see && absUrl(e.see.href) ? { label: e.see.label || null, url: absUrl(e.see.href) } : null,
  };
  if (!full) { out.fix.summary = out.fix.label || out.fix.url ? null : firstPara(out.fix.text, 500); delete out.fix.text; }
  if (full) {
    out.sources = (e.sources || []).map((s) => ({ label: s.label, url: absUrl(s.href), checkedAt: s.checkedAt || null }));
    if (Array.isArray(e.packages)) out.packages = e.packages;
    if (e.packagesNote) out.packagesNote = e.packagesNote;
    out.added = e.added || null;
  }
  return out;
}

const fixLine = (f) => {
  const where = [f.label, f.url].filter(Boolean).join(': ') || f.summary || (f.text ? firstPara(f.text, 500) : '');
  if (f.kind === 'tested') return `Tested fix${f.testedAt ? ` (we ran it on ${f.testedAt})` : ''}: ${where}`;
  if (f.kind === 'guide') return `Guide (a check or guide; the fix itself is not tested by us): ${where}`;
  return `No tested fix yet.${where ? ` Vendor notice: ${where}` : ''}`;
};

const VERDICT = { match: 'HITS', possible: 'MAY HIT', mention: 'NAMED ONLY IN DOCUMENTS', package: 'MAY HIT', named: 'NAMED' };

function renderFinding(f, i) {
  const lines = [`${i + 1}. ${f.date}${f.dateEnd ? ` to ${f.dateEnd}` : ''} (${f.note}) — ${f.title} [${VERDICT[f.verdict]}]`];
  if (f.because?.length) lines.push(`   Because of: ${f.because.join(', ')}`);
  if (f.evidence?.length) lines.push(...f.evidence.slice(0, 3).map((h) => `   ${h.path}:${h.line}: ${h.text}`));
  if (f.packageNote) lines.push(`   ${f.packageNote}`);
  lines.push(`   What changes: ${f.what}`);
  if (f.affected) lines.push(`   Who is affected: ${f.affected}`);
  if (f.check) lines.push(`   Check: ${f.check}`);
  if (f.checkCode) lines.push(`   Check command:\n${f.checkCode.split('\n').map((l) => `     ${l}`).join('\n')}`);
  lines.push(`   ${fixLine(f.fix)}`);
  if (f.related) lines.push(`   More: ${f.related.label ? `${f.related.label} ` : ''}${f.related.url}`);
  if (f.fix.code) lines.push(`   Fix command:\n${f.fix.code.split('\n').map((l) => `     ${l}`).join('\n')}`);
  lines.push(`   Details: ${f.link}`);
  return lines.join('\n');
}

function header(d, today) {
  const stale = d.stale ? ` Could not refresh just now (${d.stale}); this is the copy read at ${new Date(d.fetchedAt).toISOString()}.` : '';
  return `Breakage Calendar (${SITE}/breakage-calendar/, file dated ${d.cal.updated || 'unknown'}), today ${today} UTC.${stale}`;
}

const sourceInfo = (d) => ({ calendar: `${SITE}/breakage-calendar/`, calendarUpdated: d.cal.updated || null, fetchedAt: new Date(d.fetchedAt).toISOString(), stale: d.stale });

function daysArg(v, dflt) {
  if (v === undefined || v === null) return dflt;
  if (!Number.isInteger(v) || v < 0 || v > 3650) throw new ToolError('days_ahead is a whole number from 0 to 3650');
  return v;
}

const order = (a, b) => (a.status === 'overdue') - (b.status === 'overdue') || a.daysLeft - b.daysLeft || a.id.localeCompare(b.id);
const rank = { match: 0, package: 1, possible: 2, named: 3, mention: 4 };

// rows: match.js scan() results. Returns findings for the dates in the window, most urgent first.
function fromRows(rows, byId, today, daysAhead, because) {
  const out = [];
  for (const r of rows) {
    const e = byId.get(r.row);
    if (!e || !inWindow(e, today, daysAhead)) continue;
    const f = { ...brief(e, today), verdict: r.kind, evidence: r.hits.slice(0, 5).map((h) => ({ path: h.path, line: h.line, text: h.text })), moreLines: r.more };
    if (because) {
      f.because = [...new Set(r.hits.map((h) => because(h.path, h.line)).filter(Boolean))];
      delete f.evidence; delete f.moreLines;
    }
    out.push(f);
  }
  return out;
}

function blindIn(d, today, daysAhead) {
  const byId = new Map(d.cal.entries.map((e) => [e.id, e]));
  return Object.entries(d.sigs.blind || {}).map(([id, why]) => [byId.get(id), why])
    .filter(([e]) => e && inWindow(e, today, daysAhead))
    .map(([e, why]) => ({ id: e.id, date: e.date, short: e.short || e.title, reason: String(why).slice(0, 300), link: pageLink(e) }));
}

function report(d, today, findings, extra = {}) {
  findings.sort((a, b) => rank[a.verdict] - rank[b.verdict] || order(a, b));
  const main = findings.filter((f) => f.verdict !== 'mention' && f.verdict !== 'named');
  const side = findings.filter((f) => f.verdict === 'mention' || f.verdict === 'named');
  main.sort(order);
  const parts = [header(d, today)];
  if (extra.intro) parts.push(extra.intro);
  parts.push(main.length
    ? `${main.length} dated break${main.length === 1 ? '' : 's'} found (HITS: the published search matched a line that uses what changes; MAY HIT: it is used, and only some setups break):\n\n${main.map(renderFinding).join('\n\n')}`
    : 'No dated break on the calendar matched. This covers only the dates the calendar lists and only what the given input shows.');
  if (side.length) parts.push(`Also named, not checked (${side.length}):\n${side.map((f) => `- ${f.date} ${f.short || f.title} [${VERDICT[f.verdict]}${f.because?.length ? `: ${f.because.join(', ')}` : ''}] ${f.link}`).join('\n')}`);
  if (extra.notUnderstood?.length) parts.push(`Not understood, so not checked:\n${extra.notUnderstood.map((n) => `- ${n.raw ?? '(input)'}: ${n.error}`).join('\n')}`);
  if (extra.blind?.length) parts.push(`${extra.blind.length} date${extra.blind.length === 1 ? '' : 's'} in this window cannot show in files (servers, certificates, clocks, browsers): ${extra.blind.map((b) => `${b.date} ${b.short}`).join('; ')}. Each has its own check at its link.`);
  if (extra.limits) parts.push(extra.limits);
  return { text: parts.join('\n\n'), data: { source: sourceInfo(d), today, findings: [...main, ...side], ...(extra.notUnderstood ? { notUnderstood: extra.notUnderstood } : {}), ...(extra.blind ? { cannotShowInFiles: extra.blind } : {}), ...(extra.stats ? { stats: extra.stats } : {}) } };
}

export async function checkDependencies(store, args, now = Date.now()) {
  const list = args?.dependencies;
  if (!Array.isArray(list) || list.length < 1 || list.length > 1000) throw new ToolError('dependencies is a list of 1 to 1000 strings like "npm:express@4" or "docker:postgres:latest"');
  const daysAhead = daysArg(args.days_ahead, 365);
  const d = await store.load();
  const today = todayUtc(now);
  const parsed = list.map(parseDep);
  const ok = parsed.filter((p) => !p.error);
  const notUnderstood = parsed.filter((p) => p.error);
  const byId = new Map(d.cal.entries.map((e) => [e.id, e]));
  const findings = [];
  if (ok.length) {
    const { files, origin } = synthesize(ok);
    const r = await runScan({ mode: 'files', files, sigs: d.sigs });
    if (r.error) throw new ToolError(r.error);
    findings.push(...fromRows(r.rows, byId, today, daysAhead, origin));
  }
  // Libraries the calendar names as sending a retiring AI model when the caller does not choose one.
  const seen = new Set(findings.map((f) => f.id));
  for (const e of d.cal.entries) {
    if (!Array.isArray(e.packages) || !inWindow(e, today, daysAhead)) continue;
    for (const dep of ok.filter((x) => x.eco === 'pypi' || x.eco === 'npm')) {
      const p = e.packages.find((q) => q && typeof q.package === 'string' && normName(q.package) === normName(dep.name));
      if (!p) continue;
      const prev = findings.find((f) => f.id === e.id);
      const note = `${p.package} ${p.version || ''} (read ${p.versionReadOn || 'earlier'}) sends ${p.modelId} by default: ${p.role}${p.fileLine ? ` (${p.fileLine})` : ''}. Choose a model explicitly to avoid it.`;
      if (prev) { prev.because = [...new Set([...(prev.because || []), dep.raw])]; prev.packageNote = note; continue; }
      findings.push({ ...brief(e, today), verdict: 'package', because: [dep.raw], packageNote: note });
      seen.add(e.id);
    }
  }
  // Dates whose title names a dependency and that have no search of their own: listed for reading, not as hits.
  // A date with a search already answered: its search did not match, so it is not listed.
  const searched = new Set(d.sigs.signatures.map((x) => x.row));
  for (const dep of ok) {
    const base = dep.eco === 'docker' ? dep.name.replace(/^(docker\.io\/)?(library\/)?/, '').split(/[:@]/)[0].split('/').pop() : dep.eco === 'maven' ? dep.name.split(':')[1] : dep.name.split('/').pop();
    if (!base || base.length < 3) continue;
    const re = new RegExp(`(^|[^A-Za-z0-9_.-])${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_-]|$)`, 'i');
    let n = 0;
    for (const e of d.cal.entries) {
      if (n >= 5 || !inWindow(e, today, daysAhead)) continue;
      if (searched.has(e.id) || findings.some((f) => f.id === e.id)) continue;
      if (![e.title, e.short].some((t) => t && re.test(t))) continue;
      findings.push({ ...brief(e, today), verdict: 'named', because: [dep.raw] });
      n++;
    }
  }
  return report(d, today, findings, { notUnderstood, intro: `Checked ${ok.length} dependenc${ok.length === 1 ? 'y' : 'ies'} with each date's own published search.` });
}

export async function checkFiles(store, args, now = Date.now()) {
  const files = args?.files;
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES_GIVEN) throw new ToolError(`files is a list of 1 to ${MAX_FILES_GIVEN} {path, content} objects`);
  let total = 0;
  const clean = files.map((f, i) => {
    if (!f || typeof f.path !== 'string' || typeof f.content !== 'string' || !f.path.trim()) throw new ToolError(`files[${i}] needs a path and a content string`);
    total += f.content.length;
    return { path: f.path.replace(/\\/g, '/').replace(/^\.?\/+/, ''), text: f.content };
  });
  if (total > MAX_TEXT_GIVEN) throw new ToolError(`the files hold more than ${MAX_TEXT_GIVEN} characters; give the dependency manifests, Dockerfiles, Compose files and CI workflows first`);
  const daysAhead = daysArg(args.days_ahead, 365);
  const d = await store.load();
  const today = todayUtc(now);
  const r = await runScan({ mode: 'files', files: clean, sigs: d.sigs });
  if (r.error) throw new ToolError(r.error);
  const byId = new Map(d.cal.entries.map((e) => [e.id, e]));
  return report(d, today, fromRows(r.rows, byId, today, daysAhead), { blind: blindIn(d, today, daysAhead), intro: `Ran each date's published search over ${clean.length} file${clean.length === 1 ? '' : 's'}. Paths matter: the searches choose files by name (package.json, requirements.txt, compose.yaml, Dockerfile, .github/workflows/*.yml, Gemfile.lock, …).` });
}

export function allowedRoots(env = process.env, cwd = process.cwd()) {
  const extra = (env.BREAKAGE_CALENDAR_ROOTS || '').split(delimiter).filter(Boolean);
  return [...new Set([cwd, ...extra].map((p) => resolve(p)))];
}

export async function checkRepository(store, args, { now = Date.now(), roots = allowedRoots() } = {}) {
  const path = args?.path === undefined ? '.' : args.path;
  if (typeof path !== 'string' || !path || path.length > 4096) throw new ToolError('path is a folder path');
  let where = null, why = [];
  for (const root of roots) {
    try { where = { root, ...resolveRoot(root, path) }; break; } catch (e) { why.push(e.message); }
  }
  if (!where) throw new ToolError(roots.length
    ? `This server reads folders only inside ${roots.join(', ')}. ${why[0] || ''} Use check_files to send file contents instead.`
    : 'No project folder was chosen for this server, so it reads none. Choose a folder in the client\'s settings for this server, or use check_files or check_dependencies.');
  const daysAhead = daysArg(args.days_ahead, 365);
  const d = await store.load();
  const today = todayUtc(now);
  const r = await runScan({ mode: 'tree', base: where.base, sigs: d.sigs });
  if (r.error) throw new ToolError(r.error);
  const byId = new Map(d.cal.entries.map((e) => [e.id, e]));
  const s = r.stats;
  const limits = s.stopped ? `Only part of the folder was read: the ${s.stopped} limit was reached. Check a smaller folder.` : null;
  return report(d, today, fromRows(r.rows, byId, today, daysAhead), {
    blind: blindIn(d, today, daysAhead), limits, stats: { filesRead: s.files, bytesRead: s.bytes, skippedLarge: s.skippedLarge, stopped: s.stopped },
    intro: `Read ${s.files} text file${s.files === 1 ? '' : 's'} under ${where.base} (skipping .git, node_modules, virtual environments and build output) and ran each date's published search. Nothing was sent anywhere.`,
  });
}

export async function listUpcoming(store, args, now = Date.now()) {
  const daysAhead = daysArg(args?.days_ahead, 90);
  const area = args?.area === undefined ? null : String(args.area).toLowerCase();
  const q = args?.query === undefined ? null : String(args.query).toLowerCase().slice(0, 200);
  const d = await store.load();
  const today = todayUtc(now);
  const t = dayNum(today);
  const rows = d.cal.entries
    .filter((e) => e.overdue || (dayNum(e.dateEnd || e.date) >= t && dayNum(e.date) <= t + daysAhead))
    .filter((e) => !area || (e.area || '').toLowerCase().includes(area))
    .filter((e) => !q || [e.title, e.short, e.area, e.what, e.affected, e.id].some((s) => s && s.toLowerCase().includes(q)))
    .map((e) => brief(e, today)).sort(order);
  const areas = [...new Set(d.cal.entries.map((e) => e.area).filter(Boolean))].sort();
  const text = [header(d, today),
    rows.length ? `${rows.length} date${rows.length === 1 ? '' : 's'} still to come within ${daysAhead} days${area ? `, area "${args.area}"` : ''}${q ? `, matching "${args.query}"` : ''}:` : `No date still to come within ${daysAhead} days${area ? ` in area "${args.area}"` : ''}${q ? ` matching "${args.query}"` : ''}.`,
    ...rows.map((r) => `- ${r.date}${r.dateEnd ? ` to ${r.dateEnd}` : ''} (${r.note}) ${r.short || r.title} [${r.area}; ${r.fix.kind === 'tested' ? 'tested fix' : r.fix.kind === 'guide' ? 'guide' : 'no tested fix yet'}] id ${r.id}`),
    rows.length ? 'Use get_break with an id for the full entry, or check_dependencies / check_repository to see which of these hit a project.' : `Areas: ${areas.join(', ')}.`].join('\n');
  return { text, data: { source: sourceInfo(d), today, breaks: rows, areas } };
}

export async function getBreak(store, args, now = Date.now()) {
  const id = args?.id;
  if (typeof id !== 'string' || !id) throw new ToolError('id is an entry id, for example 2026-11-19-postgres-latest-becomes-19');
  const d = await store.load();
  const today = todayUtc(now);
  const e = d.cal.entries.find((x) => x.id === id.trim().replace(/^.*#/, ''));
  if (!e) throw new ToolError(`No entry with id "${id.slice(0, 200)}". list_upcoming_breaks shows the ids.`);
  const b = brief(e, today, { full: true });
  const text = [header(d, today), `${b.date}${b.dateEnd ? ` to ${b.dateEnd}` : ''}${b.time ? `, ${b.time}` : ''} (${b.note}) — ${b.title}`, `Area: ${b.area}`,
    `What changes: ${b.what}`, `Who is affected: ${b.affected}`, `Check: ${b.check}`, b.checkCode ? `Check command:\n${b.checkCode}` : null,
    fixLine(b.fix), b.fix.text ? `Fix: ${b.fix.text}` : null, b.fix.code ? `Fix command:\n${b.fix.code}` : null,
    b.packagesNote ? `Libraries that send it by default: ${b.packages.map((p) => `${p.package} ${p.version} (${p.role})`).join('; ')}. ${b.packagesNote}` : null,
    b.related ? `Related: ${b.related.label}: ${b.related.url}` : null,
    `Sources: ${b.sources.map((s) => `${s.label} ${s.url}${s.checkedAt ? ` (read ${s.checkedAt})` : ''}`).join('; ')}`,
    `Details: ${b.link}`].filter(Boolean).join('\n\n');
  return { text, data: { source: sourceInfo(d), today, break: b } };
}

const DAYS = { type: 'integer', minimum: 0, maximum: 3650, description: 'Report dates up to this many days ahead (default 365). Dates that took effect in the last 30 days, and announced dates that are late, are always included.' };
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export const TOOLS = [
  {
    name: 'check_dependencies',
    title: 'Dated breaks for a dependency list',
    description: 'Which dated upstream changes (image tags that move, AI models and APIs that shut down, CI runners that are retired, packages that stop installing) will break these dependencies, and the fix for each, with the day it was tested. Runs each Breakage Calendar date\'s own published search. Use before upgrading, pinning or deploying. Write each dependency as ecosystem:name[@version]: '
      + Object.values(ECOSYSTEMS).join('; ') + '.',
    inputSchema: { type: 'object', properties: { dependencies: { type: 'array', minItems: 1, maxItems: 1000, items: { type: 'string', maxLength: 200 }, description: 'For example ["docker:postgres:latest", "pypi:celery==5.4.0", "npm:cron@3.1.7", "runner:macos-14", "model:gpt-4o"]' }, days_ahead: DAYS }, required: ['dependencies'], additionalProperties: false },
    annotations: { title: 'Dated breaks for a dependency list', ...RO },
    run: (store, args) => checkDependencies(store, args),
  },
  {
    name: 'check_files',
    title: 'Dated breaks in given files',
    description: 'Runs every Breakage Calendar date\'s published search over file contents you pass (package.json, requirements.txt, pyproject.toml, Gemfile.lock, go.mod, Dockerfile, compose.yaml, .github/workflows/*.yml, source files that name AI models) and reports the dates that will break them, with the file line, the check and the tested fix. Use when the server cannot read the project folder itself.',
    inputSchema: { type: 'object', properties: { files: { type: 'array', minItems: 1, maxItems: MAX_FILES_GIVEN, items: { type: 'object', properties: { path: { type: 'string', description: 'Path relative to the repository top, e.g. .github/workflows/ci.yml' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } }, days_ahead: DAYS }, required: ['files'], additionalProperties: false },
    annotations: { title: 'Dated breaks in given files', ...RO },
    run: (store, args) => checkFiles(store, args),
  },
  {
    name: 'check_repository',
    title: 'Dated breaks in a local repository',
    description: 'Reads a local project folder (text files only; skips .git, node_modules, virtual environments and build output) and runs every Breakage Calendar date\'s published search over it: which dated upstream changes will break this repository, on which line, and the tested fix. Nothing from the folder is sent anywhere. The folder must be inside a folder this server may read: its working folder and BREAKAGE_CALENDAR_ROOTS, or, when the client chose folders, only those.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Folder to read, absolute or relative to the first folder this server may read (default ".")' }, days_ahead: DAYS }, additionalProperties: false },
    annotations: { title: 'Dated breaks in a local repository', ...RO },
    run: (store, args, ctx = {}) => checkRepository(store, args, ctx.roots ? { roots: ctx.roots } : {}),
  },
  {
    name: 'list_upcoming_breaks',
    title: 'Upcoming dated breaks',
    description: 'Lists Breakage Calendar dates still to come: runtimes, images, APIs, AI models, CI runners, certificates and time-zone rules that stop working on a known date, each with the kind of fix (tested, guide, or none yet). Filter by area or a word.',
    inputSchema: { type: 'object', properties: { days_ahead: { ...DAYS, description: 'Dates up to this many days ahead (default 90). Late announced dates are always included.' }, area: { type: 'string', maxLength: 100, description: 'Part of an area name, e.g. "AI APIs", "CI runners", "Time zones"' }, query: { type: 'string', maxLength: 200, description: 'A word to find in the title or text, e.g. "postgres"' } }, additionalProperties: false },
    annotations: { title: 'Upcoming dated breaks', ...RO },
    run: (store, args) => listUpcoming(store, args),
  },
  {
    name: 'get_break',
    title: 'One dated break in full',
    description: 'The full Breakage Calendar entry for one id: what changes, who is affected, how to check, the fix (with the day we tested it, if we did), the command, and the vendor sources with the day each was last read.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', maxLength: 300, description: 'Entry id, e.g. 2026-11-19-postgres-latest-becomes-19' } }, required: ['id'], additionalProperties: false },
    annotations: { title: 'One dated break in full', ...RO },
    run: (store, args) => getBreak(store, args),
  },
];
