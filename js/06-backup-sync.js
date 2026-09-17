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
var META_KEY = STORAGE_KEY + '_meta';
var MAX_VERSIONS = 5;

function loadMeta(){
  try{ return JSON.parse(localStorage.getItem(META_KEY)) || {}; }catch(e){ return {}; }
}
function saveMeta(meta){
  try{ localStorage.setItem(META_KEY, JSON.stringify(meta)); }catch(e){}
}

/* Version snapshots are full copies of the entire notebook (see
   snapshotVersion below), so — unlike everything else that shares
   localStorage's ~5-10MB budget — they live in their own IndexedDB
   object store, right alongside attachments. Up to MAX_VERSIONS
   snapshots of a large notebook would otherwise multiply the
   localStorage footprint several times over for no benefit, and
   IndexedDB has effectively no comparable ceiling. All access is
   necessarily async now; call sites use .then() rather than reading
   the list synchronously. */
var VERS_STORE = "versions";
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
/* Same at-rest treatment as the notebook JSON and attachments: when a
   passcode is set, entry.data (the full-notebook JSON string) is AES-GCM
   encrypted under the DEK before being written, and {ts, reason} stay in
   the clear so the versions list can render without decrypting anything.
   Callers of getVersionData() never see the difference. */
function putVersion(entry){
  return openAttachmentDb().then(function(db){
    function write(payload){
      return new Promise(function(resolve, reject){
        var tx = db.transaction(VERS_STORE, 'readwrite');
        tx.objectStore(VERS_STORE).put(payload);
        tx.oncomplete = function(){ resolve(); };
        tx.onerror = function(){ reject(tx.error); };
      });
    }
    if(lockCryptoKey){
      return encryptWithKey(lockCryptoKey, entry.data).then(function(enc){
        return write({ts: entry.ts, reason: entry.reason, enc: true, iv: enc.iv, ct: enc.ct});
      });
    }
    return write(entry);
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
function snapshotVersion(reason){
  var entry = {ts: Date.now(), reason: reason, data: JSON.stringify(state)};
  return putVersion(entry).then(function(){
    return loadVersions();
  }).then(function(list){
    var excess = list.length - MAX_VERSIONS;
    if(excess <= 0) return;
    var toDrop = list.slice(0, excess); // oldest first
    return Promise.all(toDrop.map(function(v){ return deleteVersion(v.ts); }));
  }).catch(function(){ /* IndexedDB unavailable — snapshot silently skipped, same as attachments do */ });
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
  snapshotVersion('manual backup');
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
var GDRIVE_AUTH_SESSION_KEY = STORAGE_KEY + '_gdrive_auth_session';
var GDRIVE_SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file';

function gdriveAuthSessionValid(){
  var raw = null;
  try{ raw = localStorage.getItem(GDRIVE_AUTH_SESSION_KEY); }catch(e){}
  var ts = parseInt(raw, 10);
  if(!ts) return false;
  var hours = (typeof currentSettings !== 'undefined' && currentSettings.reauthInterval) || '24';
  hours = parseInt(hours, 10);
  if(hours !== 1 && hours !== 6 && hours !== 12 && hours !== 24) hours = 24;
  return Date.now() - ts < hours * 60 * 60 * 1000;
}
function markGdriveAuthSession(){
  try{ localStorage.setItem(GDRIVE_AUTH_SESSION_KEY, String(Date.now())); }catch(e){}
}

function gdriveCredentialsConfigured(){
  return GOOGLE_DRIVE_CLIENT_ID && GOOGLE_DRIVE_CLIENT_ID.indexOf('YOUR_OAUTH_CLIENT_ID') === -1
      && GOOGLE_DRIVE_API_KEY && GOOGLE_DRIVE_API_KEY.indexOf('YOUR_API_KEY') === -1;
}

/* Returns true (and shows an explanation) if this page can't do Google
   OAuth from where it's currently running — i.e. opened as a local file. */
function gdriveBlockedByOrigin(){
  if(location.protocol === 'file:'){
    alert('Google Drive import/export needs Nexus to be opened over http(s), not as a local file.\n\n' +
          'Google\'s sign-in won\'t authorize a page opened directly from disk (a file:// address). ' +
          'Host this file somewhere simple — GitHub Pages, Netlify, Vercel, or even "python3 -m http.server" ' +
          'on your own machine for local testing — then open it from that http(s) address instead.\n\n' +
          'Your backup/restore still work as before, just via the regular file-picker buttons.');
    return true;
  }
  return false;
}

function gdriveEnsurePicker(cb){
  if(gdrivePickerLoaded){ cb(); return; }
  gapi.load('picker', function(){ gdrivePickerLoaded = true; cb(); });
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
   called once gdriveAccessToken is set. */
function gdriveWithToken(onReady){
  if(gdriveBlockedByOrigin()) return;
  if(!gdriveCredentialsConfigured()){
    alert('Google Drive import/export needs a Client ID and API key from Google Cloud Console first. See the setup notes for this feature.');
    return;
  }
  if(!window.google || !google.accounts || !google.accounts.oauth2){
    toast('Google sign-in is still loading — try again in a moment.');
    return;
  }
  var needsInteractive = !gdriveAuthSessionValid();
  function requestToken(promptMode, allowConsentFallback){
    var finish = function(resp){
      if(resp.error){
        if(allowConsentFallback){ requestToken('consent', false); return; }
        toast('Google Drive sign-in was cancelled or failed.');
        return;
      }
      gdriveAccessToken = resp.access_token;
      if(promptMode === 'consent') markGdriveAuthSession();
      onReady();
    };
    if(!gdriveTokenClient){
      gdriveTokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_DRIVE_CLIENT_ID,
        scope: GDRIVE_SCOPES,
        callback: finish
      });
    } else {
      gdriveTokenClient.callback = finish;
    }
    try{ gdriveTokenClient.requestAccessToken({ prompt: promptMode }); }
    catch(e){
      if(allowConsentFallback){ requestToken('consent', false); return; }
      toast('Google Drive sign-in was cancelled or failed.');
    }
  }
  /* Reuse a token that is already live in this page. Otherwise, while the
     selected interval is still valid, ask Google for a fresh token silently.
     Only an expired Nexus auth window is allowed to start interactive sign-in. */
  if(!needsInteractive && gdriveAccessToken){
    onReady();
    return;
  }
  requestToken(needsInteractive ? 'consent' : '', false);
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
    snapshotVersion('manual backup (Google Drive)');
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

/* Acquires an access token without ever showing a consent popup —
   used for background/periodic attempts so a stale session doesn't
   nag the person with sign-in windows they didn't ask for right now.
   Only the explicit "On" click (enableGdriveAutoSync) uses the
   interactive version, gdriveWithToken. */
function gdriveGetTokenSilently(onReady, onFail){
  if(typeof gdriveAuthSessionValid === 'function' && !gdriveAuthSessionValid()){ onFail && onFail(); return; }
  if(gdriveAccessToken){ onReady(); return; }
  if(!window.google || !google.accounts || !google.accounts.oauth2){ onFail && onFail(); return; }
  if(!gdriveTokenClient){
    gdriveTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_DRIVE_CLIENT_ID,
      scope: GDRIVE_SCOPES,
      callback: function(resp){
        if(resp.error){ onFail && onFail(); return; }
        gdriveAccessToken = resp.access_token;
        onReady();
      }
    });
  } else {
    gdriveTokenClient.callback = function(resp){
      if(resp.error){ onFail && onFail(); return; }
      gdriveAccessToken = resp.access_token;
      onReady();
    };
  }
  try{ gdriveTokenClient.requestAccessToken({ prompt: '' }); }
  catch(e){ onFail && onFail(); }
}

/* Only called from an interactive click (enableGdriveAutoSync,
   gdriveSyncNow) — never from the silent periodic tick — since it may
   show a confirm()/prompt(). Resolves 'plain', 'encrypted', or
   'cancelled'. Once resolved 'encrypted' or 'plain' this session, it
   won't ask again unless the passcode turns out to be wrong. */
function ensureGdriveSyncMode(){
  if(!isLockEnabled() || gdriveSyncEncryptionDeclined) return Promise.resolve('plain');
  if(gdriveSyncPasscode && typeof getActivePasscode === 'function' && !getActivePasscode()){
    gdriveSyncPasscode = null;
    gdriveSyncKeyCache = { salt: null, key: null };
  }
  if(gdriveSyncPasscode) return Promise.resolve('encrypted');
  if(!confirm('This notebook has a passcode lock set up.\n\nEncrypt Google Drive sync data with your passcode too?\n\nOK = encrypted (every device you sync with must use this same passcode).\nCancel = keep sync data as plain, readable JSON, same as before.')){
    gdriveSyncEncryptionDeclined = true;
    return Promise.resolve('plain');
  }
  var cachedPasscode = typeof getActivePasscode === 'function' ? getActivePasscode() : null;
  if(cachedPasscode){
    gdriveSyncPasscode = cachedPasscode;
    return Promise.resolve('encrypted');
  }
  var passcode = promptForPasscode('Enter your passcode:');
  if(passcode === null) return Promise.resolve('cancelled');
  return confirmPasscode(passcode).then(function(ok){
    if(!ok){ toast('Incorrect passcode.'); return 'cancelled'; }
    gdriveSyncPasscode = passcode;
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
    });
  });
}

