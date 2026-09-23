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


async def t_multi_select_bulk_delete(browser, base):
    ctx, page = await new_page(browser, base); c = Ctx(page)
    page.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
    await boot(page, base)
    ids = await page.evaluate("""() => {
        const p = state.pages[state.currentPageId];
        p.rootBlocks = [];
        const ids = ['Alpha','Beta','Gamma','Delta'].map((t) => {
            const id = uid();
            state.blocks[id] = mkBlock(id, p.id, null, t);
            p.rootBlocks.push(id);
            return id;
        });
        save(); renderPage();
        return ids;
    }""")
    a_id, b_id, g_id, d_id = ids

    # Ctrl-click Beta, then Shift-click Delta with real mouse events on the real
    # bullet elements: range-select must land on Beta/Gamma/Delta (not Alpha),
    # and the .selected class must actually be applied in the live DOM.
    await page.click('.block-row[data-id="%s"] .bullet' % b_id, modifiers=["Control"])
    await page.click('.block-row[data-id="%s"] .bullet' % d_id, modifiers=["Shift"])
    selected = await page.evaluate("selectedBlockIds")
    check(selected == [b_id, g_id, d_id], "Shift/Ctrl-click on real bullets gave %s, expected [Beta, Gamma, Delta]" % selected)
    classes = await page.evaluate(
        "(ids) => ids.map((id) => document.querySelector(`.block-row[data-id=\"${id}\"]`).classList.contains('selected'))",
        ids)
    check(classes == [False, True, True, True], "the .selected class in the live DOM did not match the real selection: %s" % classes)

    # Delete bulk-deletes the real selection through the app's real confirm() dialog.
    await page.keyboard.press("Delete")
    await page.wait_for_timeout(300)
    remaining = await page.evaluate("Object.keys(state.blocks)")
    check(a_id in remaining, "Alpha (not selected) must survive a bulk delete")
    check(b_id not in remaining and g_id not in remaining and d_id not in remaining,
          "bulk delete via the Delete key did not remove the selected blocks: remaining=%s" % remaining)
    check(await page.evaluate("selectedBlockIds.length") == 0, "selection must be cleared after a bulk delete")
    check(not c.errors, c.errors)
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


MK_PAGE = """([title, blocks, props]) => { const id=uid(); state.pages[id]={id,title,type:'page',createdAt:Date.now(),properties:props||[],rootBlocks:[]}; state.titleIndex[title.toLowerCase()]=id;
  blocks.forEach(t=>{const b=uid(); state.blocks[b]=mkBlock(b,id,null,t); state.pages[id].rootBlocks.push(b);}); return id; }"""
XSS_SCAN = """() => { const bad=[]; document.querySelectorAll('body *').forEach(e=>{ for(const a of e.attributes){ if(/^on/i.test(a.name)) bad.push(e.tagName+'['+a.name+']'); } if(e.tagName==='IMG'&&e.getAttribute('src')==='x') bad.push('IMG src=x'); }); return {x:window.__xss, bad:bad.slice(0,5)}; }"""


# ----------------------------------------------------------------------------------- links / views / security
async def t_trashed_pages_are_not_backlinks(browser, base):
    ctx, page = await new_page(browser, base); c = Ctx(page)
    await boot(page, base)
    src = await page.evaluate(MK_PAGE, ["Src Trash", ["mention of [[Target Two]] here"], []]); await page.evaluate(MK_PAGE, ["Target Two", [], []]); await page.evaluate("save()")
    async def backlinks():
        await page.evaluate("openPageByTitle('Target Two','page')"); await page.wait_for_timeout(500)
        return await page.evaluate("document.getElementById('backlinks').innerText")
    check("mention of" in await backlinks(), "a live page's link should be a backlink")
    await page.evaluate("(id)=>trashPage(id)", src); await page.wait_for_timeout(300)
    check("mention of" not in await backlinks(), "a trashed page must not appear in backlinks")
    await page.evaluate("(id)=>restorePage(id)", src); await page.wait_for_timeout(300)
    check("mention of" in await backlinks(), "restoring the page should bring its backlink back")
    # tags keep working as references: the tag page lists #tagged blocks
    await page.evaluate(MK_PAGE, ["Tagged Src", ["alpha block #zed"], []]); await page.evaluate("save(); openPageByTitle('zed','page')"); await page.wait_for_timeout(500)
    check("alpha block" in await page.evaluate("document.getElementById('backlinks').innerText"), "visiting a tag page must list its tagged blocks")
    check(not c.errors, c.errors)
    await ctx.close()


async def t_task_group_labels_are_text(browser, base):
    ctx, page = await new_page(browser, base); c = Ctx(page)
    await boot(page, base)
    P = "<img src=x onerror=window.__xss=1>"
    await page.evaluate("window.__xss = 0")
    await page.evaluate(MK_PAGE, ["Evil " + P, ["[ ] task under evil title #evtag !p1"], []]); await page.evaluate("save()")
    await page.click("#btn-tasks"); await page.wait_for_timeout(400)
    for g in ["page", "tag", "pri", "due"]:
        await page.evaluate("(g)=>{ tasksViewState.group=g; renderTasksView(); }", g); await page.wait_for_timeout(400)
        r = await page.evaluate(XSS_SCAN); check(r["x"] == 0 and not r["bad"], "task group '%s' injected markup: %s" % (g, r))
    await page.evaluate("()=>{ tasksViewState.group='page'; renderTasksView(); }"); await page.wait_for_timeout(300)
    check(P in await page.evaluate("document.querySelector('.task-group-head span').textContent"), "page-title group label should be shown as literal text")
    check(not c.errors, c.errors)
    await ctx.close()


