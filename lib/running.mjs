// How the project runs, and the signals for its rules and questions (IMPORT-PLAN §1, §2): sections of the survey's
// digest, read from HEAD and the log, never from a live service.
//
// Only names come out: an env var's name, never what follows its `=`; a config's keys and the commands it runs,
// never a value; a secret found committed is reported by file, line and key name. Every read is one `git grep` per
// kind of pattern, or one `git cat-file --batch` for the few whole configs, so the pass costs about a second on a
// project of 3,000 files and runs beside blame (IMPORT-PLAN, Performance). Each section has a budget in characters
// and says what it left out.
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { ROOT } from './folder.mjs';
import { secretIn, denied } from './refs.mjs';

const PROSE = /\.(md|mdx|markdown|txt|rst|adoc|org)$/i;
const CODE = /\.(m?[jt]sx?|cjs|cts|mts|py|rb|go|rs|php|java|kt|swift|cs|ex|exs|sh|bash|zsh|svelte|vue|astro)$/i;

function run(args, max = 256 << 20) {
  return new Promise((res) => execFile('git', args, { cwd: ROOT, maxBuffer: max, encoding: 'utf8' }, (e, out) => res(e && e.code !== 1 ? '' : out ?? '')));
}
/** `git grep` at HEAD: [{ file, line, text }] (exit 1, no match, is an empty list) */
async function grep(pattern, specs = [], flags = []) {
  const out = await run(['grep', '-z', '-n', '-I', '-E', ...flags, '-e', pattern, 'HEAD', '--', ...specs]);
  const hits = [];
  for (const l of out.split('\n')) {
    const a = l.indexOf('\0'), b = l.indexOf('\0', a + 1); if (a < 0 || b < 0) continue;
    hits.push({ file: l.slice(0, a).replace(/^HEAD:/, ''), line: +l.slice(a + 1, b), text: l.slice(b + 1) });
  }
  return hits;
}
/** whole files at HEAD, through one `git cat-file --batch` (a missing one is left out) */
function blobs(paths, max = 512 << 10) {
  if (!paths.length) return Promise.resolve(new Map());
  return new Promise((res) => {
    const p = spawn('git', ['cat-file', '--batch'], { cwd: ROOT }), chunks = [];
    p.stdout.on('data', (c) => chunks.push(c));
    p.on('close', () => {
      const buf = Buffer.concat(chunks), m = new Map(); let at = 0;
      for (const f of paths) {
        const nl = buf.indexOf(0x0a, at); if (nl < 0) break;
        const head = buf.subarray(at, nl).toString('utf8'), s = /^[0-9a-f]+ blob (\d+)$/.exec(head);
        if (!s) { at = nl + 1; continue; }
        const size = +s[1]; if (size <= max) m.set(f, buf.subarray(nl + 1, nl + 1 + size).toString('utf8'));
        at = nl + 1 + size + 1;
      }
      res(m);
    });
    p.on('error', () => res(new Map()));
    p.stdin.end(paths.map(f => 'HEAD:' + f).join('\n') + '\n');
  });
}

// ---- budgets --------------------------------------------------------------------------------------------------
export const BUDGET = { env: 3000, deploy: 3500, data: 1000, services: 2000, tooling: 1800, logins: 500, together: 1000, security: 1200, open: 1000 };
/** lines kept within `max` characters; what is cut is said */
export function fit(lines, max) {
  const out = []; let n = 0;
  for (let i = 0; i < lines.length; i++) {
    if (n + lines[i].length + 1 > max && out.length) { out.push(`- (${lines.length - i} more lines left out for length)`); break; }
    out.push(lines[i]); n += lines[i].length + 1;
  }
  return out;
}
const list = (xs, cap, more = (k) => `, and ${k} more`) => xs.slice(0, cap).join(', ') + (xs.length > cap ? more(xs.length - cap) : '');
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const short = (s) => s.slice(0, 9);

