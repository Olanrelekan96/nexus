#!/usr/bin/env python3
"""Browser-level regression + smoke suite for Nexus (real Chromium via Playwright).

Setup (once):   pip install playwright && playwright install chromium
Run:            python3 tests/e2e/nexus_e2e.py            (or: npm run test:e2e)
Options:        --only footnotes,tabs     run a subset by name
                NEXUS_E2E_HEADED=1        watch it run

It serves the repository root itself on a free localhost port, so nothing else needs to be
running. Google scripts are blocked (the app must not need them). Exit status is non-zero if
any test fails.
"""
import asyncio, datetime, functools, http.server, json, os, shutil, signal, socket, subprocess, sys, tempfile, threading, time

from playwright.async_api import async_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PASSCODE = "correct-horse-battery-1"
NAV = ["btn-dashboard", "btn-command-center", "btn-today", "btn-help", "btn-global-search", "btn-graph", "btn-tasks",
       "btn-database", "btn-queries", "btn-flashcards", "btn-sticky-notes", "btn-zettelkasten"]


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass


def start_server():
    port = free_port()
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Quiet, directory=ROOT))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, port


class Ctx:
    """Collects runtime errors for one page."""
    def __init__(self, page):
        self.errors = []
        page.on("pageerror", lambda e: self.errors.append("pageerror: " + str(e)[:200]))
        page.on("console", lambda m: self.errors.append("console: " + m.text[:200]) if m.type == "error" else None)


async def new_page(browser, base, **kw):
    ctx = await browser.new_context(viewport=kw.pop("viewport", {"width": 1280, "height": 900}), **kw)
    await ctx.route("**/accounts.google.com/**", lambda r: r.abort())
    await ctx.route("**/apis.google.com/**", lambda r: r.abort())
    page = await ctx.new_page()
    return ctx, page


def check(cond, msg):
    if not cond: raise AssertionError(msg)


async def boot(page, base, wait=1500):
    await page.goto(base + "/index.html"); await page.wait_for_timeout(wait)


# ----------------------------------------------------------------------------------- tests
async def t_boot_clean(browser, base):
    ctx, page = await new_page(browser, base); c = Ctx(page); ext = []
    page.on("request", lambda r: ext.append(r.url) if not r.url.startswith(base) and not r.url.startswith("data:") and not r.url.startswith("blob:") else None)
    await boot(page, base, 2000)
    check(not c.errors, c.errors)
    check(ext == [], "app contacted third parties at startup: %s" % ext)
    await ctx.close()


async def t_nav_crawl(browser, base):
    ctx, page = await new_page(browser, base); c = Ctx(page)
    page.on("dialog", lambda d: asyncio.ensure_future(d.dismiss()))
    await boot(page, base)
    for nid in NAV:
        await page.click("#" + nid, timeout=3000); await page.wait_for_timeout(500); await page.keyboard.press("Escape")
    check(not c.errors, c.errors)
    await ctx.close()


async def t_footnotes(browser, base):
    ctx, page = await new_page(browser, base); c = Ctx(page)
    await boot(page, base)
    await page.evaluate("""() => { const id=uid(); state.pages[id]={id,title:'FN',type:'page',createdAt:Date.now(),properties:[],rootBlocks:[]}; state.titleIndex['fn']=id;
      parseMarkdownIntoBlocks(id, '- Claim[^a] here\\n- [^a]: The source'); save(); openPage(id); }""")
    await page.wait_for_timeout(800)
    check(await page.locator(".footnote-ref").count() >= 1, "footnote reference did not render")
    check("Claim[^a]" not in await page.evaluate("document.body.innerText"), "raw [^a] left in the rendered text")
    check(not c.errors, c.errors)
    await ctx.close()


