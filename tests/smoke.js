const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const assert = require('assert');
const vm = require('vm');
const coreSource = fs.readFileSync(path.join(__dirname, '..', 'js', '00-state-and-helpers.js'), 'utf8');

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
assert.ok(index.includes('settings-passcodereentry-row'), 'passcode re-entry setting row missing');
assert.ok(index.includes('data-passcodereentry="1"'), '1-hour passcode interval missing');
assert.ok(index.includes('data-passcodereentry="6"'), '6-hour passcode interval missing');
assert.ok(index.includes('data-passcodereentry="12"'), '12-hour passcode interval missing');
assert.ok(index.includes('data-passcodereentry="24"'), '24-hour passcode interval missing');
assert.ok(index.includes('data-theme="aurora"'), 'Aurora theme missing');
assert.ok(index.includes('data-theme="amethyst"'), 'Amethyst theme missing');
assert.ok(index.includes('data-theme="meadow"'), 'Meadow theme missing');
assert.ok(index.includes('data-theme="ember"'), 'Ember theme missing');
const cssTheme = fs.readFileSync(path.join(root,'css','styles.css'),'utf8');
for (const theme of ['aurora','amethyst','meadow','ember']) {
  assert.ok(cssTheme.includes(`:root[data-theme="${theme}"]`), `${theme} theme CSS missing`);
}
assert.ok(index.includes('data-health-overlay'), 'Data health UI must be present');
assert.ok(/nexus-build" content="2026-09-19-quality-hardened-v1-/.test(index), 'quality build marker missing');
assert.ok(index.includes('tasks-layout'), 'task layout control missing');
const core = fs.readFileSync(path.join(root,'js','00-state-and-helpers.js'),'utf8');
assert.ok(/NEXUS_HELP_GUIDE_VERSION\s*=\s*29/.test(core), 'current Help guide version missing');
assert.ok(core.includes('ensureCompleteHelpGuide(docsId)'), 'existing Help pages must receive the complete guide update');
const dbSidebar = fs.readFileSync(path.join(root,'js','21-database-sidebar.js'),'utf8');
const querySidebar = fs.readFileSync(path.join(root,'js','22-query-sidebar.js'),'utf8');
assert.ok(dbSidebar.includes('ensureDefaultDatabasePage'), 'default database page creator');
assert.ok(dbSidebar.includes('renderDatabaseSidebarSection'), 'database sidebar index renderer');
assert.ok(dbSidebar.includes('databaseSidebarFilter'), 'database filter state');
assert.ok(dbSidebar.includes('repairedId'), 'default database page repair');
assert.ok(querySidebar.includes('ensureDefaultQueryPage'), 'default query page creator');
assert.ok(querySidebar.includes('renderQuerySidebarSection'), 'query sidebar index renderer');
assert.ok(querySidebar.includes('querySidebarFilter'), 'query filter state');
assert.ok(querySidebar.includes('repairedId'), 'default query page repair');
assert.ok(fs.readFileSync(path.join(root,'js','01-query-engine.js'),'utf8').includes('queryBlockId'), 'query widget addressability');
assert.ok(fs.readFileSync(path.join(root,'js','02-editor-core.js'),'utf8').includes('default Database workspace cannot be moved to Trash'), 'database workspace trash guard');
assert.ok(fs.readFileSync(path.join(root,'js','01-query-engine.js'),'utf8').includes('dbBlockId'), 'database widget addressability');
assert.ok(core.includes('NEXUS_HELP_FEATURE_CATALOG'), 'Help feature catalog missing');
assert.ok(core.includes('Query workspace & sidebar index'), 'query workspace Help topic missing');
assert.ok(core.includes('Task gallery view'), 'task gallery Help topic missing');
assert.ok(core.includes('Logseq-inspired Daily Notes'), 'daily notes Help topic missing');
assert.ok(core.includes('Page icons & banners'), 'page appearance Help topic missing');
assert.ok(core.includes('getHelpGuideCoverage'), 'Help coverage checker missing');
assert.ok(core.includes('Passcode re-entry interval'), 'passcode re-entry Help topic missing');
assert.ok(core.includes('Mobile Zettelkasten collapse & expand'), 'mobile Zettelkasten Help topic missing');
assert.ok(core.includes('help-71'), 'Command Center Help catalog id missing');
assert.ok(core.includes('Central Command Center'), 'Command Center Help topic missing');
assert.ok(core.includes('Workspace tabs'), 'Workspace tabs Help topic missing');
assert.ok(core.includes('Pinned tabs & sidebar drag-and-drop ordering'), 'Pinned tabs/sidebar reorder Help topic missing');
assert.ok(core.includes('Additional crafted themes'), 'crafted themes Help topic missing');
assert.ok(core.includes('help-73'), 'crafted themes Help catalog id missing');
assert.ok(core.includes('help-72'), 'Workspace tabs Help catalog id missing');
const tabs = fs.readFileSync(path.join(root,'js','32-tabs.js'),'utf8');
assert.ok(tabs.includes('function toggleNexusTabPinned'), 'tab pin action missing');
assert.ok(tabs.includes('isNexusTabPinned'), 'pinned close guard missing');
assert.ok(cssTheme.includes('.nexus-tab.pinned'), 'pinned tab CSS missing');
assert.ok(tabs.includes('NEXUS_TABS_STORAGE_KEY'), 'tab persistence key missing');
assert.ok(tabs.includes('function closeNexusTab'), 'tab close behavior missing');
assert.ok(tabs.includes('function activateNexusTab'), 'tab activation missing');
assert.ok(tabs.includes('function nexusTabsActivateWorkspace'), 'workspace tab support missing');
assert.ok(index.includes('id="nexus-tabs-shell"'), 'tab shell missing');
assert.ok(index.includes('id="btn-sync-center"'), 'Sync cleanup center sidebar control missing');
assert.ok(index.includes('id="sync-center-overlay"'), 'Sync cleanup center UI missing');
assert.ok(index.includes('id="version-create-btn"'), 'named version checkpoint control missing');
assert.ok(index.includes('id="version-filter"'), 'version history filter missing');
assert.ok(index.includes('id="conflicts-open-cleanup"'), 'conflict cleanup shortcut missing');
assert.ok(index.includes('id="sync-center-review-conflicts"'), 'sync center conflict review control missing');

