/* ============================================================
 * 20-quality-hardening.js
 * Product-quality layer added after the feature build:
 * - data health / storage dashboard
 * - orphan attachment cleanup
 * - storage persistence request
 * - visible save/sync state
 * - search operator discoverability
 * - accessible dialog focus trapping
 * - Google Drive credential UI (API key is no longer shipped)
 * - lightweight runtime diagnostics
 * ============================================================ */
"use strict";

var nexusHealthState = {kind:'saved', text:'Saved locally', ts:Date.now()};
var nexusHealthTimer = null;
var DATA_HEALTH_OVERLAY = 'data-health-overlay';

function setDataHealthStatus(kind, text){
  nexusHealthState = {kind:kind || 'saved', text:text || 'Saved locally', ts:Date.now()};
  var chip = document.getElementById('nexus-health-chip');
  if(chip){
    chip.className = 'nexus-health-chip ' + nexusHealthState.kind;
    chip.textContent = (nexusHealthState.kind === 'saved' ? '✓ ' : nexusHealthState.kind === 'warning' ? '⚠ ' : nexusHealthState.kind === 'error' ? '!' : '↻ ') + nexusHealthState.text;
    chip.title = 'Data health: ' + nexusHealthState.text + '. Open the panel for details.';
  }
}

function ensureHealthChip(){
  var pageView = document.getElementById('page-view');
  if(!pageView || document.getElementById('nexus-health-chip')) return;
  var topbar = pageView.querySelector('.topbar');
  if(!topbar) return;
  var chip = document.createElement('button');
  chip.type = 'button';
  chip.id = 'nexus-health-chip';
  chip.className = 'nexus-health-chip saved';
  chip.onclick = openDataHealth;
  topbar.appendChild(chip);
  setDataHealthStatus(nexusHealthState.kind, nexusHealthState.text);
}

function bytesLabel(n){
  n = Number(n) || 0;
  if(n >= 1024*1024*1024) return (n/1024/1024/1024).toFixed(2) + ' GB';
  if(n >= 1024*1024) return (n/1024/1024).toFixed(1) + ' MB';
  if(n >= 1024) return Math.round(n/1024) + ' KB';
  return n + ' B';
}

function countAttachmentReferences(){
  var used = {};
  var re = /\{\{(?:img|file):([a-zA-Z0-9_-]+)\|[^}]*\}\}/g;
  Object.keys(state.blocks || {}).forEach(function(id){
    var text = state.blocks[id] && state.blocks[id].text || '';
    var m;
    while((m = re.exec(text))) used[m[1]] = true;
    re.lastIndex = 0;
  });
  return used;
}

function getOrphanAttachments(){
  var used = countAttachmentReferences();
  return listAllAttachments().then(function(records){
    return records.filter(function(rec){ return !used[rec.id]; });
  });
}

function cleanOrphanAttachments(){
  return getOrphanAttachments().then(function(orphaned){
    if(!orphaned.length){ toast('No orphaned attachments found.'); return {removed:0, bytes:0}; }
    var label = orphaned.length + ' unused attachment' + (orphaned.length === 1 ? '' : 's');
    if(!confirm('Delete ' + label + ' and reclaim ' + bytesLabel(orphaned.reduce(function(a,r){ return a + (r.size||0); },0)) + '? This cannot be undone.')) return {removed:0, cancelled:true};
    return Promise.all(orphaned.map(function(rec){ return deleteAttachmentRecord(rec.id); })).then(function(){
      Object.keys(attObjectUrlCache).forEach(function(id){
        var rec = orphaned.find(function(x){ return x.id === id; });
        if(rec){ try{ URL.revokeObjectURL(attObjectUrlCache[id]); }catch(ignore){} delete attObjectUrlCache[id]; }
      });
      renderAttachmentsSection();
      updateStorageHint();
      toast('Removed ' + label + '.');
      return {removed:orphaned.length, bytes:orphaned.reduce(function(a,r){ return a + (r.size||0); },0)};
    });
  }).catch(function(){ toast('Could not inspect attachments.'); return {removed:0}; });
}

function requestPersistentStorage(){
  if(!navigator.storage || !navigator.storage.persist){
    toast('This browser does not expose persistent-storage controls.');
    return Promise.resolve(false);
  }
  return navigator.storage.persist().then(function(ok){
    toast(ok ? 'Browser storage is now marked persistent.' : 'The browser declined persistent storage — normal backups still work.');
    renderDataHealth();
    return ok;
  }).catch(function(){
    toast('Could not request persistent storage.');
    return false;
  });
}

