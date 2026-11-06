#!/usr/bin/env node
// Claude's side of the journal (JOURNAL-PLAN.md §4, phase J3). No dependencies. Claude reads and writes the
// journal folder only through this script, which validates every write:
//
//   pica-journal pending              outbox entries past the cursor, as JSON lines, then "cursor <n>"
//   pica-journal ack <n>              move the cursor to <n> (the number pending printed)
//   pica-journal read <sheet>         a sheet as Markdown, every block with its id
//   pica-journal reading <sheet> <item>...    tell pica Claude is reading these items (their marks breathe
//                                     until the reply comes)
//   pica-journal reply [--awaits] [--replace] <sheet> <item> [md]
//                                     reply to an item (md from the argument, or stdin). --awaits: the reply
//                                     waits for the writer's ✓ or ∅ (pica sets the pair under it); --replace:
//                                     this reply takes the place of all earlier replies to the item (pica
//                                     keeps them, under "Show earlier replies")
//   pica-journal sheet <title> [md]           a new sheet; prints its link, sheet:<id>
//   pica-journal state <sheet> <item> <open|sent|answered|done>
//   pica-journal sheets               the sheets kept in the journal, with titles
//   pica-journal where                where the journal is, the project it belongs to, and whether pica has written there
//   pica-journal init                 make the journal folder, so pica can be pointed at it
//   pica-journal mirror               copy Claude's memory files into journal/memory/ and tell pica
//                                               what changed (each memory is a sheet, mem-<file>)
//   pica-journal adopt <amend-id>     the writer ✓'d a proposed memory edit: write it to the memory file
//   pica-journal forget <mem-sheet>   the writer ✗'d a new memory: set the file aside, drop its index line
//   pica-journal full                 run by the Stop hook, with the hook's JSON on stdin: attach this turn's
//                                     prose (Claude's own text, never tool output) to the replies it wrote
//
// Claude's memory directory is ~/.claude/projects/<this project>/memory, or $CLAUDE_MEMORY_DIR.
//
// The folder is found as folder.mjs says: $PICA_JOURNAL; else the folder Claude runs in, when it is a journal (a
// writer runs Claude in the folder they chose in pica); else, in a code project, <project>/journal. pica writes
// sheets/ and outbox.jsonl; this script writes inbox.jsonl, .cursor and memory/; and, only through adopt and
// forget, Claude's own memory files.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { DIR, ROOT, isJournal } from './folder.mjs';
import { numberItems, entryOf, NUMBERS } from './numbering.mjs';

const VERSION = '0.3.0';         // printed by `pending`, so a skill and a script from different releases notice
const file = (...p) => path.join(DIR, ...p);
const die = (msg) => { process.stderr.write('journal: ' + msg + '\n'); process.exit(1); };
const SHEET_ID = /^[\w-]{1,64}$/;
const MAX_MD = 20000;

function sheetPath(id) {
  if (!SHEET_ID.test(id ?? '')) die(`not a sheet id: ${JSON.stringify(id)}`);
  return file('sheets', id + '.pica');
}
function loadSheet(id) {
  const p = sheetPath(id);
  if (!fs.existsSync(p)) die(`no sheet ${id} in ${path.join(DIR, 'sheets')}`);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')).doc; } catch { die(`sheet ${id} is not readable .pica JSON`); }
}
const blocks = (doc) => doc?.content ?? [];
const textOf = (b) => (b.content ?? []).map(t => t.text ?? '').join('');

