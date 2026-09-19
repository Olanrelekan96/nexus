/* ============================================================
 * 09-security-lock.js
 * Passcode lock screen and encryption-at-rest.
 *
 * Part of Nexus — loaded as a plain <script> (not a module) in
 * index.html, in numeric filename order. All files share one global
 * scope on purpose (same as the original single-file build), so
 * `state`, helper functions, etc. declared in an earlier file are
 * directly usable here without imports.
 * ============================================================ */
"use strict";

/* ============================================================
   PASSCODE LOCK & ENCRYPTION AT REST
   When a passcode is set, every write to NB_STORE's 'state' record
   is AES-GCM encrypted with a randomly generated data key (the
   "DEK"), and every read is decrypted with it. That happens
   transparently inside getNotebookState() / putNotebookState()
   below, so save()/loadAsync() and everything built on them (undo,
   restore, sync) keep passing plain JSON strings around exactly as
   before.

   The DEK itself is never written to disk in the clear. Instead it's
   "wrapped" (encrypted) twice, under two independently-derived keys:
     - one derived from the passcode via PBKDF2 (200k iterations,
       SHA-256) — used for everyday unlocking
     - one derived from a high-entropy recovery key, generated once
       and shown to the person a single time — used only if the
       passcode is forgotten
   Either wrapped copy can unwrap the same DEK, so the passcode and
   the recovery key are two independent doors to the same room.
   Changing the passcode just re-wraps the DEK under a new
   passcode-derived key; it doesn't touch the recovery wrap or
   require re-encrypting the notebook itself.

   The unwrapped DEK (lockCryptoKey) lives only in memory for the
   current tab/session by default. When "Request passcode on launch" is
   turned off, Nexus keeps a device-local CryptoKey in IndexedDB (plus a
   same-tab fallback) for auto-unlock, guarded by the normal re-entry
   deadline. The key is never included in backup/sync. Salts and iteration counts
   are public (localStorage, see LOCK_KEY) and don't weaken the
   passcode; they just let the same passcode/recovery key re-derive
   the same wrapping key next time. A small known string, encrypted
   with the DEK, serves as a "verifier" so an unlock attempt can be
   checked without touching the (possibly large) notebook payload.

   Notebooks encrypted before recovery keys existed have lock
   metadata with no wrappedDEK/recovery fields at all ("legacy"
   format, where the passcode derives the encryption key directly).
   Those are handled by tryUnlock()'s legacy branch and are quietly
   upgraded to the new format — with a fresh recovery key shown to
   the person — the next time they unlock or change their passcode.

   If someone has lost both their passcode and their recovery key,
   there is still no way back in: the only option at that point is to
   erase the encrypted notebook and start fresh (see "Forgot your
   passcode?" on the lock screen).
   ============================================================ */
var LOCK_KEY = STORAGE_KEY + '_lock';
var PBKDF2_ITERATIONS = 200000;
var MIN_PASSCODE_LENGTH = 12;
function validatePasscode(passcode){
  if(typeof passcode !== 'string' || passcode.length < MIN_PASSCODE_LENGTH){
    return Promise.reject(new Error('Passcode must be at least ' + MIN_PASSCODE_LENGTH + ' characters.'));
  }
  return Promise.resolve();
}
var LOCK_VERIFIER_TEXT = 'nexus-unlock-ok';
var RECOVERY_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; /* 32 chars; excludes 0/O/1/I/L to avoid transcription mistakes */
var lockCryptoKey = null; /* CryptoKey (the DEK) while unlocked this session, else null */

/* Re-entry interval: this is separate from the permanent encryption lock.
   The notebook normally starts locked on a fresh page load. A separate
   "Request passcode on launch" preference can allow the current browser tab
   to resume its unlocked DEK from sessionStorage, provided the absolute
   re-entry deadline has not expired. */
var PASSCODE_REENTRY_DEFAULT = '24';
var PASSCODE_REENTRY_CHOICES = ['1','6','12','24'];
var passcodeUnlockedAt = 0;
var passcodeReentryTimer = null;
var passcodeReentryHeartbeat = null;
var passcodeReentryLockPending = false;
var PASSCODE_REENTRY_STATE_KEY = LOCK_KEY + '_reentry_v3';
var PASSCODE_REENTRY_HEARTBEAT_MS = 15000;
var PASSCODE_LAUNCH_DEFAULT = 'on';
var PASSCODE_SESSION_KEY = LOCK_KEY + '_session_dek_v1';
var PASSCODE_PERSISTENT_STORE = 'security';
var PASSCODE_PERSISTENT_KEY = 'launch_dek_v1';

/* The interval must survive browser timer throttling/suspension. Keep the
   session start + absolute deadline in localStorage as non-secret metadata
   so the deadline can always be recomputed when Nexus returns to the
   foreground. A v1 numeric timestamp is accepted for one-time migration. */
function loadPasscodeReentryState(){
  try{
    var raw = localStorage.getItem(PASSCODE_REENTRY_STATE_KEY);
    if(raw){
      var obj = JSON.parse(raw);
      if(obj && Number(obj.startedAt) > 0 && Number(obj.deadlineAt) > 0){
        return {startedAt:Number(obj.startedAt), deadlineAt:Number(obj.deadlineAt)};
      }
    }
  }catch(e){}
  /* Migrate the earlier repair's plain numeric key if present. */
  try{
    var legacyKeys = [LOCK_KEY + '_reentry_v2', LOCK_KEY + '_reentry'];
    for(var li=0; li<legacyKeys.length; li++) {
      var n = Number(localStorage.getItem(legacyKeys[li]));
      if(Number.isFinite(n) && n > 0){
        return {startedAt:n, deadlineAt:n + passcodeReentryMs()};
      }
    }
  }catch(e){}
  return {startedAt:0, deadlineAt:0};
}
function persistPasscodeReentryState(startedAt, deadlineAt){
  try{
    if(startedAt && deadlineAt){
      localStorage.setItem(PASSCODE_REENTRY_STATE_KEY, JSON.stringify({startedAt:startedAt, deadlineAt:deadlineAt}));
    }else{
      localStorage.removeItem(PASSCODE_REENTRY_STATE_KEY);
      localStorage.removeItem(LOCK_KEY + '_reentry_v2');
      localStorage.removeItem(LOCK_KEY + '_reentry');
    }
  }catch(e){}
}
function loadPasscodeReentryStartedAt(){ return loadPasscodeReentryState().startedAt; }
function loadPasscodeReentryDeadline(){ return loadPasscodeReentryState().deadlineAt; }
function persistPasscodeReentryStartedAt(value){
  if(value){ persistPasscodeReentryState(value, value + passcodeReentryMs()); }
  else persistPasscodeReentryState(0, 0);
}