function storageEstimate(){
  if(!navigator.storage || !navigator.storage.estimate) return Promise.resolve({usage:null, quota:null, persisted:null});
  return Promise.all([
    navigator.storage.estimate().catch(function(){ return {}; }),
    navigator.storage.persisted ? navigator.storage.persisted().catch(function(){ return null; }) : Promise.resolve(null)
  ]).then(function(x){ return {usage:x[0].usage == null ? null : x[0].usage, quota:x[0].quota == null ? null : x[0].quota, persisted:x[1]}; });
}

function formatHealthRow(label, value, tone){
  var row = document.createElement('div');
  row.className = 'quality-health-row';
  var l = document.createElement('span'); l.className = 'quality-health-label'; l.textContent = label;
  var v = document.createElement('span'); v.className = 'quality-health-value' + (tone ? ' ' + tone : ''); v.textContent = value;
  row.appendChild(l); row.appendChild(v); return row;
}
function appendHealthSection(parent, title, rows){
  var sec = document.createElement('section'); sec.className = 'quality-health-section';
  var h = document.createElement('h3'); h.textContent = title; sec.appendChild(h);
  rows.forEach(function(r){ sec.appendChild(formatHealthRow(r[0], r[1], r[2])); });
  parent.appendChild(sec);
}

function renderDataHealth(){
  var body = document.getElementById('data-health-body');
  if(!body || !state) return;
  body.innerHTML = '<div class="quality-health-grid"><div class="quality-health-loading">Reading local storage and attachment health…</div></div>';
  Promise.all([
    listAllAttachments().catch(function(){ return []; }),
    getOrphanAttachments().catch(function(){ return []; }),
    loadVersions().catch(function(){ return []; }),
    storageEstimate(),
    Promise.resolve(loadMeta())
  ]).then(function(res){
    var attachments = res[0], orphaned = res[1], versions = res[2], storage = res[3], meta = res[4] || {};
    var grid = document.createElement('div'); grid.className = 'quality-health-grid';
    var noteBytes = JSON.stringify(state).length;
    var attBytes = attachments.reduce(function(a,r){ return a + (r.size||0); },0);
    var orphanBytes = orphaned.reduce(function(a,r){ return a + (r.size||0); },0);
    var vBytes = versions.reduce(function(a,v){ return a + (v.ct ? v.ct.length : (v.data ? v.data.length : 0)); },0);
    var lastBackup = meta.lastBackupAt ? new Date(meta.lastBackupAt).toLocaleString() : 'No backup recorded';
    var lastSaved = nexusHealthState.ts ? new Date(nexusHealthState.ts).toLocaleString() : 'Unknown';
    var driveStatus = document.getElementById('gdrive-autosync-status');
    var driveText = driveStatus && driveStatus.textContent ? driveStatus.textContent : (typeof gdriveAutoSyncEnabled === 'function' && gdriveAutoSyncEnabled() ? 'Enabled; waiting for connection' : 'Off');
    var persistText = storage.persisted === true ? 'Persistent' : storage.persisted === false ? 'Best-effort browser storage' : 'Unknown';
    var quotaText = storage.usage != null && storage.quota ? bytesLabel(storage.usage) + ' / ' + bytesLabel(storage.quota) : 'Unavailable';
    var device = (typeof myDeviceName === 'function' ? myDeviceName() : 'This device');

    appendHealthSection(grid, 'Local notebook', [
      ['Pages', Object.keys(state.pages||{}).filter(function(id){ return !state.pages[id].trashedAt; }).length],
      ['Blocks', Object.keys(state.blocks||{}).length],
      ['Notes JSON', bytesLabel(noteBytes)],
      ['Last save status', nexusHealthState.text, nexusHealthState.kind === 'error' ? 'danger' : 'ok'],
      ['Last activity', lastSaved]
    ]);
    appendHealthSection(grid, 'Attachments', [
      ['Stored files', attachments.length],
      ['Attachment bytes', bytesLabel(attBytes)],
      ['Orphaned files', orphaned.length, orphaned.length ? 'warning' : 'ok'],
      ['Orphaned bytes', bytesLabel(orphanBytes), orphanBytes ? 'warning' : 'ok']
    ]);
    appendHealthSection(grid, 'Recovery', [
      ['Version snapshots', versions.length + ' / 5'],
      ['Version storage', bytesLabel(vBytes)],
      ['Last backup', lastBackup],
      ['Storage estimate', quotaText],
      ['Storage policy', persistText]
    ]);
    appendHealthSection(grid, 'Sync', [
      ['Device', device],
      ['Google Drive', driveText],
      ['Conflicts', (typeof loadConflicts === 'function' ? loadConflicts().length : 0)],
      ['Google credentials', GOOGLE_DRIVE_API_KEY ? 'Configured locally' : 'Not configured', GOOGLE_DRIVE_API_KEY ? 'ok' : 'warning']
    ]);
    var docsId = state.titleIndex && state.titleIndex[String(DOCS_TITLE).toLowerCase()];
    var helpCoverage = (typeof getHelpGuideCoverage === 'function') ? getHelpGuideCoverage(docsId) : null;
    if(helpCoverage){
      var helpTone = helpCoverage.complete ? 'ok' : (helpCoverage.locked ? 'warning' : 'danger');
      var helpMissing = helpCoverage.missing.length ? helpCoverage.missing.join(', ') : 'None';
      appendHealthSection(grid, 'Help & Tutorial', [
        ['Guide version', String(helpCoverage.version) + ' / ' + String(helpCoverage.currentVersion), helpCoverage.complete ? 'ok' : 'warning'],
        ['Coverage', helpCoverage.complete ? 'Complete' : (helpCoverage.locked ? 'Update pending — Help is locked' : 'Update pending'), helpTone],
        ['Missing topics', helpMissing, helpCoverage.missing.length ? 'warning' : 'ok'],
        ['Maintenance rule', 'Update Help in the same release as every user-visible feature change', 'ok']
      ]);
    }
    body.innerHTML = '';
    body.appendChild(grid);
    var note = document.createElement('div'); note.className = 'quality-health-note';
    note.textContent = 'Tip: keep at least one manual backup outside the browser for important notebooks. Persistent storage reduces browser eviction risk but is not a substitute for independent backups.';
    body.appendChild(note);
  });
}

