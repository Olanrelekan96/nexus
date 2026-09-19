'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const jsDir = path.join(root, 'js');

function makeClassList(){
  const set = new Set();
  return { add:c=>set.add(c), remove:c=>set.delete(c), toggle:(c,on)=>on===undefined ? (set.has(c)?set.delete(c):set.add(c)) : (on?set.add(c):set.delete(c)), contains:c=>set.has(c) };
}
function makeElement(id, dataset){
  const handlers = {};
  return {
    id, style:{display:'', opacity:''}, dataset:dataset||{}, classList:makeClassList(),
    value:'', textContent:'', disabled:false, handlers,
    addEventListener(type, fn){ (handlers[type] ||= []).push(fn); },
    removeEventListener(){}, click(){ (this.onclick||(()=>{}))({target:this}); (handlers.click||[]).forEach(fn=>fn({target:this})); },
    focus(){}, setAttribute(){}, getAttribute(){return null;}, querySelectorAll(){return []},
    matches(){return false}, closest(){return null}, contains(){return false}
  };
}

const els = {};
function getEl(id){ return els[id] ||= makeElement(id); }
const reentryButtons = ['1','6','12','24'].map(v=>makeElement('reentry-'+v,{passcodereentry:v}));
els['settings-passcodereentry-row'] = makeElement('settings-passcodereentry-row');
els['settings-passcodereentry-row'].querySelectorAll = () => reentryButtons;
const selectors = {
  '#settings-theme-row .settings-opt':[makeElement('theme',{theme:'paper'})],
  '#settings-textsize-row .settings-opt':[makeElement('textsize',{textsize:'medium'})],
  '#settings-defaultview-row .settings-opt':[makeElement('view',{defaultview:'outline'})],
  '#settings-spellcheck-row .settings-opt':[makeElement('spell',{spellcheck:'on'})],
  '#settings-backupdays-row .settings-opt':[makeElement('backupdays',{backupdays:'7'})],
  '#settings-autobackup-row .settings-opt':[makeElement('autobackup',{autobackup:'off'})],
  '#settings-confirmtrash-row .settings-opt':[makeElement('confirmtrash',{confirmtrash:'off'})],
  '#settings-gdriveautosync-row .settings-opt':[makeElement('gdrive',{gdriveautosync:'off'})],
  '#settings-passcodereentry-row .settings-opt':reentryButtons,
  '.block-content, .prop-key, .prop-val':[]
};

const local = {};
let fakeNow = 1700000000000;
function FakeDate(...args){ return new global.Date(...args); }
FakeDate.now = () => fakeNow;
const document = {
  documentElement:{setAttribute(){}}, body:getEl('body'), visibilityState:'visible',
  getElementById:getEl, querySelectorAll:(sel)=>selectors[sel]||[], querySelector:()=>null,
  addEventListener(){}, createElement:()=>makeElement('created')
};

let timerDelay = null;
const ctx = {
  console, document,
  window:{matchMedia:()=>({matches:false}), addEventListener(){}},
  navigator:{clipboard:null}, localStorage:{getItem:k=>local[k]??null,setItem:(k,v)=>{local[k]=v},removeItem:k=>{delete local[k]}},
  STORAGE_KEY:'nexus_state', LOCK_KEY:'nexus_lock',
  setTimeout:(fn,delay)=>{timerDelay=delay; return 1}, clearTimeout(){},
  setInterval:()=>1, clearInterval(){}, Date:FakeDate,
  Promise, JSON, Math, Number, String, Array, Object, RegExp, Error, Uint8Array,
  MutationObserver: class { observe(){} disconnect(){} },
  URL, Blob, atob:()=>'', btoa:()=>'',
  updateBackupBanner(){}, applySpellcheckToDom(){}, updateAutoBackupStatusUI(){}, maybeRunAutoBackup(){},
  saveSettings(){}, toast(){}, setDataHealthStatus(){}, setSidebarCollapsed(){}, appLocked:false
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(jsDir,'07-find-replace-settings.js'),'utf8'), ctx, {filename:'07-find-replace-settings.js'});
vm.runInContext(fs.readFileSync(path.join(jsDir,'09-security-lock.js'),'utf8'), ctx, {filename:'09-security-lock.js'});

local.nexus_state_lock = JSON.stringify({version:2, wrappedDEK:'x'});
ctx.lockCryptoKey = {};
ctx.appLocked = false;
ctx.refreshLockSessionTimer();
assert.strictEqual(ctx.currentSettings.passcodeReentryHours, '24');
assert.strictEqual(timerDelay, 24*60*60*1000);

reentryButtons[0].click();
assert.strictEqual(ctx.currentSettings.passcodeReentryHours, '1', 'Settings click must change the live interval setting');
assert.ok(timerDelay >= 60*60*1000-5 && timerDelay <= 60*60*1000+5, '1-hour selection must reschedule the live timer');
assert.ok(ctx.loadPasscodeReentryDeadline() - fakeNow >= 60*60*1000-5, '1-hour deadline must be persisted');

getEl('settings-overlay').style.display = 'flex';
getEl('passcode-overlay').style.display = 'flex';
getEl('recovery-unlock-overlay').style.display = 'flex';
getEl('recovery-show-overlay').style.display = 'flex';
fakeNow += 60*60*1000 + 1;
ctx.enforcePasscodeReentry();
assert.strictEqual(ctx.appLocked, true, 'Expired interval must reach the real lock path');
for (const id of ['settings-overlay','passcode-overlay','recovery-unlock-overlay','recovery-show-overlay']) {
  assert.strictEqual(getEl(id).style.display, 'none', `${id} must close when the app locks`);
}

console.log('Passcode integration test passed: Settings → interval timer → expiry → lock, with overlay cleanup.');
