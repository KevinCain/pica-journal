#!/usr/bin/env node
// Claude's side of the journal (JOURNAL-PLAN.md §4, phase J3). No dependencies. Claude reads and writes the
// journal folder only through this script, which validates every write:
//
//   pica-journal pending              outbox entries past the cursor, as JSON lines, then "cursor <n>"
//   pica-journal ack <n>              move the cursor to <n> (the number pending printed)
//   pica-journal read <sheet>         a sheet as Markdown, every block with its id
//   pica-journal reading <sheet> <item>...    tell pica Claude is reading these items (their marks breathe
//                                     until the reply comes)
//   pica-journal reply [--awaits] [--replace] [--blocked] [--offer <label>]... [--state <marks>] [--phase <n/total>]
//                      [--ref <spec> [--why <text>]]... [--detail <md|@file>] <sheet> <item> [md]
//                                     reply to an item (md from the argument, or stdin). --awaits: the reply
//                                     waits for the writer's ✓ or ✕ (pica sets the pair under it); --replace:
//                                     this reply takes the place of all earlier replies to the item (pica
//                                     keeps them, under "Show earlier replies"); --blocked: Claude Code's
//                                     permissions stopped a step the item asked for (pica shows the writer
//                                     how to allow it); --offer: a pill at the end of the reply, the next thing
//                                     the writer is likely to ask (up to three, 40 characters each); a click
//                                     sends it as a follow-up; --state: what has happened to the item, which
//                                     pica sets on the reply's signature: a comma list of worked, planned,
//                                     committed, pushed (committed and pushed are checked against git here);
//                                     --phase 2/3: the reply is phase 2 of a plan of 3 (set on the signature; a phase
//                                     before the last offers "Continue" unless other --offer labels are given);
//                                     --ref <path[:a-b]|path#symbol> [--why <text>]: a reference to code, up to
//                                     three (a snapshot of at most 12 lines goes with it; pica opens the lines as
//                                     they are now); --detail <md|@file>: the longer working, kept beside the
//                                     reply (opened from its signature's §), never on the page
//   pica-journal resolve <reply-id> <n> [--then] [--span 40]   reference n (from 1) of a reply, as it is now
//                                     (--then: as it was at the reply's commit), as pica would be shown it
//   pica-journal recast <sheet> <item> [md]   propose the item's wording in the past tense, as a record of what
//                                     was asked and done (pica shows it under the item; the writer ✓s it in)
//   pica-journal pin <sheet> [md]     pin a point to the head of the sheet, where pica lists the points the
//                                     writer and Claude agree on (set at once, in Claude's ink, signed)
//   pica-journal sheet <title> [md]           a new sheet (at most 100,000 characters; no item may open with ☞);
//                                     prints its link, sheet:<id>
//   pica-journal rewrite --base <version> <sheet> [md]   a refactor: the sheet rewritten in place (read prints its
//                                     version); {#id} alone on a line keeps the writer's block as it is, with its
//                                     replies; the rest is new prose. Every open item stays, and the pins; pica keeps
//                                     the sheet as it was in the Archive, and refuses (pending: refused) if the
//                                     writer changed the sheet since, or an ask on it is waiting
//   pica-journal state <sheet> <item> <open|sent|answered|done|declined>
//   pica-journal sheets               the sheets kept in the journal, with titles (and "(archived)" for those in pica's Archive)
//   pica-journal where                where the journal is, the project it belongs to, and whether pica has written there
//   pica-journal init                 make the journal folder, so pica can be pointed at it
//   pica-journal survey [--transcripts] [--since <commit>]   what an import reads, as a digest (lib/survey.mjs):
//                                     git weighted by what survives at HEAD, in threads, with removals, reverts and
//                                     branches; with --transcripts, this project's Claude sessions, filtered
//   pica-journal survey transcript <session> [--files a,b] [--from <n>]   one session's conversation, filtered
//   pica-journal mirror               copy Claude's memory files into journal/memory/ and tell pica
//                                               what changed (each memory is a sheet, mem-<file>)
//   pica-journal adopt <amend-id>     the writer ✓'d a proposed memory edit: write it to the memory file
//   pica-journal forget <mem-sheet>   the writer ✗'d a new memory: set the file aside, drop its index line
//   pica-journal remember <sheet> <item> <name>   the writer ✓'d a rule proposed as an item (answered with
//                                     --awaits): write the item's words, as they are now, to a new memory file
//   pica-journal memory [<folder>|--project]   which folder's memory the journal uses, and the candidates (the
//                                     project and the folders above it, with their memories); with a folder,
//                                     record it (once, at setup), so mirror, adopt, forget and remember use it
//
// Claude's memory directory is that of the folder `memory` recorded, else of the project; $CLAUDE_MEMORY_DIR
// overrides both (lib/folder.mjs).
//
// Nothing that looks like a secret is written: every command that writes text (sheet and its title, reply, recast,
// pin, rewrite, remember) refuses it, naming the line, and mirror leaves such a memory file out.
//
// The folder is found as folder.mjs says: $PICA_JOURNAL; else the folder Claude runs in, when it is a journal (a
// writer runs Claude in the folder they chose in pica); else, in a code project, <project>/journal. pica writes
// sheets/ and outbox.jsonl; this script writes inbox.jsonl, .cursor and memory/; and, only through adopt and
// forget, Claude's own memory files.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { DIR, ROOT, isJournal, MEM, MEMORY_SETTING, memoryOf, memoryFolder, gitRoot } from './folder.mjs';
import { numberItems, entryOf, NUMBERS } from './numbering.mjs';
import { makeRef, resolveRef, Refusal, PROJECT, RefIndex, MAX_REFS, secretIn, secretLine } from './refs.mjs';
import { sheetVersion, REWRITE_ID, KEEP } from './version.mjs';

