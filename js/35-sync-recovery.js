/* ============================================================
 * 35-sync-recovery.js
 * Sync cleanup, duplicate-page cleanup, and richer version history.
 *
 * Goals:
 *   - keep sync conflict records actionable instead of endlessly duplicating
 *   - identify same-title pages that are likely sync duplicates
 *   - archive exact-content duplicates conservatively (never hard-delete)
 *   - keep a deeper, deduplicated version history with pins and checkpoints
 *   - create a recovery snapshot before destructive/structural sync cleanup
 * ============================================================ */
"use strict";

/* ---------- version-history upgrade ---------- */
var NEXUS_VERSION_HISTORY_MAX = 20;
try{ MAX_VERSIONS = NEXUS_VERSION_HISTORY_MAX; }catch(ignoreMax){}

function nexusRecoveryHash(str){
  var h1 = 2166136261 >>> 0, h2 = 16777619 >>> 0;
  for(var i=0;i<str.length;i++){
    var c = str.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 16777619);
    h2 ^= (c + i) & 255; h2 = Math.imul(h2, 2166136261);
  }
  return (h1>>>0).toString(16).padStart(8,'0') + (h2>>>0).toString(16).padStart(8,'0');
}

function nexusVersionJson(){ return JSON.stringify(state); }

/* Replace the original snapshot function with a deduplicating, pinned-aware
   implementation while retaining the same global API used by older modules. */
var nexusOriginalSnapshotVersion = typeof snapshotVersion === 'function' ? snapshotVersion : null;
function snapshotVersion(reason, options){
  options = options || {};
  var json = nexusVersionJson();
  var hash = nexusRecoveryHash(json);
  var now = Date.now();
  return loadVersions().then(function(list){
    var same = list.filter(function(v){ return v.hash === hash; }).sort(function(a,b){ return b.ts-a.ts; })[0];
    if(same){
      /* A repeated identical sync tick should not consume retention slots. */
      if(options.pin && !same.pinned) return nexusSetVersionPinned(same.ts, true).then(function(){ return same; });
      return same;
    }
    var entry = {
      ts: now,
      reason: String(options.label || reason || 'snapshot'),
      data: json,
      hash: hash,
      pinned: !!options.pin,
      source: options.source || 'local'
    };
    return putVersion(entry).then(function(){ return loadVersions(); }).then(function(all){
      if(all.length <= NEXUS_VERSION_HISTORY_MAX) return entry;
      var unpinned = all.filter(function(v){ return !v.pinned; }).sort(function(a,b){ return a.ts-b.ts; });
      var excess = all.length - NEXUS_VERSION_HISTORY_MAX;
      return Promise.all(unpinned.slice(0, excess).map(function(v){ return deleteVersion(v.ts); })).then(function(){ return entry; });
    });
  }).catch(function(){ return null; });
}

function nexusReadVersionEntry(ts){
  return openAttachmentDb().then(function(db){
    return new Promise(function(resolve,reject){
      var tx=db.transaction(VERS_STORE,'readonly'), req=tx.objectStore(VERS_STORE).get(ts);
      req.onsuccess=function(){resolve(req.result||null);}; req.onerror=function(){reject(req.error);};
    });
  });
}
function nexusWriteVersionEntry(entry){
  return openAttachmentDb().then(function(db){
    return new Promise(function(resolve,reject){
      var tx=db.transaction(VERS_STORE,'readwrite'); tx.objectStore(VERS_STORE).put(entry);
      tx.oncomplete=function(){resolve(entry);}; tx.onerror=function(){reject(tx.error);};
    });
  });
}
function nexusSetVersionPinned(ts,pinned){
  return nexusReadVersionEntry(ts).then(function(entry){
    if(!entry) return null;
    entry.pinned = !!pinned;
    return nexusWriteVersionEntry(entry);
  });
}
function nexusDeleteVersion(ts){ return deleteVersion(ts); }
function nexusCleanVersions(){
  return loadVersions().then(function(list){
    var unpinned = list.filter(function(v){ return !v.pinned; }).sort(function(a,b){ return a.ts-b.ts; });
    var excess = Math.max(0, list.length - NEXUS_VERSION_HISTORY_MAX);
    if(!excess) return list;
    return Promise.all(unpinned.slice(0, excess).map(function(v){ return deleteVersion(v.ts); })).then(function(){ return loadVersions(); });
  });
}

function versionReasonLabel(entry){
  return entry.reason || 'snapshot';
}
function formatVersionDate(ts){ return new Date(ts).toLocaleString(); }

