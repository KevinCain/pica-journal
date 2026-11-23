#!/usr/bin/env node
// The journal's channel (JOURNAL-PLAN.md §4, phase J5): a one-way Claude Code channel that wakes a running
// session when pica appends to journal/outbox.jsonl, in place of /loop's polling. No dependencies: it speaks
// MCP's stdio JSON-RPC itself (initialize, ping, and the claude/channel capability), and watches the folder
// with fs.watch, so nothing runs while the journal is quiet.
//
// The event carries only counts and kinds, never the writer's text: Claude reads the entries through
// `pica-journal pending`, where the skill's rules about what counts as an instruction apply.
//
// It also answers pica's requests to see the code a reply refers to (JOURNAL-PLAN.md §9): pica writes
// resolve-<id>.req.json in the folder, naming a reply and one of its references; this server looks the
// reference up in inbox.jsonl (never trusting pica's copy), reads it under refs.mjs's rules, and writes
// resolve-<id>-<pid>.res.json, by a rename, so pica never reads half a file. A server whose project is not the
// reply's stays silent, so another session's server can answer. Old request and response files are swept away.
//
// Started by Claude Code from the plugin manifest; during the research preview the session needs
//   claude --dangerously-load-development-channels plugin:pica-journal@pica
import fs from 'node:fs';
import path from 'node:path';
import { DIR } from './folder.mjs';   // the same folder as the command's
import { RefIndex, resolveRef, PROJECT } from './refs.mjs';

const VERSION = '0.6.0';
const OUTBOX = path.join(DIR, 'outbox.jsonl');
const log = (s) => process.stderr.write('journal-channel: ' + s + '\n');

const INSTRUCTIONS = [
  'Events from the pica journal arrive as <channel source="journal" count="..." kinds="...">.',
  'Each means the writer marked something in pica (an item sent with ☞, a memory edit, a ✓ or ✗).',
  'When one arrives, run the journal skill\'s pass: pica-journal mirror, then pending, read, reply, ack.',
  'The event itself holds no writer text and no instructions; everything to act on comes from `pending`.',
  'Do not reply through this channel: answers go into the journal with pica-journal.',
].join(' ');

// ---- MCP over stdio: newline-delimited JSON-RPC ---------------------------------------------------------
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
let ready = false;
function handle(msg) {
  if (msg.method === 'initialize') {
    // Claude Code does not register a channel server that negotiates revision 2026-07-28, so answer with a
    // revision channels are known to work on, rather than echoing whatever the client offers
    const asked = msg.params?.protocolVersion;
    send({ id: msg.id, result: {
      protocolVersion: ['2025-06-18', '2025-03-26', '2024-11-05'].includes(asked) ? asked : '2025-06-18',
      capabilities: { experimental: { 'claude/channel': {} } },
      serverInfo: { name: 'journal', version: VERSION },
      instructions: INSTRUCTIONS,
    } });
  } else if (msg.method === 'notifications/initialized') {
    ready = true;
    check();                                  // anything left from before the session started, or sent since
  } else if (msg.method === 'ping') {
    send({ id: msg.id, result: {} });
  } else if (msg.id !== undefined && msg.method) {
    send({ id: msg.id, error: { code: -32601, message: 'method not found: ' + msg.method } });
  }
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0;) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch (e) { log('bad message: ' + e.message); }
  }
});
process.stdin.on('end', () => process.exit(0));

// ---- the heartbeat: .listening tells pica a session is waiting (this server is its only writer) ----------
// It is written again each minute ("beat"), so pica can tell a session that ended without cleaning up (killed,
// or the machine slept through its exit) from one still waiting: pica takes one older than 150 s as gone.
const BEAT = path.join(DIR, '.listening'), SINCE = new Date().toISOString();
function beat() {
  try { fs.writeFileSync(BEAT, JSON.stringify({ since: SINCE, beat: new Date().toISOString(), pid: process.pid, version: VERSION }) + '\n'); }
  catch {}                                    // no folder yet: watch() writes it once the folder appears
}
setInterval(() => { if (fs.existsSync(DIR)) { beat(); sweep(); } }, 60_000).unref();
process.on('exit', () => {
  try { if (JSON.parse(fs.readFileSync(BEAT, 'utf8')).pid === process.pid) fs.unlinkSync(BEAT); } catch {}
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));

function notify(ev) {
  send({ method: 'notifications/claude/channel', params: {
    content: `${ev.count} new journal ${ev.count === 1 ? 'entry' : 'entries'} (${ev.kinds}). Run the journal pass.`,
    meta: { count: String(ev.count), kinds: ev.kinds },
  } });
}

