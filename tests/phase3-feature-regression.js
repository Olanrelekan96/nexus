const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.resolve(__dirname, '..');

function extractFunction(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing ${signature}`);
  const end = source.indexOf(nextSignature, start);
  assert.ok(end >= 0, `missing boundary ${nextSignature}`);
  return source.slice(start, end);
}

function testQueryBuilderViewIsolation() {
  const source = fs.readFileSync(path.join(root, 'js', '01-query-engine.js'), 'utf8');
  const helper = extractFunction(source, 'function cloneDbViewDirs', 'function qbQuoteIfNeeded');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(helper + '\nthis.cloneDbViewDirs = cloneDbViewDirs;', ctx, {filename:'phase3-query-builder.js'});

  const original = {view:'board', sort:'title', sortDesc:false, group:'status', cols:['status','due'], agg:{due:'count'}};
  const copy = ctx.cloneDbViewDirs(original);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(copy)), original, 'saved view clone must preserve all directives');
  copy.cols.push('owner');
  copy.agg.due = 'sum';
  assert.deepStrictEqual(original.cols, ['status','due'], 'editing cloned columns must not mutate the live saved view');
  assert.strictEqual(original.agg.due, 'count', 'editing cloned aggregates must not mutate the live saved view');

  assert.ok(source.includes('qbView = cloneDbViewDirs(qbActiveView.dirs);'), 'query builder must edit an isolated saved-view copy');
  assert.ok(source.includes('qbViewToSave.dirs = cloneDbViewDirs(qbView);'), 'query builder must commit the saved-view copy only on Save');
  assert.ok(!source.includes('qbView = qbActiveView.dirs;'), 'query builder must not retain the old live-reference behavior');
}

function makeSearchContext() {
  const core = fs.readFileSync(path.join(root, 'js', '00-state-and-helpers.js'), 'utf8');
  const coreExtract = extractFunction(core, 'function extractRefs(text)', 'var BLOCKREF_RE');
  const search = fs.readFileSync(path.join(root, 'js', '17-advanced-search.js'), 'utf8');
  const ctx = {
    console,
    state: {blocks:{}, pages:{}},
    todoInfo(){ return null; },
    splitTodoDue(){ return {due:null}; },
    taskPriOf(){ return 0; },
    taskRepOf(){ return null; },
    blockIsLocked(){ return false; },
    pageIsLocked(){ return false; },
    ymd(){ return '2026-01-01'; },
    startOfToday(){ return new Date('2026-01-01T00:00:00Z'); },
    parseDueWord(){ return null; },
    fuzzyMatchScore(term, text){
      term = String(term || '').toLowerCase();
      text = String(text || '').toLowerCase();
      return text.indexOf(term) >= 0 ? term.length + 1 : 0;
    }
  };
  vm.createContext(ctx);
  vm.runInContext(coreExtract + '\n' + search + '\nthis.searchApi = {extractRefs,extractSearchRefLists,searchRecordForBlock,searchRecordForTask,computePageRefsMap,parseAdvancedQuery,advancedQueryMatch};', ctx, {filename:'phase3-advanced-search.js'});
  return ctx;
}

function testAdvancedSearchReferenceSemantics() {
  const ctx = makeSearchContext();
  const rec = ctx.searchApi.searchRecordForBlock({text:'#alpha [[Beta]]'}, {id:'p1',title:'Source'});
  assert.deepStrictEqual(JSON.parse(JSON.stringify(rec.tagsLower)), ['alpha'], 'tag index must contain tags only');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(rec.pagesLower)), ['beta'], 'page-link index must contain page links only');
  assert.strictEqual(ctx.searchApi.advancedQueryMatch('#alpha', rec).match, true, '#tag must match its own tag reference');
  assert.strictEqual(ctx.searchApi.advancedQueryMatch('#beta', rec).match, false, '#tag must not match a page link');
  assert.strictEqual(ctx.searchApi.advancedQueryMatch('[[Beta]]', rec).match, true, '[[Page]] must match its own page reference');
  assert.strictEqual(ctx.searchApi.advancedQueryMatch('[[alpha]]', rec).match, false, '[[Page]] must not match a tag reference');

  ctx.state.pages = {p1:{id:'p1',title:'Source'}, p2:{id:'p2',title:'Other'}};
  ctx.state.blocks = {b1:{id:'b1',pageId:'p1',text:'#alpha [[Beta]]'}, b2:{id:'b2',pageId:'p2',text:'#beta'}};
  const map = ctx.searchApi.computePageRefsMap();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(map.p1.tagsLower)), ['alpha']);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(map.p1.pagesLower)), ['beta']);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(map.p2.tagsLower)), ['beta']);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(map.p2.pagesLower)), []);
}

function testZettelkastenConnectionSemantics() {
  const core = fs.readFileSync(path.join(root, 'js', '00-state-and-helpers.js'), 'utf8');
  const coreExtract = extractFunction(core, 'function extractRefs(text)', 'var BLOCKREF_RE');
  const zettel = fs.readFileSync(path.join(root, 'js', '28-zettelkasten.js'), 'utf8');
  const pages = {
    p1:{id:'p1',title:'One',zettel:{type:'permanent',tags:[]},rootBlocks:[]},
    p2:{id:'p2',title:'Two',zettel:{type:'permanent',tags:[]},rootBlocks:[]},
    p3:{id:'p3',title:'Three',zettel:{type:'permanent',tags:[]},rootBlocks:[]}
  };
  const ctx = {
    console,
    __testState:{pages,blocks:{}},
    document: undefined
  };
  vm.createContext(ctx);
  const helpers = `
    var state = __testState;
    function livePages(){ return Object.keys(state.pages).map(function(id){ return state.pages[id]; }); }
    function findPageByTitle(title){
      var key = String(title || '').toLowerCase();
      return Object.keys(state.pages).map(function(id){ return state.pages[id]; }).filter(function(p){ return p.title.toLowerCase() === key; })[0] || null;
    }
    function uid(){ return 'uid0001'; }
    function mkBlock(id,pageId,parent,text){ return {id:id,pageId:pageId,parent:parent,text:text,children:[]}; }
    function save(){}
    function renderPage(){}
    function toast(){}
  `;
  vm.runInContext(helpers + '\n' + coreExtract + '\n' + zettel + '\nthis.zettelApi={zettelRelatedPages,invalidateZettelConnections};', ctx, {filename:'phase3-zettelkasten.js'});
  let related = ctx.zettelApi.zettelRelatedPages(ctx.state.pages.p1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(related)), [], 'unrelated Zettels must remain unconnected');

  // A tag whose text matches another Zettel title is not a page link.
  ctx.state.pages.p2.title = 'research';
  ctx.state.blocks = {b1:{id:'b1',pageId:'p1',text:'#research'}};
  ctx.zettelApi.invalidateZettelConnections();
  related = ctx.zettelApi.zettelRelatedPages(ctx.state.pages.p1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(related)), [], 'Zettelkasten links must not be created from #tags');

  // A genuine wiki page link must still create the connection.
  ctx.state.blocks = {b1:{id:'b1',pageId:'p2',text:'[[One]]'}};
  ctx.zettelApi.invalidateZettelConnections();
  related = ctx.zettelApi.zettelRelatedPages(ctx.state.pages.p1);
  assert.strictEqual(related.length, 1);
  assert.strictEqual(related[0].page.id, 'p2', 'a genuine backlink should still produce a related note');
}

function testPhase3Contracts() {
  const core = fs.readFileSync(path.join(root, 'js', '00-state-and-helpers.js'), 'utf8');
  const search = fs.readFileSync(path.join(root, 'js', '17-advanced-search.js'), 'utf8');
  const zettel = fs.readFileSync(path.join(root, 'js', '28-zettelkasten.js'), 'utf8');
  assert.ok(/NEXUS_HELP_GUIDE_VERSION\s*=\s*32/.test(core), 'Help guide must advance with Phase 3 user-visible behavior repairs');
  assert.ok(search.includes('r.type === \'tag\''), 'advanced search must explicitly classify tag references');
  assert.ok(search.includes('r.type === \'page\''), 'advanced search must explicitly classify page references');
  assert.ok(zettel.includes("if(r.type !== 'page') return;"), 'Zettelkasten connection indexing must ignore tag references');
}

(async function(){
  testQueryBuilderViewIsolation();
  testAdvancedSearchReferenceSemantics();
  testZettelkastenConnectionSemantics();
  testPhase3Contracts();
  console.log('Phase 3 feature regression tests passed: saved-view edits are transactional; tag/page search semantics are distinct; Zettelkasten connections distinguish page links from tags.');
})().catch(function(err){
  console.error(err.stack || err);
  process.exitCode = 1;
});