async def t_saved_view_cancel_is_isolated(browser, base):
    ctx, page = await new_page(browser, base); c = Ctx(page)
    await boot(page, base)
    hid = await page.evaluate(MK_PAGE, ["DB Host", ["{{table: #x}}"], []]); await page.evaluate("save()")
    await page.evaluate("(id)=>openPage(id)", hid); await page.wait_for_timeout(700)
    bid = await page.evaluate("(id)=>state.pages[id].rootBlocks[0]", hid)
    await page.evaluate("(b)=>addDbView(b,'board')", bid); await page.wait_for_timeout(500)
    views = "(b)=>JSON.stringify(state.blocks[b].dbViews.map(v=>v.dirs.view))"
    before = await page.evaluate(views, bid)
    await page.evaluate("(b)=>openQueryBuilder('table', b, '#x')", bid); await page.wait_for_timeout(300)
    await page.select_option("#qb-view-controls select >> nth=0", "gallery"); await page.wait_for_timeout(200)
    await page.click("#qb-cancel"); await page.wait_for_timeout(300)
    check(await page.evaluate(views, bid) == before, "Cancel in the query builder changed the saved view: %s -> %s" % (before, await page.evaluate(views, bid)))
    await page.evaluate("(b)=>openQueryBuilder('table', b, '#x')", bid); await page.wait_for_timeout(300)
    await page.select_option("#qb-view-controls select >> nth=0", "gallery"); await page.wait_for_timeout(200)
    await page.click("#qb-save"); await page.wait_for_timeout(500)
    check("gallery" in await page.evaluate(views, bid), "Save in the query builder did not commit the change")
    check(not c.errors, c.errors)
    await ctx.close()


async def t_xss_deep_views(browser, base):
    """Payloads in every user-editable label, then walk every view and every dropdown option looking for injected markup."""
    ctx, page = await new_page(browser, base)
    page.on("dialog", lambda d: asyncio.ensure_future(d.accept("x")))
    await boot(page, base)
    P, P2 = "<img src=x onerror=window.__xss=1>", "\"><img src=x onerror=window.__xss=1>"
    await page.evaluate("window.__xss = 0")
    await page.evaluate(MK_PAGE, ["Deep " + P, ["[ ] deep task " + P + " #x", P + " #x", "{{table: #x}}"], [{"key": "Status", "value": P, "type": "select"}, {"key": P2, "value": P2, "type": "text"}]])
    await page.evaluate("""([P,P2]) => { ensureFlashcardState(); const deck=Object.keys(state.flashcards.decks)[0]; state.flashcards.decks[deck].name=P; makeFlashcard(P,P2,deck,null,null);
      ensureStickyNoteState(); makeStickyNote(P,P2,'sun',null,null); ensureFolderState(); const f=uid(); state.folders[f]={id:f,name:P,parentId:null,collapsed:false,createdAt:Date.now()};
      state.templates=state.templates||{}; const t=uid(); state.templates[t]={id:t,name:P,blocks:[{text:P,children:[]}]}; createZettelPage('fleeting',P,P2); save(); renderAll(); }""", [P, P2])
    hid = await page.evaluate("state.titleIndex['deep ' + arguments[0]]" if False else "(P)=>state.titleIndex[('Deep '+P).toLowerCase()]", P)
    bid = await page.evaluate("(id)=>state.pages[id].rootBlocks[2]", hid)
    await page.evaluate("(id)=>openPage(id)", hid); await page.wait_for_timeout(600)
    await page.evaluate("(b)=>{ addDbView(b,'board'); const v=state.blocks[b].dbViews; v[0].name=arguments[0]; }".replace("arguments[0]", "'" + P.replace("'", "\\'") + "'"), bid) if False else None
    await page.evaluate("""([b,P]) => { addDbView(b,'board'); addDbView(b,'gallery'); const v=state.blocks[b].dbViews; v.forEach(x=>{x.name=P;}); v[1].dirs.group='Status'; save(); renderPage(); }""", [bid, P])
    await page.wait_for_timeout(700)
    async def scan(label):
        r = await page.evaluate(XSS_SCAN); check(r["x"] == 0 and not r["bad"], "markup injected at %s: %s" % (label, r))
    await scan("page with board/gallery views grouped by a payload property")
    for nid in NAV:
        await page.evaluate("document.getElementById('%s').click()" % nid); await page.wait_for_timeout(500); await scan(nid)
        n = await page.evaluate("Array.from(document.querySelectorAll('select')).filter(e=>e.offsetParent!==null).length")
        for i in range(n):
            opts = await page.evaluate("(i)=>Array.from(Array.from(document.querySelectorAll('select')).filter(e=>e.offsetParent!==null)[i].options).map(o=>o.value)", i)
            for v in opts[:12]:
                await page.evaluate("([i,v])=>{ const s=Array.from(document.querySelectorAll('select')).filter(e=>e.offsetParent!==null)[i]; if(!s) return; s.value=v; s.dispatchEvent(new Event('change',{bubbles:true})); }", [i, v]); await page.wait_for_timeout(120)
            await scan("%s select #%d" % (nid, i))
    await ctx.close()


