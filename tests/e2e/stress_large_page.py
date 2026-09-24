#!/usr/bin/env python3
"""Diagnostic (not part of the regular suite): find the NEXT render bottleneck
for a very large single page, now that the O(page x notebook) reference-scan
fix is in. Creates a page with N plain-text sibling blocks directly in state,
times renderOutline() at several sizes, and times a single post-load edit's
re-render to see whether ongoing editing on a huge page also degrades.

Run:  python3 tests/e2e/stress_large_page.py
"""
import asyncio, functools, http.server, os, socket, sys, threading
from playwright.async_api import async_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass


def start_server():
    port = free_port()
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Quiet, directory=ROOT))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, port


SIZES = [1000, 3000, 10000, 20000, 30000]


async def main():
    srv, port = start_server()
    base = "http://127.0.0.1:%d" % port
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=not os.environ.get("NEXUS_E2E_HEADED"))
        ctx = await browser.new_context(viewport={"width": 1280, "height": 900})
        await ctx.route("**/accounts.google.com/**", lambda r: r.abort())
        await ctx.route("**/apis.google.com/**", lambda r: r.abort())
        page = await ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)[:200]))
        await page.goto(base + "/index.html"); await page.wait_for_timeout(1500)

        print("%8s  %12s  %12s  %10s" % ("blocks", "renderPage", "1-char edit", "dom nodes"))
        for n in SIZES:
            result = await page.evaluate("""(n) => {
                const p = state.pages[state.currentPageId];
                p.rootBlocks = [];
                for (let i = 0; i < n; i++) {
                    const id = uid();
                    state.blocks[id] = mkBlock(id, p.id, null, 'Line number ' + i + ' with some ordinary note text.');
                    p.rootBlocks.push(id);
                }
                const t0 = performance.now();
                save();
                renderPage();
                const t1 = performance.now();

                // Simulate one keystroke's worth of re-render cost on the last block,
                // the realistic "still editing on a huge page" case.
                const lastId = p.rootBlocks[p.rootBlocks.length - 1];
                state.blocks[lastId].text += '!';
                const t2 = performance.now();
                renderPage();
                const t3 = performance.now();

                return {
                    renderMs: t1 - t0,
                    editRenderMs: t3 - t2,
                    domNodes: document.querySelectorAll('#outline *').length
                };
            }""", n)
            print("%8d  %10.1fms  %10.1fms  %10d" % (n, result["renderMs"], result["editRenderMs"], result["domNodes"]))

        if errors:
            print("\nJS ERRORS OBSERVED:")
            for e in errors[:10]:
                print(" -", e)
        await ctx.close()
        await browser.close()
    srv.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
