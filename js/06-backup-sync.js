/* ============================================================
 * 06-backup-sync.js
 * Manual backup/restore, automatic scheduled backups, and Google Drive sync conflict resolution.
 *
 * Part of Nexus — loaded as a plain <script> (not a module) in
 * index.html, in numeric filename order. All files share one global
 * scope on purpose (same as the original single-file build), so
 * `state`, helper functions, etc. declared in an earlier file are
 * directly usable here without imports.
 * ============================================================ */
"use strict";

/* ============================================================
   BACKUP / RESTORE + VERSION SAFETY NET + REMINDER
   ============================================================ */
/* Describes the shape of the exported JSON file itself (currently: notebook
   state fields plus a top-level __attachments map of base64-inlined blobs) —
   distinct from schemaVersion, which describes the notebook data inside it.
   The two can change independently: a future backup format might, say, store
   attachments as separate zip entries instead of inline base64, which is a
   change to how the FILE is shaped, not to the notebook's own data model.
   Bump this only when the outer file shape changes; schema migrations
   (00-state-and-helpers.js) still handle the notebook contents either way. */
var NEXUS_BACKUP_FORMAT_VERSION = 1;
var META_KEY = STORAGE_KEY + '_meta';

function loadMeta(){
  try{ return JSON.parse(localStorage.getItem(META_KEY)) || {}; }catch(e){ return {}; }
}
function saveMeta(meta){
  try{ localStorage.setItem(META_KEY, JSON.stringify(meta)); }catch(e){}
}

/* Version snapshots are full copies of the entire notebook (see
   snapshotVersion below), so — unlike everything else that shares
   localStorage's ~5-10MB budget — they live in their own IndexedDB
   object store, right alongside attachments. Retention: pinned or named
   snapshots are never removed automatically; the other ones keep the newest
   MAX_UNPINNED_VERSIONS (and stop growing past MAX_VERSION_BYTES, always
   keeping the newest MIN_KEEP_VERSIONS). All access is necessarily async;
   call sites use .then() rather than reading the list synchronously. */
var VERS_STORE = "versions";
var MAX_UNPINNED_VERSIONS = 30;
var MAX_VERSION_BYTES = 150 * 1024 * 1024;
var MIN_KEEP_VERSIONS = 5;
var lastVersionTs = 0;
/* Shares one DB (and one open connection) with attachments — see
   openAttachmentDb() further down, which now creates both object
   stores. Kept as a single opener so there's no risk of two
   different version numbers racing to open the same database. */
function loadVersions(){
  return openAttachmentDb().then(function(db){
    return new Promise(function(resolve, reject){
      var tx = db.transaction(VERS_STORE, 'readonly');
      var req = tx.objectStore(VERS_STORE).getAll();
      req.onsuccess = function(){ resolve((req.result || []).sort(function(a,b){ return a.ts - b.ts; })); };
      req.onerror = function(){ reject(req.error); };
    });
  }).catch(function(){ return []; });
}
/* Cheap content fingerprint (FNV-1a + length) so an unchanged notebook does not fill the
   history with identical copies. */
function versionDigest(str){
  var h = 2166136261;
  for(var i=0;i<str.length;i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16) + ':' + str.length;
}
function versionSize(v){ return v.bytes || (v.data ? v.data.length : (v.ct ? v.ct.length : 0)); }
function versionIsProtected(v){ return !!(v.pinned || v.name || v.nameEnc); }
function versionKind(v){
  if(v.kind) return v.kind;
  var r = v.reason || '';
  return /daily/i.test(r) ? 'auto' : /backup/i.test(r) ? 'backup' : 'safety';
}
function versionRecordBase(entry){
  return {ts: entry.ts, reason: entry.reason, kind: entry.kind || 'safety', pinned: !!entry.pinned,
          pages: entry.pages, blocks: entry.blocks, bytes: entry.bytes, digest: entry.digest};
}
function writeVersionRecord(db, payload){
  return new Promise(function(resolve, reject){
    var tx = db.transaction(VERS_STORE, 'readwrite');
    tx.objectStore(VERS_STORE).put(payload);
    tx.oncomplete = function(){ resolve(); };
    tx.onerror = function(){ reject(tx.error); };
    tx.onabort = function(){ reject(tx.error || new Error('IndexedDB transaction aborted.')); };
  });
}
/* Same at-rest treatment as the notebook JSON and attachments: when a
   passcode is set, the snapshot JSON (and a name you gave it) is AES-GCM
   encrypted under the DEK before being written. Time, reason, kind and the
   page/block counts stay in the clear so the list renders without decrypting
   anything. Callers of getVersionData() never see the difference. */
function putVersion(entry){
  return openAttachmentDb().then(function(db){
    var base = versionRecordBase(entry);
    if(lockCryptoKey){
      var jobs = [encryptWithKey(lockCryptoKey, entry.data)];
      if(entry.name) jobs.push(encryptWithKey(lockCryptoKey, entry.name));
      return Promise.all(jobs).then(function(r){
        base.enc = true; base.iv = r[0].iv; base.ct = r[0].ct;
        if(r[1]) base.nameEnc = {iv: r[1].iv, ct: r[1].ct};
        return writeVersionRecord(db, base);
      });
    }
    base.data = entry.data;
    if(entry.name) base.name = entry.name;
    return writeVersionRecord(db, base);
  });
}
/* Resolves the full-notebook JSON string for a version list entry,
   decrypting first if it was stored encrypted. Rejects (same as
   getAttachment/getNotebookState) if the entry is encrypted and the
   notebook is currently locked. */
function getVersionData(entry){
  if(entry.enc){
    if(!lockCryptoKey) return Promise.reject(new Error('locked'));
    return decryptWithKey(lockCryptoKey, {iv: entry.iv, ct: entry.ct});
  }
  return Promise.resolve(entry.data);
}
function resolveVersionName(entry){
  if(entry.name) return Promise.resolve(entry.name);
  if(entry.nameEnc && lockCryptoKey) return decryptWithKey(lockCryptoKey, entry.nameEnc).catch(function(){ return ''; });
  return Promise.resolve('');
}
function deleteVersion(ts){
  return openAttachmentDb().then(function(db){
    return new Promise(function(resolve, reject){
      var tx = db.transaction(VERS_STORE, 'readwrite');
      tx.objectStore(VERS_STORE).delete(ts);
      tx.oncomplete = function(){ resolve(); };
      tx.onerror = function(){ reject(tx.error); };
    });
  });
}
function clearAllVersions(){
  return openAttachmentDb().then(function(db){
    return new Promise(function(resolve, reject){
      var tx = db.transaction(VERS_STORE, 'readwrite');
      tx.objectStore(VERS_STORE).clear();
      tx.oncomplete = function(){ resolve(); };
      tx.onerror = function(){ reject(tx.error); };
    });
  });
}
/* Read-modify-write of one record's metadata, without touching (or re-encrypting) the snapshot data. */
function patchVersionRecord(ts, fn){
  return openAttachmentDb().then(function(db){
    return new Promise(function(resolve, reject){
      var tx = db.transaction(VERS_STORE, 'readwrite'), st = tx.objectStore(VERS_STORE), g = st.get(ts);
      g.onsuccess = function(){ var rec = g.result; if(rec){ fn(rec); st.put(rec); } };
      tx.oncomplete = function(){ resolve(); };
      tx.onerror = function(){ reject(tx.error); };
      tx.onabort = function(){ reject(tx.error || new Error('IndexedDB transaction aborted.')); };
    });
  });
}
function setVersionPinned(ts, pinned){ return patchVersionRecord(ts, function(r){ r.pinned = !!pinned; }); }
function setVersionName(ts, name){
  name = (name || '').trim().slice(0, 80);
  if(!name) return patchVersionRecord(ts, function(r){ delete r.name; delete r.nameEnc; });
  if(lockCryptoKey){
    return encryptWithKey(lockCryptoKey, name).then(function(enc){
      return patchVersionRecord(ts, function(r){ delete r.name; r.nameEnc = {iv: enc.iv, ct: enc.ct}; });
    });
  }
  return patchVersionRecord(ts, function(r){ delete r.nameEnc; r.name = name; });
}
function pruneVersions(){
  return loadVersions().then(function(list){
    var kept = list.filter(function(v){ return !versionIsProtected(v); });
    var drop = [];
    while(kept.length > MAX_UNPINNED_VERSIONS) drop.push(kept.shift());
    var total = kept.reduce(function(sum, v){ return sum + versionSize(v); }, 0);
    while(kept.length > MIN_KEEP_VERSIONS && total > MAX_VERSION_BYTES){
      var v = kept.shift(); total -= versionSize(v); drop.push(v);
    }
    return Promise.all(drop.map(function(v){ return deleteVersion(v.ts); }));
  });
}
/* opts: kind ('auto' | 'safety' | 'sync' | 'manual' | 'backup'), name, pinned, force.
   The state is captured synchronously at call time, so a caller can snapshot and then go on to
   change it. An unchanged notebook is not stored twice in a row unless force is set. */
function snapshotVersion(reason, opts){
  opts = opts || {};
  if(!state || !state.pages) return Promise.resolve(null);
  var json = JSON.stringify(state);
  var ts = Date.now(); if(ts <= lastVersionTs) ts = lastVersionTs + 1; lastVersionTs = ts;
  var entry = {ts: ts, reason: reason, kind: opts.kind || 'safety', data: json, name: opts.name || '', pinned: !!opts.pinned,
               pages: Object.keys(state.pages).length, blocks: Object.keys(state.blocks || {}).length,
               bytes: json.length, digest: versionDigest(json)};
  return loadVersions().then(function(list){
    var last = list.length ? list[list.length-1] : null;
    if(!opts.force && !entry.name && last && last.digest && last.digest === entry.digest) return null;
    return putVersion(entry).then(function(){ return pruneVersions(); }).then(function(){ return entry.ts; });
  }).catch(function(){ return null; /* IndexedDB unavailable — snapshot silently skipped, same as attachments do */ });
}
/* At most one snapshot per key every `ms` — for actions that can repeat quickly (deleting several pages). */
var snapshotThrottle = {};
function snapshotVersionThrottled(key, ms, reason, opts){
  var now = Date.now();
  if(snapshotThrottle[key] && now - snapshotThrottle[key] < ms) return Promise.resolve(null);
  snapshotThrottle[key] = now;
  return snapshotVersion(reason, opts);
}
/* Passcode lifecycle. Snapshots taken before a passcode existed sat in the store as plaintext copies of
   the whole notebook, and snapshots encrypted under a passcode became unreadable the moment it was removed.
   Both directions are migrated with the key still in hand (see setPasscode / removePasscode). */
function encryptExistingVersions(){
  return loadVersions().then(function(list){
    var plain = list.filter(function(v){ return !v.enc && typeof v.data === 'string'; });
    var failed = 0;
    return plain.reduce(function(chain, v){
      return chain.then(function(){
        return putVersion({ts: v.ts, reason: v.reason, kind: v.kind, pinned: v.pinned, pages: v.pages, blocks: v.blocks,
                           bytes: v.bytes, digest: v.digest, data: v.data, name: v.name});
      }).catch(function(){ failed++; });
    }, Promise.resolve()).then(function(){ return failed; });
  });
}
function decryptExistingVersions(){
  return loadVersions().then(function(list){
    var encs = list.filter(function(v){ return v.enc; });
    var result = {migrated: 0, unreadable: []};
    return encs.reduce(function(chain, v){
      return chain.then(function(){
        return Promise.all([getVersionData(v), resolveVersionName(v)]).then(function(r){
          var rec = versionRecordBase(v); rec.data = r[0]; if(r[1]) rec.name = r[1];
          return idbPutRaw(VERS_STORE, rec);
        }).then(function(){ result.migrated++; }, function(){ result.unreadable.push(v.ts); });
      });
    }, Promise.resolve()).then(function(){
      return loadVersions().then(function(after){
        var still = after.filter(function(v){ return v.enc && result.unreadable.indexOf(v.ts) === -1; });
        if(still.length) throw new Error('Could not verify the decrypted snapshots, so the passcode was kept.');
        return result;
      });
    });
  });
}

/* Bundles state plus every attachment's actual bytes (base64) into one
   exportable object, so a .json backup is fully self-contained — restoring
   it on any device (or the same one after clearing storage) brings images
   and files back too, not just their {{img:…}}/{{file:…}} references. */
function buildBackupJson(){
  return listAllAttachments().then(function(records){
    return Promise.all(records.map(function(meta){
      return getAttachment(meta.id).then(function(rec){
        if(!rec) return null;
        return blobToBase64(rec.blob).then(function(b64){
          return {id: rec.id, name: rec.name, type: rec.type, size: rec.size, dataB64: b64};
        });
      });
    }));
  }).then(function(attList){
    attList = attList.filter(Boolean);
    var exportObj = JSON.parse(JSON.stringify(state));
    var attMap = {};
    attList.forEach(function(a){ attMap[a.id] = {name:a.name, type:a.type, size:a.size, dataB64:a.dataB64}; });
    exportObj.__attachments = attMap;
    exportObj.backupFormatVersion = NEXUS_BACKUP_FORMAT_VERSION;
    return JSON.stringify(exportObj, null, 2);
  });
}

function backup(){
  var d = new Date();
  var fname = 'nexus-backup-' + d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0') + '.json';

  /* Where supported (Chrome/Edge/Opera, desktop, https or localhost), let
     the person pick the folder and filename via a native Save As dialog.
     Must be called synchronously from the click handler — it is, since
     backup() itself is only ever invoked directly from a button's onclick;
     gathering attachments happens inside the promise chain that follows,
     which doesn't affect that synchronous user-gesture requirement. */
  if(window.showSaveFilePicker){
    window.showSaveFilePicker({
      suggestedName: fname,
      types: [{ description: 'Nexus backup', accept: {'application/json': ['.json']} }]
    }).then(function(handle){
      return buildBackupJson().then(maybeEncryptExport).then(function(json){
        return handle.createWritable().then(function(writable){
          return writable.write(json).then(function(){ return writable.close(); });
        });
      });
    }).then(function(){
      finishBackup(fname);
    }).catch(function(err){
      if(err && err.name === 'AbortError') return; /* person cancelled the dialog — do nothing */
      if(err && err.message === 'export-cancelled') return; /* declined/failed the passcode prompt — already toasted */
      buildBackupJson().then(maybeEncryptExport).then(function(json){ downloadBackupFallback(json, fname); });
    });
  } else {
    buildBackupJson().then(maybeEncryptExport).then(function(json){ downloadBackupFallback(json, fname); }).catch(function(){});
  }
}

/* Wraps a plain backup JSON string in the portable-encryption envelope
   if (and only if) a passcode lock is set up and the person confirms —
   they can always decline and keep the export as plain, readable JSON.
   Rejects with message 'export-cancelled' if they cancel or mistype
   their passcode, so callers can quietly stop rather than exporting
   anything. Unattended/automatic backups never call this — there's no
   one there to type a passcode — see AUTOMATIC BACKUPS below. */