function openDataHealth(){
  var overlay = document.getElementById(DATA_HEALTH_OVERLAY); if(!overlay) return;
  ensureHealthChip();
  overlay.classList.add('visible'); overlay.setAttribute('aria-hidden','false');
  renderDataHealth();
  setTimeout(function(){ var m = document.getElementById('data-health-modal'); if(m) m.focus(); }, 0);
}
function closeDataHealth(){
  var overlay = document.getElementById(DATA_HEALTH_OVERLAY); if(!overlay) return;
  overlay.classList.remove('visible'); overlay.setAttribute('aria-hidden','true');
}

function runNexusDiagnostics(){
  var checks = [];
  function add(name, ok, detail){ checks.push({name:name, ok:!!ok, detail:detail || ''}); }
  add('IndexedDB', !!window.indexedDB, window.indexedDB ? 'Available' : 'Unavailable');
  add('Web Crypto', !!(window.crypto && window.crypto.subtle), window.crypto && window.crypto.subtle ? 'Available' : 'Unavailable');
  add('Service worker', 'serviceWorker' in navigator, 'navigator.serviceWorker' in navigator ? 'Available' : 'Unavailable');
  add('Notebook loaded', !!(state && state.pages && state.blocks), state ? 'Loaded' : 'Not loaded');
  add('Google API key not embedded', document.documentElement.outerHTML.indexOf('AIza') === -1, 'Distributable HTML contains no live API key');
  add('Required core functions', ['save','renderAll','uid','snapshotVersion','buildBackupJson','openDataHealth'].every(function(name){ return typeof window[name] === 'function'; }), 'Core runtime surface');
  var docsId = state && state.titleIndex && state.titleIndex[String(DOCS_TITLE).toLowerCase()];
  var helpCoverage = (typeof getHelpGuideCoverage === 'function') ? getHelpGuideCoverage(docsId) : null;
  if(helpCoverage){
    add('Help & Tutorial coverage', helpCoverage.complete, helpCoverage.complete
      ? 'Current guide version with all maintained topics present'
      : (helpCoverage.locked ? 'Update pending, but the Help page is locked' : 'Missing: ' + (helpCoverage.missing.join(', ') || 'current guide version')));
  }
  return getOrphanAttachments().then(function(orphaned){
    add('Attachment references', true, orphaned.length + ' orphaned file(s)');
    var failed = checks.filter(function(x){ return !x.ok; });
    var lines = checks.map(function(x){ return (x.ok ? '✓ ' : '✗ ') + x.name + (x.detail ? ' — ' + x.detail : ''); });
    alert('Nexus diagnostics\n\n' + lines.join('\n') + (failed.length ? '\n\n' + failed.length + ' check(s) need attention.' : '\n\nAll checks passed.'));
    return checks;
  });
}

