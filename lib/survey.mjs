// pica-journal survey: what an import reads, distilled without Claude (the plan sheet "Import and refactor").
//
//   survey [--transcripts] [--since <commit>]   a digest of the project, as Markdown on stdout
//   survey transcript <session> [--files a,b] [--from <n>]   one session's conversation, filtered, as text
//
// Git, weighted by what survives: blame at HEAD (-w -M, and .git-blame-ignore-revs when the project has one)
// counts each commit's lines still present. The journal, lockfiles, generated, vendored and binary files are left
// out. Surviving commits are grouped into threads by the file most of their surviving lines are in (its folder,
// unless the folder is crowded, then the file itself). A commit that removes more than it adds, or reverts, is a
// decision too: the largest are weighed by the size and age of what they removed. The digest's size is set by
// caps, never by the repo.
//
// Transcripts, only with --transcripts: Claude Code's sessions under ~/.claude/projects, found by the folder each
// ran in (the project, its worktrees, or a folder above it when the session names the project's files), never by
// the transcript folder's name. Only the writer's words, Claude's answers and each session's last compaction
// summary are kept, scrubbed of addresses, keys, tokens and phone numbers, and pasted material is dropped. The
// journal's own sessions are left out: their replies are in the journal already.
//
// Everything kept between runs (each file's blame, the transcript index and the filtered sessions) lives in the
// plugin's data folder, never the journal: $CLAUDE_PLUGIN_DATA, else ~/.cache/pica-journal, one folder a project.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { execFile } from 'node:child_process';
import { ROOT, DIR, MEM, memoryOf } from './folder.mjs';
import { denied, PROJECT } from './refs.mjs';
import { runningProject, runningRest, moved, fit } from './running.mjs';

const CACHE_VERSION = 2, RUNNING_VERSION = 2;
const DATA = path.join(process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.cache', 'pica-journal'), PROJECT);
const CAP = { threads: 12, below: 30, lead: 3, subjects: 12, body: 900, subject: 160, removals: 12, hunks: 30, sessions: 60, answer: 3000, words: 4000, files: 8, docs: 30 };
const LARGE_FILE = 400_000;          // a tracked file this large is data, not work: not blamed
const CROWDED = 15;
// records, results and exports kept in the repo: data, not work, once past a config file's size
const DATA_EXT = /\.(json|jsonl|ndjson|csv|tsv|xml|geojson|html?)$/i, DATA_SIZE = 20_000;                  // a folder with more files than this is split into its files' threads

class Stop extends Error {}
const stop = (m) => { throw new Stop(m); };

// ---- git ------------------------------------------------------------------------------------------------------
function run(args, { ok = [0], max = 512 << 20 } = {}) {
  return new Promise((res, rej) => execFile('git', args, { cwd: ROOT, maxBuffer: max, encoding: 'utf8' }, (e, out) => {
    if (e && !ok.includes(e.code)) rej(e); else res({ out: out ?? '', code: e ? e.code : 0 });
  }));
}
const git = async (...args) => (await run(args)).out;
async function pool(items, n, f) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await f(items[k], k); } }));
  return out;
}
const CPUS = Math.max(2, Math.min(8, os.cpus().length));

// ---- what is the project's own work ---------------------------------------------------------------------------
const LICENCE = /(^|\/)(LICEN[CS]E|COPYING|NOTICE)(\.\w+)?$|(^|\/)licen[cs]es?\//i;
const LOCKS = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum|flake\.lock|[^/]+\.lock)$/;
const MADE = /(^|\/)(dist|build|out|\.next|\.nuxt|\.svelte-kit|coverage|vendor|third_party|__generated__|generated)\//;
const MADE_NAME = /\.(min\.(js|css)|map|snap)$|\.generated\.|\.pb\.go$|_pb2\.py$/;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|psd|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|woff2?|ttf|otf|eot|mp3|mp4|m4a|wav|ogg|webm|mov|avi|wasm|sqlite3?|db|bin|exe|dll|so|dylib|class|pyc)$/i;
/** why a path is not the project's own work, by its name alone (null: it is) */
export function leftOut(rel) {
  if (denied(rel)) return 'protected';
  if (LOCKS.test(rel)) return 'lockfile';
  if (LICENCE.test(rel)) return 'licence';
  if (MADE.test(rel) || MADE_NAME.test(rel)) return 'generated';
  if (BINARY_EXT.test(rel)) return 'binary';
  return null;
}

/** the files blame reads: tracked at HEAD, the project's own, text, not huge */
async function ownFiles() {
  const sizes = new Map();
  for (const l of (await git('ls-tree', '-r', '-l', '-z', 'HEAD')).split('\0')) {
    const m = /^\d+ blob [0-9a-f]+ +(\d+|-)\t(.+)$/s.exec(l); if (m) sizes.set(m[2], +m[1] || 0);
  }
  const text = new Set();
  for (const l of (await git('ls-files', '--eol', '-z')).split('\0')) {
    const m = /^i\/(\S*)\s+w\/\S*\s+attr\/[^\t]*\t(.+)$/s.exec(l); if (m && m[1] !== '-text') text.add(m[2]);
  }
  // .gitattributes may mark files generated or vendored (linguist's attributes)
  const marked = new Set(), names = [...sizes.keys()];
  if (names.length) {
    const out = await new Promise((res) => {
      const p = execFile('git', ['check-attr', '-z', '--stdin', 'linguist-generated', 'linguist-vendored'], { cwd: ROOT, maxBuffer: 256 << 20 }, (e, o) => res(e ? '' : o));
      p.stdin.end(names.join('\0') + '\0');
    });
    const f = out.split('\0');
    for (let i = 0; i + 2 < f.length; i += 3) if (f[i + 2] === 'set' || f[i + 2] === 'true') marked.add(f[i]);
  }
  const files = [], out = {};
  for (const [rel, size] of sizes) {
    const why = leftOut(rel) ?? (marked.has(rel) ? 'generated' : !text.has(rel) ? 'binary' : size > LARGE_FILE ? 'large' : DATA_EXT.test(rel) && size > DATA_SIZE ? 'data' : null);
    if (why) out[why] = (out[why] ?? 0) + 1; else files.push(rel);
  }
  return { files, out };
}

