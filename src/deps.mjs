// A dependency list as the files a repository would have, so each calendar date's own published search
// (signatures.json) can run on it unchanged. "npm:cron@3" becomes a line in package.json, "docker:postgres:latest"
// a line in compose.yaml, and so on. Each synthetic line remembers the dependency it came from.

export const ECOSYSTEMS = {
  npm: 'npm package: npm:express@4.21.0, npm:@scope/name',
  pypi: 'Python package: pypi:celery==5.4.0, pypi:paramiko',
  gem: 'Ruby gem: gem:rails@8.0.2, gem:sidekiq-cron',
  go: 'Go module: go:golang.org/x/crypto@v0.31.0',
  maven: 'Maven artifact: maven:com.jcraft:jsch@0.1.55',
  docker: 'container image: docker:postgres:latest, docker:node:lts, docker:php:8-apache',
  action: 'GitHub Action: action:actions/setup-python@v5',
  runner: 'CI runner label: runner:ubuntu-latest, runner:macos-14',
  brew: 'Homebrew formula: brew:node@18',
  model: 'AI model id your code sends: model:gpt-4o, model:claude-sonnet-4-5',
  cran: 'R package: cran:decoupleR',
};
const ALIASES = { pip: 'pypi', python: 'pypi', py: 'pypi', node: 'npm', js: 'npm', ruby: 'gem', rubygems: 'gem', image: 'docker', container: 'docker', oci: 'docker', actions: 'action', 'runs-on': 'runner', homebrew: 'brew', r: 'cran', bioc: 'cran', golang: 'go', java: 'maven' };
const SAFE = /^[\x20-\x7e]{1,200}$/; // one printable ASCII line

// "npm:@scope/name@1.2" -> { eco: 'npm', name: '@scope/name', version: '1.2' }. Returns { error } when unusable.
export function parseDep(raw) {
  if (typeof raw !== 'string') return { error: 'not a string' };
  const s = raw.trim();
  if (!SAFE.test(s)) return { raw: s.slice(0, 80), error: 'use one line of printable ASCII, at most 200 characters' };
  const m = s.match(/^([A-Za-z-]+):(.+)$/);
  const eco = m && (ECOSYSTEMS[m[1].toLowerCase()] ? m[1].toLowerCase() : ALIASES[m[1].toLowerCase()]);
  if (!eco) return { raw: s, error: `start with an ecosystem: ${Object.keys(ECOSYSTEMS).join(', ')} (for example npm:express@4)` };
  const spec = m[2].trim();
  let name = spec, version = null;
  if (eco === 'pypi') {
    const p = spec.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(.*)$/);
    if (!p) return { raw: s, error: 'not a Python package name' };
    name = p[1];
    version = p[3] ? (/^[<>=!~]/.test(p[3]) ? p[3] : p[3].replace(/^@/, '')) : null;
  } else if (eco === 'docker') {
    name = spec; // the whole reference, tag and digest included: the searches read it as one
  } else if (eco === 'maven') {
    const at = spec.lastIndexOf('@');
    if (at > 0) { name = spec.slice(0, at); version = spec.slice(at + 1); }
    if (!/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/.test(name)) return { raw: s, error: 'write maven:groupId:artifactId[@version]' };
  } else if (eco === 'runner' || eco === 'model' || eco === 'cran') {
    name = spec;
  } else {
    const at = spec.lastIndexOf('@');
    if (at > 0) { name = spec.slice(0, at); version = spec.slice(at + 1); }
  }
  if (!name || /["'`\\]/.test(name) || (version && /["'`\\]/.test(version))) return { raw: s, error: 'quotes and backslashes are not allowed' };
  return { raw: s, eco, name, version: version || null };
}

// deps: parsed dependencies (no errors). Returns { files: [{ path, text }], origin(path, line) -> [raw] }.
export function synthesize(deps) {
  const files = new Map(); // path -> [{ text, from }]
  const add = (path, text, from) => { if (!files.has(path)) files.set(path, []); files.get(path).push({ text, from }); };
  const by = (eco) => deps.filter((d) => d.eco === eco);

  const npm = by('npm');
  if (npm.length) {
    add('package.json', '{', null);
    add('package.json', '  "dependencies": {', null);
    npm.forEach((d, i) => add('package.json', `    ${JSON.stringify(d.name)}: ${JSON.stringify(d.version || '*')}${i < npm.length - 1 ? ',' : ''}`, d.raw));
    add('package.json', '  }', null);
    add('package.json', '}', null);
  }
  for (const d of by('pypi')) add('requirements.txt', d.version ? `${d.name}${/^[<>=!~]/.test(d.version) ? '' : '=='}${d.version}` : d.name, d.raw);
  const gems = by('gem');
  if (gems.length) {
    for (const l of ['GEM', '  remote: https://rubygems.org/', '  specs:']) add('Gemfile.lock', l, null);
    for (const d of gems) add('Gemfile.lock', `    ${d.name} (${d.version || 'unknown'})`, d.raw);
  }
  const gomods = by('go');
  if (gomods.length) {
    for (const l of ['module example.com/project', '', 'require (']) add('go.mod', l, null);
    for (const d of gomods) add('go.mod', `\t${d.name} ${d.version || 'v0.0.0'}`, d.raw);
    add('go.mod', ')', null);
    // The SSH dates search Go source for the import path, as a repository's own .go files would show it.
    for (const d of gomods) add('deps.go', `import _ "${d.name}"`, d.raw);
  }
  for (const d of by('maven')) {
    const [g, a] = d.name.split(':');
    add('pom.xml', `<dependency><groupId>${g}</groupId><artifactId>${a}</artifactId>${d.version ? `<version>${d.version}</version>` : ''}</dependency>`, d.raw);
  }
  const images = by('docker');
  if (images.length) {
    add('compose.yaml', 'services:', null);
    images.forEach((d, i) => { add('compose.yaml', `  s${i + 1}:`, null); add('compose.yaml', `    image: ${d.name}`, d.raw); });
  }
  const runners = by('runner'), actions = by('action');
  if (runners.length || actions.length) {
    const wf = '.github/workflows/dependencies.yml';
    add(wf, 'on: push', null);
    add(wf, 'jobs:', null);
    const labels = runners.length ? runners : [null];
    labels.forEach((r, i) => {
      add(wf, `  job${i + 1}:`, null);
      if (r) add(wf, `    runs-on: ${r.name}`, r.raw);
      add(wf, '    steps:', null);
      for (const a of actions) add(wf, `      - uses: ${a.name}${a.version ? `@${a.version}` : '@'}`, a.raw);
    });
  }
  for (const d of by('brew')) add('Brewfile', `brew "${d.name}"`, d.raw);
  for (const d of by('model')) add('app/models.py', `model = "${d.name}"`, d.raw);
  for (const d of by('cran')) add('DESCRIPTION', `Imports: ${d.name}`, d.raw);

  const out = [], origin = new Map();
  for (const [path, lines] of files) {
    out.push({ path, text: lines.map((l) => l.text).join('\n') + '\n' });
    lines.forEach((l, i) => { if (l.from) origin.set(`${path}:${i + 1}`, l.from); });
  }
  return { files: out, origin: (path, line) => origin.get(`${path}:${line}`) || null };
}

// PyPI and npm compare names loosely: case, and - _ . are the same.
export const normName = (s) => String(s).toLowerCase().replace(/[-_.]+/g, '-');