// ---- reading ------------------------------------------------------------------------------------------
function inline(b) {
  return (b.content ?? []).map(t => {
    let s = t.text ?? '';
    const m = (n) => (t.marks ?? []).some(x => x.type === n);
    if (m('em')) s = `*${s}*`;
    if (m('strong')) s = `**${s}**`;
    const ln = (t.marks ?? []).find(x => x.type === 'link');
    if (ln) s = `[${s}](${ln.attrs.href})`;
    return s;
  }).join('');
}
const MARK = { open: '•', sent: '☞', answered: '☞', done: '✓', declined: '✗' };
function toMarkdown(doc) {
  const out = [], bs = blocks(doc);
  // each item's number, as pica sets it (lib/numbering.mjs): the writer may say "item 3" or "A.2"
  const style = NUMBERS.includes(doc.attrs?.numbers) ? doc.attrs.numbers : '1', places = numberItems(bs.map(entryOf), style);
  for (const [i, b] of bs.entries()) {
    const num = places[i]?.label ? `, ${places[i].label}` : '';
    const a = b.attrs ?? {}, id = a.id ? `  {#${a.id}}` : '';
    if (b.type === 'heading') out.push('#'.repeat(a.level ?? 1) + ' ' + inline(b) + id);
    else if (a.voice === 'claude') out.push(`> Claude (${a.at ?? '?'}, to ${a.of ?? '?'}): ` + inline(b));
    // a follow-up goes on the conversation under the item it names (`thread`): indented, after the replies
    else if (a.item && a.thread) out.push(`  - ${MARK[a.item] ?? '•'} [${a.item}, follow-up to ${a.thread}] ` + inline(b) + id);
    // an item nested under the one above it: indented four spaces a level (follow-ups are labelled, so never mistaken)
    else if (a.item) out.push('    '.repeat(places[i]?.level ?? a.depth ?? 0) + `- ${MARK[a.item] ?? '•'} [${a.item}${num}] ` + inline(b) + id);
    else out.push(inline(b) + id);
  }
  return out.join('\n\n') + '\n';
}

// ---- writing: one line per operation, appended whole ------------------------------------------------------
function append(op) {
  fs.mkdirSync(DIR, { recursive: true });
  const line = JSON.stringify({ ...op, id: crypto.randomUUID() }) + '\n';
  fs.appendFileSync(file('inbox.jsonl'), line);
  return op;
}
async function mdArg(arg) {
  let md = arg;
  if (md === undefined || md === '-') { md = ''; for await (const c of process.stdin) md += c; }
  md = md.replace(/\r\n?/g, '\n').trim();
  if (!md) die('the reply is empty');
  if (md.length > MAX_MD) die(`too long (${md.length} > ${MAX_MD} characters); put longer work in a sheet`);
  for (const [, href] of md.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (!/^(sheet:[\w-]+|https?:\/\/\S+|mailto:\S+)$/.test(href)) die(`a link pica cannot open: ${href}`);
    const s = /^sheet:(.+)$/.exec(href);
    if (s && !fs.existsSync(sheetPath(s[1])) && !made().has(s[1])) die(`a link to a sheet that does not exist: ${href}`);
  }
  return md;
}
/** sheets Claude has made that pica may not have written to the folder yet */
function made() {
  const s = new Set();
  try { for (const l of fs.readFileSync(file('inbox.jsonl'), 'utf8').split('\n')) { try { const o = JSON.parse(l); if (o.op === 'sheet') s.add(o.sheet); } catch {} } } catch {}
  return s;
}
function findItem(doc, item) {
  const b = blocks(doc).find(b => b.attrs?.id === item);
  if (!b) die(`no block ${item} on that sheet`);
  if (b.attrs.voice) die(`${item} is a reply, not an item`);
  return b;
}