async def t_settings_round_trip(browser, base):
    """OPEN -> CHANGE -> CLOSE -> REOPEN -> VERIFY -> RELOAD -> VERIFY, for every segmented setting and the Drive credential fields."""
    ctx, page = await new_page(browser, base); c = Ctx(page)
    page.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
    await boot(page, base)
    groups = await page.evaluate("""() => { const rows = SETTINGS_ROWS.filter(r => !/passcode/.test(r[0])).map(r => ({row:r[0], attr:r[1], key:r[2]})); rows.push({row:'settings-gdriveauthttl-row', attr:'gdriveauthttl', key:'gdriveAuthTtlHours'});
      return rows.map(g => { g.options = Array.from(document.getElementById(g.row).querySelectorAll('button')).map(b => b.dataset[g.attr]); return g; }); }""")
    check(len(groups) >= 9, "expected the settings rows, found %d" % len(groups))
    async def open_settings():
        await page.click("#btn-settings"); await page.wait_for_selector("#settings-modal", state="visible"); await page.wait_for_timeout(200)
    async def verify(want, where):
        for g in groups:
            act = await page.evaluate("(g)=>{const b=document.querySelector('#'+g.row+' button.active'); return b ? b.dataset[g.attr] : null;}", g)
            val = await page.evaluate("(k)=>String(currentSettings[k])", g["key"])
            check(act == want[g["row"]] and val == want[g["row"]], "%s: %s shows %r / stored %r, expected %r" % (where, g["row"], act, val, want[g["row"]]))
    async def choose_all(pick):
        want = {}
        for g in groups:
            opt = pick(g["options"]); want[g["row"]] = opt
            await page.click("#%s button[data-%s='%s']" % (g["row"], g["attr"], opt)); await page.wait_for_timeout(120)
        return want
    await open_settings()
    for g in groups:                                           # every single option must take effect immediately
        for opt in g["options"]:
            await page.click("#%s button[data-%s='%s']" % (g["row"], g["attr"], opt)); await page.wait_for_timeout(80)
            act = await page.evaluate("(g)=>{const b=document.querySelector('#'+g.row+' button.active'); return b ? b.dataset[g.attr] : null;}", g)
            check(act == opt, "%s: clicking %r left %r active" % (g["row"], opt, act))
    for pick, label in [(lambda o: o[-1], "last option"), (lambda o: o[0], "first option")]:
        if not await page.evaluate("getComputedStyle(document.getElementById('settings-overlay')).display !== 'none'"): await open_settings()
        want = await choose_all(pick)
        await page.click("#settings-close"); await page.wait_for_timeout(200)
        await open_settings(); await verify(want, "reopen (%s)" % label)
        await page.click("#settings-close"); await page.wait_for_timeout(300)
        await page.reload(); await page.wait_for_timeout(1800)
        await open_settings(); await verify(want, "after reload (%s)" % label)
        await page.click("#settings-close"); await page.wait_for_timeout(200)
        if label == "last option":                             # theme + text size must actually be applied, not just remembered
            t = await page.evaluate("[document.documentElement.getAttribute('data-theme'), document.documentElement.getAttribute('data-textsize')]")
            check(t == [want["settings-theme-row"], want["settings-textsize-row"]], "theme/text size not applied to the page: %s" % t)
    await open_settings()
    KEY = "AIzaE2E_key_0123456789ABCDEFGHIJ"
    await page.fill("#gdrive-client-id-input", "not-a-client-id"); await page.fill("#gdrive-api-key-input", KEY)
    await page.click("#btn-save-gdrive-credentials"); await page.wait_for_timeout(300)
    check(await page.evaluate("localStorage.getItem('nexus_gdrive_client_id')") is None, "an invalid client id must be rejected, not stored")
    await page.fill("#gdrive-client-id-input", "e2e-client.apps.googleusercontent.com")
    await page.click("#btn-save-gdrive-credentials"); await page.wait_for_timeout(300); await page.click("#settings-close")
    await page.reload(); await page.wait_for_timeout(1800); await open_settings()
    check(await page.input_value("#gdrive-client-id-input") == "e2e-client.apps.googleusercontent.com", "Drive client id not restored after reload")
    check(await page.input_value("#gdrive-api-key-input") == KEY, "Drive API key not restored after reload")
    await page.click("#btn-clear-gdrive-credentials"); await page.wait_for_timeout(300)
    check(await page.evaluate("localStorage.getItem('nexus_gdrive_api_key')") is None, "Clear API key did not remove the stored key")
    check(not c.errors, c.errors)
    await ctx.close()


async def t_settings_passcode_rows_persist(browser, base):
    ctx, page = await new_page(browser, base); c = Ctx(page)
    page.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
    await boot(page, base)
    await page.click("#btn-settings"); await page.wait_for_timeout(200)
    check(await page.evaluate("document.querySelector('#settings-passcodereentry-row button').disabled"), "re-entry interval must be disabled until a passcode exists")
    await page.click("#settings-close"); await set_passcode_ui(page)
    async def unlock_if_needed():
        if await page.evaluate("getComputedStyle(document.getElementById('lock-overlay')).display !== 'none'"):
            await page.fill("#lock-input", PASSCODE); await page.click("#lock-submit"); await page.wait_for_timeout(2500)
    for hours in ["1", "12", "24", "6"]:
        await page.click("#btn-settings"); await page.wait_for_timeout(200)
        await page.click("#settings-passcodereentry-row button[data-passcodereentry='%s']" % hours); await page.wait_for_timeout(200)
        act = await page.evaluate("document.querySelector('#settings-passcodereentry-row button.active').dataset.passcodereentry")
        check(act == hours, "re-entry %sh: shows %s" % (hours, act))
        st = await page.evaluate("JSON.parse(localStorage.getItem('nexus_pkm_v1_lock_reentry_v3')||'{}')")
        check(st.get("deadlineAt") and abs((st["deadlineAt"] - st["startedAt"]) - int(hours) * 3600000) < 5000, "re-entry timer not re-armed for %sh: %s" % (hours, st))
        await page.click("#settings-close"); await page.wait_for_timeout(200)
    await page.reload(); await page.wait_for_timeout(1800); await unlock_if_needed()
    await page.click("#btn-settings"); await page.wait_for_timeout(300)
    check(await page.evaluate("document.querySelector('#settings-passcodereentry-row button.active').dataset.passcodereentry") == "6", "re-entry interval not restored after reload")
    await page.click("#settings-passcode-launch-row button[data-passcoderequest='off']"); await page.wait_for_timeout(500)
    await page.click("#settings-close"); await page.reload(); await page.wait_for_timeout(2500); await unlock_if_needed()
    await page.click("#btn-settings"); await page.wait_for_timeout(300)
    check(await page.evaluate("document.querySelector('#settings-passcode-launch-row button.active').dataset.passcoderequest") == "off", "launch policy not restored after reload")
    check(not c.errors, c.errors)
    await ctx.close()


