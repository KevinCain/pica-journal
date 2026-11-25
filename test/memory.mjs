#!/usr/bin/env node
// The journal's memory folder (IMPORT-PLAN §3) and rules kept by hand (§6): `memory` lists the candidates and
// records one; mirror, adopt, forget and remember then use it; a switch tells pica the old memory sheets are gone;
// `remember` writes a rule only once the writer has ✓'d it. Against a project, a journal and a Claude config made
// for the test.
//   node test/memory.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'journal.mjs');
const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pica-journal-memory-')));
const project = path.join(top, 'work', 'app'), journal = path.join(project, 'journal'), claude = path.join(top, 'claude');
fs.mkdirSync(path.join(journal, 'sheets'), { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: project });
const memOf = (f) => path.join(claude, 'projects', f.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
const put = (f, name, body) => { fs.mkdirSync(memOf(f), { recursive: true }); fs.writeFileSync(path.join(memOf(f), name + '.md'), `---\nname: ${name}\ndescription: ${body}\n---\n${body}\n`); };
put(project, 'own', 'The project folder holds one memory.');
put(path.join(top, 'work'), 'above-1', 'Most sessions ran in the folder above.'); put(path.join(top, 'work'), 'above-2', 'So most memories are there.');

let fails = 0, passes = 0;
const ok = (c, what) => { if (c) passes++; else { fails++; console.log('FAIL', what); } };
const run = (...a) => { const r = spawnSync(process.execPath, [CLI, ...a], { cwd: project, env: { ...process.env, PICA_JOURNAL: journal, CLAUDE_PROJECT_DIR: project, CLAUDE_CONFIG_DIR: claude, CLAUDE_MEMORY_DIR: '' }, encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
delete process.env.CLAUDE_MEMORY_DIR;
const inbox = () => { try { return fs.readFileSync(path.join(journal, 'inbox.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

let r = run('memory');
ok(r.out.includes(`memory ${memOf(project)} (the project's, not recorded)`), 'unrecorded, the project\'s memory: ' + r.out.split('\n')[0]);
ok(new RegExp(`candidate ${path.join(top, 'work')}\\t2 memories`).test(r.out) && new RegExp(`candidate ${project}\\t1 memories\\t\\(in use\\)`).test(r.out), 'the candidates, with their memories');
run('mirror');
ok(fs.existsSync(path.join(journal, 'memory', 'own.md')), 'mirror reads the project\'s memory');

ok(run('memory', os.homedir()).code !== 0, 'the home folder is never a candidate');
ok(run('memory', path.join(top, 'elsewhere')).code !== 0, 'nor a folder that is not above the project');
r = run('memory', path.join(top, 'work'));
ok(r.code === 0 && /2 memories/.test(r.out), 'record the folder above: ' + r.out.trim());
ok(inbox().some(o => o.op === 'memory' && o.gone && o.sheet === 'mem-own'), 'pica is told the old memory sheets are gone');
ok(!fs.existsSync(path.join(journal, 'memory')), 'and the old mirror is cleared');
r = run('mirror');
ok(fs.existsSync(path.join(journal, 'memory', 'above-1.md')) && !fs.existsSync(path.join(journal, 'memory', 'own.md')), 'mirror now reads the recorded folder');
ok(!inbox().some(o => o.op === 'memory' && o.new), 'its memories arrive as a first mirror, not as new ones to keep');
ok(/\(recorded\)/.test(run('memory').out), 'memory says it is recorded');

// remember: a rule proposed as an item, answered, then ✓'d by the writer
const P = (attrs, text) => ({ type: 'paragraph', attrs, content: [{ type: 'text', text }] });
const sheet = (item) => fs.writeFileSync(path.join(journal, 'sheets', 'rules.pica'), JSON.stringify({ v: 2, doc: { type: 'doc', content: [P({ id: 'h' }, 'Rules kept by hand'), P({ id: 'k1', item }, 'When you change the credit packs in the modal, change the Credit Packages section too.')] } }));
sheet('answered');
ok(/not ✓'d/.test(run('remember', 'rules', 'k1', 'credit-packs-twice').err), 'remember refuses before the writer ✓s');
sheet('done');
ok(/not ✓'d/.test(run('remember', 'rules', 'k1', 'credit-packs-twice').err), 'and without the agree in the outbox');
fs.writeFileSync(path.join(journal, 'outbox.jsonl'), JSON.stringify({ op: 'agree', id: 'a1', sheet: 'rules', item: 'k1', at: '2026-11-24T12:00:00Z' }) + '\n');
ok(run('remember', 'rules', 'k1', 'Bad Name').code !== 0, 'a memory name is lower-case-with-hyphens');
r = run('remember', 'rules', 'k1', 'credit-packs-twice');
const f = path.join(memOf(path.join(top, 'work')), 'credit-packs-twice.md');
ok(r.code === 0 && fs.existsSync(f), 'remember writes to the recorded folder: ' + (r.err || r.out).trim().split('\n')[0]);
ok(/^---\nname: credit-packs-twice\ndescription: "When you change/.test(fs.readFileSync(f, 'utf8')) && fs.readFileSync(f, 'utf8').includes('change the Credit Packages section too.'), 'the item\'s words, as they are');
ok(fs.readFileSync(path.join(memOf(path.join(top, 'work')), 'MEMORY.md'), 'utf8').includes('[credit-packs-twice](credit-packs-twice.md)'), 'with its line in the index');
ok(fs.existsSync(path.join(journal, 'memory', 'credit-packs-twice.md')), 'and mirrored at once');
ok(/exists already/.test(run('remember', 'rules', 'k1', 'credit-packs-twice').err), 'never over an existing memory');

fs.rmSync(top, { recursive: true, force: true });
console.log(fails ? `memory: ${fails} of ${fails + passes} failed` : `memory: ${passes} checks pass`);
process.exit(fails ? 1 : 0);