const syncRecovery = fs.readFileSync(path.join(root,'js','35-sync-recovery.js'),'utf8');
assert.ok(syncRecovery.includes('function nexusCleanConflictLog'), 'sync conflict cleanup missing');
assert.ok(syncRecovery.includes('function nexusConsolidateConflicts'), 'sync conflict consolidation missing');
assert.ok(syncRecovery.includes('function scanNexusDuplicateGroups'), 'duplicate page scanner missing');
assert.ok(syncRecovery.includes('function archiveExactDuplicatePages'), 'safe duplicate cleanup missing');
assert.ok(syncRecovery.includes('function nexusProtectedSystemPage'), 'duplicate cleanup must protect system pages');
assert.ok(fs.readFileSync(path.join(root,'js','20-quality-hardening.js'),'utf8').includes('Duplicate groups'), 'Data health duplicate metrics missing');

assert.ok(syncRecovery.includes('NEXUS_VERSION_HISTORY_MAX = 20'), 'version history depth missing');
assert.ok(syncRecovery.includes('function createNamedCheckpoint'), 'named checkpoint creation missing');
assert.ok(syncRecovery.includes('function nexusSetVersionPinned'), 'version pinning missing');
assert.ok(core.includes('Sync cleanup, duplicate recovery & conflict management'), 'sync cleanup Help topic missing');
assert.ok(core.includes('Version history, checkpoints & pins'), 'version history Help topic missing');

assert.ok(index.includes('id="nexus-tabs-menu-popover"'), 'tab menu popover missing');
assert.ok(index.includes('id="sidebar-nav-list"'), 'sidebar navigation reorder container missing');
assert.ok(index.includes('id="sidebar-order-reset-btn"'), 'sidebar order reset control missing');
assert.ok(index.includes('js/34-sidebar-ui-ordering.js'), 'sidebar ordering module load missing');
assert.ok(index.includes('js/35-sync-recovery.js'), 'sync recovery module load missing');

assert.ok(index.includes('js/36-footer-actions-repair.js'), 'critical sidebar footer action repair module must load last');
const footerRepair = fs.readFileSync(path.join(root,'js','36-footer-actions-repair.js'),'utf8');
assert.ok(footerRepair.includes("bind('btn-settings'"), 'Settings defensive binding missing');
assert.ok(footerRepair.includes("bind('btn-find-replace'"), 'Find & replace defensive binding missing');
assert.ok(footerRepair.includes("bind('btn-sync-center'"), 'Sync cleanup defensive binding missing');
assert.ok(footerRepair.includes("bind('btn-sync'"), 'Sync devices defensive binding missing');
assert.ok(syncRecovery.includes("if(typeof state !== 'undefined' && state && state.pages)"), 'sync recovery must defer live rendering until notebook state exists');


const sidebarUi = fs.readFileSync(path.join(root,'js','34-sidebar-ui-ordering.js'),'utf8');
assert.ok(sidebarUi.includes('NEXUS_SIDEBAR_ORDER_KEY'), 'sidebar order persistence key missing');
assert.ok(sidebarUi.includes('function nexusSidebarMoveBefore'), 'sidebar reorder movement function missing');
assert.ok(sidebarUi.includes("handle.addEventListener('dragstart'"), 'sidebar drag-and-drop handle missing');
assert.ok(sidebarUi.includes('function nexusSidebarResetOrder'), 'sidebar reorder reset missing');
assert.ok(sidebarUi.includes('nexusSidebarInitialOrder'), 'sidebar reorder must retain the original reset order');
assert.ok(cssTheme.includes('.nexus-tabs-menu-popover[hidden]{display:none !important;}'), 'tab menu must respect hidden state');
assert.ok(index.includes('id="expand-btn"'), 'persistent sidebar toggle control missing');
assert.ok(/aria-label="Toggle sidebar"|aria-label="Expand sidebar"|aria-label="Collapse sidebar"/.test(index), 'sidebar toggle accessibility labeling missing');
assert.ok(cssTheme.includes('/* Persistent mobile sidebar toggle.'), 'persistent mobile sidebar CSS missing');
assert.ok(core.includes('Mobile sidebar always-visible toggle'), 'mobile sidebar Help topic missing');
assert.ok(core.includes('help-76'), 'mobile sidebar Help catalog id missing');
assert.ok(/NEXUS_HELP_GUIDE_VERSION\s*=\s*29/.test(core), 'current Help version must be v29');
assert.ok(index.includes('js/32-tabs.js'), 'tabs module load missing');

const footnotes = fs.readFileSync(path.join(root,'js','33-footnotes.js'),'utf8');
assert.ok(index.includes('js/33-footnotes.js'), 'footnotes module load missing');
assert.ok(footnotes.includes('FOOTNOTE_REF_RE'), 'footnote reference parser missing');
assert.ok(footnotes.includes('FOOTNOTE_DEF_RE'), 'footnote definition parser missing');
assert.ok(footnotes.includes('function getPageFootnoteModel'), 'footnote page model missing');
assert.ok(footnotes.includes('function renderFootnotes'), 'footnote panel renderer missing');
assert.ok(footnotes.includes('function createFootnoteOnPage'), 'footnote creation flow missing');
assert.ok(footnotes.includes("label:'Footnote…'"), 'slash Footnote command missing');
assert.ok(cssTheme.includes('.footnote-ref'), 'footnote ref CSS missing');
assert.ok(cssTheme.includes('#page-footnotes'), 'footnote panel CSS missing');
assert.ok(core.includes('Footnotes'), 'Footnotes Help topic missing');

assert.ok(fs.readFileSync(path.join(root,'js','31-command-center.js'),'utf8').includes('function showCommandCenterView'), 'Command Center show function missing');
assert.ok(fs.readFileSync(path.join(root,'js','31-command-center.js'),'utf8').includes('Sync cleanup & recovery'), 'Command Center sync cleanup command missing');

