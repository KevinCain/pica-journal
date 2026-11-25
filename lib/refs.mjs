// References to code in a reply (JOURNAL-PLAN.md §9): a reply stays short and points at the code instead of
// pasting it; the writer opens a reference in pica to see the lines. Shared by the command (making a reference,
// `resolve` for a look by hand) and the channel server (answering pica's requests).
//
// A reference, as stored in the reply op's `refs` (at most three):
//   { path, sym?, kind: 'lines'|'symbol'|'file', line, anchor, sha, dirty?, snapshot, why? }
//   path      relative to the project (ROOT), as the real path (a symlink's target, never its name)
//   line      the excerpt's first line, when the reply was written
//   anchor    that line's text, trimmed: found again by indexOf in the file as it is now, never as a RegExp
//   sha       HEAD when the reply was written ('' outside git, or for a file git does not track)
//   dirty     the file differed from HEAD then: its lines at `sha` are not what Claude saw
//   snapshot  at most 12 lines and 1 KB, each line capped: what pica shows until the reference is opened
//
// The rules every read obeys, here and in the server alike: the real path inside ROOT; never a secrets file
// (.env*, keys, credentials), a git-ignored file, or anything under .git or the journal; regular files only (a
// FIFO would hang); at most 1 MB, no binary; an excerpt holding something that looks like a key is refused. git
// runs as async execFile with fixed arguments, the path after `--` or as `sha:./path`, a hex sha only, two at a
// time, each with a timeout.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { DIR, ROOT } from './folder.mjs';

export const MAX_REFS = 3, SNAP_LINES = 12, SNAP_BYTES = 1024, LINE_CAP = 160, VIEW_LINES = 40, MAX_FILE = 1 << 20, MAX_WHY = 200;

const REAL_ROOT = (() => { try { return fs.realpathSync(ROOT); } catch { return ROOT; } })();
/** the project a reference belongs to, as the reply op carries it: a hash, never the path */
export const PROJECT = crypto.createHash('sha256').update(REAL_ROOT).digest('hex').slice(0, 12);

export class Refusal extends Error {}
const refuse = (why) => { throw new Refusal(why); };

