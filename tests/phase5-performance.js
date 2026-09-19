'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
function extractFunction(source, signature, nextSignature){
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing ${signature}`);
  const end = source.indexOf(nextSignature, start);
  assert.ok(end >= 0, `missing boundary ${nextSignature}`);
  return source.slice(start, end);
}

function makeSearchContext(){
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
  vm.runInContext(coreExtract + '\n' + search + '\nthis.searchApi={computePageRefsMap,invalidatePageRefsMapCache};', ctx, {filename:'phase5-search.js'});
  return ctx;
}

function testReferenceIndexCache(){
  const ctx = makeSearchContext();
  ctx.state.pages = {p1:{id:'p1',title:'One'}};
  ctx.state.blocks = {
    b1:{id:'b1',pageId:'p1',text:'#alpha [[Beta]]'},
    b2:{id:'b2',pageId:'p1',text:'#gamma'}
  };
  let extractCount = 0;
  const originalExtract = ctx.extractRefs;
  ctx.extractRefs = function(text){ extractCount++; return originalExtract(text); };

  const first = ctx.searchApi.computePageRefsMap();
  assert.strictEqual(extractCount, 2, 'initial derived index should inspect each block once');
  const second = ctx.searchApi.computePageRefsMap();
  assert.strictEqual(extractCount, 2, 'repeated derived-index reads should reuse the cached map');
  assert.strictEqual(first, second, 'cached page-reference map should keep the same object during one state epoch');

  ctx.searchApi.invalidatePageRefsMapCache();
  const third = ctx.searchApi.computePageRefsMap();
  assert.strictEqual(extractCount, 4, 'explicit cache invalidation should rebuild the derived index');
  assert.notStrictEqual(third, second, 'invalidated derived-index reads should produce a fresh map');
}

function testSortPrecomputesPropertyValues(){
  const source = fs.readFileSync(path.join(root, 'js', '01-query-engine.js'), 'utf8');
  const sortFn = extractFunction(source, 'function sortPages(pages, sortKey, desc)', '/* Blocks matching every filter');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(sortFn + '\nthis.sortPages=sortPages;', ctx, {filename:'phase5-sort.js'});

  let keyReads = 0;
  const pages = [];
  for(let i=0;i<1200;i++){
    const props = [];
    for(let j=0;j<4;j++){
      const obj = {};
      Object.defineProperty(obj, 'key', {get(){ keyReads++; return 'noise' + j; }});
      obj.value = String((1200-i) % 97);
      props.push(obj);
    }
    const target = {};
    Object.defineProperty(target, 'key', {get(){ keyReads++; return 'rank'; }});
    target.value = String(i);
    props.push(target);
    pages.push({id:'p'+i,title:'Page '+i,properties:props});
  }

  const sorted = ctx.sortPages(pages, 'rank', false);
  assert.strictEqual(sorted.length, pages.length, 'sorting should preserve the full page set');
  for(let i=1;i<sorted.length;i++){
    const a = Number(sorted[i-1].properties[4].value);
    const b = Number(sorted[i].properties[4].value);
    assert.ok(a <= b, 'sorted pages should remain ascending by the requested property');
  }
  assert.ok(keyReads <= pages.length * 5, `property keys should be read once per page/property scan, observed ${keyReads}`);
  assert.notStrictEqual(sorted, pages, 'sorting should return a new array');
}

function testReleaseContracts(){
  const state = fs.readFileSync(path.join(root, 'js', '00-state-and-helpers.js'), 'utf8');
  const search = fs.readFileSync(path.join(root, 'js', '17-advanced-search.js'), 'utf8');
  const query = fs.readFileSync(path.join(root, 'js', '01-query-engine.js'), 'utf8');
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(search.includes('var pageRefsMapCache = {state:null, map:null};'), 'derived reference cache contract missing');
  assert.ok(search.includes('function invalidatePageRefsMapCache()'), 'derived reference cache invalidator missing');
  assert.ok(state.includes('invalidatePageRefsMapCache()'), 'state mutation paths must invalidate derived search cache');
  assert.ok(query.includes('var decorated = pages.map(function(p){'), 'database sort should decorate/precompute page values');
  assert.ok(sw.includes("var CACHE='nexus-shell-v11';"), 'production shell cache must remain version-aligned');
}

try{
  testReferenceIndexCache();
  testSortPrecomputesPropertyValues();
  testReleaseContracts();
  console.log('Phase 5 performance tests passed: derived search index is cached safely, database sorting precomputes property values, and release contracts remain aligned.');
}catch(err){
  console.error(err.stack || err);
  process.exitCode = 1;
}
