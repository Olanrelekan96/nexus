'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.resolve(__dirname, '..');

function read(rel){ return fs.readFileSync(path.join(root, rel), 'utf8'); }
function extract(source, startSig, endSig){
  const start = source.indexOf(startSig);
  assert.ok(start >= 0, `missing ${startSig}`);
  const end = source.indexOf(endSig, start);
  assert.ok(end >= 0, `missing ${endSig}`);
  return source.slice(start, end);
}
function makeCoreContext(){
  const core = read('js/00-state-and-helpers.js');
  const ctx = {
    Promise, JSON, Date, Math, Uint8Array, console,
    window: {crypto:null},
    localStorage: {getItem(){return null;}, setItem(){}, removeItem(){}},
    navigator: {},
    document: {},
    setTimeout, clearTimeout
  };
  vm.createContext(ctx);
  vm.runInContext(core, ctx, {filename:'phase6-core.js'});
  return ctx;
}

function testNormalizeRepairsAdversarialGraph(){
  const ctx = makeCoreContext();
  const bad = {
    pages:{
      p1:{id:'p1',title:'One',type:'page',properties:[],rootBlocks:[]},
      p2:{id:'p2',title:'Two',type:'page',properties:[],rootBlocks:[]}
    },
    blocks:{
      b1:{id:'b1',pageId:'p1',parent:'b2',text:'one',children:[]},
      b2:{id:'b2',pageId:'p1',parent:'b1',text:'two',children:[]},
      b3:{id:'b3',pageId:'p2',parent:'b1',text:'cross-page',children:[]},
      b4:{id:'b4',pageId:'missing',parent:null,text:'fallback',children:[]}
    },
    folders:{
      f1:{id:'f1',name:'A',parentId:'f2'},
      f2:{id:'f2',name:'B',parentId:'f1'},
      f3:{id:'f3',name:'C',parentId:'missing'}
    }
  };
  const normalized = ctx.normalizeState(bad);
  assert.ok(normalized.deviceId, 'normalized state should receive a device id');
  assert.strictEqual(normalized.blocks.b3.parent, null, 'cross-page block parent must be detached');
  assert.strictEqual(normalized.blocks.b4.pageId, 'p1', 'block with missing page should attach to fallback page');
  assert.ok(normalized.blocks.b1.parent === null || normalized.blocks.b2.parent === null, 'parent cycle must be broken');
  assert.ok(!normalized.pages.p1.rootBlocks.includes('b3'), 'cross-page block must not enter wrong page roots');
  assert.ok(normalized.pages.p1.rootBlocks.includes('b4'), 'fallback block should be rebuilt into page roots');
  assert.strictEqual(normalized.folders.f3.parentId, null, 'folder pointing at missing parent must be detached');
  assert.ok(normalized.folders.f1.parentId === null || normalized.folders.f2.parentId === null, 'folder cycle must be broken');
  Object.keys(normalized.blocks).forEach(id => {
    const b = normalized.blocks[id];
    if (b.parent) assert.strictEqual(normalized.blocks[b.parent].pageId, b.pageId, `parent ${id} must remain in same page`);
  });
}

async function testPersistQueueSerializesWrites(){
  const core = read('js/00-state-and-helpers.js');
  const queueFn = extract(core, 'function enqueueNotebookPersist(json, keyOverride)', '\nfunction save(');
  const writes = [];
  let resolveFirst;
  const ctx = {Promise, putNotebookState(json, key){
    writes.push({json, key});
    if (writes.length === 1) return new Promise(resolve => { resolveFirst = resolve; });
    return Promise.resolve();
  }};
  vm.createContext(ctx);
  vm.runInContext('var persistQueue = Promise.resolve();\n' + queueFn + '\nthis.q={enqueueNotebookPersist};', ctx);
  const first = ctx.q.enqueueNotebookPersist('first', 'k1');
  const second = ctx.q.enqueueNotebookPersist('second', 'k2');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(writes.map(x => x.json), ['first'], 'second write must not start before first finishes');
  resolveFirst();
  await Promise.all([first, second]);
  assert.deepStrictEqual(writes.map(x => x.json), ['first','second'], 'queued writes must complete in submission order');
  assert.deepStrictEqual(writes.map(x => x.key), ['k1','k2'], 'key overrides must remain paired with their writes');
}

