// The numbers of the journal's items: the same rule as pica's src/numbering.ts, so `read` shows Claude the
// numbers the writer sees. Both are checked against test/numbering.json (node test/numbering.mjs here;
// tools/check-numbering.mjs in pica).
//
// A list is a run of items of the outline. Claude's replies and the writer's follow-ups inside it neither count
// nor break it; any other block ends it, and the next list starts at 1. An item nested deeper than one below
// the item above it counts as one below (its level is how many open items above it are
// shallower).

export const NUMBERS = ['off', '1', '1.1', 'A.1'];
const alpha = (n, a) => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(a + (n - 1) % 26) + s; return s; };
const ROMAN = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
const roman = n => { let s = ''; for (const [v, r] of ROMAN) for (; n >= v; n -= v) s += r; return s; };

/** an item's label from the counts of its level and the levels above it */
export function label(path, style) {
  const l = path.length - 1, n = path[l];
  if (style === 'off') return undefined;
  if (style === '1') return (l % 3 === 0 ? String(n) : l % 3 === 1 ? alpha(n, 97) : roman(n)) + '.';
  const parts = path.map((k, i) => i === 0 && style === 'A.1' ? alpha(k, 65) : String(k));
  return l === 0 ? parts[0] + '.' : parts.join('.');
}
/** blocks: [{kind: 'item', depth} | {kind: 'thread'} | {kind: 'other'}]; every block's place, or null */
export function numberItems(blocks, style) {
  const out = [];
  let list = -1, open = false, path = [], level = -1, above = [];
  for (const b of blocks) {
    if (b.kind === 'other') { open = false; out.push(null); continue; }
    if (b.kind === 'thread') { out.push(open ? { list, level } : null); continue; }
    if (!open) { open = true; list++; path = []; above = []; }
    // its level: how many items above it are open and shallower (the depths of its ancestors)
    while (above.length && above[above.length - 1] >= b.depth) above.pop();
    level = above.length; above.push(b.depth);
    path = path.slice(0, level + 1);
    path[level] = (path[level] ?? 0) + 1;
    out.push({ list, level, label: label(path, style), n: path[level] });
  }
  return out;
}
/** a sheet's blocks as numbering sees them */
export const entryOf = b => { const a = b.attrs ?? {}; return b.type !== 'paragraph' ? { kind: 'other' } : a.voice === 'claude' || a.item && a.thread ? { kind: 'thread' } : a.item ? { kind: 'item', depth: a.depth ?? 0 } : { kind: 'other' }; };
