#!/usr/bin/env node
// Claude's side of the journal (JOURNAL-PLAN.md §4, phase J3). No dependencies. Claude reads and writes the
// journal folder only through this script, which validates every write:
//
//   pica-journal pending              outbox entries past the cursor, as JSON lines, then "cursor <n>"
//   pica-journal ack <n>              move the cursor to <n> (the number pending printed)
//   pica-journal read <sheet>         a sheet as Markdown, every block with its id
//   pica-journal reply <sheet> <item> [md]     reply to an item (md from the argument, or stdin)
//   pica-journal sheet <title> [md]           a new sheet; prints its link, sheet:<id>
//   pica-journal state <sheet> <item> <open|sent|answered|done>
//   pica-journal sheets               the sheets kept in the journal, with titles
//   pica-journal mirror               copy Claude's memory files into journal/memory/ and tell pica
//                                               what changed (each memory is a sheet, mem-<file>)
//   pica-journal adopt <amend-id>     the writer ✓'d a proposed memory edit: write it to the memory file
//   pica-journal forget <mem-sheet>   the writer ✗'d a new memory: set the file aside, drop its index line
//
// Claude's memory directory is ~/.claude/projects/<this project>/memory, or $CLAUDE_MEMORY_DIR.
//
// The folder is $PICA_JOURNAL if set; else the current folder, when it holds sheets/ or outbox.jsonl, or nothing yet
// but dotfiles (a writer
// runs Claude in the folder they chose in pica); else ./journal. pica writes sheets/ and outbox.jsonl; this script writes
// inbox.jsonl, .cursor and memory/; and, only through adopt and forget, Claude's own memory files.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

const VERSION = '0.1.0';         // printed by `pending`, so a skill and a script from different releases notice
const isJournal = (d) => fs.existsSync(path.join(d, 'sheets')) || fs.existsSync(path.join(d, 'outbox.jsonl'));
// a folder holding nothing but dotfiles is one pica has not written to yet (Claude started first)
const fresh = (d) => !fs.existsSync(path.resolve('journal')) && fs.readdirSync(d).every((n) => n.startsWith('.'));
const DIR = process.env.PICA_JOURNAL ? path.resolve(process.env.PICA_JOURNAL)
  : isJournal(process.cwd()) || fresh(process.cwd()) ? process.cwd() : path.resolve('journal');
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
  const out = [];
  for (const b of blocks(doc)) {
    const a = b.attrs ?? {}, id = a.id ? `  {#${a.id}}` : '';
    if (b.type === 'heading') out.push('#'.repeat(a.level ?? 1) + ' ' + inline(b) + id);
    else if (a.voice === 'claude') out.push(`> Claude (${a.at ?? '?'}, to ${a.of ?? '?'}): ` + inline(b));
    else if (a.item) out.push(`- ${MARK[a.item] ?? '•'} [${a.item}] ` + inline(b) + id);
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
const MEM = path.resolve(process.env.CLAUDE_MEMORY_DIR ?? path.join(os.homedir(), '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), 'memory'));
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
    for (const n of names) { const id = n.slice(0, -5); process.stdout.write(`${id}\t${textOf(blocks(loadSheet(id))[0] ?? {}).slice(0, 80)}\n`); }
    break;
  }
  case 'reply': {
    const [sheet, item, md] = args, doc = loadSheet(sheet);
    findItem(doc, item);
    append({ op: 'reply', sheet, for: item, md: await mdArg(md), at: new Date().toISOString() });
    process.stdout.write(`replied to ${item} on ${sheet}\n`);
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
  case 'mirror': mirror(); break;
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
    process.stderr.write('usage: pica-journal pending | ack <n> | read <sheet> | sheets | reply <sheet> <item> [md] | sheet <title> [md] | state <sheet> <item> <state> | mirror | adopt <amend-id> | forget <mem-sheet>\n');
    process.exit(cmd ? 1 : 0);
}
