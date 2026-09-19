/* ============================================================
 * 07-find-replace-settings.js
 * Find & replace across all pages/blocks, and the Settings panel.
 *
 * Part of Nexus — loaded as a plain <script> (not a module) in
 * index.html, in numeric filename order. All files share one global
 * scope on purpose (same as the original single-file build), so
 * `state`, helper functions, etc. declared in an earlier file are
 * directly usable here without imports.
 * ============================================================ */
"use strict";

/* ============================================================
   FIND & REPLACE (across every block, every page)
   ============================================================ */
function openFindReplace(){
  document.getElementById('fr-find').value = "";
  document.getElementById('fr-replace').value = "";
  document.getElementById('fr-case').checked = false;
  document.getElementById('fr-preview').textContent = "";
  document.getElementById('findreplace-overlay').style.display = 'flex';
  setTimeout(function(){ document.getElementById('fr-find').focus(); }, 0);
}
function closeFindReplace(){
  document.getElementById('findreplace-overlay').style.display = 'none';
}
function countMatches(find, caseSensitive){
  if(!find) return 0;
  var n = 0;
  Object.keys(state.blocks).forEach(function(id){
    var text = state.blocks[id].text || "";
    var hay = caseSensitive ? text : text.toLowerCase();
    var needle = caseSensitive ? find : find.toLowerCase();
    var idx = 0;
    while((idx = hay.indexOf(needle, idx)) !== -1){ n++; idx += needle.length; }
  });
  return n;
}
function updateFrPreview(){
  var find = document.getElementById('fr-find').value;
  var cs = document.getElementById('fr-case').checked;
  var el = document.getElementById('fr-preview');
  if(!find){ el.textContent = ""; return; }
  var n = countMatches(find, cs);
  el.textContent = n ? (n + ' match' + (n===1?'':'es') + ' found across your notebook.') : 'No matches found.';
}
function applyFindReplace(){
  var find = document.getElementById('fr-find').value;
  var replace = document.getElementById('fr-replace').value;
  var cs = document.getElementById('fr-case').checked;
  if(!find) return;
  var total = countMatches(find, cs);
  if(!total){ toast('No matches found.'); return; }
  if(!confirm('Replace ' + total + ' occurrence' + (total===1?'':'s') + ' of "' + find + '" with "' + replace + '" across your whole notebook? A snapshot will be saved first.')) return;
  snapshotVersion('before find & replace');
  var re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), cs ? 'g' : 'gi');
  Object.keys(state.blocks).forEach(function(id){
    var b = state.blocks[id];
    if(blockIsLocked(b)) return; /* a lock has to hold here too, not just in the editor */
    re.lastIndex = 0;
    if(b.text && re.test(b.text)){
      re.lastIndex = 0;
      b.text = b.text.replace(re, replace);
    }
  });
  save();
  renderAll();
  closeFindReplace();
  toast('Replaced ' + total + ' occurrence' + (total===1?'':'s') + '.');
}

