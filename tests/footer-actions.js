const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

/* Browser-like smoke harness for the four critical sidebar footer actions.
   It intentionally starts with state=null so Sync Recovery must not render
   notebook statistics during the synchronous script-loading phase. */
const elements = Object.create(null);
function element(id){
  return elements[id] || (elements[id] = {
    id,
    style:{}, classList:{add(){},remove(){},toggle(){},contains(){return false}},
    dataset:{}, value:'', checked:false, disabled:false, textContent:'', innerHTML:'', children:[],
    focus(){}, appendChild(child){if(child)child.parentNode=this;}, setAttribute(){}, addEventListener(){}, querySelectorAll(){return []}, parentNode:null
  });
}
const docListeners = [];
const documentStub = {
  readyState:'complete', visibilityState:'visible',
  documentElement: element('html'), body: element('body'),
  getElementById: id => element(id), querySelectorAll:()=>[], querySelector:()=>element('meta'),
  createElement: tag => element(tag),
  addEventListener(type, fn, capture){ docListeners.push({type,fn,capture}); }
};
const storage = {getItem(){return null},setItem(){},removeItem(){}};
const windowStub = {innerWidth:1200, showDirectoryPicker:null, crypto:{randomUUID(){return 'test-id';}}, matchMedia(){return {matches:false,addEventListener(){}}}, addEventListener(){}};
const ctx = {
  console, document:documentStub, window:windowStub, localStorage:storage, sessionStorage:storage,
  STORAGE_KEY:'nexus_pkm_v1', state:null, MAX_VERSIONS:5,
  currentSettings:{theme:'paper',textSize:'medium',defaultPageView:'outline',spellcheck:'on',backupReminderDays:'7',confirmTrash:'off',autoBackupInterval:'off',gdriveAutoSync:'off',passcodeReentryHours:'24',passcodeRequestOnLaunch:'on'},
  loadMeta:()=>({}), updateBackupBanner(){}, loadVersions:()=>Promise.resolve([]),
  loadConflicts:()=>[], scanNexusDuplicateGroups:()=>[], livePages:()=>[],
  snapshotVersion:()=>Promise.resolve(), putVersion:()=>Promise.resolve(), deleteVersion:()=>Promise.resolve(),
  openAttachmentDb:()=>Promise.resolve({transaction(){return {objectStore(){return {get(){return {}}}}}}}),
  closeConflicts(){}, openConflicts(){}, openVersionsUpgraded(){}, closeVersions(){}, nexusBeforeSyncRecoverySnapshot(){}, applyIncomingMerge(){},
  loadLockMeta:()=>null, updatePasscodeReentryStatus(){}, isLockEnabled:()=>false, applySpellcheckToDom(){}, refreshLockSettingsUI(){}, updateAutoBackupStatusUI(){}, saveSettings(){},
  renderSyncCenter(){}, renderLanPeerList(){}, myDeviceName:()=> 'Test device', toast(){},
  setSidebarCollapsed(){}, save(){}, renderAll(){}, renderPage(){},
  confirm(){return true}, prompt(){return null}, alert(){}, URL:{createObjectURL(){return ''},revokeObjectURL(){}}, Blob:function(){},
  setTimeout(){return 1}, clearTimeout(){}, setInterval(){return 1}, clearInterval(){}, Date, JSON, Math, Promise, Uint8Array, innerWidth:1200, crypto:{randomUUID(){return 'test-id';}}, matchMedia(){return {matches:false,addEventListener(){}}}, addEventListener(){}
};
ctx.globalThis = ctx; windowStub.NexusCriticalActions = undefined; ctx.window = ctx;
for (const file of ['07-find-replace-settings.js','10-lan-sync.js','35-sync-recovery.js','36-footer-actions-repair.js']) {
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..','js',file),'utf8'), ctx, {filename:file});
}
assert.strictEqual(ctx.state, null, 'test should begin before async notebook load');
assert.strictEqual(typeof element('btn-settings').onclick, 'function', 'Settings must have a final click handler');
assert.strictEqual(typeof element('btn-find-replace').onclick, 'function', 'Find & replace must have a final click handler');
assert.strictEqual(typeof element('btn-sync-center').onclick, 'function', 'Sync cleanup must have a final click handler');
assert.strictEqual(typeof element('btn-sync').onclick, 'function', 'Sync devices must have a final click handler');

for (const [id, overlay] of [
  ['btn-settings','settings-overlay'],
  ['btn-find-replace','findreplace-overlay'],
  ['btn-sync-center','sync-center-overlay'],
  ['btn-sync','sync-overlay']
]) {
  element(overlay).style.display = 'none';
  assert.doesNotThrow(()=>element(id).onclick({}), `${id} should open without throwing`);
  assert.strictEqual(element(overlay).style.display, 'flex', `${id} should display its overlay`);
}


/* Real event-routing regression: simulate a click event whose target is the
   button after its direct property handler has been removed. The capture
   listener must still reach the action. */
for (const [id, overlay] of [
  ['btn-settings','settings-overlay'],
  ['btn-find-replace','findreplace-overlay'],
  ['btn-sync-center','sync-center-overlay'],
  ['btn-sync','sync-overlay']
]) {
  element(overlay).style.display='none';
  element(id).onclick = null;
  const ev = {target: element(id), __nexusCriticalHandled:false, preventDefault(){}};
  docListeners.filter(x=>x.type==='click' && x.capture).forEach(x=>x.fn(ev));
  assert.strictEqual(element(overlay).style.display, 'flex', `${id} capture router should open its overlay`);
}

console.log('Critical sidebar footer action test passed: Settings, Find & Replace, Sync cleanup & recovery, and Sync devices remain responsive during early/normal initialization.');
