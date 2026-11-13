// The calendar's two public files, read live from cybernative.ai and kept in memory.
// Nothing about the caller's project is sent: two GET requests with no body, redirects refused.
// The files are admitted only if every field the tools use has the expected type, size and, for searches,
// valid regular-expression syntax (the same rules as the dated-break-check GitHub Action).

export const SITE = 'https://cybernative.ai';
export const ENTRIES_PATH = '/breakage-calendar/entries.json';
export const SIGNATURES_PATH = '/breakage-calendar/check/signatures.json';
export const VERSION = '0.1.0';
export const UA = `breakage-calendar-mcp/${VERSION} (+https://github.com/CyberNative-AI/breakage-calendar-mcp)`;
const MAX_RESPONSE = 4 * 1024 * 1024; // each file
const FRESH_MS = 60 * 60 * 1000; // re-ask the server (with If-None-Match) after an hour
const TIMEOUT_MS = 15000;

const ID = /^[a-z0-9][a-z0-9.-]{0,199}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = new Set(['match', 'possible', 'postgres']);
const FILE_SETS = new Set(['any', 'source', 'workflow']);
const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const optStr = (v, max) => v === undefined || v === null || isStr(v, max);
const isRegex = (p) => {
  if (!isStr(p, 2000)) return false;
  try { new RegExp(p); return true; } catch { return false; }
};
export const isDate = (d) => {
  if (typeof d !== 'string' || !DATE.test(d)) return false;
  const [y, m, n] = d.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, n));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === n;
};

// Returns null when the data can be used, else what is wrong with it.
export function checkData(sigs, cal) {
  if (!sigs || typeof sigs !== 'object' || !Array.isArray(sigs.signatures)) return 'signatures: no signature list';
  if (sigs.signatures.length < 1 || sigs.signatures.length > 500) return 'signatures: count out of range';
  if (!isRegex(sigs.workflow)) return 'signatures: bad workflow search';
  const rows = new Set();
  let chars = 0;
  for (const s of sigs.signatures) {
    if (!s || typeof s !== 'object' || typeof s.row !== 'string' || !ID.test(s.row) || rows.has(s.row)) return 'signatures: bad or repeated row';
    rows.add(s.row);
    if (!KINDS.has(s.kind)) return `signatures: ${s.row}: bad kind`;
    if (!FILE_SETS.has(s.files) && !isRegex(s.files)) return `signatures: ${s.row}: bad file search`;
    if (!Array.isArray(s.patterns) || s.patterns.length > 50 || !s.patterns.every(isRegex)) return `signatures: ${s.row}: bad search`;
    if (s.needs !== undefined && !isRegex(s.needs)) return `signatures: ${s.row}: bad needs search`;
    chars += s.patterns.reduce((n, p) => n + p.length, 0);
  }
  if (chars > 100000) return 'signatures: searches too long';
  if (sigs.blind !== undefined && (typeof sigs.blind !== 'object' || sigs.blind === null)) return 'signatures: bad blind list';
  if (!cal || typeof cal !== 'object' || !Array.isArray(cal.entries)) return 'entries: no entry list';
  if (cal.entries.length < 1 || cal.entries.length > 5000) return 'entries: count out of range';
  const ids = new Set();
  for (const e of cal.entries) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !ID.test(e.id) || ids.has(e.id)) return 'entries: bad or repeated id';
    ids.add(e.id);
    const at = `entries: ${e.id}`;
    if (!isDate(e.date)) return `${at}: bad date`;
    if (e.dateEnd !== undefined && e.dateEnd !== null && !isDate(e.dateEnd)) return `${at}: bad dateEnd`;
    if (e.overdue !== undefined && e.overdue !== null && !isDate(e.overdue)) return `${at}: bad overdue`;
    if (!isStr(e.title, 500)) return `${at}: bad title`;
    for (const k of ['short', 'area', 'time', 'datePrecision']) if (!optStr(e[k], 500)) return `${at}: bad ${k}`;
    for (const k of ['what', 'affected', 'check', 'checkCode']) if (!optStr(e[k], 20000)) return `${at}: bad ${k}`;
    if (!e.fix || typeof e.fix !== 'object' || !isStr(e.fix.kind, 20)) return `${at}: bad fix`;
    for (const k of ['href', 'label', 'text', 'code', 'testedAt']) if (!optStr(e.fix[k], 20000)) return `${at}: bad fix.${k}`;
    if (e.sources !== undefined && !Array.isArray(e.sources)) return `${at}: bad sources`;
    if (e.packages !== undefined && !Array.isArray(e.packages)) return `${at}: bad packages`;
  }
  return null;
}

async function getJson(fetchImpl, path, etag) {
  const headers = { 'user-agent': UA, accept: 'application/json' };
  if (etag) headers['if-none-match'] = etag;
  const r = await fetchImpl(SITE + path, { headers, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (r.status === 304 && etag) return { notModified: true };
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  if (Number(r.headers.get('content-length')) > MAX_RESPONSE) throw new Error(`${path}: larger than ${MAX_RESPONSE} bytes`);
  if (!r.body) throw new Error(`${path}: empty answer`);
  const reader = r.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_RESPONSE) { await reader.cancel(); throw new Error(`${path}: larger than ${MAX_RESPONSE} bytes`); }
    chunks.push(value);
  }
  let json;
  try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error(`${path}: not valid JSON`); }
  return { json, etag: r.headers.get('etag') };
}

// One cache per server process. load() returns { cal, sigs, fetchedAt } or throws with a reason a person can read.
// A failed refresh keeps serving the copy already read, and says so (stale).
export function createStore({ fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  let cur = null; // { cal, sigs, etags, fetchedAt, checkedAt }
  let pending = null;
  async function refresh() {
    const [e, s] = await Promise.all([
      getJson(fetchImpl, ENTRIES_PATH, cur?.etags.entries),
      getJson(fetchImpl, SIGNATURES_PATH, cur?.etags.signatures),
    ]);
    const cal = e.notModified ? cur.cal : e.json;
    const sigs = s.notModified ? cur.sigs : s.json;
    const bad = checkData(sigs, cal);
    if (bad) throw new Error(`the calendar files are not in the expected form (${bad})`);
    const changed = !e.notModified || !s.notModified;
    cur = {
      cal, sigs,
      etags: { entries: e.notModified ? cur.etags.entries : e.etag, signatures: s.notModified ? cur.etags.signatures : s.etag },
      fetchedAt: changed || !cur ? now() : cur.fetchedAt,
      checkedAt: now(),
    };
  }
  return {
    async load() {
      if (cur && now() - cur.checkedAt < FRESH_MS) return { ...cur, stale: null };
      if (!pending) pending = refresh().finally(() => { pending = null; });
      try {
        await pending;
        return { ...cur, stale: null };
      } catch (err) {
        const why = err.cause && err.cause.message ? `${err.message}: ${err.cause.message}` : String(err.message || err);
        if (cur) return { ...cur, stale: why.slice(0, 300) };
        throw new Error(`Could not read the Breakage Calendar from ${SITE}: ${why.slice(0, 300)}`);
      }
    },
  };
}
