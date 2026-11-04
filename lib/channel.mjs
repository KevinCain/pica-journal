#!/usr/bin/env node
// The journal's channel (JOURNAL-PLAN.md §4, phase J5): a one-way Claude Code channel that wakes a running
// session when pica appends to journal/outbox.jsonl, in place of /loop's polling. No dependencies: it speaks
// MCP's stdio JSON-RPC itself (initialize, ping, and the claude/channel capability), and watches the folder
// with fs.watch, so nothing runs while the journal is quiet.
//
// The event carries only counts and kinds, never the writer's text: Claude reads the entries through
// `pica-journal pending`, where the skill's rules about what counts as an instruction apply.
//
// Started by Claude Code from the plugin manifest; during the research preview the session needs
//   claude --dangerously-load-development-channels plugin:pica-journal@pica
import fs from 'node:fs';
import path from 'node:path';

const VERSION = '0.1.0';
// the same folder rule as journal.mjs: $PICA_JOURNAL, else the current folder if it is a journal, else ./journal
const isJournal = (d) => fs.existsSync(path.join(d, 'sheets')) || fs.existsSync(path.join(d, 'outbox.jsonl'));
const DIR = process.env.PICA_JOURNAL ? path.resolve(process.env.PICA_JOURNAL)
  : isJournal(process.cwd()) ? process.cwd() : path.resolve('journal');
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
let ready = false, queued = null;
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
    check();                                  // anything left from before the session started
    if (queued) { notify(queued); queued = null; }
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
const BEAT = path.join(DIR, '.listening');
function beat() {
  try { fs.writeFileSync(BEAT, JSON.stringify({ since: new Date().toISOString(), pid: process.pid, version: VERSION }) + '\n'); }
  catch {}                                    // no folder yet: watch() writes it once the folder appears
}
process.on('exit', () => {
  try { if (JSON.parse(fs.readFileSync(BEAT, 'utf8')).pid === process.pid) fs.unlinkSync(BEAT); } catch {}
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));

function notify(ev) {
  if (!ready) { queued = ev; return; }
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
function watch() {
  try {
    fs.watch(DIR, (_e, name) => { if (!name || name === 'outbox.jsonl') soon(); });
    beat();
  } catch {
    // no folder yet: look again for it rarely, until pica makes it
    setTimeout(watch, 30000);
  }
}
watch();