function passcodeReentryHours(){
  var v = (typeof currentSettings !== 'undefined' && currentSettings.passcodeReentryHours) || PASSCODE_REENTRY_DEFAULT;
  return PASSCODE_REENTRY_CHOICES.indexOf(String(v)) === -1 ? PASSCODE_REENTRY_DEFAULT : String(v);
}
function passcodeReentryMs(){ return parseInt(passcodeReentryHours(), 10) * 60 * 60 * 1000; }
function passcodeRequestOnLaunch(){
  var v = (typeof currentSettings !== 'undefined' && currentSettings.passcodeRequestOnLaunch) || PASSCODE_LAUNCH_DEFAULT;
  return String(v) !== 'off';
}
function clearPasscodeSessionKey(){
  try{ sessionStorage.removeItem(PASSCODE_SESSION_KEY); }catch(e){}
}
function clearPersistentPasscodeKey(){
  if(typeof openAttachmentDb !== 'function') return Promise.resolve(false);
  return openAttachmentDb().then(function(db){
    return new Promise(function(resolve){
      try{
        var tx = db.transaction(PASSCODE_PERSISTENT_STORE, 'readwrite');
        tx.objectStore(PASSCODE_PERSISTENT_STORE).delete(PASSCODE_PERSISTENT_KEY);
        tx.oncomplete = function(){ resolve(true); };
        tx.onerror = tx.onabort = function(){ resolve(false); };
      }catch(e){ resolve(false); }
    });
  }).catch(function(){ return false; });
}
function persistPersistentPasscodeKey(){
  if(passcodeRequestOnLaunch() || !lockCryptoKey) return Promise.resolve(false);
  var state = loadPasscodeReentryState();
  var deadline = state.deadlineAt || (passcodeUnlockedAt ? passcodeUnlockedAt + passcodeReentryMs() : 0);
  if(!deadline || Date.now() >= deadline){ return clearPersistentPasscodeKey().then(function(){ return false; }); }
  return openAttachmentDb().then(function(db){
    return new Promise(function(resolve){
      try{
        var tx = db.transaction(PASSCODE_PERSISTENT_STORE, 'readwrite');
        tx.objectStore(PASSCODE_PERSISTENT_STORE).put({v:1, key:lockCryptoKey, startedAt:state.startedAt || passcodeUnlockedAt || Date.now(), deadlineAt:deadline}, PASSCODE_PERSISTENT_KEY);
        tx.oncomplete = function(){ resolve(true); };
        tx.onerror = tx.onabort = function(){ resolve(false); };
      }catch(e){ resolve(false); }
    });
  }).catch(function(){ return false; });
}
function restorePersistentPasscodeKey(){
  if(passcodeRequestOnLaunch() || !isLockEnabled()) return Promise.resolve(false);
  var reentry = loadPasscodeReentryState();
  if(!reentry.deadlineAt || Date.now() >= reentry.deadlineAt){
    return clearPersistentPasscodeKey().then(function(){ return false; });
  }
  return openAttachmentDb().then(function(db){
    return new Promise(function(resolve){
      try{
        var tx = db.transaction(PASSCODE_PERSISTENT_STORE, 'readonly');
        var req = tx.objectStore(PASSCODE_PERSISTENT_STORE).get(PASSCODE_PERSISTENT_KEY);
        req.onsuccess = function(){ resolve(req.result || null); };
        req.onerror = function(){ resolve(null); };
      }catch(e){ resolve(null); }
    });
  }).then(function(raw){
    if(!raw || raw.v !== 1 || !raw.key || Number(raw.deadlineAt) <= Date.now()){
      return clearPersistentPasscodeKey().then(function(){ return false; });
    }
    var deadline = Math.min(Number(raw.deadlineAt), Number(reentry.deadlineAt));
    if(!Number.isFinite(deadline) || deadline <= Date.now()){
      return clearPersistentPasscodeKey().then(function(){ return false; });
    }
    var meta = loadLockMeta();
    if(!meta || !meta.verifier){ return clearPersistentPasscodeKey().then(function(){ return false; }); }
    return decryptWithKey(raw.key, meta.verifier).then(function(text){
      if(text !== LOCK_VERIFIER_TEXT) return clearPersistentPasscodeKey().then(function(){ return false; });
      lockCryptoKey = raw.key;
      passcodeUnlockedAt = Number(raw.startedAt) || Number(reentry.startedAt) || Date.now();
      if(Number(loadPasscodeReentryDeadline()) !== deadline){
        persistPasscodeReentryState(passcodeUnlockedAt, deadline);
      }
      return true;
    }).catch(function(){ return clearPersistentPasscodeKey().then(function(){ return false; }); });
  });
}
function persistPasscodeSessionKey(){
  if(passcodeRequestOnLaunch() || !lockCryptoKey) return Promise.resolve(false);
  var state = loadPasscodeReentryState();
  var deadline = state.deadlineAt || (passcodeUnlockedAt ? passcodeUnlockedAt + passcodeReentryMs() : 0);
  if(!deadline || Date.now() >= deadline){ clearPasscodeSessionKey(); return Promise.resolve(false); }
  return crypto.subtle.exportKey('raw', lockCryptoKey).then(function(raw){
    var payload = {v:1, startedAt: state.startedAt || passcodeUnlockedAt || Date.now(), deadlineAt: deadline, key: bufToB64(raw)};
    try{ sessionStorage.setItem(PASSCODE_SESSION_KEY, JSON.stringify(payload)); return true; }catch(e){ return false; }
  }).catch(function(){ return false; });
}
function restorePasscodeSessionKey(){
  if(passcodeRequestOnLaunch() || !isLockEnabled()) return Promise.resolve(false);
  var raw;
  try{ raw = JSON.parse(sessionStorage.getItem(PASSCODE_SESSION_KEY) || 'null'); }catch(e){ raw = null; }
  if(!raw || raw.v !== 1 || !raw.key || Number(raw.deadlineAt) <= Date.now()){ clearPasscodeSessionKey(); return Promise.resolve(false); }
  var meta = loadLockMeta();
  if(!meta || !meta.verifier){ clearPasscodeSessionKey(); return Promise.resolve(false); }
  return crypto.subtle.importKey('raw', b64ToBuf(raw.key), {name:'AES-GCM'}, true, ['encrypt','decrypt']).then(function(dek){
    return decryptWithKey(dek, meta.verifier).then(function(text){
      if(text !== LOCK_VERIFIER_TEXT){ clearPasscodeSessionKey(); return false; }
      lockCryptoKey = dek;
      passcodeUnlockedAt = Number(raw.startedAt) || Date.now();
      return true;
    });
  }).catch(function(){ clearPasscodeSessionKey(); return false; });
}
function updatePasscodeLaunchSessionPolicy(){
  if(!isLockEnabled() || passcodeRequestOnLaunch() || !lockCryptoKey){
    clearPasscodeSessionKey();
    return clearPersistentPasscodeKey();
  }
  return Promise.all([persistPasscodeSessionKey(), persistPersistentPasscodeKey()]).then(function(result){ return result[0] || result[1]; });
}
function updatePasscodeReentryStatus(){
  var el = document.getElementById('passcode-reentry-status');
  if(!el) return;
  if(!isLockEnabled()){
    el.textContent = 'Set a passcode first. Once unlocked, Nexus can require it again every ' + passcodeReentryHours() + ' hour' + (passcodeReentryHours()==='1'?'':'s') + '.';
    return;
  }
  if(!lockCryptoKey || !passcodeUnlockedAt){
    el.textContent = 'Next re-entry interval: every ' + passcodeReentryHours() + ' hour' + (passcodeReentryHours()==='1'?'':'s') + '. The timer starts after a successful unlock.';
    return;
  }
  var deadline = loadPasscodeReentryDeadline() || (passcodeUnlockedAt + passcodeReentryMs());
  var remaining = deadline - Date.now();
  if(remaining <= 0){
    el.textContent = 'Passcode re-entry is due now.';
    return;
  }
  var mins = Math.ceil(remaining / 60000);
  var left = mins >= 60 ? (Math.floor(mins/60) + 'h ' + (mins%60) + 'm') : (mins + 'm');
  el.textContent = 'Passcode re-entry is due in about ' + left + '. The timer is based on elapsed time, not typing activity.';
}
function clearPasscodeReentryTimer(){
  if(passcodeReentryTimer !== null){ clearTimeout(passcodeReentryTimer); passcodeReentryTimer = null; }
  if(passcodeReentryHeartbeat !== null){ clearInterval(passcodeReentryHeartbeat); passcodeReentryHeartbeat = null; }
}
function startPasscodeReentryHeartbeat(){
  if(typeof setInterval !== 'function') return;
  if(passcodeReentryHeartbeat !== null) clearInterval(passcodeReentryHeartbeat);
  passcodeReentryHeartbeat = setInterval(function(){
    if(document.visibilityState !== 'hidden') enforcePasscodeReentry();
  }, PASSCODE_REENTRY_HEARTBEAT_MS);
}
function schedulePasscodeReentry(){
  clearTimeout(passcodeReentryTimer);
  passcodeReentryTimer = null;
  if(!isLockEnabled() || !lockCryptoKey || appLocked) return;
  var persisted = loadPasscodeReentryState();
  /* localStorage is best-effort. Never recurse back into refreshLockSessionTimer
     merely because persistence failed or is unavailable. The in-memory start
     time is sufficient for this live session; persistence only protects resume. */
  if(!passcodeUnlockedAt) passcodeUnlockedAt = persisted.startedAt;
  var deadline = persisted.deadlineAt || (passcodeUnlockedAt ? passcodeUnlockedAt + passcodeReentryMs() : 0);
  if(!passcodeUnlockedAt || !deadline){ return; }
  if(Date.now() >= deadline){ enforcePasscodeReentry(); return; }
  var delay = Math.max(250, deadline - Date.now());
  passcodeReentryTimer = setTimeout(enforcePasscodeReentry, delay);
  startPasscodeReentryHeartbeat();
  updatePasscodeReentryStatus();
}
function refreshLockSessionTimer(){
  if(!isLockEnabled() || !lockCryptoKey){
    passcodeUnlockedAt = 0;
    clearPasscodeReentryTimer();
    persistPasscodeReentryState(0, 0);
    updatePasscodeReentryStatus();
    return;
  }
  passcodeUnlockedAt = Date.now();
  var deadlineAt = passcodeUnlockedAt + passcodeReentryMs();
  persistPasscodeReentryState(passcodeUnlockedAt, deadlineAt);
  passcodeReentryLockPending = false;
  schedulePasscodeReentry();
  updatePasscodeReentryStatus();
  try{ persistPasscodeSessionKey().catch(function(){}); }catch(ignore){}
  try{ persistPersistentPasscodeKey().catch(function(){}); }catch(ignore){}
}
function enforcePasscodeReentry(){
  passcodeReentryTimer = null;
  var persisted = loadPasscodeReentryState();
  if(!passcodeUnlockedAt) passcodeUnlockedAt = persisted.startedAt;
  if(appLocked || !isLockEnabled() || !lockCryptoKey || !passcodeUnlockedAt) return;
  var deadline = persisted.deadlineAt || (passcodeUnlockedAt + passcodeReentryMs());
  if(Date.now() < deadline){ schedulePasscodeReentry(); return; }
  if(passcodeReentryLockPending) return;
  passcodeReentryLockPending = true;
  var finished = false;
  var finalize = function(){
    if(finished) return;
    finished = true;
    passcodeReentryLockPending = false;
    if(!appLocked && isLockEnabled() && lockCryptoKey){
      passcodeUnlockedAt = 0;
      persistPasscodeReentryState(0, 0);
      lockNow();
      toast('Passcode interval expired. Enter your passcode to continue.');
    }
    updatePasscodeReentryStatus();
  };
  /* Saving is best-effort. Never let an IndexedDB promise prevent the
     security boundary from locking indefinitely. */
  try{
    /* Lock immediately after initiating a best-effort flush. The flush captures
       the current DEK, so the encrypted write can complete after the key is
       cleared by lockNow(). This avoids both a visible delay and a lost pending save. */
    var flushed = typeof flushSaveNow === 'function' ? flushSaveNow() : null;
    Promise.resolve(flushed).catch(function(){});
    finalize();
  }catch(ignore){ finalize(); }
}
function setPasscodeReentry(hours){
  hours = String(hours);
  if(PASSCODE_REENTRY_CHOICES.indexOf(hours) === -1) return;
  currentSettings.passcodeReentryHours = hours;
  saveSettings(currentSettings);
  if(isLockEnabled() && lockCryptoKey){
    /* Choosing a new interval starts that interval from now rather than
       unexpectedly locking immediately because the previous interval was shorter. */
    refreshLockSessionTimer();
  }else{
    updatePasscodeReentryStatus();
  }
  if(typeof setDataHealthStatus === 'function') setDataHealthStatus('saved', 'Passcode interval saved');
  if(typeof toast === 'function') toast('Nexus will require your passcode again every ' + hours + ' hour' + (hours==='1'?'':'s') + '.');
}