async def t_daily_calendar_31st(browser, base):
    ctx, page = await new_page(browser, base)
    await page.clock.install(time=datetime.datetime(2026, 3, 31, 12, 0, 0))
    await boot(page, base)
    if not await page.locator(".daily-cal-title").count():
        await page.click("#toggle-daily-view"); await page.wait_for_timeout(400)
    await page.click(".daily-cal-head button:first-child"); await page.wait_for_timeout(300)
    t = await page.inner_text(".daily-cal-title")
    check(t == "February 2026", "‹ on Mar 31 showed %r" % t)
    await ctx.close()


async def t_tasks_recurrence(browser, base):
    ctx, page = await new_page(browser, base); c = Ctx(page)
    await page.clock.install(time=datetime.datetime(2026, 9, 19, 9, 0, 0))
    await boot(page, base)
    await page.click("#btn-tasks"); await page.wait_for_timeout(400)
    await page.fill("#tasks-quickadd", "Pay rent !p1 due:2026-08-31 every:1m >Money"); await page.keyboard.press("Enter"); await page.wait_for_timeout(500)
    tid = await page.evaluate("collectTasks().find(t=>/Pay rent/.test(t.text||'')).id")
    await page.evaluate("(id)=>toggleTaskDone(id)", tid); await page.wait_for_timeout(400)
    txt = await page.evaluate("(id)=>state.blocks[id].text", tid)
    check("[ ]" in txt and "2026-09-30" in txt, "recurring task rolled to wrong date: " + txt)
    check(not c.errors, c.errors)
    await ctx.close()


async def t_flashcards_typing_guard(browser, base):
    ctx, page = await new_page(browser, base); c = Ctx(page)
    page.on("dialog", lambda d: asyncio.ensure_future(d.accept("Study")))
    await boot(page, base)
    await page.click("#btn-flashcards"); await page.wait_for_timeout(400)
    for f, b in [("Q1", "A1"), ("Q2", "A2")]:
        await page.click("#flashcards-add-btn"); await page.fill("#flashcards-editor input", f); await page.fill("#flashcards-editor textarea", b)
        await page.click("#flashcards-editor button.primary"); await page.wait_for_timeout(300)
    await page.click("#flashcards-start-review"); await page.wait_for_timeout(200)
    await page.click("#flashcards-search"); await page.keyboard.type("a b"); await page.wait_for_timeout(150)
    check(await page.input_value("#flashcards-search") == "a b" and not await page.evaluate("flashcardState.revealed"), "Space in the search box drove the review")
    await page.fill("#flashcards-search", ""); await page.click("#flashcards-start-review"); await page.click(".flashcard-reveal")
    await page.click("#flashcards-search"); await page.keyboard.type("3"); await page.wait_for_timeout(200)
    check(sum(await page.evaluate("Object.values(state.flashcards.cards).map(c=>c.reps)")) == 0, "typing 3 rated a card")
    await page.fill("#flashcards-search", ""); await page.click("#flashcards-start-review"); await page.click(".flashcard-reveal"); await page.click(".flashcard-rate.again"); await page.wait_for_timeout(300)
    check(await page.evaluate("flashcardStatus(Object.values(state.flashcards.cards).find(c=>c.lapses===1))") == "learning", "lapsed card should be 'learning'")
    check(not c.errors, c.errors)
    await ctx.close()


async def t_undo_guard(browser, base):
    ctx, page = await new_page(browser, base)
    await boot(page, base)
    await page.evaluate("window.__u=0; (function(){ const u=window.performUndo; window.performUndo=function(){window.__u++; return u.apply(this,arguments);}; })();")
    await page.click("#btn-flashcards"); await page.click("#flashcards-search"); await page.keyboard.type("hello")
    await page.keyboard.press("Control+z"); await page.wait_for_timeout(200)
    check(await page.evaluate("window.__u") == 0, "Ctrl+Z in a text field triggered notebook undo")
    await ctx.close()