async def t_drive_sync_pauses_while_locked(browser, base):
    ctx, page = await new_page(browser, base); c = Ctx(page)
    page.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
    await boot(page, base)
    await set_passcode_ui(page)
    await page.evaluate("""() => { window.__cycles = 0; GOOGLE_DRIVE_CLIENT_ID = 'x.apps.googleusercontent.com'; GOOGLE_DRIVE_API_KEY = 'AIzaE2E_key_0123456789ABCDEFGHIJ';
      currentSettings.gdriveAutoSync = 'on'; gdriveAccessToken = 'tok'; localStorage.setItem(GDRIVE_AUTH_AT_KEY, String(Date.now()));
      window.gdrivePerformSyncCycle = function(){ window.__cycles++; }; }""")
    await page.evaluate("runGdriveSyncCycle()")
    check(await page.evaluate("window.__cycles") == 1, "sync cycle should run while unlocked")
    await page.evaluate("lockNow()"); await page.wait_for_timeout(500)
    await page.evaluate("runGdriveSyncCycle()")
    check(await page.evaluate("window.__cycles") == 1, "Drive sync must not run while the notebook is locked")
    await page.fill("#lock-input", PASSCODE); await page.click("#lock-submit"); await page.wait_for_timeout(2500)
    await page.evaluate("runGdriveSyncCycle()")
    check(await page.evaluate("window.__cycles") == 2, "Drive sync should resume after unlocking")
    check(not c.errors, c.errors)
    await ctx.close()



# ----------------------------------------------------------------------------------- sync conflicts & version history
HARNESS = os.path.join(ROOT, "tests", "e2e", "sync_harness.js")
VERSIONS = "()=>loadVersions().then(l=>l.map(v=>({ts:v.ts,reason:v.reason,kind:versionKind(v),pinned:!!v.pinned,named:!!(v.name||v.nameEnc),enc:!!v.enc,pages:v.pages,blocks:v.blocks})))"


async def t_sync_merge_convergence(browser, base):
    """Real merge/change-tracking code under controlled clocks: field tracking, delete-vs-edit, ties, skew, random sessions."""
    ctx, page = await new_page(browser, base); c = Ctx(page)
    await boot(page, base); await page.add_script_tag(path=HARNESS)
    r = await page.evaluate("""() => { const S = NexusSim, out = {};
      let b0 = S.baseState(), A = S.device(b0, 'devA'); const pid = Object.keys(b0.pages)[0], bid = Object.keys(b0.blocks)[0];
      S.edit(A, 5000, d => { d.pages[pid].icon = '🔥'; d.pages[pid].banner = 'ocean'; d.pages[pid].pinned = true; d.blocks[bid].locked = true; d.blocks[bid].dbViews = [{id:'v1'}]; });
      const m = S.merge(S.device(b0, 'devB'), A, 1500).state;
      out.fieldsSync = m.pages[pid].icon === '🔥' && m.pages[pid].banner === 'ocean' && m.pages[pid].pinned === true && m.blocks[bid].locked === true && !!m.blocks[bid].dbViews;
      b0 = S.baseState(); A = S.device(b0, 'devA'); const B = S.device(b0, 'devB'); const x = Object.keys(b0.blocks)[1];
      S.edit(A, 2100, d => { d.blocks[x].text = 'A EDITED THIS OFFLINE'; });
      S.edit(B, 2200, d => { const b = d.blocks[x]; const list = b.parent ? d.blocks[b.parent].children : d.pages[b.pageId].rootBlocks; list.splice(list.indexOf(x), 1); delete d.blocks[x]; });
      const dm = S.merge(A, B, 1500); const dm2 = S.merge(B, A, 1500);
      out.deleteVsEdit = {gone: !dm.state.blocks[x], recorded: dm.conflicts.filter(c => c.kind === 'line-deleted' && c.droppedText === 'A EDITED THIS OFFLINE').length, recordedReverse: dm2.conflicts.length, localLoss: dm.stats.localLoss};
      b0 = S.baseState(); const y = Object.keys(b0.blocks)[2]; A = S.device(b0, 'devA'); const B2 = S.device(b0, 'devB');
      A.blocks[y].text = 'variant-A'; B2.blocks[y].text = 'variant-B'; A.blocks[y].updatedAt = B2.blocks[y].updatedAt = 3000; A.blocks[y].updatedBy = B2.blocks[y].updatedBy = 'same';
      out.tieCommutes = S.canonJson(S.merge(A, B2, null).state) === S.canonJson(S.merge(B2, A, null).state);
      b0 = S.baseState(); const z = Object.keys(b0.blocks)[3]; A = S.device(b0, 'devA'); const Bs = S.device(b0, 'devB');
      S.edit(Bs, 10000 + 3600000, d => { d.blocks[z].text = 'B (clock 1h fast)'; });
      const synced = S.merge(A, Bs, 1500).state; S.edit(synced, 20000, d => { d.blocks[z].text = 'A later real edit'; });
      out.skewLaterEditWins = S.merge(synced, Bs, 1500).state.blocks[z].text === 'A later real edit';
      out.random = S.randomTrials(600, 12345); out.protocol = S.protocolTrials(1500, 4242);
      return out; }""")
    check(r["fieldsSync"], "icon/banner/pinned/locked/saved-view changes must sync to the other device")
    check(r["deleteVsEdit"]["gone"] and r["deleteVsEdit"]["recorded"] == 1 and r["deleteVsEdit"]["localLoss"] >= 1, "an edit lost to a deletion must be recorded as a conflict: %s" % r["deleteVsEdit"])
    check(r["tieCommutes"], "merge must give the same result in either order when stamps tie")
    check(r["skewLaterEditWins"], "a later real edit must beat an earlier edit from a fast clock")
    f = r["random"]["fails"]
    check(not f.get("not-commutative") and not f.get("invariant"), "random sessions diverged or broke the tree: %s %s" % (f, r["random"]["sample"]))
    check(sum(v for k, v in f.items() if k.startswith("not-idempotent")) <= 6, "too many order-only re-merge differences: %s" % f)
    check(r["protocol"]["notConverged"] == 0, "pull-merge-push did not converge: %s" % r["protocol"])
    check(not c.errors, c.errors)
    await ctx.close()