assert.ok(core.includes('Release rule: whenever a user-visible feature'), 'Help maintenance instruction missing');
const catalogCount = (core.match(/\{id:'[^']+', title:'/g) || []).length;
assert.ok(catalogCount >= 60, `Help feature catalog unexpectedly small: ${catalogCount}`);
const catalogBlock = core.slice(core.indexOf('var NEXUS_HELP_FEATURE_CATALOG = ['), core.indexOf('function getHelpGuideCoverage'));
const catalogTitles = new Set([...catalogBlock.matchAll(/title:'([^']+)'/g)].map(m => m[1]));
const allHelpSectionTitles = new Set([...core.matchAll(/(?:\bsection|\baddMaintainedSection)\(\"([^\"]+)\"/g)].map(m => m[1]));
for (const title of allHelpSectionTitles) {
  assert.ok(catalogTitles.has(title), `Help section is not registered in feature catalog: ${title}`);
}
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
  'Mobile editing',
  'Find & replace',
  'Trash & recovery',
  'Daily notes: recent, all & calendar',
  'Highlight, text color & links',
  'Graph navigation & accessibility',
  'Database calendar view',
  'Visual query builder',
  'Navigation, zoom & undo/redo',
  'Help & Tutorial maintenance',
  'Database workspace & sidebar index',
  'Query workspace & sidebar index',
  'Task gallery view',
  'Dashboard home hub'
]) {
  assert.ok(core.includes(phrase), `Help guide topic missing: ${phrase}`);
}


const css = fs.readFileSync(path.join(root,'css','styles.css'), 'utf8');
assert.ok(css.includes('#nexus-health-chip'), 'health chip CSS missing');
assert.ok(css.includes('.quality-modal'), 'data health modal CSS missing');
assert.ok(css.includes('.tasks-gallery'), 'task gallery CSS missing');
assert.ok(css.includes('.page-banner-ocean'), 'page banner CSS missing');
assert.ok(css.includes('.page-icon-btn'), 'page icon CSS missing');
const tasks = fs.readFileSync(path.join(root,'js','15-task-manager.js'),'utf8');const security = fs.readFileSync(path.join(root,'js','09-security-lock.js'),'utf8');const wiring = fs.readFileSync(path.join(root,'js','14-wiring-and-init.js'),'utf8');
assert.ok(security.includes("PASSCODE_REENTRY_CHOICES = ['1','6','12','24']"), 'passcode interval choices missing');
assert.ok(security.includes('enforcePasscodeReentry'), 'automatic passcode re-entry enforcement missing');
assert.ok(security.includes('refreshLockSessionTimer'), 'passcode session timer missing');
assert.ok(security.includes('flushSaveNow'), 'automatic lock must save before clearing the key');
assert.ok(security.includes('PASSCODE_LAUNCH_DEFAULT'), 'launch passcode policy missing');
assert.ok(security.includes("PASSCODE_PERSISTENT_STORE = 'security'"), 'persistent launch unlock store missing');
assert.ok(security.includes('restorePersistentPasscodeKey'), 'persistent launch unlock restore missing');
assert.ok(wiring.includes('restorePersistentPasscodeKey'), 'boot must attempt persistent launch unlock');
assert.ok(security.includes('restorePasscodeSessionKey'), 'launch session restore missing');
assert.ok(security.includes('persistPasscodeSessionKey'), 'launch session persistence missing');
assert.ok(security.includes('updatePasscodeLaunchSessionPolicy'), 'launch policy updater missing');
assert.ok(index.includes('settings-passcode-launch-row'), 'Request passcode on launch setting missing');
assert.ok(index.includes('data-passcoderequest="off"'), 'launch off control missing');
assert.ok(fs.readFileSync(path.join(root,'js','14-wiring-and-init.js'),'utf8').includes('startNotebookWithSecurityGate'), 'startup security gate missing');
assert.ok(core.includes('Launch passcode policy & device auto-unlock'), 'launch policy Help section missing');

assert.ok(tasks.includes("['board','list','gallery']"), 'task layout cycle must include gallery');
assert.ok(tasks.includes("tasksViewState.layout === 'gallery' ? 'tasks-gallery'"), 'gallery renderer class missing');
assert.ok(index.includes('Switch task layout (Board, List, Gallery)'), 'task gallery accessibility label missing');
assert.ok(tasks.includes('Task layout: '), 'task gallery runtime accessibility label missing');
assert.ok(core.includes('Task gallery view'), 'Task gallery Help section missing');
assert.ok(fs.existsSync(path.join(root,'js','24-page-appearance.js')), 'page appearance module missing');
const appearance = fs.readFileSync(path.join(root,'js','24-page-appearance.js'),'utf8');
assert.ok(appearance.includes('NEXUS_PAGE_ICON_CHOICES'), 'page icon choices missing');
assert.ok(appearance.includes('NEXUS_PAGE_BANNER_LABELS'), 'page banner presets missing');
assert.ok(appearance.includes('renderPageAppearance'), 'page appearance renderer missing');
assert.ok(index.includes('page-icon-btn'), 'page icon control missing');
assert.ok(index.includes('page-banner-btn'), 'page banner control missing');


assert.ok(index.includes('id="dashboard-view"'), 'dashboard home hub view missing');
assert.ok(index.includes('id="btn-dashboard"'), 'permanent Dashboard sidebar button missing');
const dashboard = fs.readFileSync(path.join(root,'js','13b-dashboard.js'),'utf8');
assert.ok(dashboard.includes('showDashboardView'), 'dashboard show function missing');
assert.ok(dashboard.includes('renderDashboardStats'), 'dashboard stats renderer missing');
assert.ok(dashboard.includes('renderDashboardWorkspaces'), 'dashboard workspace renderer missing');
assert.ok(dashboard.includes('renderDashboardHealth'), 'dashboard health renderer missing');
assert.ok(core.includes('Dashboard home hub'), 'Dashboard Help topic missing');
assert.ok(core.includes("NEXUS_HELP_GUIDE_VERSION = 29"), 'current Help version missing');
assert.ok(css.includes('#dashboard-view.visible'), 'Dashboard CSS missing');
assert.ok(core.includes('Page transclusion'), 'Page transclusion Help topic missing');
assert.ok(core.includes('Block transclusion'), 'Block transclusion Help topic missing');
assert.ok(core.includes('Section transclusion'), 'Section transclusion Help topic missing');
assert.ok(core.includes('Flashcards & spaced repetition'), 'Flashcards Help topic missing');
assert.ok(fs.existsSync(path.join(root,'js','25-transclusion.js')), 'transclusion module missing');
const tx = fs.readFileSync(path.join(root,'js','25-transclusion.js'),'utf8');
assert.ok(tx.includes('![[Page Title]]'), 'page transclusion syntax missing');
assert.ok(tx.includes('!((block-id))'), 'block transclusion syntax missing');
assert.ok(tx.includes('![[Page Title#Heading]]'), 'section transclusion syntax missing');
assert.ok(tx.includes('NEXUS_TRANSCLUSION_MAX_DEPTH'), 'transclusion recursion guard missing');
assert.ok(index.includes('js/25-transclusion.js'), 'transclusion script not loaded');
assert.ok(css.includes('.transclusion-card'), 'transclusion CSS missing');
assert.ok(css.includes('#flashcards-view.visible'), 'flashcards CSS missing');
const fc = fs.readFileSync(path.join(root,'js','26-flashcards.js'),'utf8');
assert.ok(fc.includes('ensureFlashcardState'), 'flashcard state initializer missing');
assert.ok(fc.includes('scheduleFlashcard'), 'flashcard scheduler missing');
assert.ok(fc.includes('renderFlashcardReview'), 'flashcard review renderer missing');
assert.ok(fc.includes('flashcardSidebarFilter'), 'created flashcards sidebar filter missing');
assert.ok(index.includes('js/26-flashcards.js'), 'flashcards module not loaded');
const flashcardCtx = {
  window: {crypto:{randomUUID:()=> 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}},
  console, setTimeout, clearTimeout, Promise, JSON, Math, Date,
  Uint8Array, Array, Object, String, Number, RegExp, Error,
  localStorage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}}, document:undefined, indexedDB:{}, navigator:{}
};
vm.createContext(flashcardCtx);
vm.runInContext(coreSource, flashcardCtx, {filename:'00-state-and-helpers.js'});
vm.runInContext(fs.readFileSync(path.join(root,'js','26-flashcards.js'),'utf8'), flashcardCtx, {filename:'26-flashcards.js'});
flashcardCtx.state={flashcards:{decks:{d:{id:'d',name:'Study',createdAt:1}},cards:{}} , pages:{}, currentPageId:null};
flashcardCtx.flashcardState={deckId:'all',status:'all',query:'',reviewId:null,revealed:false,selectedId:null};
const fcCreated=flashcardCtx.makeFlashcard('Capital of Nigeria?','Abuja','d',null,null);
assert.ok(fcCreated && fcCreated.state==='new' && fcCreated.dueAt===0, 'new flashcard should start unscheduled');
flashcardCtx.scheduleFlashcard(fcCreated,'good');
assert.ok(fcCreated.reps===1 && fcCreated.dueAt>0 && fcCreated.interval>=1, 'good review should schedule the card');
const beforeSyncFc=JSON.parse(JSON.stringify(flashcardCtx.state.flashcards));
// Runtime render smoke test for page/block/section transclusion.
const txContext = {
  window: {crypto: {}}, console, setTimeout, clearTimeout, Promise, JSON, Math, Date,
  Uint8Array, Array, Object, String, Number, RegExp, Error,
  localStorage: {getItem:()=>null,setItem:()=>{},removeItem:()=>{}},
  document: undefined, indexedDB: {}, navigator: {}
};
txContext.findPageByTitle = function(title){
  var id = txContext.state && txContext.state.titleIndex ? txContext.state.titleIndex[String(title || '').toLowerCase()] : null;
  return id && txContext.state.pages[id] ? txContext.state.pages[id] : null;
};
txContext.headingInfo = function(text){
  var m = String(text || '').match(/^(#{1,6})[ \t]+([\s\S]*)$/);
  return m ? {level:m[1].length, rest:m[2]} : null;
};
vm.createContext(txContext);
vm.runInContext(coreSource, txContext, {filename:'00-state-and-helpers.js'});
txContext.blockPreviewText = function(blk){ return (blk.text || '').trim() || '(empty block)'; };
vm.runInContext(fs.readFileSync(path.join(root,'js','25-transclusion.js'),'utf8'), txContext, {filename:'25-transclusion.js'});
txContext.state = {
  pages: {
    p1:{id:'p1',title:'Source',type:'page',rootBlocks:['h1','b2'],properties:[]},
    p2:{id:'p2',title:'Host',type:'page',rootBlocks:['host'],properties:[]}
  },
  blocks: {
    h1:{id:'h1',pageId:'p1',parent:null,text:'# Section',children:['b1'],collapsed:false},
    b1:{id:'b1',pageId:'p1',parent:'h1',text:'Alpha',children:[],collapsed:false},
    b2:{id:'b2',pageId:'p1',parent:null,text:'Beta',children:[],collapsed:false},
    host:{id:'host',pageId:'p2',parent:null,text:'Host',children:[],collapsed:false}
  },
  titleIndex:{source:'p1',host:'p2'},
  currentPageId:'p2'
};
assert.ok(/transclusion-page/.test(txContext.renderExplicitTransclusion('![[Source]]',0,'p2')), 'page transclusion should render');
assert.ok(/Alpha/.test(txContext.renderExplicitTransclusion('![[Source#Section]]',0,'p2')), 'section transclusion should include section content');
assert.ok(/Beta/.test(txContext.renderExplicitTransclusion('{{transclude:page|Source}}',0,'p2')), 'explicit page transclusion should render');
assert.ok(/transclusion-block/.test(txContext.renderExplicitTransclusion('!((b1))',0,'p2')), 'block transclusion should render');
assert.ok(/Section not found/.test(txContext.renderExplicitTransclusion('![[Source#Missing]]',0,'p2')), 'missing section should fail safely');
assert.ok(/Circular page transclusion/.test(txContext.renderPageTransclusion(txContext.state.pages.p2,0)) === false, 'non-recursive page render should not report circular transclusion');



const folders = fs.readFileSync(path.join(root,'js','29-folders.js'),'utf8');
assert.ok(folders.includes('ensureFolderState'), 'folder state initializer missing');
assert.ok(folders.includes('createFolder'), 'folder creation missing');
assert.ok(folders.includes('createFolderPrompt'), 'folder prompt missing');
assert.ok(folders.includes('movePageToFolderPrompt'), 'page folder move workflow missing');
assert.ok(folders.includes('folderDescendant'), 'nested folder cycle guard missing');
assert.ok(folders.includes('dragstart'), 'folder drag/drop support missing');
assert.ok(folders.includes('folderSidebarFilter'), 'folder-local filter state missing');
assert.ok(folders.includes('renderFolderSidebarSection'), 'folder sidebar renderer missing');
assert.ok(index.includes('id="folder-tree"'), 'folder tree UI missing');
assert.ok(index.includes('id="new-folder-btn"'), 'new folder control missing');
assert.ok(index.indexOf('js/29-folders.js') < index.indexOf('js/14-wiring-and-init.js'), 'folders module must load before final wiring');
assert.ok(fs.readFileSync(path.join(root,'js','13-slash-and-context-menus.js'),'utf8').includes('copy.folderId = page.folderId'), 'duplicated pages should retain their folder');
assert.ok(css.includes('.folder-children'), 'nested folder CSS missing');
assert.ok(core.includes('Folder organization & nested folders'), 'folder Help topic missing');
assert.ok(core.includes("help-68"), 'folder Help catalog id missing');
assert.ok(core.includes("help-69"), 'passcode interval Help catalog id missing');

// Folder runtime smoke: nested creation, path resolution, moving a page, safe deletion.
let folderUuidCounter=0;
const folderCtx = {
  window:{crypto:{randomUUID:()=> 'bbbbbbbb-bbbb-bbbb-bbbb-' + String(++folderUuidCounter).padStart(12,'0')}}, console, setTimeout, clearTimeout, Promise, JSON, Math, Date, Uint8Array, Array, Object, String, Number, RegExp, Error,
  localStorage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}}, document:undefined, indexedDB:{}, navigator:{}
};
vm.createContext(folderCtx);
vm.runInContext(coreSource, folderCtx, {filename:'00-state-and-helpers.js'});
folderCtx.renderAll=function(){}; folderCtx.toast=function(){}; folderCtx.save=function(){}; folderCtx.confirm=function(){return true;}; folderCtx.prompt=function(){return null;};
folderCtx.state={pages:{p:{id:'p',title:'Project',type:'page',rootBlocks:[],properties:[]}},blocks:{},titleIndex:{project:'p'},folders:{},tombstones:{pages:{},blocks:{}},deviceId:'D',templates:{},flashcards:{decks:{},cards:{}},stickyNotes:{cards:{}}};
folderCtx.livePages=function(){return Object.keys(folderCtx.state.pages).map(function(id){return folderCtx.state.pages[id];}).filter(function(x){return !x.trashedAt;});};
vm.runInContext(folders, folderCtx, {filename:'29-folders.js'});
folderCtx.createFolder('Projects',null);
const rootFolderId=Object.keys(folderCtx.state.folders)[0];
folderCtx.createFolder('Work',rootFolderId);
const workFolderId=Object.keys(folderCtx.state.folders).find(id=>id!==rootFolderId);
assert.strictEqual(folderCtx.folderPath(workFolderId),'Projects / Work','nested folder path should resolve');
folderCtx.movePageToFolder('p',workFolderId);
assert.strictEqual(folderCtx.state.pages.p.folderId,workFolderId,'page should move into nested folder');
folderCtx.deleteFolder(rootFolderId);
assert.ok(folderCtx.state.folders[rootFolderId].deletedAt,'deleted folder should remain as a sync-safe tombstone');
assert.strictEqual(folderCtx.state.folders[workFolderId].parentId,null,'deleting a parent should safely reparent its child folder');
assert.strictEqual(folderCtx.state.pages.p.folderId,workFolderId,'pages inside a reparented child folder should remain in that child folder');

// Passcode re-entry runtime smoke: load the security module's session-timer
// logic without requiring its browser-only DOM wiring.
const securitySource = fs.readFileSync(path.join(root,'js','09-security-lock.js'),'utf8');
const securityLogic = securitySource.slice(
  securitySource.indexOf('var lockCryptoKey = null'),
  securitySource.indexOf("document.getElementById('lock-submit').onclick")
);
let scheduledDelay = 0;
const secCtx = {
  window:{crypto:{}, addEventListener:()=>{}}, console, Promise, JSON, Math, Date, Uint8Array, Array, Object, String, Number, RegExp, Error,
  setTimeout:(fn, delay)=>{ scheduledDelay = delay; return 1; },
  clearTimeout:()=>{},
  localStorage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}},
  document:{getElementById:()=>null, addEventListener:()=>{}, visibilityState:'visible'},
  currentSettings:{passcodeReentryHours:'24'},
  LOCK_KEY:'nexus_lock',
  appLocked:false,
  toast:()=>{},
  saveSettings:()=>{},
  setDataHealthStatus:()=>{},
  isLockEnabled:()=>true,
  flushSaveNow:()=>Promise.resolve(),
  lockNow:()=>{ secCtx.appLocked = true; },
  updatePasscodeReentryStatus:()=>{}
};
vm.createContext(secCtx);
vm.runInContext(securityLogic, secCtx, {filename:'09-security-lock-session.js'});
vm.runInContext("isLockEnabled = function(){ return true; };", secCtx);
assert.strictEqual(vm.runInContext("PASSCODE_REENTRY_CHOICES.join(',')", secCtx), '1,6,12,24', 'passcode intervals should include 1/6/12/24 hours');
secCtx.lockCryptoKey = {};
secCtx.passcodeUnlockedAt = Date.now();
secCtx.refreshLockSessionTimer();
assert.ok(scheduledDelay >= 24*60*60*1000 - 1000 && scheduledDelay <= 24*60*60*1000 + 1000, '24-hour interval should schedule approximately 24 hours');
secCtx.currentSettings.passcodeReentryHours = '1';
secCtx.refreshLockSessionTimer();
assert.ok(scheduledDelay >= 60*60*1000 - 1000 && scheduledDelay <= 60*60*1000 + 1000, '1-hour interval should schedule approximately 1 hour');
const lockSource = fs.readFileSync(path.join(root,'js','09-security-lock.js'),'utf8');
assert.ok(/\.then\(function\(\)\{[\s\S]*?refreshLockSessionTimer\(\);[\s\S]*?return rc\.display;/.test(lockSource), 'setting a new passcode should start the re-entry timer immediately');
const settingsSource = fs.readFileSync(path.join(root,'js','07-find-replace-settings.js'),'utf8');
assert.ok(/tryUnlockWithRecovery\(code\)\.then\(function\(ok\)\{[\s\S]*?refreshLockSessionTimer\(\);/.test(settingsSource), 'recovery unlock should start the re-entry timer');
assert.ok(lockSource.includes('persistPasscodeReentryStartedAt(0);'), 're-entry start time should be cleared on lock');
/* Force the actual expiry path to execute with a 100ms synthetic interval.
   This catches the class of regression where the code schedules a timer but
   never reaches lockNow() when the deadline is crossed. */
let fakeNow = 1000000;
secCtx.Date = {now:()=>fakeNow};
secCtx.Promise = {resolve:()=>({catch:function(){return this;},then:function(fn){fn(); return this;}})};
secCtx.flushSaveNow = ()=>null;
secCtx.passcodeReentryMs = ()=>100;
secCtx.currentSettings.passcodeReentryHours = '1';
secCtx.lockCryptoKey = {};
secCtx.appLocked = false;
secCtx.passcodeReentryLockPending = false;
secCtx.passcodeUnlockedAt = fakeNow;
secCtx.closeSettings = ()=>{};
secCtx.showLockScreen = ()=>{ secCtx.appLocked = true; };
secCtx.refreshLockSessionTimer();
fakeNow += 101;
secCtx.enforcePasscodeReentry();
assert.strictEqual(secCtx.appLocked, true, 'expired passcode interval must actually lock the app');


console.log(`Nexus smoke tests passed: ${jsFiles.length} JavaScript files syntax-checked; security/markup/UI guards passed.`);

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

// Help updater regression: upgrades must append missing sections once and
// remain idempotent on the next boot without duplicating existing content.
let helpUuidCounter = 0;
ctx.window.crypto.randomUUID = () => ('12345678-1234-1234-1234-' + String(++helpUuidCounter).padStart(12, '0'));
const seededHelpPage = {id:'doc',title:'Help & Tutorial',type:'page',rootBlocks:[],properties:[]};
ctx.state = {pages:{doc:seededHelpPage}, blocks:{}, titleIndex:{'help & tutorial':'doc'}};
// Emulate the sections present on a newly-created/legacy Help page before the
// versioned updater runs. The updater should add only the missing maintained
// topics, then become a no-op on the next call.
const seedPrefix = coreSource.slice(0, coreSource.indexOf('function ensureCompleteHelpGuide(pid)'));
const seededTitles = [];
for (const m of seedPrefix.matchAll(/\bsection\("([^"]+)"/g)) seededTitles.push(m[1]);
seededTitles.forEach((title, i) => {
  const id = 'seed-help-' + i;
  ctx.state.blocks[id] = {id, pageId:'doc', parent:null, text:'**' + title + '**', children:[], collapsed:false};
  seededHelpPage.rootBlocks.push(id);
});
ctx.ensureCompleteHelpGuide('doc');
const helpCountAfterFirst = Object.keys(ctx.state.blocks).length;
assert.strictEqual(ctx.state.pages.doc.helpGuideVersion, 29, 'Help guide should be current after updater runs');

/* Passcode re-entry hardening: the session start is persisted as non-secret
   metadata so timer throttling/background suspension cannot silently defeat
   the configured interval. */
const corePersistenceSource = fs.readFileSync(path.join(jsDir, '00-state-and-helpers.js'), 'utf8');
assert.ok(/function flushSaveNow\(\)[\s\S]*?return enqueueNotebookPersist\(json, capturedKey\)/.test(corePersistenceSource), 'flushSaveNow should return its persistence promise and capture the encryption key');
const lockCode = fs.readFileSync(path.join(jsDir, '09-security-lock.js'), 'utf8');
assert.ok(lockCode.includes("PASSCODE_REENTRY_STATE_KEY = LOCK_KEY + '_reentry_v3'"), 'passcode re-entry persistence key missing');
assert.ok(lockCode.includes('loadPasscodeReentryState'), 'passcode re-entry persisted state loader missing');
assert.ok(lockCode.includes('persistPasscodeReentryState(passcodeUnlockedAt, deadlineAt)'), 'unlock deadline is not persisted');
assert.ok(lockCode.includes('PASSCODE_REENTRY_HEARTBEAT_MS = 15000'), 'passcode re-entry heartbeat missing');
assert.ok(lockCode.includes("window.addEventListener('focus', checkPasscodeReentryOnResume)"), 'focus resume check missing');
assert.ok(lockCode.includes("document.addEventListener('visibilitychange', checkPasscodeReentryOnResume)"), 'visibility resume guard missing');
assert.ok(lockCode.includes("window.addEventListener('pageshow', checkPasscodeReentryOnResume)"), 'pageshow resume guard missing');
assert.ok(lockCode.includes('persistPasscodeReentryStartedAt(0);'), 're-entry state cleanup missing');
const helpCoverage = ctx.getHelpGuideCoverage('doc');
assert.ok(helpCoverage.complete, 'fresh Help guide should have complete maintained-topic coverage');
ctx.ensureCompleteHelpGuide('doc');
const helpCountAfterSecond = Object.keys(ctx.state.blocks).length;
assert.strictEqual(helpCountAfterSecond, helpCountAfterFirst, 'Help updater must be idempotent and avoid duplicate sections');


// Persistent tab-state smoke test (DOM-free): the module must store and reload
// only UI state, independent of notebook contents.
const tabsSource = fs.readFileSync(path.join(root,'js','32-tabs.js'),'utf8');
const tabStore = {};
const tabCtx = vm.createContext({
  console,
  document: undefined,
  window: {},
  state: null,
  localStorage: {
    getItem: k => Object.prototype.hasOwnProperty.call(tabStore,k) ? tabStore[k] : null,
    setItem: (k,v) => { tabStore[k]=v; }
  },
  defaultPageIcon: () => '□'
});
vm.runInContext(tabsSource, tabCtx);
tabCtx.nexusTabsState = {tabs:[{id:'page:p1',type:'page',target:'p1'},{id:'workspace:dashboard',type:'workspace',target:'dashboard'}],active:'workspace:dashboard'};
tabCtx.nexusTabsPersist();
tabCtx.nexusTabsState = {tabs:[],active:null};
tabCtx.nexusTabsRead();
assert.strictEqual(tabCtx.nexusTabsState.tabs.length, 2, 'Workspace tabs should persist open-tab state');
assert.strictEqual(tabCtx.nexusTabsState.active, 'workspace:dashboard', 'Workspace tabs should persist active tab');

// Pinned-tab behavior: pinning persists, pinned tabs sort first, and Close all/others never removes them.
tabCtx.toast = () => {};
tabCtx.nexusTabsState = {tabs:[
  {id:'page:a',type:'page',target:'a',pinned:false,_nexusOrder:0},
  {id:'page:b',type:'page',target:'b',pinned:true,_nexusOrder:1},
  {id:'page:c',type:'page',target:'c',pinned:false,_nexusOrder:2}
],active:'page:a'};
tabCtx.state = {pages:{a:{id:'a',title:'A',type:'page'},b:{id:'b',title:'B',type:'page'},c:{id:'c',title:'C',type:'page'}}};
tabCtx.toggleNexusTabPinned('page:a');
assert.strictEqual(tabCtx.nexusTabsState.tabs[0].id,'page:b','existing pinned tab should remain first');
assert.strictEqual(tabCtx.nexusTabsState.tabs[1].id,'page:a','newly pinned tab should join pinned group');
assert.strictEqual(tabCtx.isNexusTabPinned('page:a'),true,'tab pin state should be enabled');
tabCtx.closeNexusTab('page:a');
assert.ok(tabCtx.nexusTabsState.tabs.some(t=>t.id==='page:a'),'pinned tab should not close until unpinned');
tabCtx.nexusTabsState.active='page:c';
tabCtx.closeOtherNexusTabs();
assert.ok(tabCtx.nexusTabsState.tabs.some(t=>t.id==='page:a') && tabCtx.nexusTabsState.tabs.some(t=>t.id==='page:b'),'Close other tabs should preserve pinned tabs');
tabCtx.closeAllNexusTabs();
assert.ok(tabCtx.nexusTabsState.tabs.every(t=>t.pinned),'Close all tabs should retain pinned tabs');
tabCtx.nexusTabsPersist();
tabCtx.nexusTabsState={tabs:[],active:null};
tabCtx.nexusTabsRead();
assert.ok(tabCtx.nexusTabsState.tabs.some(t=>t.id==='page:a'&&t.pinned),'tab pin state should survive persistence');


const makeState = (device, order) => ({
  pages: {p: {id:'p',title:'P',type:'page',createdAt:1,updatedAt:device==='B'?3:1,updatedBy:device,properties:[],rootBlocks:order.slice()}},
  blocks: {
    a:{id:'a',pageId:'p',parent:null,text:'A',children:[],updatedAt:1,updatedBy:device},
    b:{id:'b',pageId:'p',parent:null,text:'B',children:[],updatedAt:1,updatedBy:device},
    c:{id:'c',pageId:'p',parent:null,text:'C',children:[],updatedAt:device==='A'?2:1,updatedBy:device}
  },
  tombstones:{pages:{},blocks:{}},templates:{},currentPageId:'p',dailyShowAll:false,deviceId:device,syncPeers:{},flashcards:{decks:{},cards:{}},stickyNotes:{cards:{}}
});
const ma = makeState('A',['a','b','c']);
const mb = makeState('B',['b','a','c']);
const merged = ctx.mergeStates(JSON.parse(JSON.stringify(ma)), JSON.parse(JSON.stringify(mb)), null).state;
ma.flashcards.decks.d={id:'d',name:'Study',createdAt:1,updatedAt:2,updatedBy:'A'};
ma.flashcards.cards.c1={id:'c1',deckId:'d',front:'F',back:'B',createdAt:1,updatedAt:2,updatedBy:'A',dueAt:0,state:'new'};
mb.flashcards.decks.d={id:'d',name:'Study',createdAt:1,updatedAt:2,updatedBy:'B'};
mb.flashcards.cards.c1={id:'c1',deckId:'d',front:'F2',back:'B2',createdAt:1,updatedAt:3,updatedBy:'B',dueAt:1,state:'review'};
const mergedWithFc = ctx.mergeStates(JSON.parse(JSON.stringify(ma)), JSON.parse(JSON.stringify(mb)), null).state;
assert.ok(mergedWithFc.flashcards && mergedWithFc.flashcards.cards.c1, 'sync merge must preserve flashcards');
assert.strictEqual(mergedWithFc.flashcards.cards.c1.front,'F2','flashcard merge should use the winning updated copy');
assert.ok(merged.pages.p.rootBlocks.length === 3, 'merge must retain all root blocks');
assert.strictEqual(JSON.stringify(merged.pages.p.rootBlocks), JSON.stringify(['b','a','c']), 'merge must converge on the winning page container order');
assert.ok(fs.existsSync(path.join(root,'js','23-daily-notes.js')), 'daily notes renderer missing');
var dailyNotes = fs.readFileSync(path.join(root,'js','23-daily-notes.js'),'utf8');
assert.ok(dailyNotes.includes('shiftDailyPage'), 'daily adjacent-day navigation missing');
assert.ok(dailyNotes.includes('daily-journal-chrome'), 'daily journal chrome missing');
assert.ok(core.includes("help-59"), 'daily notes Help catalog id missing');
assert.ok(/Logseq-inspired Daily Notes/.test(core), 'daily notes Help section missing');

const stickyModule = fs.readFileSync(path.join(root,'js','27-sticky-notes.js'),'utf8');
assert.ok(stickyModule.includes('Sticky Note Cards'), 'sticky notes module missing');
assert.ok(stickyModule.includes('makeStickyNote'), 'sticky note creation missing');
assert.ok(stickyModule.includes('renderStickyNoteSidebar'), 'sticky note sidebar missing');
assert.ok(core.includes("help-66"), 'sticky note Help catalog id missing');
assert.ok(core.includes("help-67"), 'Zettelkasten Help catalog id missing');
assert.ok(/Sticky Note Cards/.test(core), 'sticky note Help section missing');

const zkMobile = fs.readFileSync(path.join(root,'js','30-zettelkasten-mobile.js'),'utf8');
assert.ok(zkMobile.includes('ZETTELKASTEN_MOBILE_KEY'), 'mobile Zettelkasten preference key missing');
assert.ok(zkMobile.includes('setZettelkastenMobileCollapsed'), 'mobile Zettelkasten collapse state control missing');
assert.ok(zkMobile.includes('localStorage.setItem(ZETTELKASTEN_MOBILE_KEY'), 'mobile Zettelkasten state must persist locally');
assert.ok(!zkMobile.includes('setSidebarCollapsed('), 'Zettelkasten mobile controls must not mutate the main sidebar state');
assert.ok(index.includes('zettelkasten-mobile-backdrop'), 'Zettelkasten mobile backdrop missing');
assert.ok(index.includes('zettelkasten-mobile-reopen'), 'Zettelkasten mobile reopen control missing');
assert.ok(index.includes('zettelkasten-mobile-collapse'), 'Zettelkasten mobile collapse control missing');

// Focused runtime smoke test for independent collapse/expand persistence.
const mobileCtx = {
  console, setTimeout, localStorage:{_v:null,getItem(){return this._v;},setItem(k,v){this._v=v;}},
  window:{matchMedia:()=>({matches:true}),addEventListener:()=>{}},
  zettelkastenVisible:true
};
const makeEl = () => ({ style:{}, attrs:{}, classList:{s:new Set(), add(...xs){xs.forEach(x=>this.s.add(x));}, remove(...xs){xs.forEach(x=>this.s.delete(x));}, toggle(x,on){if(on)this.s.add(x);else this.s.delete(x);}, contains(x){return this.s.has(x);}}, setAttribute(k,v){this.attrs[k]=v;}, getAttribute(k){return this.attrs[k];}, addEventListener(){}, textContent:'', title:''});
mobileCtx.document={addEventListener(){}, getElementById(id){return this._els[id] || null;}, _els:{}};
['app','zettelkasten-view','page-view','zettelkasten-mobile-backdrop','zettelkasten-mobile-reopen','zettelkasten-mobile-collapse','zettelkasten-mobile-close'].forEach(id=>mobileCtx.document._els[id]=makeEl());
vm.createContext(mobileCtx);
vm.runInContext(zkMobile, mobileCtx, {filename:'30-zettelkasten-mobile.js'});
mobileCtx.zettelkastenVisible = true;
mobileCtx.applyZettelkastenMobileMode();
assert.ok(mobileCtx.document._els['app'].classList.contains('zettelkasten-mobile-active'), 'Zettelkasten should enter mobile mode');
assert.ok(mobileCtx.document._els['app'].classList.contains('zettelkasten-mobile-drawer-open'), 'Zettelkasten should open as a mobile drawer');
mobileCtx.collapseZettelkastenMobile();
assert.ok(mobileCtx.document._els['app'].classList.contains('zettelkasten-mobile-collapsed'), 'collapse should hide the mobile drawer');
assert.strictEqual(mobileCtx.localStorage._v, '1', 'collapsed state should persist');
assert.ok(mobileCtx.document._els['page-view'].classList.contains('visible'), 'collapsed state should reveal the editor/content');
assert.ok(mobileCtx.document._els['page-view'].classList.contains('zettelkasten-mobile-content-expanded'), 'collapsed state should expand content area');
mobileCtx.expandZettelkastenMobile();
assert.ok(!mobileCtx.document._els['app'].classList.contains('zettelkasten-mobile-collapsed'), 'expand should reopen the mobile drawer');
assert.strictEqual(mobileCtx.localStorage._v, '0', 'expanded state should persist');
assert.ok(!mobileCtx.document._els['app'].classList.contains('sidebar-collapsed'), 'Zettelkasten collapse must not alter main sidebar state');
assert.ok(fs.readFileSync(path.join(root,'css','styles.css'),'utf8').includes('#app.zettelkasten-mobile-collapsed #page-view.zettelkasten-mobile-content-expanded'), 'collapsed Zettelkasten should preserve a full-width content layout');

// Command Center smoke: permanent entry, independent workspace, shortcut and command registry.
const ccSource = fs.readFileSync(path.join(root,'js','31-command-center.js'),'utf8');
assert.ok(ccSource.includes('Command Center'), 'Command Center module should contain its label');
assert.ok(ccSource.includes('Central Command Center'), 'Command Center module title missing');
assert.ok(ccSource.includes('commandCenterCommands'), 'Command Center registry missing');
assert.ok(ccSource.includes("e.shiftKey&&(e.key==='k'"), 'Command Center keyboard shortcut missing');
assert.ok(index.includes('id="btn-command-center"'), 'Command Center sidebar control missing');
assert.ok(index.includes('id="command-center-search"'), 'Command Center search control missing');
assert.ok(fs.readFileSync(path.join(root,'css','styles.css'),'utf8').includes('#command-center-view{display:none'), 'Command Center should be hidden until opened');

assert.ok(lockCode.includes('Promise.resolve(flushed).catch(function(){});'), 'passcode lock should initiate the save flush without blocking the security boundary');
assert.ok(lockCode.includes('function closeSecurityOverlays()'), 'lockNow should close all security overlays');
const swCode = fs.readFileSync(path.join(root,'sw.js'),'utf8');
assert.ok(swCode.includes("CACHE='nexus-shell-v6'"), 'mobile sidebar update must bump the PWA cache generation');
assert.ok(swCode.includes("fetch(req,{cache:'no-store'})"), 'PWA fetch must revalidate updated security assets');
assert.ok(index.includes('09-security-lock.js?v=20260919-passcode-v7-true-launch-off'), 'security script must be cache-busted for the passcode launch policy repair');