// ---- what is never read -------------------------------------------------------------------------------------
const PATH_RE = /^[\w@+.,\- /]+$/;
const DENY_DIRS = new Set(['.git', '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', 'node_modules']);
const DENY_NAMES = [
  /^\.env($|\.)/i, /\.env$/i, /^\.(npmrc|netrc|pypirc|htpasswd|pgpass|git-credentials)$/i, /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /\.(pem|key|p12|pfx|keystore|jks|asc|gpg|kdbx|ppk)$/i, /^credentials/i, /^secrets?(\.|$)/i, /^\.listening$/,
];
const JOURNAL_REL = (() => { try { return path.relative(REAL_ROOT, fs.realpathSync(DIR)); } catch { return path.relative(ROOT, DIR); } })();
/** a project-relative path that must never be read, by its name alone */
export function denied(rel) {
  const parts = rel.split(/[\\/]/);
  if (parts.some(p => DENY_DIRS.has(p))) return 'a protected folder';
  if (DENY_NAMES.some(r => r.test(parts[parts.length - 1]))) return 'a secrets or key file';
  if (JOURNAL_REL && !JOURNAL_REL.startsWith('..') && (rel === JOURNAL_REL || rel.startsWith(JOURNAL_REL + path.sep))) return 'the journal itself';
  return null;
}
/** words in an excerpt that look like a key or a password: such an excerpt is never copied */
// Every quantifier is bounded (a value of at most 200 characters, nothing unbounded before it), so a sheet of
// 100,000 characters is checked in milliseconds (test/guard.mjs times it).
const VALUE = String.raw`(?=[A-Za-z0-9_\-+/=.]{0,200}\d)(?=[A-Za-z0-9_\-+/=.]{0,200}[A-Za-z])[A-Za-z0-9_\-+/=.]{16,200}`;
const SECRETS = [
  ['an API key (sk-)', /\bsk-[A-Za-z0-9_-]{16,200}/], ['an AWS key', /\bAKIA[0-9A-Z]{16}\b/], ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,200}/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,200}/], ['a private key', /-----BEGIN/], ['a password', /password\s{0,3}=\s{0,3}['"]?[^\s'"]{3,200}/i],
  ['a URL with credentials', /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]{1,200}:[^\s@/]{1,200}@/i], ['a JWT', /\beyJ[\w-]{8,2000}\.[\w-]{8,2000}\.[\w-]{8,2000}/],
  ['a bearer token', /\bbearer\s{1,3}[\w\-.~+/=]{20,200}/i],
  // payment, mail and webhook keys by their prefixes
  ['a payment key', /\b[spr]k_(?:live|test)_[A-Za-z0-9]{10,200}/], ['a webhook secret', /\bwhsec_[A-Za-z0-9+/=]{16,200}/],
  ['an API key (re_)', new RegExp(String.raw`\bre_(?=[A-Za-z0-9_]{0,200}\d)(?=[A-Za-z0-9_]{0,200}[A-Z])[A-Za-z0-9_]{20,200}`)],
  ['a key in a setting', new RegExp(String.raw`\b[A-Z][A-Z0-9_]{0,80}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)[A-Z0-9_]{0,80}\s{0,3}[=:]\s{0,3}['"]?` + VALUE)],   // (a value that looks random: a name or a path is not a key)
  // a key in JSON or YAML: the quote between the name and the colon defeats the rule above
  // (a bare "key" or "token" is too common a field to count: apiKey, api_key and SOME_API_KEY do; secret and password always)
  ['a key in a config', new RegExp(String.raw`["']?\b(?:[A-Za-z0-9_-]{0,80}(?:secret|password|passwd)|[A-Za-z][A-Za-z0-9_-]{0,80}(?:key|token))[A-Za-z0-9_-]{0,80}["']?\s{0,3}:\s{0,3}["']` + VALUE, 'i')],
  // a value after its label in prose: "API key: …", "Client secret – …", "Webhook secret is …", "Password: …"
  // a login written with its password, as docs and comments give them: "admin@example.com / s3cret-pass"
  // (the password: no space or slash, a digit or a sign in it, and ending there, so "user@x.com / admin", a path
  // or git@github.com:org/repo does not count)
  ['a login and its password', /\b[\w.%+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,5}\s{0,3}(?:\/|:)\s{0,3}[\x60'"]?(?=[^\s\x60'"/<>()]{0,200}[\d!#$%^&*-])(?=[^\s\x60'"/<>()]{0,200}[A-Za-z])[^\s\x60'"/<>()]{6,200}(?=$|[\s\x60'",;)])/],
  ['a key after its label', new RegExp(String.raw`\b(?:api[ _-]?key|client[ _-]?secret|webhook[ _-]?secret|signing[ _-]?secret|secret[ _-]?key|access[ _-]?token|password|passwd)\b\s{0,3}(?::|=|\bis\b|[–—])\s{0,3}[\x60'"]?(?=[^\s\x60'"]{0,200}\d)(?=[^\s\x60'"]{0,200}[A-Za-z])[^\s\x60'"]{8,200}`, 'i')],
];
export function secretIn(text) { for (const [name, re] of SECRETS) if (re.test(text)) return name; return null; }
/** the first line of `text` holding what looks like a secret: { name, line } (from 1), or null */
export function secretLine(text) {
  const ls = String(text).split('\n');
  for (let i = 0; i < ls.length; i++) { const name = secretIn(ls[i]); if (name) return { name, line: i + 1 }; }
  // a secret split over lines (a private key's armour, a JWT wrapped) is still found whole
  const name = secretIn(text); return name ? { name, line: 0 } : null;
}

// ---- git: async, fixed arguments, two at a time ------------------------------------------------------------------
const HEX = /^[0-9a-f]{7,40}$/;
let running = 0; const queue = [];
export function git(args, ms = 1500) {
  return new Promise((res) => {
    const go = () => {
      running++;
      execFile('git', ['-c', 'core.fsmonitor=false', '--no-pager', ...args], { cwd: ROOT, encoding: 'utf8', timeout: ms, maxBuffer: 4 << 20, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } },
        (err, out) => { running--; queue.shift()?.(); res(err ? { ok: false, code: err.code, killed: !!err.killed, out: out ?? '' } : { ok: true, out }); });
    };
    running < 2 ? go() : queue.push(go);
  });
}
const ignoredCache = new Map();
async function ignored(rel) {
  if (!ignoredCache.has(rel)) {
    const r = await git(['check-ignore', '-q', '--', rel]);
    ignoredCache.set(rel, r.ok);                 // exit 0: ignored; 1: not; 128 (no repo): not
  }
  return ignoredCache.get(rel);
}