async def t_drive_cycle_recovers_and_settles(browser, base):
    """A whole Drive sync cycle (network stubbed): conflict + safety snapshot + recovery, then a quiet second cycle."""
    ctx, page = await new_page(browser, base); c = Ctx(page)
    page.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
    await boot(page, base)
    await page.evaluate(MK_PAGE, ["Sync Page", ["base text", "second line"], []]); await page.evaluate("save()")
    x = await page.evaluate("state.pages[state.titleIndex['sync page']].rootBlocks[0]")
    await page.evaluate("""(x) => { window.__remote = JSON.parse(JSON.stringify(state)); window.__remote.deviceId = 'devRemote';
      const rb = window.__remote.blocks[x]; rb.text = 'remote edit'; rb.updatedAt = Date.now() + 5000; rb.updatedBy = 'devRemote';
      state.syncPeers = state.syncPeers || {}; state.syncPeers.gdrive = Date.now() - 60000;
      state.blocks[x].text = 'local edit'; save();                                   // edited here after the last sync too
      window.__pushes = 0; window.__applied = 0; const ap = window.applyIncomingMerge; window.applyIncomingMerge = function(m){ window.__applied++; return ap.apply(this, arguments); };
      window.gdriveFindSyncFile = cb => cb('file'); window.gdrivePullSyncState = () => Promise.resolve({data: window.__remote});
      window.gdrivePushSyncState = () => { window.__pushes++; window.__remote = JSON.parse(JSON.stringify(state)); return Promise.resolve(); }; }""", x)
    async def cycle(): await page.evaluate("new Promise(r => gdriveRunSyncCycleBody(r))"); await page.wait_for_timeout(700)
    await cycle()
    check(await page.evaluate("(x)=>state.blocks[x].text", x) == "remote edit", "the newer remote edit should win")
    confl = await page.evaluate("loadConflicts().map(c=>({kind:c.kind, dropped:c.droppedText, kept:c.keptText}))")
    check(len(confl) == 1 and confl[0]["kind"] == "line" and confl[0]["dropped"] == "local edit", "the dropped local edit must be logged: %s" % confl)
    snaps = await page.evaluate("()=>loadVersions().then(async l=>{ const out=[]; for(const v of l){ out.push({reason:v.reason, kind:versionKind(v), has: (await getVersionData(v)).indexOf('local edit')>=0}); } return out; })")
    check(any(s["kind"] == "sync" and s["has"] for s in snaps), "a safety snapshot holding the pre-merge text must exist: %s" % snaps)
    check(await page.evaluate("window.__pushes") == 1 and await page.evaluate("window.__applied") == 1, "cycle should apply once and push once")
    n_versions = len(snaps)
    await cycle()                                                                    # nothing changed anywhere: must be silent
    check(await page.evaluate("window.__applied") == 1, "an unchanged second cycle must not re-apply a merge (ping-pong)")
    check(len(await page.evaluate("loadVersions()")) == n_versions and len(await page.evaluate("loadConflicts()")) == 1, "second cycle must not add snapshots or duplicate conflicts")
    # delete-vs-edit through the same cycle, then recover the line from the conflict log
    y = await page.evaluate("state.pages[state.titleIndex['sync page']].rootBlocks[1]")
    await page.evaluate("""(y) => { window.__remote = JSON.parse(JSON.stringify(state)); window.__remote.deviceId = 'devRemote';
      delete window.__remote.blocks[y]; const pg = window.__remote.pages[state.blocks[y].pageId]; pg.rootBlocks = pg.rootBlocks.filter(i => i !== y);
      window.__remote.tombstones.blocks[y] = Date.now() + 5000; state.syncPeers.gdrive = Date.now() - 60000;
      state.blocks[y].text = 'second line, edited here'; save(); }""", y)
    await cycle()
    confl = await page.evaluate("loadConflicts().filter(c=>c.kind==='line-deleted').map(c=>c.droppedText)")
    check(confl == ["second line, edited here"], "deleted-elsewhere-but-edited-here must be logged: %s" % confl)
    await page.evaluate("()=>{ const c = loadConflicts().find(c=>c.kind==='line-deleted'); restoreDeletedLine(c, c.droppedText); }"); await page.wait_for_timeout(500)
    check(await page.evaluate("Object.values(state.blocks).some(b=>b.text==='second line, edited here')"), "restoring the lost line must bring its text back")
    check(not c.errors, c.errors)
    await ctx.close()