function maybeEncryptExport(jsonString){
  if(!isLockEnabled()) return Promise.resolve(jsonString);
  if(!confirm('Encrypt this backup with your passcode?\n\nOK = encrypted (needs your passcode to ever open it again, even on another device).\nCancel = plain, readable JSON, same as today.')){
    return Promise.resolve(jsonString);
  }
  var passcode = promptForPasscode('Enter your passcode to encrypt this backup:');
  if(passcode === null) return Promise.reject(new Error('export-cancelled'));
  return confirmPasscode(passcode).then(function(ok){
    if(!ok){ toast('Incorrect passcode — backup not created.'); throw new Error('export-cancelled'); }
    return encryptForPortableStorage(jsonString, passcode);
  });
}

/* Classic anchor-download, used on browsers without the File System Access
   API (Firefox, Safari, mobile). Lands in the browser's configured downloads
   location — some browsers offer a "always ask where to save" setting that
   effectively gives a location picker too. */
function downloadBackupFallback(json, fname){
  var blob = new Blob([json], {type:'application/json'});
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = fname;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  finishBackup(fname);
}

function finishBackup(fname){
  toast('Backup saved: ' + fname);
  snapshotVersion('manual backup', {kind:'backup'});
  var meta = loadMeta();
  meta.lastBackupAt = Date.now();
  meta.snoozeUntil = 0;
  saveMeta(meta);
  updateBackupBanner();
}

/* ============================================================
   AUTOMATIC BACKUPS
   Writes a timestamped .json backup (same format as a manual
   "Backup (export)") on a schedule, with no further clicks needed
   once set up. Two paths depending on what the browser supports:
     - Chrome/Edge/Opera (desktop): File System Access API
       (window.showDirectoryPicker) holds a reusable handle to a
       folder the person picks once, stored in IndexedDB, and writes
       land straight there with no repeated prompts.
     - Everywhere else (Safari, Firefox, all mobile browsers): no API
       exists for writing to an arbitrary folder without a click, so
       Nexus instead triggers a normal file download of the backup —
       same schedule, same filename pattern, lands in the browser's
       default Downloads location. The browser may ask to allow
       downloads the first time; after that it's silent.
   Either way this only fires while Nexus is actually open (there's
   no way for a plain web page to wake up in the background) — the
   startup check plus the 30-minute interval below catch up on
   anything overdue whenever the app is next opened.
   ============================================================ */
var AUTOBACKUP_HANDLE_KEY = 'autoBackupDirHandle';
function idbSetGeneric(key, value){
  return openAttachmentDb().then(function(db){
    return new Promise(function(resolve, reject){
      var tx = db.transaction(NB_STORE, 'readwrite');
      tx.objectStore(NB_STORE).put(value, key);
      tx.oncomplete = function(){ resolve(); };
      tx.onerror = function(){ reject(tx.error); };
    });
  });
}
function idbGetGeneric(key){
  return openAttachmentDb().then(function(db){
    return new Promise(function(resolve, reject){
      var tx = db.transaction(NB_STORE, 'readonly');
      var req = tx.objectStore(NB_STORE).get(key);
      req.onsuccess = function(){ resolve(req.result || null); };
      req.onerror = function(){ reject(req.error); };
    });
  });
}
function idbDeleteGeneric(key){
  return openAttachmentDb().then(function(db){
    return new Promise(function(resolve, reject){
      var tx = db.transaction(NB_STORE, 'readwrite');
      tx.objectStore(NB_STORE).delete(key);
      tx.oncomplete = function(){ resolve(); };
      tx.onerror = function(){ reject(tx.error); };
    });
  });
}
function autoBackupIntervalMs(){
  var v = currentSettings.autoBackupInterval;
  if(v === 'off' || !v) return 0;
  if(v === 'daily') return 24*60*60*1000;
  var days = parseInt(v, 10);
  return days ? days*24*60*60*1000 : 0;
}
function chooseAutoBackupFolder(){
  if(!window.showDirectoryPicker){
    toast('This browser can\'t grant folder access — try Chrome, Edge, or Opera.');
    return;
  }
  window.showDirectoryPicker({mode:'readwrite'}).then(function(handle){
    return idbSetGeneric(AUTOBACKUP_HANDLE_KEY, handle).then(function(){
      toast('Backup folder set to "' + handle.name + '".');
      updateAutoBackupStatusUI();
      maybeRunAutoBackup(true);
    });
  }).catch(function(err){
    if(err && err.name === 'AbortError') return;
    toast('Could not access that folder.');
  });
}
function forgetAutoBackupFolder(){
  idbDeleteGeneric(AUTOBACKUP_HANDLE_KEY).then(function(){
    toast('Backup folder forgotten.');
    updateAutoBackupStatusUI();
  });
}
function ensureAutoBackupPermission(handle){
  var opts = {mode:'readwrite'};
  return handle.queryPermission(opts).then(function(state){
    if(state === 'granted') return true;
    // A silent re-grant only works if the browser still associates this
    // call with a recent user gesture (e.g. right after "Choose folder…"
    // or "Back up now"); otherwise it resolves 'prompt' again and the
    // status hint below tells the person to reconnect the folder by hand.
    return handle.requestPermission(opts).then(function(s2){ return s2 === 'granted'; }).catch(function(){ return false; });
  });
}
function writeAutoBackupFile(handle){
  var d = new Date();
  var stamp = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0') +
    '_'+String(d.getHours()).padStart(2,'0')+String(d.getMinutes()).padStart(2,'0');
  var fname = 'nexus-autobackup-' + stamp + '.json';
  return buildBackupJson().then(function(json){
    return handle.getFileHandle(fname, {create:true}).then(function(fileHandle){
      return fileHandle.createWritable();
    }).then(function(writable){
      return writable.write(json).then(function(){ return writable.close(); });
    });
  }).then(function(){
    var meta = loadMeta();
    meta.lastAutoBackupAt = Date.now();
    saveMeta(meta);
    updateAutoBackupStatusUI();
  });
}
/* Fallback for browsers without the File System Access API (Safari,
   Firefox, all mobile browsers): same backup content and filename
   pattern as writeAutoBackupFile above, but delivered as a normal
   triggered download instead of a direct folder write, since there's
   no arbitrary-folder-write capability to use instead. */
function downloadAutoBackupFile(){
  var d = new Date();
  var stamp = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0') +
    '_'+String(d.getHours()).padStart(2,'0')+String(d.getMinutes()).padStart(2,'0');
  var fname = 'nexus-autobackup-' + stamp + '.json';
  return buildBackupJson().then(function(json){
    var blob = new Blob([json], {type:'application/json'});
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = fname;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    var meta = loadMeta();
    meta.lastAutoBackupAt = Date.now();
    saveMeta(meta);
    updateAutoBackupStatusUI();
  });
}
/* Called at startup and periodically while the app stays open (there's no
   reliable way for a plain web page to wake up in the background, so this
   is "automatic while Nexus is open" rather than a true background job —
   opening the app catches up on anything overdue). force=true skips the
   due-date check (used right after picking a folder, so the person gets
   immediate confirmation it works). */
function maybeRunAutoBackup(force){
  var intervalMs = autoBackupIntervalMs();
  if(!intervalMs) return;
  var meta = loadMeta();
  var due = force || !meta.lastAutoBackupAt || (Date.now() - meta.lastAutoBackupAt) >= intervalMs;
  if(!due) return;

  if(!window.showDirectoryPicker){
    /* No folder-write API available on this browser — fall back to a
       triggered download on the same schedule. */
    downloadAutoBackupFile().then(function(){
      toast('Automatic backup downloaded — check your Downloads folder.');
    }).catch(function(){
      toast('Automatic backup failed.');
    });
    return;
  }
  idbGetGeneric(AUTOBACKUP_HANDLE_KEY).then(function(handle){
    if(!handle) return;
    ensureAutoBackupPermission(handle).then(function(ok){
      if(!ok){ updateAutoBackupStatusUI(true); return; }
      writeAutoBackupFile(handle).then(function(){
        toast('Automatic backup saved to "' + handle.name + '".');
      }).catch(function(){
        toast('Automatic backup failed — the folder may have moved.');
      });
    });
  }).catch(function(){});
}
function updateAutoBackupStatusUI(needsPermission){
  var statusEl = document.getElementById('autobackup-status');
  var forgetBtn = document.getElementById('btn-forget-autobackup-folder');
  var chooseBtn = document.getElementById('btn-choose-autobackup-folder');
  if(!statusEl) return;
  if(!window.showDirectoryPicker){
    if(chooseBtn) chooseBtn.style.display = 'none';
    if(forgetBtn) forgetBtn.style.display = 'none';
    var meta = loadMeta();
    var last = meta.lastAutoBackupAt ? new Date(meta.lastAutoBackupAt).toLocaleString() : 'never yet';
    statusEl.textContent = currentSettings.autoBackupInterval === 'off'
      ? 'Pick a schedule above to have Nexus download a backup file automatically — this browser can\'t write straight to a folder, so downloads take its place.'
      : 'This browser can\'t write straight to a folder, so Nexus will download a timestamped backup file to your Downloads instead, on schedule. Last automatic backup: ' + last + '.';
    return;
  }
  if(chooseBtn) chooseBtn.style.display = '';
  idbGetGeneric(AUTOBACKUP_HANDLE_KEY).then(function(handle){
    if(forgetBtn) forgetBtn.style.display = handle ? '' : 'none';
    if(!handle){
      statusEl.textContent = currentSettings.autoBackupInterval === 'off'
        ? 'Pick a folder and a schedule above to have Nexus back itself up without reminders.'
        : 'Choose a folder above to finish setting up automatic backups.';
      return;
    }
    var meta = loadMeta();
    var last = meta.lastAutoBackupAt ? new Date(meta.lastAutoBackupAt).toLocaleString() : 'never yet';
    statusEl.textContent = (needsPermission
      ? 'Access to "' + handle.name + '" needs to be reconfirmed — click "Choose backup folder…" again. '
      : 'Backing up automatically to "' + handle.name + '". ') + 'Last automatic backup: ' + last + '.';
  });
}
document.getElementById('btn-choose-autobackup-folder').onclick = chooseAutoBackupFolder;
document.getElementById('btn-forget-autobackup-folder').onclick = forgetAutoBackupFolder;

function restoreFromJsonText(jsonText){
  var parsedOuter;
  try{ parsedOuter = JSON.parse(jsonText); }catch(e){ toast('Could not read that file.'); return; }
  if(parsedOuter && parsedOuter.nexusEncryptedBackup){
    var passcode = promptForPasscode('This backup is encrypted. Enter the passcode it was encrypted with:');
    if(passcode === null) return;
    decryptPortableStorage(parsedOuter, passcode).then(function(plain){
      restoreFromDecryptedJsonText(plain);
    }).catch(function(){
      toast('Could not decrypt that backup — wrong passcode, or the file is corrupted.');
    });
    return;
  }
  restoreFromDecryptedJsonText(jsonText);
}

function restoreFromDecryptedJsonText(jsonText){
  try{
    var parsed = JSON.parse(jsonText);
    if(!parsed.pages || !parsed.blocks){ toast('That file does not look like a Nexus backup.'); return; }
    /* Missing means this backup predates the field — every backup format so
       far (inline base64 attachments in __attachments) is the same shape, so
       there is nothing to convert; the check only matters once a FUTURE
       version bumps this past what this copy of Nexus understands, at which
       point restoring is safe to attempt (nothing here mutates the file) but
       not guaranteed complete, so the user is told plainly and decides. */
    var backupVersion = typeof parsed.backupFormatVersion === 'number' ? parsed.backupFormatVersion : 0;
    delete parsed.backupFormatVersion;
    if(backupVersion > NEXUS_BACKUP_FORMAT_VERSION){
      if(!confirm('This backup was made by a newer version of Nexus (backup format ' + backupVersion +
                  ', this copy understands up to ' + NEXUS_BACKUP_FORMAT_VERSION + '). ' +
                  'It may not restore completely. Continue anyway?')) return;
    }
    if(!confirm('Restoring will replace everything currently in Nexus with this backup. Continue?')) return;
    snapshotVersion('before restore'); // safety net in case the wrong file was picked
    var attachments = parsed.__attachments || {};
    delete parsed.__attachments;
    state = normalizeState(parsed);
    save();
    renderAll();
    var attIds = Object.keys(attachments);
    if(!attIds.length){
      toast('Backup restored. Previous data was snapshotted in Version history.');
      renderAttachmentsSection();
      return;
    }
    Promise.all(attIds.map(function(id){
      var a = attachments[id];
      return putAttachment({id:id, name:a.name, type:a.type, size:a.size, addedAt:Date.now(), blob: base64ToBlob(a.dataB64, a.type)});
    })).then(function(){
      attObjectUrlCache = {}; /* old cached URLs/misses no longer apply now that blobs changed */
      renderAll();
      updateStorageHint();
      renderAttachmentsSection();
      toast('Backup restored, including ' + attIds.length + ' attachment' + (attIds.length===1?'':'s') + '.');
    }).catch(function(){
      toast('Backup restored, but some attachments could not be brought back.');
    });
  }catch(e){ toast('Could not read that file.'); }
}

function restoreFromFile(file){
  var reader = new FileReader();
  reader.onload = function(){ restoreFromJsonText(reader.result); };
  reader.readAsText(file);
}

/* ---------- Google Drive import/export ----------
   Uses Google Identity Services for an access token (no server needed)
   and the Picker API so the user chooses the exact backup file on import —
   Nexus never lists or scans their whole Drive. Requires
   GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_API_KEY (set near the top of
   <head>) to be filled in with real credentials from Google Cloud Console.

   Both import and export need real http(s) hosting: Google's OAuth will
   not authorize a page opened directly as a file:// URL, so both entry
   points check for that first and explain rather than silently failing. */
var gdriveTokenClient = null;
var gdriveAccessToken = null;
var gdrivePickerLoaded = false;
var GDRIVE_SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';

/* ---------- How long a Drive connection stays good for ----------
   Google's own access tokens last about an hour regardless of what's
   set here; what this controls is how long Nexus keeps *silently*
   renewing them off the back of the person's Google session before it
   stops and asks for a deliberate click again. So it can only ever
   shorten the effective session, never extend it past what Google
   allows — picking 24h doesn't keep a token alive for a day, it means
   background renewals are allowed to continue for a day since the last
   time the person actually chose to connect.

   The timestamp is the moment of the last *interactive* connection
   (a real click through gdriveWithToken), and it's kept in
   localStorage rather than memory so closing and reopening the tab
   doesn't quietly reset the clock. Silent renewals deliberately do
   not touch it — otherwise a device left open would never re-ask. */
var GDRIVE_AUTH_AT_KEY = STORAGE_KEY + '_gdrive_auth_at';
var GDRIVE_AUTH_TTL_DEFAULT = '24';
var GDRIVE_AUTH_TTL_CHOICES = ['1', '6', '12', '24'];