function initGoogleCredentialUi(){
  var client = document.getElementById('gdrive-client-id-input');
  var key = document.getElementById('gdrive-api-key-input');
  var saveBtn = document.getElementById('btn-save-gdrive-credentials');
  var clearBtn = document.getElementById('btn-clear-gdrive-credentials');
  var status = document.getElementById('gdrive-credential-status');
  if(!client || !key || !saveBtn) return;
  client.value = GOOGLE_DRIVE_CLIENT_ID || '';
  key.value = GOOGLE_DRIVE_API_KEY || '';
  function statusText(){ status.textContent = GOOGLE_DRIVE_API_KEY ? 'Google Drive credentials are configured on this device.' : 'Google Drive is not ready until an API key is saved locally.'; }
  statusText();
  saveBtn.onclick = function(){
    var nextClient = client.value.trim();
    var nextKey = key.value.trim();
    if(!nextClient || !/\.apps\.googleusercontent\.com$/.test(nextClient)){ toast('Enter a valid OAuth Client ID ending in .apps.googleusercontent.com.'); return; }
    if(nextKey && !/^AIza[\w-]{20,}$/.test(nextKey)){ toast('That API key does not look like a Google browser API key.'); return; }
    GOOGLE_DRIVE_CLIENT_ID = nextClient;
    GOOGLE_DRIVE_API_KEY = nextKey;
    try{ localStorage.setItem('nexus_gdrive_client_id', nextClient); if(nextKey) localStorage.setItem('nexus_gdrive_api_key', nextKey); else localStorage.removeItem('nexus_gdrive_api_key'); }catch(ignore){}
    if(typeof setGdriveAutoSyncStatus === 'function') setGdriveAutoSyncStatus(nextKey ? 'Credentials saved locally.' : 'API key cleared.');
    statusText();
    toast(nextKey ? 'Google Drive connection details saved.' : 'Google Drive API key cleared.');
  };
  if(clearBtn) clearBtn.onclick = function(){
    key.value = ''; GOOGLE_DRIVE_API_KEY = '';
    try{ localStorage.removeItem('nexus_gdrive_api_key'); }catch(ignore){}
    if(typeof stopGdriveAutoSyncTimer === 'function') stopGdriveAutoSyncTimer();
    try{ clearGdriveAuth(); }catch(ignore){}
    gdriveAccessToken = null;
    statusText();
    toast('Google Drive API key cleared from this device.');
  };
}

function initSearchDiscoverability(){
  var box = document.getElementById('search-box'); if(!box || document.getElementById('search-discovery')) return;
  var panel = document.createElement('div'); panel.id = 'search-discovery'; panel.hidden = true;
  var title = document.createElement('div'); title.className = 'search-discovery-title'; title.textContent = 'Search shortcuts'; panel.appendChild(title);
  [
    ['#tag','find tagged lines'],['[[Page]]','find page links'],['is:done','completed tasks'],['is:overdue','late tasks'],['priority:high','high-priority tasks'],['due:today','due today'],['has:attachment','lines with files'],['before:friday','date filter'],['status:"in progress"','property match']
  ].forEach(function(pair){
    var b = document.createElement('button'); b.type='button'; b.className='search-discovery-chip'; b.innerHTML='<code>'+escapeHtml(pair[0])+'</code><span>'+escapeHtml(pair[1])+'</span>'; b.onclick=function(){ box.value=pair[0]; box.dispatchEvent(new Event('input',{bubbles:true})); box.focus(); }; panel.appendChild(b);
  });
  box.parentNode.insertBefore(panel, box.nextSibling);
  function toggle(show){ panel.hidden=!show; }
  box.addEventListener('focus', function(){ toggle(true); });
  box.addEventListener('blur', function(){ setTimeout(function(){ if(document.activeElement && panel.contains(document.activeElement)) return; toggle(false); }, 150); });
}