function createNamedCheckpoint(){
  var label = prompt('Name this recovery checkpoint:', 'manual checkpoint');
  if(label === null) return;
  label = label.trim() || 'manual checkpoint';
  snapshotVersion(label, {label:label, pin:false, source:'manual'}).then(function(){ renderVersionHistoryList(); toast('Recovery checkpoint created.'); });
}

function renderVersionHistoryList(){
  var wrap = document.getElementById('versions-list');
  if(!wrap) return;
  var filterEl = document.getElementById('version-filter');
  var q = filterEl ? filterEl.value.trim().toLowerCase() : '';
  wrap.innerHTML = '<div class="version-empty">Loading…</div>';
  loadVersions().then(function(list){
    list = list.slice().sort(function(a,b){ return b.ts-a.ts; }).filter(function(v){ return !q || (versionReasonLabel(v)+' '+formatVersionDate(v.ts)).toLowerCase().indexOf(q)!==-1; });
    wrap.innerHTML='';
    if(!list.length){ wrap.innerHTML='<div class="version-empty">No matching recovery points.</div>'; return; }
    list.forEach(function(entry){
      var row=document.createElement('div'); row.className='version-item'+(entry.pinned?' pinned':'');
      var left=document.createElement('div'); left.className='version-main';
      var title=document.createElement('div'); title.className='version-title'; title.textContent=(entry.pinned?'📌 ':'')+versionReasonLabel(entry);
      var meta=document.createElement('div'); meta.className='v-meta'; meta.textContent=formatVersionDate(entry.ts)+(entry.source?' · '+entry.source:'')+(entry.hash?' · '+entry.hash.slice(0,8):'');
      left.appendChild(title); left.appendChild(meta);
      var actions=document.createElement('div'); actions.className='version-actions';
      var pin=document.createElement('button'); pin.type='button'; pin.textContent=entry.pinned?'Unpin':'Pin'; pin.onclick=function(){ nexusSetVersionPinned(entry.ts,!entry.pinned).then(renderVersionHistoryList); };
      var cmp=document.createElement('button'); cmp.type='button'; cmp.textContent='Compare'; cmp.onclick=function(){ openVersionDiff(entry); };
      var restore=document.createElement('button'); restore.type='button'; restore.textContent='Restore'; restore.onclick=function(){ restoreFromVersion(entry); };
      var del=document.createElement('button'); del.type='button'; del.textContent='Delete'; del.disabled=!!entry.pinned; del.title=entry.pinned?'Unpin this version before deleting it.':'Delete this recovery point'; del.onclick=function(){ if(confirm('Delete this recovery point?')) nexusDeleteVersion(entry.ts).then(renderVersionHistoryList); };
      actions.appendChild(pin); actions.appendChild(cmp); actions.appendChild(restore); actions.appendChild(del);
      row.appendChild(left); row.appendChild(actions); wrap.appendChild(row);
    });
  });
}

function openVersionsUpgraded(){
  var wrap=document.getElementById('versions-list'); if(wrap) wrap.innerHTML='<div class="version-empty">Loading…</div>';
  var overlay=document.getElementById('versions-overlay'); if(overlay) overlay.style.display='flex';
  renderVersionHistoryList();
}
openVersions = openVersionsUpgraded;

/* Upgrade restore behavior: create a safety point first, then restore. */
var nexusOriginalRestoreFromVersion = typeof restoreFromVersion === 'function' ? restoreFromVersion : null;
function restoreFromVersionUpgraded(entry){
  if(!confirm('Restore this snapshot from '+formatVersionDate(entry.ts)+'? A safety snapshot of the current notebook will be created first.')) return;
  snapshotVersion('before version restore', {source:'restore'}).then(function(){
    return getVersionData(entry);
  }).then(function(json){
    state = normalizeState(JSON.parse(json));
    save(); renderAll(); closeVersions(); toast('Snapshot restored.');
  }).catch(function(){ toast('That snapshot could not be restored.'); });
}
restoreFromVersion = restoreFromVersionUpgraded;

function nexusBeforeSyncRecoverySnapshot(){
  return snapshotVersion('before sync merge', {source:'sync-merge'});
}