function gdriveAuthTtlHours(){
  var v = (typeof currentSettings !== 'undefined' && currentSettings.gdriveAuthTtlHours) || GDRIVE_AUTH_TTL_DEFAULT;
  return GDRIVE_AUTH_TTL_CHOICES.indexOf(String(v)) === -1 ? GDRIVE_AUTH_TTL_DEFAULT : String(v);
}
function gdriveAuthTtlMs(){
  return parseInt(gdriveAuthTtlHours(), 10) * 60 * 60 * 1000;
}

/* ---- Google Drive sync encryption key session -------------------------
   gdriveSyncPasscode and gdriveSyncEncryptionDeclined are plain in-memory
   variables — both reset to their defaults on every page reload, causing
   the confirm()/prompt() dialogs to re-appear on launch.

   This block persists both across reloads:
   - The passcode is written to sessionStorage (tab-scoped, never on disk)
     with a configurable deadline (1/6/12/24 h), AND to the same durable
     'security' IndexedDB store the local passcode lock uses for its own
     "request on launch" setting (see persistPersistentPasscodeKey /
     restorePersistentPasscodeKey in 09-security-lock.js). sessionStorage
     alone only survives a same-tab reload — it's wiped the moment the
     tab or app actually closes — so without the IndexedDB copy, a real
     relaunch always looked like a brand-new session and re-prompted for
     the key regardless of which "remember for…" interval was chosen.
     Restored silently on load: sessionStorage first (cheap, synchronous),
     falling back to the IndexedDB copy so the chosen interval actually
     spans real launches, not just reloads within one open tab.
   - The "I chose plain sync" decision is written to localStorage as a
     standing preference and restored on every load.

   All three are cleared whenever the local passcode lock is removed.    */
var GDRIVE_SYNC_KEY_SESSION_KEY = STORAGE_KEY + '_gdrive_synckey_session_v1';
var GDRIVE_SYNC_DECLINED_KEY    = STORAGE_KEY + '_gdrive_sync_declined_v1';
var GDRIVE_SYNC_KEY_SESSION_DEFAULT = '24';
var GDRIVE_SYNC_KEY_SESSION_CHOICES = ['1', '6', '12', '24'];
var GDRIVE_SYNC_KEY_PERSISTENT_STORE = 'security';
var GDRIVE_SYNC_KEY_PERSISTENT_KEY = 'gdrive_synckey_persistent_v1';
var gdriveSyncKeyUnlockedAt = 0;

function gdriveSyncKeySessionHours(){
  var v = (typeof currentSettings !== 'undefined' && currentSettings.gdriveSyncKeySessionHours) || GDRIVE_SYNC_KEY_SESSION_DEFAULT;
  return GDRIVE_SYNC_KEY_SESSION_CHOICES.indexOf(String(v)) === -1 ? GDRIVE_SYNC_KEY_SESSION_DEFAULT : String(v);
}
function gdriveSyncKeySessionMs(){
  return parseInt(gdriveSyncKeySessionHours(), 10) * 60 * 60 * 1000;
}
/* Durable counterpart to the sessionStorage copy below. Stores the raw
   passcode (not a derived key) since it must be reusable to derive the
   Drive sync file's own PBKDF2 key against whatever salt that file
   carries. Written to the shared 'security' IndexedDB store already
   created for the local lock's device-local key (08-edit-dock-attachments.js),
   gated by the same deadline as the sessionStorage copy. */
function persistGdriveSyncKeyPersistent(){
  if(!gdriveSyncPasscode || typeof openAttachmentDb !== 'function') return Promise.resolve(false);
  var now = gdriveSyncKeyUnlockedAt || Date.now();
  var deadline = now + gdriveSyncKeySessionMs();
  return openAttachmentDb().then(function(db){
    return new Promise(function(resolve){
      try{
        var tx = db.transaction(GDRIVE_SYNC_KEY_PERSISTENT_STORE, 'readwrite');
        tx.objectStore(GDRIVE_SYNC_KEY_PERSISTENT_STORE).put({v:1, passcode: gdriveSyncPasscode, unlockedAt: now, deadlineAt: deadline}, GDRIVE_SYNC_KEY_PERSISTENT_KEY);
        tx.oncomplete = function(){ resolve(true); };
        tx.onerror = tx.onabort = function(){ resolve(false); };
      }catch(e){ resolve(false); }
    });
  }).catch(function(){ return false; });
}
function clearGdriveSyncKeyPersistent(){
  if(typeof openAttachmentDb !== 'function') return Promise.resolve(false);
  return openAttachmentDb().then(function(db){
    return new Promise(function(resolve){
      try{
        var tx = db.transaction(GDRIVE_SYNC_KEY_PERSISTENT_STORE, 'readwrite');
        tx.objectStore(GDRIVE_SYNC_KEY_PERSISTENT_STORE).delete(GDRIVE_SYNC_KEY_PERSISTENT_KEY);
        tx.oncomplete = function(){ resolve(true); };
        tx.onerror = tx.onabort = function(){ resolve(false); };
      }catch(e){ resolve(false); }
    });
  }).catch(function(){ return false; });
}
/* Only consulted once the sessionStorage copy has already come up empty
   (see restoreGdriveSyncKeySession) — i.e. exactly the real-relaunch
   case sessionStorage can't cover. No-ops if a passcode is already in
   memory so it's safe to call speculatively. */
function restoreGdriveSyncKeyPersistent(){
  if(gdriveSyncPasscode) return Promise.resolve(true);
  if(typeof openAttachmentDb !== 'function') return Promise.resolve(false);
  return openAttachmentDb().then(function(db){
    return new Promise(function(resolve){
      try{
        var tx = db.transaction(GDRIVE_SYNC_KEY_PERSISTENT_STORE, 'readonly');
        var req = tx.objectStore(GDRIVE_SYNC_KEY_PERSISTENT_STORE).get(GDRIVE_SYNC_KEY_PERSISTENT_KEY);
        req.onsuccess = function(){ resolve(req.result || null); };
        req.onerror = function(){ resolve(null); };
      }catch(e){ resolve(null); }
    });
  }).then(function(raw){
    if(!raw || raw.v !== 1 || typeof raw.passcode !== 'string' || !raw.deadlineAt || Date.now() >= Number(raw.deadlineAt)){
      return clearGdriveSyncKeyPersistent().then(function(){ return false; });
    }
    gdriveSyncPasscode = raw.passcode;
    gdriveSyncKeyUnlockedAt = Number(raw.unlockedAt) || Date.now();
    persistGdriveSyncKeySession(); /* refresh the fast sessionStorage copy for this tab too */
    return true;
  }).catch(function(){ return false; });
}
function persistGdriveSyncKeySession(){
  if(!gdriveSyncPasscode) return;
  try{
    var now = gdriveSyncKeyUnlockedAt || Date.now();
    sessionStorage.setItem(GDRIVE_SYNC_KEY_SESSION_KEY, JSON.stringify({
      passcode: gdriveSyncPasscode,
      unlockedAt: now,
      deadlineAt: now + gdriveSyncKeySessionMs()
    }));
  }catch(e){}
  persistGdriveSyncKeyPersistent();
}
function clearGdriveSyncKeySession(){
  try{ sessionStorage.removeItem(GDRIVE_SYNC_KEY_SESSION_KEY); }catch(e){}
  try{ localStorage.removeItem(GDRIVE_SYNC_DECLINED_KEY); }catch(e){}
  clearGdriveSyncKeyPersistent();
}
function persistGdriveSyncDeclined(){
  try{ localStorage.setItem(GDRIVE_SYNC_DECLINED_KEY, '1'); }catch(e){}
}
function clearGdriveSyncDeclined(){
  try{ localStorage.removeItem(GDRIVE_SYNC_DECLINED_KEY); }catch(e){}
}
/* Restores both flags from storage on page load. Must be called from
   DOMContentLoaded (after currentSettings is available) and before any
   sync cycle fires its first ensureGdriveSyncMode() check. Returns a
   Promise now (it used to be synchronous) so callers that need the key
   in place before proceeding — bootNotebook's silent auto-sync check —
   can wait on the IndexedDB fallback instead of racing it.            */
function restoreGdriveSyncKeySession(){
  try{
    if(localStorage.getItem(GDRIVE_SYNC_DECLINED_KEY) === '1'){
      gdriveSyncEncryptionDeclined = true;
    }
  }catch(e){}
  if(gdriveSyncPasscode) return Promise.resolve(true);
  var raw;
  try{ raw = JSON.parse(sessionStorage.getItem(GDRIVE_SYNC_KEY_SESSION_KEY) || 'null'); }catch(e){ raw = null; }
  if(raw && typeof raw.passcode === 'string' && raw.deadlineAt){
    var deadline = Math.min(Number(raw.deadlineAt), Number(raw.unlockedAt||0) + gdriveSyncKeySessionMs());
    if(Date.now() < deadline){
      gdriveSyncPasscode = raw.passcode;
      gdriveSyncKeyUnlockedAt = Number(raw.unlockedAt) || Date.now();
      return Promise.resolve(true);
    }
    clearGdriveSyncKeySession();
  }
  /* The same-tab sessionStorage copy is gone — normal on every real
     relaunch, not just an expired window. Fall back to the durable
     IndexedDB copy so the configured hours actually span launches. */
  return restoreGdriveSyncKeyPersistent();
}
/* ---- Settings UI ---- */
function setGdriveSyncKeySessionUI(){
  var row = document.getElementById('settings-gdrivesynckeysession-row');
  if(!row) return;
  var cur = gdriveSyncKeySessionHours();
  Array.prototype.slice.call(row.querySelectorAll('.settings-opt')).forEach(function(btn){
    btn.classList.toggle('active', btn.dataset.gdrivesynckeysession === cur);
  });
}
function updateGdriveSyncKeySessionStatus(){
  var el = document.getElementById('gdrive-synckeysession-status');
  if(!el) return;
  if(!gdriveSyncPasscode){
    el.textContent = 'Sync encryption key not yet entered this session — you will be prompted on the next Sync.';
    return;
  }
  var deadline;
  try{
    var raw = JSON.parse(sessionStorage.getItem(GDRIVE_SYNC_KEY_SESSION_KEY)||'null');
    deadline = raw && raw.deadlineAt ? Math.min(Number(raw.deadlineAt), gdriveSyncKeyUnlockedAt + gdriveSyncKeySessionMs()) : (gdriveSyncKeyUnlockedAt + gdriveSyncKeySessionMs());
  }catch(e){ deadline = gdriveSyncKeyUnlockedAt + gdriveSyncKeySessionMs(); }
  var remaining = deadline - Date.now();
  if(remaining <= 0){ el.textContent = 'Session expired — re-entry needed on next launch.'; return; }
  var mins = Math.round(remaining / 60000);
  var left = mins >= 60 ? (Math.floor(mins/60) + 'h ' + (mins%60) + 'm') : (mins + 'm');
  el.textContent = 'Sync encryption key remembered — re-entry in about ' + left + '.';
}
function setGdriveSyncKeySession(hours){
  hours = String(hours);
  if(GDRIVE_SYNC_KEY_SESSION_CHOICES.indexOf(hours) === -1) return;
  currentSettings.gdriveSyncKeySessionHours = hours;
  saveSettings(currentSettings);
  setGdriveSyncKeySessionUI();
  if(gdriveSyncPasscode) persistGdriveSyncKeySession();
  updateGdriveSyncKeySessionStatus();
  toast('Sync key remembered for ' + hours + ' hour' + (hours==='1'?'':'s') + ' after each unlock.');
}
(function wireGdriveSyncKeySessionRow(){
  function wire(){
    var row = document.getElementById('settings-gdrivesynckeysession-row');
    if(!row) return;
    Array.prototype.slice.call(row.querySelectorAll('.settings-opt')).forEach(function(btn){
      btn.onclick = function(){ setGdriveSyncKeySession(btn.dataset.gdrivesynckeysession); };
    });
    setGdriveSyncKeySessionUI();
    updateGdriveSyncKeySessionStatus();
    /* restoreGdriveSyncKeySession() (defined just above) is what actually
       repopulates gdriveSyncPasscode from sessionStorage/IndexedDB — the
       synchronous status update above always shows "not yet entered"
       first since that restore hasn't resolved yet. Refresh once it has. */
    restoreGdriveSyncKeySession().then(updateGdriveSyncKeySessionStatus);
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
/* ---- End sync key session -------------------------------------------- */
function gdriveAuthAt(){
  var raw = localStorage.getItem(GDRIVE_AUTH_AT_KEY);
  var ts = raw ? parseInt(raw, 10) : 0;
  return isNaN(ts) ? 0 : ts;
}
function markGdriveAuthNow(){
  try{ localStorage.setItem(GDRIVE_AUTH_AT_KEY, String(Date.now())); }catch(e){}
  updateGdriveAuthTtlStatus();
}
/* Drops the in-memory token and the connection timestamp, so the next
   attempt has to go through an interactive sign-in. Used both when the
   window lapses and when the person shortens it to something already
   exceeded. */
function clearGdriveAuth(){
  gdriveAccessToken = null;
  try{ localStorage.removeItem(GDRIVE_AUTH_AT_KEY); }catch(e){}
}
function gdriveAuthExpired(){
  var at = gdriveAuthAt();
  if(!at) return true;
  return (Date.now() - at) >= gdriveAuthTtlMs();
}
/* Single gate the background paths ask before doing anything with a
   token: expires the connection in place (so the status line and the
   next silent attempt agree with each other) and reports whether the
   caller may proceed. */
function gdriveAuthStillValid(){
  if(gdriveAuthExpired()){
    if(gdriveAccessToken) clearGdriveAuth();
    return false;
  }
  return true;
}

/* ---------- Remembering which Google account to use ----------
   Without a login_hint, Google can't tell which of the person's signed-in
   accounts a request is for, so it shows the "choose an account" picker
   on *every* request — silent ones included — even with only one account
   signed in, and even inside the reconnect window above. The window only
   controls whether Nexus is allowed to try at all; it has no say over
   whether Google's own picker appears once it does.

   The fix is to learn the email once (via the small extra
   userinfo.email scope on GDRIVE_SCOPES) and hand it back as login_hint
   on every future request. Stored in localStorage, not memory, so it
   survives reloads — it's implied by having already granted that scope,
   not new information being kept around. */
var GDRIVE_EMAIL_KEY = STORAGE_KEY + '_gdrive_email';
function gdriveStoredEmail(){
  try{ return localStorage.getItem(GDRIVE_EMAIL_KEY) || ''; }catch(e){ return ''; }
}
function gdriveRememberEmailFromToken(token){
  if(gdriveStoredEmail()) return; /* already known — no need to ask again every time */
  fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { 'Authorization': 'Bearer ' + token }
  }).then(function(res){ return res.ok ? res.json() : null; })
    .then(function(info){
      if(info && info.email){ try{ localStorage.setItem(GDRIVE_EMAIL_KEY, info.email); }catch(e){} }
    }).catch(function(){ /* non-critical — the hint just stays off next time too */ });
}
/* Builds the {prompt, login_hint?} object passed to requestAccessToken.
   login_hint is applied as a per-call override rather than baked into
   initTokenClient once, so it takes effect the very first moment the
   email becomes known without needing to recreate the token client
   mid-session. */
function gdriveTokenRequestOpts(promptValue){
  var opts = { prompt: promptValue };
  var email = gdriveStoredEmail();
  if(email) opts.login_hint = email;
  return opts;
}

function gdriveCredentialsConfigured(){
  return GOOGLE_DRIVE_CLIENT_ID && GOOGLE_DRIVE_CLIENT_ID.indexOf('YOUR_OAUTH_CLIENT_ID') === -1
      && GOOGLE_DRIVE_API_KEY && GOOGLE_DRIVE_API_KEY.indexOf('YOUR_API_KEY') === -1;
}

/* Returns true (and shows an explanation) if this page can't do Google
   OAuth from where it's currently running — i.e. opened as a local file. */
function gdriveBlockedByOrigin(silent){
  if(location.protocol === 'file:'){
    if(silent) return true; /* background sync must never pop an alert */
    alert('Google Drive import/export needs Nexus to be opened over http(s), not as a local file.\n\n' +
          'Google\'s sign-in won\'t authorize a page opened directly from disk (a file:// address). ' +
          'Host this file somewhere simple — GitHub Pages, Netlify, Vercel, or even "python3 -m http.server" ' +
          'on your own machine for local testing — then open it from that http(s) address instead.\n\n' +
          'Your backup/restore still work as before, just via the regular file-picker buttons.');
    return true;
  }
  return false;
}

/* Google's client scripts are loaded on demand, never at startup: a private, offline-first
   notebook should not contact Google (or fail offline) just because it was opened. Nothing is
   requested until the person actually starts a Drive import/export or a Drive sync that they
   previously connected. */
var googleScriptPromises = {};
function loadExternalScriptOnce(src){
  if(googleScriptPromises[src]) return googleScriptPromises[src];
  googleScriptPromises[src] = new Promise(function(resolve, reject){
    var s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = function(){ resolve(); };
    s.onerror = function(){ delete googleScriptPromises[src]; s.parentNode && s.parentNode.removeChild(s); reject(new Error('Could not load ' + src)); };
    document.head.appendChild(s);
  });
  return googleScriptPromises[src];
}
function ensureGoogleIdentity(){
  if(window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
  return loadExternalScriptOnce('https://accounts.google.com/gsi/client');
}
function ensureGoogleApi(){
  if(window.gapi) return Promise.resolve();
  return loadExternalScriptOnce('https://apis.google.com/js/api.js');
}
function gdriveEnsurePicker(cb){
  if(gdrivePickerLoaded){ cb(); return; }
  ensureGoogleApi().then(function(){
    gapi.load('picker', function(){ gdrivePickerLoaded = true; cb(); });
  }, function(){
    toast('Could not reach Google — check your connection and try again.');
  });
}

function gdriveOpenPicker(){
  gdriveEnsurePicker(function(){
    var view = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setMimeTypes('application/json,text/plain')
      .setIncludeFolders(true);
    var picker = new google.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(gdriveAccessToken)
      .setDeveloperKey(GOOGLE_DRIVE_API_KEY)
      .setCallback(function(data){
        if(data.action !== google.picker.Action.PICKED) return;
        var fileId = data.docs[0].id;
        gdriveDownloadAndRestore(fileId);
      })
      .build();
    picker.setVisible(true);
  });
}

function gdriveDownloadAndRestore(fileId){
  toast('Fetching file from Google Drive…');
  fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media', {
    headers: { 'Authorization': 'Bearer ' + gdriveAccessToken }
  }).then(function(res){
    if(!res.ok) throw new Error('Drive fetch failed: ' + res.status);
    return res.text();
  }).then(function(text){
    restoreFromJsonText(text);
  }).catch(function(err){
    toast('Could not download that file from Google Drive.');
  });
}