function loadLockMeta(){
  try{ return JSON.parse(localStorage.getItem(LOCK_KEY)); }catch(e){ return null; }
}
function saveLockMeta(meta){
  try{ localStorage.setItem(LOCK_KEY, JSON.stringify(meta)); }catch(e){}
}
function clearLockMeta(){
  try{ localStorage.removeItem(LOCK_KEY); }catch(e){}
  clearPasscodeSessionKey();
  clearPersistentPasscodeKey();
}
function isLockEnabled(){ return !!loadLockMeta(); }

/* Browser/mobile timer throttling can delay setTimeout for a long time.
   These lifecycle hooks compare real elapsed time immediately when the app
   becomes visible again, so a missed timer cannot leave the notebook unlocked. */
function checkPasscodeReentryOnResume(){
  if(document.visibilityState === 'hidden') return;
  try{ enforcePasscodeReentry(); }catch(ignore){}
  updatePasscodeReentryStatus();
}
document.addEventListener('visibilitychange', checkPasscodeReentryOnResume);
window.addEventListener('pageshow', checkPasscodeReentryOnResume);
window.addEventListener('focus', checkPasscodeReentryOnResume);


/* ---------- Portable encryption for exports/backups/sync ----------
   The everyday DEK (lockCryptoKey) is randomly generated once per
   device and never leaves it, so it can't be used for anything meant
   to be opened elsewhere (a downloaded backup file, a Drive file read
   by a second device). Those need a key any device can re-derive
   independently — from the one secret the person actually carries
   between devices, their passcode — plus a random salt stored right
   alongside the ciphertext (salts aren't secret, only the passcode
   is). confirmPasscode() checks it against the local lock's verifier
   first, so a mistyped passcode is caught immediately rather than
   silently producing a backup nobody can ever decrypt. */