async def t_version_history_snapshots(browser, base):
    ctx, page = await new_page(browser, base); c = Ctx(page)
    page.on("dialog", lambda d: asyncio.ensure_future(d.accept("First draft")) if d.type == "prompt" else asyncio.ensure_future(d.accept()))
    await boot(page, base)
    pid = await page.evaluate(MK_PAGE, ["History Page", ["line one", "line two", "line three"], []]); await page.evaluate("save()")
    other = await page.evaluate(MK_PAGE, ["Other Page", ["untouched"], []]); await page.evaluate("save()")
    await page.evaluate("()=>snapshotVersion('s1', {kind:'manual', force:true})"); await page.wait_for_timeout(300)
    # identical notebook is not stored twice; metadata is recorded
    check(await page.evaluate("()=>snapshotVersion('dup')") is None, "an unchanged notebook must not create a duplicate snapshot")
    v = (await page.evaluate(VERSIONS))[-1]; check(v["pages"] >= 2 and v["blocks"] >= 4 and v["kind"] == "manual", "snapshot metadata missing: %s" % v)
    # change the page, and a different page, then bring back ONLY the first
    await page.evaluate("""([pid, other]) => { const p = state.pages[pid]; state.blocks[p.rootBlocks[0]].text = 'line one CHANGED'; delete state.blocks[p.rootBlocks[1]]; p.rootBlocks.splice(1,1);
      const b = uid(); state.blocks[b] = mkBlock(b, pid, null, 'brand new line'); p.rootBlocks.push(b); state.blocks[state.pages[other].rootBlocks[0]].text = 'other page edited'; save(); }""", [pid, other])
    ts = (await page.evaluate(VERSIONS))[-1]["ts"]
    ok = await page.evaluate("""(ts) => loadVersions().then(l => getVersionData(l.find(v => v.ts === ts))).then(j => restorePageFromSnapshot(JSON.parse(j), %s))""" % json.dumps(pid), ts)
    check(ok, "page restore failed")
    outline = await page.evaluate("(pid)=>state.pages[pid].rootBlocks.map(i=>state.blocks[i].text)", pid)
    check(outline == ["line one", "line two", "line three"], "page not restored exactly: %s" % outline)
    check(await page.evaluate("(o)=>state.blocks[state.pages[o].rootBlocks[0]].text", other) == "other page edited", "restoring one page must leave other pages alone")
    check(any(x["kind"] == "safety" and "restoring page" in x["reason"] for x in await page.evaluate(VERSIONS)), "a safety snapshot must precede a page restore")
    # a permanently deleted page can be brought back from the automatic pre-delete snapshot
    await page.evaluate("(pid)=>permanentlyDeletePage(pid)", pid); await page.wait_for_timeout(600)
    check(not await page.evaluate("(pid)=>!!state.pages[pid]", pid), "page should be gone after permanent delete")
    ts = next(x["ts"] for x in await page.evaluate(VERSIONS) if "permanently deleting" in x["reason"])
    await page.evaluate("""(ts) => loadVersions().then(l => getVersionData(l.find(v => v.ts === ts))).then(j => restorePageFromSnapshot(JSON.parse(j), %s))""" % json.dumps(pid), ts)
    check(await page.evaluate("(pid)=>state.pages[pid].rootBlocks.map(i=>state.blocks[i].text)", pid) == ["line one", "line two", "line three"], "deleted page not recovered")
    # pin / name / retention
    await page.evaluate("()=>snapshotVersion('keep me', {kind:'manual', force:true, name:'Milestone'})"); await page.wait_for_timeout(200)
    keep = next(x["ts"] for x in await page.evaluate(VERSIONS) if x["reason"] == "keep me")
    await page.evaluate("""async () => { for(let i=0;i<40;i++){ state.pages[Object.keys(state.pages)[0]].icon = 'x'+i; await snapshotVersion('bulk '+i, {kind:'auto', force:true}); } }""")
    vs = await page.evaluate(VERSIONS)
    check(sum(1 for x in vs if not x["pinned"] and not x["named"]) <= 30, "unpinned snapshots must be capped at 30, found %d" % len(vs))
    check(any(x["ts"] == keep and x["named"] for x in vs), "a named snapshot must survive pruning")
    # the list UI
    await page.click("#btn-settings") if False else None
    await page.evaluate("openVersions()"); await page.wait_for_timeout(600)
    check(await page.locator("#versions-list .version-item").count() >= 5, "versions list did not render")
    await page.select_option("#versions-filter", "pinned"); await page.wait_for_timeout(400)
    check(await page.locator("#versions-list .version-item").count() >= 1 and "Milestone" in await page.inner_text("#versions-list"), "pinned & named filter should show the named snapshot")
    await page.select_option("#versions-filter", "all"); await page.fill("#versions-name-input", "Before the big refactor"); await page.click("#versions-create-btn"); await page.wait_for_timeout(600)
    check("Before the big refactor" in await page.inner_text("#versions-list"), "a snapshot saved from the dialog should appear named")
    check(not c.errors, c.errors)
    await ctx.close()


async def t_page_history_and_diff_ui(browser, base):
    ctx, page = await new_page(browser, base); c = Ctx(page)
    page.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
    await boot(page, base)
    pid = await page.evaluate(MK_PAGE, ["Ledger", ["alpha beta gamma"], []]); await page.evaluate("save()")
    await page.evaluate("(pid)=>openPage(pid)", pid); await page.wait_for_timeout(500)
    await page.evaluate("()=>snapshotVersion('v1', {kind:'manual', force:true})"); await page.wait_for_timeout(200)
    await page.evaluate("(pid)=>{ state.blocks[state.pages[pid].rootBlocks[0]].text = 'alpha BETA gamma delta'; save(); }", pid)
    await page.evaluate("()=>snapshotVersion('v2', {kind:'manual', force:true})"); await page.wait_for_timeout(200)
    await page.evaluate("(pid)=>{ state.blocks[state.pages[pid].rootBlocks[0]].text = 'completely different now'; save(); }", pid)
    await page.click("#btn-page-history"); await page.wait_for_selector("#versions-list .version-item", timeout=8000)
    check("History of" in await page.inner_text("#versions-title") and "Ledger" in await page.inner_text("#versions-title"), "page history title missing")
    rows = await page.locator("#versions-list .version-item").count(); check(rows == 2, "expected two distinct earlier versions, got %d" % rows)
    await page.locator("#versions-list .version-item").first.locator("button", has_text="Compare").click(); await page.wait_for_timeout(700)
    check(await page.locator("#diff-list .wd-ins, #diff-list .wd-del").count() >= 1, "word-level highlighting missing in the comparison")
    await page.locator("#diff-list .diff-line-btn").first.click(); await page.wait_for_timeout(400)         # use the snapshot's line
    check(await page.evaluate("(pid)=>state.blocks[state.pages[pid].rootBlocks[0]].text", pid) == "alpha BETA gamma delta", "line restore from the comparison failed")
    await page.click("#diff-close-btn"); await page.wait_for_timeout(200)
    await page.locator("#versions-list .version-item").last.locator("button", has_text="Restore this version").click(); await page.wait_for_timeout(1500)
    check(await page.evaluate("(pid)=>state.blocks[state.pages[pid].rootBlocks[0]].text", pid) == "alpha beta gamma", "page history restore failed")
    check(not c.errors, c.errors)
    await ctx.close()


