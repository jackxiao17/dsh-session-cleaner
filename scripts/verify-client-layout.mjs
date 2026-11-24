import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const match = source.match(/const CSS = `([\s\S]*?)`;/);
assert.ok(match, 'client stylesheet must exist');
const css = match[1];

function declarations(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = css.match(new RegExp(`(?:^|\\n)${escaped}\\{([^}]*)\\}`));
  assert.ok(rule, `missing CSS rule: ${selector}`);
  return rule[1].split(';').map((part) => part.trim()).filter(Boolean);
}

function has(selector, declaration) {
  return declarations(selector).includes(declaration);
}

const wide = declarations('.scl-footerSlot');
assert.ok(wide.includes('flex:1 1 auto'), 'wide recycle-bin slot must fill remaining footer space');
assert.ok(wide.includes('min-width:0'), 'wide recycle-bin slot must be allowed to shrink beside theme toggle');
assert.ok(!wide.some((item) => item.startsWith('width:100%')), 'wide recycle-bin slot must not claim the whole footer row');
assert.ok(!wide.includes('flex:0 0 auto'), 'wide recycle-bin slot must not shrink to its label width');

const rail = declarations('.scl-railOnly');
assert.ok(rail.includes('flex:0 0 36px'), 'collapsed recycle-bin slot must keep its 36px rail footprint');
assert.ok(rail.includes('width:36px'), 'collapsed recycle-bin slot must stay centered in the rail');

assert.ok(has('.scl-footerBtnRail', 'width:36px'), 'collapsed recycle-bin button must remain 36px');
assert.ok(has('.scl-footerBtnRail', 'min-width:36px'), 'collapsed recycle-bin button must not shrink');

console.log('client layout: 8 passed / 0 failed');
