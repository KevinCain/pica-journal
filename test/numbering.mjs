// node test/numbering.mjs: the plugin's numbering against the shared sample sheets
import fs from 'node:fs';
import { numberItems } from '../lib/numbering.mjs';
export function check(numberItems) {
  const { cases } = JSON.parse(fs.readFileSync(new URL('./numbering.json', import.meta.url), 'utf8'));
  let bad = 0;
  for (const c of cases) for (const [style, want] of Object.entries(c.labels)) {
    const got = numberItems(c.blocks, style).map(p => p?.label ?? null);
    if (JSON.stringify(got) !== JSON.stringify(want)) { bad++; console.log(`✗ ${c.name} (${style})\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}`); }
  }
  console.log(bad ? `${bad} failed` : `numbering: ${cases.length} sheets agree`);
  return bad;
}
if (import.meta.url === `file://${process.argv[1]}`) process.exit(check(numberItems) ? 1 : 0);
