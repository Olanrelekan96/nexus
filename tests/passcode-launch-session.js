const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { webcrypto } = require('crypto');

const root = path.join(__dirname, '..');
const securitySource = fs.readFileSync(path.join(root, 'js', '09-security-lock.js'), 'utf8');

function makeContext(shared) {
  const clock = shared && shared.clock ? shared.clock : {now:1700000000000};
  const storage = shared ? shared.localStorage : {};
  const session = shared ? shared.sessionStorage : {};
  const elements = {};
  function element(){
    return {style:{},value:'',textContent:'',disabled:false,dataset:{},
      addEventListener:()=>{},focus:()=>{},click:()=>{},
      classList:{add:()=>{},remove:()=>{},contains:()=>false,toggle:()=>{}}};
  }
  const documentStub = {
    visibilityState:'visible',
    getElementById:id => (elements[id] ||= element()),
    querySelector:()=>null,
    querySelectorAll:()=>[],
    addEventListener:()=>{},
    createRange:()=>({})
  };
  class MutationObserverStub { constructor(){ } observe(){} disconnect(){} }
  const ctx = {
    console, Promise, JSON, Math, Date, Uint8Array, Array, Object, String, Number, Error,
    TextEncoder, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval, MutationObserver:MutationObserverStub,
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    crypto: webcrypto,
    localStorage: {
      getItem:k=>Object.prototype.hasOwnProperty.call(storage,k)?storage[k]:null,
      setItem:(k,v)=>{storage[k]=String(v)},
      removeItem:k=>{delete storage[k]}
    },
    sessionStorage: {
      getItem:k=>Object.prototype.hasOwnProperty.call(session,k)?session[k]:null,
      setItem:(k,v)=>{session[k]=String(v)},
      removeItem:k=>{delete session[k]}
    },
    currentSettings: {passcodeReentryHours:'1', passcodeRequestOnLaunch:'off'},
    STORAGE_KEY:'nexus',
    appLocked:false,
    document:documentStub,
    window:{addEventListener:()=>{}, getSelection:()=>({})},
    navigator:{},
  };
  Object.defineProperty(ctx.Date, 'now', {value:()=>clock.now});
  ctx.__advance = ms => { clock.now += ms; };
  ctx.__now = () => clock.now;
  ctx.__storage = storage;
  ctx.__session = session;
  vm.createContext(ctx);
  vm.runInContext(securitySource, ctx, {filename:'09-security-lock.js'});
  return ctx;
}

(async()=>{
  const shared = {localStorage:{}, sessionStorage:{}, clock:{now:1700000000000}};
  const ctx = makeContext(shared);
  const dek = await webcrypto.subtle.generateKey({name:'AES-GCM',length:256}, true, ['encrypt','decrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await webcrypto.subtle.encrypt({name:'AES-GCM',iv}, dek, new TextEncoder().encode('nexus-unlock-ok'));
  const b64 = b=>Buffer.from(new Uint8Array(b)).toString('base64');
  ctx.lockCryptoKey = dek;
  ctx.saveLockMeta({version:2, verifier:{iv:b64(iv), ct:b64(ct)}});
  ctx.passcodeUnlockedAt = ctx.__now();
  const deadline = ctx.passcodeUnlockedAt + ctx.passcodeReentryMs();
  ctx.persistPasscodeReentryState(ctx.passcodeUnlockedAt, deadline);
  assert.strictEqual(ctx.passcodeRequestOnLaunch(), false);
  assert.strictEqual(await ctx.persistPasscodeSessionKey(), true, 'launch-off should persist session key');
  assert.ok(shared.sessionStorage[ctx.PASSCODE_SESSION_KEY], 'session DEK should be present');

  // Same-tab reload: same sessionStorage + same localStorage, new JS context.
  const reload = makeContext(shared);
  reload.lockCryptoKey = null;
  assert.strictEqual(reload.passcodeRequestOnLaunch(), false);
  const restored = await reload.restorePasscodeSessionKey();
  assert.strictEqual(restored, true, 'launch-off should restore the same-tab session key');
  assert.ok(reload.lockCryptoKey, 'restored DEK should be available');
  const sameVerifier = await reload.decryptWithKey(reload.lockCryptoKey, reload.loadLockMeta().verifier);
  assert.strictEqual(sameVerifier, 'nexus-unlock-ok', 'restored DEK must decrypt the lock verifier');

  // Launch prompt ON must clear the remembered session and force a normal lock path.
  reload.currentSettings.passcodeRequestOnLaunch = 'on';
  await reload.updatePasscodeLaunchSessionPolicy();
  assert.strictEqual(shared.sessionStorage[reload.PASSCODE_SESSION_KEY], undefined, 'launch-on should clear remembered session key');
  assert.strictEqual(reload.passcodeRequestOnLaunch(), true);

  // Expired same-tab session must no longer restore even while launch prompt is OFF.
  ctx.currentSettings.passcodeRequestOnLaunch = 'off';
  await ctx.persistPasscodeSessionKey();
  ctx.__advance(ctx.passcodeReentryMs() + 1000);
  const expired = makeContext(shared);
  expired.currentSettings.passcodeRequestOnLaunch = 'off';
  assert.strictEqual(await expired.restorePasscodeSessionKey(), false, 'expired session must require passcode');
  console.log('Passcode launch-session policy test passed: launch off restores same-tab unlock; launch on clears it; expired sessions are rejected.');
})().catch(err=>{ console.error(err); process.exit(1); });