function isNarrowViewport(){ return window.matchMedia('(max-width:860px)').matches; }
function syncSidebarToggleControl(){
  var btn=document.getElementById('expand-btn');
  var app=document.getElementById('app');
  if(!btn || !app) return;
  var collapsed=app.classList.contains('sidebar-collapsed');
  var mobile=isNarrowViewport();
  if(mobile){
    btn.textContent=collapsed ? '☰' : '«';
    btn.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    btn.setAttribute('title', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    btn.setAttribute('aria-expanded', String(!collapsed));
  }else{
    btn.textContent='☰';
    btn.setAttribute('aria-label','Show sidebar');
    btn.setAttribute('title','Show sidebar');
    btn.setAttribute('aria-expanded','false');
  }
}
function setSidebarCollapsed(collapsed){
  document.getElementById('app').classList.toggle('sidebar-collapsed', collapsed);
  try{ localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0'); }catch(e){}
  syncSidebarToggleControl();
}
document.getElementById('collapse-btn').onclick = function(){ setSidebarCollapsed(true); };
document.getElementById('expand-btn').onclick = function(){
  var app=document.getElementById('app');
  var collapsed=app && app.classList.contains('sidebar-collapsed');
  setSidebarCollapsed(!collapsed);
};
document.getElementById('sidebar-backdrop').onclick = function(){ setSidebarCollapsed(true); };
(function(){
  var saved = null;
  try{ saved = localStorage.getItem(SIDEBAR_KEY); }catch(e){}
  if(saved === '1') setSidebarCollapsed(true);
  else if(saved === null && isNarrowViewport()){
    /* First visit, no stored preference: on a phone-width screen the
       sidebar is a full-width drawer, so start with it closed rather
       than covering the whole page. Don't persist this guess — it's
       just the opening state, not a chosen preference. */
    document.getElementById('app').classList.add('sidebar-collapsed');
  }
})();
syncSidebarToggleControl();
/* Closes the drawer after navigating away from it on a narrow
   screen, so tapping a page/section doesn't leave the sidebar open
   on top of the content it just switched to. */
function closeSidebarIfNarrow(){
  if(isNarrowViewport()) setSidebarCollapsed(true);
}
window.addEventListener('resize', syncSidebarToggleControl);
window.addEventListener('orientationchange', function(){ setTimeout(syncSidebarToggleControl, 0); });
document.addEventListener('keydown', function(e){
  if((e.key === 'b' || e.key === 'B') && (e.metaKey || e.ctrlKey)){
    e.preventDefault();
    var collapsed = document.getElementById('app').classList.contains('sidebar-collapsed');
    setSidebarCollapsed(!collapsed);
  }
});

/* ============================================================
   SETTINGS
   Each row in the modal maps to one key in `currentSettings` via a
   data-* attribute (e.g. data-theme -> settings.theme). SETTINGS_ROWS
   below is the single source of truth for that mapping, so adding a
   new setting is just: add a row to the HTML + an entry here.
   ============================================================ */
var SETTINGS_KEY = STORAGE_KEY + '_settings';
var SETTINGS_DEFAULTS = {
  theme: 'paper',
  textSize: 'medium',
  defaultPageView: 'outline',
  spellcheck: 'on',
  backupReminderDays: '7',
  confirmTrash: 'off',
  autoBackupInterval: 'off',
  gdriveAutoSync: 'off',
  passcodeReentryHours: '24',
  passcodeRequestOnLaunch: 'on'
};
/* [rowId, data-attribute name, settings key] */
var SETTINGS_ROWS = [
  ['settings-theme-row', 'theme', 'theme'],
  ['settings-textsize-row', 'textsize', 'textSize'],
  ['settings-defaultview-row', 'defaultview', 'defaultPageView'],
  ['settings-spellcheck-row', 'spellcheck', 'spellcheck'],
  ['settings-backupdays-row', 'backupdays', 'backupReminderDays'],
  ['settings-autobackup-row', 'autobackup', 'autoBackupInterval'],
  ['settings-confirmtrash-row', 'confirmtrash', 'confirmTrash'],
  ['settings-gdriveautosync-row', 'gdriveautosync', 'gdriveAutoSync'],
  ['settings-passcodereentry-row', 'passcodereentry', 'passcodeReentryHours'],
  ['settings-passcode-launch-row', 'passcoderequest', 'passcodeRequestOnLaunch']
];
SETTINGS_ROWS.filter(function(r){ return r[0] === 'settings-autobackup-row'; }).forEach(function(row){
  Array.prototype.slice.call(document.querySelectorAll('#'+row[0]+' .settings-opt')).forEach(function(btn){
    btn.addEventListener('click', function(){ updateAutoBackupStatusUI(); maybeRunAutoBackup(); });
  });
});

function loadSettings(){
  try{
    var raw = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    if(raw && typeof raw === 'object') return Object.assign({}, SETTINGS_DEFAULTS, raw);
  }catch(e){}
  return Object.assign({}, SETTINGS_DEFAULTS);
}
function saveSettings(settings){
  try{ localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }catch(e){}
}

/* Live-updates spellcheck on whatever's already rendered, so toggling
   the setting takes effect immediately without needing a full
   re-render of the current page. */
function applySpellcheckToDom(settings){
  var sc = settings.spellcheck !== 'off';
  var titleEl = document.getElementById('page-title');
  if(titleEl) titleEl.spellcheck = sc;
  Array.prototype.slice.call(document.querySelectorAll('.block-content, .prop-key, .prop-val')).forEach(function(el){
    el.spellcheck = sc;
  });
}

var NEXUS_THEME_META_COLORS = {
  paper:'#F6F4EE', dark:'#111613', slate:'#F4F7FA', sepia:'#F5ECDF', ocean:'#EAF4F6', rose:'#FBF0EF', contrast:'#FFFFFF', midnight:'#0B0F1A',
  aurora:'#09131A', amethyst:'#F7F3FB', meadow:'#EEF7F0', ember:'#17110F'
};
function applySettings(settings){
  document.documentElement.setAttribute('data-theme', settings.theme);
  var themeMeta = document.querySelector('meta[name="theme-color"]');
  if(themeMeta) themeMeta.setAttribute('content', NEXUS_THEME_META_COLORS[settings.theme] || NEXUS_THEME_META_COLORS.paper);
  document.documentElement.setAttribute('data-textsize', settings.textSize);
  applySpellcheckToDom(settings);
  SETTINGS_ROWS.forEach(function(row){
    var rowId = row[0], attr = row[1], key = row[2];
    Array.prototype.slice.call(document.querySelectorAll('#'+rowId+' .settings-opt')).forEach(function(btn){
      btn.classList.toggle('active', btn.dataset[attr] === String(settings[key]));
    });
  });
  updateBackupBanner();
}
var currentSettings = loadSettings();
applySettings(currentSettings);

function openSettings(){
  applySettings(currentSettings);
  refreshLockSettingsUI();
  updateAutoBackupStatusUI();
  document.getElementById('settings-overlay').style.display = 'flex';
}
function closeSettings(){
  document.getElementById('settings-overlay').style.display = 'none';
}
document.getElementById('btn-settings').onclick = openSettings;
document.getElementById('settings-close').onclick = closeSettings;
document.getElementById('settings-overlay').addEventListener('click', function(e){
  if(e.target.id === 'settings-overlay') closeSettings();
});

/* ---- Passcode lock settings UI ---- */
var pcMode = 'set'; /* 'set' | 'change' | 'remove' */
function refreshLockSettingsUI(){
  var meta = loadLockMeta();
  var on = !!meta;
  document.getElementById('lock-status-text').textContent = on
    ? 'On — your notes are encrypted at rest and require a passcode to open.'
    : 'Off — your notes are stored on this device without encryption.';
  document.getElementById('btn-set-passcode').style.display = on ? 'none' : '';
  document.getElementById('btn-change-passcode').style.display = on ? '' : 'none';
  document.getElementById('btn-lock-now').style.display = on ? '' : 'none';
  document.getElementById('btn-remove-passcode').style.display = on ? '' : 'none';
  var launchRow = document.getElementById('settings-passcode-launch-row');
  if(launchRow){
    launchRow.style.opacity = on ? '1' : '.55';
    Array.prototype.slice.call(launchRow.querySelectorAll('.settings-opt')).forEach(function(btn){ btn.disabled = !on; });
  }
  var reentryRow = document.getElementById('settings-passcodereentry-row');
  if(reentryRow){
    reentryRow.style.opacity = on ? '1' : '.55';
    Array.prototype.slice.call(reentryRow.querySelectorAll('.settings-opt')).forEach(function(btn){ btn.disabled = !on; });
  }
  var launchStatus = document.getElementById('passcode-launch-status');
  if(launchStatus){
    launchStatus.textContent = !on
      ? 'Set a passcode first. This option becomes available when encryption is enabled.'
      : (currentSettings.passcodeRequestOnLaunch === 'on'
        ? 'On — a fresh Nexus launch asks for your passcode. The re-entry interval remains an in-session timer.'
        : 'Off — Nexus can resume the unlocked session on reload in this browser tab. The selected 1/6/12/24-hour interval still forces a passcode when it expires.');
  }
  if(typeof updatePasscodeReentryStatus === 'function') updatePasscodeReentryStatus();
  var hasRecovery = on && !!meta.wrappedDEKRecovery;
  document.getElementById('btn-regen-recovery').style.display = hasRecovery ? '' : 'none';
  var recEl = document.getElementById('recovery-status-text');
  recEl.style.display = on ? '' : 'none';
  recEl.textContent = hasRecovery
    ? 'A recovery key was saved when your passcode was set — use it if you ever forget your passcode.'
    : 'No recovery key yet for this passcode — unlocking or changing it once will add one.';
}
function openPasscodeModal(mode){
  pcMode = mode;
  document.getElementById('pc-current').value = '';
  document.getElementById('pc-new').value = '';
  document.getElementById('pc-confirm').value = '';
  document.getElementById('pc-error').textContent = '';
  var showCurrent = mode === 'change' || mode === 'remove' || mode === 'regen-recovery';
  var showNew = mode === 'set' || mode === 'change' || mode === 'reset';
  document.getElementById('pc-current-row').style.display = showCurrent ? '' : 'none';
  document.getElementById('pc-new-row').style.display = showNew ? '' : 'none';
  document.getElementById('pc-confirm-row').style.display = showNew ? '' : 'none';
  document.getElementById('pc-cancel').style.display = mode === 'reset' ? 'none' : '';
  document.getElementById('pc-title').textContent =
    mode === 'set' ? 'Set a passcode' :
    mode === 'change' ? 'Change passcode' :
    mode === 'reset' ? 'Set a new passcode' :
    mode === 'regen-recovery' ? 'Regenerate recovery key' : 'Remove passcode';
  document.getElementById('pc-submit').textContent =
    mode === 'set' ? 'Enable passcode' :
    mode === 'change' ? 'Change passcode' :
    mode === 'reset' ? 'Set passcode' :
    mode === 'regen-recovery' ? 'Regenerate' : 'Remove passcode';
  document.getElementById('pc-note').textContent =
    mode === 'remove' ? 'This decrypts your notes and stores them on this device without a passcode from then on.' :
    mode === 'reset' ? "You're back in with your recovery key. Choose a new passcode — your recovery key will keep working with it." :
    mode === 'regen-recovery' ? 'This replaces your recovery key. Your old recovery key will stop working, and the new one is shown only once.' :
    "This encrypts your notes at rest with a key derived from your passcode. You'll get a recovery key afterward — save it somewhere safe, since it's the only other way back in if you forget your passcode.";
  document.getElementById('passcode-overlay').style.display = 'flex';
  setTimeout(function(){ document.getElementById(showCurrent ? 'pc-current' : 'pc-new').focus(); }, 50);
}
function closePasscodeModal(){
  document.getElementById('passcode-overlay').style.display = 'none';
}
document.getElementById('btn-set-passcode').onclick = function(){ openPasscodeModal('set'); };
document.getElementById('btn-change-passcode').onclick = function(){ openPasscodeModal('change'); };
document.getElementById('btn-remove-passcode').onclick = function(){ openPasscodeModal('remove'); };
document.getElementById('btn-regen-recovery').onclick = function(){ openPasscodeModal('regen-recovery'); };
document.getElementById('btn-lock-now').onclick = function(){ lockNow(); };
document.getElementById('pc-cancel').onclick = closePasscodeModal;
document.getElementById('passcode-overlay').addEventListener('click', function(e){
  if(e.target.id === 'passcode-overlay' && pcMode !== 'reset') closePasscodeModal();
});
document.getElementById('pc-submit').onclick = function(){
  var errEl = document.getElementById('pc-error');
  errEl.textContent = '';
  var current = document.getElementById('pc-current').value;
  var next = document.getElementById('pc-new').value;
  var confirmVal = document.getElementById('pc-confirm').value;
  var btn = document.getElementById('pc-submit');

  if(pcMode === 'set' || pcMode === 'change' || pcMode === 'reset'){
    if(next.length < MIN_PASSCODE_LENGTH){ errEl.textContent = 'Use at least ' + MIN_PASSCODE_LENGTH + ' characters.'; return; }
    if(next !== confirmVal){ errEl.textContent = "Passcodes don't match."; return; }
  }
  if(pcMode === 'regen-recovery' && !current){ errEl.textContent = 'Enter your current passcode.'; return; }

  btn.disabled = true;
  var task;
  if(pcMode === 'set'){
    task = setPasscode(next).then(function(recoveryCode){ return {ok:true, recoveryCode: recoveryCode}; });
  } else if(pcMode === 'change'){
    task = changePasscode(current, next);
  } else if(pcMode === 'reset'){
    task = rewrapPasscodeOnly(next).then(function(){ return {ok:true}; });
  } else if(pcMode === 'regen-recovery'){
    task = tryUnlock(current).then(function(res){
      if(!res.ok) return {ok:false};
      return regenerateRecoveryCode().then(function(code){ return {ok:true, recoveryCode: code}; });
    });
  } else {
    task = removePasscodeConfirmed(current).then(function(ok){ return {ok: ok}; });
  }
  task.then(function(result){
    btn.disabled = false;
    if(!result || !result.ok){ errEl.textContent = 'Current passcode is incorrect.'; return; }
    var wasReset = pcMode === 'reset';
    closePasscodeModal();
    refreshLockSettingsUI();
    if(wasReset){
      hideLockScreen();
      if(!state) bootNotebook();
    }
    if(result.recoveryCode){
      openRecoveryShowModal(result.recoveryCode);
    } else {
      if(pcMode === 'set' || pcMode === 'change' || pcMode === 'reset' || pcMode === 'remove') refreshLockSessionTimer();
      toast(pcMode === 'set' ? 'Passcode set. Your notes are now encrypted on this device.'
        : pcMode === 'change' ? 'Passcode changed.'
        : pcMode === 'reset' ? "Passcode set. You're back in."
        : pcMode === 'regen-recovery' ? 'Recovery key regenerated.' : 'Passcode removed.');
    }
  }).catch(function(){
    btn.disabled = false;
    errEl.textContent = 'Something went wrong — try again.';
  });
};
document.getElementById('lock-forgot').onclick = function(){
  var meta = loadLockMeta();
  if(meta && meta.wrappedDEKRecovery){ openRecoveryUnlockModal(); }
  else{ eraseAndStartOver(); }
};

/* ---- Recovery-key modals ---- */
function openRecoveryUnlockModal(){
  document.getElementById('recovery-input').value = '';
  document.getElementById('recovery-unlock-error').textContent = '';
  document.getElementById('recovery-unlock-overlay').style.display = 'flex';
  setTimeout(function(){ document.getElementById('recovery-input').focus(); }, 50);
}
function closeRecoveryUnlockModal(){
  document.getElementById('recovery-unlock-overlay').style.display = 'none';
}
document.getElementById('recovery-unlock-cancel').onclick = closeRecoveryUnlockModal;
document.getElementById('recovery-unlock-overlay').addEventListener('click', function(e){
  if(e.target.id === 'recovery-unlock-overlay') closeRecoveryUnlockModal();
});
document.getElementById('recovery-unlock-erase-instead').onclick = function(){
  closeRecoveryUnlockModal();
  eraseAndStartOver();
};
document.getElementById('recovery-unlock-submit').onclick = function(){
  var input = document.getElementById('recovery-input');
  var errEl = document.getElementById('recovery-unlock-error');
  var btn = document.getElementById('recovery-unlock-submit');
  var code = input.value;
  if(!code.trim()){ errEl.textContent = 'Enter your recovery key.'; return; }
  btn.disabled = true;
  tryUnlockWithRecovery(code).then(function(ok){
    btn.disabled = false;
    if(!ok){ errEl.textContent = 'That recovery key is incorrect.'; return; }
    /* Recovery unlock is an unlocked session too. Start the same elapsed
       re-entry clock immediately; resetting/changing the passcode below
       restarts the interval after confirmation. */
    if(typeof refreshLockSessionTimer === 'function') refreshLockSessionTimer();
    closeRecoveryUnlockModal();
    openPasscodeModal('reset');
  });
};
document.getElementById('recovery-input').addEventListener('keydown', function(e){
  if(e.key === 'Enter') document.getElementById('recovery-unlock-submit').click();
});

function openRecoveryShowModal(code){
  document.getElementById('recovery-code-display').textContent = code;
  document.getElementById('recovery-saved-check').checked = false;
  document.getElementById('recovery-show-done').disabled = true;
  document.getElementById('recovery-show-overlay').style.display = 'flex';
}
document.getElementById('recovery-saved-check').addEventListener('change', function(e){
  document.getElementById('recovery-show-done').disabled = !e.target.checked;
});
document.getElementById('recovery-copy-btn').onclick = function(){
  var text = document.getElementById('recovery-code-display').textContent;
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(function(){ toast('Recovery key copied.'); }).catch(function(){});
  }
};
document.getElementById('recovery-show-done').onclick = function(){
  document.getElementById('recovery-show-overlay').style.display = 'none';
};
SETTINGS_ROWS.forEach(function(row){
  var rowId = row[0], attr = row[1], key = row[2];
  Array.prototype.slice.call(document.querySelectorAll('#'+rowId+' .settings-opt')).forEach(function(btn){
    btn.onclick = function(){
      currentSettings[key] = btn.dataset[attr];
      saveSettings(currentSettings);
      applySettings(currentSettings);
    };
  });
});

/* The generic SETTINGS_ROWS handler saves the passcode interval; this
   listener also resets the current in-memory lock timer so changing the
   interval takes effect immediately. */
Array.prototype.slice.call(document.querySelectorAll('#settings-passcodereentry-row .settings-opt')).forEach(function(btn){
  btn.addEventListener('click', function(){
    setPasscodeReentry(btn.dataset.passcodereentry);
    refreshLockSettingsUI();
  });
});
Array.prototype.slice.call(document.querySelectorAll('#settings-passcode-launch-row .settings-opt')).forEach(function(btn){
  btn.addEventListener('click', function(){
    if(!loadLockMeta()) return;
    currentSettings.passcodeRequestOnLaunch = btn.dataset.passcoderequest === 'off' ? 'off' : 'on';
    saveSettings(currentSettings);
    applySettings(currentSettings);
    if(typeof updatePasscodeLaunchSessionPolicy === 'function') updatePasscodeLaunchSessionPolicy();
    refreshLockSettingsUI();
    if(typeof setDataHealthStatus === 'function') setDataHealthStatus('saved', 'Passcode launch policy saved');
    if(typeof toast === 'function') toast(currentSettings.passcodeRequestOnLaunch === 'on'
      ? 'Nexus will request your passcode on a fresh launch.'
      : 'Nexus can resume this unlocked tab until the passcode interval expires.');
  });
});

/* Registered after the generic handler above (same click, later listener),
   so currentSettings.gdriveAutoSync already reflects the new value by the
   time this runs. */
Array.prototype.slice.call(document.querySelectorAll('#settings-gdriveautosync-row .settings-opt')).forEach(function(btn){
  btn.addEventListener('click', function(){
    if(currentSettings.gdriveAutoSync === 'on') enableGdriveAutoSync();
    else disableGdriveAutoSync();
  });
});

