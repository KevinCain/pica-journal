// node test/survey.mjs: the survey (lib/survey.mjs) in a scratch git project: what is left out, survival, removals,
// the blame cache, --since, and the scrubbing of what is private
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pica-survey-')), data = fs.mkdtempSync(path.join(os.tmpdir(), 'pica-survey-data-'));
const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' });
const lines = (n, p) => Array.from({ length: n }, (_, i) => `${p} ${i}`).join('\n') + '\n';
const commit = (m) => { g('add', '-A'); g('commit', '-qm', m); return g('rev-parse', 'HEAD').trim(); };

g('init', '-q');
w('src/a.ts', lines(40, 'const a =')); w('package-lock.json', lines(500, '"x":')); w('data/rows.json', '[' + '1,'.repeat(15000) + '1]\n');
w('LICENSE', 'MIT\n'); w('PLAN.md', lines(30, 'plan'));
const first = commit('First: a and a plan');
w('src/a.ts', lines(20, 'const a =') + lines(20, 'const b ='));
w('src/old.ts', lines(120, 'let old ='));
commit('Second: b replaces half of a, and old.ts');
fs.rmSync(path.join(dir, 'src/old.ts'));
const mid = commit('Remove old.ts, which nothing used');
w('src/c.ts', lines(10, 'const c =')); commit('Third: c');

// how the project runs: env reads in each form, an example env file, deploy config, a workflow, a deploy script,
// migrations (one edited later), a seed, a skill, an agent config holding a literal key (made up), a pair of
// files that always change together, and a security fix
w('src/env.ts', [
  'const a = process.env.ALPHA_KEY;', "const b = process.env['BETA_URL'];", 'const { GAMMA_TOKEN, DELTA } = process.env;',
  'const v = import.meta.env.VITE_PUBLIC_THING;', 'import Stripe from "stripe";', 'const s = new Stripe(process.env.STRIPE_SECRET_KEY);',
  'fetch("https://api.rentcast.io/v1/x");', ''].join('\n'));
w('app.py', 'import os\nX = os.environ["PY_SETTING"]\nY = os.getenv("PY_OTHER")\n');
w('.env.example', 'ALPHA_KEY=\nBETA_URL=https://example.com\nUNUSED_NAME=xyz\n');
w('package.json', JSON.stringify({ name: 'x', scripts: { build: 'next build', 'db:migrate': 'prisma migrate deploy', dev: 'next dev' }, dependencies: { stripe: '1' } }));
w('vercel.json', JSON.stringify({ framework: 'nextjs', crons: [{ path: '/api/cron/nightly', schedule: '0 3 * * *' }] }));
w('.github/workflows/reset.yml', '# Reset the demo every night: data only, never code.\non:\n  schedule:\n    - cron: "0 3 * * *"\n  workflow_dispatch:\njobs:\n  r:\n    steps:\n      - run: npx tsx scripts/reset.ts\n        env:\n          K: ${{ secrets.RESET_DB_URL }}\n');
w('scripts/deploy-demo.sh', '#!/bin/sh\n# Deploys the working tree to the demo, by hand.\nvercel --prod --yes\n');
w('prisma/migrations/20260101000000_init/migration.sql', 'CREATE TABLE a (id int);\n');
w('prisma/seed.ts', "await db.user.create({ data: { email: 'admin@example.test', role: 'ADMIN', password: hash('x') } });\n");
w('.claude/skills/release/SKILL.md', '---\nname: release\ndescription: Push to production after the checks\n---\nSteps.\n');
w('opencode.json', JSON.stringify({ mcp: { pay: { headers: { SOME_API_KEY: 'ab12CD34ef56GH78ij90kl' } } } }, null, 1));
w('docs/pilot-guide.md', '# Pilot program guide\n\n## Pricing for pilots\n\ntext\n');
w('docs/audit-answer-key.md', '# The answer key\n');
w('lib/x.ts', lines(5, 'x')); w('web/y.ts', lines(5, 'y'));
commit('Running: config, env reads and a deploy script');
// a migration edited a day after it was added; prisma's dates are the commits'
const later2 = new Date(Date.now() + 2 * 86400000).toISOString(), day1 = { GIT_AUTHOR_DATE: later2, GIT_COMMITTER_DATE: later2 };
w('prisma/migrations/20260101000000_init/migration.sql', 'CREATE TABLE a (id int, b int);\n');
execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'Edit the init migration after db push'], { cwd: dir, env: { ...process.env, ...day1 } });
for (let i = 0; i < 5; i++) { w('lib/x.ts', lines(6 + i, 'x')); w('web/y.ts', lines(6 + i, 'y')); commit(`Change x and y together ${i}`); }
w('src/env.ts', fs.readFileSync(path.join(dir, 'src/env.ts'), 'utf8') + '// scoped\n'); commit('Scope queries by tenantId; require webhook secret');
const runAt = g('rev-parse', 'HEAD').trim();