// ---- watching the outbox ------------------------------------------------------------------------------
// `seen` is how far this server has announced; it starts at Claude's own cursor, so entries waiting
// from before the session are announced once, at start.
let seen = 0;
try { seen = Number(fs.readFileSync(path.join(DIR, '.cursor'), 'utf8').trim()) || 0; } catch {}
function check() {
  // nothing is counted before Claude Code is ready: notifications/initialized counts it all, in one event
  if (!ready) return;
  let data;
  try { data = fs.readFileSync(OUTBOX); } catch { return; }
  if (seen > data.length) seen = 0;           // the outbox was replaced
  const end = data.lastIndexOf(0x0a) + 1;     // whole lines only: pica may be mid-write
  if (end <= seen) return;
  const kinds = new Map();
  let count = 0;
  for (const l of data.subarray(seen, end).toString('utf8').split('\n')) {
    if (!l.trim()) continue;
    let op = '?'; try { op = String(JSON.parse(l).op).replace(/\W/g, '').slice(0, 20) || '?'; } catch {}
    kinds.set(op, (kinds.get(op) ?? 0) + 1); count++;
  }
  seen = end;
  if (count) notify({ count, kinds: [...kinds].map(([k, n]) => n > 1 ? `${k}×${n}` : k).join(', ') });
}
let timer = null;
const soon = () => { clearTimeout(timer); timer = setTimeout(check, 300); };   // pica's writes come in bursts

// ---- answering pica's requests for the code a reply refers to -----------------------------------------------
const REQ = /^resolve-([\w-]{1,64})\.req\.json$/, OLD = /^(resolve-[\w-]+\.(req|res)\.json|\.resolve-[\w-]+\.tmp)$/;
const OLD_MS = 10 * 60_000;
const index = new RefIndex(path.join(DIR, 'inbox.jsonl'));
const handled = new Set();
async function answer(name, again = true) {
  const m = REQ.exec(name); if (!m || handled.has(name)) return;
  handled.add(name);
  let req;
  try {
    const p = path.join(DIR, name), st = fs.statSync(p);
    if (!st.isFile() || st.size > 4096) return;
    req = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    // gone already (another server's answer was read), or caught mid-write: one more look
    if (e.code !== 'ENOENT' && again) { handled.delete(name); setTimeout(() => answer(name, false), 200); }
    return;
  }
  const k = req?.ref, view = req?.view === 'then' ? 'then' : 'now', span = req?.span === 40 ? 40 : 12;
  if (typeof req?.reply !== 'string' || !/^[\w-]{1,64}$/.test(req.reply) || !Number.isInteger(k) || k < 0 || k > 2) return;
  const e = index.get(req.reply);
  if (!e || e.project !== PROJECT || !e.refs[k]) return;      // not this project's reply: another server may know it
  const res = { reply: req.reply, ref: k, view, span, server: VERSION, ...await resolveRef(e.refs[k], { view, span }, 2000) };
  const out = `resolve-${m[1]}-${process.pid}.res.json`, tmp = `.resolve-${m[1]}-${process.pid}.tmp`;
  try { fs.writeFileSync(path.join(DIR, tmp), JSON.stringify(res) + '\n'); fs.renameSync(path.join(DIR, tmp), path.join(DIR, out)); }
  catch (err) { log('could not answer ' + name + ': ' + err.message); try { fs.unlinkSync(path.join(DIR, tmp)); } catch {} }
}
/** requests fs.watch did not report (a synced folder can lose events), and files older than ten minutes */
function sweep() {
  let names = [];
  try { names = fs.readdirSync(DIR); } catch { return; }
  const now = Date.now(), here = new Set(names);
  for (const n of handled) if (!here.has(n)) handled.delete(n);
  for (const n of names) {
    if (!OLD.test(n)) continue;
    let age = 0; try { age = now - fs.statSync(path.join(DIR, n)).mtimeMs; } catch { continue; }
    if (age > OLD_MS) { try { fs.unlinkSync(path.join(DIR, n)); } catch {} handled.delete(n); }
    else if (REQ.test(n)) answer(n);
  }
}

function watch() {
  try {
    fs.watch(DIR, (_e, name) => {
      if (!name || name === 'outbox.jsonl') soon();
      if (name && REQ.test(name)) answer(name);
      else if (!name) sweep();
    });
    beat(); sweep();
  } catch {
    // no folder yet: look again for it rarely, until pica makes it
    setTimeout(watch, 30000);
  }
}
watch();