function confirmPasscode(passcode){
  return tryUnlock(passcode).then(function(res){ return !!res.ok; });
}
function encryptForPortableStorage(jsonString, passcode){
  var salt = randomSaltB64();
  return deriveLockKey(passcode, salt, PBKDF2_ITERATIONS).then(function(key){
    return encryptWithKey(key, jsonString).then(function(enc){
      return JSON.stringify({ nexusEncryptedBackup: true, v: 1, salt: salt, iterations: PBKDF2_ITERATIONS, iv: enc.iv, ct: enc.ct });
    });
  });
}
function decryptPortableStorage(envelope, passcode){
  return deriveLockKey(passcode, envelope.salt, envelope.iterations).then(function(key){
    return decryptWithKey(key, {iv: envelope.iv, ct: envelope.ct});
  });
}
/* Visible-while-typing is a known trade-off of the browser's native
   prompt() — fine for an occasional "type this to encrypt/decrypt a
   backup" moment, not a replacement for the masked lock-screen input
   used for everyday unlocking. Returns null if cancelled. */
function promptForPasscode(message){
  return window.prompt(message);
}

/* ArrayBuffer <-> base64 helpers used throughout the lock/encryption code. */
function bufToB64(buf){
  var bytes = new Uint8Array(buf);
  var bin = '';
  for(var i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64ToBuf(b64){
  var bin = atob(b64);
  var bytes = new Uint8Array(bin.length);
  for(var i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function randomSaltB64(){
  var bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bufToB64(bytes.buffer);
}
function deriveLockKey(secret, saltB64, iterations){
  var salt = new Uint8Array(b64ToBuf(saltB64));
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'PBKDF2'}, false, ['deriveKey'])
    .then(function(material){
      return crypto.subtle.deriveKey(
        {name:'PBKDF2', salt: salt, iterations: iterations, hash:'SHA-256'},
        material,
        {name:'AES-GCM', length:256},
        false,
        ['encrypt','decrypt']
      );
    });
}
function encryptWithKey(key, plaintext){
  var iv = crypto.getRandomValues(new Uint8Array(12));
  var data = new TextEncoder().encode(plaintext);
  return crypto.subtle.encrypt({name:'AES-GCM', iv: iv}, key, data).then(function(cipher){
    return {iv: bufToB64(iv.buffer), ct: bufToB64(cipher)};
  });
}
function decryptWithKey(key, payload){
  var iv = new Uint8Array(b64ToBuf(payload.iv));
  var cipher = b64ToBuf(payload.ct);
  return crypto.subtle.decrypt({name:'AES-GCM', iv: iv}, key, cipher).then(function(plain){
    return new TextDecoder().decode(plain);
  });
}
/* Wraps/unwraps raw DEK bytes under a KEK (passcode- or recovery-derived). */
function wrapDEK(kek, dekRawBuf){
  var iv = crypto.getRandomValues(new Uint8Array(12));
  return crypto.subtle.encrypt({name:'AES-GCM', iv: iv}, kek, dekRawBuf).then(function(cipher){
    return {iv: bufToB64(iv.buffer), ct: bufToB64(cipher)};
  });
}
function unwrapDEK(kek, wrapped){
  var iv = new Uint8Array(b64ToBuf(wrapped.iv));
  var cipher = b64ToBuf(wrapped.ct);
  return crypto.subtle.decrypt({name:'AES-GCM', iv: iv}, kek, cipher); /* -> raw DEK ArrayBuffer */
}

/* Generates a random, high-entropy recovery key: 160 bits encoded
   5 bits/char over a 32-character alphabet, shown grouped in 4s.
   `compact` (no separators, uppercase) is what's actually used as
   key material; `display` is only for showing/printing it. */
function generateRecoveryCode(){
  var bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  var bits = '';
  for(var i=0;i<bytes.length;i++){ bits += ('00000000'+bytes[i].toString(2)).slice(-8); }
  var compact = '';
  for(var i=0;i+5<=bits.length;i+=5){ compact += RECOVERY_CHARSET[parseInt(bits.substr(i,5),2)]; }
  var display = (compact.match(/.{1,4}/g) || [compact]).join('-');
  return {compact: compact, display: display};
}
function normalizeRecoveryCode(str){
  return (str||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
}

/* Establishes a passcode for the first time (mode 'set'), or
   silently upgrades a legacy-format lock to the new recovery-capable
   format under the same passcode (called from tryUnlock()'s legacy
   branch and changePasscode()). Generates a fresh DEK and a fresh
   recovery key, wraps the DEK under both the passcode and the
   recovery key, re-encrypts whatever notebook JSON is currently
   stored under the new DEK, and resolves to the recovery key's
   display string so the caller can show it to the person once. */
function setPasscode(passcode){
  return validatePasscode(passcode).then(function(){
  var pcSalt = randomSaltB64();
  var rc = generateRecoveryCode();
  var recSalt = randomSaltB64();
  var dekRaw;
  return crypto.subtle.generateKey({name:'AES-GCM', length:256}, true, ['encrypt','decrypt'])
    .then(function(dek){ return crypto.subtle.exportKey('raw', dek); })
    .then(function(raw){
      dekRaw = raw;
      return Promise.all([
        deriveLockKey(passcode, pcSalt, PBKDF2_ITERATIONS),
        deriveLockKey(rc.compact, recSalt, PBKDF2_ITERATIONS)
      ]);
    })
    .then(function(keys){
      return Promise.all([ wrapDEK(keys[0], dekRaw), wrapDEK(keys[1], dekRaw) ]);
    })
    .then(function(wrapped){
      return crypto.subtle.importKey('raw', dekRaw, {name:'AES-GCM'}, true, ['encrypt','decrypt']).then(function(dek){
        return encryptWithKey(dek, LOCK_VERIFIER_TEXT).then(function(verifier){
          return getNotebookState().then(function(currentJson){
            lockCryptoKey = dek;
            saveLockMeta({
              version: 2,
              salt: pcSalt, iterations: PBKDF2_ITERATIONS, wrappedDEK: wrapped[0], verifier: verifier,
              recoverySalt: recSalt, recoveryIterations: PBKDF2_ITERATIONS, wrappedDEKRecovery: wrapped[1]
            });
            if(currentJson) return putNotebookState(currentJson);
          });
        });
      });
    })
    .then(function(){
      /* lockCryptoKey is set now — sweep any attachments stored before
         the passcode existed and re-save them through putAttachment()
         so they get encrypted under the new DEK too. */
      return listAllAttachments().then(function(records){
        var plain = records.filter(function(r){ return !r.enc; });
        return Promise.all(plain.map(function(r){
          return getAttachment(r.id).then(function(rec){ if(rec) return putAttachment(rec); });
        }));
      });
    })
    .then(function(){
      /* Setting the passcode is also a successful unlock. Start the re-entry
         clock here so the first passcode session cannot remain unlocked
         indefinitely while the recovery key dialog is displayed. */
      refreshLockSessionTimer();
      return rc.display;
    });
  });
}
/* Re-wraps the already-unlocked DEK under a new passcode, without
   touching the recovery wrap or re-encrypting the notebook — used
   for an ordinary passcode change, and to set a fresh passcode right
   after a recovery-key unlock. */
function rewrapPasscodeOnly(newPasscode){
  var meta = loadLockMeta();
  if(!meta || !lockCryptoKey) return Promise.reject(new Error('not unlocked'));
  var newSalt = randomSaltB64();
  return validatePasscode(newPasscode).then(function(){ return crypto.subtle.exportKey('raw', lockCryptoKey).then(function(dekRaw){
    return deriveLockKey(newPasscode, newSalt, PBKDF2_ITERATIONS).then(function(kek){
      return wrapDEK(kek, dekRaw).then(function(wrapped){
        meta.version = 2;
        meta.salt = newSalt; meta.iterations = PBKDF2_ITERATIONS; meta.wrappedDEK = wrapped;
        saveLockMeta(meta);
      });
    });
  });
  });
}
/* Replaces the recovery wrap with a fresh recovery key, invalidating
   the old one. Requires the DEK to already be unlocked in memory. */
function regenerateRecoveryCode(){
  var meta = loadLockMeta();
  if(!meta || !lockCryptoKey) return Promise.reject(new Error('not unlocked'));
  var rc = generateRecoveryCode();
  var recSalt = randomSaltB64();
  return crypto.subtle.exportKey('raw', lockCryptoKey).then(function(dekRaw){
    return deriveLockKey(rc.compact, recSalt, PBKDF2_ITERATIONS).then(function(kek){
      return wrapDEK(kek, dekRaw).then(function(wrapped){
        meta.version = 2;
        meta.recoverySalt = recSalt; meta.recoveryIterations = PBKDF2_ITERATIONS; meta.wrappedDEKRecovery = wrapped;
        saveLockMeta(meta);
        return rc.display;
      });
    });
  });
}
/* Resolves {ok, legacy}; never rejects, so a wrong guess is just
   ok:false. `legacy` flags lock metadata from before recovery keys
   existed, so callers can trigger the one-time upgrade. */
function tryUnlock(passcode){
  var meta = loadLockMeta();
  if(!meta) return Promise.resolve({ok:true, legacy:false}); /* no passcode set — nothing to unlock */
  if(meta.wrappedDEK){
    return deriveLockKey(passcode, meta.salt, meta.iterations).then(function(kek){
      return unwrapDEK(kek, meta.wrappedDEK);
    }).then(function(dekRaw){
      return crypto.subtle.importKey('raw', dekRaw, {name:'AES-GCM'}, true, ['encrypt','decrypt']);
    }).then(function(dek){
      return decryptWithKey(dek, meta.verifier).then(function(text){
        if(text !== LOCK_VERIFIER_TEXT) return {ok:false, legacy:false};
        lockCryptoKey = dek;
        return {ok:true, legacy:false};
      });
    }).catch(function(){ return {ok:false, legacy:false}; });
  }
  /* legacy format: the passcode derives the data key directly, with
     no recovery wrap at all. */
  return deriveLockKey(passcode, meta.salt, meta.iterations).then(function(key){
    return decryptWithKey(key, meta.verifier).then(function(text){
      if(text !== LOCK_VERIFIER_TEXT) return {ok:false, legacy:true};
      lockCryptoKey = key;
      return {ok:true, legacy:true};
    });
  }).catch(function(){ return {ok:false, legacy:true}; });
}
/* Resolves true/false; never rejects. Unlocks using the recovery key
   instead of the passcode — only possible on the new lock format. */
function tryUnlockWithRecovery(code){
  var meta = loadLockMeta();
  if(!meta || !meta.wrappedDEKRecovery) return Promise.resolve(false);
  var secret = normalizeRecoveryCode(code);
  if(!secret) return Promise.resolve(false);
  return deriveLockKey(secret, meta.recoverySalt, meta.recoveryIterations).then(function(kek){
    return unwrapDEK(kek, meta.wrappedDEKRecovery);
  }).then(function(dekRaw){
    return crypto.subtle.importKey('raw', dekRaw, {name:'AES-GCM'}, true, ['encrypt','decrypt']);
  }).then(function(dek){
    return decryptWithKey(dek, meta.verifier).then(function(text){
      if(text !== LOCK_VERIFIER_TEXT) return false;
      lockCryptoKey = dek;
      return true;
    });
  }).catch(function(){ return false; });
}
/* Resolves {ok, recoveryCode?} — recoveryCode is only present when a
   legacy notebook got silently upgraded as part of this change. */
function changePasscode(oldPasscode, newPasscode){
  return tryUnlock(oldPasscode).then(function(res){
    if(!res.ok) return {ok:false};
    if(res.legacy){
      return setPasscode(newPasscode).then(function(recoveryCode){ return {ok:true, recoveryCode: recoveryCode}; });
    }
    return rewrapPasscodeOnly(newPasscode).then(function(){ return {ok:true}; });
  });
}
/* Decrypts the notebook (and any encrypted attachments) with the
   current in-memory key and writes them back out in plain form, then
   drops the lock metadata (and recovery key) entirely. Attachments
   must be decrypted *before* the DEK is discarded — otherwise their
   ciphertext would be left on disk with no key left able to open it. */
function removePasscode(){
  return getNotebookState().then(function(currentJson){
    return listAllAttachments().then(function(records){
      var encRecords = records.filter(function(r){ return r.enc; });
      return Promise.all(encRecords.map(function(r){ return getAttachment(r.id); }));
    }).then(function(decrypted){
      clearPasscodeReentryTimer();
      passcodeUnlockedAt = 0;
      persistPasscodeReentryStartedAt(0);
      clearPasscodeSessionKey();
      clearPersistentPasscodeKey();
      lockCryptoKey = null;
      clearLockMeta();
      var writes = [];
      if(currentJson) writes.push(putNotebookState(currentJson));
      decrypted.filter(Boolean).forEach(function(rec){ writes.push(putAttachment(rec)); });
      return Promise.all(writes);
    });
  });
}
function removePasscodeConfirmed(passcode){
  return tryUnlock(passcode).then(function(res){
    if(!res.ok) return false;
    return removePasscode().then(function(){ return true; });
  });
}
function closeSecurityOverlays(){
  ['settings-overlay','passcode-overlay','recovery-unlock-overlay','recovery-show-overlay','data-health-overlay'].forEach(function(id){
    var el = document.getElementById(id);
    if(el) el.style.display = 'none';
  });
}
function lockNow(){
  closeSecurityOverlays();
  clearPasscodeReentryTimer();
  passcodeUnlockedAt = 0;
  persistPasscodeReentryStartedAt(0);
  passcodeReentryLockPending = false;
  lockCryptoKey = null;
  clearPasscodeSessionKey();
  clearPersistentPasscodeKey();
  showLockScreen();
}

function showLockScreen(){
  appLocked = true;
  document.getElementById('lock-overlay').style.display = 'flex';
  document.getElementById('lock-input').value = '';
  document.getElementById('lock-error').textContent = '';
  setTimeout(function(){ document.getElementById('lock-input').focus(); }, 50);
}
function hideLockScreen(){
  appLocked = false;
  document.getElementById('lock-overlay').style.display = 'none';
}
function attemptUnlockFromScreen(){
  var input = document.getElementById('lock-input');
  var errEl = document.getElementById('lock-error');
  var btn = document.getElementById('lock-submit');
  var passcode = input.value;
  if(!passcode){ errEl.textContent = 'Enter your passcode.'; return; }
  btn.disabled = true;
  tryUnlock(passcode).then(function(res){
    btn.disabled = false;
    if(!res.ok){ errEl.textContent = 'Incorrect passcode.'; input.value=''; input.focus(); return; }
    hideLockScreen();
    refreshLockSessionTimer();
    if(!state) bootNotebook(); /* first unlock of this page load */
    if(res.legacy){
      /* One-time background upgrade: adds a recovery key to a
         notebook that was encrypted before recovery keys existed. */
      setPasscode(passcode).then(function(recoveryCode){
        openRecoveryShowModal(recoveryCode);
      }).catch(function(){ /* not critical — changing the passcode later will retry */ });
    }
  });
}
document.getElementById('lock-submit').onclick = attemptUnlockFromScreen;
document.getElementById('lock-input').addEventListener('keydown', function(e){
  if(e.key === 'Enter') attemptUnlockFromScreen();
});
/* Erases the (encrypted, otherwise unreadable) notebook on this
   device and its passcode, then reloads into a fresh notebook. Last
   resort for a forgotten passcode with no recovery key — there is no
   other way in. */
function eraseAndStartOver(){
  if(!confirm('This permanently erases your notes on this device — there is no way to recover them without the passcode or your recovery key. Continue?')) return;
  openAttachmentDb().then(function(db){
    return new Promise(function(resolve, reject){
      var tx = db.transaction(NB_STORE, 'readwrite');
      tx.objectStore(NB_STORE).delete('state');
      tx.oncomplete = function(){ resolve(); };
      tx.onerror = function(){ reject(tx.error); };
    });
  }).then(function(){
    clearLockMeta();
    location.reload();
  }).catch(function(){
    toast('Could not erase — try again.');
  });
}

/* ---- Notebook persistence (IndexedDB) ----
   The live notebook is stored as a single value under the key
   'state' in NB_STORE. Unencrypted it's the plain JSON string, same
   as always; encrypted it's {iv, ct, enc:true}. Callers of
   getNotebookState()/putNotebookState() never see the difference —
   they always deal in plain JSON strings, same as before passcodes
   existed. */
function getNotebookState(){
  return openAttachmentDb().then(function(db){
    return new Promise(function(resolve, reject){
      var tx = db.transaction(NB_STORE, 'readonly');
      var req = tx.objectStore(NB_STORE).get('state');
      req.onsuccess = function(){ resolve(req.result || null); };
      req.onerror = function(){ reject(req.error); };
    });
  }).then(function(raw){
    if(raw == null) return null;
    if(typeof raw === 'string') return raw; /* unencrypted */
    if(raw.enc){
      if(!lockCryptoKey) return Promise.reject(new Error('locked'));
      return decryptWithKey(lockCryptoKey, raw);
    }
    return raw;
  });
}
function putNotebookState(json, keyOverride){
  /* Never downgrade a locked notebook to plaintext. A background save,
     sync callback, or unload handler may run after the UI has locked.
     keyOverride is used only for a save that captured the DEK before locking. */
  var keyToUse = keyOverride || lockCryptoKey;
  if(isLockEnabled() && !keyToUse){
    return Promise.reject(new Error('Security Error: storage write attempted while locked.'));
  }
  return openAttachmentDb().then(function(db){
    function write(payload){
      return new Promise(function(resolve, reject){
        var tx = db.transaction(NB_STORE, 'readwrite');
        tx.objectStore(NB_STORE).put(payload, 'state');
        tx.oncomplete = function(){ resolve(); };
        tx.onerror = function(){ reject(tx.error || new Error('IndexedDB write failed.')); };
        tx.onabort = function(){ reject(tx.error || new Error('IndexedDB transaction aborted.')); };
      });
    }
    if(keyToUse){
      return encryptWithKey(keyToUse, json).then(function(enc){
        enc.enc = true;
        return write(enc);
      });
    }
    return write(json);
  });
}
/* Attachment blobs get the same at-rest treatment as the notebook JSON:
   when a passcode is set, the blob's bytes (as base64) are AES-GCM
   encrypted under the DEK before being written; metadata (name/type/
   size/addedAt) stays in the clear so listAllAttachments()/storage-hint/
   the attachments list can keep working without decrypting anything.
   Callers of putAttachment()/getAttachment() never see the difference —
   they always deal in a real Blob on rec.blob, same as before passcodes
   protected attachments. */
function putAttachment(record){
  /* Attachments are protected by the same lock boundary as notebook state. */
  if(isLockEnabled() && !lockCryptoKey){
    return Promise.reject(new Error('Security Error: attachment write attempted while locked.'));
  }
  return openAttachmentDb().then(function(db){
    function write(payload){
      return new Promise(function(resolve, reject){
        var tx = db.transaction(ATT_STORE, 'readwrite');
        tx.objectStore(ATT_STORE).put(payload);
        tx.oncomplete = function(){ resolve(); };
        tx.onerror = function(){ reject(tx.error || new Error('IndexedDB attachment write failed.')); };
        tx.onabort = function(){ reject(tx.error || new Error('IndexedDB attachment transaction aborted.')); };
      });
    }
    if(lockCryptoKey){
      return blobToBase64(record.blob).then(function(b64){
        return encryptWithKey(lockCryptoKey, b64).then(function(enc){
          return write({id: record.id, name: record.name, type: record.type, size: record.size, addedAt: record.addedAt, enc: true, iv: enc.iv, ct: enc.ct});
        });
      });
    }
    return write(record);
  });
}
function getAttachment(id){
  return openAttachmentDb().then(function(db){
    return new Promise(function(resolve, reject){
      var tx = db.transaction(ATT_STORE, 'readonly');
      var req = tx.objectStore(ATT_STORE).get(id);
      req.onsuccess = function(){ resolve(req.result || null); };
      req.onerror = function(){ reject(req.error); };
    });
  }).then(function(rec){
    if(!rec) return null;
    if(rec.enc){
      if(!lockCryptoKey) return Promise.reject(new Error('locked'));
      return decryptWithKey(lockCryptoKey, {iv: rec.iv, ct: rec.ct}).then(function(b64){
        return {id: rec.id, name: rec.name, type: rec.type, size: rec.size, addedAt: rec.addedAt, blob: base64ToBlob(b64, rec.type)};
      });
    }
    return rec;
  });
}
function listAllAttachments(){
  return openAttachmentDb().then(function(db){
    return new Promise(function(resolve, reject){
      var tx = db.transaction(ATT_STORE, 'readonly');
      var req = tx.objectStore(ATT_STORE).getAll();
      req.onsuccess = function(){ resolve(req.result || []); };
      req.onerror = function(){ reject(req.error); };
    });
  });
}

/* Fetches an attachment's real bytes and saves them to disk under
   their original name — used by the ⬇ button on inline images/files
   and by the Attachments browser in the sidebar (including for
   attachments no longer referenced from any page, as a last chance
   to grab a copy before deleting them for good). */
function downloadAttachment(id, name){
  getAttachment(id).then(function(rec){
    if(!rec){ toast('Not available on this device.'); return; }
    var url = URL.createObjectURL(rec.blob);
    var a = document.createElement('a');
    a.href = url; a.download = name || rec.name || 'download';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 4000);
  }).catch(function(err){
    toast('Could not download that file' + (err && err.message ? (': ' + err.message) : '.'));
  });
}

function blobToBase64(blob){
  return blob.arrayBuffer().then(function(buf){
    var bytes = new Uint8Array(buf), binary = "", chunk = 0x8000;
    for(var i=0;i<bytes.length;i+=chunk){ binary += String.fromCharCode.apply(null, bytes.subarray(i, i+chunk)); }
    return btoa(binary);
  });
}
function base64ToBlob(b64, type){
  var binary = atob(b64);
  var bytes = new Uint8Array(binary.length);
  for(var i=0;i<binary.length;i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], {type: type || 'application/octet-stream'});
}

/* ---- Hydration: fills in the real src/href for every {{img:}}/{{file:}}
   placeholder that shows up in the DOM, however it got there (view mode
   innerHTML, edit-mode contenteditable nodes, query embeds, backlinks…),
   without every render call site needing to know about attachments. ---- */
function applyAttachmentUrl(node, url){
  if(node.classList.contains('att-img-el')) node.src = url;
  else if(node.classList.contains('att-file-link')){
    node.href = url;
    /* Blob URLs carry no filename of their own — without `download`,
       browsers are free to just navigate to/preview the blob (and if
       the user does manually save it, it lands under a meaningless
       generated name). Setting it here guarantees a real Save-As with
       the original name, straight from the link itself. */
    var wrap = node.closest('.att-file');
    node.setAttribute('download', (wrap && wrap.dataset.attName) || node.textContent || 'file');
  }
}
function markAttachmentMissing(node){
  if(node.classList.contains('att-img-el')){
    var wrap = node.closest('.att-img'); if(wrap) wrap.classList.add('att-missing');
    node.title = 'Not available on this device';
  } else if(node.classList.contains('att-file-link')){
    var wrap2 = node.closest('.att-file'); if(wrap2) wrap2.classList.add('att-missing');
    node.title = 'Not available on this device';
  }
}
function hydrateAttachmentNode(node){
  if(node.dataset.hydrated) return;
  node.dataset.hydrated = '1';
  var id = node.dataset.attId;
  if(!id) return;
  var cached = attObjectUrlCache[id];
  if(cached === 'missing'){ markAttachmentMissing(node); return; }
  if(cached){ applyAttachmentUrl(node, cached); return; }
  getAttachment(id).then(function(rec){
    if(!rec){ attObjectUrlCache[id] = 'missing'; markAttachmentMissing(node); return; }
    var url = URL.createObjectURL(rec.blob);
    attObjectUrlCache[id] = url;
    applyAttachmentUrl(node, url);
  }).catch(function(){ attObjectUrlCache[id] = 'missing'; markAttachmentMissing(node); });
}
function scanForAttachments(root){
  if(!root || !root.querySelectorAll) return;
  if(root.matches && root.matches('[data-att-id]')) hydrateAttachmentNode(root);
  root.querySelectorAll('[data-att-id]:not([data-hydrated])').forEach(hydrateAttachmentNode);
}
var attObserver = new MutationObserver(function(mutations){
  mutations.forEach(function(mut){
    mut.addedNodes.forEach(function(n){ if(n.nodeType === 1) scanForAttachments(n); });
  });
});
attObserver.observe(document.getElementById('app'), {childList:true, subtree:true});

/* ---- Insert flow: the dock's 📎 button reads a file, stores its blob,
   and drops a {{img:…}}/{{file:…}} reference at the caret (or appends it
   to the block if that block isn't actively being edited right now). ---- */
var ATTACHMENT_WARN_BYTES = 8 * 1024 * 1024;
function insertAttachmentMarkupAtCaret(markup, isImage){
  var editingEl = document.querySelector('.block-content.editing');
  if(editingEl && dockBlockId && editingBlockId === dockBlockId){
    var node = isImage ? buildImageNode(markup.slice(markup.indexOf(':')+1, -2)) : buildFileNode(markup.slice(markup.indexOf(':')+1, -2));
    var sel = window.getSelection();
    var range;
    if(sel.rangeCount && editingEl.contains(sel.getRangeAt(0).commonAncestorContainer)) range = sel.getRangeAt(0);
    else { range = document.createRange(); range.selectNodeContents(editingEl); range.collapse(false); }
    range.deleteContents();
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges(); sel.addRange(range);
    var b = state.blocks[dockBlockId];
    if(b){ b.text = serializeInline(editingEl); save(); }
  } else if(dockBlockId){
    var b2 = state.blocks[dockBlockId];
    if(b2){
      b2.text = (b2.text ? b2.text + ' ' : '') + markup;
      save(); renderPage();
    }
  } else {
    toast('Tap a line first, then add an attachment.');
  }
}
function addAttachmentToBlock(file){
  if(!dockBlockId){ toast('Tap a line first, then add an attachment.'); return; }
  if(file.size > ATTACHMENT_WARN_BYTES){
    toast('Adding a large file (' + Math.round(file.size/1024/1024) + 'MB) — large attachments add up fast in on-device storage.');
  }
  var id = 'att' + uid();
  var isImage = file.type.indexOf('image/') === 0;
  var record = {id: id, name: file.name, type: file.type || 'application/octet-stream', size: file.size, addedAt: Date.now(), blob: file};
  putAttachment(record).then(function(){
    var safeName = (file.name || (isImage ? 'image' : 'file')).replace(/[{}]/g, '');
    var markup = (isImage ? '{{img:' : '{{file:') + id + '|' + safeName + '}}';
    insertAttachmentMarkupAtCaret(markup, isImage);
    updateStorageHint();
    renderAttachmentsSection();
    toast((isImage ? 'Image' : 'File') + ' added.');
  }).catch(function(err){
    toast('Could not store that file' + (err && err.message ? (': ' + err.message) : '.'));
  });
}
document.getElementById('dock-attach-btn').onclick = function(){
  if(!dockBlockId){ toast('Tap a line first, then add an attachment.'); return; }
  document.getElementById('attach-file-input').click();
};
document.getElementById('attach-file-input').addEventListener('change', function(e){
  var files = Array.prototype.slice.call(e.target.files || []);
  e.target.value = ""; /* so picking the same file again still fires change */
  files.forEach(addAttachmentToBlock);
});

