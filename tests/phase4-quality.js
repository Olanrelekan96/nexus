'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'styles.css'), 'utf8');

function assert(cond, msg){ if(!cond) throw new Error(msg); }

// Interactive dialogs should expose a modal semantic to assistive tech.
for (const label of ['Command palette','Global search','Settings','Passcode settings','Recovery key unlock','Save recovery key','Sync devices','Find and replace','Query builder']) {
  assert(html.includes(`role="dialog" aria-modal="true" aria-label="${label}"`), `Missing dialog semantics: ${label}`);
}
assert(html.includes('id="page-title" contenteditable="true" spellcheck="false" aria-label="Page title"'), 'Page title is missing an accessible label');

// Visible credential/find-replace controls should have programmatic labels.
for (const label of ['Current passcode','New passcode','Confirm new passcode','Recovery key','This device\'s name','Find text','Replace with text']) {
  assert(html.includes(`aria-label="${label}"`), `Missing input label: ${label}`);
}

// Avoid executable javascript: URIs in generated navigation anchors.
const jsUriCount = (fs.readdirSync(path.join(root,'js'))
  .filter(f=>f.endsWith('.js'))
  .map(f=>fs.readFileSync(path.join(root,'js',f),'utf8'))
  .join('\n').match(/javascript:\s*void\s*\(\s*0\s*\)/g)||[]).length;
assert(jsUriCount === 0, `Found ${jsUriCount} javascript: URI placeholder(s)`);

// Quality layer should keep overlays usable on short/narrow viewports and respect reduced motion.
assert(css.includes('@media (prefers-reduced-motion:reduce)'), 'Reduced-motion rule missing');
assert(css.includes('max-height:calc(100dvh - max(20px'), 'Narrow modal max-height guard missing');
assert(css.includes('#page-title[contenteditable="true"]:focus-visible'), 'Editable focus-visible rule missing');

console.log('Phase 4 quality tests passed: dialogs/forms are labeled, editable surfaces are focus-visible, executable placeholder URIs are gone, and responsive quality guards are present.');
