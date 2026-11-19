// node test/refs.mjs: references to code (lib/refs.mjs) in a scratch git project: what is refused, and where
// an excerpt is found again after the file changes
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pica-refs-'));
const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
w('src/a.ts', '// header\nexport function readInbox(x: number) {\n  return x;\n}\n\nclass Box {\n  async open() {\n    readInbox(2);\n  }\n}\n');
w('.env', 'A=1\n'); w('.gitignore', 'dist\n'); w('dist/o.js', 'x\n'); w('src/k.ts', 'const k = "ghp_abcdefghijklmnopqrstuvwxyz";\n');
w('src/p.ts', 'let password = "hunter22";\n'); w('src/m.ts', 'a\nb\nc\nx\nd\nx\n'); fs.symlinkSync('.env', path.join(dir, 'link.txt')); fs.mkdirSync(path.join(dir, 'journal'));
g('init', '-q'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one');
process.chdir(dir); process.env.CLAUDE_PROJECT_DIR = dir; delete process.env.PICA_JOURNAL;
const R = await import('../lib/refs.mjs');

let bad = 0, n = 0;
const ok = (c, what) => { n++; if (!c) { bad++; console.log('✗ ' + what); } };
const refused = async (spec) => { try { await R.makeRef(spec); return null; } catch (e) { return e instanceof R.Refusal ? e.message : 'threw ' + e; } };

for (const s of ['.env', 'link.txt', 'dist/o.js', 'src/k.ts', 'src/p.ts', '../x', '/etc/passwd', 'journal/inbox.jsonl', 'src/a.ts#nope', 'src/a.ts:50'])
  ok(await refused(s), `${s} is refused`);
const { ref: sym } = await R.makeRef('src/a.ts#readInbox', 'the reader');
ok(sym.kind === 'symbol' && sym.line === 2 && sym.anchor.startsWith('export function readInbox') && /^[0-9a-f]{40}$/.test(sym.sha) && !sym.dirty, 'a symbol is found at its definition, with HEAD');
const { ref: open } = await R.makeRef('src/a.ts#open');
ok(open.line === 7, 'a method is found where it is defined, not where it is called');
const { ref: lines } = await R.makeRef('src/a.ts:5-30');
ok(lines.line === 6 && lines.snapshot.split('\n').length <= R.SNAP_LINES, 'a range skips its blank first line and is capped at 12 lines');
ok(R.validRef(sym) && R.validRef(lines) && !R.validRef({ ...sym, path: '../x' }) && !R.validRef({ ...sym, sha: 'HEAD~1' }) && !R.validRef({ ...sym, snapshot: 'x\n'.repeat(13) }), 'validRef checks shape, path, sha and size');

w('src/a.ts', '// header\n// one\n// two\nexport function readInbox(x: number) {\n  return x;\n}\n\nclass Crate {\n  async open() {\n    readInbox(2);\n  }\n}\n');
let r = await R.resolveRef(sym);
ok(r.status === 'here' && r.at === 4 && r.was === 2, 'an excerpt moved down is found again: ' + JSON.stringify({ ...r, text: undefined }));
r = await R.resolveRef(lines);
ok(r.status === 'changed' && r.at === 8, 'a rewritten first line is placed by git diff: ' + JSON.stringify({ ...r, text: undefined }));
r = await R.resolveRef(lines, { view: 'then', span: 40 });
ok(r.status === 'then' && r.text.includes('class Box'), 'then: the lines as they were at the sha');
w('src/a.ts', 'export function readInbox(x: number) {\n  let password = "letmein1";\n');
ok((await R.resolveRef(sym)).status === 'refused', 'a view that now holds a secret is refused');
// a line deleted above an anchor that appears twice: git's line map must say where the old line went (a pure
// deletion's hunk, "-2,1 +1,0", names the line before it)
const { ref: twice } = await R.makeRef('src/m.ts:6');
w('src/m.ts', 'a\nc\nx\nd\nx\n');
r = await R.resolveRef(twice);
ok(r.status === 'approximate' && r.at === 5, 'after a deletion above, the nearer of two matches is the one git maps to: ' + JSON.stringify({ ...r, text: undefined }));
fs.rmSync(path.join(dir, 'src/a.ts'));
ok((await R.resolveRef(sym)).status === 'gone', 'a file removed is gone');

fs.rmSync(dir, { recursive: true, force: true });
console.log(bad ? `${bad} of ${n} failed` : `refs: ${n} checks pass`);
process.exit(bad ? 1 : 0);