const run = (...a) => execFileSync('node', [path.resolve('lib/journal.mjs'), 'survey', ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: data, CLAUDE_PROJECT_DIR: dir, PICA_JOURNAL: '' } });
let failed = 0, n = 0;
const check = (what, ok) => { n++; if (!ok) { failed++; console.error('FAIL ' + what); } };

const out = run(); if (process.env.SHOW) console.log(out);
check('lockfile, data and licence are left out', /left out: .*1 lockfile/.test(out) && /1 data/.test(out) && /1 licence/.test(out));
check('a.ts: 20 of its 40 first lines survive', /src\/a\.ts.*\n[\s\S]*?First: a and a plan \(20 lines here; 50 of 70 survive in all\)/.test(out) || /First: a and a plan \(20 lines here/.test(out));
check('prose is listed under Documents, not weighed', /## Documents[\s\S]*PLAN\.md: “PLAN\.md”/.test(out) && !/### \d+\. PLAN\.md/.test(out));
check('documents ranked by subject: the pilot guide first, with its title', /## Documents\n\n.*\n\n- docs\/pilot-guide\.md: “Pilot program guide” \(pricing, pilot/.test(out));
const sec = (name) => (new RegExp(`### ${name}\\n([\\s\\S]*?)(?=\\n###? |$)`).exec(out) ?? [])[1] ?? '';
const env = sec('Environment names');
check('env names in every form', ['ALPHA_KEY', 'BETA_URL', 'GAMMA_TOKEN', 'DELTA', 'VITE_PUBLIC_THING', 'PY_SETTING', 'PY_OTHER', 'STRIPE_SECRET_KEY'].every(n => env.includes(n)));
check('the example env file is read for names only', /listed in \.env\.example/.test(env) && /in no example file[^\n]*GAMMA_TOKEN/.test(env) && /read nowhere in code[^\n]*UNUSED_NAME/.test(env) && !/example\.com|xyz/.test(out));
const dep = sec('Deploy and schedules');
check('vercel crons, the workflow and the deploy script', /vercel\.json: sets framework, crons; 1 crons: \/api\/cron\/nightly \(0 3 \* \* \*\)/.test(dep) && /reset\.yml: on schedule 0 3 \* \* \*, workflow_dispatch; runs npx tsx scripts\/reset\.ts; secrets named: RESET_DB_URL/.test(dep) && /> Reset the demo every night/.test(dep) && /deploy-demo\.sh: runs vercel --prod --yes; deploys to production/.test(dep) && /> Deploys the working tree/.test(dep));
check('package scripts by what they run', /package\.json scripts: build \(\.\.\.|package\.json scripts: [^\n]*db:migrate \(prisma migrate deploy\)/.test(dep) || /db:migrate/.test(dep));
check('CI-only names', /Named in CI only[^\n]*RESET_DB_URL/.test(dep));
const dataSec = sec('Data');
check('migrations, and one edited after it was added', /prisma\/migrations: 1 migrations/.test(dataSec) && /1 edited after they were added[^\n]*20260101000000_init/.test(dataSec) && /mention db push or migrate resolve/.test(dataSec));
check('services from packages, env and hosts', /- Stripe: package stripe; env STRIPE_SECRET_KEY/.test(sec('Services')) && /api\.rentcast\.io/.test(sec('Services')));
check('tooling: the skill and the MCP config', /skill release: Push to production/.test(sec('Tooling')) && /opencode\.json: keys mcp/.test(sec('Tooling')));
check('a test login by role, never its password', /prisma\/seed\.ts: 1 user by email; roles ADMIN; sets a password \(not shown\)/.test(out) && !/admin@example/.test(out));
check('a committed secret, by file and name, at the top', /## Committed secrets[\s\S]*- opencode\.json: line \d+, a key in a config/.test(out) && out.indexOf('## Committed secrets') < out.indexOf('## Threads') && !/ab12CD34/.test(out));
check('a pair that changes together', /lib\/x\.ts and web\/y\.ts: 6 commits together \(100%\)/.test(out));
check('a security fix', /### Security[\s\S]*Scope queries by tenantId; require webhook secret/.test(out));
check('a removal is a decision', /## Removals and reverts[\s\S]*Remove old\.ts, which nothing used: removed 120 lines/.test(out));
check('the first run blames every file', /Blame: \d+ files blamed, 0 from the cache/.test(out));
const again = run();
check('running the project at the same HEAD comes from the cache', /running the project and signals from the cache/.test(again));
// leave-out: a document, a session or a memory naming a word in the journal's leave-out.txt is not read
const jdir = path.join(dir, 'journal'); fs.mkdirSync(jdir, { recursive: true }); fs.writeFileSync(path.join(jdir, 'leave-out.txt'), '# the answer key\naudit-answer-key\n');
const lo = execFileSync('node', [path.resolve('lib/journal.mjs'), 'survey'], { cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: data, CLAUDE_PROJECT_DIR: dir, PICA_JOURNAL: jdir } });
check('leave-out.txt keeps a document out, and says so', !/audit-answer-key/.test(lo.split('## Documents')[1].split('\n## ')[0]) && /Left out by the journal's leave-out\.txt \(1 word\): 1 documents/.test(lo));
fs.rmSync(jdir, { recursive: true, force: true });
check('a second run reads the cache', /Blame: 0 files blamed, \d+ from the cache/.test(again));
const since = run('--since', mid);
check('--since counts the new commit', /## Since [0-9a-f]+\n\n\d+ new commits?\./.test(since));
check('--since a commit outside the history says so', /no longer in this history/.test(run('--since', 'abcdef1234567')));
check('--since the first commit works', /## Since/.test(run('--since', first)));
w('.github/workflows/lint.yml', 'on: [push]\njobs:\n  l:\n    steps:\n      - run: npm run lint\n'); commit('Add a lint workflow');
const later = run('--since', runAt);
check('--since says which kept sheets moved', /- Infrastructure: moved \(new: [^\n]*lint\.yml/.test(later) && /- Credentials and access: unchanged/.test(later) && /- How we work: unchanged/.test(later));

const { scrub, leftOut, newPath } = await import(path.resolve('lib/survey.mjs'));
const cases = [
  ['mail me at someone@example.org', 'mail me at [email]'],
  ['call +1 (415) 555-0134 now', 'call [phone] now'],
  ['version 1.2.3 and 2026-11-23 stay', 'version 1.2.3 and 2026-11-23 stay'],
  ['postgres://user:hunter2@db.example.com/x', 'postgres://[credentials]@db.example.com/x'],
  ['STRIPE_SECRET_KEY=sk_live_abcdefghijklmnop1234', 'STRIPE_SECRET_KEY=[secret]'],
  ['API_KEY = process.env.API_KEY', 'API_KEY = process.env.API_KEY'],
  ['Authorization: Bearer abcdefghijklmnop1234', 'Authorization: Bearer [token]'],
  ['they stayed at 12 Ocean View Drive last week', 'they stayed at [address] last week'],
  ['commit 0319456f8 is fine', 'commit 0319456f8 is fine'],
];
for (const [a, b] of cases) check(`scrub ${JSON.stringify(a)} → ${JSON.stringify(scrub(a))}`, scrub(a) === b);
check('lockfiles by name', leftOut('web/yarn.lock') === 'lockfile' && leftOut('src/lock.ts') === null);
check('generated by folder', leftOut('dist/app.js') === 'generated' && leftOut('src/dist.ts') === null);
check('renamed paths', newPath('src/{a => b}/x.ts') === 'src/b/x.ts' && newPath('a.ts => b.ts') === 'b.ts');

fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(data, { recursive: true, force: true });
if (failed) { console.error(`survey: ${failed} of ${n} checks failed`); process.exit(1); }
console.log(`survey: ${n} checks pass`);