function testMergeDeterminismAndTombstones(){
  const ctx = makeCoreContext();
  const base = ctx.normalizeState({
    pages:{p:{id:'p',title:'Shared',type:'page',properties:[],rootBlocks:['b']}},
    blocks:{b:{id:'b',pageId:'p',parent:null,text:'base',children:[]}},
    currentPageId:'p', deviceId:'A', tombstones:{pages:{},blocks:{}}, templates:{},
    flashcards:{decks:{},cards:{}}, stickyNotes:{cards:{}}, folders:{}
  });
  const local = JSON.parse(JSON.stringify(base));
  const remote = JSON.parse(JSON.stringify(base));
  local.pages.p.updatedAt = 20; local.pages.p.updatedBy = 'A';
  remote.pages.p.updatedAt = 20; remote.pages.p.updatedBy = 'B';
  local.blocks.b.updatedAt = 30; local.blocks.b.updatedBy = 'A'; local.blocks.b.text = 'local';
  remote.blocks.b.updatedAt = 40; remote.blocks.b.updatedBy = 'B'; remote.blocks.b.text = 'remote';
  local.tombstones.blocks.b = 50;
  remote.tombstones.blocks.b = 50;

  const first = ctx.mergeStates(local, remote, 10);
  const second = ctx.mergeStates(remote, local, 10);
  assert.strictEqual(first.state.pages.p.title, 'Shared', 'page tie should retain identical content');
  assert.ok(!first.state.blocks.b, 'equal or newer tombstone must suppress the live block');
  assert.ok(!second.state.blocks.b, 'merge must converge regardless of local/remote argument order');
  assert.deepStrictEqual(first.state.tombstones, second.state.tombstones, 'tombstones must converge deterministically');

  const conflictLocal = JSON.parse(JSON.stringify(base));
  const conflictRemote = JSON.parse(JSON.stringify(base));
  conflictLocal.blocks.b.text = 'A edit';
  conflictRemote.blocks.b.text = 'B edit';
  conflictLocal.blocks.b.updatedAt = 200; conflictLocal.blocks.b.updatedBy = 'A';
  conflictRemote.blocks.b.updatedAt = 210; conflictRemote.blocks.b.updatedBy = 'B';
  const conflict = ctx.mergeStates(conflictLocal, conflictRemote, 100);
  assert.strictEqual(conflict.conflicts.length, 1, 'two post-sync edits to the same block should surface one conflict');
  assert.strictEqual(conflict.state.blocks.b.text, 'B edit', 'newer block edit should be retained');
  assert.strictEqual(conflict.state.blocks.b.conflict.droppedText, 'A edit', 'dropped conflict content should remain recoverable');
}

function testReleaseAssetsAndPwaParity(){
  const index = read('index.html');
  const manifest = JSON.parse(read('manifest.json'));
  const sw = read('sw.js').trim();
  const pwa = read('js/12-pwa.js');
  const pkg = JSON.parse(read('package.json'));

  assert.strictEqual(pkg.version, '1.0.0-rc6', 'Phase 6 release candidate version must be aligned');
  assert.ok(index.includes('phase8-offline-first-drive-v1-phase9-master-takeover-v2'), 'Phase 7 build marker missing');
  assert.ok(sw.includes("var CACHE='nexus-shell-v11';"), 'service worker cache must be current release');
  assert.ok(pwa.includes("var CACHE='nexus-shell-v11';"), 'embedded service worker source must be current release');
  assert.ok(pwa.includes('var NEXUS_SW_SOURCE ='), 'embedded service worker source missing');

  const localRefs = [];
  for (const m of index.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const ref = m[1].split('?')[0];
    if (!/^[a-z][a-z0-9+.-]*:|^\/\//i.test(ref) && ref) localRefs.push(ref);
  }
  for (const ref of localRefs) assert.ok(fs.existsSync(path.join(root, ref)), `missing local asset referenced by index.html: ${ref}`);

  for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(root, icon.src)), `manifest icon missing: ${icon.src}`);
  assert.ok(fs.existsSync(path.join(root, 'sw.js')), 'companion service worker missing');

  const swShell = [...sw.matchAll(/var SHELL=\[([\s\S]*?)\];/g)][0];
  assert.ok(swShell, 'service-worker shell declaration missing');
  const shellRefs = [...swShell[1].matchAll(/'([^']+)'/g)].map(m => m[1].split('?')[0]);
  for (const ref of shellRefs) assert.ok(fs.existsSync(path.join(root, ref.replace(/^\.\//,''))), `service-worker shell asset missing: ${ref}`);

  const cacheMatch = pwa.match(/var CACHE='([^']+)'/);
  assert.ok(cacheMatch && cacheMatch[1] === 'nexus-shell-v11', 'embedded PWA cache id must match sw.js');
  for (const ref of shellRefs) assert.ok(pwa.includes(ref) || pwa.includes(ref + '?'), `embedded PWA shell is missing: ${ref}`);
}

function testLargeGraphNormalization(){
  const ctx = makeCoreContext();
  const pages = {}, blocks = {};
  const PAGE_COUNT = 40, BLOCKS_PER_PAGE = 250;
  for(let p=0;p<PAGE_COUNT;p++){
    const pid = `p${p}`;
    pages[pid] = {id:pid,title:`Page ${p}`,type:'page',properties:[],rootBlocks:[]};
    let prev = null;
    for(let i=0;i<BLOCKS_PER_PAGE;i++){
      const id = `b${p}_${i}`;
      blocks[id] = {id,pageId:pid,parent:prev,text:`item ${p}-${i}`,children:[]};
      if(!prev) pages[pid].rootBlocks.push(id);
      prev = id;
    }
  }
  const started = Date.now();
  const out = ctx.normalizeState({pages,blocks,currentPageId:'p0',deviceId:'stress',tombstones:{pages:{},blocks:{}},templates:{},flashcards:{decks:{},cards:{}},stickyNotes:{cards:{}},folders:{}});
  const elapsed = Date.now() - started;
  assert.strictEqual(Object.keys(out.blocks).length, PAGE_COUNT * BLOCKS_PER_PAGE, 'large normalization must retain every valid block');
  assert.strictEqual(Object.keys(out.pages).length, PAGE_COUNT, 'large normalization must retain every valid page');
  assert.ok(elapsed < 2500, `large notebook normalization unexpectedly slow: ${elapsed}ms`);
}

(async function(){
  testNormalizeRepairsAdversarialGraph();
  await testPersistQueueSerializesWrites();
  testMergeDeterminismAndTombstones();
  testReleaseAssetsAndPwaParity();
  testLargeGraphNormalization();
  console.log('Phase 6 acceptance tests passed: adversarial normalization repairs safely, persistence writes serialize, sync merges converge, release assets/PWA shell are complete, and a 10k-block notebook normalizes within the resilience budget.');
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
