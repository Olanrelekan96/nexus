const fs=require('fs'), path=require('path'), vm=require('vm'), assert=require('assert');
const src=fs.readFileSync(path.join(__dirname,'..','js','35-sync-recovery.js'),'utf8');
function el(){return {style:{},hidden:false,textContent:'',innerHTML:'',disabled:false,value:'',setAttribute(){},addEventListener(){},appendChild(){},classList:{toggle(){}}};}
const els={};
['btn-sync-center','sync-center-close','sync-center-overlay','sync-center-review-conflicts','conflicts-open-cleanup','sync-center-clean-conflicts','sync-center-consolidate-conflicts','sync-center-scan-duplicates','sync-center-archive-exact','sync-center-open-versions','sync-center-create-checkpoint','version-filter','version-create-btn','version-prune-btn','versions-close-btn','versions-overlay','versions-list','sync-center-summary','sync-center-conflict-count','sync-center-duplicate-count','sync-center-version-count','sync-center-duplicates'].forEach(id=>els[id]=el());
let conflicts=[];
let versions=[];
const ctx={
  console, Date, Promise, setTimeout, clearTimeout,
  STORAGE_KEY:'nexus', VERS_STORE:'versions', CONFLICTS_MAX:200, uid:(()=>{let n=0;return ()=> 't'+(++n)})(),
  state:{pages:{},blocks:{},titleIndex:{},deviceId:'A',folders:{},templates:{},flashcards:{decks:{},cards:{}},stickyNotes:{cards:{}},tombstones:{pages:{},blocks:{}}},
  document:{getElementById:id=>els[id]||null, addEventListener(){}},
  localStorage:{getItem(){return JSON.stringify(conflicts);},setItem(k,v){conflicts=JSON.parse(v);}},
  loadConflicts:()=>conflicts.slice(),
  saveConflictsList:v=>{conflicts=JSON.parse(JSON.stringify(v));},
  updateConflictsBadge(){}, renderConflictsList(){}, renderAll(){}, renderPage(){}, save(){}, toast(){},
  livePages(){return Object.values(ctx.state.pages).filter(p=>!p.trashedAt);},
  escapeHtml:s=>String(s).replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m])),
  loadVersions:()=>Promise.resolve(versions.slice()),
  putVersion:entry=>{versions.push(JSON.parse(JSON.stringify(entry))); return Promise.resolve();},
  deleteVersion:ts=>{versions=versions.filter(v=>v.ts!==ts);return Promise.resolve();},
  openAttachmentDb:()=>Promise.reject(new Error('not used in focused test')),
  getVersionData:()=>Promise.resolve('{}'),
  closeVersions(){}, closeConflicts(){}, openConflicts(){},
  saveMeta(){},
  openVersionDiff(){},
  restoreFromVersion(){},
  recordUndoCheckpoint(){},
  MAX_VERSIONS:5,
  applyIncomingMerge(){},
  isPermanentDatabasePage(){return false;},isPermanentQueryPage(){return false;},isPermanentStickyNotesPage(){return false;}
};
vm.createContext(ctx); vm.runInContext(src,ctx,{filename:'35-sync-recovery.js'});

// Duplicate detector: exact same-title copies are classified separately from meaningful differences.
const makePage=(id,title,text,updatedAt)=>({id,title,type:'page',properties:[],folderId:null,rootBlocks:[id+'b'],updatedAt,createdAt:1});
ctx.state.pages={a:makePage('a','Research','',30),b:makePage('b',' research ','',20),c:makePage('c','Research','Different',10)};
ctx.state.blocks={ab:{id:'ab',pageId:'a',parent:null,text:'Same',children:[],collapsed:false},bb:{id:'bb',pageId:'b',parent:null,text:'Same',children:[],collapsed:false},cb:{id:'cb',pageId:'c',parent:null,text:'Different',children:[],collapsed:false}};
let groups=ctx.scanNexusDuplicateGroups(); assert.strictEqual(groups.length,1,'same-title pages should form one duplicate group'); assert.strictEqual(groups[0].exactDuplicateCount,1,'exact-content duplicate should be classified separately');

// Conflict log: repeated identical conflicts are consolidated.
conflicts=[];
const conflict={kind:'line',entityId:'b1',pageId:'p',pageTitle:'P',keptText:'new',droppedText:'old'};
ctx.recordConflicts([JSON.parse(JSON.stringify(conflict))],'Device B');
ctx.recordConflicts([JSON.parse(JSON.stringify(conflict))],'Device B');
assert.strictEqual(conflicts.length,1,'identical sync conflict should not be recorded twice');
ctx.state.blocks.b1={id:'b1',pageId:'p',text:'new',children:[]};
ctx.nexusCleanConflictLog();
assert.strictEqual(conflicts.length,0,'stale line conflict should be cleaned after its conflict marker disappears');

// Version snapshot wrapper: identical states deduplicate and named metadata is retained.
versions=[];
ctx.state.pages={p:makePage('p','P','',1)}; ctx.state.blocks={pb:{id:'pb',pageId:'p',parent:null,text:'one',children:[]}};
(async()=>{
  await ctx.snapshotVersion('checkpoint',{label:'Checkpoint A',source:'manual',pin:true});
  await ctx.snapshotVersion('checkpoint',{label:'Checkpoint A',source:'manual',pin:true});
  assert.strictEqual(versions.length,1,'identical snapshots should deduplicate');
  assert.strictEqual(versions[0].pinned,true,'snapshot pin must persist');
  assert.strictEqual(versions[0].reason,'Checkpoint A','snapshot label must persist');
  console.log('Sync recovery tests passed.');
})();