/* ---------- conflict log cleanup ---------- */
function conflictFingerprint(c){
  return [c.kind,c.entityId,c.pageId,c.keptText,c.droppedText].map(function(x){ return String(x||''); }).join('¦');
}
function conflictIsStale(c){
  if(!c) return true;
  if(c.kind==='line'){
    var b=state.blocks && state.blocks[c.entityId];
    return !b || !b.conflict;
  }
  if(c.kind==='page'){
    var p=state.pages && state.pages[c.pageId||c.entityId];
    return !p || !!p.trashedAt;
  }
  return true;
}
function nexusCleanConflictLog(){
  var list=loadConflicts(); var seen={}; var out=[]; var removed=0;
  list.sort(function(a,b){ return (b.detectedAt||0)-(a.detectedAt||0); }).forEach(function(c){
    if(conflictIsStale(c)){ removed++; return; }
    var fp=conflictFingerprint(c);
    if(seen[fp]){ removed++; return; }
    seen[fp]=true; out.push(c);
  });
  saveConflictsList(out); updateConflictsBadge(); renderConflictsList();
  toast(removed ? ('Cleaned '+removed+' stale/duplicate conflict record'+(removed===1?'':'s')+'.') : 'Conflict log is already clean.');
  renderSyncCenter();
}
function nexusConsolidateConflicts(){
  var list=loadConflicts(); var seen={}; var out=[];
  list.sort(function(a,b){ return (b.detectedAt||0)-(a.detectedAt||0); }).forEach(function(c){
    var key=String(c.kind)+'¦'+String(c.entityId||c.pageId||'');
    if(seen[key]) return;
    seen[key]=true; out.push(c);
  });
  saveConflictsList(out); updateConflictsBadge(); renderConflictsList(); renderSyncCenter();
  toast('Kept the latest conflict record for each affected item.');
}

/* Wrap conflict recording so repeated sync cycles cannot append the exact
   same conflict endlessly. */
var nexusOriginalRecordConflicts = typeof recordConflicts === 'function' ? recordConflicts : null;
function recordConflicts(newOnes, peerLabel){
  if(!newOnes || !newOnes.length) return;
  var list=loadConflicts();
  var byFp={}; list.forEach(function(c){ byFp[conflictFingerprint(c)]=c; });
  newOnes.forEach(function(c){
    c.id = c.id || uid(); c.detectedAt=Date.now(); c.peerLabel=peerLabel;
    var fp=conflictFingerprint(c);
    if(byFp[fp]){ byFp[fp].detectedAt=c.detectedAt; byFp[fp].peerLabel=peerLabel; }
    else { list.unshift(c); byFp[fp]=c; }
  });
  list.sort(function(a,b){ return (b.detectedAt||0)-(a.detectedAt||0); });
  if(list.length>CONFLICTS_MAX) list.length=CONFLICTS_MAX;
  saveConflictsList(list); updateConflictsBadge(); renderSyncCenter();
}

