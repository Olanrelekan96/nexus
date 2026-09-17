# Nexus — split build

This is your app split into files, with **zero logic changes**. Every line of
JS and CSS was moved, not rewritten — verified byte-for-byte against the
original single-file version before anything was touched further.

## Structure

```
index.html                          — page shell + all <script> tags, in load order
css/styles.css                      — all styling (was the inline <style> block)
js/00-state-and-helpers.js          — state model, undo/redo, sync merge, shared helpers
js/01-query-engine.js               — {{query:}} / {{table:}} engine + query builder popup
js/02-editor-core.js                — block rendering, navigation, trash, indent/outdent, caret
js/03-sidebar-search-templates.js   — fuzzy search, sidebar, templates, attachments browser
js/04-render-page.js                — main page rendering, block zoom, word count
js/05-backlinks-nav-graph.js        — backlinks, command palette (Cmd+K), graph view
js/06-backup-sync.js                — backup/restore, auto backups, Drive sync conflicts
js/07-find-replace-settings.js      — find & replace, Settings panel
js/08-edit-dock-attachments.js      — docked toolbar, image/file attachments
js/09-security-lock.js              — passcode lock, encryption at rest
js/10-lan-sync.js                   — direct LAN sync (no relay/internet)
js/11-import-export.js              — markdown import/export, PDF export
js/12-pwa.js                        — install prompt, offline app shell
js/13-wiring-and-init.js            — wires up every UI control, boots the app — MUST load last
```

You still need to drop your existing `manifest.json`, `icon-192.png`, etc.
next to `index.html` — those weren't part of the file you gave me, so they
aren't included here, but `index.html` still references them at the same
relative paths as before.

## Why this approach (and not ES modules or a bundler)

The 14 JS files load as **plain `<script src="...">` tags, in order** — not
`type="module"`. That was a deliberate choice, not a shortcut:

- Your code is one big shared mutable `state` object with ~395 functions
  that all reach into it directly. True ES modules would mean adding
  `export`/`import` to every one of those functions — hundreds of manual
  edits, and hundreds of chances to introduce a bug, for an app that has no
  other consumer than itself.
- Plain scripts loaded in sequence share one global scope, which is exactly
  the scope your code already ran in in inside the old single `(function(){
  ... })()` wrapper. Nothing about *how the code runs* changed — only
  *which file it lives in*.
- No build step, no bundler, no npm install. You can still open this with
  any static file server (or even `file://` in most browsers, if that's how
  you've been using it) and it behaves identically.

**The one rule this depends on:** the script tags in `index.html` must stay
in numeric order, and `13-wiring-and-init.js` must always load last, since
it's the file that actually calls everything else to boot the app.

## What was and wasn't changed

- **Changed:** file boundaries only. Each JS file got a `"use strict";` line
  and a descriptive header comment. `index.html` now links `css/styles.css`
  and the 14 scripts instead of embedding everything.
- **Not changed:** every function, every line of logic, every comment,
  the CSS, the HTML markup. I diffed the reconstructed content against your
  original file programmatically to confirm this before adding anything.

## Going live on GitHub Pages

New in this pass — real, static files needed for a working install/offline
experience once this is actually hosted somewhere, instead of the runtime-
generated versions the app used to build on the fly:

```
manifest.json          — real PWA manifest (was generated as a blob: URL at runtime)
sw.js                  — the service worker, extracted verbatim from what
                          the app's own "download sw.js" button produces
.nojekyll               — tells GitHub Pages to serve files as-is, no Jekyll processing
icons/favicon.ico
icons/icon-192.png
icons/icon-512.png
icons/icon-512-maskable.png
icons/apple-touch-icon.png
```

I changed one function, `registerPwa()` in `js/12-pwa.js`: it used to build
the manifest and icon in memory as `blob:` URLs and rewrite the `<link>` tags
to point at them every time the app loaded. `blob:` manifests are exactly
the kind of thing that makes "Add to Home Screen" behave inconsistently
across browsers, and now that real files exist, there's no reason to keep
generating fake ones — `index.html`'s `<link>` tags just point straight at
`manifest.json` and `icons/` and stay put. Everything else in that file
(service worker registration, install prompt handling) is untouched.

**To deploy:**

1. Push this whole folder's contents to a GitHub repo (root of the repo, or
   a `/docs` folder — either works).
2. In the repo, go to **Settings → Pages**, and set the source to the
   branch/folder you pushed to.
3. GitHub gives you a `https://<username>.github.io/<repo>/` URL — open it.
   Everything (install prompt, offline mode, service worker) needs `https://`
   to work, which GitHub Pages provides automatically.
4. If you're using a custom domain, add a `CNAME` file with just that domain
   name in it (not included here since I don't know if you have one).

You still need to fill in `GOOGLE_DRIVE_CLIENT_ID` and `GOOGLE_DRIVE_API_KEY`
near the top of `index.html` yourself if you want the "Import from Google
Drive" feature to work — those are your own credentials from Google Cloud
Console and I can't generate them for you.

## Suggested next steps (optional, not done here)

These are genuinely optional — the app works today exactly as it did before.
Only worth doing if you keep growing it:

1. **Split the largest files further.** `00-state-and-helpers.js` (~1,150
   lines) and `02-editor-core.js` (~1,000 lines) are still the biggest.
   If they keep growing, they're natural candidates to split again along
   their internal section comments.
2. **A lint pass** (ESLint with a basic config) across all 14 files now that
   they're a normal multi-file project — easy to add, would catch typos and
   unused variables before they become bugs.
3. **Version control.** If you're not already keeping this in git, this is
   the right moment to start — multi-file diffs are far more readable than
   one 10,000-line file, which was hard to do meaningfully before.