// ---- a path, checked -------------------------------------------------------------------------------------
/** The file a reference names, checked against every rule; its text and its real project-relative path. */
export async function readChecked(given) {
  if (typeof given !== 'string' || !given || given.length > 300 || !PATH_RE.test(given) || path.isAbsolute(given) || given.split('/').includes('..')) refuse('not a path inside the project');
  if (denied(given)) refuse(denied(given));
  let real;
  try { real = fs.realpathSync(path.resolve(ROOT, given)); } catch { return null; }      // not there: gone
  const rel = path.relative(REAL_ROOT, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) refuse('outside the project');
  if (denied(rel)) refuse(denied(rel));
  const st = fs.statSync(real);
  if (!st.isFile()) refuse('not a regular file');
  if (st.size > MAX_FILE) refuse('larger than 1 MB');
  if (await ignored(rel)) refuse('ignored by git');
  const buf = fs.readFileSync(real);
  if (buf.subarray(0, 8192).includes(0)) refuse('a binary file');
  return { rel: rel.split(path.sep).join('/'), text: buf.toString('utf8') };
}

const cap = (l) => [...l].length > LINE_CAP ? [...l].slice(0, LINE_CAP - 1).join('') + '…' : l;
const linesOf = (text) => text.replace(/\r\n?/g, '\n').split('\n');
/** lines [from, from+n) of a file, 1-based, each capped */
const excerpt = (lines, from, n) => lines.slice(from - 1, from - 1 + n).map(cap);

/** `path`, `path:12`, `path:12-30`, `path#symbol` */
export function parseSpec(spec) {
  const s = String(spec ?? '').trim();
  let m = /^(.+?)#([\w$.:-]{1,120})$/.exec(s);
  if (m) return { path: m[1], sym: m[2] };
  m = /^(.+?):(\d{1,7})(?:-(\d{1,7}))?$/.exec(s);
  if (m) return { path: m[1], a: +m[2], b: m[3] ? +m[3] : +m[2] };
  return { path: s };
}