/* Shared token-acquisition step for both import and export. onReady is
   called once gdriveAccessToken is set.

   Whether this can renew quietly must be judged purely by the saved
   timestamp (gdriveAuthStillValid), never by whether gdriveAccessToken
   is currently set in memory — that variable resets to null on every
   page load/app launch, so gating on it here would force the full
   consent screen on literally the first click of every session even
   when well inside the person's chosen reconnect window. So: if the
   window hasn't lapsed, try a silent renewal first (prompt:''), and
   only fall back to the interactive consent screen if that silent
   attempt itself comes back with an error (e.g. the Google session
   cookie is also gone). Past the window, go straight to consent. */
function gdriveWithToken(onReady){
  if(gdriveBlockedByOrigin()) return;
  if(!gdriveCredentialsConfigured()){
    alert('Google Drive import/export needs a Client ID and API key from Google Cloud Console first. See the setup notes for this feature.');
    return;
  }
  ensureGoogleIdentity().then(function(){ gdriveWithTokenLoaded(onReady); }, function(){
    toast('Could not reach Google — check your connection and try again.');
  });
}
function gdriveWithTokenLoaded(onReady){
  var withinWindow = gdriveAuthStillValid();
  if(!withinWindow) clearGdriveAuth();

  if(!gdriveTokenClient){
    gdriveTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_DRIVE_CLIENT_ID,
      scope: GDRIVE_SCOPES,
      callback: function(){} /* replaced per-request just below */
    });
  }

  function succeed(resp){
    gdriveAccessToken = resp.access_token;
    markGdriveAuthNow(); /* click-driven connection (silent or not) — this is what starts/extends the clock */
    gdriveRememberEmailFromToken(resp.access_token); /* so the picker has nothing left to ask, from here on */
    onReady();
  }
  function requestConsent(){
    gdriveTokenClient.callback = function(resp){
      if(resp.error){ toast('Google Drive sign-in was cancelled or failed.'); return; }
      succeed(resp);
    };
    gdriveTokenClient.requestAccessToken(gdriveTokenRequestOpts('consent'));
  }

  if(withinWindow){
    gdriveTokenClient.callback = function(resp){
      if(!resp.error){ succeed(resp); return; }
      requestConsent(); /* silent renewal failed — ask properly instead */
    };
    gdriveTokenClient.requestAccessToken(gdriveTokenRequestOpts(''));
  } else {
    requestConsent();
  }
}

function gdriveStartImport(){
  gdriveWithToken(gdriveOpenPicker);
}

/* Uploads the current notebook as a new .json file in the user's My Drive
   root, using the multipart upload endpoint. Reuses buildBackupJson() so
   the export is byte-for-byte the same format as the local "Backup
   (export)" button produces, attachments included. */
function gdriveUploadBackup(){
  var d = new Date();
  var fname = 'nexus-backup-' + d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')
    + '-' + String(d.getHours()).padStart(2,'0')+String(d.getMinutes()).padStart(2,'0') + '.json';
  toast('Preparing backup for Google Drive…');
  buildBackupJson().then(maybeEncryptExport).then(function(json){
    var metadata = { name: fname, mimeType: 'application/json' };
    var boundary = 'nexus-boundary-' + Date.now();
    var body =
      '--' + boundary + '\r\n' +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) + '\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Type: application/json\r\n\r\n' +
      json + '\r\n' +
      '--' + boundary + '--';
    return fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + gdriveAccessToken,
        'Content-Type': 'multipart/related; boundary=' + boundary
      },
      body: body
    });
  }).then(function(res){
    if(!res.ok) throw new Error('Drive upload failed: ' + res.status);
    return res.json();
  }).then(function(file){
    toast('Backup saved to Google Drive: ' + fname);
    snapshotVersion('manual backup (Google Drive)', {kind:'backup'});
  }).catch(function(err){
    if(err && err.message === 'export-cancelled') return; /* already toasted, or silently cancelled */
    toast('Could not save the backup to Google Drive.');
  });
}

function gdriveStartExport(){
  gdriveWithToken(gdriveUploadBackup);
}

/* ---------- Google Drive AUTO-SYNC ----------
   A third sync transport alongside LAN sync (10-lan-sync.js): instead of
   a live peer-to-peer link, this periodically merges the notebook with
   one fixed file in the user's Drive ("nexus-sync-state.json"), reusing
   the exact same mergeStates()/applyIncomingMerge()/recordConflicts()
   engine LAN sync uses — Google Drive is treated as just another peer,
   with its own cursor at state.syncPeers.gdrive. This means it can work
   even when the two devices are never open at the same time, and it
   doesn't require any particular network path between the devices —
   only that each one can reach Google's servers.

   The trade-off vs LAN sync: it needs the Google Drive credentials
   configured, isn't instantaneous (polls on an interval), and — because
   this is a client-side-only app with no server to hold a refresh
   token — silently reconnecting after the browser is closed and
   reopened isn't always possible; if Google's session-based silent
   token request fails, this shows a status message asking for one
   click to reconnect rather than repeatedly prompting. */
var GDRIVE_SYNC_FILENAME = 'nexus-sync-state.json';
var GDRIVE_SYNC_FILEID_KEY = STORAGE_KEY + '_gdrive_sync_fileid';
var gdriveAutoSyncTimer = null;
var gdriveAutoPushTimer = null;
/* Encryption state for the Drive sync file specifically — separate
   from the local passcode lock's own DEK, which is per-device and
   can't be shared with another device the way this needs to be. See
   the big comment above and encryptForPortableStorage() in
   09-security-lock.js for why. All memory-only; never written to
   disk, same as the DEK itself. */
var gdriveSyncPasscode = null;          /* raw passcode, only once confirmed correct, kept for this tab session */
var gdriveSyncEncryptionDeclined = false; /* person chose plain sync even though a lock is set up */
var gdriveSyncKeyCache = { salt: null, key: null }; /* memoized derived key so a 200k-iteration KDF isn't redone every tick */

function gdriveAutoSyncEnabled(){
  return typeof currentSettings !== 'undefined' && currentSettings.gdriveAutoSync === 'on';
}

function setGdriveAutoSyncStatus(text){
  var el = document.getElementById('gdrive-autosync-status');
  if(el) el.textContent = text || '';
}

function setGdriveAutoSyncToggleUI(){
  var row = document.getElementById('settings-gdriveautosync-row');
  if(!row) return;
  Array.prototype.slice.call(row.querySelectorAll('.settings-opt')).forEach(function(btn){
    btn.classList.toggle('active', btn.dataset.gdriveautosync === (gdriveAutoSyncEnabled() ? 'on' : 'off'));
  });
}

/* ---- "Reconnect to Google Drive every…" setting UI ----
   Same shape as the auto-sync toggle row above: a row of .settings-opt
   buttons, each carrying data-gdriveauthttl="1|6|12|24". */