// ---- blame, cached by file ------------------------------------------------------------------------------------
const cacheFile = (n) => path.join(DATA, n);
function readCache(n) { try { return JSON.parse(fs.readFileSync(cacheFile(n), 'utf8')); } catch { return null; } }
function writeCache(n, v) {
  const p = cacheFile(n), tmp = p + '.' + process.pid;
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tmp, typeof v === 'string' ? v : JSON.stringify(v), { mode: 0o600 }); fs.renameSync(tmp, p);
}

async function blameAll(head, files) {
  const ignore = fs.existsSync(path.join(ROOT, '.git-blame-ignore-revs')) ? ['--ignore-revs-file', '.git-blame-ignore-revs'] : [];
  const key = ignore.length ? fs.readFileSync(path.join(ROOT, '.git-blame-ignore-revs'), 'utf8') : '';
  const c = readCache('blame.json');
  let kept = {}, again = new Set(files);
  // a file blames the same while its own history does: after an earlier HEAD still in this history, only the
  // files changed since are blamed again (a rebase, or a new ignore list, blames everything)
  if (c?.v === CACHE_VERSION && c.ignore === key && c.head && (c.head === head || (await run(['merge-base', '--is-ancestor', c.head, head], { ok: [0, 1, 128] })).code === 0)) {
    const changed = new Set(c.head === head ? [] : (await git('diff', '--name-only', '-z', c.head, head)).split('\0').filter(Boolean));
    again = new Set(files.filter(f => changed.has(f) || !c.files[f]));
    for (const f of files) if (!again.has(f)) kept[f] = c.files[f];
  }
  const list = [...again];
  const t0 = Date.now();
  await pool(list, CPUS, async (f) => {
    const counts = {};
    try {
      const { out } = await run(['blame', '-w', '-M', '--porcelain', ...ignore, head, '--', f]);
      // a group of lines from one commit opens with "<sha> <orig> <final> <count>"
      for (const m of out.matchAll(/^([0-9a-f]{40}) \d+ \d+ (\d+)$/gm)) counts[m[1]] = (counts[m[1]] ?? 0) + +m[2];
    } catch {}
    kept[f] = counts;
  });
  writeCache('blame.json', { v: CACHE_VERSION, head, ignore: key, files: kept });
  return { blame: kept, blamed: list.length, cached: files.length - list.length, ms: Date.now() - t0 };
}

// ---- the log --------------------------------------------------------------------------------------------------
/** numstat's path, after a rename ("a => b", "dir/{a => b}/x") the new one */
export function newPath(p) {
  const b = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(p);
  if (b) return (b[1] + b[3] + b[4]).replace(/\/\//g, '/');
  const r = / => /.exec(p); return r ? p.slice(r.index + 4) : p;
}
async function readLog() {
  const out = await git('log', '-M', '--numstat', '--format=%x1e%H%x1f%P%x1f%at%x1f%s', 'HEAD');
  const commits = [];
  for (const rec of out.split('\x1e').slice(1)) {
    const [head, ...rest] = rec.split('\n');
    const [sha, parents, at, subject] = head.split('\x1f');
    const c = { sha, parents: parents ? parents.split(' ') : [], at: +at * 1000, subject, add: 0, del: 0, files: {} };
    for (const l of rest) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l); if (!m || m[1] === '-') continue;
      const p = newPath(m[3]); if (leftOut(p)) continue;
      c.add += +m[1]; c.del += +m[2]; c.files[p] = [+m[1], +m[2]];
    }
    commits.push(c);
  }
  return commits;      // newest first
}

// ---- threads --------------------------------------------------------------------------------------------------
const PROSE = /\.(md|mdx|markdown|txt|rst|adoc|org)$/i;
/** Threads: each file's surviving lines go to its folder's thread (or, in a crowded folder, the file's own), so
 *  a commit that touched several places counts in each, by the lines it left there. Prose (plans, notes, READMEs)
 *  is a source to read, not work to weigh: it is listed apart, under Documents. */
function threadsOf(commits, blame, files) {
  const perDir = new Map();
  for (const f of files) { const d = path.posix.dirname(f); perDir.set(d, (perDir.get(d) ?? 0) + 1); }
  const area = (f) => { const d = path.posix.dirname(f); return d === '.' || (perDir.get(d) ?? 0) > CROWDED ? f : d + '/'; };
  const by = new Map(commits.map(c => [c.sha, c]));
  for (const c of commits) { c.alive = 0; c.code = 0; }
  const threads = new Map(), docs = [];
  for (const [f, counts] of Object.entries(blame)) {
    const prose = PROSE.test(f); let total = 0;
    for (const [sha, n] of Object.entries(counts)) {
      const c = by.get(sha); if (!c) continue;      // (a boundary commit outside this history)
      c.alive += n; total += n;
      if (prose || c.parents.length > 1) continue;  // a merge says what its branch said
      c.code += n;
      const k = area(f);
      if (!threads.has(k)) threads.set(k, { key: k, alive: 0, here: new Map(), files: {} });
      const t = threads.get(k); t.alive += n; t.here.set(c, (t.here.get(c) ?? 0) + n); t.files[f] = (t.files[f] ?? 0) + n;
    }
    if (prose && total) docs.push({ file: f, lines: total, last: commits.find(c => c.files[f])?.at ?? null });
  }
  // a folder's thread joins the nearest folder above it that has one, when it is the smaller (logic/nodes/ is part
  // of logic/; a big folder under a thin src/ is a topic of its own), deepest first
  const own = new Map([...threads].map(([k, t]) => [k, t.alive]));
  for (const k of [...threads.keys()].filter(k => k.endsWith('/')).sort((a, b) => b.split('/').length - a.split('/').length)) {
    let up = path.posix.dirname(k.slice(0, -1));
    while (up !== '.' && !threads.has(up + '/')) up = path.posix.dirname(up);
    if (up === '.' || own.get(k) >= own.get(up + '/')) continue;
    const t = threads.get(k), into = threads.get(up + '/');
    into.alive += t.alive;
    for (const [c, n] of t.here) into.here.set(c, (into.here.get(c) ?? 0) + n);
    for (const [f, n] of Object.entries(t.files)) into.files[f] = (into.files[f] ?? 0) + n;
    threads.delete(k);
  }
  for (const t of threads.values()) t.commits = [...t.here.keys()].sort((a, b) => t.here.get(b) - t.here.get(a));
  return { threads: [...threads.values()].sort((a, b) => b.alive - a.alive), docs: docs.sort((a, b) => b.lines - a.lines) };
}