/* ---------- duplicate pages ---------- */
function nexusNormPageTitle(title){ return String(title||'').trim().replace(/\s+/g,' ').toLowerCase(); }
function nexusCanonicalBlockTree(pageId){
  var page=state.pages && state.pages[pageId];
  if(!page) return [];
  function walk(ids, depth){
    return (ids||[]).filter(function(id){return !!state.blocks[id];}).map(function(id){
      var b=state.blocks[id];
      return {text:String(b.text||''), collapsed:!!b.collapsed, depth:depth, children:walk(b.children||[],depth+1)};
    });
  }
  return walk(page.rootBlocks||[],0);
}
function nexusDuplicateFingerprint(page){
  return nexusRecoveryHash(JSON.stringify({
    title:nexusNormPageTitle(page.title),
    type:page.type||'page',
    properties:page.properties||[],
    folderId:page.folderId||null,
    blocks:nexusCanonicalBlockTree(page.id)
  }));
}
function scanNexusDuplicateGroups(){
  var groups={};
  livePages().forEach(function(p){
    var key=nexusNormPageTitle(p.title); if(!key) return;
    if(!groups[key]) groups[key]=[];
    groups[key].push(p);
  });
  return Object.keys(groups).map(function(key){
    var pages=groups[key]; if(pages.length<2) return null;
    var exactGroups={};
    pages.forEach(function(p){ var fp=nexusDuplicateFingerprint(p); (exactGroups[fp]||(exactGroups[fp]=[])).push(p); });
    var exact=Object.keys(exactGroups).filter(function(k){return exactGroups[k].length>1;}).reduce(function(n,k){return n+exactGroups[k].length-1;},0);
    return {title:pages[0].title,pages:pages.slice().sort(function(a,b){return (b.updatedAt||b.createdAt||0)-(a.updatedAt||a.createdAt||0);}),exactDuplicateCount:exact};
  }).filter(Boolean);
}
function nexusProtectedSystemPage(p){
  return !!(p && (p.systemPage || p.systemQueryPage || p.systemStickyNotesPage || p.permanentSidebar || p.permanentSidebarQuery || p.permanentSidebarStickyNotes || p.helpGuideVersion));
}
function chooseDuplicateCanonical(pages){
  return pages.slice().sort(function(a,b){
    var pa=nexusProtectedSystemPage(a)?1:0, pb=nexusProtectedSystemPage(b)?1:0;
    if(pa!==pb) return pb-pa;
    var la=a.locked?1:0, lb=b.locked?1:0;
    if(la!==lb) return lb-la;
    return (b.updatedAt||b.createdAt||0)-(a.updatedAt||a.createdAt||0) || String(a.id).localeCompare(String(b.id));
  })[0];
}
function archiveExactDuplicatePages(){
  var groups=scanNexusDuplicateGroups(); var exactTargets=[];
  groups.forEach(function(g){
    var byFp={}; g.pages.forEach(function(p){ var fp=nexusDuplicateFingerprint(p); (byFp[fp]||(byFp[fp]=[])).push(p); });
    Object.keys(byFp).forEach(function(fp){
      var same=byFp[fp]; if(same.length<2) return;
      var canonical=chooseDuplicateCanonical(same);
      same.forEach(function(p){ if(p.id!==canonical.id && !p.locked && !nexusProtectedSystemPage(p)) exactTargets.push({duplicate:p,canonical:canonical}); });
    });
  });
  if(!exactTargets.length){ toast('No exact-content duplicate pages found.'); renderSyncCenter(); return; }
  snapshotVersion('before duplicate cleanup', {source:'sync-cleanup',pin:true}).then(function(){
    var now=Date.now(); exactTargets.forEach(function(item){
      var p=item.duplicate;
      p.trashedAt=now; p.duplicateOf=item.canonical.id; p.updatedAt=now; p.updatedBy=state.deviceId;
    });
    save(); renderAll();
    toast('Archived '+exactTargets.length+' exact duplicate page'+(exactTargets.length===1?'':'s')+'. The originals remain recoverable in Trash.');
    renderSyncCenter();
  });
}
function renderDuplicateDetails(){
  var wrap=document.getElementById('sync-center-duplicates'); if(!wrap) return;
  var groups=scanNexusDuplicateGroups();
  wrap.hidden=false; wrap.innerHTML='';
  if(!groups.length){ wrap.innerHTML='<div class="sync-center-empty">No same-title duplicate page groups found.</div>'; return; }
  groups.forEach(function(g){
    var card=document.createElement('div'); card.className='duplicate-group';
    var head=document.createElement('div'); head.className='duplicate-group-head'; head.textContent=g.title+' · '+g.pages.length+' pages'; card.appendChild(head);
    var body=document.createElement('div'); body.className='duplicate-group-body';
    g.pages.forEach(function(p){
      var row=document.createElement('div'); row.className='duplicate-row';
      var fp=nexusDuplicateFingerprint(p); var exactPeers=g.pages.filter(function(x){return nexusDuplicateFingerprint(x)===fp;}).length;
      row.innerHTML='<div><strong>'+escapeHtml(p.title)+'</strong><span>'+escapeHtml((p.id||'').slice(0,10))+' · '+(p.blocksCount||Object.keys(state.blocks).filter(function(id){return state.blocks[id].pageId===p.id;}).length)+' blocks · '+new Date(p.updatedAt||p.createdAt||Date.now()).toLocaleString()+'</span></div><em>'+ (exactPeers>1?'Exact-content duplicate':'Different content') +'</em>';
      body.appendChild(row);
    });
    card.appendChild(body); wrap.appendChild(card);
  });
}

/* ---------- sync center UI ---------- */
function getSyncCenterStats(){
  var conflicts=loadConflicts();
  var groups=scanNexusDuplicateGroups();
  var exact=groups.reduce(function(n,g){return n+g.exactDuplicateCount;},0);
  return {conflicts:conflicts.length, duplicateGroups:groups.length, exactDuplicates:exact};
}
function renderSyncCenter(){
  var s=getSyncCenterStats();
  var sum=document.getElementById('sync-center-summary'); if(sum) sum.textContent=(s.conflicts?'⚠ '+s.conflicts+' conflict record'+(s.conflicts===1?'':'s')+' · ':'')+(s.duplicateGroups?s.duplicateGroups+' duplicate group'+(s.duplicateGroups===1?'':'s')+' · ':'')+(s.exactDuplicates?s.exactDuplicates+' safe exact duplicate'+(s.exactDuplicates===1?'':'s')+' · ':'')+'Recovery history is protected.';
  var c=document.getElementById('sync-center-conflict-count'); if(c) c.textContent=s.conflicts;
  var d=document.getElementById('sync-center-duplicate-count'); if(d) d.textContent=s.duplicateGroups;
  var v=document.getElementById('sync-center-version-count'); if(v) loadVersions().then(function(list){ v.textContent=list.length; });
}
function openSyncCenter(){
  var ov=document.getElementById('sync-center-overlay');
  if(ov) ov.style.display='flex';
  try{ renderSyncCenter(); }catch(ignore){
    var sum=document.getElementById('sync-center-summary');
    if(sum) sum.textContent='Sync recovery is ready. Live counts will appear after the notebook is loaded.';
  }
}
function closeSyncCenter(){ var ov=document.getElementById('sync-center-overlay'); if(ov) ov.style.display='none'; }