function setGdriveAuthTtlUI(){
  var row = document.getElementById('settings-gdriveauthttl-row');
  if(!row) return;
  var cur = gdriveAuthTtlHours();
  Array.prototype.slice.call(row.querySelectorAll('.settings-opt')).forEach(function(btn){
    btn.classList.toggle('active', btn.dataset.gdriveauthttl === cur);
  });
}
function updateGdriveAuthTtlStatus(){
  var el = document.getElementById('gdrive-authttl-status');
  if(!el) return;
  var hours = gdriveAuthTtlHours();
  var at = gdriveAuthAt();
  if(!at){
    el.textContent = 'Not connected to Google Drive right now. Once you connect, Nexus will keep the connection alive in the background for ' + hours + 'h before asking you to reconnect.';
    return;
  }
  var remaining = (at + gdriveAuthTtlMs()) - Date.now();
  if(remaining <= 0){
    el.textContent = 'Connection expired — click "Sync now" to reconnect to Google Drive.';
    return;
  }
  var mins = Math.round(remaining / 60000);
  var left = mins >= 60 ? (Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm') : (mins + 'm');
  el.textContent = 'Connected ' + timeAgo(at) + '. Reconnect needed in about ' + left + '. ' +
    'Google\'s own tokens expire hourly regardless; this controls how long Nexus may renew them quietly before asking you again.';
}
/* Changing the window re-evaluates the existing connection immediately,
   so shortening it to something already exceeded drops the token there
   and then rather than at the next tick. */
function setGdriveAuthTtl(hours){
  hours = String(hours);
  if(GDRIVE_AUTH_TTL_CHOICES.indexOf(hours) === -1) return;
  currentSettings.gdriveAuthTtlHours = hours;
  saveSettings(currentSettings);
  setGdriveAuthTtlUI();
  if(gdriveAuthExpired()){
    clearGdriveAuth();
    if(gdriveAutoSyncEnabled()) setGdriveAutoSyncStatus('Drive connection expired — click "Sync now" to reconnect.');
  }
  updateGdriveAuthTtlStatus();
  toast('Google Drive will ask you to reconnect every ' + hours + ' hour' + (hours === '1' ? '' : 's') + '.');
}
/* Wired on DOMContentLoaded rather than inline, so that if
   07-find-replace-settings.js (which loads after this file) assigns its
   own handlers across .settings-opt buttons, it can't clobber this row's
   onclick — by then every script has run. */
(function wireGdriveAuthTtlRow(){
  function wire(){
    var row = document.getElementById('settings-gdriveauthttl-row');
    if(!row) return;
    Array.prototype.slice.call(row.querySelectorAll('.settings-opt')).forEach(function(btn){
      btn.onclick = function(){ setGdriveAuthTtl(btn.dataset.gdriveauthttl); };
    });
    setGdriveAuthTtlUI();
    updateGdriveAuthTtlStatus();
    /* The sync-key session restore itself now lives in
       wireGdriveSyncKeySessionRow above, alongside the status text it
       needs to refresh once the restore resolves. */
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();

/* Acquires an access token without ever showing a consent popup —
   used for background/periodic attempts so a stale session doesn't
   nag the person with sign-in windows they didn't ask for right now.
   Only the explicit "On" click (enableGdriveAutoSync) uses the
   interactive version, gdriveWithToken. */
function gdriveGetTokenSilently(onReady, onFail){
  /* Never-connected (or lapsed) means: don't load or contact Google at all. */
  if(!gdriveAuthStillValid()){ onFail && onFail(); return; }
  ensureGoogleIdentity().then(function(){ gdriveGetTokenSilentlyLoaded(onReady, onFail); }, function(){ onFail && onFail(); });
}
function gdriveGetTokenSilentlyLoaded(onReady, onFail){
  /* The whole point of the setting: once the window since the last
     deliberate connection has passed, background renewal stops and the
     caller falls through to its "needs sign-in" status instead. Note
     this never marks the auth time — only an interactive connect does,
     so a machine left running still comes back and asks on schedule. */
  if(!gdriveAuthStillValid()){ onFail && onFail(); return; }
  if(!gdriveTokenClient){
    gdriveTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_DRIVE_CLIENT_ID,
      scope: GDRIVE_SCOPES,
      callback: function(resp){
        if(resp.error){ onFail && onFail(); return; }
        gdriveAccessToken = resp.access_token;
        gdriveRememberEmailFromToken(resp.access_token);
        onReady();
      }
    });
  } else {
    gdriveTokenClient.callback = function(resp){
      if(resp.error){ onFail && onFail(); return; }
      gdriveAccessToken = resp.access_token;
      gdriveRememberEmailFromToken(resp.access_token);
      onReady();
    };
  }
  try{ gdriveTokenClient.requestAccessToken(gdriveTokenRequestOpts('')); }
  catch(e){ onFail && onFail(); }
}

/* Only called from an interactive click (enableGdriveAutoSync,
   gdriveSyncNow) — never from the silent periodic tick — since it may
   show a confirm()/prompt(). Resolves 'plain', 'encrypted', or
   'cancelled'. Once resolved 'encrypted' or 'plain' this session, it
   won't ask again unless the passcode turns out to be wrong. */
function ensureGdriveSyncMode(){
  if(!isLockEnabled() || gdriveSyncEncryptionDeclined) return Promise.resolve('plain');
  if(gdriveSyncPasscode) return Promise.resolve('encrypted');
  if(!confirm('This notebook has a passcode lock set up.\n\nEncrypt Google Drive sync data with your passcode too?\n\nOK = encrypted (every device you sync with must use this same passcode).\nCancel = keep sync data as plain, readable JSON, same as before.')){
    gdriveSyncEncryptionDeclined = true;
    clearGdriveSyncKeySession();
    persistGdriveSyncDeclined();
    return Promise.resolve('plain');
  }
  var passcode = promptForPasscode('Enter your passcode:');
  if(passcode === null) return Promise.resolve('cancelled');
  return confirmPasscode(passcode).then(function(ok){
    if(!ok){ toast('Incorrect passcode.'); return 'cancelled'; }
    gdriveSyncEncryptionDeclined = false;
    clearGdriveSyncDeclined();
    gdriveSyncPasscode = passcode;
    gdriveSyncKeyUnlockedAt = Date.now();
    persistGdriveSyncKeySession();
    updateGdriveSyncKeySessionStatus();
    return 'encrypted';
  });
}

function getGdriveSyncKey(salt){
  if(gdriveSyncKeyCache.salt === salt && gdriveSyncKeyCache.key) return Promise.resolve(gdriveSyncKeyCache.key);
  return deriveLockKey(gdriveSyncPasscode, salt, PBKDF2_ITERATIONS).then(function(key){
    gdriveSyncKeyCache = { salt: salt, key: key };
    return key;
  });
}

/* Builds the request body for creating/overwriting the sync file:
   plain JSON if encryption isn't in play, otherwise the same portable
   envelope format used by backups. Reuses whatever salt this device
   last saw for this file so the salt (and therefore the file) stays
   stable across pushes from any device, rather than a fresh one every
   write. */
function buildGdriveSyncBody(){
  deriveOrder(state);
  var jsonStr = JSON.stringify(JSON.parse(JSON.stringify(state)));
  if(!gdriveSyncPasscode) return Promise.resolve(jsonStr);
  var salt = gdriveSyncKeyCache.salt || randomSaltB64();
  return getGdriveSyncKey(salt).then(function(key){
    return encryptWithKey(key, jsonStr).then(function(enc){
      return JSON.stringify({ nexusEncryptedBackup: true, v: 1, salt: salt, iterations: PBKDF2_ITERATIONS, iv: enc.iv, ct: enc.ct });
    });
  });
}

function gdriveCreateSyncFile(cb){
  buildGdriveSyncBody().then(function(body){
    var metadata = { name: GDRIVE_SYNC_FILENAME, mimeType: 'application/json' };
    var boundary = 'nexus-boundary-' + Date.now();
    var multipartBody =
      '--' + boundary + '\r\n' +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) + '\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Type: application/json\r\n\r\n' +
      body + '\r\n' +
      '--' + boundary + '--';
    return fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + gdriveAccessToken, 'Content-Type': 'multipart/related; boundary=' + boundary },
      body: multipartBody
    });
  }).then(function(res){
    if(!res.ok) throw new Error('Drive create failed: ' + res.status);
    return res.json();
  }).then(function(file){
    localStorage.setItem(GDRIVE_SYNC_FILEID_KEY, file.id);
    cb(file.id);
  }).catch(function(){ cb(null); });
}

/* drive.file scope only ever sees files this app itself created (or
   the person opened via the Picker), so this list query can't leak
   into the rest of their Drive even though it isn't scoped to a
   single folder. */
function gdriveFindSyncFile(cb, forceRelist){
  var cachedId = !forceRelist && localStorage.getItem(GDRIVE_SYNC_FILEID_KEY);
  if(cachedId){ cb(cachedId); return; }
  fetch('https://www.googleapis.com/drive/v3/files?q=' +
    encodeURIComponent("name='" + GDRIVE_SYNC_FILENAME + "' and trashed=false") +
    '&spaces=drive&fields=files(id,name)', {
    headers: { 'Authorization': 'Bearer ' + gdriveAccessToken }
  }).then(function(res){ return res.json(); }).then(function(data){
    if(data.files && data.files.length){
      localStorage.setItem(GDRIVE_SYNC_FILEID_KEY, data.files[0].id);
      cb(data.files[0].id);
    } else {
      gdriveCreateSyncFile(cb);
    }
  }).catch(function(){ cb(null); });
}

/* Resolves {data, needsPasscode, error}. data is the plain notebook
   state object (never the raw envelope) once decrypted, or null if
   there's nothing usable yet. needsPasscode means the remote file is
   encrypted but this session hasn't confirmed a passcode for it —
   the caller should show a status, not fail loudly, since this is
   the normal shape of "just reopened the tab" before a click. */
function gdrivePullSyncState(fileId){
  return fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media', {
    headers: { 'Authorization': 'Bearer ' + gdriveAccessToken }
  }).then(function(res){
    if(!res.ok) throw new Error('Drive fetch failed: ' + res.status);
    return res.text();
  }).then(function(text){
    var obj;
    try{ obj = JSON.parse(text); }catch(e){ return {data:null, needsPasscode:false, error:false}; }
    if(!obj) return {data:null, needsPasscode:false, error:false};
    if(obj.nexusEncryptedBackup){
      if(!gdriveSyncPasscode) return {data:null, needsPasscode:true, error:false};
      return getGdriveSyncKey(obj.salt).then(function(key){
        return decryptWithKey(key, {iv:obj.iv, ct:obj.ct});
      }).then(function(plain){
        try{ return {data: JSON.parse(plain), needsPasscode:false, error:false}; }
        catch(e){ return {data:null, needsPasscode:false, error:true}; }
      }).catch(function(){ return {data:null, needsPasscode:false, error:true}; });
    }
    return {data: obj, needsPasscode:false, error:false};
  });
}

function gdrivePushSyncState(fileId){
  return buildGdriveSyncBody().then(function(body){
    return fetch('https://www.googleapis.com/upload/drive/v3/files/' + fileId + '?uploadType=media', {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + gdriveAccessToken, 'Content-Type': 'application/json' },
      body: body
    }).then(function(res){
      if(!res.ok) throw new Error('Drive upload failed: ' + res.status);
      return res;
    });
  });
}

/* One pull -> merge -> push pass. Mirrors handleIncomingLanSync in
   10-lan-sync.js, with Google Drive standing in for a live peer link
   and 'gdrive' as its fixed peer id in state.syncPeers. Does not check
   whether auto-sync is turned on — callers decide that. */
var gdriveCycleRunning = false;
var gdriveCycleStartedAt = 0;
var gdriveCycleQueued = false;
var GDRIVE_CYCLE_STALE_MS = 90000; /* a cycle that hasn't finished in this long is assumed hung, so it can't block syncing forever */

/* Entry point for every kind of sync (timer tick, tab resume, local save,
   "Sync now"). Only one pull->merge->push runs at a time: a request that
   arrives mid-cycle is remembered and re-run once, right after, so a
   local edit made while a sync was in flight is never left behind. */
function gdrivePerformSyncCycle(){
  if(typeof appLocked !== 'undefined' && appLocked) return;
  if(!gdriveCredentialsConfigured() || gdriveBlockedByOrigin(true)) return;
  if(gdriveCycleRunning && (Date.now() - gdriveCycleStartedAt) < GDRIVE_CYCLE_STALE_MS){
    gdriveCycleQueued = true;
    return;
  }
  gdriveCycleRunning = true;
  gdriveCycleStartedAt = Date.now();
  var finished = false;
  gdriveRunSyncCycleBody(function(){
    if(finished) return;
    finished = true;
    gdriveCycleRunning = false;
    if(gdriveCycleQueued){
      gdriveCycleQueued = false;
      gdrivePerformSyncCycle();
    }
  });
}

function gdriveRunSyncCycleBody(done){
  gdriveFindSyncFile(function(fileId){
    if(!fileId){ setGdriveAutoSyncStatus('Could not reach the Google Drive sync file — will retry.'); done(); return; }
    gdrivePullSyncState(fileId).then(function(result){
      if(result.needsPasscode){
        setGdriveAutoSyncStatus('Encrypted sync data found — click "Sync now" to unlock it for this session.');
        return;
      }
      if(result.error){
        setGdriveAutoSyncStatus('Could not decrypt the Google Drive sync file — check your passcode.');
        return;
      }
      var remote = result.data;
      if(!remote || !remote.pages){
        return gdrivePushSyncState(fileId).then(function(){
          state.syncPeers = state.syncPeers || {};
          state.syncPeers.gdrive = Date.now();
          save({touchEntities:false, recordUndo:false, broadcast:false});
          setGdriveAutoSyncStatus('Synced just now.');
        });
      }
      var sinceTs = (state.syncPeers && state.syncPeers.gdrive) || null;
      var mergeResult = mergeStates(state, remote, sinceTs);
      var merged = mergeResult.state;
      var changed = JSON.stringify(merged) !== JSON.stringify(state);
      var syncTs = Date.now();
      if(!merged.syncPeers) merged.syncPeers = {};
      merged.syncPeers.gdrive = syncTs;
      if(changed){
        syncSafetySnapshot(mergeResult, 'Google Drive');
        applyIncomingMerge(merged);
        toast('Synced with Google Drive.');
      } else {
        state.syncPeers = state.syncPeers || {};
        state.syncPeers.gdrive = syncTs;
        save({touchEntities:false, recordUndo:false, broadcast:false});
      }
      if(mergeResult.conflicts.length){
        recordConflicts(mergeResult.conflicts, 'Google Drive');
        toast(mergeResult.conflicts.length + (mergeResult.conflicts.length === 1 ? ' line conflicted' : ' lines conflicted') +
          ' while syncing with Google Drive — see Sync conflicts.');
      }
      return gdrivePushSyncState(fileId).then(function(){
        setGdriveAutoSyncStatus('Last synced ' + timeAgo(syncTs) + '.');
      });
    }).catch(function(){
      setGdriveAutoSyncStatus('Could not reach Google Drive just now — will retry.');
    }).then(done);
  });
}

/* The periodic/background path: silent-only, never pops a sign-in or
   passcode prompt on its own, and does nothing while the setting is
   off. If the sync file turns out to be encrypted and this session
   hasn't unlocked it yet, gdrivePerformSyncCycle just shows a status
   line asking for a "Sync now" click rather than interrupting. */
function runGdriveSyncCycle(){
  if(!gdriveAutoSyncEnabled()) return;
  /* A locked notebook must not be merged with, or uploaded to, Drive in the background: the
     passcode gate also covers sync. The next timer tick / resume after unlocking catches up. */
  if(typeof appLocked !== 'undefined' && appLocked) return;
  if(!gdriveCredentialsConfigured() || gdriveBlockedByOrigin(true)) return;
  if(gdriveAccessToken && gdriveAuthStillValid()){ gdrivePerformSyncCycle(); return; }
  gdriveGetTokenSilently(gdrivePerformSyncCycle, function(){
    setGdriveAutoSyncStatus(gdriveAuthExpired()
      ? 'Drive connection expired after ' + gdriveAuthTtlHours() + 'h — click "Sync now" to reconnect.'
      : 'Needs sign-in — click "On" again to reconnect.');
    updateGdriveAuthTtlStatus();
  });
}

/* The "Sync now" button: a direct click, so an interactive consent
   popup (Drive sign-in) and a passcode prompt (encryption) are both
   fine here even if auto-sync is off or a silent attempt just failed. */
function gdriveSyncNow(){
  if(!gdriveCredentialsConfigured()){
    alert('Google Drive import/export needs a Client ID and API key from Google Cloud Console first. See the setup notes for this feature.');
    return;
  }
  if(gdriveBlockedByOrigin()) return;
  ensureGdriveSyncMode().then(function(mode){
    if(mode === 'cancelled') return;
    setGdriveAutoSyncStatus('Syncing…');
    gdriveWithToken(gdrivePerformSyncCycle);
  });
}

/* Called from broadcastStateToPeers() (10-lan-sync.js) on every local
   save. Waits for a short pause in editing, then runs a full
   pull -> merge -> push cycle — NOT a bare push. A bare push would
   overwrite the Drive file with this device's copy, silently erasing
   anything another device had pushed since this one last looked; going
   through the merge engine first means edits from every device
   accumulate no matter which one saves last, with no manual "Sync now".
   Only runs if a token is already live, so this never itself triggers a
   sign-in or passcode prompt. If encryption is in play but this session
   hasn't confirmed the passcode yet, this quietly skips (the next
   "Sync now" or periodic tick picks it up once it has). */
function scheduleGdriveAutoPush(){
  if(!gdriveAutoSyncEnabled() || !gdriveAccessToken) return;
  if(!gdriveAuthStillValid()){ setGdriveAutoSyncStatus('Drive connection expired — click "Sync now" to reconnect.'); return; }
  if(isLockEnabled() && !gdriveSyncEncryptionDeclined && !gdriveSyncPasscode) return;
  clearTimeout(gdriveAutoPushTimer);
  gdriveAutoPushTimer = setTimeout(function(){
    gdriveAutoPushTimer = null;
    gdrivePerformSyncCycle();
  }, 4000);
}

/* Sync as soon as the person comes back to this tab/window (or the
   network returns) instead of waiting up to 60s for the next tick.
   Throttled so tab-switch + window-focus events firing together, or
   rapid flipping between tabs, don't stack up requests. Silent-only,
   same as the periodic path (runGdriveSyncCycle). */
var gdriveLastResumeSync = 0;
var GDRIVE_RESUME_MIN_GAP_MS = 5000;
function gdriveSyncOnResume(){
  if(!gdriveAutoSyncEnabled() || document.hidden) return;
  var now = Date.now();
  if(now - gdriveLastResumeSync < GDRIVE_RESUME_MIN_GAP_MS) return;
  gdriveLastResumeSync = now;
  runGdriveSyncCycle();
}