// ---- memory ---------------------------------------------------------------------------------------------
const MEM = path.resolve(process.env.CLAUDE_MEMORY_DIR ?? path.join(os.homedir(), '.claude', 'projects', ROOT.replace(/[^a-zA-Z0-9]/g, '-'), 'memory'));
const isMem = (id) => typeof id === 'string' && id.startsWith('mem-');
const sheetOfFile = (f) => 'mem-' + f.slice(0, -3).replace(/[^\w-]/g, '-').slice(0, 60);
const memFiles = () => { try { return fs.readdirSync(MEM).filter(f => f.endsWith('.md') && f !== 'MEMORY.md'); } catch { return []; } };
function fileOfSheet(sheet) { return memFiles().find(f => sheetOfFile(f) === sheet) ?? null; }
/** a memory file: its frontmatter (kept as written) and its body (what the sheet shows) */
function splitMemory(text) {
  const m = /^---\n[\s\S]*?\n---\n?/.exec(text);
  const front = m ? m[0] : '', name = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim();
  return { front, name, body: text.slice(front.length).trim() };
}
function mirror() {
  const out = file('memory'), first = !fs.existsSync(out);
  fs.mkdirSync(out, { recursive: true });
  const now = new Set(memFiles()), said = [];
  for (const f of now) {
    const text = fs.readFileSync(path.join(MEM, f), 'utf8'), was = fs.existsSync(path.join(out, f)) ? fs.readFileSync(path.join(out, f), 'utf8') : null;
    if (was === text) continue;
    fs.writeFileSync(path.join(out, f), text);
    const { name, body } = splitMemory(text);
    // on the first mirror every memory is simply there; after that, one pica has not seen is new
    append({ op: 'memory', sheet: sheetOfFile(f), name: name ?? f.slice(0, -3), md: body, ...(was === null && !first ? { new: true } : {}) });
    said.push((was === null ? (first ? '' : 'new ') : 'changed ') + f);
  }
  for (const f of fs.readdirSync(out).filter(f => f.endsWith('.md') && f !== 'MEMORY.md' && !now.has(f))) {
    fs.rmSync(path.join(out, f));
    append({ op: 'memory', sheet: sheetOfFile(f), name: f.slice(0, -3), md: '', gone: true });
    said.push('gone ' + f);
  }
  try { fs.copyFileSync(path.join(MEM, 'MEMORY.md'), path.join(out, 'MEMORY.md')); } catch {}
  process.stdout.write(said.length ? said.join('\n') + '\n' : 'memory unchanged\n');
}

// ---- the full answer: what Claude wrote in the terminal for the turn that replied ----------------------------
// The reply is the distilled record; the working is kept beside it, as pica's sidebar. Only text blocks of Claude's
// own messages are taken: no thinking, no tool calls, no tool output (which may hold file contents or secrets).
const MAX_FULL = 60000;
function turnOf(transcript) {
  const ents = [];
  for (const l of fs.readFileSync(transcript, 'utf8').split('\n')) { try { const e = JSON.parse(l); if (e.type === 'user' || e.type === 'assistant') ents.push(e); } catch {} }
  // the turn began with the last thing said to Claude: a prompt, a channel event, /loop; not a tool result or a skill's text
  const said = (e) => e.type === 'user' && !e.isMeta && !(Array.isArray(e.message?.content) && e.message.content.some(b => b.type === 'tool_result'));
  let i = ents.length - 1; while (i >= 0 && !said(ents[i])) i--;
  const turn = ents.slice(i + 1), prose = [], replied = new Set();
  for (const e of turn) {
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    for (const b of e.message.content) {
      if (b.type === 'text' && b.text.trim()) prose.push(b.text.trim());
      const c = b.type === 'tool_use' && typeof b.input?.command === 'string' ? b.input.command : '';
      for (const [, sh, it] of c.matchAll(/(?:journal\.mjs|pica-journal)\s+reply\s+['"]?([\w-]+)['"]?\s+['"]?([\w-]+)/g)) replied.add(sh + ' ' + it);
    }
  }
  return { since: i >= 0 ? Date.parse(ents[i].timestamp) || 0 : 0, prose: prose.join('\n\n'), replied };
}
function full(hook) {
  if (!hook?.transcript_path || !fs.existsSync(hook.transcript_path) || !fs.existsSync(file('inbox.jsonl'))) return;
  const { since, prose, replied } = turnOf(hook.transcript_path);
  if (!prose || !replied.size) return;
  const ops = fs.readFileSync(file('inbox.jsonl'), 'utf8').split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const done = new Set(ops.filter(o => o.op === 'full').map(o => o.reply));
  const md = prose.length > MAX_FULL ? '…' + prose.slice(-MAX_FULL) : prose;
  // the last reply to each item this turn wrote, made since the turn began; a turn that answered several
  // items keeps one answer for all of them, and says how many (`items`), so the sidebar can tell the writer
  const last = new Map();
  for (const o of ops) if (o.op === 'reply' && replied.has(o.sheet + ' ' + o.for) && Date.parse(o.at) >= since - 1000) last.set(o.sheet + ' ' + o.for, o);
  for (const o of last.values()) if (!done.has(o.id)) append({ op: 'full', sheet: o.sheet, for: o.for, reply: o.id, md, ...(last.size > 1 ? { items: last.size } : {}), at: new Date().toISOString() });
}

