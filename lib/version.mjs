// A sheet's version, worked out from its .pica file exactly as pica works it out from the page (pica's src/rewrite.ts,
// the same code: test/version.mjs and pica's tools/check-rewrite.mjs hold one fixture and its version, so the two
// never drift). What the writer has on the sheet: Claude's replies and the journal's own blocks ("j-") are left
// out, and an answered item counts as sent, so Claude answering an item leaves the version as it was; anything the
// writer changes does not. `rewrite --base` carries it, and pica refuses a rewrite whose base is not the sheet's now.

/** cyrb53: a quick 53-bit hash of a string (not for secrets: for telling two versions of a sheet apart) */
function cyrb53(s) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
/** the version of a sheet's document (the `doc` of its .pica file; a v 2 file leaves defaults out) */
export function sheetVersion(doc) {
  const rows = [];
  for (const b of doc?.content ?? []) {
    const a = b.attrs ?? {};
    if (a.voice === 'claude' || String(a.id ?? '').startsWith('j-')) continue;
    rows.push([b.type, b.type === 'heading' ? a.level || 1 : 0, a.id || '', a.item === 'answered' ? 'sent' : a.item || '', a.depth || 0,
      a.thread || '', a.pin || '', !!a.section, !!a.bullet, (b.content ?? []).map(x => x.text ?? '').join('')]);
  }
  return cyrb53(JSON.stringify(rows)).toString(16).padStart(14, '0');
}
/** the block pica leaves at the end of a rewritten sheet: when, the version it left, and a link to the sheet as it was */
export const REWRITE_ID = 'j-rewrite';
/** a block kept in a rewrite: a line of its own holding only {#id} */
export const KEEP = /^\{#([\w-]+)\}$/;