async def t_version_history_passcode_lifecycle(browser, base):
    ctx, page = await new_page(browser, base); c = Ctx(page)
    page.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
    await boot(page, base)
    await page.evaluate(MK_PAGE, ["Secret", ["SENTINEL-VH-42 in a note"], []]); await page.evaluate("save()")
    await page.evaluate("()=>snapshotVersion('before passcode', {kind:'manual', force:true, name:'NAME-SENTINEL-77'})"); await page.wait_for_timeout(500)
    scan = """(needle) => new Promise((res) => { const hits = []; for (let i=0;i<localStorage.length;i++){ const k=localStorage.key(i); if((localStorage.getItem(k)||'').indexOf(needle)>=0) hits.push('ls:'+k); }
      const r = indexedDB.open('nexus_attachments'); r.onsuccess = () => { const db=r.result; const names=Array.from(db.objectStoreNames); let pending=names.length;
        names.forEach(n => { const g = db.transaction(n).objectStore(n).getAll(); g.onsuccess = () => { (g.result||[]).forEach(v => { let s=''; try{ s = typeof v==='string' ? v : JSON.stringify(v,(k,x)=>x instanceof Blob?'[blob]':x); }catch(e){} if(s.indexOf(needle)>=0) hits.push('idb:'+n); }); if(--pending===0) res(hits); }; }); }; })"""
    await page.evaluate("recordConflicts([{kind:'line',entityId:'x',pageId:'y',pageTitle:'Secret',keptText:'CONFLICT-SENTINEL-kept',droppedText:'CONFLICT-SENTINEL-dropped'}],'Test')"); await page.wait_for_timeout(500)
    check("idb:versions" in await page.evaluate(scan, "SENTINEL-VH-42") and not [h for h in await page.evaluate(scan, "CONFLICT-SENTINEL") if h.startswith("ls:")], "precondition: conflict log must never be in localStorage")
    await set_passcode_ui(page); await page.wait_for_timeout(1200)
    for needle in ["SENTINEL-VH-42", "NAME-SENTINEL-77", "CONFLICT-SENTINEL"]:
        hits = await page.evaluate(scan, needle); check(hits == [], "%r still stored as plaintext after setting a passcode: %s" % (needle, hits))
    v = (await page.evaluate(VERSIONS))
    check(v and all(x["enc"] for x in v), "every snapshot must be encrypted once a passcode is set: %s" % v)
    await page.evaluate("openVersions()"); await page.wait_for_timeout(700)
    check("NAME-SENTINEL-77" in await page.inner_text("#versions-list"), "an encrypted name must still display while unlocked")
    await page.evaluate("closeVersions()")
    await page.evaluate("""() => { window.__fail = true; const o = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function(v){ if(window.__fail && this.name === 'notebook') throw new Error('injected'); return o.apply(this, arguments); }; }""")
    res = await page.evaluate("removePasscodeConfirmed('%s').then(v=>'resolved:'+v, e=>'rejected')" % PASSCODE); await page.evaluate("window.__fail = false")
    check(res == "rejected" and await page.evaluate("isLockEnabled()"), "a failing removal must keep the passcode")
    check(all(x["enc"] for x in await page.evaluate(VERSIONS)), "a failed removal must leave snapshots encrypted")
    check(await page.evaluate("removePasscodeConfirmed('%s')" % PASSCODE) is True, "removal should succeed once storage works"); await page.wait_for_timeout(1200)
    readable = await page.evaluate("()=>loadVersions().then(async l=>{ const out=[]; for(const v of l){ try{ out.push((await getVersionData(v)).indexOf('SENTINEL-VH-42')>=0 || v.reason!=='before passcode'); }catch(e){ out.push(false); } } return out; })")
    check(readable and all(readable), "snapshots must stay readable after the passcode is removed: %s" % readable)
    check((await page.evaluate("loadVersions().then(l=>l.find(v=>v.reason==='before passcode').name)")) == "NAME-SENTINEL-77", "snapshot name lost when the passcode was removed")
    await page.reload(); await page.wait_for_timeout(1800)
    check(len(await page.evaluate("loadConflicts()")) == 1, "conflict log must survive removal and reload")
    check(not c.errors, c.errors)
    await ctx.close()