// ---- commands -------------------------------------------------------------------------------------------
const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case 'pending': {
    process.stdout.write(`version ${VERSION}\n`);
    let cursor = 0;
    try { cursor = Number(fs.readFileSync(file('.cursor'), 'utf8').trim()) || 0; } catch {}
    let buf = Buffer.alloc(0);
    try { buf = fs.readFileSync(file('outbox.jsonl')); } catch {}
    if (cursor > buf.length) cursor = 0;      // the outbox was replaced: read it again
    // only whole lines: a line still being written waits for the next look
    const end = buf.lastIndexOf(0x0a) + 1;
    const lines = end > cursor ? buf.subarray(cursor, end).toString('utf8').split('\n').filter(Boolean) : [];
    const ops = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    // an ask taken back before it was read is not pending
    const asks = new Map();
    for (const o of ops) {
      const k = o.sheet + ' ' + o.item;
      if (o.op === 'withdraw') asks.delete(k);
      else if (o.op === 'ask' || o.op === 'amend') { asks.delete(k); asks.set(k, o); }
      else if (o.op === 'agree' || o.op === 'decline') asks.set(k + ' ' + o.op, o);
    }
    for (const o of asks.values()) process.stdout.write(JSON.stringify(isMem(o.sheet) ? { ...o, memory: fileOfSheet(o.sheet) } : o) + '\n');
    process.stdout.write(`cursor ${Math.max(end, cursor)}\n`);
    break;
  }
  case 'ack': {
    const n = Number(args[0]);
    let size = 0; try { size = fs.statSync(file('outbox.jsonl')).size; } catch {}
    if (!Number.isInteger(n) || n < 0 || n > size) die('ack needs the cursor number pending printed');
    fs.writeFileSync(file('.cursor'), String(n) + '\n');
    break;
  }
  case 'read': process.stdout.write(toMarkdown(loadSheet(args[0]))); break;
  case 'sheets': {
    let names = [];
    try { names = fs.readdirSync(file('sheets')).filter(n => n.endsWith('.pica')); } catch {}
    // the writer's name for the sheet, if they gave it one (pica's Rename), else its first line
    for (const n of names) {
      const id = n.slice(0, -5);
      let name = '';
      try { name = JSON.parse(fs.readFileSync(sheetPath(id), 'utf8')).name ?? ''; } catch {}
      process.stdout.write(`${id}\t${(name || textOf(blocks(loadSheet(id))[0] ?? {})).slice(0, 80)}\n`);
    }
    break;
  }
  case 'reading': {
    const [sheet, ...items] = args, doc = loadSheet(sheet);
    if (!items.length) die('reading needs the items, after the sheet');
    for (const i of items) findItem(doc, i);
    append({ op: 'reading', sheet, items, at: new Date().toISOString() });
    process.stdout.write(`reading ${items.join(' ')} on ${sheet}\n`);
    break;
  }
  case 'reply': {
    const flags = new Set(args.filter(a => a.startsWith('--'))), rest = args.filter(a => !a.startsWith('--'));
    for (const f of flags) if (f !== '--awaits' && f !== '--replace') die(`reply: unknown flag ${f}`);
    const [sheet, item, md] = rest, doc = loadSheet(sheet);
    findItem(doc, item);
    append({ op: 'reply', sheet, for: item, md: await mdArg(md), at: new Date().toISOString(),
      ...(flags.has('--awaits') ? { awaits: true } : {}), ...(flags.has('--replace') ? { replace: true } : {}) });
    process.stdout.write(`${flags.has('--replace') ? 'replaced the replies' : 'replied'} to ${item} on ${sheet}${flags.has('--awaits') ? ', awaiting ✓ or ∅' : ''}\n`);
    break;
  }
  case 'sheet': {
    const [title, md] = args;
    if (!title?.trim() || title.length > 120) die('a sheet needs a title of at most 120 characters');
    const sheet = 'c' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
    append({ op: 'sheet', sheet, title: title.trim(), md: await mdArg(md) });
    process.stdout.write(`sheet:${sheet}\n`);
    break;
  }
  case 'state': {
    const [sheet, item, state] = args;
    if (!['open', 'sent', 'answered', 'done', 'declined'].includes(state)) die('state is one of open, sent, answered, done, declined');
    findItem(loadSheet(sheet), item);
    append({ op: 'state', sheet, item, state });
    process.stdout.write(`${item} is ${state}\n`);
    break;
  }
  case 'where': {
    const state = isJournal(DIR) ? 'ready' : fs.existsSync(DIR) ? 'empty (pica has not written here yet)' : 'missing (pica-journal init makes it)';
    process.stdout.write(`journal ${DIR}\nproject ${ROOT}\nstate ${state}\n`);
    break;
  }
  case 'init': {
    const was = fs.existsSync(DIR);
    fs.mkdirSync(DIR, { recursive: true });
    process.stdout.write(`${was ? 'already there' : 'made'}: ${DIR}\n`);
    break;
  }
  case 'mirror': mirror(); break;
  case 'full': {
    // a hook must never get in the way of the session: any failure is silent
    let input = ''; for await (const c of process.stdin) input += c;
    try { full(JSON.parse(input || '{}')); } catch {}
    break;
  }
  case 'adopt': {
    // the edit comes from the outbox, word for word: what the writer ✓'d is what is written
    let amend = null;
    try { for (const l of fs.readFileSync(file('outbox.jsonl'), 'utf8').split('\n')) { try { const o = JSON.parse(l); if (o.op === 'amend' && o.id === args[0]) amend = o; } catch {} } } catch {}
    if (!amend) die(`no amend ${args[0]} in the outbox`);
    const agreed = fs.readFileSync(file('outbox.jsonl'), 'utf8').split('\n').some(l => { try { const o = JSON.parse(l); return o.op === 'agree' && o.sheet === amend.sheet && o.item === amend.item; } catch { return false; } });
    if (!agreed) die('the writer has not ✓\'d that change yet');
    const f = fileOfSheet(amend.sheet); if (!f) die(`no memory file for ${amend.sheet}`);
    const p = path.join(MEM, f), { front } = splitMemory(fs.readFileSync(p, 'utf8'));
    fs.writeFileSync(p, front + (front ? '\n' : '') + amend.md.trim() + '\n');
    process.stdout.write(`adopted into ${f}\n`);
    mirror();
    break;
  }
  case 'forget': {
    const f = fileOfSheet(args[0]); if (!f) die(`no memory file for ${args[0]}`);
    // set aside, not deleted
    fs.mkdirSync(path.join(MEM, '.forgotten'), { recursive: true });
    fs.renameSync(path.join(MEM, f), path.join(MEM, '.forgotten', f));
    const idx = path.join(MEM, 'MEMORY.md');
    try { fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').split('\n').filter(l => !l.includes('(' + f + ')')).join('\n')); } catch {}
    process.stdout.write(`forgot ${f} (kept in ${path.join(MEM, '.forgotten')})\n`);
    mirror();
    break;
  }
  default:
    process.stderr.write('usage: pica-journal pending | ack <n> | read <sheet> | sheets | where | init | reading <sheet> <item>... | reply [--awaits] [--replace] <sheet> <item> [md] | sheet <title> [md] | state <sheet> <item> <state> | mirror | adopt <amend-id> | forget <mem-sheet> | full (hook)\n');
    process.exit(cmd ? 1 : 0);
}