/* When a tab is being hidden, a save-triggered sync may still be waiting
   out its 4s pause — and background timers get throttled or frozen. Run
   it now so the edit gets out before the tab goes to sleep. */
function gdriveFlushPendingSync(){
  if(!gdriveAutoPushTimer) return;
  clearTimeout(gdriveAutoPushTimer);
  gdriveAutoPushTimer = null;
  if(gdriveAutoSyncEnabled() && gdriveAccessToken && gdriveAuthStillValid()) gdrivePerformSyncCycle();
}

function startGdriveAutoSyncTimer(){
  clearInterval(gdriveAutoSyncTimer);
  gdriveAutoSyncTimer = setInterval(function(){
    if(document.hidden) return;
    updateGdriveAuthTtlStatus();
    runGdriveSyncCycle();
  }, 60000);
}
function stopGdriveAutoSyncTimer(){
  clearInterval(gdriveAutoSyncTimer);
  gdriveAutoSyncTimer = null;
  clearTimeout(gdriveAutoPushTimer);
  gdriveAutoPushTimer = null;
}

/* Entry point for the explicit "On" click — the only place (besides
   Sync now) allowed to pop an interactive consent/passcode prompt,
   since it's a direct response to the person's own click. */
function enableGdriveAutoSync(){
  if(!gdriveCredentialsConfigured()){
    alert('Google Drive import/export needs a Client ID and API key from Google Cloud Console first. See the setup notes for this feature.');
    return;
  }
  if(gdriveBlockedByOrigin()) return;
  ensureGdriveSyncMode().then(function(mode){
    if(mode === 'cancelled'){
      currentSettings.gdriveAutoSync = 'off';
      saveSettings(currentSettings);
      setGdriveAutoSyncToggleUI();
      return;
    }
    setGdriveAutoSyncToggleUI();
    setGdriveAutoSyncStatus('Connecting…');
    gdriveWithToken(function(){
      startGdriveAutoSyncTimer();
      runGdriveSyncCycle();
    });
  });
}

function disableGdriveAutoSync(){
  setGdriveAutoSyncToggleUI();
  setGdriveAutoSyncStatus('');
  stopGdriveAutoSyncTimer();
}

function parseSnapshotJson(json){
  var snap = JSON.parse(json);
  if(!snap || typeof snap !== 'object' || !snap.pages || !snap.blocks) throw new Error('not a notebook snapshot');
  return snap;
}
function restoreFromVersion(entry){
  if(!confirm('Load this snapshot from ' + new Date(entry.ts).toLocaleString() + '? This will replace what\'s currently open.')) return;
  snapshotVersion('Before restoring a snapshot', {kind:'safety'});
  getVersionData(entry).then(function(json){
    state = normalizeState(parseSnapshotJson(json));
    save();
    renderAll();
    closeVersions();
    closeVersionDiff();
    toast('Snapshot loaded.');
  }).catch(function(){ toast('That snapshot could not be read.'); });
}

/* Bring one page (its title, properties and every line, exactly as the snapshot had them) back into the
   notebook without touching anything else. A safety snapshot of the current state is taken first. */
function restorePageFromSnapshot(snap, pageId){
  var sp = snap.pages && snap.pages[pageId];
  if(!sp){ toast('That page is not in this snapshot.'); return false; }
  var curP = state.pages[pageId];
  snapshotVersion('Before restoring page "' + (curP ? curP.title : sp.title) + '"', {kind:'safety'});
  var copy = JSON.parse(JSON.stringify(sp));
  var snapIds = Object.keys(snap.blocks || {}).filter(function(id){ return snap.blocks[id] && snap.blocks[id].pageId === pageId; });
  /* A line id that has since moved to a different page keeps living there; the restored line gets a fresh id. */
  var remap = {};
  snapIds.forEach(function(id){ var ex = state.blocks[id]; if(ex && ex.pageId !== pageId) remap[id] = uid(); });
  function mapId(id){ return remap[id] || id; }
  Object.keys(state.blocks).forEach(function(id){ if(state.blocks[id].pageId === pageId) delete state.blocks[id]; });
  snapIds.forEach(function(id){
    var nb = JSON.parse(JSON.stringify(snap.blocks[id]));
    nb.id = mapId(id);
    nb.pageId = pageId;
    nb.parent = nb.parent ? mapId(nb.parent) : null;
    nb.children = (nb.children || []).map(mapId);
    delete nb.conflict;
    state.blocks[nb.id] = nb;
    if(state.tombstones && state.tombstones.blocks){ delete state.tombstones.blocks[nb.id]; delete state.tombstones.blocks[id]; }
  });
  snapIds.forEach(function(id){
    var b = state.blocks[mapId(id)];
    b.children = b.children.filter(function(c){ return !!state.blocks[c]; });
    if(b.parent && !state.blocks[b.parent]) b.parent = null;
  });
  copy.rootBlocks = (copy.rootBlocks || []).map(mapId).filter(function(id){ return state.blocks[id] && !state.blocks[id].parent; });
  snapIds.forEach(function(id){ var nid = mapId(id); if(state.blocks[nid] && !state.blocks[nid].parent && copy.rootBlocks.indexOf(nid) === -1) copy.rootBlocks.push(nid); });
  var key = (copy.title || '').toLowerCase();
  var clash = Object.keys(state.pages).some(function(pid){ return pid !== pageId && (state.pages[pid].title || '').toLowerCase() === key; });
  if(clash) copy.title = copy.title + ' (restored)';
  delete copy.trashedAt;
  state.pages[pageId] = copy;
  if(state.tombstones && state.tombstones.pages) delete state.tombstones.pages[pageId];
  state.titleIndex = rebuildTitleIndex(state);
  save();
  renderAll();
  openPage(pageId);
  toast('Restored "' + copy.title + '".');
  return true;
}
function restoreLineFromSnapshot(snap, blockId){
  var sb = snap.blocks && snap.blocks[blockId], cb = state.blocks[blockId];
  if(!sb || !cb){ toast('That line is not available to restore.'); return false; }
  snapshotVersionThrottled('line-restore', 2*60*1000, 'Before restoring lines from a snapshot', {kind:'safety'});
  cb.text = sb.text;
  save();
  renderPage();
  return true;
}

/* ---- Word-level highlighting (used by the snapshot comparison and by sync conflicts). Pure text →
   DOM built with textContent, so nothing from a note is ever interpreted as markup. ---- */
function tokenizeWords(s){ return (s || '').split(/(\s+)/).filter(function(t){ return t.length; }); }
function wordDiffParts(a, b){
  var A = tokenizeWords(a), B = tokenizeWords(b), n = A.length, m = B.length, i, j;
  if(n * m > 250000) return {a:[{t:a || '', d:true}], b:[{t:b || '', d:true}]};
  var dp = [];
  for(i=0;i<=n;i++){ dp.push(new Array(m+1)); dp[i][m] = 0; }
  for(j=0;j<=m;j++) dp[n][j] = 0;
  for(i=n-1;i>=0;i--) for(j=m-1;j>=0;j--) dp[i][j] = A[i] === B[j] ? dp[i+1][j+1] + 1 : Math.max(dp[i+1][j], dp[i][j+1]);
  var oa = [], ob = [];
  i = 0; j = 0;
  while(i < n && j < m){
    if(A[i] === B[j]){ oa.push({t:A[i]}); ob.push({t:B[j]}); i++; j++; }
    else if(dp[i+1][j] >= dp[i][j+1]){ oa.push({t:A[i], d:true}); i++; }
    else { ob.push({t:B[j], d:true}); j++; }
  }
  while(i < n){ oa.push({t:A[i++], d:true}); }
  while(j < m){ ob.push({t:B[j++], d:true}); }
  return {a:oa, b:ob};
}
function fillWordDiff(el, parts, cls){
  el.textContent = '';
  parts.forEach(function(p){
    if(p.d && /\S/.test(p.t)){ var s = document.createElement('span'); s.className = cls; s.textContent = p.t; el.appendChild(s); }
    else el.appendChild(document.createTextNode(p.t));
  });
  if(!el.firstChild) el.textContent = '(empty)';
}
function fillWordDiffPair(elOld, elNew, oldText, newText){
  var d = wordDiffParts(oldText, newText);
  fillWordDiff(elOld, d.a, 'wd-del');
  fillWordDiff(elNew, d.b, 'wd-ins');
}

/* ---- Version diff: a per-page/per-block summary of what a snapshot restore would change, computed on
   demand from the two full-state JSON blobs — no separate diff storage needed. ---- */
function truncateForDiff(s, n){
  s = s || '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function computeVersionDiff(entry){
  return getVersionData(entry).then(function(json){
    var snap;
    try{ snap = parseSnapshotJson(json); }catch(e){ return null; }
    return {snap: snap, diff: buildVersionDiff(snap)};
  }).catch(function(){ return null; });
}
function buildVersionDiff(snap){
  var curPages = state.pages || {}, snapPages = snap.pages || {};
  var curBlocksAll = state.blocks || {}, snapBlocksAll = snap.blocks || {};
  var result = {restored:[], removed:[], modified:[], unchangedCount:0};
  var allIds = {};
  Object.keys(curPages).forEach(function(id){ allIds[id] = true; });
  Object.keys(snapPages).forEach(function(id){ allIds[id] = true; });

  function blockTextsForPage(blocksObj, pageId){
    var out = {};
    Object.keys(blocksObj).forEach(function(bid){
      var b = blocksObj[bid];
      if(b && b.pageId === pageId) out[bid] = b.text || '';
    });
    return out;
  }

  Object.keys(allIds).forEach(function(pid){
    var curP = curPages[pid], snapP = snapPages[pid];
    if(curP && !snapP){ result.removed.push({id:pid, title: curP.title}); return; }
    if(!curP && snapP){ result.restored.push({id:pid, title: snapP.title}); return; }
    if(!curP && !snapP) return;

    var curBlocks = blockTextsForPage(curBlocksAll, pid);
    var snapBlocks = blockTextsForPage(snapBlocksAll, pid);
    var blockIds = {};
    Object.keys(curBlocks).forEach(function(k){ blockIds[k] = true; });
    Object.keys(snapBlocks).forEach(function(k){ blockIds[k] = true; });
    var changedBlocks = [];
    Object.keys(blockIds).forEach(function(bid){
      var cText = curBlocks.hasOwnProperty(bid) ? curBlocks[bid] : null;
      var sText = snapBlocks.hasOwnProperty(bid) ? snapBlocks[bid] : null;
      if(cText === sText) return;
      changedBlocks.push({id: bid, current: cText, snapshot: sText});
    });
    var titleChanged = curP.title !== snapP.title;
    if(changedBlocks.length || titleChanged){
      result.modified.push({id:pid, currentTitle:curP.title, snapshotTitle:snapP.title, titleChanged:titleChanged, blocks:changedBlocks});
    } else {
      result.unchangedCount++;
    }
  });
  return result;
}
function scopeVersionDiffToPage(diff, pageId){
  function only(list){ return list.filter(function(x){ return x.id === pageId; }); }
  return {restored: only(diff.restored), removed: only(diff.removed), modified: only(diff.modified), unchangedCount: 0};
}

function openVersionDiff(entry, opts){
  opts = opts || {};
  var wrap = document.getElementById('diff-list');
  document.getElementById('diff-overlay-title').textContent = (opts.pageId ? 'This page vs. ' : 'Comparing to ') + new Date(entry.ts).toLocaleString();
  var restoreBtn = document.getElementById('diff-restore-btn');
  restoreBtn.textContent = opts.pageId ? 'Restore this page' : 'Restore this snapshot';
  restoreBtn.style.display = 'none';
  wrap.textContent = '';
  var loading = document.createElement('div'); loading.className = 'version-empty'; loading.textContent = 'Loading…'; wrap.appendChild(loading);
  document.getElementById('diff-overlay').style.display = 'flex';
  computeVersionDiff(entry).then(function(res){
    wrap.textContent = '';
    function message(text){ var d = document.createElement('div'); d.className = 'version-empty'; d.textContent = text; wrap.appendChild(d); }
    if(!res){ message('That snapshot could not be read.'); return; }
    var snap = res.snap, diff = opts.pageId ? scopeVersionDiffToPage(res.diff, opts.pageId) : res.diff;
    if(opts.pageId){
      if(snap.pages[opts.pageId]){
        restoreBtn.style.display = '';
        restoreBtn.onclick = function(){
          if(!confirm('Replace this page with its version from ' + new Date(entry.ts).toLocaleString() + '? Everything else stays as it is.')) return;
          if(restorePageFromSnapshot(snap, opts.pageId)){ closeVersionDiff(); closeVersions(); }
        };
      }
    } else {
      restoreBtn.style.display = '';
      restoreBtn.onclick = function(){ closeVersionDiff(); restoreFromVersion(entry); };
    }
    if(!diff.removed.length && !diff.restored.length && !diff.modified.length){
      message(opts.pageId ? 'This page is identical to that snapshot.' : 'No differences — this snapshot matches what\'s currently open.');
      return;
    }
    var summary = document.createElement('div');
    summary.className = 'diff-summary';
    summary.textContent = diff.modified.length + ' page' + (diff.modified.length===1?'':'s') + ' changed, ' +
      diff.removed.length + ' created since (would be removed by a full restore), ' + diff.restored.length + ' missing now (would come back), ' +
      diff.unchangedCount + ' unchanged.';
    wrap.appendChild(summary);
    var rows = [];
    if(diff.modified.length + diff.restored.length + diff.removed.length > 8){
      var filter = document.createElement('input');
      filter.type = 'search'; filter.className = 'diff-filter'; filter.placeholder = 'Filter pages…'; filter.setAttribute('aria-label', 'Filter changed pages');
      filter.addEventListener('input', function(){
        var q = filter.value.toLowerCase();
        rows.forEach(function(r){ r.el.style.display = !q || r.title.toLowerCase().indexOf(q) !== -1 ? '' : 'none'; });
      });
      wrap.appendChild(filter);
    }
    function addSection(label, items, render){
      if(!items.length) return;
      var h = document.createElement('div'); h.className = 'diff-section-head'; h.textContent = label;
      wrap.appendChild(h);
      items.forEach(function(it){ var el = render(it); wrap.appendChild(el); rows.push({el: el, title: it.currentTitle || it.title || ''}); });
    }
    addSection('Created since this snapshot (' + diff.removed.length + ')', diff.removed, function(it){
      var row = document.createElement('div'); row.className = 'diff-page-row removed';
      row.textContent = it.title || '(untitled)';
      return row;
    });
    addSection('Not in your notebook now (' + diff.restored.length + ')', diff.restored, function(it){
      var row = document.createElement('div'); row.className = 'diff-page-row restored';
      var t = document.createElement('span'); t.textContent = it.title || '(untitled)';
      var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'diff-action'; btn.textContent = 'Bring this page back';
      btn.onclick = function(){ if(restorePageFromSnapshot(snap, it.id)){ closeVersionDiff(); closeVersions(); } };
      row.appendChild(t); row.appendChild(btn);
      return row;
    });
    addSection('Changed (' + diff.modified.length + ')', diff.modified, function(it){
      var row = document.createElement('div'); row.className = 'diff-page-row modified';
      var head = document.createElement('div'); head.className = 'diff-page-head';
      var label = document.createElement('span');
      label.textContent = (it.currentTitle || '(untitled)') + (it.titleChanged ? ' (was “' + (it.snapshotTitle || '') + '”)' : '') +
        ' — ' + it.blocks.length + ' line' + (it.blocks.length===1?'':'s') + ' changed';
      head.appendChild(label);
      if(!opts.pageId){
        var pbtn = document.createElement('button'); pbtn.type = 'button'; pbtn.className = 'diff-action'; pbtn.textContent = 'Restore this page';
        pbtn.onclick = function(ev){
          ev.stopPropagation();
          if(!confirm('Replace “' + (it.currentTitle || 'this page') + '” with its version from ' + new Date(entry.ts).toLocaleString() + '? Everything else stays as it is.')) return;
          if(restorePageFromSnapshot(snap, it.id)){ closeVersionDiff(); closeVersions(); }
        };
        head.appendChild(pbtn);
      }
      var body = document.createElement('div'); body.className = 'diff-block-list'; body.style.display = opts.pageId ? '' : 'none';
      it.blocks.slice(0, 200).forEach(function(b){
        var bRow = document.createElement('div'); bRow.className = 'diff-block-row';
        var oldEl = document.createElement('div'); oldEl.className = 'diff-old';
        var newEl = document.createElement('div'); newEl.className = 'diff-new';
        if(b.snapshot === null) oldEl.textContent = '(added since snapshot)'; else if(b.current === null) fillWordDiff(oldEl, [{t: truncateForDiff(b.snapshot, 300)}], 'wd-del');
        if(b.current === null) newEl.textContent = '(removed since snapshot)'; else if(b.snapshot === null) fillWordDiff(newEl, [{t: truncateForDiff(b.current, 300)}], 'wd-ins');
        if(b.snapshot !== null && b.current !== null) fillWordDiffPair(oldEl, newEl, truncateForDiff(b.snapshot, 300), truncateForDiff(b.current, 300));
        bRow.appendChild(oldEl); bRow.appendChild(newEl);
        if(b.snapshot !== null && b.current !== null){
          var useBtn = document.createElement('button'); useBtn.type = 'button'; useBtn.className = 'diff-action diff-line-btn'; useBtn.textContent = 'Use the snapshot’s line';
          useBtn.onclick = function(){
            if(restoreLineFromSnapshot(snap, b.id)){ useBtn.disabled = true; useBtn.textContent = '✓ Restored'; }
          };
          bRow.appendChild(useBtn);
        }
        body.appendChild(bRow);
      });
      if(it.blocks.length > 200){ var more = document.createElement('div'); more.className = 'v-meta'; more.textContent = '…and ' + (it.blocks.length - 200) + ' more lines. Restore the page to bring them all back.'; body.appendChild(more); }
      head.addEventListener('click', function(){ body.style.display = body.style.display === 'none' ? '' : 'none'; });
      row.appendChild(head); row.appendChild(body);
      return row;
    });
  });
}
function closeVersionDiff(){
  document.getElementById('diff-overlay').style.display = 'none';
}