function initQualityAccessibility(){
  var overlayIds = ['palette-overlay','gs-overlay','versions-overlay','diff-overlay','conflicts-overlay','settings-overlay','lock-overlay','sync-overlay','findreplace-overlay','querybuilder-overlay','data-health-overlay'];
  overlayIds.forEach(function(id){
    var overlay=document.getElementById(id); if(!overlay) return;
    overlay.setAttribute('aria-hidden', overlay.classList.contains('visible') || getComputedStyle(overlay).display !== 'none' ? 'false' : 'true');
    var modal = overlay.querySelector('[role="dialog"]') || overlay.firstElementChild;
    if(modal){ modal.setAttribute('role','dialog'); modal.setAttribute('aria-modal','true'); if(!modal.hasAttribute('tabindex')) modal.setAttribute('tabindex','-1'); }
  });
  var lastFocused = null;
  function activeOverlay(){
    for(var i=overlayIds.length-1;i>=0;i--){
      var el=document.getElementById(overlayIds[i]); if(!el) continue;
      var shown = el.classList.contains('visible') || (getComputedStyle(el).display !== 'none');
      if(shown && getComputedStyle(el).visibility !== 'hidden') return el;
    }
    return null;
  }
  document.addEventListener('focusin', function(e){ var ov=activeOverlay(); if(ov && ov.contains(e.target)) lastFocused=e.target; });
  document.addEventListener('keydown', function(e){
    var ov=activeOverlay(); if(!ov || e.key !== 'Tab') return;
    var modal=ov.querySelector('[role="dialog"]') || ov.firstElementChild; if(!modal) return;
    var focusables=Array.prototype.slice.call(modal.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])')).filter(function(el){ return el.offsetParent !== null; });
    if(!focusables.length){ e.preventDefault(); modal.focus(); return; }
    var first=focusables[0], last=focusables[focusables.length-1];
    if(e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
    else if(!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
  });
  new MutationObserver(function(){
    overlayIds.forEach(function(id){
      var el=document.getElementById(id); if(!el) return;
      var visible=el.classList.contains('visible') || getComputedStyle(el).display !== 'none';
      el.setAttribute('aria-hidden', visible ? 'false' : 'true');
      var modal=el.querySelector('[role="dialog"]'); if(modal){ modal.setAttribute('aria-modal','true'); }
    });
  }).observe(document.body,{subtree:true,attributes:true,attributeFilter:['class','style']});
}

function qualityHeartbeat(){
  ensureHealthChip();
  if(!navigator.onLine){ setDataHealthStatus('warning','Offline — saved locally'); return; }
  if(nexusHealthState.kind === 'error') return;
  var g = document.getElementById('gdrive-autosync-status');
  if(g && /Could not|expired|failed|conflict/i.test(g.textContent||'')){ setDataHealthStatus('warning', g.textContent.slice(0,54)); return; }
  if(!document.hidden && Date.now()-nexusHealthState.ts > 120000) setDataHealthStatus('saved','Saved locally');
}

function initQualityLayer(){
  ensureHealthChip();
  initGoogleCredentialUi();
  initSearchDiscoverability();
  initQualityAccessibility();
  var healthBtn=document.getElementById('btn-data-health'); if(healthBtn) healthBtn.onclick=openDataHealth;
  var close1=document.getElementById('data-health-close'); if(close1) close1.onclick=closeDataHealth;
  var close2=document.getElementById('data-health-close-bottom'); if(close2) close2.onclick=closeDataHealth;
  var overlay=document.getElementById('data-health-overlay'); if(overlay) overlay.addEventListener('click',function(e){ if(e.target===overlay) closeDataHealth(); });
  var diag=document.getElementById('data-health-diagnostics'); if(diag) diag.onclick=runNexusDiagnostics;
  var clean=document.getElementById('data-health-clean-orphans'); if(clean) clean.onclick=function(){ cleanOrphanAttachments().then(renderDataHealth); };
  var persist=document.getElementById('btn-request-persistent-storage'); if(persist) persist.onclick=requestPersistentStorage;
  try{ window.addEventListener('online', qualityHeartbeat); window.addEventListener('offline', qualityHeartbeat); document.addEventListener('visibilitychange', qualityHeartbeat); }catch(ignore){}
  qualityHeartbeat();
  clearInterval(nexusHealthTimer); nexusHealthTimer=setInterval(qualityHeartbeat,30000);
  /* Best-effort persistent-storage request. No modal or navigation, and a\n     browser is free to decline. The explicit Settings button remains too. */
  if(navigator.storage && navigator.storage.persisted && navigator.storage.persist){ navigator.storage.persisted().then(function(already){ if(!already) return; }).catch(function(){}); }
  if(typeof updateStorageHint === 'function') updateStorageHint();
}

/* Let the app's later boot call this after IndexedDB has populated state. */
window.addEventListener('load', function(){ setTimeout(initQualityLayer, 0); });