async def t_tabs_persist(browser, base):
    ctx, page = await new_page(browser, base); c = Ctx(page)
    page.on("dialog", lambda d: asyncio.ensure_future(d.accept("x")))
    await boot(page, base)
    for t in ["Tab A", "Tab B", "Tab C"]:
        await page.evaluate("(t)=>{ const p=resolvePage(t,'page'); save(); openPage(p.id); }", t); await page.wait_for_timeout(250)
    await page.click("#btn-tasks"); await page.wait_for_timeout(1500)
    before = await page.evaluate("nexusTabsState.tabs.length")
    await page.reload(); await page.wait_for_timeout(1800)
    after = await page.evaluate("nexusTabsState.tabs.length")
    check(before >= 5 and after == before, "tabs before=%s after reload=%s" % (before, after))
    check(not c.errors, c.errors)
    await ctx.close()


async def t_offline_first_visit(browser, base):
    port = free_port()
    srv = subprocess.Popen([sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=os.setsid)
    time.sleep(1.2)
    ctx, page = await new_page(browser, base)
    try:
        await page.goto("http://localhost:%d/index.html" % port); await page.wait_for_timeout(2500)
        await page.evaluate("navigator.serviceWorker.ready.then(()=>true)")
        os.killpg(os.getpgid(srv.pid), signal.SIGKILL); time.sleep(0.8)        # the server is really gone
        await page.reload(timeout=8000); await page.wait_for_timeout(2500)
        check(await page.evaluate("typeof state!=='undefined' && !!state && !!document.querySelector('#sidebar .side-btn')"), "app did not open offline after a single online visit")
    finally:
        try: os.killpg(os.getpgid(srv.pid), signal.SIGKILL)
        except Exception: pass
        await ctx.close()


async def t_passcode_launch_policy(browser, base):
    ud = tempfile.mkdtemp(prefix="nexus-e2e-")
    async def launch(p):
        ctx = await p.chromium.launch_persistent_context(ud, headless=not os.environ.get("NEXUS_E2E_HEADED"), viewport={"width": 1280, "height": 800})
        await ctx.route("**/accounts.google.com/**", lambda r: r.abort()); await ctx.route("**/apis.google.com/**", lambda r: r.abort())
        page = ctx.pages[0] if ctx.pages else await ctx.new_page(); return ctx, page
    locked = "getComputedStyle(document.getElementById('lock-overlay')).display !== 'none'"
    try:
        async with async_playwright() as p:
            ctx, page = await launch(p); await boot(page, base)
            await page.click("#add-root-block"); await page.keyboard.type("secret note alpha"); await page.wait_for_timeout(1200)
            await page.click("#btn-settings"); await page.click("#btn-set-passcode")
            await page.fill("#pc-new", PASSCODE); await page.fill("#pc-confirm", PASSCODE); await page.click("#pc-submit")
            await page.wait_for_selector("#recovery-show-overlay", state="visible", timeout=15000)
            await page.check("#recovery-saved-check"); await page.click("#recovery-show-done"); await ctx.close()

            ctx, page = await launch(p); await boot(page, base)
            check(await page.evaluate(locked), "launch prompt ON: relaunch must lock")
            await page.fill("#lock-input", PASSCODE); await page.click("#lock-submit"); await page.wait_for_timeout(2500)
            await page.click("#btn-settings"); await page.click('#settings-passcode-launch-row [data-passcoderequest="off"]'); await page.wait_for_timeout(800); await ctx.close()

            ctx, page = await launch(p); await boot(page, base, 2500)
            check(not await page.evaluate(locked), "launch prompt OFF: relaunch must not lock")
            check(await page.evaluate("document.body.innerText.includes('secret note alpha')"), "note not visible after silent unlock")
            await page.evaluate("""() => { const k='nexus_pkm_v1_lock_reentry_v3'; const o=JSON.parse(localStorage.getItem(k)); o.deadlineAt=Date.now()-1000; localStorage.setItem(k,JSON.stringify(o)); }""")
            await ctx.close()

            ctx, page = await launch(p); await boot(page, base)
            check(await page.evaluate(locked), "expired interval must lock on relaunch")
            await ctx.close()
    finally:
        shutil.rmtree(ud, ignore_errors=True)


async def t_backup_restore_and_encrypted(browser, base):
    ctx, page = await new_page(browser, base); c = Ctx(page); answer = {"v": PASSCODE}
    page.on("dialog", lambda d: asyncio.ensure_future(d.accept(answer["v"]) if d.type == "prompt" else d.accept()))
    await boot(page, base)
    await page.evaluate("""() => { const id=uid(); state.pages[id]={id,title:'Secret Page',type:'page',createdAt:Date.now(),properties:[],rootBlocks:[]}; state.titleIndex['secret page']=id;
      const b=uid(); state.blocks[b]=mkBlock(b,id,null,'launch-code-SENTINEL-42'); state.pages[id].rootBlocks.push(b); save(); }""")
    await page.wait_for_timeout(700)
    js = await page.evaluate("buildBackupJson()")
    await page.evaluate("(()=>{const id=state.titleIndex['secret page']; state.blocks[state.pages[id].rootBlocks[0]].text='CHANGED'; save();})()")
    await page.evaluate("(t)=>restoreFromDecryptedJsonText(t)", js); await page.wait_for_timeout(1000)
    txt = lambda: page.evaluate("state.blocks[state.pages[state.titleIndex['secret page']].rootBlocks[0]].text")
    check(await txt() == "launch-code-SENTINEL-42", "plain backup restore did not reproduce the note")
    await page.click("#btn-settings"); await page.click("#btn-set-passcode")
    await page.fill("#pc-new", PASSCODE); await page.fill("#pc-confirm", PASSCODE); await page.click("#pc-submit")
    await page.wait_for_selector("#recovery-show-overlay", state="visible", timeout=15000)
    await page.check("#recovery-saved-check"); await page.click("#recovery-show-done"); await page.wait_for_timeout(500)
    enc = await page.evaluate("(j)=>maybeEncryptExport(j)", await page.evaluate("buildBackupJson()"))
    check(json.loads(enc).get("nexusEncryptedBackup") and "SENTINEL-42" not in enc, "export was not encrypted")
    await page.evaluate("(()=>{const id=state.titleIndex['secret page']; state.blocks[state.pages[id].rootBlocks[0]].text='CHANGED'; save();})()"); await page.wait_for_timeout(600)
    answer["v"] = "wrong-passcode-here"; await page.evaluate("(t)=>restoreFromJsonText(t)", enc); await page.wait_for_timeout(2500)
    check(await txt() == "CHANGED", "wrong passcode must not touch the notebook")
    answer["v"] = PASSCODE; await page.evaluate("(t)=>restoreFromJsonText(t)", enc); await page.wait_for_timeout(3000)
    check(await txt() == "launch-code-SENTINEL-42", "encrypted restore failed")
    check(not c.errors, c.errors)
    await ctx.close()


async def t_mobile_layout(browser, base):
    ctx, page = await new_page(browser, base, viewport={"width": 390, "height": 844}, device_scale_factor=2, has_touch=True, is_mobile=True)
    c = Ctx(page); await boot(page, base, 1800)
    r = await page.evaluate("(()=>{const a=document.getElementById('expand-btn').getBoundingClientRect(), t=document.querySelector('.nexus-tab').getBoundingClientRect(); return [a.right,t.left,document.documentElement.scrollWidth,innerWidth]})()")
    check(r[1] >= r[0], "floating menu button overlaps the first tab (%s)" % r)
    check(r[2] <= r[3] + 1, "page scrolls horizontally on mobile (%s)" % r)
    await page.tap("#expand-btn"); await page.wait_for_timeout(500)
    await page.tap("#btn-tasks"); await page.wait_for_timeout(700)
    check(await page.evaluate("document.getElementById('sidebar').getBoundingClientRect().right <= 2"), "drawer did not close after navigating")
    check(not c.errors, c.errors)
    await ctx.close()


async def t_xss_sweep(browser, base):
    ctx, page = await new_page(browser, base)
    page.on("dialog", lambda d: asyncio.ensure_future(d.accept("x")))
    await boot(page, base)
    await page.evaluate("window.__xss = 0")
    P, P2 = "<img src=x onerror=window.__xss=1>", "\"><img src=x onerror=window.__xss=1>"
    await page.evaluate("""([P,P2]) => {
      function mk(title, blocks, props){ const id=uid(); state.pages[id]={id,title,type:'page',createdAt:Date.now(),properties:props||[],rootBlocks:[]}; state.titleIndex[title.toLowerCase()]=id;
        blocks.forEach(t=>{const b=uid(); state.blocks[b]=mkBlock(b,id,null,t); state.pages[id].rootBlocks.push(b);}); return id; }
      mk('Evil '+P,['x']); const host=mk('XSS Host',[P,'[['+P+']] [['+P2+']] #x'+P2,'**'+P+'** `'+P+'`','[c](javascript:window.__xss=1)','{{img:'+P2+'|'+P+'}}','(('+P2+'))','[ ] t '+P,'{{query: '+P+'}}','{{table: '+P2+'}}'],[{key:P2,value:P},{key:'s',value:P,type:'select'}]);
      state.pages[host].icon=P; state.pages[host].banner=P2; ensureFlashcardState(); makeFlashcard(P,P2,Object.keys(state.flashcards.decks)[0],host,null);
      ensureStickyNoteState(); makeStickyNote(P,P2,'sun',host,null); createZettelPage('fleeting',P,P2); save(); openPage(host); }""", [P, P2])
    await page.wait_for_timeout(1000)
    scan = """() => { const bad=[]; document.querySelectorAll('body *').forEach(e=>{ for(const a of e.attributes){ if(/^on/i.test(a.name)) bad.push(e.tagName+'['+a.name+']'); } if(e.tagName==='IMG'&&e.getAttribute('src')==='x') bad.push('IMG src=x'); }); return {x:window.__xss, bad:bad.slice(0,5)}; }"""
    for nid in [None] + NAV + ["btn-today"]:
        if nid: await page.evaluate("document.getElementById('%s').click()" % nid); await page.wait_for_timeout(500)
        r = await page.evaluate(scan); check(r["x"] == 0 and not r["bad"], "XSS after %s: %s" % (nid or "host page", r))
    await ctx.close()


async def t_find_replace_literal(browser, base):
    ctx, page = await new_page(browser, base); c = Ctx(page)
    page.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
    await boot(page, base)
    await page.evaluate("""() => { const id=uid(); state.pages[id]={id,title:'FR',type:'page',createdAt:Date.now(),properties:[],rootBlocks:[]}; state.titleIndex['fr']=id;
      ['price is USD today','USD and usd again'].forEach(t=>{const b=uid(); state.blocks[b]=mkBlock(b,id,null,t); state.pages[id].rootBlocks.push(b);}); save(); openPage(id); }""")
    await page.evaluate("()=>{ openFindReplace(); document.getElementById('fr-find').value='USD'; document.getElementById('fr-replace').value='$$100 $&'; document.getElementById('fr-case').checked=false; applyFindReplace(); }")
    await page.wait_for_timeout(300)
    out = await page.evaluate("state.pages[state.titleIndex['fr']].rootBlocks.map(i=>state.blocks[i].text)")
    check(out == ["price is $$100 $& today", "$$100 $& and $$100 $& again"], "replacement text was not inserted literally: %s" % out)
    check(not c.errors, c.errors)
    await ctx.close()


async def t_formatting_and_attachments_persist(browser, base):
    """Toolbar formatting and attached images used to be flattened on save (a footnotes wrapper broke serializeInline)."""
    ctx, page = await new_page(browser, base); c = Ctx(page)
    page.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
    png = os.path.join(tempfile.gettempdir(), "nexus-e2e-tiny.png")
    import base64
    open(png, "wb").write(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="))
    await boot(page, base)
    await page.click("#btn-new-page"); await page.wait_for_timeout(300); await page.keyboard.type("Fmt Page"); await page.keyboard.press("Enter"); await page.wait_for_timeout(600)
    for tag, want in [("strong", "**bold**"), ("em", "*bold*"), ("del", "~~bold~~"), ("code", "`bold`")]:
        await page.click("#add-root-block"); await page.wait_for_timeout(250)
        await page.keyboard.type("make this word bold"); await page.wait_for_timeout(200)
        for _ in range(4): await page.keyboard.press("Shift+ArrowLeft")
        await page.click('.dock-fmt-btn[data-tag="%s"]' % tag); await page.wait_for_timeout(250)
        await page.keyboard.press("Escape"); await page.wait_for_timeout(900)
        got = await page.evaluate("(()=>{const ids=state.pages[state.currentPageId].rootBlocks; return state.blocks[ids[ids.length-1]].text;})()")
        check(got == "make this word " + want, "%s formatting lost on save: %r" % (tag, got))
    await page.click("#add-root-block"); await page.wait_for_timeout(250); await page.keyboard.type("pic:"); await page.wait_for_timeout(300)
    await page.set_input_files("#attach-file-input", png); await page.wait_for_timeout(1500)
    await page.keyboard.press("Escape"); await page.wait_for_timeout(1000)
    txt = await page.evaluate("(()=>{const ids=state.pages[state.currentPageId].rootBlocks; return state.blocks[ids[ids.length-1]].text;})()")
    check(txt.startswith("pic:{{img:att") and txt.endswith("|nexus-e2e-tiny.png}}"), "attachment reference lost on save: %r" % txt)
    await page.reload(); await page.wait_for_timeout(1800)
    check(await page.locator(".block-content img").count() >= 1, "attached image missing after reload")
    # the whole inline grammar must survive render -> serialise unchanged
    cases = ["**bold**", "*it*", "~~s~~", "`c`", "[[Wiki Link]]", "#tag", "((blk1))", "[^a]", "{{img:a1|x.png}}", "{{file:a2|y.pdf}}", "{{mark:yellow|hi}}",
             "%%color:red|c%%", "**bold [[Link]] more**", "text [^a] and [^b] end", "**bold[^a] end**", "a < b && c > d", "5 * 3 * 2", "**unclosed", "line1\nline2"]
    bad = await page.evaluate("""(cs)=>cs.map(t=>{const d=document.createElement('div'); d.appendChild(buildInlineNodes(t)); return [t, serializeInline(d)];}).filter(x=>x[0]!==x[1])""", cases)
    check(not bad, "inline round-trip mismatches: %s" % bad)
    check(not c.errors, c.errors)
    await ctx.close()


RAW_READ = """() => new Promise((res, rej) => { const r = indexedDB.open('nexus_attachments'); r.onerror = () => rej(r.error);
  r.onsuccess = () => { const g = r.result.transaction('notebook').objectStore('notebook').get('state'); g.onsuccess = () => res(g.result === undefined ? null : (typeof g.result === 'string' ? g.result : JSON.stringify(g.result))); g.onerror = () => rej(g.error); }; })"""
RAW_KEYS = """() => new Promise((res, rej) => { const r = indexedDB.open('nexus_attachments'); r.onsuccess = () => { const g = r.result.transaction('notebook').objectStore('notebook').getAllKeys(); g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error); }; })"""
SEED_NOTE = """(text) => { const id=uid(); state.pages[id]={id,title:'Keep Me',type:'page',createdAt:Date.now(),properties:[],rootBlocks:[]}; state.titleIndex['keep me']=id;
  const b=uid(); state.blocks[b]=mkBlock(b,id,null,text); state.pages[id].rootBlocks.push(b); save(); }"""


async def leave_app(page, base):
    """Navigate to a same-origin page that does not run the app (its unload flush has already happened)."""
    await page.goto(base + "/manifest.json"); await page.wait_for_timeout(300)


async def set_passcode_ui(page):
    await page.click("#btn-settings"); await page.click("#btn-set-passcode")
    await page.fill("#pc-new", PASSCODE); await page.fill("#pc-confirm", PASSCODE); await page.click("#pc-submit")
    await page.wait_for_selector("#recovery-show-overlay", state="visible", timeout=15000)
    await page.check("#recovery-saved-check"); await page.click("#recovery-show-done"); await page.wait_for_timeout(500)
    await page.keyboard.press("Escape")


# ----------------------------------------------------------------------------------- data-safety tests
async def t_load_failure_never_overwrites(browser, base):
    ctx, page = await new_page(browser, base)
    page.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
    await boot(page, base)
    await page.evaluate(SEED_NOTE, "precious note"); await page.wait_for_timeout(1000)
    await leave_app(page, base)
    await page.evaluate("""() => new Promise((res, rej) => { const r = indexedDB.open('nexus_attachments'); r.onsuccess = () => { const tx = r.result.transaction('notebook', 'readwrite'); tx.objectStore('notebook').put('{corrupt-not-json', 'state'); tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error); }; })""")
    await page.goto(base + "/index.html"); await page.wait_for_timeout(3000)
    check(await page.locator("#load-failure-overlay").count() == 1, "an unreadable notebook must show the recovery dialog, not a blank notebook")
    await page.wait_for_timeout(2500)                                   # long enough for any autosave to fire
    check(await page.evaluate(RAW_READ) == "{corrupt-not-json", "the unreadable stored data was overwritten")
    await page.click("#load-failure-overlay button:has-text('Start a fresh')"); await page.wait_for_timeout(3000)
    keys = await page.evaluate(RAW_KEYS)
    check(any(str(k).startswith("state_quarantine_") for k in keys), "'Start fresh' must keep a quarantine copy of the old data: %s" % keys)
    check(await page.evaluate("!!state && Object.keys(state.pages).length > 0"), "a fresh notebook did not start")
    await ctx.close()


async def t_flush_before_load_is_harmless(browser, base):
    ctx, page = await new_page(browser, base)
    await boot(page, base)
    await page.evaluate(SEED_NOTE, "precious note"); await page.wait_for_timeout(1000)
    await page.evaluate("() => { window.__keep = state; state = null; flushSaveNow(); }"); await page.wait_for_timeout(700)
    raw = await page.evaluate(RAW_READ)
    check(raw and "precious note" in raw, "flushing before the notebook is loaded replaced the stored notebook with %r" % str(raw)[:40])
    await page.evaluate("() => { state = window.__keep; }")
    await ctx.close()


async def t_typing_autosaves_without_blur(browser, base):
    ctx, page = await new_page(browser, base)
    await boot(page, base)
    await page.click("#add-root-block"); await page.wait_for_timeout(250)
    await page.keyboard.type("autosave-marker-123"); await page.wait_for_timeout(1500)     # still editing: no blur, no Enter
    raw = await page.evaluate(RAW_READ)
    check(raw and "autosave-marker-123" in raw, "text still being typed was not saved to storage after ~1.5s")
    await ctx.close()


async def t_passcode_set_failure_keeps_data(browser, base):
    ctx, page = await new_page(browser, base)
    await boot(page, base)
    await page.evaluate(SEED_NOTE, "meta-fail note"); await page.wait_for_timeout(1000)
    await page.evaluate("""() => { window.__failLock = true; const o = Storage.prototype.setItem;
      Storage.prototype.setItem = function(k, v){ if(window.__failLock && k === LOCK_KEY) throw new Error('QuotaExceededError'); return o.call(this, k, v); }; }""")
    res = await page.evaluate("setPasscode('%s').then(() => 'resolved', e => 'rejected: ' + e.message)" % PASSCODE)
    await page.evaluate("window.__failLock = false")
    check(res.startswith("rejected"), "setPasscode must fail when its lock settings cannot be stored (got %r)" % res)
    check(not await page.evaluate("isLockEnabled()"), "lock reported enabled although its settings were never stored")
    await leave_app(page, base); await page.goto(base + "/index.html"); await page.wait_for_timeout(2500)
    check(await page.locator("#load-failure-overlay").count() == 0, "notebook became unreadable after a failed passcode setup")
    check(await page.evaluate("Object.values(state.blocks).some(b => b.text === 'meta-fail note')"), "note lost after a failed passcode setup")
    await ctx.close()


async def t_passcode_removal_failure_keeps_lock(browser, base):
    ctx, page = await new_page(browser, base)
    page.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
    await boot(page, base)
    await page.evaluate(SEED_NOTE, "removal note"); await page.wait_for_timeout(1000)
    await set_passcode_ui(page)
    await page.evaluate("""() => { window.__failPut = true; const o = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(){ if(window.__failPut && this.name === 'notebook') throw new Error('injected write failure'); return o.apply(this, arguments); }; }""")
    res = await page.evaluate("removePasscodeConfirmed('%s').then(v => 'resolved:' + v, e => 'rejected: ' + e.message)" % PASSCODE)
    await page.evaluate("window.__failPut = false")
    check(res.startswith("rejected"), "removal must fail loudly when the plain copy cannot be written (got %r)" % res)
    check(await page.evaluate("isLockEnabled()"), "passcode was discarded although the decrypted copy was never written")
    await leave_app(page, base); await page.goto(base + "/index.html"); await page.wait_for_timeout(2500)
    check(await page.evaluate("getComputedStyle(document.getElementById('lock-overlay')).display !== 'none'"), "notebook should still be locked")
    await page.fill("#lock-input", PASSCODE); await page.click("#lock-submit"); await page.wait_for_timeout(3000)
    check(await page.evaluate("Object.values(state.blocks).some(b => b.text === 'removal note')"), "note lost after a failed passcode removal")
    await ctx.close()


TESTS = [t_boot_clean, t_nav_crawl, t_footnotes, t_daily_calendar_31st, t_tasks_recurrence, t_flashcards_typing_guard, t_undo_guard,
         t_tabs_persist, t_offline_first_visit, t_passcode_launch_policy, t_backup_restore_and_encrypted, t_mobile_layout, t_xss_sweep, t_find_replace_literal, t_formatting_and_attachments_persist,
         t_load_failure_never_overwrites, t_flush_before_load_is_harmless, t_typing_autosaves_without_blur, t_passcode_set_failure_keeps_data, t_passcode_removal_failure_keeps_lock]


async def main():
    only = None
    if "--only" in sys.argv: only = set(sys.argv[sys.argv.index("--only") + 1].split(","))
    srv, port = start_server(); base = "http://127.0.0.1:%d" % port
    failures = 0
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=not os.environ.get("NEXUS_E2E_HEADED"))
        for t in TESTS:
            name = t.__name__[2:]
            if only and not any(o in name for o in only): continue
            t0 = time.time()
            try:
                await t(browser, base); print("PASS  %-34s %.1fs" % (name, time.time() - t0))
            except Exception as e:
                failures += 1; print("FAIL  %-34s %s: %s" % (name, type(e).__name__, str(e)[:300]))
        await browser.close()
    srv.shutdown()
    print("\n%s" % ("All browser tests passed." if not failures else "%d browser test(s) FAILED." % failures))
    sys.exit(1 if failures else 0)

if __name__ == "__main__":
    asyncio.run(main())
