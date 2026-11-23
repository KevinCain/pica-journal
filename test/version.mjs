#!/usr/bin/env node
// lib/version.mjs against pica's own: one fixture, one version, held in both tests (pica's tools/check-rewrite.mjs)
//   node test/version.mjs
import { sheetVersion } from '../lib/version.mjs';
let fails = 0, passes = 0;
const ok = (c, what) => { if (c) passes++; else { fails++; console.log('FAIL', what); } };
const FIX = { type: 'doc', content: [{ type: 'heading', attrs: { level: 1, id: 'h' }, content: [{ type: 'text', text: 'Title' }] },
  { type: 'paragraph', attrs: { id: 'a', item: 'answered', depth: 1 }, content: [{ type: 'text', text: 'An item, é ☞' }] },
  { type: 'paragraph', attrs: { id: 'r', voice: 'claude', of: 'a' }, content: [{ type: 'text', text: 'reply' }] }] };
ok(sheetVersion(FIX) === '0c76278fb61c9c', 'the shared fixture’s version, as pica has it: ' + sheetVersion(FIX));
// defaults written or left out (a v 1 file has them, a v 2 file not) give the same version
const full = structuredClone(FIX); full.content[0].attrs = { level: 1, id: 'h' }; full.content[1].attrs = { ...full.content[1].attrs, thread: null, pin: null, section: false, bullet: false, voice: null };
ok(sheetVersion(full) === sheetVersion(FIX), 'defaults written or left out: the same');
const sent = structuredClone(FIX); sent.content[1].attrs.item = 'sent';
ok(sheetVersion(sent) === sheetVersion(FIX), 'sent and answered: the same');
const reply = structuredClone(FIX); reply.content[2].content[0].text = 'another reply';
ok(sheetVersion(reply) === sheetVersion(FIX), 'Claude’s reply: not counted');
const edit = structuredClone(FIX); edit.content[1].content[0].text = 'An item, edited';
ok(sheetVersion(edit) !== sheetVersion(FIX), 'the writer’s edit: counted');
console.log(`version: ${passes} pass, ${fails} fail`);
process.exit(fails ? 1 : 0);