// ---- env names ------------------------------------------------------------------------------------------------
const ENV_READ = String.raw`process\.env|import\.meta\.env|os\.environ|os\.getenv|Deno\.env|ENV\[|getenv\(|env\(['"]`;
const ENV_NAME = /[A-Z][A-Z0-9_]{1,}/;
const ENV_FORMS = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/g, /process\.env\[\s*['"`]([A-Z_][A-Z0-9_]*)['"`]\s*\]/g, /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g,
  /os\.environ(?:\.get)?\(?\[?\s*['"]([A-Z_][A-Z0-9_]*)['"]/g, /os\.getenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g, /Deno\.env\.get\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /\bENV\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g, /\bgetenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g, /\benv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
];
/** the names a line of code reads from the environment, in every form survey knows */
export function envNamesIn(text) {
  const out = new Set();
  for (const re of ENV_FORMS) for (const m of text.matchAll(re)) out.add(m[1]);
  // const { A, B: b } = process.env (on one line)
  const d = /\{([^}]*)\}\s*=\s*(?:process\.env|import\.meta\.env)\b/.exec(text);
  if (d) for (const part of d[1].split(',')) { const k = part.trim().split(/[:=\s]/)[0]; if (ENV_NAME.test(k) && k === k.toUpperCase()) out.add(k); }
  // the shell's own, read everywhere and set by no one
  return [...out].filter(n => n.length >= 2 && !/^(NODE_ENV|CI|PWD|HOME|PATH|TZ|USER|SHELL|LANG|TERM)$/.test(n));
}
const EXAMPLE_ENV = /(^|\/)(\.env(\.[\w-]+)?\.(example|sample|template|dist|defaults)|\.env\.(example|sample|template)|example\.env|env\.example)$/i;
/** the names an example env file sets: what is before `=`, never what follows */
export function exampleNames(text) {
  const out = [];
  for (const l of text.split('\n')) { const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l); if (m) out.push(m[1]); }
  return out;
}
const prefixOf = (n) => { const b = n.replace(/^(NEXT_PUBLIC_|VITE_|PUBLIC_|REACT_APP_|EXPO_PUBLIC_|NUXT_PUBLIC_)/, ''); const i = b.indexOf('_'); return i > 0 ? b.slice(0, i + 1) : b; };

// ---- committed secrets ------------------------------------------------------------------------------------------
// A literal value where a key belongs, in any tracked text file (the protected ones included: a tracked .env is
// itself the finding). The match is held only long enough to be classified; the report is file, line and name.
// Two searches, not one: a single alternation with a leading name class costs 2.3 s on 3,000 files, these 0.8 s.
const COMMITTED_PREFIX = String.raw`(sk|pk|rk)_(live|test)_[A-Za-z0-9]{10}|whsec_[A-Za-z0-9+/=]{16}|re_[A-Za-z0-9_]{20}|sk-(ant|proj)-[A-Za-z0-9_-]{16}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20}|xox[abprs]-[A-Za-z0-9-]{10}|-----BEGIN [A-Z ]*PRIVATE KEY`;
const COMMITTED_NAMED = String.raw`(key|token|secret|password)["']?[[:space:]]*[:=][[:space:]]*["'][A-Za-z0-9_+/=.-]{16}`;
const KEYNAME = /["']?((?:[A-Za-z0-9_-]{0,80}(?:secret|password|passwd)|[A-Za-z][A-Za-z0-9_-]{0,80}(?:key|token))[A-Za-z0-9_-]{0,80})["']?\s*[:=]\s*["']([^"']{16,200})["']/i;
const DATAFILE = /\.(json|jsonl|ndjson|csv|tsv|xml|geojson|html?|txt|log)$/i;
const PREFIXED = /(sk|pk|rk)_live_|whsec_|sk-(ant|proj)-|AKIA[0-9A-Z]{16}|gh[pousr]_|xox[abprs]-|BEGIN [A-Z ]*PRIVATE KEY/;
/** what a line that matched COMMITTED holds: the key's name or its kind, or null for a look-alike */
export function committedIn(text) {
  const m = KEYNAME.exec(text);
  // a reference, a placeholder or a name is not a value
  if (m && !/^\$|\$\{|\{\{|process\.env|env\(|<|your[_-]|xxx|placeholder|example|changeme|^[A-Z0-9_]+$|^[a-z]+([_-][a-z]+)*$/i.test(m[2]) && /\d/.test(m[2]) && /[A-Za-z]/.test(m[2])) return m[1];
  const k = secretIn(text);
  return k ?? (/-----BEGIN [A-Z ]*PRIVATE KEY/.test(text) ? 'a private key' : null);
}

// ---- services -------------------------------------------------------------------------------------------------
// [name, packages (prefix match), env prefixes, hosts]: a short list of what projects commonly call; whatever it
// misses still shows, as env prefixes and hosts with no known vendor
const VENDORS = [
  ['Stripe', ['stripe', '@stripe/'], ['STRIPE_'], ['stripe.com']], ['Creem', ['creem'], ['CREEM_'], ['creem.io']],
  ['Dodo Payments', ['dodopayments'], ['DODO_'], ['dodopayments.com']], ['Polar', ['@polar-sh/'], ['POLAR_'], ['polar.sh']],
  ['Paddle', ['@paddle/'], ['PADDLE_'], ['paddle.com']], ['Lemon Squeezy', ['@lemonsqueezy/'], ['LEMONSQUEEZY_', 'LEMON_'], ['lemonsqueezy.com']],
  ['Resend', ['resend'], ['RESEND_'], ['resend.com']], ['SendGrid', ['@sendgrid/'], ['SENDGRID_'], ['sendgrid.com']],
  ['Postmark', ['postmark'], ['POSTMARK_'], ['postmarkapp.com']], ['Mailgun', ['mailgun'], ['MAILGUN_'], ['mailgun.net']],
  ['Twilio', ['twilio'], ['TWILIO_'], ['twilio.com']], ['Anthropic', ['@anthropic-ai/'], ['ANTHROPIC_', 'CLAUDE_'], ['anthropic.com']],
  ['OpenAI', ['openai', '@ai-sdk/openai'], ['OPENAI_'], ['openai.com']], ['Google AI', ['@google/genai', '@google/generative-ai', '@ai-sdk/google'], ['GEMINI_', 'GOOGLE_AI_', 'GOOGLE_GENERATIVE_'], ['generativelanguage.googleapis.com']],
  ['DeepSeek', ['@ai-sdk/deepseek'], ['DEEPSEEK_'], ['deepseek.com']], ['Mistral', ['@mistralai/'], ['MISTRAL_'], ['mistral.ai']],
  ['Vercel', ['@vercel/', 'vercel'], ['VERCEL_'], ['vercel.com', 'vercel.app']], ['Neon', ['@neondatabase/'], ['NEON_'], ['neon.tech']],
  ['Supabase', ['@supabase/'], ['SUPABASE_'], ['supabase.co']], ['Upstash', ['@upstash/'], ['UPSTASH_', 'KV_'], ['upstash.io']],
  ['Sentry', ['@sentry/'], ['SENTRY_'], ['sentry.io']], ['PostHog', ['posthog-js', 'posthog-node'], ['POSTHOG_'], ['posthog.com']],
  ['Browserless', ['browserless'], ['BROWSERLESS_'], ['browserless.io']], ['AWS', ['@aws-sdk/', 'aws-sdk'], ['AWS_', 'S3_'], ['amazonaws.com']],
  ['Google Cloud', ['googleapis', '@google-cloud/'], ['GOOGLE_', 'GCP_', 'GMAIL_'], ['googleapis.com']], ['Cloudflare', ['@cloudflare/'], ['CLOUDFLARE_', 'CF_', 'R2_'], ['cloudflare.com']],
  ['Clerk', ['@clerk/'], ['CLERK_'], ['clerk.com']], ['Auth0', ['@auth0/'], ['AUTH0_'], ['auth0.com']],
  ['Auth.js', ['next-auth', '@auth/'], ['NEXTAUTH_', 'AUTH_'], []], ['GitHub', ['@octokit/', 'octokit'], ['GITHUB_', 'GH_'], ['api.github.com']],
  ['Slack', ['@slack/'], ['SLACK_'], ['slack.com']], ['Render', [], ['RENDER_'], ['render.com', 'onrender.com']],
  ['Fly.io', [], ['FLY_'], ['fly.io', 'fly.dev']], ['Inngest', ['inngest'], ['INNGEST_'], ['inngest.com']],
  ['Trigger.dev', ['@trigger.dev/'], ['TRIGGER_'], ['trigger.dev']], ['Algolia', ['algoliasearch'], ['ALGOLIA_'], ['algolia.net']],
  ['Mapbox', ['mapbox-gl', '@mapbox/'], ['MAPBOX_'], ['mapbox.com']], ['Pusher', ['pusher', 'pusher-js'], ['PUSHER_'], ['pusher.com']],
];
const NOISE_HOST = /(^|\.)(w3\.org|schema\.org|example\.(com|org|net)|localhost|127\.0\.0\.1|0\.0\.0\.0|json-schema\.org|xmlns\.com|purl\.org|github\.com|githubusercontent\.com|npmjs\.(com|org)|unpkg\.com|jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|mozilla\.org|wikipedia\.org|ogp\.me)$/i;

// ---- tooling and deploy -----------------------------------------------------------------------------------------
const DEPLOY = /(^|\/)(vercel\.json|vercel\.ts|now\.json|render\.ya?ml|fly\.toml|netlify\.toml|railway\.(json|toml)|app\.json|Procfile|Dockerfile[\w.-]*|docker-compose[\w.-]*\.ya?ml|compose\.ya?ml|wrangler\.(toml|jsonc?)|serverless\.ya?ml|amplify\.yml|firebase\.json|cloudbuild\.ya?ml)$/;
const WORKFLOW = /^\.(github\/workflows|gitlab-ci|circleci)\/.*\.ya?ml$|^\.gitlab-ci\.yml$|^bitbucket-pipelines\.yml$/;
const OPS_SCRIPT = /(^|\/)(scripts?|bin|ops|deploy)\/[^/]*(deploy|release|cleanup|reset|migrate|rollback|backup|restore|seed|sync|provision|bootstrap)[^/]*\.(sh|bash|zsh|m?[jt]s|py|rb)$/i;
const TOOLS = /^(vercel|prisma|drizzle-kit|knex|alembic|rails|npx|npm|pnpm|yarn|bun|node|tsx|ts-node|git|psql|pg_dump|pg_restore|neonctl|supabase|curl|docker|flyctl|fly|wrangler|netlify|railway|heroku|gh|aws|gcloud|terraform|make|python3?|ruby|bundle)$/;
/** the commands a script or a build line runs: each command's first words, nothing after a value */
export function commandsIn(text) {
  const out = new Set();
  for (const raw of text.split(/\n|&&|\|\||;|\|/)) {
    const l = raw.replace(/#.*$/, '').trim(); if (!l) continue;
    const words = l.split(/\s+/).filter(w => !/^[A-Z_][A-Z0-9_]*=/.test(w));   // an env assignment before the command
    if (!words.length || !TOOLS.test(words[0])) continue;
    const kept = [];
    for (const w of words) { if (kept.length >= 4 || /[=$'"`{}<>()]/.test(w) || w.length > 40) break; kept.push(w); }
    out.add(kept.join(' '));
  }
  return [...out];
}
/** the comment that opens a script or a workflow: prose about why it is as it is, scrubbed and guarded */
export function headerComment(text, scrub, max = 500) {
  const lines = [];
  for (const l of text.split('\n')) {
    if (/^#!/.test(l)) continue;
    const m = /^\s*(?:#|\/\/|--)\s?(.*)$/.exec(l);
    if (!m) { if (lines.length || l.trim()) break; continue; }
    if (/^-?\s*(eslint|@ts-|prettier|shellcheck)/.test(m[1])) continue;
    lines.push(m[1]);
  }
  let t = lines.join(' ').replace(/\s+/g, ' ').trim(); if (!t) return null;
  if (secretIn(t)) return '(its opening comment is left out: it holds what looks like a key)';
  t = scrub(t);
  return t.length > max ? t.slice(0, max).replace(/\s+\S*$/, '') + ' …' : t;
}
/** a workflow's triggers, schedules, the scripts it runs and the secrets it names (names only) */
function workflowOf(text) {
  const on = [];
  for (const m of text.matchAll(/cron:\s*['"]([^'"]+)['"]/g)) on.push(`schedule ${m[1]}`);
  for (const k of ['push', 'pull_request', 'workflow_dispatch', 'release', 'workflow_run', 'repository_dispatch']) if (new RegExp(`^\\s*${k}:|on:\\s*\\[?[^\\n]*\\b${k}\\b`, 'm').test(text)) on.push(k);
  const runs = [];
  for (const m of text.matchAll(/^\s*(?:-\s*)?run:\s*(.+)$/gm)) runs.push(...commandsIn(m[1]));
  const secrets = [...new Set([...text.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]))].filter(s => s !== 'GITHUB_TOKEN');
  const branches = [...text.matchAll(/branches:\s*\[([^\]]+)\]/g)].map(m => m[1].replace(/['"\s]/g, ''));
  return { on: [...new Set(on)], runs: [...new Set(runs)], secrets, branches };
}
function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text); if (!m) return {};
  const o = {}; for (const l of m[1].split('\n')) { const k = /^(\w[\w-]*):\s*(.*)$/.exec(l); if (k) o[k[1]] = k[2].replace(/^['"]|['"]$/g, ''); }
  return o;
}

/**
 * Running the project: env names, deploy and schedules, data, services, tooling, test logins, and the cross-checks.
 * Returns the digest's lines, the alarms for its top (committed secrets), and a snapshot of each kept sheet's
 * inputs, so a later survey --since can say which moved.
 */
export async function runningProject({ files, scrub }) {
  const t0 = Date.now();
  const own = new Set(files);
  const tracked = (await run(['ls-tree', '-r', '--name-only', '-z', 'HEAD'])).split('\0').filter(Boolean);
  const code = new Set(files.filter(f => CODE.test(f)));
  const NOLOCK = [':(exclude)*.lock', ':(exclude)*lock.json', ':(exclude)*lock.yaml'];
  const [envHits, schemaHits, prefixHits, namedHits, urlHits, importHits] = await Promise.all([
    grep(ENV_READ),
    grep(String.raw`^\s+[A-Z][A-Z0-9_]{2,}:\s*z\.`),
    grep(COMMITTED_PREFIX, NOLOCK),
    grep(COMMITTED_NAMED, NOLOCK, ['-i']),
    grep(String.raw`https?://[A-Za-z0-9.-]+\.[a-z]{2,}`, [], ['-o']),
    grep(String.raw`(from|require\(|import\()\s*['"][@a-z0-9][^'"]*['"]`, [], ['-o']),
  ]);

  // env names read in code
  const reads = new Map();
  for (const h of envHits) { if (!own.has(h.file) || PROSE.test(h.file)) continue; for (const n of envNamesIn(h.text)) { if (!reads.has(n)) reads.set(n, new Set()); reads.get(n).add(h.file); } }
  for (const h of schemaHits) { if (!own.has(h.file) || !/env/i.test(h.file)) continue; const n = /([A-Z][A-Z0-9_]{2,}):/.exec(h.text)?.[1]; if (n) { if (!reads.has(n)) reads.set(n, new Set()); reads.get(n).add(h.file); } }

  // whole files: example env files, deploy configs, workflows, ops scripts, manifests, tooling
  const examples = tracked.filter(f => EXAMPLE_ENV.test(f));
  const deploys = tracked.filter(f => DEPLOY.test(f) && !denied(f));
  const workflows = tracked.filter(f => WORKFLOW.test(f));
  const rank = (f) => (/deploy|release|rollback/i.test(f) ? 0 : /\.(sh|bash|zsh)$/.test(f) ? 1 : 2);
  const scripts = files.filter(f => OPS_SCRIPT.test(f)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, 40);
  const manifests = tracked.filter(f => /(^|\/)package\.json$/.test(f) && !/node_modules\//.test(f)).slice(0, 12);
  const reqs = tracked.filter(f => /(^|\/)(requirements[\w-]*\.txt|pyproject\.toml|Gemfile|go\.mod|Cargo\.toml)$/.test(f)).slice(0, 8);
  const skills = tracked.filter(f => /^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(f) || /^\.claude\/commands\/.+\.md$/.test(f) || /^\.claude\/agents\/.+\.md$/.test(f));
  const agentCfg = tracked.filter(f => /^(\.mcp\.json|opencode\.jsonc?|\.claude\/settings\.json|\.cursor\/mcp\.json|\.vscode\/mcp\.json|AGENTS\.md|CLAUDE\.md|GEMINI\.md|\.codex\/config\.toml)$/.test(f));
  const seeds = files.filter(f => /(^|\/)(seeds?|fixtures?|factories)(\/|\.|[-_])|(^|\/)seed[\w-]*\.(m?[jt]s|py|rb|sql)$/i.test(f) && CODE.test(f)).slice(0, 40);
  const B = await blobs([...new Set([...examples, ...deploys, ...workflows, ...scripts, ...manifests, ...reqs, ...skills, ...agentCfg, ...seeds])]);

  const listed = new Map();
  for (const f of examples) for (const n of exampleNames(B.get(f) ?? '')) { if (!listed.has(n)) listed.set(n, new Set()); listed.get(n).add(f); }

  // ---- committed secrets: file, line, name; never the value
  // prose and data files (records, exports, logs) only by a key's known prefix: their fields named "key" are data
  const byFile = new Map();
  const seen = new Set();
  for (const h of [...prefixHits, ...namedHits]) {
    if (seen.has(h.file + ':' + h.line)) continue; seen.add(h.file + ':' + h.line);
    if ((PROSE.test(h.file) || DATAFILE.test(h.file)) && !/\.env/.test(h.file) && !/(^|\/)[^/]*(config|settings|secrets?|credentials|opencode|mcp)[^/]*\.json$/i.test(h.file) && !PREFIXED.test(h.text)) continue;
    const what = committedIn(h.text); if (!what) continue;
    if (!byFile.has(h.file)) byFile.set(h.file, []);
    byFile.get(h.file).push({ line: h.line, what: /^[A-Za-z0-9_-]+$/.test(what) ? `\`${what}\`` : what });
  }
  const alarms = [...byFile].map(([f, hs]) => `${f}: ${hs.length === 1 ? `line ${hs[0].line}` : `${hs.length} lines (${hs.slice(0, 5).map(h => h.line).join(', ')}${hs.length > 5 ? ', …' : ''})`}, ${[...new Set(hs.map(h => h.what))].slice(0, 4).join(', ')}`);

  const L = [], snap = { infra: [], creds: [], work: [] };
  L.push('## Running the project', '', 'Read from HEAD: names, triggers and commands only, never a value. What only a live service or a person knows (what each environment actually sets, a restore window, who holds a login) is for the writer to answer.', '');

  // ---- env
  {
    const E = [];
    const names = [...reads.keys()].sort();
    const byPre = new Map(); for (const n of names) { const p = prefixOf(n); if (!byPre.has(p)) byPre.set(p, []); byPre.get(p).push(n); }
    E.push('### Environment names', '', `${names.length} names read in code${examples.length ? `; ${listed.size} listed in ${examples.join(', ')}` : '; no example env file is tracked'}.`, '');
    // a credential's name first within its group, and groups holding credentials first: those are what a new
    // setup cannot do without (survey can say which files read a name: git grep it)
    const cred = (n) => /KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|DSN|DATABASE_URL|_URL$|CLIENT_ID/.test(n);
    const groups = [...byPre].map(([p, ns]) => [p, ns.sort((a, b) => cred(b) - cred(a) || a.localeCompare(b))]);
    groups.sort((a, b) => b[1].filter(cred).length - a[1].filter(cred).length || b[1].length - a[1].length);
    const small = groups.filter(([, ns]) => ns.length < 3).flatMap(([, ns]) => ns).sort((a, b) => cred(b) - cred(a) || a.localeCompare(b));
    for (const [p, ns] of groups) if (ns.length >= 3) E.push(`- ${p} (${ns.length}): ${list(ns, 16)}`);
    if (small.length) E.push(`- In groups of one or two (${small.length}): ${list(small, 60)}`);
    if (examples.length) {
      const unlisted = names.filter(n => !listed.has(n)), unread = [...listed.keys()].filter(n => !reads.has(n));
      E.push('', `Read in code but in no example file (a new setup would miss them): ${unlisted.length ? list(unlisted, 40) : 'none'}.`);
      E.push(`In an example file but read nowhere in code (gone, or read by a tool): ${unread.length ? list(unread, 30) : 'none'}.`);
    }
    E.push('');
    L.push(...fit(E, BUDGET.env));
    snap.creds.push(...names.map(n => 'env ' + n));
  }

  // ---- deploy and schedules
  {
    const D = ['### Deploy and schedules', ''];
    const ciSecrets = new Set();
    for (const f of deploys) {
      const t = B.get(f) ?? ''; let line = `- ${f}`;
      if (/\.json$/.test(f)) {
        try {
          const j = JSON.parse(t);
          line += `: sets ${Object.keys(j).join(', ')}`;
          if (Array.isArray(j.crons)) line += `; ${j.crons.length} crons: ${list(j.crons.map(c => `${String(c.path).split('?')[0]} (${c.schedule})`), 30)}`;
          if (j.git?.deploymentEnabled !== undefined) line += `; git deployments: ${JSON.stringify(j.git.deploymentEnabled)}`;
          for (const k of ['buildCommand', 'installCommand']) if (j[k]) line += `; ${k} runs ${commandsIn(j[k]).join(', ') || '(no known tool)'}`;
        } catch { line += ' (not readable as JSON)'; }
      } else {
        const svc = [...t.matchAll(/^\s*-?\s*name:\s*([\w.-]+)/gm)].map(m => m[1]), types = [...t.matchAll(/^\s*-?\s*type:\s*([\w.-]+)/gm)].map(m => m[1]);
        if (svc.length) line += `: names ${list([...new Set(svc)], 10)}${types.length ? ` (types ${[...new Set(types)].join(', ')})` : ''}`;
        const cmds = [...t.matchAll(/(?:buildCommand|startCommand|preDeployCommand|command|release|CMD|RUN|web|worker):\s*(.+)$/gm)].flatMap(m => commandsIn(m[1]));
        if (cmds.length) line += `; runs ${list([...new Set(cmds)], 10)}`;
      }
      D.push(line); snap.infra.push(line);
    }
    for (const f of workflows) {
      const w = workflowOf(B.get(f) ?? '');
      for (const s of w.secrets) ciSecrets.add(s);
      const line = `- ${f}: on ${w.on.join(', ') || '(no trigger found)'}${w.branches.length ? ` (branches ${w.branches.join('; ')})` : ''}; runs ${list(w.runs, 8) || 'nothing survey knows'}${w.secrets.length ? `; secrets named: ${list(w.secrets, 12)}` : ''}`;
      D.push(line); snap.infra.push(line.replace(/; secrets named.*/, ''));
      const c = headerComment(B.get(f) ?? '', scrub); if (c) D.push(`  > ${c}`);
    }
    const quiet = [];
    for (const f of scripts) {
      const t = B.get(f) ?? '', cmds = commandsIn(t), c = headerComment(t, scrub);
      const notes = `${/vercel\b[^\n]*--prod/.test(t) ? '; deploys to production with the Vercel CLI' : ''}${/git\s+(status|diff)\s+--porcelain/.test(t) ? '; checks for uncommitted changes' : ''}`;
      if (!cmds.length && !notes && !c) { quiet.push(f); continue; }
      const line = `- ${f}: ${cmds.length ? `runs ${list(cmds, 8)}` : 'a script'}${notes}`;
      D.push(line); snap.infra.push(line);
      if (c) D.push(`  > ${c}`);
    }
    if (quiet.length) { D.push(`- Other scripts by name: ${list(quiet, 20)}`); snap.infra.push(...quiet.map(f => 'script ' + f)); }
    for (const f of manifests) {
      let j; try { j = JSON.parse(B.get(f) ?? ''); } catch { continue; }
      const s = Object.entries(j.scripts ?? {}).filter(([k]) => /deploy|release|migrat|seed|reset|db|build|start|postinstall|vercel|prisma|test|lint|typecheck|e2e/i.test(k));
      if (s.length) { const line = `- ${f} scripts: ${list(s.map(([k, v]) => `${k} (${commandsIn(String(v)).join(', ') || '…'})`), 16)}`; D.push(line); snap.work.push(...s.map(([k]) => 'script ' + k)); }
    }
    if (ciSecrets.size) { const only = [...ciSecrets].filter(s => !reads.has(s)); if (only.length) D.push('', `Named in CI only, not read by the code under that name: ${list(only, 20)}.`); }
    if (D.length === 2) D.push('No deploy config, workflow or deploy script is tracked: this project may not be deployed.');
    D.push('');
    L.push(...fit(D, BUDGET.deploy));
  }
  return { lines: L, alarms, snap, B, reads, tracked, code, urlHits, importHits, seeds, skills, agentCfg, manifests, reqs, ms: Date.now() - t0, t0 };
}

/** the rest of Running (data, services, tooling, logins), and the signals, once the log is read */
export async function runningRest(R, { commits, area, scrub, bodies }) {
  const L = [];
  const { B, reads } = R;
  // ---- data: migrations
  {
    const M = ['### Data', ''];
    const dirs = new Map();
    for (const f of R.tracked) { const m = /^((?:.*\/)?(?:migrations|alembic\/versions|db\/migrate))\/([^/]+)/.exec(f); if (m && !/node_modules\//.test(f)) { if (!dirs.has(m[1])) dirs.set(m[1], new Set()); dirs.get(m[1]).add(m[2]); } }
    const touched = new Map();      // a migration file: the commits that touched it, oldest first
    for (const c of [...commits].reverse()) for (const f of Object.keys(c.files)) if ([...dirs.keys()].some(d => f.startsWith(d + '/'))) { if (!touched.has(f)) touched.set(f, []); touched.get(f).push(c); }
    for (const [d, set] of dirs) {
      const names = [...set].filter(n => !/^(migration_lock\.toml|README|\.)/i.test(n)).sort();
      if (!names.length) continue;
      M.push(`- ${d}: ${names.length} migrations, the first ${names[0]}, the last ${names[names.length - 1]}`);
      R.snap.infra.push(`migrations ${d} ${names.length} ${names[names.length - 1]}`);
    }
    // edited a day or more after it was added: by then it may have been applied somewhere
    const edited = [...touched].map(([f, cs]) => [f, [cs[0], ...cs.slice(1).filter(c => c.at - cs[0].at >= 86400000)]]).filter(([, cs]) => cs.length > 1).map(([f, cs]) => `${f.replace(/\/migration\.sql$/, '')} (added ${day(cs[0].at)}; edited in ${cs.slice(1, 3).map(c => short(c.sha)).join(', ')}${cs.length > 3 ? ', …' : ''})`);
    if (edited.length) M.push(`- ${edited.length} edited after they were added (one already applied somewhere is not run again): ${list(edited, 4)}`);
    const push = commits.filter(c => /\bdb push\b|migrate resolve/i.test(c.subject + '\n' + (bodies.get(c.sha) ?? '')));
    if (push.length) M.push(`- Commits that mention db push or migrate resolve: ${list(push.map(c => `${short(c.sha)} ${day(c.at)}`), 8)}`);
    if (M.length > 2) { M.push(''); L.push(...fit(M, BUDGET.data)); }
  }

  // ---- services
  {
    const S = ['### Services', ''];
    const deps = new Map();       // package → the manifests naming it
    for (const f of R.manifests) { let j; try { j = JSON.parse(B.get(f) ?? ''); } catch { continue; } for (const k of Object.keys({ ...j.dependencies, ...j.devDependencies, ...j.optionalDependencies })) { if (!deps.has(k)) deps.set(k, f); } }
    for (const f of R.reqs) for (const l of (B.get(f) ?? '').split('\n')) { const m = /^\s*([A-Za-z0-9][\w.-]*)/.exec(l); if (m && !/^\[|^#/.test(l)) deps.set(m[1].toLowerCase(), f); }
    const importsBy = new Map();  // package → code files importing it
    for (const h of R.importHits) { if (!R.code.has(h.file)) continue; const m = /['"]([^'"]+)['"]/.exec(h.text); if (!m) continue; const p = m[1].startsWith('@') ? m[1].split('/').slice(0, 2).join('/') : m[1].split('/')[0]; if (!importsBy.has(p)) importsBy.set(p, new Set()); importsBy.get(p).add(h.file); }
    const hosts = new Map();      // host → code files naming it
    for (const h of R.urlHits) { if (PROSE.test(h.file) || !R.code.has(h.file)) continue; const host = h.text.replace(/^https?:\/\//, '').toLowerCase(); if (NOISE_HOST.test(host)) continue; if (!hosts.has(host)) hosts.set(host, new Set()); hosts.get(host).add(h.file); }
    const envNames = [...reads.keys()], used = new Set(), claimedPre = new Set(), claimedHost = new Set();
    const tooling = Object.fromEntries(R.agentCfg.map(f => [f, B.get(f) ?? '']));
    const rows = [];
    for (const [name, pkgs, pres, hs] of VENDORS) {
      const dep = [...deps.keys()].filter(d => pkgs.some(p => p.endsWith('/') ? d.startsWith(p) : d === p));
      const env = envNames.filter(n => pres.some(p => prefixOf(n) === p || n.startsWith(p)));
      const host = [...hosts.keys()].filter(h => hs.some(x => h === x || h.endsWith('.' + x)));
      const files = new Set(); for (const d of dep) for (const f of importsBy.get(d) ?? []) files.add(f); for (const h of host) for (const f of hosts.get(h)) files.add(f);
      for (const n of env) for (const f of reads.get(n)) files.add(f);
      const tool = Object.entries(tooling).filter(([f, t]) => !/\.md$/.test(f) && new RegExp(`\\b${name.split(/[ .]/)[0]}`, 'i').test(t)).map(([f]) => f);
      if (!dep.length && !env.length && !host.length && !tool.length) continue;
      env.forEach(n => claimedPre.add(prefixOf(n))); host.forEach(h => claimedHost.add(h)); dep.forEach(d => used.add(d));
      const inCode = dep.some(d => importsBy.has(d)) || host.length > 0 || env.length > 0;
      rows.push({ name, inCode, line: `- ${name}: ${[dep.length && `package ${list(dep, 3)}`, env.length && `env ${list(env, 4)}`, host.length && `hosts ${list(host, 2)}`, tool.length && `in ${tool.join(', ')}`].filter(Boolean).join('; ')}${files.size ? `; ${files.size} file${files.size === 1 ? '' : 's'} (${[...files][0]}${files.size > 1 ? ', …' : ''})` : ''}${inCode ? '' : ' (not called from code)'}` });
    }
    S.push(...rows.filter(r => r.inCode).map(r => r.line), ...rows.filter(r => !r.inCode).map(r => r.line));
    R.snap.creds.push(...rows.map(r => 'vendor ' + r.name));
    const pre = new Map(); for (const n of envNames) { const p = prefixOf(n); if (!claimedPre.has(p) && p.endsWith('_')) pre.set(p, (pre.get(p) ?? 0) + 1); }
    const odd = [...pre].filter(([, k]) => k >= 2).sort((a, b) => b[1] - a[1]);
    if (odd.length) S.push(`- Env prefixes no vendor above claims (services survey does not know, or the project's own settings): ${list(odd.map(([p, k]) => `${p} (${k})`), 15)}`);
    const other = [...hosts].filter(([h]) => !claimedHost.has(h)).sort((a, b) => b[1].size - a[1].size);
    if (other.length) S.push(`- Other hosts in code: ${list(other.map(([h, fs]) => `${h} (${fs.size})`), 15)}`);
    S.push('');
    L.push(...fit(S, BUDGET.services));
  }

  // ---- tooling
  {
    const T = ['### Tooling', ''];
    for (const f of R.skills) {
      const fm = frontmatter(B.get(f) ?? ''), name = fm.name || path.basename(f === 'SKILL.md' ? f : f.replace(/\/SKILL\.md$/, ''), '.md');
      const d = fm.description ? scrub(fm.description).slice(0, 160) : '';
      T.push(`- ${f.startsWith('.claude/commands') ? 'command /' : f.startsWith('.claude/agents') ? 'agent ' : 'skill '}${name}${d ? `: ${d}` : ''}`);
      R.snap.work.push('skill ' + name);
    }
    for (const f of R.agentCfg) {
      const t = B.get(f) ?? '';
      if (/\.md$/.test(f)) { const hs = [...t.matchAll(/^#{1,2} (.+)$/gm)].map(m => m[1]); T.push(`- ${f}: ${t.split('\n').length} lines${hs.length ? `; headings ${list(hs, 8)}` : ''}`); continue; }
      let j = null; try { j = JSON.parse(t.replace(/^\s*\/\/.*$/gm, '')); } catch {}
      if (!j) { T.push(`- ${f}`); continue; }
      const servers = Object.keys(j.mcpServers ?? j.mcp ?? j.servers ?? {});
      const parts = [`keys ${Object.keys(j).join(', ')}`];
      if (servers.length) parts.push(`MCP servers ${servers.join(', ')}`);
      if (j.hooks) parts.push(`hooks on ${Object.keys(j.hooks).join(', ')}`);
      if (j.env) parts.push(`sets env ${Object.keys(j.env).join(', ')}`);
      T.push(`- ${f}: ${parts.join('; ')}`);
      R.snap.work.push(`tool ${f} ${servers.join(',')}`);
    }
    if (T.length > 2) { T.push(''); L.push(...fit(T, BUDGET.tooling)); }
  }

  // ---- test logins
  {
    const G = [];
    for (const f of R.seeds) {
      const t = B.get(f) ?? ''; if (!/email/i.test(t) || !/(role|password|user)/i.test(t)) continue;
      const roles = [...new Set([...t.matchAll(/\brole\s*:\s*(?:['"]([A-Za-z_]+)['"]|(?:[A-Z]\w*Role|Role)\.([A-Za-z_]+))/g)].map(m => m[1] ?? m[2]))];
      const n = (t.match(/\bemail\s*:/g) ?? []).length;
      G.push(`- ${f}: ${n} user${n === 1 ? '' : 's'} by email${roles.length ? `; roles ${list(roles, 8)}` : ''}${/password/i.test(t) ? '; sets a password (not shown)' : ''}`);
    }
    if (G.length) L.push(...fit(['### Test logins', '', 'Where seeded users come from (the logins themselves are for the writer to say where they are kept):', '', ...G, ''], BUDGET.logins));
  }

  // ---- signals
  L.push('## Signals for rules and questions', '');
  {
    // change together: pairs in one commit at least 80% of the time over at least 5, sweeps of over 30 files left out
    const n = new Map(), pair = new Map();
    for (const c of commits) {
      const fs = Object.keys(c.files).filter(f => !PROSE.test(f));
      for (const f of fs) n.set(f, (n.get(f) ?? 0) + 1);
      if (fs.length > 30 || c.parents.length > 1) continue;
      fs.sort();
      for (let i = 0; i < fs.length; i++) for (let j = i + 1; j < fs.length; j++) { const k = fs[i] + '\0' + fs[j]; pair.set(k, (pair.get(k) ?? 0) + 1); }
    }
    const hits = [];
    for (const [k, c] of pair) {
      if (c < 5) continue;
      const [a, b] = k.split('\0'), r = c / Math.min(n.get(a), n.get(b));
      // a test and the file it tests change together by design
      const stem = (f) => path.posix.basename(f).replace(/\.(test|spec)(?=\.)/, '').replace(/\.[^.]+$/, '');
      if (r >= 0.8 && !(stem(a) === stem(b) && /\.(test|spec)\.|__tests__\//.test(a + b))) hits.push({ a, b, c, r, across: area(a) !== area(b) });
    }
    hits.sort((x, y) => (y.across - x.across) || (y.c - x.c));
    const C = ['### Change together', '', `${hits.length} pairs of files changed in the same commit at least 80% of the time, over at least 5 commits (sweeps of over 30 files left out). Across threads first: candidates for "when you change X, change Y".`, ''];
    for (const h of hits.slice(0, 12)) C.push(`- ${h.a} and ${h.b}: ${h.c} commits together (${Math.round(h.r * 100)}%)${h.across ? '' : ', same thread'}`);
    if (hits.length > 12) C.push(`- and ${hits.length - 12} more`);
    C.push('');
    L.push(...fit(C, BUDGET.together));
  }
  {
    // scored by how plainly the subject names security (a feature that merely touches auth is not a fix)
    const STRONG = [/\bsecurity\b/i, /vulnerab/i, /\bcve-\d+/i, /\b(xss|csrf|ssrf|idor)\b/i, /injection/i, /\bleak/i, /\bharden/i, /signature|hmac/i, /\bcsp\b|content[- ]security/i, /rate[- ]?limit/i, /privilege|escalat/i, /sanitiz|escap(e|ing) (html|input)/i, /webhook secret|signing secret/i, /\btenant ?id\b|cross[- ]tenant|tenant[- ](scop|isolat|leak)/i, /\bscope[sd]? \w+( \w+)? by\b/i];
    const WEAK = /\b(auth\w*|oauth|secrets?|permissions?|encrypt\w*|tokens?|access control)\b/i;
    const scored = [];
    for (const c of commits) {
      if (c.parents.length > 1) continue;
      const body = bodies.get(c.sha) ?? '';
      const strong = STRONG.filter(re => re.test(c.subject)).length, weak = WEAK.test(c.subject) ? 1 : 0, inBody = Math.min(2, STRONG.filter(re => re.test(body)).length);
      const score = strong * 3 + weak + inBody;
      if (score >= 3) scored.push({ c, score });
    }
    scored.sort((a, b) => b.score - a.score || b.c.at - a.c.at);
    const S = ['### Security', '', `${scored.length} commits name security plainly in their subject, or in passing with more in the body; the plainest first:`, ''];
    for (const { c } of scored.slice(0, 12)) S.push(`- ${short(c.sha)} ${day(c.at)} ${scrub(c.subject).slice(0, 140)} (${c.alive} lines survive)`);
    if (scored.length > 12) S.push(`- and ${scored.length - 12} more`);
    S.push('');
    L.push(...fit(S, BUDGET.security));
  }
  {
    const O = ['### Open ends', ''];
    const todo = await grep(String.raw`\b(TODO|FIXME|HACK|XXX)\b`);
    const mine = todo.filter(h => R.code.has(h.file));
    const by = new Map(); for (const h of mine) by.set(area(h.file), (by.get(area(h.file)) ?? 0) + 1);
    if (mine.length) {
      O.push(`- ${mine.length} TODO/FIXME/HACK in code, by thread: ${list([...by].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} (${v})`), 10)}`);
      // the oldest, dated by blame on those lines only (one call a file, at most 30 files)
      const perFile = new Map(); for (const h of mine) { if (!perFile.has(h.file)) perFile.set(h.file, []); perFile.get(h.file).push(h); }
      const dated = [];
      for (const [f, hs] of [...perFile].slice(0, 30)) {
        const out = await run(['blame', '--porcelain', ...hs.flatMap(h => ['-L', `${h.line},${h.line}`]), 'HEAD', '--', f]);
        let sha = null; const at = new Map();
        for (const b of out.split('\n')) {
          const s = /^([0-9a-f]{40}) \d+ (\d+)/.exec(b); if (s) { sha = s[1]; continue; }
          const t = /^author-time (\d+)$/.exec(b); if (t && sha) at.set(sha, +t[1] * 1000);
          if (b.startsWith('\t') && sha) { const h = hs.find(x => b.includes(x.text.trim().slice(0, 40))); if (h && at.get(sha)) dated.push({ ...h, at: at.get(sha) }); }
        }
      }
      for (const d of dated.sort((a, b) => a.at - b.at).slice(0, 3)) O.push(`  - oldest: ${d.file}:${d.line} (${day(d.at)}): ${scrub(d.text.trim()).slice(0, 120)}`);
    }
    const ask = /\b(should we|consider(?:ing)?|maybe we|not sure|open question|tbd|to decide|revisit|follow[- ]up)\b|\?\s*$/im;
    const asks = [];
    for (const c of commits) {
      const b = bodies.get(c.sha); if (!b) continue;
      // a body is wrapped: its paragraphs joined, then the sentence that asks
      const sentences = b.split(/\n\s*\n/).map(p => p.replace(/\s*\n\s*/g, ' ')).flatMap(p => p.split(/(?<=[.?!])\s+(?=[A-Z(“"])/));
      const l = sentences.find(x => ask.test(x) && x.length > 30);
      if (l) asks.push({ c, l });
    }
    if (asks.length) { O.push(`- ${asks.length} commit bodies ask or leave something to decide; the newest:`); for (const { c, l } of asks.slice(0, 6)) O.push(`  - ${short(c.sha)} ${day(c.at)}: ${scrub(l.trim()).slice(0, 220)}`); }
    const flags = [...reads.keys()].filter(k => /^(FEATURE_|FF_|ENABLE_|DISABLE_|FLAG_)|_(ENABLED|DISABLED|FLAG)$/.test(k));
    if (flags.length) O.push(`- Feature flags read from the environment: ${list(flags, 15)}`);
    if (O.length > 2) { O.push(''); L.push(...fit(O, BUDGET.open)); }
  }
  return L;
}

/** what moved in each kept sheet's inputs between two snapshots */
export function moved(was, now) {
  const out = [];
  for (const [k, title] of [['infra', 'Infrastructure'], ['creds', 'Credentials and access'], ['work', 'How we work']]) {
    const a = new Set(was?.[k] ?? []), b = new Set(now[k] ?? []);
    const plus = [...b].filter(x => !a.has(x)), minus = [...a].filter(x => !b.has(x));
    out.push(plus.length || minus.length ? `- ${title}: moved (${[plus.length && `new: ${list(plus.map(x => x.slice(0, 80)), 5)}`, minus.length && `gone: ${list(minus.map(x => x.slice(0, 80)), 5)}`].filter(Boolean).join('; ')})` : `- ${title}: unchanged`);
  }
  return out;
}
