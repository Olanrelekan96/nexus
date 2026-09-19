const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const jsDir = path.join(root, 'js');
const jsFiles = fs.readdirSync(jsDir).filter(f => f.endsWith('.js')).sort();

for (const file of jsFiles) {
  const full = path.join(jsDir, file);
  const r = cp.spawnSync(process.execPath, ['--check', full], {encoding:'utf8'});
  assert.strictEqual(r.status, 0, `${file} failed syntax validation:\n${r.stderr}`);
}

const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert.strictEqual((index.match(/<body>/g) || []).length, 1, 'index.html must contain exactly one <body>');
assert.strictEqual((index.match(/<\/body>/g) || []).length, 1, 'index.html must contain exactly one </body>');
assert.ok(!/AIza[\w-]{20,}/.test(index), 'index.html must not ship a live Google API key');
assert.ok(!/AIza[\w-]{20,}/.test(fs.readFileSync(path.join(root,'js','06-backup-sync.js'),'utf8')), 'backup/sync code must not embed a live Google API key');
assert.ok(index.includes('gdrive-api-key-input'), 'Google Drive API key must be configurable at runtime');
assert.ok(index.includes('data-health-overlay'), 'Data health UI must be present');
assert.ok(index.includes('nexus-build" content="2026-09-19-quality-hardening-v1"'), 'quality build marker missing');
const core = fs.readFileSync(path.join(root,'js','00-state-and-helpers.js'),'utf8');
assert.ok(core.includes('NEXUS_HELP_GUIDE_VERSION = 2'), 'complete Help guide version missing');
assert.ok(core.includes('ensureCompleteHelpGuide(docsId)'), 'existing Help pages must receive the complete guide update');
for (const phrase of [
  'Slash commands',
  'Context menus & selection tools',
  'Advanced search language',
  'Task manager — advanced',
  'Locks & read-only protection',
  'Data health & diagnostics',
  'Google Drive sync & credentials',
  'LAN device sync',
  'PWA / install / offline',
  'Mobile editing'
]) {
  assert.ok(core.includes('section("' + phrase + '"'), `Help guide section missing: ${phrase}`);
}


const css = fs.readFileSync(path.join(root,'css','styles.css'), 'utf8');
assert.ok(css.includes('#nexus-health-chip'), 'health chip CSS missing');
assert.ok(css.includes('.quality-modal'), 'data health modal CSS missing');

console.log(`Nexus smoke tests passed: ${jsFiles.length} JavaScript files syntax-checked; security/markup/UI guards passed.`);

const vm = require('vm');
const coreSource = fs.readFileSync(path.join(root,'js','00-state-and-helpers.js'),'utf8');
const ctx = {
  window: {crypto: {
    randomUUID: () => '12345678-1234-1234-1234-123456789abc'
  }},
  console, setTimeout, clearTimeout, Promise, JSON, Math, Date,
  Uint8Array, Array, Object, String, Number, RegExp, Error,
  localStorage: {getItem:()=>null,setItem:()=>{},removeItem:()=>{}},
  document: {}, indexedDB: {}, navigator: {}
};
vm.createContext(ctx);
vm.runInContext(coreSource, ctx, {filename:'00-state-and-helpers.js'});
assert.ok(/^b[0-9a-f]{32}$/.test(ctx.uid()), 'uid() should use a CSPRNG-backed stable ID format');

const makeState = (device, order) => ({
  pages: {p: {id:'p',title:'P',type:'page',createdAt:1,updatedAt:device==='B'?3:1,updatedBy:device,properties:[],rootBlocks:order.slice()}},
  blocks: {
    a:{id:'a',pageId:'p',parent:null,text:'A',children:[],updatedAt:1,updatedBy:device},
    b:{id:'b',pageId:'p',parent:null,text:'B',children:[],updatedAt:1,updatedBy:device},
    c:{id:'c',pageId:'p',parent:null,text:'C',children:[],updatedAt:device==='A'?2:1,updatedBy:device}
  },
  tombstones:{pages:{},blocks:{}},templates:{},currentPageId:'p',dailyShowAll:false,deviceId:device,syncPeers:{}
});
const ma = makeState('A',['a','b','c']);
const mb = makeState('B',['b','a','c']);
const merged = ctx.mergeStates(JSON.parse(JSON.stringify(ma)), JSON.parse(JSON.stringify(mb)), null).state;
assert.ok(merged.pages.p.rootBlocks.length === 3, 'merge must retain all root blocks');
assert.strictEqual(JSON.stringify(merged.pages.p.rootBlocks), JSON.stringify(['b','a','c']), 'merge must converge on the winning page container order');