/* One pull -> merge -> push pass. Mirrors handleIncomingLanSync in
   10-lan-sync.js, with Google Drive standing in for a live peer link
   and 'gdrive' as its fixed peer id in state.syncPeers. Does not check
   whether auto-sync is turned on — callers decide that. */
function gdrivePerformSyncCycle(){
  if(!gdriveCredentialsConfigured() || gdriveBlockedByOrigin()) return;
  if(isLockEnabled() && !gdriveSyncEncryptionDeclined){
    var cachedPasscode = typeof getActivePasscode === 'function' ? getActivePasscode() : null;
    if(cachedPasscode) gdriveSyncPasscode = cachedPasscode;
    else if(gdriveSyncPasscode){
      gdriveSyncPasscode = null;
      gdriveSyncKeyCache = { salt: null, key: null };
    }
  }
  gdriveFindSyncFile(function(fileId){
    if(!fileId){ setGdriveAutoSyncStatus('Could not reach the Google Drive sync file — will retry.'); return; }
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
    });
  });
}

/* The periodic/background path: silent-only, never pops a sign-in or
   passcode prompt on its own, and does nothing while the setting is
   off. If the sync file turns out to be encrypted and this session
   hasn't unlocked it yet, gdrivePerformSyncCycle just shows a status
   line asking for a "Sync now" click rather than interrupting. */
