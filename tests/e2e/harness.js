'use strict';
/* Minimal browser-test harness for Nexus (no test framework needed).
   Requires the `playwright` package plus a Chromium build:
     npm i -D playwright && npx playwright install chromium
   Run everything with:  npm run test:e2e
   The suite is optional: `npm test` stays dependency-free. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

let playwright;
try { playwright = require('playwright'); }
catch (e) {
  try { playwright = require(path.join(process.env.NODE_PATH || '/usr/lib/node_modules', 'playwright')); }
  catch (e2) { playwright = null; }
}

const ROOT = path.join(__dirname, '..', '..');
const MIME = {'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.ico':'image/x-icon'};

function startServer() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
      res.writeHead(200, {'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store'});
      fs.createReadStream(f).pipe(res);
    }).listen(0, '127.0.0.1', () => resolve({srv, url: 'http://127.0.0.1:' + srv.address().port + '/index.html'}));
  });
}

async function newPage(ctx, errs) {
  await ctx.route(/accounts\.google\.com|apis\.google\.com/, r => r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push(String(e)));
  page.on('dialog', d => d.accept());
  return page;
}

const TREE = () => {
  const pg = state.pages[state.currentPageId];
  const walk = id => { const b = state.blocks[id]; return {t: b.text, c: b.children.map(walk)}; };
  return pg.rootBlocks.map(walk);
};

async function rawState(page) {
  return page.evaluate(() => new Promise(res => {
    const r = indexedDB.open('nexus_attachments');
    r.onsuccess = () => { const g = r.result.transaction('notebook').objectStore('notebook').get('state'); g.onsuccess = () => res(g.result === undefined ? null : g.result); g.onerror = () => res('ERR'); };
    r.onerror = () => res('OPENERR');
  }));
}

async function newNamedPage(page, title) {
  await page.click('#btn-new-page'); await page.waitForTimeout(250);
  await page.keyboard.type(title); await page.keyboard.press('Enter'); await page.waitForTimeout(500);
}

async function run(tests) {
  if (!playwright) { console.log('SKIP e2e: install playwright (npm i -D playwright && npx playwright install chromium)'); return 0; }
  const {srv, url} = await startServer();
  const browser = await playwright.chromium.launch();
  let failed = 0; const only = process.env.E2E_ONLY;
  for (const [name, fn] of tests) {
    if (only && name.indexOf(only) === -1) continue;
    const errs = [];
    const t0 = Date.now();
    try {
      await fn({browser, url, errs, newPage, TREE, rawState, newNamedPage, playwright, tmp: () => fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-e2e-'))});
      console.log('  ok   ' + name + ' (' + (Date.now() - t0) + 'ms)');
    } catch (e) {
      failed++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message || e).split('\n').join('\n       '));
    }
  }
  await browser.close(); srv.close();
  console.log(failed ? ('\n' + failed + ' e2e test(s) failed') : '\nAll e2e tests passed');
  return failed;
}
module.exports = {run};