/* ---- Version history list ---- */
var versionsView = {pageId: null};
function formatBytes(n){
  n = n || 0;
  if(n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if(n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}
var VERSION_KIND_LABEL = {auto:'Automatic', safety:'Safety copy', sync:'Before a sync', manual:'Saved by you', backup:'Backup'};
function setVersionsChrome(pageTitle){
  var title = document.getElementById('versions-title');
  title.textContent = pageTitle ? 'History of “' + pageTitle + '”' : 'Version history';
  document.getElementById('versions-toolbar').style.display = pageTitle ? 'none' : '';
}
function versionMessage(text){
  var d = document.createElement('div'); d.className = 'version-empty'; d.textContent = text; return d;
}
function buildVersionRow(entry){
  var row = document.createElement('div');
  row.className = 'version-item';
  var main = document.createElement('div'); main.className = 'v-main';
  var line1 = document.createElement('div'); line1.className = 'v-line1';
  var when = document.createElement('span'); when.className = 'v-when'; when.textContent = new Date(entry.ts).toLocaleString();
  var nameEl = document.createElement('span'); nameEl.className = 'v-name';
  line1.appendChild(when); line1.appendChild(nameEl);
  var meta = document.createElement('div'); meta.className = 'v-meta';
  var badge = document.createElement('span'); badge.className = 'v-badge v-badge-' + versionKind(entry); badge.textContent = VERSION_KIND_LABEL[versionKind(entry)] || 'Snapshot';
  meta.appendChild(badge);
  var bits = [entry.reason || ''];
  if(entry.pages != null) bits.push(entry.pages + ' page' + (entry.pages === 1 ? '' : 's') + ' · ' + entry.blocks + ' lines');
  if(versionSize(entry)) bits.push(formatBytes(versionSize(entry)) + (entry.enc ? ' (encrypted)' : ''));
  meta.appendChild(document.createTextNode(' ' + bits.filter(Boolean).join(' · ')));
  main.appendChild(line1); main.appendChild(meta);
  resolveVersionName(entry).then(function(n){ if(n){ nameEl.textContent = ' — ' + n; } });

  var actions = document.createElement('div'); actions.className = 'version-actions';
  function btn(label, title, fn, cls){
    var b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.title = title; b.setAttribute('aria-label', title);
    if(cls) b.className = cls; b.onclick = fn; actions.appendChild(b); return b;
  }
  btn('Compare', 'Compare this snapshot with what is open now', function(){ openVersionDiff(entry); });
  btn('Restore', 'Replace the whole notebook with this snapshot', function(){ restoreFromVersion(entry); });
  btn(entry.pinned ? '📌' : '📍', entry.pinned ? 'Pinned — never deleted automatically. Click to unpin' : 'Pin: never delete this snapshot automatically', function(){
    setVersionPinned(entry.ts, !entry.pinned).then(refreshVersionsList);
  }, entry.pinned ? 'v-pinned' : '');
  btn('✎', 'Name this snapshot (named snapshots are kept)', function(){
    resolveVersionName(entry).then(function(cur){
      var n = prompt('Name this snapshot (leave empty to remove the name):', cur);
      if(n === null) return;
      setVersionName(entry.ts, n).then(refreshVersionsList);
    });
  });
  btn('🗑', 'Delete this snapshot', function(){
    if(!confirm('Delete this snapshot? This cannot be undone.')) return;
    deleteVersion(entry.ts).then(refreshVersionsList);
  });
  row.appendChild(main); row.appendChild(actions);
  return row;
}
function refreshVersionsList(){
  var wrap = document.getElementById('versions-list');
  loadVersions().then(function(list){
    var filter = document.getElementById('versions-filter').value;
    list = list.slice().reverse().filter(function(v){
      if(filter === 'pinned') return versionIsProtected(v);
      if(filter === 'safety') return versionKind(v) === 'safety' || versionKind(v) === 'sync';
      return true;
    });
    wrap.textContent = '';
    if(!list.length){
      wrap.appendChild(versionMessage(filter === 'all'
        ? 'No snapshots yet — Nexus takes one automatically about once a day, before every restore, big replace or sync that would overwrite your edits. You can also save one yourself above.'
        : 'No snapshots match this filter.'));
      return;
    }
    list.forEach(function(entry){ wrap.appendChild(buildVersionRow(entry)); });
  });
}
function openVersions(){
  versionsView = {pageId: null};
  setVersionsChrome(null);
  document.getElementById('versions-overlay').style.display = 'flex';
  refreshVersionsList();
}
function createManualSnapshot(){
  var input = document.getElementById('versions-name-input');
  var name = (input.value || '').trim();
  snapshotVersion(name ? 'Saved snapshot' : 'Manual snapshot', {kind:'manual', name: name, force: true}).then(function(ts){
    input.value = '';
    if(ts){ toast('Snapshot saved.'); } else { toast('Could not save a snapshot on this device.'); }
    refreshVersionsList();
  });
}
function closeVersions(){
  versionsView = {pageId: null};
  document.getElementById('versions-overlay').style.display = 'none';
}

/* ---- Page history: every earlier version of ONE page found in the stored snapshots ---- */
function pageOutlineText(s, pageId){
  var p = s.pages && s.pages[pageId];
  if(!p) return null;
  var out = [], seen = {};
  function walk(id, depth){
    var b = s.blocks && s.blocks[id];
    if(!b || seen[id]) return;
    seen[id] = true;
    out.push(new Array(depth + 1).join('  ') + (b.text || ''));
    (b.children || []).forEach(function(c){ walk(c, depth + 1); });
  }
  (p.rootBlocks || []).forEach(function(id){ walk(id, 0); });
  return (p.title || '') + '\n' + out.join('\n');
}
function openPageHistory(pageId){
  var page = state.pages[pageId];
  if(!page) return;
  versionsView = {pageId: pageId};
  setVersionsChrome(page.title || 'Untitled');
  var wrap = document.getElementById('versions-list');
  wrap.textContent = '';
  var progress = versionMessage('Reading your snapshots…'); wrap.appendChild(progress);
  document.getElementById('versions-overlay').style.display = 'flex';
  var currentSig = pageOutlineText(state, pageId);
  loadVersions().then(function(list){
    list = list.slice().reverse();
    var rows = [], i = 0;
    function next(){
      if(i >= list.length || versionsView.pageId !== pageId) return Promise.resolve();
      var entry = list[i++];
      progress.textContent = 'Reading snapshot ' + i + ' of ' + list.length + '…';
      return getVersionData(entry).then(function(json){
        var sig = pageOutlineText(parseSnapshotJson(json), pageId);
        if(sig !== null) rows.push({entry: entry, sig: sig});
      }, function(){ /* unreadable snapshot: skip it */ }).then(next);
    }
    return next().then(function(){
      if(versionsView.pageId !== pageId) return;
      wrap.textContent = '';
      /* Consecutive snapshots in which the page looked the same are one version. */
      var groups = [];
      rows.forEach(function(r){
        var g = groups[groups.length - 1];
        if(g && g.sig === r.sig){ g.count++; } else { groups.push({entry: r.entry, sig: r.sig, count: 1}); }
      });
      if(!groups.length){ wrap.appendChild(versionMessage('This page is not in any snapshot yet — snapshots are taken about once a day and before big changes.')); return; }
      groups.forEach(function(g){
        var same = g.sig === currentSig;
        var row = document.createElement('div'); row.className = 'version-item';
        var main = document.createElement('div'); main.className = 'v-main';
        var line1 = document.createElement('div'); line1.className = 'v-line1';
        var when = document.createElement('span'); when.className = 'v-when'; when.textContent = new Date(g.entry.ts).toLocaleString();
        line1.appendChild(when);
        var meta = document.createElement('div'); meta.className = 'v-meta';
        var badge = document.createElement('span'); badge.className = 'v-badge ' + (same ? 'v-badge-same' : 'v-badge-diff'); badge.textContent = same ? 'Same as now' : 'Different from now';
        meta.appendChild(badge);
        meta.appendChild(document.createTextNode(' ' + (g.sig.split('\n').length - 1) + ' lines' + (g.count > 1 ? ' · same in ' + g.count + ' snapshots' : '')));
        main.appendChild(line1); main.appendChild(meta);
        var actions = document.createElement('div'); actions.className = 'version-actions';
        if(!same){
          var cmp = document.createElement('button'); cmp.type = 'button'; cmp.textContent = 'Compare';
          cmp.onclick = function(){ openVersionDiff(g.entry, {pageId: pageId}); };
          var res = document.createElement('button'); res.type = 'button'; res.textContent = 'Restore this version';
          res.onclick = function(){
            if(!confirm('Replace this page with its version from ' + new Date(g.entry.ts).toLocaleString() + '? Everything else stays as it is.')) return;
            getVersionData(g.entry).then(function(json){
              if(restorePageFromSnapshot(parseSnapshotJson(json), pageId)) closeVersions();
            }).catch(function(){ toast('That snapshot could not be read.'); });
          };
          actions.appendChild(cmp); actions.appendChild(res);
        }
        row.appendChild(main); row.appendChild(actions); wrap.appendChild(row);
      });
    });
  });
}


/* ============================================================
   SYNC CONFLICTS
   A local, device-only log of lines/pages where two devices edited
   the same thing differently between syncs, or where a deletion on one
   device beat an edit on another (see mergeStates). Kept in its own
   IndexedDB record — encrypted when a passcode is set — so it never
   travels through Sync itself; only the inline `.conflict` flag on
   the affected block does, which is what makes it visible on the
   other device too.
   ============================================================ */
var CONFLICTS_KEY = STORAGE_KEY + '_conflicts'; /* legacy plaintext location — migrated into IndexedDB (encrypted when a passcode is set) and removed */
var CONFLICTS_REC = 'conflicts';
var CONFLICTS_MAX = 200;
var conflictsCache = [];
/* The log holds snippets of your notes (what was kept, what was dropped), so it gets the same at-rest
   treatment as the notebook itself — it used to sit in plaintext localStorage even with a passcode set.
   Reads are served from memory; every change is written through to IndexedDB. */
function loadConflicts(){ return conflictsCache; }
function readConflictsRecord(){
  return openAttachmentDb().then(function(db){
    return new Promise(function(resolve, reject){
      var req = db.transaction(NB_STORE, 'readonly').objectStore(NB_STORE).get(CONFLICTS_REC);
      req.onsuccess = function(){ resolve(req.result === undefined ? null : req.result); };
      req.onerror = function(){ reject(req.error); };
    });
  });
}
/* Resolves true once the current log is safely stored. */
function persistConflicts(){
  var json = JSON.stringify(conflictsCache);
  if(isLockEnabled()){
    if(!lockCryptoKey) return Promise.resolve(false);
    return encryptWithKey(lockCryptoKey, json).then(function(enc){
      return idbPutRaw(NB_STORE, {enc: true, iv: enc.iv, ct: enc.ct}, CONFLICTS_REC);
    }).then(function(){ return true; }, function(){ return false; });
  }
  return idbPutRaw(NB_STORE, json, CONFLICTS_REC).then(function(){ return true; }, function(){ return false; });
}
function initConflictsStore(){
  return readConflictsRecord().then(function(rec){
    if(!rec) return null;
    if(typeof rec === 'string') return JSON.parse(rec);
    if(rec.enc && lockCryptoKey) return decryptWithKey(lockCryptoKey, {iv: rec.iv, ct: rec.ct}).then(function(t){ return JSON.parse(t); });
    return null;
  }).catch(function(){ return null; }).then(function(list){
    if(!Array.isArray(list)) list = [];
    var legacy = null, hadLegacy = false;
    try{ var raw = localStorage.getItem(CONFLICTS_KEY); if(raw !== null){ hadLegacy = true; legacy = JSON.parse(raw); } }catch(e){}
    if(Array.isArray(legacy)){
      var ids = {}; list.forEach(function(c){ ids[c.id] = true; });
      legacy.forEach(function(c){ if(c && !ids[c.id]) list.push(c); });
      list.sort(function(a,b){ return (b.detectedAt||0) - (a.detectedAt||0); });
    }
    if(list.length > CONFLICTS_MAX) list.length = CONFLICTS_MAX;
    conflictsCache = list;
    updateConflictsBadge();
    if(hadLegacy){
      return persistConflicts().then(function(ok){
        if(ok){ try{ localStorage.removeItem(CONFLICTS_KEY); }catch(e){} }
      });
    }
  });
}
function saveConflictsList(list){
  conflictsCache = list;
  persistConflicts();
}
function recordConflicts(newOnes, peerLabel){
  if(!newOnes || !newOnes.length) return;
  var list = loadConflicts().slice();
  newOnes.forEach(function(c){
    var dup = list.some(function(x){ return x.kind === c.kind && x.entityId === c.entityId && x.keptText === c.keptText && x.droppedText === c.droppedText; });
    if(dup) return;
    c.id = uid();
    c.detectedAt = Date.now();
    c.peerLabel = peerLabel;
    list.unshift(c);
  });
  if(list.length > CONFLICTS_MAX) list.length = CONFLICTS_MAX;
  saveConflictsList(list);
  updateConflictsBadge();
}
function updateConflictsBadge(){
  var btn = document.getElementById('btn-conflicts');
  if(!btn) return;
  var n = loadConflicts().length;
  btn.textContent = '⚠ Sync conflicts';
  if(n){
    var badge = document.createElement('span');
    badge.className = 'conflict-badge';
    badge.textContent = n;
    btn.appendChild(badge);
  }
  btn.style.display = n ? '' : 'none';
}
/* Snapshot the notebook before a sync merge that would overwrite or remove something edited on this
   device, or that found conflicts — so nothing a sync does to your edits is unrecoverable. (Ordinary
   catching-up on a peer's edits, where nothing here changed since the last sync, needs no copy.) */
var lastSyncSnapshotAt = 0;
function syncSafetySnapshot(result, peerLabel){
  var st = (result && result.stats) || {};
  var hasConflicts = !!(result && result.conflicts && result.conflicts.length);
  if(!(st.localLoss > 0 || hasConflicts)) return Promise.resolve(null);
  var now = Date.now();
  if(!hasConflicts && now - lastSyncSnapshotAt < 10*60*1000) return Promise.resolve(null);
  lastSyncSnapshotAt = now;
  return snapshotVersion('Before sync with ' + peerLabel, {kind:'sync'});
}
function clearBlockConflictFlag(entityId){
  var b = state.blocks[entityId];
  if(b && b.conflict){ delete b.conflict; save(); renderPage(); }
}
function openConflicts(){
  renderConflictsList();
  document.getElementById('conflicts-overlay').style.display = 'flex';
}
function closeConflicts(){
  document.getElementById('conflicts-overlay').style.display = 'none';
}
var CONFLICT_KIND_LABEL = {
  'line': 'Line edited on two devices',
  'page': 'Page title changed on two devices',
  'properties': 'Page properties changed on two devices',
  'line-deleted': 'Line deleted on one device, edited on another'
};
function conflictColumn(label, cls){
  var col = document.createElement('div');
  col.className = 'conflict-version' + (cls ? ' ' + cls : '');
  var l = document.createElement('div'); l.className = 'cv-label'; l.textContent = label;
  var body = document.createElement('div'); body.className = 'cv-body';
  col.appendChild(l); col.appendChild(body);
  return {el: col, body: body};
}
function finishConflict(c, message){
  saveConflictsList(loadConflicts().filter(function(x){ return x.id !== c.id; }));
  updateConflictsBadge();
  renderConflictsList();
  if(message) toast(message);
}
function conflictCurrentText(c){
  if(c.kind === 'line'){ var b = state.blocks[c.entityId]; return b ? b.text : null; }
  if(c.kind === 'page'){ var p = state.pages[c.pageId]; return p ? p.title : null; }
  return undefined;
}
function renderConflictsList(){
  var list = loadConflicts();
  var wrap = document.getElementById('conflicts-list');
  wrap.textContent = '';
  if(!list.length){
    var empty = document.createElement('div'); empty.className = 'version-empty'; empty.textContent = 'No sync conflicts — nice and quiet.';
    wrap.appendChild(empty);
    return;
  }
  list.forEach(function(c){
    var item = document.createElement('div');
    item.className = 'conflict-item';

    var meta = document.createElement('div');
    meta.className = 'conflict-meta';
    meta.textContent = (CONFLICT_KIND_LABEL[c.kind] || 'Conflict') + ' — “' + c.pageTitle + '”, syncing with ' +
      (c.peerLabel || 'another device') + ', ' + timeAgo(c.detectedAt);
    item.appendChild(meta);

    var versions = document.createElement('div');
    versions.className = 'conflict-versions';
    var isDeleted = c.kind === 'line-deleted';
    var kept = conflictColumn(isDeleted ? 'What happened' : 'Kept (newer edit)', 'kept');
    var dropped = conflictColumn(isDeleted ? 'Your edit, lost in the sync' : 'Dropped (older edit)');
    if(isDeleted){
      kept.body.textContent = c.keptText || '(deleted)';
      dropped.body.textContent = c.droppedText || '(empty)';
    } else {
      var d = wordDiffParts(c.keptText || '', c.droppedText || '');
      fillWordDiff(kept.body, d.a, 'wd-diff');
      fillWordDiff(dropped.body, d.b, 'wd-diff');
    }
    versions.appendChild(kept.el); versions.appendChild(dropped.el);
    var now = conflictCurrentText(c);
    var stale = (c.kind === 'line' || c.kind === 'page') && now !== undefined && now !== null && now !== c.keptText;
    if(stale){
      var cur = conflictColumn('Now (changed since the sync)', 'current');
      cur.body.textContent = now;
      versions.appendChild(cur.el);
    }
    item.appendChild(versions);

    var actions = document.createElement('div');
    actions.className = 'conflict-actions';
    function action(label, fn){
      var b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.onclick = fn; actions.appendChild(b); return b;
    }
    if(isDeleted){
      action('Restore as a new line', function(){ restoreDeletedLine(c, c.droppedText); });
      action('Leave it deleted', function(){ dismissConflict(c.id); });
    } else {
      action('Keep what\'s here', function(){ dismissConflict(c.id); });
      action(c.kind === 'page' ? 'Use the other title' : c.kind === 'properties' ? 'Use the other properties' : 'Use the other version', function(){ useDroppedInsteadOfKept(c); });
      if(c.kind === 'line') action('Keep both (add as new line)', function(){ restoreDroppedConflict(c); });
      action('Dismiss', function(){ dismissConflict(c.id); });
    }
    item.appendChild(actions);

    /* Combine by hand: one editable box, so both edits can be merged into whatever the line should say. */
    if(c.kind === 'line' || isDeleted){
      var block = c.kind === 'line' ? state.blocks[c.entityId] : null;
      if(c.kind === 'line' && !block){ /* the line is gone: nothing to combine into */ }
      else {
        var det = document.createElement('details'); det.className = 'conflict-merge';
        var sum = document.createElement('summary'); sum.textContent = 'Combine by hand';
        var ta = document.createElement('textarea'); ta.rows = 3; ta.value = c.kind === 'line' ? (block.text || '') : (c.droppedText || '');
        ta.setAttribute('aria-label', 'Combined text');
        var apply = document.createElement('button'); apply.type = 'button';
        apply.textContent = isDeleted ? 'Restore this text as a new line' : 'Save combined text';
        apply.onclick = function(){ if(isDeleted) restoreDeletedLine(c, ta.value); else applyMergedConflictText(c, ta.value); };
        det.appendChild(sum); det.appendChild(ta); det.appendChild(apply);
        item.appendChild(det);
      }
    }
    wrap.appendChild(item);
  });
}
function applyMergedConflictText(c, text){
  var b = state.blocks[c.entityId];
  if(!b){ toast('That line no longer exists — nothing to change.'); return; }
  b.text = text;
  delete b.conflict;
  save(); renderPage();
  finishConflict(c, 'Saved your combined text.');
}
/* A line that was edited on this device but deleted elsewhere: put its text back as a new line on the
   same page, or — if that page is gone too — on a "Recovered from sync" page. */
function restoreDeletedLine(c, text){
  var page = state.pages[c.pageId];
  if(!page || page.trashedAt) page = resolvePage('Recovered from sync', 'page');
  var id = uid();
  state.blocks[id] = mkBlock(id, page.id, null, text || '');
  page.rootBlocks.push(id);
  save();
  renderAll();
  finishConflict(c, 'Restored the line' + (page.title === 'Recovered from sync' ? ' on “Recovered from sync”.' : '.'));
  revealBlock(id);
}
/* "Use the other version" — overwrites the kept text/title/properties with the dropped one, in place. If the
   line was changed again since the sync, ask first: this would overwrite that newer edit. */
function useDroppedInsteadOfKept(c){
  if(c.kind === 'line'){
    var b = state.blocks[c.entityId];
    if(!b){ toast('That line no longer exists — nothing to switch.'); return; }
    if(b.text !== c.keptText && !confirm('This line has been changed since the sync. Replace its current text with the other version?')) return;
    b.text = c.droppedText;
    delete b.conflict;
    save(); renderPage();
  } else if(c.kind === 'page'){
    var p = state.pages[c.pageId];
    if(!p){ toast('That page no longer exists — nothing to switch.'); return; }
    if(p.title !== c.keptText && !confirm('This page has been renamed since the sync. Replace its current title with the other one?')) return;
    var oldTitle = p.title;
    p.title = c.droppedText;
    if(state.titleIndex[oldTitle.toLowerCase()] === p.id) delete state.titleIndex[oldTitle.toLowerCase()];
    state.titleIndex[p.title.toLowerCase()] = p.id;
    renameCascade(oldTitle, p.title);
    save(); renderAll();
  } else if(c.kind === 'properties'){
    var pp = state.pages[c.pageId];
    if(!pp){ toast('That page no longer exists — nothing to switch.'); return; }
    pp.properties = JSON.parse(JSON.stringify(c.droppedProps || []));
    save(); renderAll();
  }
  finishConflict(c, 'Switched to the other version.');
}
function dismissConflict(id){
  var list = loadConflicts();
  var entry = list.filter(function(c){ return c.id === id; })[0];
  saveConflictsList(list.filter(function(c){ return c.id !== id; }));
  if(entry && entry.kind === 'line') clearBlockConflictFlag(entry.entityId);
  renderConflictsList();
  updateConflictsBadge();
}
function dismissAllConflicts(){
  var list = loadConflicts();
  var touched = false;
  list.forEach(function(c){
    if(c.kind === 'line'){
      var b = state.blocks[c.entityId];
      if(b && b.conflict){ delete b.conflict; touched = true; }
    }
  });
  saveConflictsList([]);
  if(touched){ save(); renderPage(); }
  renderConflictsList();
  updateConflictsBadge();
}
function restoreDroppedConflict(c){
  var winnerBlock = state.blocks[c.entityId];
  if(!winnerBlock){ toast('That line no longer exists — nothing to attach the recovered text to.'); return; }
  delete winnerBlock.conflict;
  var nb = createBlockAfter(winnerBlock, c.droppedText);
  save(); renderPage();
  finishConflict(c, 'Recovered the other version as a new line.');
  revealBlock(nb.id);
}
document.getElementById('btn-conflicts').onclick = openConflicts;
document.getElementById('conflicts-overlay').addEventListener('click', function(e){
  if(e.target.id === 'conflicts-overlay') closeConflicts();
});
document.getElementById('conflicts-dismiss-all').onclick = dismissAllConflicts;

function maybeAutoSnapshot(){
  loadVersions().then(function(list){
    var autos = list.filter(function(v){ return versionKind(v) === 'auto'; });
    var last = autos.length ? autos[autos.length-1] : null;
    var oneDay = 24*60*60*1000;
    if(!last || Date.now() - last.ts > oneDay){
      snapshotVersion('Daily snapshot', {kind:'auto'});
    }
  });
}

function updateBackupBanner(){
  var meta = loadMeta();
  var banner = document.getElementById('backup-banner');
  var textEl = document.getElementById('backup-banner-text');
  var hintEl = document.getElementById('last-backup-hint');
  var now = Date.now();
  var days = meta.lastBackupAt ? Math.floor((now - meta.lastBackupAt) / (24*60*60*1000)) : null;

  hintEl.textContent = meta.lastBackupAt
    ? 'Last backup: ' + new Date(meta.lastBackupAt).toLocaleDateString()
    : 'No backup taken yet';

  var reminderSetting = (typeof currentSettings !== 'undefined' && currentSettings.backupReminderDays) || '7';
  if(reminderSetting === 'never'){
    banner.classList.remove('visible');
    return;
  }
  var reminderDays = parseInt(reminderSetting, 10) || 7;
  var overdue = days === null || days >= reminderDays;
  var snoozed = meta.snoozeUntil && now < meta.snoozeUntil;
  if(overdue && !snoozed){
    textEl.textContent = days === null
      ? "You haven't downloaded a backup yet — it only takes a click."
      : "It's been " + days + " days since your last backup.";
    banner.classList.add('visible');
  } else {
    banner.classList.remove('visible');
  }
}

document.getElementById('banner-backup-now').onclick = backup;
document.getElementById('banner-dismiss').onclick = function(){
  var meta = loadMeta();
  meta.snoozeUntil = Date.now() + (24*60*60*1000);
  saveMeta(meta);
  updateBackupBanner();
};
document.getElementById('btn-versions').onclick = openVersions;
document.getElementById('versions-overlay').addEventListener('click', function(e){
  if(e.target.id === 'versions-overlay') closeVersions();
});
document.getElementById('diff-overlay').addEventListener('click', function(e){
  if(e.target.id === 'diff-overlay') closeVersionDiff();
});
document.getElementById('diff-close-btn').onclick = closeVersionDiff;

var SIDEBAR_KEY = STORAGE_KEY + '_sidebar';

document.getElementById('versions-create-btn').onclick = createManualSnapshot;
document.getElementById('versions-name-input').addEventListener('keydown', function(e){ if(e.key === 'Enter'){ e.preventDefault(); createManualSnapshot(); } });
document.getElementById('versions-filter').addEventListener('change', refreshVersionsList);
document.getElementById('btn-page-history').onclick = function(){ if(state && state.currentPageId) openPageHistory(state.currentPageId); };
