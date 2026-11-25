#!/usr/bin/env node
// The guard on values (IMPORT-PLAN §5): what must be refused, the look-alikes that must pass, its speed on a large
// sheet, and that every command writing text to the journal refuses a secret, naming the line; mirror leaves such
// a memory out and says so once. Run against a journal folder made for the test.
//   node test/guard.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { secretIn, secretLine } from '../lib/refs.mjs';
import { scrub } from '../lib/survey.mjs';
import { sheetVersion } from '../lib/version.mjs';

let fails = 0, passes = 0;
const ok = (c, what) => { if (c) passes++; else { fails++; console.log('FAIL', what); } };

// made-up values only: shaped like keys, never real ones
const MUST_REFUSE = [
  '"SOME_API_KEY": "ab12CD34ef56GH78ij90"', "some_api_key: 'ab12CD34ef56GH78ij90'", 'apiKey: "Zx9Yw8Vu7Ts6Rq5Po4Nm"',
  'LIVE API key: ab12CD34ef56GH78ij90kl', 'Client secret – Xy9zXy9zXy9zXy9zXy9z', 'Webhook secret is Q1w2E3r4T5y6U7i8',
  'Password: Hunter2xyz!', 'whsec_abcdefghijklmnop1234', 'sk_live_abc123def456ghi', 'pk_test_abc123def456ghi',
  're_AbCdEf123456GhIjKl7890x', 'sk-ant-api03-abcdefghijklmnopqrstuv', 'STRIPE_SECRET_KEY=sk_abc123def456ghi789jkl',
  'postgres://user:hunter2@db.example.com/x', 'Authorization: Bearer abcdefghijklmnop1234567',
];
const MUST_PASS = [
  'commit 0319456f8a3b2c1d4e5f6a7b8c9d0e1f2a3b4c5d', 'uuid 3f2b8c1e-4d5a-4b6c-9e7f-1a2b3c4d5e6f',
  'migration 20260303120000_add_weight failed', 'color: #a1b2c3', 'CREEM_API_KEY is read in src/lib/creem.ts',
  'apiKey: process.env.CREEM_API_KEY', 'The API key: kept in the team vault', 're_render_component_now',
  'token: "${{ secrets.NEON_API_KEY }}"', 'the password reset flow', 'SOME_API_KEY', '"key": "row-1234-abcd-5678-efgh"',
  'API key: see the 1Password entry “Creem live”',
];
for (const t of MUST_REFUSE) ok(secretIn(t), `refused: ${t}`);
for (const t of MUST_PASS) ok(!secretIn(t), `passes: ${t} (${secretIn(t)})`);
ok(secretLine('one\ntwo\nPassword: Hunter2xyz!\n')?.line === 3, 'secretLine names the line');

// scrub: the same shapes are taken out of transcripts; a timestamp is not a phone number
ok(scrub('migration 20260303120000 failed') === 'migration 20260303120000 failed', 'a bare 14-digit timestamp is not a phone number');
ok(scrub('call +1 (415) 555-0134 now') === 'call [phone] now', 'a phone number still is');
ok(scrub('"SOME_API_KEY": "ab12CD34ef56GH78ij90"') === '"SOME_API_KEY": "[secret]"', 'scrub: a key in JSON');
ok(scrub('LIVE API key: ab12CD34ef56GH78ij90kl') === 'LIVE API key: [secret]', 'scrub: a key after its label');

// speed: a sheet of 100,000 characters, ordinary and adversarial, well under 50 ms
const prose = ('A normal line about API keys, tokens and CREEM_API_KEY, migration 20260303120000, commit 0319456f8.\n').repeat(1000).slice(0, 100000);
for (const [name, text] of [['prose', prose], ['KEY_ repeated', 'KEY_'.repeat(25000)], ['api key: repeated', 'api key: '.repeat(11000)], ['digits', '1'.repeat(100000)]]) {
  const t = process.hrtime.bigint(); secretLine(text); const ms = Number(process.hrtime.bigint() - t) / 1e6;
  ok(ms < 50, `${name}: ${ms.toFixed(1)} ms`);
}

// every command that writes text refuses a secret
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'journal.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pica-journal-guard-')), mem = fs.mkdtempSync(path.join(os.tmpdir(), 'pica-journal-guard-mem-'));
fs.mkdirSync(path.join(dir, 'sheets'));
const run = (...a) => { const r = spawnSync(process.execPath, [CLI, ...a], { cwd: dir, env: { ...process.env, PICA_JOURNAL: dir, CLAUDE_MEMORY_DIR: mem }, encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const P = (attrs, text) => ({ type: 'paragraph', attrs, content: text ? [{ type: 'text', text }] : [] });
const doc1 = { type: 'doc', attrs: {}, content: [P({ id: 'i1', item: 'open' }, 'Where is the key kept?')] };
fs.writeFileSync(path.join(dir, 'sheets', 's1.pica'), JSON.stringify({ v: 2, doc: doc1 }));
const SECRET = 'Webhook secret is Q1w2E3r4T5y6U7i8';
const inbox = () => { try { return fs.readFileSync(path.join(dir, 'inbox.jsonl'), 'utf8'); } catch { return ''; } };
for (const [what, args] of [
  ['reply', ['reply', 's1', 'i1', `It is here:\n\n${SECRET}`]], ['recast', ['recast', 's1', 'i1', SECRET]], ['pin', ['pin', 's1', SECRET]],
  ['sheet', ['sheet', 'Credentials', `# Credentials\n\n${SECRET}`]], ['sheet title', ['sheet', SECRET, '# Fine']],
  ['rewrite', ['rewrite', '--base', sheetVersion(doc1), 's1', `{#i1}\n\n${SECRET}`]],
]) {
  const r = run(...args);
  ok(r.code !== 0 && /secret|looks like/.test(r.err) && !inbox().includes('Q1w2E3r4'), `${what} refuses a secret (${r.err.trim().slice(0, 90)})`);
}
ok(/line 3/.test(run('reply', 's1', 'i1', `It is here:\n\n${SECRET}`).err), 'the refusal names the line');
ok(run('reply', 's1', 'i1', 'Kept in the team vault, under “Webhook (live)”.').code === 0, 'a credential named, not given, is written');

// mirror: a memory holding a secret is left out, said once, and mirrored once the value is taken out
fs.writeFileSync(path.join(mem, 'ok.md'), '---\nname: ok\n---\nA fact.\n');
fs.writeFileSync(path.join(mem, 'leaky.md'), `---\nname: leaky\n---\n${SECRET}\n`);
let m = run('mirror');
ok(/not mirrored: leaky\.md/.test(m.out) && fs.existsSync(path.join(dir, 'memory', 'ok.md')) && !fs.existsSync(path.join(dir, 'memory', 'leaky.md')), 'mirror leaves a leaky memory out: ' + m.out.trim());
m = run('mirror');
ok(!/not mirrored/.test(m.out), 'and says so once: ' + m.out.trim());
fs.writeFileSync(path.join(mem, 'leaky.md'), '---\nname: leaky\n---\nThe webhook secret is in the vault.\n');
m = run('mirror');
ok(fs.existsSync(path.join(dir, 'memory', 'leaky.md')), 'mirrored once the value is out: ' + m.out.trim());
ok(!inbox().includes('Q1w2E3r4'), 'no value reached the inbox');

fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(mem, { recursive: true, force: true });
console.log(fails ? `guard: ${fails} of ${fails + passes} failed` : `guard: ${passes} checks pass`);
process.exit(fails ? 1 : 0);