/** commits that remove more than they add, and reverts: weighed by the size and age of what they removed */
async function removals(commits) {
  const cands = commits.filter(c => c.parents.length === 1 && (/^Revert\b/.test(c.subject) || c.del >= 50 && c.del > 2 * c.add))
    .sort((a, b) => b.del - a.del).slice(0, CAP.removals);
  await pool(cands, CPUS, async (c) => {
    let lines = 0, age = 0, n = 0;
    const diff = await git('diff', '-U0', '--no-color', '-M', c.parents[0], c.sha).catch(() => '');
    let file = null;
    for (const l of diff.split('\n')) {
      const f = /^--- a\/(.+)$/.exec(l); if (f) { file = leftOut(f[1]) ? null : f[1]; continue; }
      if (l.startsWith('--- ')) { file = null; continue; }
      const h = /^@@ -(\d+)(?:,(\d+))? /.exec(l); if (!h || !file || n >= CAP.hunks) continue;
      const from = +h[1], len = h[2] === undefined ? 1 : +h[2]; if (!len) continue;
      n++;
      const out = await git('blame', '-w', '--porcelain', '-L', `${from},+${len}`, c.parents[0], '--', file).catch(() => '');
      const times = new Map(); let sha = null;
      for (const b of out.split('\n')) {
        const s = /^([0-9a-f]{40}) \d+ \d+(?: (\d+))?$/.exec(b); if (s) { sha = s[1]; if (s[2]) times.set(sha, times.get(sha) ?? null); continue; }
        const t = /^author-time (\d+)$/.exec(b); if (t && sha) times.set(sha, +t[1] * 1000);
        if (b.startsWith('\t') && sha && times.get(sha)) { lines++; age += c.at - times.get(sha); }
      }
    }
    c.removedAge = lines ? age / lines / 86400000 : 0;
  });
  return cands;
}

async function bodies(shas) {
  if (!shas.length) return new Map();
  const out = await git('show', '-s', '--no-color', '--format=%x1e%H%n%b', ...shas);
  const m = new Map();
  for (const r of out.split('\x1e').slice(1)) { const i = r.indexOf('\n'); m.set(r.slice(0, i), scrub(r.slice(i + 1).replace(/^(Co-Authored-By|Signed-off-by|Reviewed-by|Change-Id):.*$/gim, '').trim())); }
  return m;
}

/** every commit's body, trailers left out (one git log: 3 MB, a tenth of a second, on 4,000 commits) */
async function bodiesAll() {
  const out = await git('log', '--no-color', '--format=%x1e%H%n%b', 'HEAD');
  const m = new Map();
  for (const r of out.split('\x1e').slice(1)) { const i = r.indexOf('\n'); const b = r.slice(i + 1).replace(/^(Co-Authored-By|Signed-off-by|Reviewed-by|Change-Id):.*$/gim, '').trim(); if (b) m.set(r.slice(0, i), b); }
  return m;
}

async function branches(head) {
  const current = (await git('rev-parse', '--abbrev-ref', 'HEAD')).trim();
  const out = (await git('for-each-ref', '--no-merged=' + head, '--format=%(refname:short)%1f%(committerdate:unix)%1f%(subject)', 'refs/heads', 'refs/remotes')).split('\n').filter(Boolean);
  const month = Date.now() - 30 * 86400000, live = [], stale = [];
  for (const l of out) {
    const [name, at, subject] = l.split('\x1f');
    if (name.endsWith('/HEAD')) continue;
    (+at * 1000 >= month ? live : stale).push({ name, at: +at * 1000, subject });
  }
  await pool(live, CPUS, async (b) => { b.ahead = +(await git('rev-list', '--count', head + '..' + b.name).catch(() => '0')).trim(); });
  let base = null;
  for (const r of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) if ((await run(['rev-parse', '--verify', '-q', r], { ok: [0, 1, 128] })).code === 0) { base = r; break; }
  const ahead = base ? +(await git('rev-list', '--count', base + '..HEAD').catch(() => '0')).trim() : 0;
  const dirty = (await git('status', '--porcelain', '--untracked-files=no')).split('\n').filter(Boolean).length;
  return { current, base, ahead, dirty, live: live.sort((a, b) => b.at - a.at), stale: stale.length };
}