async def t_conflicts_panel(browser, base):
    ctx, page = await new_page(browser, base); c = Ctx(page); confirms = []
    def on_dialog(d): confirms.append(d.type); asyncio.ensure_future(d.accept())
    page.on("dialog", on_dialog)
    await boot(page, base)
    P = "<img src=x onerror=window.__xss=1>"; await page.evaluate("window.__xss = 0")
    pid = await page.evaluate(MK_PAGE, ["Conflict Page", ["shared line " + P], [{"key": "status", "value": "open", "type": "text"}]]); await page.evaluate("save()")
    b = await page.evaluate("(pid)=>state.pages[pid].rootBlocks[0]", pid)
    rec = "(a)=>recordConflicts([{kind:'line', entityId:a[0], pageId:a[1], pageTitle:'Conflict Page', keptText:'the quick brown fox '+a[2], droppedText:'the slow brown dog '+a[2]}], 'Google Drive')"
    await page.evaluate(rec, [b, pid, P]); await page.evaluate(rec, [b, pid, P])
    check(await page.evaluate("loadConflicts().length") == 1, "the same conflict must not be logged twice")
    await page.evaluate("(a)=>{ state.blocks[a].text = 'edited again after the sync'; save(); }", b)
    await page.evaluate("openConflicts()"); await page.wait_for_timeout(400)
    check(await page.locator("#conflicts-list .wd-diff").count() >= 2, "differing words should be highlighted")
    check(await page.locator("#conflicts-list .conflict-version.current").count() == 1, "a line changed since the sync should show its current text")
    x = await page.evaluate(XSS_SCAN); check(x["x"] == 0 and not x["bad"], "conflict text injected markup: %s" % x)
    await page.locator("#conflicts-list .conflict-merge summary").click(); await page.fill("#conflicts-list .conflict-merge textarea", "the quick brown dog")
    await page.locator("#conflicts-list .conflict-merge button").click(); await page.wait_for_timeout(500)
    check(await page.evaluate("(a)=>state.blocks[a].text", b) == "the quick brown dog" and await page.evaluate("loadConflicts().length") == 0, "combined text should be saved and the conflict cleared")
    # properties conflict, and switching to the other version asks first only for a line that changed since
    await page.evaluate("(pid)=>recordConflicts([{kind:'properties', entityId:pid, pageId:pid, pageTitle:'Conflict Page', keptText:'status: open', droppedText:'status: done', droppedProps:[{key:'status',value:'done',type:'text'}]}],'LAN')", pid)
    await page.evaluate("openConflicts()"); await page.wait_for_timeout(300)
    await page.locator("#conflicts-list button", has_text="Use the other properties").click(); await page.wait_for_timeout(400)
    check(await page.evaluate("(pid)=>state.pages[pid].properties[0].value", pid) == "done", "the other properties should have been applied")
    # deleted-page recovery lands on 'Recovered from sync'
    await page.evaluate("()=>recordConflicts([{kind:'line-deleted', entityId:'gone', pageId:'no-such-page', pageTitle:'(deleted page)', keptText:'(its page was deleted on another device)', droppedText:'rescued words'}],'Drive')")
    await page.evaluate("openConflicts()"); await page.wait_for_timeout(300)
    await page.locator("#conflicts-list button", has_text="Restore as a new line").click(); await page.wait_for_timeout(600)
    check(await page.evaluate("(()=>{ const id = state.titleIndex['recovered from sync']; return !!id && state.pages[id].rootBlocks.some(b=>state.blocks[b].text==='rescued words'); })()"), "the lost line should be recovered on a 'Recovered from sync' page")
    check(not c.errors, c.errors)
    await ctx.close()


async def t_versions_ui_is_text_only(browser, base):
    ctx, page = await new_page(browser, base)
    await boot(page, base)
    P = "<img src=x onerror=window.__xss=1>"; await page.evaluate("window.__xss = 0")
    await page.evaluate("""(P) => snapshotVersion(P, {kind:'manual', force:true, name:P})""", P); await page.wait_for_timeout(400)
    await page.evaluate("openVersions()"); await page.wait_for_timeout(600)
    r = await page.evaluate(XSS_SCAN); check(r["x"] == 0 and not r["bad"], "snapshot names/reasons must render as text: %s" % r)
    check(P in await page.inner_text("#versions-list"), "payload should be visible as literal text")
    await ctx.close()


async def t_three_devices_share_one_drive_file(browser, base):
    """Three devices pulling/merging/pushing through one shared file, including stale pulls that overwrite each other's push."""
    ctx, page = await new_page(browser, base); c = Ctx(page)
    await boot(page, base); await page.add_script_tag(path=HARNESS)
    a = await page.evaluate("NexusSim.driveTrials(1500, 21, null, false, 40)")
    check(a["notConvergedOrBroken"] == 0, "three devices did not settle on the same notebook: %s" % a["sample"])
    check(max(int(k) for k in a["rounds"]) <= 25, "settling took too many sync rounds: %s" % a["rounds"])
    safe = ["edit", "add", "rename", "addPage", "icon", "collapse", "prop", "reorder"]
    b = await page.evaluate("(s)=>NexusSim.driveTrials(1500, 22, s, true, 40)", safe)
    check(b["notConvergedOrBroken"] == 0 and b["lostAdds"] == 0, "lines added on one device must reach all three: %s" % b)
    check(not c.errors, c.errors)
    await ctx.close()


TESTS = [t_boot_clean, t_nav_crawl, t_footnotes, t_daily_calendar_31st, t_tasks_recurrence, t_flashcards_typing_guard, t_undo_guard, t_multi_select_bulk_delete,
         t_tabs_persist, t_offline_first_visit, t_passcode_launch_policy, t_backup_restore_and_encrypted, t_mobile_layout, t_xss_sweep, t_find_replace_literal, t_formatting_and_attachments_persist,
         t_load_failure_never_overwrites, t_flush_before_load_is_harmless, t_typing_autosaves_without_blur, t_passcode_set_failure_keeps_data, t_passcode_removal_failure_keeps_lock,
         t_trashed_pages_are_not_backlinks, t_task_group_labels_are_text, t_saved_view_cancel_is_isolated, t_xss_deep_views, t_settings_round_trip, t_settings_passcode_rows_persist, t_drive_sync_pauses_while_locked,
         t_sync_merge_convergence, t_drive_cycle_recovers_and_settles, t_version_history_snapshots, t_page_history_and_diff_ui,
         t_version_history_passcode_lifecycle, t_conflicts_panel, t_versions_ui_is_text_only, t_three_devices_share_one_drive_file]


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