const VERSION = '0.7.1';         // printed by `pending`, so a skill and a script from different releases notice

/** `--phase 2/3`: the reply is phase 2 of a plan of 3 steps */
function checkPhase(v) {
  const m = /^(\d{1,2})\/(\d{1,2})$/.exec(v.trim());
  if (!m || +m[1] < 1 || +m[2] < +m[1] || +m[2] > 20) die('reply: --phase is n/total, such as 1/3 (n at least 1, at most total, total at most 20)');
  return { n: +m[1], of: +m[2] };
}
const MARKS = ['worked', 'planned', 'committed', 'pushed'];
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
/** the marks of `reply --state`: known words, in order; committed and pushed only when git says so */
function checkMarks(list) {
  const w = list.split(',').map(x => x.trim()).filter(Boolean);
  if (!w.length) die(`reply: --state needs a list of ${MARKS.join(', ')}`);
  for (const m of w) if (!MARKS.includes(m)) die(`reply: unknown state ${m} (${MARKS.join(', ')})`);
  if (w.includes('worked') && w.includes('planned')) die('reply: an item is worked or planned, not both');
  try {
    if (w.includes('committed') || w.includes('pushed')) {
      if (git('status', '--porcelain', '--untracked-files=no')) die('reply: committed or pushed, but tracked files have uncommitted changes');
      git('rev-parse', 'HEAD');
    }
    if (w.includes('pushed') && git('rev-list', '--count', '@{u}..HEAD') !== '0') die('reply: pushed, but there are commits not on the upstream branch');
  } catch (e) { if (e.status !== undefined || e.code) die(`reply: cannot check git for committed or pushed (${e.message.split('\n')[0]})`); throw e; }
  return MARKS.filter(m => w.includes(m));
}
const file = (...p) => path.join(DIR, ...p);
const die = (msg) => { process.stderr.write('journal: ' + msg + '\n'); process.exit(1); };
const SHEET_ID = /^[\w-]{1,64}$/;
/** a list item opening with ☞ (pica's list markers: - * 1. 1) 2.1 A.1) */
const SENT_ITEM = /^\s*(?:[-*]|\d+[.)]|\d+(?:\.\d+)+|[A-Z]\.\d+(?:\.\d+)*)\s+☞\s/;
// a reply stays short (the skill asks for a few sentences; this is a backstop); a sheet holds a plan, an essay or an index
const MAX_MD = 20000, MAX_SHEET = 100000, MAX_DETAIL = 12000;

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
  const out = [], all = blocks(doc);
  // the pins first, whatever the fold: the points agreed on, read before anything else on the sheet
  const pins = all.filter(b => b.attrs?.pin);
  if (pins.length) {
    out.push('## Pinned (agreed)' + (doc.attrs?.pinsFolded ? ' (folded on the page)' : ''));
    for (const b of pins) out.push(`- ${inline(b)}${b.attrs.pin === 'claude' ? ' — Claude' : ''}  {#${b.attrs.id ?? ''}}`);
    out.push('---');
  }
  const bs = all.filter(b => !b.attrs?.pin);
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
    else if (a.item) {
      const ind = '    '.repeat(places[i]?.level ?? a.depth ?? 0);
      out.push(ind + `- ${MARK[a.item] ?? '•'} [${a.item}${num}] ` + inline(b) + id);
      // a wording Claude proposed that the writer has not yet taken or set aside
      if (Array.isArray(a.recast)) out.push(ind + `  (your proposed wording, not yet taken: ${inline({ content: a.recast })})`);
    }
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
async function mdArg(arg, max = MAX_MD) {
  let md = arg;
  if (md === undefined || md === '-') { md = ''; for await (const c of process.stdin) md += c; }
  md = md.replace(/\r\n?/g, '\n').trim();
  if (!md) die('the reply is empty');
  if (md.length > max) die(`too long (${md.length} > ${max} characters)` + (max === MAX_MD ? '; put longer work in a sheet' : '; split it into sheets that link each other'));
  const secret = secretLine(md);
  if (secret) die(`refused: ${secret.line ? `line ${secret.line}` : 'the text'} holds what looks like ${secret.name}. Name a credential, its service and where it is kept, never its value`);
  for (const [, href] of md.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (!LINK.test(href)) die(`a link pica cannot open: ${href}`);
    const s = /^sheet:([\w-]+)(?:#([\w-]+))?$/.exec(href);
    if (!s) continue;
    const there = fs.existsSync(sheetPath(s[1]));
    if (!there && !made().has(s[1])) die(`a link to a sheet that does not exist: ${href}`);
    // a link to an item: on the sheet, or in an archived copy a rewrite of it left (pica opens it there)
    if (s[2] && there && !itemHome(s[1], s[2])) die(`a link to an item that is not on ${s[1]}, nor in the sheet as it was before a rewrite: ${href}`);
  }
  return md;
}
/** `--detail`: Markdown, or `@file` to read it from a file; kept beside the reply, never on the page */
function detailArg(v) {
  if (v === undefined) die('reply: --detail needs Markdown, or @file');
  let md = v;
  if (v.startsWith('@')) { try { md = fs.readFileSync(v.slice(1), 'utf8'); } catch { die(`reply: cannot read ${v.slice(1)}`); } }
  md = md.replace(/\r\n?/g, '\n').trim();
  if (!md) die('reply: --detail is empty');
  if (md.length > MAX_DETAIL) die(`reply: --detail is at most ${MAX_DETAIL} characters (${md.length}); put longer work in a sheet`);
  for (const [, href] of md.matchAll(/\]\(([^)\s]+)\)/g)) if (!LINK.test(href)) die(`reply: --detail has a link pica cannot open: ${href}`);
  const secret = secretIn(md); if (secret) die(`reply: --detail holds what looks like ${secret}`);
  return md;
}
/** the links pica opens: a sheet, an item on one (sheet:<id>#<item>), the web, mail */
const LINK = /^(sheet:[\w-]+(?:#[\w-]+)?|https?:\/\/\S+|mailto:\S+)$/;
/** the sheet holding `item`: `sheet` itself, else the archived copy, back through each rewrite's record, that has it */
function itemHome(sheet, item) {
  const seen = new Set();
  for (let id = sheet; id && !seen.has(id) && seen.size <= 20;) {
    seen.add(id);
    let doc; try { doc = JSON.parse(fs.readFileSync(sheetPath(id), 'utf8')).doc; } catch { return null; }
    if (blocks(doc).some(b => b.attrs?.id === item)) return id;
    const rec = blocks(doc).find(b => b.attrs?.id === REWRITE_ID);
    id = (rec?.content ?? []).map(t => (t.marks ?? []).find(m => m.type === 'link')?.attrs?.href).find(h => /^sheet:[\w-]+$/.test(h ?? ''))?.slice(6) ?? null;
  }
  return null;
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
  // a memory holding what looks like a secret is not mirrored; remembered by its text's hash, so it is said once
  const refusedFile = file('.mirror-refused'); let refused = {};
  try { refused = JSON.parse(fs.readFileSync(refusedFile, 'utf8')); } catch {}
  const refusedNow = {};
  for (const f of now) {
    const text = fs.readFileSync(path.join(MEM, f), 'utf8'), was = fs.existsSync(path.join(out, f)) ? fs.readFileSync(path.join(out, f), 'utf8') : null;
    if (was === text) continue;
    const secret = secretIn(text);
    if (secret) {
      const h = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
      refusedNow[f] = h;
      if (refused[f] !== h) said.push(`not mirrored: ${f} holds what looks like ${secret} (take the value out of the memory file; it stays out of pica until then)`);
      continue;
    }
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
  // a refused file is never copied, so each pass checks it again: what is refused now replaces the record
  if (Object.keys(refusedNow).length || Object.keys(refused).length) fs.writeFileSync(refusedFile, JSON.stringify(refusedNow) + '\n');
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
      // the writer took Claude's wording of an item that has replies: they answer the old wording
      else if (o.op === 'reworded') asks.set(k + ' reworded', o);
      // the writer changed a sheet's pins: only the latest list matters
      else if (o.op === 'pins') { asks.delete(o.sheet + ' pins'); asks.set(o.sheet + ' pins', o); }
      // pica would not apply a rewrite: why, for Claude to read the sheet again or answer what is waiting
      else if (o.op === 'refused') asks.set(o.sheet + ' refused ' + o.of, o);
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
  case 'read': {
    let archived = false; try { archived = !!JSON.parse(fs.readFileSync(sheetPath(args[0]), 'utf8')).archived; } catch {}
    if (archived) process.stdout.write('<!-- archived: a record the writer keeps; read it and link to it, but do not reply to it or change it -->\n\n');
    const doc = loadSheet(args[0]), v = sheetVersion(doc);
    // the version a rewrite starts from (rewrite --base), and whether the writer changed the sheet since its last rewrite
    const rec = blocks(doc).find(b => b.attrs?.id === REWRITE_ID), was = rec && /\b([0-9a-f]{14})\b/.exec(textOf(rec))?.[1];
    process.stdout.write(`<!-- version ${v}${was ? (was === v ? '; unchanged since its last rewrite' : '; changed since its last rewrite') : ''} -->\n\n`);
    process.stdout.write(toMarkdown(doc)); break;
  }
  case 'sheets': {
    let names = [];
    try { names = fs.readdirSync(file('sheets')).filter(n => n.endsWith('.pica')); } catch {}
    // the writer's name for the sheet, if they gave it one (pica's Rename), else its first line
    for (const n of names) {
      const id = n.slice(0, -5);
      let name = '', archived = false;
      try { const f = JSON.parse(fs.readFileSync(sheetPath(id), 'utf8')); name = f.name ?? ''; archived = !!f.archived; } catch {}
      // an archived sheet is a record the writer keeps: read it, link to it, never change it
      process.stdout.write(`${id}\t${(name || textOf(blocks(loadSheet(id))[0] ?? {})).slice(0, 80)}${archived ? '\t(archived)' : ''}\n`);
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
    const flags = new Set(), rest = [], offers = [];
    let marks = [], phase = null, detail = null;
    const specs = [];
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (a === '--phase') { phase = checkPhase(args[++k] ?? ''); continue; }
      if (a === '--ref') { const v = args[++k]; if (!v?.trim()) die('reply: --ref needs a path, path:12-30 or path#symbol'); specs.push({ spec: v }); continue; }
      if (a === '--why') { const v = args[++k]; if (!specs.length || specs[specs.length - 1].why !== undefined) die('reply: --why goes after the --ref it explains, once'); specs[specs.length - 1].why = v ?? ''; continue; }
      if (a === '--detail') { detail = detailArg(args[++k]); continue; }
      if (a === '--state') { marks = checkMarks(args[++k] ?? ''); continue; }
      if (a === '--offer') { const l = (args[++k] ?? '').trim(); if (!l) die('reply: --offer needs a label'); offers.push(l); }
      else if (a.startsWith('--')) flags.add(a); else rest.push(a);
    }
    for (const f of flags) if (!['--awaits', '--replace', '--blocked'].includes(f)) die(`reply: unknown flag ${f}`);
    // a phase that is not the last offers its own way on, unless Claude offered something else
    if (phase && phase.n < phase.of && !offers.length) offers.push('Continue');
    if (offers.length > 3) die('reply: at most three --offer labels');
    if (offers.some(l => [...l].length > 40 || /[\n\r]/.test(l))) die('reply: an --offer label is one line of at most 40 characters');
    if (specs.length > MAX_REFS) die(`reply: at most ${MAX_REFS} --ref`);
    const [sheet, item, md] = rest, doc = loadSheet(sheet);
    findItem(doc, item);
    // each reference checked and its snapshot taken now: what is refused is said, and nothing is written
    const refs = [];
    for (const { spec, why } of specs) {
      try { const { ref, note } = await makeRef(spec, why); refs.push(ref); if (note) process.stderr.write(`journal: ${spec}: ${note}\n`); }
      catch (e) { if (e instanceof Refusal) die(`reply: --ref ${spec}: ${e.message}`); throw e; }
    }
    append({ op: 'reply', sheet, for: item, md: await mdArg(md), at: new Date().toISOString(),
      ...(refs.length ? { refs, project: PROJECT } : {}), ...(detail ? { detail } : {}),
      ...(flags.has('--awaits') ? { awaits: true } : {}), ...(flags.has('--replace') ? { replace: true } : {}),
      ...(flags.has('--blocked') ? { blocked: true } : {}), ...(offers.length ? { offers } : {}), ...(marks.length ? { marks } : {}), ...(phase ? { phase } : {}) });
    process.stdout.write(`${flags.has('--replace') ? 'replaced the replies' : 'replied'} to ${item} on ${sheet}${flags.has('--awaits') ? ', awaiting ✓ or ✕' : ''}${flags.has('--blocked') ? ', marked as stopped by a permission' : ''}${offers.length ? ', offering ' + offers.map(l => '“' + l + '”').join(', ') : ''}${refs.length ? ', with ' + refs.map(r => r.path + ':' + r.line).join(', ') : ''}${detail ? ', detail kept beside it' : ''}\n`);
    break;
  }
  case 'recast': {
    const [sheet, item, md] = args, doc = loadSheet(sheet);
    findItem(doc, item);
    append({ op: 'recast', sheet, item, md: await mdArg(md) });
    process.stdout.write(`proposed a wording for ${item} on ${sheet}\n`);
    break;
  }
  case 'pin': {
    const [sheet, md] = args;
    loadSheet(sheet);
    const text = await mdArg(md);
    if (text.length > 600) die('a pin is a point, not a page: at most 600 characters (put longer work in a sheet)');
    append({ op: 'pin', sheet, md: text, at: new Date().toISOString() });
    process.stdout.write(`pinned to ${sheet}\n`);
    break;
  }
  case 'sheet': {
    const [title, md] = args;
    if (!title?.trim() || title.length > 120) die('a sheet needs a title of at most 120 characters');
    { const t = secretIn(title); if (t) die(`refused: the title holds what looks like ${t}`); }
    const sheet = 'c' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
    const text = await mdArg(md, MAX_SHEET);
    // pica reads a list item opening with ☞ as sent, but sends only what it sees marked on the page: in a sheet
    // that arrives whole it would sit as sent with no ask behind it (Claude cannot send to itself)
    const sent = text.split('\n').find(l => SENT_ITEM.test(l));
    if (sent) die(`an item opens with ☞, which would show as sent with nothing sent: ${JSON.stringify(sent.trim().slice(0, 80))}; leave the mark off, or write \\☞ to keep it as words`);
    append({ op: 'sheet', sheet, title: title.trim(), md: text });
    process.stdout.write(`sheet:${sheet}\n`);
    break;
  }
  case 'rewrite': {
    let base = null; const rest = [];
    for (let k = 0; k < args.length; k++) { if (args[k] === '--base') base = args[++k]; else if (args[k].startsWith('--')) die(`rewrite: unknown flag ${args[k]}`); else rest.push(args[k]); }
    if (!/^[0-9a-f]{14}$/.test(base ?? '')) die('rewrite: --base <version>, as read printed it at the top of the sheet');
    const [sheet, md] = rest;
    if (isMem(sheet)) die('rewrite: a memory sheet is changed through its memory file');
    const doc = loadSheet(sheet);
    let archived = false; try { archived = !!JSON.parse(fs.readFileSync(sheetPath(sheet), 'utf8')).archived; } catch {}
    if (archived) die('rewrite: that sheet is in the Archive, a record: never rewritten');
    const now = sheetVersion(doc);
    if (now !== base) die(`rewrite: the sheet changed since you read it (its version is now ${now}): read it again, and rewrite it from what it says now`);
    const bs = blocks(doc), byId = new Map(bs.filter(b => b.attrs?.id).map(b => [b.attrs.id, b]));
    const waiting = bs.filter(b => !b.attrs?.voice && b.attrs?.item === 'sent').map(b => b.attrs.id);
    if (waiting.length) die(`rewrite: an item on the sheet is waiting for your answer (${waiting.join(', ')}): answer it first`);
    const text = await mdArg(md, MAX_SHEET), lines = text.split('\n');
    const sent = lines.find(l => SENT_ITEM.test(l));
    if (sent) die(`rewrite: an item opens with ☞, which would show as sent with nothing sent: ${JSON.stringify(sent.trim().slice(0, 80))}`);
    if (lines.some(l => /^\s*>\s*\*\*Claude:?\*\*/.test(l))) die('rewrite: a rewrite is prose: it cannot add a reply (write it as a paragraph)');
    // the writer's words: a kept block is named, {#id} on a line of its own, and comes over as it is, with its replies
    const kept = new Set();
    for (const l of lines) {
      const m = KEEP.exec(l.trim()); if (!m) continue;
      const b = byId.get(m[1]);
      if (!b) die(`rewrite: {#${m[1]}} is not a block of the sheet`);
      if (b.attrs.voice) die(`rewrite: {#${m[1]}} is one of your replies: keep the item it answers, and its replies come with it`);
      if (b.attrs.pin || m[1].startsWith('j-')) continue;
      if (kept.has(m[1])) die(`rewrite: {#${m[1]}} is kept twice`);
      kept.add(m[1]);
    }
    for (const b of bs) {
      const a = b.attrs ?? {};
      if (a.voice || a.pin || !a.id) continue;
      if (a.item === 'open' && !kept.has(a.id)) die(`rewrite: {#${a.id}} is an open item: a rewrite keeps every open item (“${textOf(b).slice(0, 60)}”)`);
      // a discussion survives its answer: an answered item stays, with its replies, until the writer ✓s or ✗s it
      if (a.item === 'answered' && !kept.has(a.id)) die(`rewrite: {#${a.id}} is answered but not yet ✓ or ✗: a rewrite keeps it, with its replies, until the writer decides (“${textOf(b).slice(0, 60)}”)`);
      if (kept.has(a.id) && a.thread && !kept.has(a.thread)) die(`rewrite: {#${a.id}} is a follow-up, kept without the item it follows ({#${a.thread}})`);
    }
    append({ op: 'rewrite', sheet, base, md: text, at: new Date().toISOString() });
    process.stdout.write(`rewrite of ${sheet} sent, from version ${base}, keeping ${kept.size} of the writer's block${kept.size === 1 ? '' : 's'}: pica puts the sheet as it was in the Archive; if it refuses, pending says why\n`);
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
  case 'resolve': {
    const [id, n, ...more] = args, k = Number(n) - 1;
    if (!id || !Number.isInteger(k) || k < 0) die('resolve needs a reply id and a reference number (from 1)');
    const e = new RefIndex(file('inbox.jsonl')).get(id);
    if (!e) die(`no reply ${id} with references in the inbox`);
    if (e.project !== PROJECT) die('that reply refers to another project\'s code');
    if (!e.refs[k]) die(`that reply has ${e.refs.length} reference${e.refs.length === 1 ? '' : 's'}`);
    const span = more.includes('--span') ? Number(more[more.indexOf('--span') + 1]) : 12;
    process.stdout.write(JSON.stringify(await resolveRef(e.refs[k], { view: more.includes('--then') ? 'then' : 'now', span }), null, 1) + '\n');
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
  case 'survey': await (await import('./survey.mjs')).main(args); break;
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
  case 'remember': {
    // a rule proposed as an item, ✓'d by the writer: its words, as they are on the sheet now, become a memory
    const [sheet, item, name] = args;
    if (!/^[a-z0-9][a-z0-9-]{1,59}$/.test(name ?? '')) die('remember <sheet> <item> <name>: the name is the memory file\'s, in lower-case-with-hyphens');
    const b = findItem(loadSheet(sheet), item);
    const agreed = (() => { try { return fs.readFileSync(file('outbox.jsonl'), 'utf8').split('\n').some(l => { try { const o = JSON.parse(l); return o.op === 'agree' && o.sheet === sheet && o.item === item; } catch { return false; } }); } catch { return false; } })();
    if (!agreed || b.attrs.item !== 'done') die('the writer has not ✓\'d that item: a rule becomes a memory only once they agree');
    const words = inline(b).trim();
    if (!words) die('that item is empty');
    const secret = secretIn(words); if (secret) die(`refused: the item holds what looks like ${secret}`);
    const f = name + '.md';
    if (fs.existsSync(path.join(MEM, f))) die(`a memory ${f} exists already: choose another name, or amend that one`);
    fs.mkdirSync(MEM, { recursive: true });
    const desc = words.replace(/\s+/g, ' ').slice(0, 150);
    fs.writeFileSync(path.join(MEM, f), `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\nmetadata:\n  type: project\n---\n\n${words}\n\nAgreed in the journal (${sheet}#${item}).\n`);
    const idx = path.join(MEM, 'MEMORY.md');
    let was = ''; try { was = fs.readFileSync(idx, 'utf8'); } catch {}
    fs.writeFileSync(idx, (was && !was.endsWith('\n') ? was + '\n' : was) + `- [${name}](${f}) — ${desc.slice(0, 100)}\n`);
    process.stdout.write(`remembered in ${path.join(MEM, f)}\n`);
    mirror();
    break;
  }
  case 'memory': {
    const home = os.homedir();
    const project = gitRoot(ROOT) ?? ROOT;
    // the project and each folder above it, up to the home folder or the root (never either)
    const cands = [];
    for (let at = project; at !== home && at !== path.dirname(at); at = path.dirname(at)) cands.push(at);
    const count = (d) => { try { return fs.readdirSync(memoryOf(d)).filter(n => n.endsWith('.md') && n !== 'MEMORY.md').length; } catch { return 0; } };
    if (args[0]) {
      const want = args[0] === '--project' ? project : path.resolve(args[0]);
      if (!cands.includes(want)) die(`memory: ${want} is neither the project nor a folder above it (never the home folder)`);
      const before = MEM;
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(MEMORY_SETTING, JSON.stringify({ folder: want }) + '\n');
      const after = memoryOf(want);
      if (after !== before && !process.env.CLAUDE_MEMORY_DIR) {
        // the memory sheets pica holds are of the old folder: tell pica they are gone, and mirror the new one fresh
        const out = file('memory');
        try { for (const f of fs.readdirSync(out).filter(f => f.endsWith('.md') && f !== 'MEMORY.md')) append({ op: 'memory', sheet: sheetOfFile(f), name: f.slice(0, -3), md: '', gone: true }); } catch {}
        fs.rmSync(out, { recursive: true, force: true });
        try { fs.rmSync(file('.mirror-refused')); } catch {}
      }
      process.stdout.write(`memory: ${after} (${count(want)} memories), for sessions started in ${want}; run pica-journal mirror next\n`);
      break;
    }
    process.stdout.write(`memory ${MEM}${process.env.CLAUDE_MEMORY_DIR ? ' (from $CLAUDE_MEMORY_DIR)' : fs.existsSync(MEMORY_SETTING) ? ' (recorded)' : ' (the project\'s, not recorded)'}\n`);
    for (const c of cands) process.stdout.write(`candidate ${c}\t${count(c)} memories${memoryOf(c) === MEM ? '\t(in use)' : ''}\n`);
    break;
  }
  default:
    process.stderr.write('usage: pica-journal pending | ack <n> | read <sheet> | sheets | where | init | reading <sheet> <item>... | reply [--awaits] [--replace] [--blocked] [--offer <label>]... [--state <marks>] [--phase <n/total>] [--ref <path[:a-b]|path#sym> [--why <text>]]... [--detail <md|@file>] <sheet> <item> [md] | resolve <reply-id> <n> [--then] [--span 40] | recast <sheet> <item> [md] | pin <sheet> [md] | sheet <title> [md] | rewrite --base <version> <sheet> [md] | state <sheet> <item> <state> | survey [--transcripts] [--since <commit>] | survey transcript <session> [--files a,b] [--from <n>] | mirror | adopt <amend-id> | forget <mem-sheet> | remember <sheet> <item> <name> | memory [<folder>|--project]\n');
    process.exit(cmd ? 1 : 0);
}