function runGdriveSyncCycle(){
  if(!gdriveAutoSyncEnabled()) return;
  if(!gdriveCredentialsConfigured() || gdriveBlockedByOrigin()) return;
  if(!gdriveAuthSessionValid()){
    setGdriveAutoSyncStatus('Needs sign-in — click "Sync now" to reconnect.');
    return;
  }
  if(gdriveAccessToken){ gdrivePerformSyncCycle(); return; }
  gdriveGetTokenSilently(gdrivePerformSyncCycle, function(){
    setGdriveAutoSyncStatus('Needs sign-in — click "On" again to reconnect.');
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
   save, so edits reach Drive quickly rather than waiting for the next
   polling tick — but only if a token is already live, so this never
   itself triggers a sign-in or passcode prompt. If encryption is in
   play but this session hasn't confirmed the passcode yet, this quietly
   skips (the next "Sync now" or periodic tick picks it up once it has). */
function scheduleGdriveAutoPush(){
  if(!gdriveAutoSyncEnabled() || !gdriveAccessToken) return;
  if(isLockEnabled() && !gdriveSyncEncryptionDeclined && !gdriveSyncPasscode) return;
  clearTimeout(gdriveAutoPushTimer);
  gdriveAutoPushTimer = setTimeout(function(){
    var fileId = localStorage.getItem(GDRIVE_SYNC_FILEID_KEY);
    if(!fileId) return;
    gdrivePushSyncState(fileId).then(function(){
      setGdriveAutoSyncStatus('Last synced ' + timeAgo(Date.now()) + '.');
    }).catch(function(){});
  }, 4000);
}

function startGdriveAutoSyncTimer(){
  clearInterval(gdriveAutoSyncTimer);
  gdriveAutoSyncTimer = setInterval(function(){
    if(!document.hidden) runGdriveSyncCycle();
  }, 60000);
}
function stopGdriveAutoSyncTimer(){
  clearInterval(gdriveAutoSyncTimer);
  gdriveAutoSyncTimer = null;
  clearTimeout(gdriveAutoPushTimer);
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

function restoreFromVersion(entry){
  if(!confirm('Load this snapshot from ' + new Date(entry.ts).toLocaleString() + '? This will replace what\'s currently open.')) return;
  snapshotVersion('before version restore');
  getVersionData(entry).then(function(json){
    state = normalizeState(JSON.parse(json));
    save();
    renderAll();
    closeVersions();
    toast('Snapshot loaded.');
  }).catch(function(){ toast('That snapshot could not be read.'); });
}

/* ---- Version diff: a per-page/per-block summary of what a snapshot
   restore would change, computed on demand from the two full-state
   JSON blobs — no separate diff storage needed. This is a summary
   view (which pages/blocks changed), not a character-level text diff. ---- */
function truncateForDiff(s, n){
  s = s || '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function computeVersionDiff(entry){
  return getVersionData(entry).then(function(json){
    var snap;
    try{ snap = JSON.parse(json); }catch(e){ return null; }
    return buildVersionDiff(snap);
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
      changedBlocks.push({current: cText, snapshot: sText});
    });
    var titleChanged = curP.title !== snapP.title;
    if(changedBlocks.length || titleChanged){
      result.modified.push({id:pid, currentTitle:curP.title, titleChanged:titleChanged, blocks:changedBlocks});
    } else {
      result.unchangedCount++;
    }
  });
  return result;
}

function openVersionDiff(entry){
  var wrap = document.getElementById('diff-list');
  document.getElementById('diff-overlay-title').textContent = 'Comparing to ' + new Date(entry.ts).toLocaleString();
  wrap.innerHTML = '<div class="version-empty">Loading…</div>';
  document.getElementById('diff-restore-btn').onclick = function(){ closeVersionDiff(); restoreFromVersion(entry); };
  document.getElementById('diff-overlay').style.display = 'flex';
  computeVersionDiff(entry).then(function(diff){
    wrap.innerHTML = "";
    if(!diff){
      wrap.innerHTML = '<div class="version-empty">That snapshot could not be read.</div>';
    } else if(!diff.removed.length && !diff.restored.length && !diff.modified.length){
      wrap.innerHTML = '<div class="version-empty">No differences — this snapshot matches what\'s currently open.</div>';
    } else {
      var summary = document.createElement('div');
      summary.className = 'diff-summary';
      summary.textContent = diff.modified.length + ' page' + (diff.modified.length===1?'':'s') + ' changed, ' +
        diff.removed.length + ' would be removed, ' + diff.restored.length + ' would come back, ' +
        diff.unchangedCount + ' unchanged if you restore this snapshot.';
      wrap.appendChild(summary);
  
      function addSection(label, items, cls, render){
        if(!items.length) return;
        var h = document.createElement('div'); h.className = 'diff-section-head'; h.textContent = label;
        wrap.appendChild(h);
        items.forEach(function(it){ wrap.appendChild(render(it)); });
      }
  
      addSection('Would be removed (' + diff.removed.length + ')', diff.removed, 'removed', function(it){
        var row = document.createElement('div'); row.className = 'diff-page-row removed';
        row.textContent = it.title || '(untitled)';
        return row;
      });
      addSection('Would come back (' + diff.restored.length + ')', diff.restored, 'restored', function(it){
        var row = document.createElement('div'); row.className = 'diff-page-row restored';
        row.textContent = it.title || '(untitled)';
        return row;
      });
      addSection('Changed (' + diff.modified.length + ')', diff.modified, 'modified', function(it){
        var row = document.createElement('div'); row.className = 'diff-page-row modified';
        var head = document.createElement('div'); head.className = 'diff-page-head';
        head.textContent = (it.currentTitle || '(untitled)') + (it.titleChanged ? ' (title changed)' : '') +
          ' — ' + it.blocks.length + ' block' + (it.blocks.length===1?'':'s') + ' changed';
        var body = document.createElement('div'); body.className = 'diff-block-list'; body.style.display = 'none';
        it.blocks.forEach(function(b){
          var bRow = document.createElement('div'); bRow.className = 'diff-block-row';
          var oldEl = document.createElement('div'); oldEl.className = 'diff-old';
          oldEl.textContent = b.snapshot === null ? '(added since snapshot)' : truncateForDiff(b.snapshot, 140);
          var newEl = document.createElement('div'); newEl.className = 'diff-new';
          newEl.textContent = b.current === null ? '(removed since snapshot)' : truncateForDiff(b.current, 140);
          bRow.appendChild(oldEl); bRow.appendChild(newEl);
          body.appendChild(bRow);
        });
        head.addEventListener('click', function(){ body.style.display = body.style.display === 'none' ? '' : 'none'; });
        row.appendChild(head); row.appendChild(body);
        return row;
      });
    }
  });
}
function closeVersionDiff(){
  document.getElementById('diff-overlay').style.display = 'none';
}

function openVersions(){
  var wrap = document.getElementById('versions-list');
  wrap.innerHTML = '<div class="version-empty">Loading…</div>';
  document.getElementById('versions-overlay').style.display = 'flex';
  loadVersions().then(function(list){
    list = list.slice().reverse();
    wrap.innerHTML = "";
    if(!list.length){
      wrap.innerHTML = '<div class="version-empty">No snapshots yet — one is taken automatically before any restore, and roughly once a day while you use Nexus.</div>';
    } else {
      list.forEach(function(entry){
        var row = document.createElement('div');
        row.className = 'version-item';
        var label = document.createElement('div');
        label.innerHTML = new Date(entry.ts).toLocaleString() + '<div class="v-meta">' + escapeHtml(entry.reason) + '</div>';
        var btnRow = document.createElement('div');
        btnRow.style.display = 'flex'; btnRow.style.gap = '6px';
        var compareBtn = document.createElement('button');
        compareBtn.textContent = 'Compare';
        compareBtn.onclick = function(){ openVersionDiff(entry); };
        var btn = document.createElement('button');
        btn.textContent = 'Restore this';
        btn.onclick = function(){ restoreFromVersion(entry); };
        btnRow.appendChild(compareBtn); btnRow.appendChild(btn);
        row.appendChild(label); row.appendChild(btnRow);
        wrap.appendChild(row);
      });
    }
  });
}
function closeVersions(){
  document.getElementById('versions-overlay').style.display = 'none';
}

/* ============================================================
   SYNC CONFLICTS
   A local, device-only log of lines/pages where two devices edited
   the same thing differently between syncs (see mergeStates). Kept
   under its own storage key, like Versions and Meta, so it never
   travels through Sync itself — only the inline `.conflict` flag on
   the affected block does, which is what makes it visible on the
   other device too.
   ============================================================ */
var CONFLICTS_KEY = STORAGE_KEY + '_conflicts';
var CONFLICTS_MAX = 200;
function loadConflicts(){
  try{ return JSON.parse(localStorage.getItem(CONFLICTS_KEY)) || []; }catch(e){ return []; }
}
function saveConflictsList(list){
  try{ localStorage.setItem(CONFLICTS_KEY, JSON.stringify(list)); }
  catch(e){
    // if storage is tight, drop the oldest conflict entries and retry once
    // (list is newest-first, so trim from the end) rather than silently
    // losing the newest conflict we were just asked to record
    while(list.length > 1){
      list.length = list.length - 1;
      try{ localStorage.setItem(CONFLICTS_KEY, JSON.stringify(list)); return; }
      catch(e2){ /* still too big, keep trimming */ }
    }
  }
}
function recordConflicts(newOnes, peerLabel){
  if(!newOnes || !newOnes.length) return;
  var list = loadConflicts();
  newOnes.forEach(function(c){
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
function renderConflictsList(){
  var list = loadConflicts();
  var wrap = document.getElementById('conflicts-list');
  wrap.innerHTML = "";
  if(!list.length){
    wrap.innerHTML = '<div class="version-empty">No sync conflicts — nice and quiet.</div>';
    return;
  }
  list.forEach(function(c){
    var item = document.createElement('div');
    item.className = 'conflict-item';

    var meta = document.createElement('div');
    meta.className = 'conflict-meta';
    meta.textContent = (c.kind === 'page' ? 'Page title' : 'Line') + ' in "' + c.pageTitle + '" — conflicted syncing with ' +
      (c.peerLabel || 'another device') + ', ' + timeAgo(c.detectedAt);

    var versions = document.createElement('div');
    versions.className = 'conflict-versions';
    var kept = document.createElement('div');
    kept.className = 'conflict-version kept';
    kept.innerHTML = '<div class="cv-label">Kept (newer edit)</div>' + escapeHtml(c.keptText || '(empty)');
    var dropped = document.createElement('div');
    dropped.className = 'conflict-version';
    dropped.innerHTML = '<div class="cv-label">Dropped (older edit)</div>' + escapeHtml(c.droppedText || '(empty)');
    versions.appendChild(kept); versions.appendChild(dropped);

    /* Real conflict resolution: keep the version already kept (just
       dismiss), switch to the other version instead (overwrite), or —
       for a single line only — bring the dropped text back as a second
       line so both survive and can be merged by hand. */
    var actions = document.createElement('div');
    actions.className = 'conflict-actions';

    var keepMineBtn = document.createElement('button');
    keepMineBtn.type = 'button';
    keepMineBtn.textContent = 'Keep this version';
    keepMineBtn.onclick = function(){ dismissConflict(c.id); };
    actions.appendChild(keepMineBtn);

    var keepTheirsBtn = document.createElement('button');
    keepTheirsBtn.type = 'button';
    keepTheirsBtn.textContent = 'Use dropped version instead';
    keepTheirsBtn.onclick = function(){ useDroppedInsteadOfKept(c); };
    actions.appendChild(keepTheirsBtn);

    if(c.kind === 'line'){
      var restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.textContent = 'Keep both (add as new line)';
      restoreBtn.onclick = function(){ restoreDroppedConflict(c); };
      actions.appendChild(restoreBtn);
    }
    var dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.onclick = function(){ dismissConflict(c.id); };
    actions.appendChild(dismissBtn);

    item.appendChild(meta); item.appendChild(versions); item.appendChild(actions);
    wrap.appendChild(item);
  });
}
/* "Use dropped version instead" — overwrites the kept text/title with the
   dropped one, in place, then clears the conflict record. This is the
   side-by-side "keep theirs" choice; "Keep this version" (dismissConflict)
   is "keep mine", and "Keep both" (restoreDroppedConflict, line-only) is
   the manual-merge option that preserves both as separate lines. */
function useDroppedInsteadOfKept(c){
  if(c.kind === 'line'){
    var b = state.blocks[c.entityId];
    if(!b){ toast('That line no longer exists — nothing to switch.'); return; }
    b.text = c.droppedText;
    delete b.conflict;
    save(); renderPage();
  } else if(c.kind === 'page'){
    var p = state.pages[c.pageId];
    if(!p){ toast('That page no longer exists — nothing to switch.'); return; }
    var oldTitle = p.title;
    p.title = c.droppedText;
    if(state.titleIndex[oldTitle.toLowerCase()] === p.id) delete state.titleIndex[oldTitle.toLowerCase()];
    state.titleIndex[p.title.toLowerCase()] = p.id;
    renameCascade(oldTitle, p.title);
    save(); renderAll();
  }
  var list = loadConflicts().filter(function(x){ return x.id !== c.id; });
  saveConflictsList(list);
  updateConflictsBadge();
  renderConflictsList();
  toast('Switched to the dropped version.');
}
function dismissConflict(id){
  var list = loadConflicts();
  var entry = list.filter(function(c){ return c.id === id; })[0];
  list = list.filter(function(c){ return c.id !== id; });
  saveConflictsList(list);
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
  var list = loadConflicts().filter(function(x){ return x.id !== c.id; });
  saveConflictsList(list);
  updateConflictsBadge();
  renderConflictsList();
  toast('Recovered the other version as a new line.');
  revealBlock(nb.id);
}
document.getElementById('btn-conflicts').onclick = openConflicts;
document.getElementById('conflicts-overlay').addEventListener('click', function(e){
  if(e.target.id === 'conflicts-overlay') closeConflicts();
});
document.getElementById('conflicts-dismiss-all').onclick = dismissAllConflicts;

function maybeAutoSnapshot(){
  loadVersions().then(function(list){
    var last = list.length ? list[list.length-1] : null;
    var oneDay = 24*60*60*1000;
    if(!last || Date.now() - last.ts > oneDay){
      snapshotVersion('daily snapshot');
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
