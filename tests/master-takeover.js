'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

function extractFunction(source, signature, nextSignature){
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing ${signature}`);
  const end = source.indexOf(nextSignature, start);
  assert.ok(end >= 0, `missing boundary ${nextSignature}`);
  return source.slice(start, end);
}

function testProjectInventoryAndScriptOrder(){
  const index = read('index.html');
  const scripts = [...index.matchAll(/<script(?:[^>]*?)src="([^"]+)"/g)].map(m => m[1]);
  const localJs = scripts.filter(s => /^js\/[^?]+\.js(?:\?.*)?$/.test(s)).map(s => s.split('?')[0]);
  const expected = fs.readdirSync(path.join(root,'js'))
    .filter(f => f.endsWith('.js'))
    .sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}))
    .map(f=>'js/'+f);
  assert.strictEqual(new Set(localJs).size, expected.length, 'every shipped JS module should load exactly once');
  assert.deepStrictEqual([...new Set(localJs)].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})), expected, 'index.html must load the complete JS inventory');
  assert.ok(localJs.indexOf('js/14-wiring-and-init.js') > localJs.indexOf('js/34-sidebar-ui-ordering.js'), 'boot wiring must load after feature modules so its deferred initialization sees the complete application');
  assert.ok(localJs.indexOf('js/12-pwa.js') < localJs.indexOf('js/14-wiring-and-init.js'), 'PWA registration must be defined before boot wiring');
  assert.ok(fs.existsSync(path.join(root,'.nojekyll')), 'GitHub Pages marker documented by the project must be shipped');
}

function testLinkBacklinkGraphSemantics(){
  const core = read('js/00-state-and-helpers.js');
  const graph = read('js/05-backlinks-nav-graph.js');
  const zettel = read('js/28-zettelkasten.js');
  const start = core.indexOf('function extractRefs(text)');
  const end = core.indexOf('var BLOCKREF_RE', start);
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(core.slice(start,end), ctx);
  assert.deepStrictEqual(
    Array.from(ctx.extractRefs('#research [[Research]] ![[Research]]'), x=>x.type),
    ['tag','page','page']
  );
  assert.ok(
    graph.includes("r.type === 'page' && r.title.toLowerCase() === page.title.toLowerCase()"),
    'backlinks must ignore #tag/page-title collisions'
  );
  assert.ok(graph.includes('if(!sourcePage || sourcePage.trashedAt) return;'), 'Backlinks must exclude trashed source pages');
  const tasks = read('js/15-task-manager.js');
  assert.ok(tasks.includes('label.textContent = g.label'), 'Task group labels must use textContent');
  assert.ok(tasks.includes('count.textContent = String(g.items.length)'), 'Task group counts must use textContent');
  assert.ok(!/head\.innerHTML\s*=.*g\.label/.test(tasks), 'Task group labels must not be interpolated into HTML');
  assert.ok(graph.includes("if(r.type !== 'page') return;"), 'graph edges must only use explicit page references');
  assert.ok(zettel.includes("if(r.type !== 'page') return;"), 'Zettelkasten edges must only use explicit page references');
}

function testTransclusionAndBlockReferenceContracts(){
  const transclusion = read('js/25-transclusion.js');
  const core = read('js/00-state-and-helpers.js');
  assert.ok(transclusion.includes('var NEXUS_TRANSCLUSION_PATTERN = /!\\[\\['), 'page transclusion syntax must remain implemented');
  assert.ok(transclusion.includes('!\\(\\('), 'block transclusion syntax must remain implemented');
  assert.ok(transclusion.includes('transclude:section'), 'section transclusion syntax must remain implemented');
  assert.ok(transclusion.includes('NEXUS_TRANSCLUSION_MAX_DEPTH'), 'transclusion must have an explicit recursion bound');
  assert.ok(transclusion.includes('Circular page transclusion'), 'transclusion must surface cycles safely');
  assert.ok(core.includes('function findBlockRefsTo(id)'), 'native block reference helper must remain implemented');
}

function testMarkdownImportHierarchy(){
  const imp = read('js/11-import-export.js');
  const ctx = {
    state: {pages:{p:{id:'p',title:'Imported',rootBlocks:[]}}, blocks:{}},
    uid: (()=>{ let n=0; return ()=>`b${++n}`; })(),
    mkBlock: (id,pageId,parent,text)=>({id,pageId,parent,text,children:[]})
  };
  const parse = extractFunction(imp, 'function parseMarkdownIntoBlocks(pageId, text)', 'function importMarkdownFiles');
  vm.createContext(ctx);
  vm.runInContext(parse + '\nthis.parseMarkdownIntoBlocks=parseMarkdownIntoBlocks;', ctx);
  ctx.parseMarkdownIntoBlocks('p', '# Heading\n- root\n  - child\n- [x] done\n1. numbered');
  const roots = ctx.state.pages.p.rootBlocks;
  assert.strictEqual(roots.length, 1, 'heading should remain the document root');
  const heading = ctx.state.blocks[roots[0]];
  assert.strictEqual(heading.text, '# Heading');
  assert.strictEqual(heading.children.length, 3, 'following Markdown items should remain children of the heading');
  const root = ctx.state.blocks[heading.children[0]];
  assert.strictEqual(root.text, 'root');
  assert.deepStrictEqual(root.children, ['b3']);
  assert.strictEqual(ctx.state.blocks['b3'].text, 'child');
  assert.strictEqual(ctx.state.blocks[heading.children[1]].text, '[x] done');
  assert.strictEqual(ctx.state.blocks[heading.children[2]].text, 'numbered');
  assert.ok(imp.includes('function buildPageMarkdown(page)'), 'Markdown export must remain implemented');
  assert.ok(imp.includes('blockRefPreview'), 'export must retain intentional block-reference flattening');
}

async function testMarkdownExportRuntime(){
  const imp = read('js/11-import-export.js');
  const start = imp.indexOf('function blockRefPreview(id)');
  const end = imp.indexOf('function importMarkdownFiles(fileList)', start);
  assert.ok(start >= 0 && end > start, 'Markdown export implementation boundary must exist');
  const ctx = {
    state: {blocks:{b1:{id:'b1', text:'Body with [[Other]] ((block2))', children:['block2']}, block2:{id:'block2', text:'Child', children:[]}}},
    getAttachment: () => Promise.resolve(null),
    blobToBase64: () => Promise.resolve(''),
    parseAttRef: () => ({id:'missing'}),
    Promise, Set, Array
  };
  vm.createContext(ctx);
  vm.runInContext(imp.slice(start,end) + '\nthis.buildPageMarkdown=buildPageMarkdown;', ctx);
  const md = await ctx.buildPageMarkdown({title:'Exported', properties:[{key:'Status',value:'draft'}], rootBlocks:['b1']});
  assert.ok(md.includes('# Exported'), 'Markdown export must include page title');
  assert.ok(md.includes('*Status:* draft'), 'Markdown export must include page properties');
  assert.ok(md.includes('Body with [[Other]] Child'), 'block references must flatten to referenced text for Markdown portability');
  assert.ok(md.includes('- Child'), 'nested blocks must remain represented in exported Markdown');
}

function testPersistenceRecoveryAndSecurityClosure(){
  const core = read('js/00-state-and-helpers.js');
  const backup = read('js/06-backup-sync.js');
  const security = read('js/09-security-lock.js');
  assert.ok(core.includes('function normalizeState(parsed)'), 'state normalization must remain explicit');
  assert.ok(core.includes('function enqueueNotebookPersist(json, keyOverride)'), 'serialized persistence queue must remain explicit');
  assert.ok(backup.includes('snapshot'), 'restore flow must preserve a pre-replacement recovery snapshot');
  assert.ok(security.includes('keyOverride || lockCryptoKey'), 'lock-boundary saves must retain the pre-lock key override');
  assert.ok(security.includes('clearLockMeta()'), 'removing/transitioning lock state must clear security metadata');
  assert.ok(/function escapeHtml\(/.test(core), 'shared HTML escaping helper must remain present');
}

function testReleaseAndStaticAssetClosure(){
  const pkg = JSON.parse(read('package.json'));
  const index = read('index.html');
  const sw = read('sw.js');
  const pwa = read('js/12-pwa.js');
  const readme = read('README.md');
  const assetRefs = [];
  for (const m of index.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const ref = m[1].split('?')[0];
    if(ref && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(ref)) assetRefs.push(ref);
  }
  for (const ref of assetRefs) assert.ok(fs.existsSync(path.join(root, ref)), `missing local release asset: ${ref}`);
  assert.strictEqual(pkg.version, '1.0.0-rc6');
  assert.ok(index.includes('phase9-master-takeover-v2'));
  assert.ok(sw.includes("var CACHE='nexus-shell-v11';"));
  assert.ok(pwa.includes("var CACHE='nexus-shell-v11';"));
  assert.ok(fs.existsSync(path.join(root,'.nojekyll')));
  assert.ok(!/href\s*=\s*["']javascript:/i.test(index), 'static HTML must not contain executable javascript: links');
  assert.ok(readme.includes('Production Candidate'), 'README current-state heading must describe the production candidate');
  assert.ok(readme.includes('1.0.0-rc6'), 'README must carry the current release version');
  assert.ok(readme.includes('nexus-shell-v11'), 'README must carry the current PWA generation');
}

function testPwaEmbeddedSourceExactParity(){
  const sw = read('sw.js');
  const pwa = read('js/12-pwa.js');
  const start = pwa.indexOf('var NEXUS_SW_SOURCE = ') + 'var NEXUS_SW_SOURCE = '.length;
  const end = pwa.indexOf(';\n\nfunction downloadServiceWorkerFile', start);
  assert.ok(start > 'var NEXUS_SW_SOURCE = '.length && end > start, 'embedded service-worker source declaration must exist');
  const embedded = vm.runInNewContext(pwa.slice(start, end));
  assert.strictEqual(embedded, sw, 'embedded downloadable worker source must exactly match shipped sw.js');
}

function testGraphPerformanceShape(){
  const graph = read('js/05-backlinks-nav-graph.js');
  assert.ok(/for\(var j=i\+1;j<nodes\.length;j\+\+\)/.test(graph), 'graph repulsion must process each symmetric pair once');
  assert.ok(graph.includes('n2.vx -= fx; n2.vy -= fy;'), 'graph repulsion must apply equal/opposite force');
}

function testCurrentHelpCoverageContract(){
  const core = read('js/00-state-and-helpers.js');
  assert.ok(/NEXUS_HELP_GUIDE_VERSION = 32/.test(core));
  assert.ok(core.includes("help-78', title:'Link, backlink & graph semantics'"));
  assert.ok(core.includes('addMaintainedSection("Link, backlink & graph semantics"'));
}

function testNoDeadExecutablePlaceholderLinks(){
  const files = fs.readdirSync(path.join(root,'js')).filter(f=>f.endsWith('.js')).map(f=>read('js/'+f)).join('\n');
  const index = read('index.html');
  assert.ok(!/javascript:/i.test(index), 'HTML must not contain javascript: URI links');
  assert.ok(!/TODO\s*:\s*(?:implement|finish|fix)/i.test(files), 'source must not contain implementation TODO placeholders');
  assert.ok(!/coming soon/i.test(files), 'source must not expose coming-soon functionality placeholders');
}

async function main(){
  testProjectInventoryAndScriptOrder();
  testLinkBacklinkGraphSemantics();
  testTransclusionAndBlockReferenceContracts();
  testMarkdownImportHierarchy();
  await testMarkdownExportRuntime();
  testPersistenceRecoveryAndSecurityClosure();
  testReleaseAndStaticAssetClosure();
  testPwaEmbeddedSourceExactParity();
  testGraphPerformanceShape();
  testCurrentHelpCoverageContract();
  testNoDeadExecutablePlaceholderLinks();
  console.log('Master takeover acceptance tests passed: full project inventory and load order are intact; links/backlinks/graph semantics are correct; transclusion/import structure, persistence/recovery/security, release/PWA closure, performance contracts and Help coverage remain aligned.');
}
main().catch(function(err){ console.error(err); process.exitCode=1; });