const DEF = /^\s*(export\s+)?(default\s+)?(public\s+|private\s+|protected\s+|static\s+|readonly\s+)*(async\s+)?(function\*?|class|const|let|var|def|fn|func|interface|type|enum|struct|trait|impl|module|case)\b/;
const isWordChar = (c) => c !== undefined && /[\w$]/.test(c);
/** the lines holding `sym` as a whole word (indexOf, never a RegExp built from it); definitions first */
function symbolLines(lines, sym) {
  const hits = [];
  lines.forEach((l, i) => {
    for (let at = l.indexOf(sym); at >= 0; at = l.indexOf(sym, at + 1))
      if (!isWordChar(l[at - 1]) && !isWordChar(l[at + sym.length])) { hits.push(i + 1); break; }
  });
  // a definition: a keyword and then the name (`function sym`, `const sym =`, `class sym`), or a method or key
  // that starts its line (`async sym(…) {`, `sym: …`, `sym = …`)
  const defs = hits.filter(n => {
    const l = lines[n - 1], m = DEF.exec(l);
    if (m) return l.slice(m[0].length).replace(/^[\s*]+/, '').startsWith(sym);
    const t = l.trimStart().replace(/^((async|static|private|public|protected|readonly|get|set|override)\s+)+/, '');
    if (!t.startsWith(sym)) return false;
    const after = t.slice(sym.length).trimStart();
    return /^[:=](?!=)/.test(after) || after.startsWith('(') && /\{\s*$/.test(t) || after.startsWith('<') && /\{\s*$/.test(t);
  });
  return { defs, hits };
}

/** a snapshot within its caps: at most SNAP_LINES lines and SNAP_BYTES bytes */
function snapshotOf(ls) {
  const out = ls.slice(0, SNAP_LINES);
  while (out.length > 1 && Buffer.byteLength(out.join('\n')) > SNAP_BYTES) out.pop();
  let s = out.join('\n');
  if (Buffer.byteLength(s) > SNAP_BYTES) s = Buffer.from(s).subarray(0, SNAP_BYTES - 3).toString('utf8').replace(/�$/, '') + '…';
  return s;
}

// ---- making a reference (reply --ref) ------------------------------------------------------------------------------
export async function makeRef(spec, why) {
  const p = parseSpec(spec);
  const f = await readChecked(p.path);
  if (!f) refuse(`no file ${p.path} in the project`);
  const lines = linesOf(f.text);
  let kind = 'file', start = 1, n = SNAP_LINES, note = '';
  if (p.sym) {
    const { defs, hits } = symbolLines(lines, p.sym);
    if (!hits.length) refuse(`${p.sym} is not in ${f.rel}`);
    kind = 'symbol'; start = (defs[0] ?? hits[0]);
    if (!defs.length && hits.length > 1) note = `${p.sym} appears ${hits.length} times and none looks like its definition; took line ${start}`;
  } else if (p.a !== undefined) {
    if (p.a < 1 || p.b < p.a || p.a > lines.length) refuse(`${f.rel} has ${lines.length} lines`);
    kind = 'lines'; start = p.a; n = Math.min(p.b - p.a + 1, SNAP_LINES);
    if (p.b - p.a + 1 > SNAP_LINES) note = `the excerpt is the first ${SNAP_LINES} lines; pica fetches ${VIEW_LINES} when the writer opens it`;
  }
  // the anchor is the excerpt's first line with text in it: a blank line would be found everywhere
  while (start < lines.length && !lines[start - 1].trim() && n > 1) { start++; n--; }
  const ex = excerpt(lines, start, n), anchor = lines[start - 1].trim().slice(0, 200);
  if (!anchor) refuse(`line ${start} of ${f.rel} is blank`);
  const snapshot = snapshotOf(ex);
  const secret = secretIn(snapshot);
  if (secret) refuse(`the excerpt holds what looks like ${secret}; point at other lines, or describe them`);
  let sha = '', dirty = false;
  const head = await git(['rev-parse', '--verify', '-q', 'HEAD']);
  if (head.ok && HEX.test(head.out.trim()) && (await git(['ls-files', '--error-unmatch', '--', f.rel])).ok) {
    sha = head.out.trim();
    dirty = !(await git(['diff', '--quiet', '--no-ext-diff', '--no-textconv', 'HEAD', '--', f.rel])).ok;
  }
  const w = typeof why === 'string' ? why.replace(/\s+/g, ' ').trim() : '';
  if ([...w].length > MAX_WHY) refuse(`--why is at most ${MAX_WHY} characters`);
  if (w && secretIn(w)) refuse('--why holds what looks like a secret');
  return { ref: { path: f.rel, ...(p.sym ? { sym: p.sym } : {}), kind, line: start, anchor, sha, ...(dirty ? { dirty: true } : {}), snapshot, ...(w ? { why: w } : {}) }, note };
}

// ---- checking a reference read from the inbox (that file may sync, and be forged) -----------------------------
export function validRef(r) {
  const s = (v) => typeof v === 'string';
  return !!r && typeof r === 'object' && s(r.path) && r.path.length <= 300 && PATH_RE.test(r.path) && !r.path.startsWith('/') && !r.path.split('/').includes('..')
    && (r.sym === undefined || s(r.sym) && /^[\w$.:-]{1,120}$/.test(r.sym))
    && ['lines', 'symbol', 'file'].includes(r.kind) && Number.isInteger(r.line) && r.line >= 1 && r.line < 1e7
    && s(r.anchor) && r.anchor.length <= 200 && s(r.sha) && (r.sha === '' || HEX.test(r.sha)) && [undefined, true, false].includes(r.dirty)
    && s(r.snapshot) && Buffer.byteLength(r.snapshot) <= SNAP_BYTES + 3 && r.snapshot.split('\n').length <= SNAP_LINES
    && (r.why === undefined || s(r.why) && [...r.why].length <= MAX_WHY && !/[\n\r]/.test(r.why));
}
export const validRefs = (a) => Array.isArray(a) && a.length >= 1 && a.length <= MAX_REFS && a.every(validRef);

// ---- resolving: where the lines are now, or what they were ----------------------------------------------------------
/** old line → its line in the working tree, through `git diff -U0 <sha>` (null: git could not say in time) */
async function mapLine(ref, ms) {
  if (!ref.sha || ref.dirty || !HEX.test(ref.sha)) return null;
  const r = await git(['diff', '--no-color', '--no-textconv', '--no-ext-diff', '-U0', ref.sha, '--', ref.path], ms);
  if (!r.ok) return null;
  let off = 0;
  for (const m of r.out.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const a = +m[1], b = m[2] === undefined ? 1 : +m[2], c = +m[3], d = m[4] === undefined ? 1 : +m[4];
    if (b === 0 ? ref.line <= a : ref.line < a) break;
    if (b > 0 && ref.line <= a + b - 1) return { line: c, changed: true };       // the line itself was rewritten
    // a side with no lines (",0": a pure insertion or deletion) names the line before the hunk, not its first
    off = ((d === 0 ? c + 1 : c) + d) - ((b === 0 ? a + 1 : a) + b);
  }
  return { line: ref.line + off, changed: false };
}

const lru = new Map();
const remember = (k, v) => { lru.delete(k); lru.set(k, v); if (lru.size > 64) lru.delete(lru.keys().next().value); return v; };
const windowStart = (line, span) => Math.max(1, line - (span > SNAP_LINES ? 8 : 0));

/** `view` 'now' (the working tree: where the excerpt is now) or 'then' (the file at the reply's sha); `span` 12 or 40.
 *  Answers within `ms` with what it has: past that, `partial`. Never throws. */
export async function resolveRef(ref, { view = 'now', span = SNAP_LINES } = {}, ms = 2000) {
  span = span > SNAP_LINES ? VIEW_LINES : SNAP_LINES;
  const deadline = Date.now() + ms, left = () => Math.max(50, deadline - Date.now());
  try {
    if (!validRef(ref)) return { status: 'refused', why: 'not a reference' };
    if (view === 'then') {
      if (!ref.sha || ref.dirty) return { status: 'snapshot', line: ref.line, text: ref.snapshot, why: ref.dirty ? 'uncommitted when Claude replied' : 'not in git' };
      const key = `${ref.sha}:${ref.path}:${ref.line}:${span}`;
      if (lru.has(key)) return remember(key, lru.get(key));
      if (denied(ref.path) || await ignored(ref.path)) return { status: 'refused', why: denied(ref.path) ?? 'ignored by git' };
      const r = await git(['show', '--no-textconv', `${ref.sha}:./${ref.path}`], left());
      if (!r.ok) return r.killed ? { status: 'partial', line: ref.line, text: ref.snapshot } : { status: 'snapshot', line: ref.line, text: ref.snapshot, why: 'not in that commit' };
      if (r.out.length > MAX_FILE || r.out.includes('\0')) return { status: 'refused', why: 'larger than 1 MB, or binary' };
      const from = windowStart(ref.line, span), text = excerpt(linesOf(r.out), from, span).join('\n');
      const secret = secretIn(text); if (secret) return { status: 'refused', why: `holds what looks like ${secret}` };
      return remember(key, { status: 'then', line: from, at: ref.line, text });
    }
    let f;
    try { f = await readChecked(ref.path); } catch (e) { if (e instanceof Refusal) return { status: 'refused', why: e.message }; throw e; }
    if (!f) return { status: 'gone', line: ref.line, text: ref.snapshot, why: 'the file is no longer there' };
    const lines = linesOf(f.text);
    // the anchor, found again: every line holding it; the nearest to where git says the old line went
    const hits = [];
    lines.forEach((l, i) => { if (l.includes(ref.anchor)) hits.push(i + 1); });
    let partial = false, found = null, status = 'here';
    if (hits.length === 1) found = hits[0];
    else {
      const mapped = Date.now() < deadline ? await mapLine(ref, left()) : null;
      if (!mapped && ref.sha && !ref.dirty) partial = true;
      const near = mapped?.line ?? ref.line;
      if (hits.length) { found = hits.reduce((b, n) => Math.abs(n - near) < Math.abs(b - near) ? n : b); status = 'approximate'; }
      else if (ref.kind === 'symbol' && ref.sym) {
        const { defs, hits: sh } = symbolLines(lines, ref.sym), pool = defs.length ? defs : sh;
        if (pool.length) { found = pool.reduce((b, n) => Math.abs(n - near) < Math.abs(b - near) ? n : b); status = pool.length > 1 ? 'approximate' : 'here'; }
      }
      if (found === null) {
        // the excerpt's first line is not in the file any more: show where its place is now, if git knows
        if (!mapped) return { status: 'changed', line: ref.line, text: ref.snapshot, why: 'the lines are no longer in the file', ...(partial ? { partial: true } : {}) };
        found = Math.min(Math.max(1, mapped.line), lines.length); status = 'changed';
      }
    }
    const from = windowStart(found, span), text = excerpt(lines, from, span).join('\n');
    const secret = secretIn(text); if (secret) return { status: 'refused', why: `holds what looks like ${secret}` };
    return { status, line: from, at: found, was: ref.line, ...(hits.length > 1 ? { matches: hits.length } : {}), ...(partial ? { partial: true } : {}), text };
  } catch (e) {
    return { status: 'partial', line: ref.line, text: ref.snapshot, why: String(e?.message ?? e).split('\n')[0].slice(0, 120) };
  }
}

// ---- the replies' references, as the inbox holds them (tailed: only what was appended is read) ----------------------
export class RefIndex {
  pos = 0; head = ''; map = new Map();
  constructor(file) { this.file = file; }
  /** read what the inbox gained since the last look */
  update() {
    let fd;
    try { fd = fs.openSync(this.file, 'r'); } catch { return; }
    try {
      const size = fs.fstatSync(fd).size, h = Buffer.alloc(Math.min(64, size));
      fs.readSync(fd, h, 0, h.length, 0);
      const head = h.toString('latin1');
      if (size < this.pos || (this.head && size >= 64 && head !== this.head)) { this.pos = 0; this.map.clear(); }
      if (size >= 64) this.head = head;
      if (size <= this.pos) return;
      const buf = Buffer.alloc(size - this.pos);
      fs.readSync(fd, buf, 0, buf.length, this.pos);
      const end = buf.lastIndexOf(0x0a) + 1;
      for (const l of buf.subarray(0, end).toString('utf8').split('\n')) {
        if (!l.includes('"refs"')) continue;
        try { const o = JSON.parse(l); if (o.op === 'reply' && typeof o.id === 'string' && validRefs(o.refs)) this.map.set(o.id, { refs: o.refs, project: o.project }); } catch {}
      }
      this.pos += end;
    } finally { fs.closeSync(fd); }
  }
  get(id) { this.update(); return this.map.get(id); }
}