/* Wrap sync merge: preserve the pre-merge notebook as a recovery point if the
   incoming state changes anything. This is deliberately non-blocking — the
   merge should still be able to complete if IndexedDB is unavailable. */
var nexusOriginalApplyIncomingMerge = typeof applyIncomingMerge === 'function' ? applyIncomingMerge : null;
if(nexusOriginalApplyIncomingMerge){
  applyIncomingMerge = function(merged){
    var changed = JSON.stringify(merged)!==JSON.stringify(state);
    if(changed) nexusBeforeSyncRecoverySnapshot();
    return nexusOriginalApplyIncomingMerge(merged);
  };
}

function initSyncRecovery(){
  var btn=document.getElementById('btn-sync-center'); if(btn) btn.onclick=openSyncCenter;
  var close=document.getElementById('sync-center-close'); if(close) close.onclick=closeSyncCenter;
  var ov=document.getElementById('sync-center-overlay'); if(ov) ov.addEventListener('click',function(e){if(e.target===ov)closeSyncCenter();});
  var review=document.getElementById('sync-center-review-conflicts'); if(review) review.onclick=function(){closeSyncCenter();openConflicts();};
  var openCleanup=document.getElementById('conflicts-open-cleanup'); if(openCleanup) openCleanup.onclick=function(){closeConflicts();openSyncCenter();};
  var clean=document.getElementById('sync-center-clean-conflicts'); if(clean) clean.onclick=nexusCleanConflictLog;
  var consolidate=document.getElementById('sync-center-consolidate-conflicts'); if(consolidate) consolidate.onclick=nexusConsolidateConflicts;
  var scan=document.getElementById('sync-center-scan-duplicates'); if(scan) scan.onclick=renderDuplicateDetails;
  var arch=document.getElementById('sync-center-archive-exact'); if(arch) arch.onclick=archiveExactDuplicatePages;
  var openV=document.getElementById('sync-center-open-versions'); if(openV) openV.onclick=function(){closeSyncCenter();openVersionsUpgraded();};
  var checkpoint=document.getElementById('sync-center-create-checkpoint'); if(checkpoint) checkpoint.onclick=function(){createNamedCheckpoint();renderSyncCenter();};
  var vf=document.getElementById('version-filter'); if(vf) vf.addEventListener('input',renderVersionHistoryList);
  var vc=document.getElementById('version-create-btn'); if(vc) vc.onclick=createNamedCheckpoint;
  var vp=document.getElementById('version-prune-btn'); if(vp) vp.onclick=function(){if(confirm('Clean old unpinned recovery points now? Pinned snapshots are protected.')) nexusCleanVersions().then(function(){renderVersionHistoryList();renderSyncCenter();toast('Version history cleaned.');});};
  var vx=document.getElementById('versions-close-btn'); if(vx) vx.onclick=closeVersions;
  var vo=document.getElementById('versions-overlay'); if(vo) vo.addEventListener('click',function(e){if(e.target===vo)closeVersions();});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'){closeSyncCenter();}});
  /* Make the richer version renderer take over the old handler. */
  var vb=document.getElementById('btn-versions'); if(vb) vb.onclick=openVersionsUpgraded;
  /* During script loading `state` is intentionally null because the
     notebook is loaded asynchronously later. Rendering here used to throw
     before the UI was wired, leaving recovery controls in a partially
     initialized state. Wire first; render only once state exists or when
     the hub is explicitly opened. */
  if(typeof state !== 'undefined' && state && state.pages) {
    try{ renderSyncCenter(); }catch(ignore){ }
  }
}

/* init after all earlier modules are loaded, before wiring's final boot. */
initSyncRecovery();
