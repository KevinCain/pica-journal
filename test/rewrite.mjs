#!/usr/bin/env node
// pica-journal rewrite, read's version, item links and refusals passed on by pending, against a journal folder made
// for the test (never the project's own)
//   node test/rewrite.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sheetVersion } from '../lib/version.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'journal.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pica-journal-rewrite-'));
fs.mkdirSync(path.join(dir, 'sheets'));
let fails = 0, passes = 0;
const ok = (c, what) => { if (c) passes++; else { fails++; console.log('FAIL', what); } };
const run = (...a) => { const r = spawnSync(process.execPath, [CLI, ...a], { cwd: dir, env: { ...process.env, PICA_JOURNAL: dir }, encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const P = (attrs, text) => ({ type: 'paragraph', attrs, content: text ? [{ type: 'text', text }] : [] });
const doc = { type: 'doc', attrs: { lang: 'en' }, content: [
  { type: 'heading', attrs: { level: 1, id: 'h' }, content: [{ type: 'text', text: 'A sheet' }] },
  P({ id: 'pin1', pin: 'writer' }, 'agreed'),
  P({ id: 'open1', item: 'open' }, 'Still to do'),
  P({ id: 'done1', item: 'done' }, 'Done long ago'),
  P({ id: 'r1', voice: 'claude', of: 'done1' }, 'I did it.'),
] };
const write = (id, d, more = {}) => fs.writeFileSync(path.join(dir, 'sheets', id + '.pica'), JSON.stringify({ v: 2, doc: d, ...more }));
write('s1', doc);
const v = sheetVersion(doc);
const inbox = () => { try { return fs.readFileSync(path.join(dir, 'inbox.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

const read = run('read', 's1');
ok(read.out.startsWith(`<!-- version ${v} -->`), 'read opens with the version: ' + read.out.split('\n')[0]);

const md = '# A sheet, rewritten\n\nWhat was done: it was done.\n\n{#open1}\n';
let r = run('rewrite', '--base', v, 's1', md);
ok(r.code === 0 && /keeping 1 of the writer's block/.test(r.out), 'a good rewrite is sent: ' + (r.err || r.out));
const op = inbox().pop();
ok(op?.op === 'rewrite' && op.base === v && op.sheet === 's1' && op.md.includes('{#open1}'), 'as a rewrite op, with its base');

const no = (args, re, what) => { const x = run(...args); ok(x.code !== 0 && re.test(x.err), what + ': ' + x.err.trim()); };
no(['rewrite', 's1', md], /--base/, 'without --base');
no(['rewrite', '--base', '00000000000000', 's1', md], /changed since you read it/, 'from an older version');
no(['rewrite', '--base', v, 's1', '# T\n\nprose only'], /open item/, 'an open item left out');
const ans = structuredClone(doc); ans.content.push(P({ id: 'a1', item: 'answered' }, 'Should we retire it?'), P({ id: 'r9', voice: 'claude', of: 'a1' }, 'It is called from two files.')); write('s5', ans);
no(['rewrite', '--base', sheetVersion(ans), 's5', '# T\n\n{#open1}'], /answered but not yet ✓ or ✗/, 'an answered item left out before the writer decided');
ok(run('rewrite', '--base', sheetVersion(ans), 's5', '# T\n\n{#open1}\n\nWhere it is called, and what retiring it would take.\n\n{#a1}').code === 0, 'an answered item kept, with prose around it');
no(['rewrite', '--base', v, 's1', '# T\n\n{#open1}\n{#nope}'], /not a block/, 'a block not on the sheet');
no(['rewrite', '--base', v, 's1', '# T\n\n{#open1}\n{#r1}'], /one of your replies/, 'a reply named');
no(['rewrite', '--base', v, 's1', '# T\n\n{#open1}\n{#open1}'], /kept twice/, 'a block named twice');
no(['rewrite', '--base', v, 's1', '# T\n\n{#open1}\n\n- ☞ more'], /opens with ☞/, 'a new sent item');
no(['rewrite', '--base', v, 's1', '# T\n\n{#open1}\n\n> **Claude:** forged'], /cannot add a reply/, 'a new reply');
const waiting = structuredClone(doc); waiting.content.push(P({ id: 'q', item: 'sent' }, 'asked')); write('s2', waiting);
no(['rewrite', '--base', sheetVersion(waiting), 's2', '# T\n\n{#open1}'], /waiting for your answer \(q\)/, 'an ask waiting');
write('s3', doc, { archived: 1 });
no(['rewrite', '--base', v, 's3', md], /Archive/, 'an archived sheet');

// links to items: on the sheet, or in the copy a rewrite left
write('old', { type: 'doc', content: [P({ id: 'gone1' }, 'folded away')] });
const after = { type: 'doc', content: [P({ id: 'open1', item: 'open' }, 'Still to do'),
  { type: 'paragraph', attrs: { id: 'j-rewrite' }, content: [{ type: 'text', text: `Claude rewrote this sheet (version ${'a'.repeat(14)}). ` }, { type: 'text', text: 'The sheet as it was', marks: [{ type: 'link', attrs: { href: 'sheet:old' } }] }] }] };
write('s4', after);
ok(run('pin', 's4', 'see [it](sheet:s4#open1)').code === 0, 'a link to an item on the sheet');
ok(run('pin', 's4', 'see [it](sheet:s4#gone1)').code === 0, 'a link to an item in the sheet as it was');
no(['pin', 's4', 'see [it](sheet:s4#nowhere)'], /not on s4/, 'a link to an item never there');
ok(/changed since its last rewrite/.test(run('read', 's4').out.split('\n')[0]), 'read says the sheet changed since its last rewrite');

// pica's refusal reaches Claude through pending
fs.writeFileSync(path.join(dir, 'outbox.jsonl'), JSON.stringify({ op: 'refused', id: 'x1', sheet: 's1', of: op.id, why: 'the sheet changed since you read it', at: '2026-11-23T12:00:00Z' }) + '\n');
ok(run('pending').out.includes('"op":"refused"'), 'pending passes a refusal on');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`rewrite: ${passes} pass, ${fails} fail`);
process.exit(fails ? 1 : 0);