// ---- privacy ----------------------------------------------------------------------------------------------------
const SCRUB = [
  [/\b[A-Za-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/g, (m) => m.replace(/\/\/.*@/, '//[credentials]@')],
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]'],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '[token]'],
  [/\b(bearer|basic)\s+[\w\-.~+/=]{12,}/gi, '$1 [token]'],
  [/\bsk-[A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[secret]'],
  // payment, mail and webhook keys by their prefixes
  [/\b[spr]k_(?:live|test)_[A-Za-z0-9]{10,200}|\bwhsec_[A-Za-z0-9+/=]{16,200}|\bre_(?=[A-Za-z0-9_]{0,200}\d)(?=[A-Za-z0-9_]{0,200}[A-Z])[A-Za-z0-9_]{20,200}/g, '[secret]'],
  // a key in JSON or YAML ("SOME_API_KEY": "…"), and a value after its label in prose ("API key: …")
  [/(["']?\b[A-Za-z][A-Za-z0-9_-]{0,80}(?:key|token|secret|password)[A-Za-z0-9_-]{0,80}["']?\s{0,3}:\s{0,3}["'])(?=[^"'\s]{0,200}\d)(?=[^"'\s]{0,200}[A-Za-z])[A-Za-z0-9_\-+/=.]{16,200}/gi, '$1[secret]'],
  [/(\b(?:api[ _-]?key|client[ _-]?secret|webhook[ _-]?secret|signing[ _-]?secret|secret[ _-]?key|access[ _-]?token|password|passwd)\b\s{0,3}(?::|=|\bis\b|[–—])\s{0,3}[`'"]?)(?=[^\s`'"]{0,200}\d)(?=[^\s`'"]{0,200}[A-Za-z])[^\s`'"]{8,200}/gi, '$1[secret]'],
  [/-----BEGIN[^-]*-----[\s\S]*?(-----END[^-]*-----|$)/g, '[private key]'],
  [/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?|DSN|DATABASE_URL)[A-Z0-9_]*)(\s*[=:]\s*)(?!process\.|import\b|env\b|os\.)['"]?[^\s'"]{6,}['"]?/g, '$1$2[secret]'],
  [/\b(password|passwd|secret|api[_-]?key|token)(\s*[=:]\s*)(?!process\.|import\b|env\b|os\.)['"]?[^\s'"]{4,}['"]?/gi, '$1$2[secret]'],
  [/(?<![\w/.-])(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{40,}(?![\w/.-])/g, '[token]'],
  [/(?<![\w.:/-])\+?\(?\d{1,4}\)?(?:[\s.-]?\(?\d{2,4}\)?){2,4}[\s.-]?\d{3,4}(?![\w.:/-])/g, (m) => (m.replace(/\D/g, '').length >= 10 && /[\s.()+-]/.test(m) ? '[phone]' : m)],
  [/\b\d{1,6}\s+(?:[A-Z][a-z]+\s+){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Ter|Terrace|Hwy|Highway)\b\.?/g, '[address]'],
];
export function scrub(text) { for (const [re, to] of SCRUB) text = text.replace(re, to); return text; }

// ---- transcripts ------------------------------------------------------------------------------------------------
const PROJECTS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const TAGS = /<(system-reminder|pasted_content|local-command-stdout|local-command-stderr|command-name|command-message|command-args|local-command-caveat|bash-input|bash-stdout|bash-stderr|task-notification|user-prompt-submit-hook)\b[^>]*>[\s\S]*?<\/\1>/g;

/** the folder a session ran in, from its opening records (read 256 KB at most) */
function launchedIn(file) {
  let fd; try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const buf = Buffer.alloc(256 << 10), n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const l of buf.subarray(0, n).toString('utf8').split('\n')) {
      const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(l); if (m) { try { return JSON.parse('"' + m[1] + '"'); } catch { return null; } }
    }
    return null;
  } finally { fs.closeSync(fd); }
}
const inside = (p, root) => p === root || p.startsWith(root + path.sep);

/** the words in a user record that are the writer's own: tags, pastes and commands taken out */
function writerWords(content) {
  const parts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter(p => p?.type === 'text').map(p => p.text ?? '') : [];
  let t = parts.join('\n').replace(TAGS, '').trim();
  if (!t || /^\[Request interrupted/.test(t) || /^Caveat:/.test(t)) return '';
  // rows pasted from a spreadsheet or a table of records (three tabs or more): never the writer's own words
  t = t.split('\n').filter(l => (l.match(/\t/g) ?? []).length < 3).join('\n');
  if (t.length > CAP.words) t = t.slice(0, CAP.words) + ` [… ${t.length - CAP.words} characters left out, most likely pasted]`;
  return t;
}

/** one session, streamed: the records worth keeping, and whether it is one of the journal's own */
async function readSession(file) {
  const out = []; let summary = null, journal = false, first = null, last = null, spoke = false, answering = false;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const l of rl) {
    // most of a session is tool calls, their results and requests: passed over without parsing
    if (!(l.includes('"type":"user"') || l.includes('"type":"assistant"')) || l.includes('"type":"tool_result"') || l.includes('"isSidechain":true')) continue;
    if (l.includes('"type":"assistant"') && !l.includes('"type":"text"')) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.isSidechain || (o.type !== 'user' && o.type !== 'assistant')) continue;
    const at = o.timestamp ?? null; if (at) { first ??= at; last = at; }
    if (o.type === 'user') {
      const raw = typeof o.message?.content === 'string' ? o.message.content : '';
      // a journal event (its source is the plugin's server: "plugin:pica-journal:journal"): a session that opens with
      // one is the journal's own, its replies in the journal already; in a working session, the event and
      // Claude's words answering it are passed over until the writer speaks again
      if (/^\s*<channel source="[^"]*journal"/.test(raw)) { if (!spoke) { journal = true; break; } answering = true; continue; }
      if (o.isCompactSummary) { summary = { at, who: 'summary', text: scrub(raw.replace(TAGS, '').trim()) }; continue; }
      if (o.isMeta) continue;
      const t = writerWords(o.message?.content); if (t) { spoke = true; answering = false; out.push({ at, who: 'writer', text: scrub(t) }); }
    } else {
      if (answering) continue;
      const t = (o.message?.content ?? []).filter(p => p?.type === 'text').map(p => p.text ?? '').join('\n').trim();
      if (t) out.push({ at, who: 'claude', text: scrub(t.length > CAP.answer ? t.slice(0, CAP.answer) + ' […]' : t) });
    }
  }
  rl.close();
  if (summary) out.push(summary);         // the last compaction summary alone: each carries the one before it
  return { records: out, journal, first, last };
}

/** the project's files a text names, by path or (when it names one file only) by name */
function namer(files, prefixes) {
  const all = new Set(files), byName = new Map();
  for (const f of files) { const b = path.posix.basename(f); byName.set(b, byName.has(b) ? null : f); }
  return (text) => {
    const hit = {};
    for (const m of text.matchAll(/[\w@()[\]+.-]+(?:\/[\w@()[\]+.-]+)*\.[A-Za-z0-9]{1,6}/g)) {
      let p = m[0].replace(/^\.\//, '');
      for (const x of prefixes) if (p.startsWith(x)) { p = p.slice(x.length); break; }
      const f = all.has(p) ? p : !p.includes('/') && p.length >= 6 ? byName.get(p) : null;
      if (f) hit[f] = (hit[f] ?? 0) + 1;
    }
    return hit;
  };
}

async function transcripts(files) {
  const root = fs.realpathSync(ROOT);
  const trees = [root];
  for (const l of (await git('worktree', 'list', '--porcelain').catch(() => '')).split('\n')) { const m = /^worktree (.+)$/.exec(l); if (m && m[1] !== root) trees.push(m[1]); }
  // a session run in a folder above the project names its files by their path from there
  const prefixesFor = (cwd) => [path.relative(cwd, root) + '/', root + '/'];
  const index = readCache('transcripts.json')?.v === CACHE_VERSION ? readCache('transcripts.json').sessions : {};
  const found = {}; let scanned = 0, read = 0;
  let folders = []; try { folders = fs.readdirSync(PROJECTS); } catch {}
  for (const d of folders) {
    let names = []; try { names = fs.readdirSync(path.join(PROJECTS, d)).filter(n => n.endsWith('.jsonl')); } catch { continue; }
    for (const n of names) {
      const file = path.join(PROJECTS, d, n), id = n.slice(0, -6);
      let st; try { st = fs.statSync(file); } catch { continue; }
      if (!st.size) continue;                       // cleared by Claude Code's clean-up
      scanned++;
      const was = index[id];
      if (was && was.size === st.size && was.mtime === st.mtimeMs) { if (was.kept) found[id] = was; continue; }
      const cwd = launchedIn(file);
      const near = cwd && trees.some(t => inside(cwd, t)), above = cwd && !near && inside(root, cwd);
      if (!near && !above) { found[id] = undefined; index[id] = { size: st.size, mtime: st.mtimeMs, kept: false }; continue; }
      read++;
      const s = await readSession(file), name = namer(files, prefixesFor(cwd)), hits = {}, writer = { n: 0 }, claude = { n: 0 }, sum = { n: 0 };
      for (const r of s.records) {
        r.files = Object.keys(name(r.text));
        for (const f of r.files) hits[f] = (hits[f] ?? 0) + 1;
        (r.who === 'writer' ? writer : r.who === 'claude' ? claude : sum).n += r.text.length;
      }
      const mentions = Object.values(hits).reduce((a, b) => a + b, 0);
      // a session above the project is kept only when it names the project's files
      const kept = !s.journal && s.records.length > 0 && (near || mentions >= 3);
      const entry = { size: st.size, mtime: st.mtimeMs, kept, id, folder: d, cwd: path.relative(root, cwd) || '.', first: s.first, last: s.last,
        writer: writer.n, claude: claude.n, summary: sum.n, journal: s.journal,
        files: Object.entries(hits).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([f]) => f) };
      index[id] = entry;
      if (kept) { found[id] = entry; writeCache(path.join('t', id + '.jsonl'), s.records.map(r => JSON.stringify(r)).join('\n') + '\n'); }
      else { try { fs.unlinkSync(cacheFile(path.join('t', id + '.jsonl'))); } catch {} }
    }
  }
  fs.mkdirSync(path.join(DATA, 't'), { recursive: true, mode: 0o700 });
  writeCache('transcripts.json', { v: CACHE_VERSION, sessions: index });
  const words = leaveOutWords(); let leftOut = 0;
  const sessions = Object.values(found).filter(Boolean).filter(e => {
    if (!words.length) return true;
    let t = ''; try { t = fs.readFileSync(cacheFile(path.join('t', e.id + '.jsonl')), 'utf8'); } catch {}
    if (holds(t, words)) { leftOut++; return false; }
    return true;
  }).sort((a, b) => (a.first ?? '').localeCompare(b.first ?? ''));
  return { sessions, scanned, read, leftOut, journal: Object.values(index).filter(e => e?.journal).length };
}

// ---- leave-out: words naming what an import must not read (an audit's answer key, say) -------------------------
// The journal folder's leave-out.txt, one word or phrase a line: a document whose path holds one, a session or a
// memory whose text holds one, is left out, and the digest says how many.
export function leaveOutWords() {
  try { return fs.readFileSync(path.join(DIR, 'leave-out.txt'), 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')); } catch { return []; }
}
const holds = (text, words) => words.some(w => text.includes(w));

// ---- documents, by what they are about (IMPORT-PLAN §0) ----------------------------------------------------------
const SUBJECTS = [
  ['pricing', /pric|billing|payment|subscription|credits?\b|monetiz|revenue|plans? and/i],
  ['pilot', /pilot|beta\b|early access|trial/i],
  ['go-to-market', /go[ -]?to[ -]?market|\bgtm\b|marketing|launch|growth|outreach|affiliate|partner|sales|positioning|competitor|landing/i],
  ['operations', /operations|\bops\b|runbook|playbook|on-?call|incident|deploy|release|backup|restore|infrastructure|environment/i],
  ['experiments', /experiment|hypothes|a\/b|bake-?off|benchmark|calibrat/i],
  ['decisions', /decision|\badr\b|\brfc\b|proposal|trade-?off|rationale/i],
  ['security', /security|threat|privacy|secrets?\b|vulnerab|pentest/i],
  ['architecture', /architecture|design doc|overview|data model|schema/i],
  ['plans', /\bplan\b|roadmap|strategy|vision|backlog|open (items|questions)/i],
];
/** documents ranked by the subjects their path, title and headings name, then by recency; length breaks ties */
async function documents(docs, words) {
  const heads = new Map();
  const out = await git('grep', '-z', '-n', '-I', '-E', '-e', '^#{1,3} ', 'HEAD', '--', '*.md', '*.mdx', '*.markdown').catch(() => '');
  for (const l of out.split('\n')) {
    const a = l.indexOf('\0'), b = l.indexOf('\0', a + 1); if (a < 0 || b < 0) continue;
    const f = l.slice(0, a).replace(/^HEAD:/, ''); if (!heads.has(f)) heads.set(f, []);
    heads.get(f).push(l.slice(b + 1).replace(/^#+\s*/, '').trim());
  }
  let left = 0;
  const ranked = [];
  for (const d of docs) {
    if (holds(d.file, words)) { left++; continue; }
    const hs = heads.get(d.file) ?? [], title = hs[0] ?? path.posix.basename(d.file);
    let score = 0; const subjects = [], by = {};
    for (const [name, re] of SUBJECTS) {
      const s = (re.test(d.file) || re.test(title) ? 3 : 0) + Math.min(3, hs.slice(1).filter(h => re.test(h)).length);
      if (s) { score += s; subjects.push(name); by[name] = s; }
    }
    ranked.push({ ...d, title: scrub(title).slice(0, 100), subjects, score, by });
  }
  const recent = (a, b) => (b.last ?? 0) - (a.last ?? 0) || b.lines - a.lines;
  // each subject's strongest documents in turn (a document about everything would otherwise push out the one
  // document about the pilot), then the rest by how much they name, then by recency
  const queues = SUBJECTS.map(([name]) => ranked.filter(d => d.by[name] >= 3).sort((a, b) => b.by[name] - a.by[name] || recent(a, b)));
  const picked = new Set();
  for (let round = 0; picked.size < CAP.docs && queues.some(q => q.length > round); round++) for (const q of queues) { const d = q[round]; if (d && picked.size < CAP.docs) picked.add(d); }
  const rest = ranked.filter(d => !picked.has(d)).sort((a, b) => (b.score > 0) - (a.score > 0) || b.score - a.score || recent(a, b));
  return { ranked: [...picked, ...rest], left };
}

// ---- Claude's memory, a source (IMPORT-PLAN §3) ------------------------------------------------------------------
/** the memory folders of the folders the project's sessions ran in, and the journal's own: names and descriptions */
function memories(sessions, words) {
  const dirs = new Map();
  dirs.set(MEM, 'the journal\'s memory');
  dirs.set(memoryOf(ROOT), dirs.get(memoryOf(ROOT)) ?? 'the project\'s');
  for (const s of sessions) { const d = path.join(PROJECTS, s.folder, 'memory'); if (!dirs.has(d)) dirs.set(d, `sessions in ${s.cwd}`); }
  const out = []; let left = 0;
  for (const [d, why] of dirs) {
    let names = []; try { names = fs.readdirSync(d).filter(n => n.endsWith('.md') && n !== 'MEMORY.md').sort(); } catch { continue; }
    if (!names.length) continue;
    const items = [];
    for (const n of names) {
      let t = ''; try { t = fs.readFileSync(path.join(d, n), 'utf8'); } catch { continue; }
      if (holds(t, words)) { left++; continue; }
      const desc = /^description:\s*(.+)$/m.exec(t)?.[1]?.replace(/^["']|["']$/g, '') ?? t.replace(/^---[\s\S]*?---/, '').trim().split('\n')[0];
      items.push({ name: n.slice(0, -3), desc: scrub((desc ?? '').replace(/\\"/g, '"')).slice(0, 160) });
    }
    out.push({ dir: d, why, inUse: d === MEM, items });
  }
  return { folders: out, left };
}

// ---- the digest ---------------------------------------------------------------------------------------------------
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const num = (n) => n.toLocaleString('en-US');
const short = (s) => s.slice(0, 9);
/** a subject line as listed: scrubbed, and cut where a subject runs on into a paragraph */
const subj = (s) => { s = scrub(s); return s.length > CAP.subject ? s.slice(0, CAP.subject).replace(/\s+\S*$/, '') + ' …' : s; };

export async function survey(args) {
  if ((await run(['rev-parse', '--verify', '-q', 'HEAD'], { ok: [0, 1, 128] })).code !== 0) stop('no git history here: nothing to survey (a writer\'s folder is not imported)');
  const withTranscripts = args.includes('--transcripts');
  const si = args.indexOf('--since'), since = si >= 0 ? args[si + 1] : null;
  if (si >= 0 && !/^[0-9a-f]{7,40}$/.test(since ?? '')) stop('--since needs a commit (hex)');
  const t0 = Date.now();
  const head = (await git('rev-parse', 'HEAD')).trim();
  const [{ files, out }, commits, br] = await Promise.all([ownFiles(), readLog(), branches(head)]);
  // how the project runs needs no blame: read beside it, and at a HEAD read before, from the cache (IMPORT-PLAN, Performance)
  const rc = readCache('running.json'), cachedRun = rc?.v === RUNNING_VERSION ? rc.heads?.[head] : null;
  const [b, R, allBodies] = await Promise.all([blameAll(head, files), cachedRun ? null : runningProject({ files, scrub }), cachedRun ? null : bodiesAll()]);
  const { threads, docs } = threadsOf(commits, b.blame, files), gone = await removals(commits);
  const thread = new Map(); for (const t of threads) for (const f of Object.keys(t.files)) thread.set(f, t.key);
  let run_ = cachedRun;
  if (!run_) {
    const t1 = Date.now();
    const rest = await runningRest(R, { commits, area: (f) => thread.get(f) ?? path.posix.dirname(f) + '/', scrub, bodies: allBodies });
    run_ = { lines: [...R.lines, ...rest], alarms: R.alarms, snap: R.snap, ms: R.ms + (Date.now() - t1) };
    const heads = { ...(rc?.v === RUNNING_VERSION ? rc.heads : {}), [head]: run_ };
    for (const h of Object.keys(heads).slice(0, Math.max(0, Object.keys(heads).length - 20))) delete heads[h];
    writeCache('running.json', { v: RUNNING_VERSION, heads });
  }
  const words = leaveOutWords();
  const { ranked, left: docsLeft } = await documents(docs, words);
  const alive = threads.reduce((a, t) => a + t.alive, 0), all = commits.reduce((a, c) => a + c.alive, 0);
  const above = threads.slice(0, CAP.threads), below = threads.slice(CAP.threads);
  const lead = above.flatMap(t => t.commits.slice(0, CAP.lead).map(c => c.sha));
  const body = await bodies([...lead, ...gone.map(c => c.sha)]);
  const tr = withTranscripts ? await transcripts(files) : null;

  const L = [];
  const name = path.basename(ROOT);
  const oldest = commits[commits.length - 1], newest = commits[0];
  L.push(`# Survey of ${name} at ${short(head)}`, '');
  L.push(`${num(commits.length)} commits, ${day(oldest.at)} to ${day(newest.at)}. ${num(files.length)} files are the project's own work; left out: ${Object.entries(out).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}. ${num(all)} lines survive at HEAD from ${num(commits.filter(c => c.alive).length)} commits, ${num(alive)} of them in code and configuration, the rest in prose.`);
  L.push(`Blame: ${b.blamed} files blamed, ${b.cached} from the cache, ${(b.ms / 1000).toFixed(1)} s; running the project and signals ${cachedRun ? 'from the cache' : `${(run_.ms / 1000).toFixed(1)} s, beside blame`}; ${((Date.now() - t0) / 1000).toFixed(1)} s in all.`, '');
  if (words.length) L.push(`Left out by the journal's leave-out.txt (${words.length} word${words.length === 1 ? '' : 's'}): ${docsLeft} documents${tr ? `, ${tr.leftOut} sessions` : ''}.`, '');
  if (run_.alarms.length) {
    L.push('## Committed secrets', '', `**A literal value where a key belongs, in a tracked file** (by file, line and name; the value is not shown and must never be copied). Each is for the writer: rotate it, read it from the environment instead, and consider removing it from history.`, '');
    for (const a of run_.alarms.slice(0, 20)) L.push(`- ${a}`);
    if (run_.alarms.length > 20) L.push(`- and ${run_.alarms.length - 20} more`);
    L.push('');
  }
  L.push(`Branch: ${br.current}${br.base && br.ahead ? `, ${br.ahead} commits ahead of ${br.base} (in progress)` : ''}${br.dirty ? `; ${br.dirty} tracked files changed and not committed` : ''}.`);
  if (br.live.length) L.push(`Unmerged branches with commits in the last 30 days (work in progress): ${br.live.slice(0, 10).map(x => `${x.name} (${x.ahead} ahead, ${day(x.at)}: ${x.subject})`).join('; ')}.`);
  if (br.stale) L.push(`${br.stale} older unmerged branches are left out.`);
  if (since) {
    const anc = (await run(['merge-base', '--is-ancestor', since, head], { ok: [0, 1, 128] })).code;
    if (anc !== 0) L.push('', `**${since} is no longer in this history** (a rebase, or another branch): survey this as a fresh import, not as an update.`);
    else {
      const fresh = new Set((await git('rev-list', since + '..' + head)).split('\n').filter(Boolean));
      const was = readCache('threads.json')?.[since] ?? null;
      L.push('', `## Since ${short(since)}`, '', `${fresh.size} new commit${fresh.size === 1 ? '' : 's'}.`);
      for (const t of threads) {
        const n = t.commits.filter(c => fresh.has(c.sha)).length, before = was?.[t.key];
        const moved = before ? Math.round((t.alive - before) / before * 100) : null;
        if (n || moved !== null && Math.abs(moved) >= 10) L.push(`- ${t.key}: ${n} new commit${n === 1 ? '' : 's'}${moved !== null ? `, surviving lines ${moved >= 0 ? '+' : ''}${moved}%` : was ? ', a new thread' : ''}`);
      }
      if (!was) L.push('(no survey was recorded at that commit, so changes in weight are not shown)');
      const then = rc?.v === RUNNING_VERSION ? rc.heads?.[since] ?? Object.entries(rc.heads ?? {}).find(([h]) => h.startsWith(since))?.[1] : null;
      L.push('', 'Kept sheets, by what their inputs did since then (a sheet whose inputs did not change needs no step):', '');
      if (then) L.push(...moved(then.snap, run_.snap));
      else L.push('- (how the project ran at that commit was not recorded: compare each kept sheet with Running the project below)');
    }
  }
  L.push('', '## Threads, by what survives', '');
  above.forEach((t, i) => {
    const cs = t.commits, from = Math.min(...cs.map(c => c.at)), to = Math.max(...cs.map(c => c.at));
    L.push(`### ${i + 1}. ${t.key}: ${num(t.alive)} lines (${Math.round(t.alive / alive * 100)}%), ${cs.length} commits, ${day(from)} to ${day(to)}`, '');
    L.push('Files: ' + Object.entries(t.files).sort((a, b) => b[1] - a[1]).slice(0, CAP.files).map(([f, n]) => `${f} (${num(n)})`).join(', '), '');
    for (const c of cs.slice(0, CAP.lead)) {
      L.push(`- ${short(c.sha)} ${day(c.at)} ${subj(c.subject)} (${num(t.here.get(c))} lines here; ${num(c.alive)} of ${num(c.add)} survive in all)`);
      const m = body.get(c.sha); if (m) L.push('', ...('> ' + (m.length > CAP.body ? m.slice(0, CAP.body) + ' […]' : m)).split('\n').map(x => x.startsWith('> ') ? x : '> ' + x), '');
    }
    const rest = cs.slice(CAP.lead, CAP.lead + CAP.subjects);
    for (const c of rest) L.push(`- ${short(c.sha)} ${day(c.at)} ${subj(c.subject)} (${num(t.here.get(c))})`);
    if (cs.length > CAP.lead + CAP.subjects) L.push(`- and ${cs.length - CAP.lead - CAP.subjects} more`);
    if (tr) {
      const inThread = new Set(Object.keys(t.files));
      const ss = tr.sessions.filter(s => s.files.some(f => inThread.has(f)));
      if (ss.length) L.push('', 'Sessions: ' + ss.slice(0, 12).map(s => `${s.id.slice(0, 8)} (${(s.first ?? '').slice(0, 10)})`).join(', ') + (ss.length > 12 ? `, and ${ss.length - 12} more` : ''));
    }
    L.push('');
  });
  if (ranked.length) {
    L.push('## Documents', '', `Prose the project keeps (plans, notes, READMEs): sources to read, not weighed as work. ${ranked.length} in all, ranked by the subjects their titles and headings name (pricing, pilots, go-to-market, operations, experiments, decisions, security, architecture, plans), then by when they last changed. A fact is only a person's to know once these have been looked through.`, '');
    for (const d of ranked.slice(0, CAP.docs)) L.push(`- ${d.file}: “${d.title}”${d.subjects.length ? ` (${d.subjects.join(', ')})` : ''}, ${num(d.lines)} lines${d.last ? `, last changed ${day(d.last)}` : ''}`);
    const rest = ranked.slice(CAP.docs);
    if (rest.length) {
      const by = new Map(); for (const d of rest) { const k = path.posix.dirname(d.file) + '/'; by.set(k, (by.get(k) ?? 0) + 1); }
      L.push('', `The other ${rest.length}, by folder: ` + [...by].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, n]) => `${k} (${n})`).join(', ') + (by.size > 25 ? `, and ${by.size - 25} more folders` : '') + '.');
    }
    L.push('');
  }
  L.push(...run_.lines);
  if (below.length) {
    L.push('## Below the line', '', below.slice(0, CAP.below).map(t => `${t.key} (${num(t.alive)} lines, ${t.commits.length} commits)`).join('; ') + (below.length > CAP.below ? `; and ${below.length - CAP.below} more threads` : '') + '.', '');
  }
  if (gone.length) {
    L.push('## Removals and reverts', '', 'Nothing of these survives, but each was a decision.', '');
    for (const c of gone) {
      L.push(`- ${short(c.sha)} ${day(c.at)} ${subj(c.subject)}: removed ${num(c.del)} lines${c.removedAge ? `, on average ${Math.round(c.removedAge)} days old` : ''}, added ${num(c.add)}`);
      const m = body.get(c.sha); if (m) L.push('', ...('> ' + (m.length > 600 ? m.slice(0, 600) + ' […]' : m)).split('\n').map(x => x.startsWith('> ') ? x : '> ' + x), '');
    }
    L.push('');
  }
  if (tr) {
    L.push('## Transcripts', '', `${tr.scanned} sessions on disk were looked at; ${tr.read} read in full this time (the rest from the cache). ${tr.sessions.length} belong to this project; ${tr.journal} of the journal's own sessions were left out. Read one with \`pica-journal survey transcript <session> [--files a,b]\`.`, '');
    if (!tr.sessions.length) L.push('None found: Claude Code clears sessions after cleanupPeriodDays (30 by default).', '');
    for (const s of tr.sessions.slice(-CAP.sessions)) L.push(`- ${s.id.slice(0, 8)} ${(s.first ?? '').slice(0, 10)} to ${(s.last ?? '').slice(0, 10)}, in ${s.cwd}: writer ${num(s.writer)}, Claude ${num(s.claude)}, summary ${num(s.summary)} characters. ${s.files.slice(0, 5).join(', ')}`);
    if (tr.sessions.length > CAP.sessions) L.push(`- and ${tr.sessions.length - CAP.sessions} earlier sessions`);
    L.push('');
    const mem = memories(tr.sessions, words);
    if (mem.folders.length) {
      L.push('## Claude\'s memory', '', `The memory folders of the folders this project's sessions ran in: the most distilled record a project has, read as prose (a memory is Claude's claim, checked like any other). The journal's memory, where new memories go, is ${MEM}.${mem.left ? ` ${mem.left} memories left out by leave-out.txt.` : ''}`, '');
      for (const m of mem.folders) {
        // descriptions while they fit, then the rest by name: none is left unnamed
        const M = [`### ${m.why}${m.inUse ? ' (in use by the journal)' : ''}: ${m.items.length} memories`, ''];
        let size = 0, k = 0;
        for (; k < m.items.length; k++) { const l = `- ${m.items[k].name}: ${m.items[k].desc}`; if (size + l.length > 6000) break; M.push(l); size += l.length + 1; }
        if (k < m.items.length) M.push(`- And by name (read one in ${m.dir}): ${m.items.slice(k).map(i => i.name).join(', ')}`);
        L.push(...M, '');
      }
    }
  }
  // the weights at this HEAD, so a later survey --since it can say which threads moved
  const kept = readCache('threads.json') ?? {}; kept[head] = Object.fromEntries(threads.map(t => [t.key, t.alive]));
  const heads = Object.keys(kept); for (const h of heads.slice(0, Math.max(0, heads.length - 20))) delete kept[h];
  writeCache('threads.json', kept);
  process.stdout.write(L.join('\n') + '\n');
}

export async function transcript(args) {
  const [id] = args; if (!/^[0-9a-f-]{8,36}$/.test(id ?? '')) stop('survey transcript needs a session id (as survey printed it)');
  let t = null;
  try { t = fs.readdirSync(path.join(DATA, 't')).filter(n => n.startsWith(id)); } catch {}
  if (!t?.length) stop(`no session ${id}: run pica-journal survey --transcripts first`);
  if (t.length > 1) stop(`${id} names ${t.length} sessions: give more of the id`);
  { const words = leaveOutWords(); if (words.length && holds(fs.readFileSync(path.join(DATA, 't', t[0]), 'utf8'), words)) stop(`session ${id} is left out (it names something in the journal's leave-out.txt)`); }
  const fi = args.indexOf('--files'), want = fi >= 0 ? new Set((args[fi + 1] ?? '').split(',').filter(Boolean)) : null;
  const from = Math.max(0, +(args[args.indexOf('--from') + 1] ?? 0) || 0) * (args.includes('--from') ? 1 : 0);
  const rs = fs.readFileSync(path.join(DATA, 't', t[0]), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  // with --files: the records that name one of them, and the one before and after each, for context
  const show = new Set();
  rs.forEach((r, i) => { if (!want || r.files?.some(f => want.has(f))) for (const k of want ? [i - 1, i, i + 1] : [i]) if (k >= 0 && k < rs.length) show.add(k); });
  let size = 0; const out = [];
  for (const i of [...show].sort((a, b) => a - b)) {
    if (i < from) continue;
    const r = rs[i], s = `[${i}] ${(r.at ?? '').slice(0, 16).replace('T', ' ')} ${r.who === 'writer' ? 'Writer' : r.who === 'claude' ? 'Claude' : 'Summary (Claude\'s claims)'}:\n${r.text}\n`;
    if (size + s.length > 40000 && out.length) { out.push(`… more: pica-journal survey transcript ${id}${want ? ' --files ' + [...want].join(',') : ''} --from ${i}`); break; }
    out.push(s); size += s.length;
  }
  process.stdout.write(out.join('\n') + '\n');
}

export async function main(args) {
  try { if (args[0] === 'transcript') await transcript(args.slice(1)); else await survey(args); }
  catch (e) { if (e instanceof Stop) { process.stderr.write('journal: ' + e.message + '\n'); process.exit(1); } throw e; }
}
