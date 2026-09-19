'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
function read(rel){ return fs.readFileSync(path.join(root, rel), 'utf8'); }

function testOfflineFirstBootstrap(){
  const index = read('index.html');
  assert.ok(!/<script[^>]+src="https:\/\/accounts\.google\.com\/gsi\/client"/i.test(index), 'Google Identity SDK must not load at core startup');
  assert.ok(!/<script[^>]+src="https:\/\/apis\.google\.com\/js\/api\.js"/i.test(index), 'Google API SDK must not load at core startup');
  assert.ok(index.includes('try{\n    GOOGLE_DRIVE_CLIENT_ID = localStorage.getItem'), 'Drive credential bootstrap must tolerate storage access failure');

  const boot = index.match(/<script>\n  \/\* Google Drive is optional\.[\s\S]*?<\/script>/i);
  assert.ok(boot, 'Drive bootstrap script missing');
  const ctx = {
    localStorage: { getItem(){ throw new Error('storage blocked'); } },
    console
  };
  vm.createContext(ctx);
  vm.runInContext(boot[0].replace(/^<script>|<\/script>$/gi,''), ctx, {filename:'phase8-bootstrap.js'});
  assert.ok(ctx.GOOGLE_DRIVE_CLIENT_ID && ctx.GOOGLE_DRIVE_API_KEY === '', 'Drive bootstrap should still produce safe defaults when storage is blocked');
}

function testLazyDriveLoaderAndSilentFileMode(){
  const source = read('js/06-backup-sync.js');
  assert.ok(source.includes('var gdriveGoogleApisPromise = null;'), 'Drive API loader state missing');
  assert.ok(source.includes('function ensureGoogleDriveApis()'), 'lazy Drive API loader missing');
  assert.ok(source.includes("gdriveLoadScript('https://accounts.google.com/gsi/client')"), 'GSI must load only through the lazy loader');
  assert.ok(source.includes("gdriveLoadScript('https://apis.google.com/js/api.js')"), 'GAPI must load only through the lazy loader');
  assert.ok(source.includes('ensureGoogleDriveApis().then(function(){'), 'interactive Drive flow must lazy-load APIs');
  assert.ok(source.includes('function gdriveGetTokenSilently(onReady, onFail)'), 'silent Drive flow missing');
  assert.ok(source.includes('gdriveBlockedByOrigin(true)'), 'background Drive checks must use silent file-origin guarding');

  const block = source.slice(source.indexOf('function gdriveBlockedByOrigin'), source.indexOf('var gdriveGoogleApisPromise'));
  const alertCalls = [];
  const ctx = {
    location: {protocol:'file:'},
    alert(msg){ alertCalls.push(msg); }
  };
  vm.createContext(ctx);
  vm.runInContext(block + '\nthis.blocked=gdriveBlockedByOrigin(true);', ctx, {filename:'phase8-file-guard.js'});
  assert.strictEqual(ctx.blocked, true, 'silent file-origin guard should block Drive work');
  assert.strictEqual(alertCalls.length, 0, 'background file-origin guard must not interrupt the user with an alert');
}

function testReleaseContracts(){
  const pkg = JSON.parse(read('package.json'));
  const index = read('index.html');
  const sw = read('sw.js');
  const pwa = read('js/12-pwa.js');
  const readme = read('README.md');
  assert.strictEqual(pkg.version, '1.0.0-rc6', 'Phase 8 release version must be current release');
  assert.ok(index.includes('phase8-offline-first-drive-v1-phase9-master-takeover-v2'), 'Phase 8 build marker missing');
  assert.ok(sw.includes("var CACHE='nexus-shell-v11';"), 'service worker cache must be v9');
  assert.ok(pwa.includes("var CACHE='nexus-shell-v11';"), 'embedded PWA cache must be v9');
  assert.ok(readme.includes('Phase 8 offline-first Drive hardening'), 'README must document Phase 8');
  assert.ok(readme.includes('1.0.0-rc6'), 'README must carry current release version');
  assert.ok(readme.includes('nexus-shell-v11'), 'README must carry current PWA generation');
}

function main(){
  testOfflineFirstBootstrap();
  testLazyDriveLoaderAndSilentFileMode();
  testReleaseContracts();
  console.log('Phase 8 production tests passed: core startup is independent of Google SDK loading, Drive services load on demand, restricted storage cannot abort bootstrap, file-origin background sync stays silent, and release contracts are aligned.');
}
main();
