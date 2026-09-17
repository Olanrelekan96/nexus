/* ============================================================
 * 13-slash-and-context-menus.js
 * Two input surfaces layered on top of the existing editor:
 *
 *   1. "/" commands — typing a slash at the start of a word inside a
 *      block opens a filterable command list at the caret. Picking a
 *      command removes the typed "/token" and performs the action.
 *   2. Right-click context menus — on a block row, on selected text,
 *      on a sidebar page/tag/template row, on the page title, and on
 *      empty outline space.
 *
 * Both are additive: every command here calls the same functions the
 * existing buttons and menus already call, so there is exactly one
 * implementation of "make this a heading", "indent", "trash this
 * page", etc. Nothing in here owns state of its own beyond which
 * menu is currently open.
 *
 * Part of Nexus — loaded as a plain <script> (not a module) in
 * index.html, in numeric filename order. All files share one global
 * scope on purpose (same as the original single-file build), so
 * `state`, helper functions, etc. declared in an earlier file are
 * directly usable here without imports.
 * ============================================================ */
"use strict";

/* ============================================================
   SHARED: a small generic dropdown
   Used by every context menu except the block-row one, which reuses
   the existing openBlockMenu (passing it pointer coordinates) so the
   "⋯" button and right-click can never drift apart.
   ============================================================ */
var ctxMenuCleanup = null;

function closeCtxMenu(){
  var existing = document.querySelector('.ctx-menu');
  if(existing) existing.remove();
  if(ctxMenuCleanup){ ctxMenuCleanup(); ctxMenuCleanup = null; }
}

/* items: array of
     {icon, label, sub, disabled, danger, onClick}
     {divider:true}
     {header:'Text'}                                              */
function openCtxMenu(items, x, y){
  closeCtxMenu();
  closeBlockMenu();

  var menu = document.createElement('div');
  menu.className = 'ctx-menu';

  items.forEach(function(it){
    if(it.divider){
      var d = document.createElement('div');
      d.className = 'ctx-menu-divider';
      menu.appendChild(d);
      return;
    }
    if(it.header){
      var h = document.createElement('div');
      h.className = 'ctx-menu-header';
      h.textContent = it.header;
      menu.appendChild(h);
      return;
    }
    var item = document.createElement('button');
    item.type = 'button';
    item.className = 'ctx-menu-item' + (it.danger ? ' danger' : '');
    item.disabled = !!it.disabled;
    var icon = document.createElement('span');
    icon.className = 'cmi-icon';
    icon.textContent = it.icon || '';
    var label = document.createElement('span');
    label.className = 'cmi-label';
    label.textContent = it.label;
    item.appendChild(icon);
    item.appendChild(label);
    if(it.sub){
      var sub = document.createElement('span');
      sub.className = 'cmi-sub';
      sub.textContent = it.sub;
      item.appendChild(sub);
    }
    if(!it.disabled){
      item.onclick = function(e){
        e.stopPropagation();
        closeCtxMenu();
        it.onClick();
      };
    }
    menu.appendChild(item);
  });

  /* Keeps the block's contenteditable focused (and its text selection
     intact) while the menu is clicked — same trick the edit dock uses. */
  menu.addEventListener('mousedown', function(e){ e.preventDefault(); });

  function onOutside(e){ if(!menu.contains(e.target)) closeCtxMenu(); }
  function onEsc(e){ if(e.key === 'Escape') closeCtxMenu(); }
  /* A scroll anywhere else moves the thing the menu was opened on, so
     close — but scrolling the menu's own overflow must not close it. */
  function onScroll(e){ if(!e || !menu.contains(e.target)) closeCtxMenu(); }
  document.addEventListener('mousedown', onOutside);
  document.addEventListener('contextmenu', onOutside);
  document.addEventListener('keydown', onEsc);
  window.addEventListener('resize', onScroll);
  document.addEventListener('scroll', onScroll, true);
  ctxMenuCleanup = function(){
    document.removeEventListener('mousedown', onOutside);
    document.removeEventListener('contextmenu', onOutside);
    document.removeEventListener('keydown', onEsc);
    window.removeEventListener('resize', onScroll);
    document.removeEventListener('scroll', onScroll, true);
  };

  document.body.appendChild(menu);
  positionFloating(menu, x, y);
}

/* Places a fixed-position element near (x, y), flipping it up/left
   instead of letting it run off the bottom or right edge. */
function positionFloating(el, x, y){
  var w = el.offsetWidth, h = el.offsetHeight;
  var left = x;
  if(left + w > window.innerWidth - 8) left = Math.max(8, x - w);
  if(left < 8) left = 8;
  var top = y;
  if(top + h > window.innerHeight - 8) top = Math.max(8, y - h);
  if(top < 8) top = 8;
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

/* ============================================================
   SHARED: block-text editing helpers
   Every "/" command that changes a line's text funnels through
   applyBlockText, which is deliberate about one thing: the block's
   blur handler commits whatever is in the DOM back onto the block,
   so the contenteditable is switched off *before* state changes.
   Otherwise a blur firing mid-update would write the stale text
   (still containing the typed "/command") straight back over us.
   ============================================================ */
function applyBlockText(block, newText, caretOffset){
  var editingEl = document.querySelector('.block-content.editing');
  if(editingEl) editingEl.contentEditable = 'false';
  block.text = newText;
  save();
  focusBlock(block.id, caretOffset); /* focusBlock re-renders for us */
}

/* Strips a leading heading ("## ") and/or to-do ("[ ] ") marker so a
   line can be re-typed as something else without stacking prefixes. */
function stripLineMarkers(text){
  var t = text || '';
  var h = headingInfo(t);
  if(h) t = h.rest;
  var td = todoInfo(t);
  if(td) t = td.rest;
  return t;
}

function editingBlockEl(){
  return document.querySelector('.block-content.editing');
}

function blockOfEl(el){
  var row = el && el.closest ? el.closest('.block-row') : null;
  return row ? state.blocks[row.dataset.id] : null;
}

/* Menus act on `state`, but a line being edited holds its newest text
   only in the DOM until it's committed — so anything that reads or
   rewrites block text has to flush that first, exactly like the "⋯"
   button does. Blurring is what runs the row's own commitEdit; it
   leaves the row element in place, so it's still valid to anchor a
   menu to. The one caller that must NOT do this is the text-selection
   menu, which needs the selection and the caret to stay live. */
function commitEditingBlock(){
  var el = editingBlockEl();
  if(el) el.blur();
}

/* ============================================================
   "/" COMMANDS
   ============================================================ */

/* Where the caret's "/token" starts, or null if the caret isn't
   sitting just after one. Offsets are in the same "raw" space that
   getCaretOffset/setCaretOffset and serializeInline all use (i.e.
   markup characters, where **bold** counts as 8), so the token can be
   sliced straight out of the serialized text with no DOM surgery. */
var SLASH_TOKEN_RE = /(?:^|[\s([{>])\/([a-zA-Z0-9]*)$/;

function readSlashToken(){
  var el = editingBlockEl();
  if(!el) return null;
  var block = blockOfEl(el);
  if(!block) return null;
  var raw = serializeInline(el);
  if(CODE_BLOCK_RE.test(raw)) return null; /* inside a fenced code block a slash is just a slash */
  var off = getCaretOffset(el);
  var m = raw.slice(0, off).match(SLASH_TOKEN_RE);
  if(!m) return null;
  if(m[1].length > 24) return null; /* clearly not a command any more */
  return {
    el: el,
    block: block,
    raw: raw,
    query: m[1],
    start: off - m[1].length - 1,
    end: off
  };
}

var slashMenuEl = null;
var slashActiveIndex = 0;
var slashItems = [];
var slashBlockId = null;
var slashDismissed = false; /* set by Escape; cleared once the token goes away */

function slashMenuOpen(){ return !!slashMenuEl; }

function closeSlashMenu(){
  if(slashMenuEl){ slashMenuEl.remove(); slashMenuEl = null; }
  slashItems = [];
  slashActiveIndex = 0;
  slashBlockId = null;
}

/* ---------- The command catalogue ----------
   `run` receives {block, head, tail} where head/tail are the raw text
   either side of the removed "/token" — so a command that inserts
   something writes head + thing + tail, and one that reshapes the
   whole line works on head + tail. */
function slashCommandList(){
  var cmds = [];

  function add(icon, label, sub, keywords, run){
    cmds.push({icon:icon, label:label, sub:sub, keywords:keywords || '', run:run});
  }

  /* -- Turn the line into something -- */
  [1,2,3].forEach(function(level){
    add('H' + level, 'Heading ' + level, 'Turn into', 'h' + level + ' heading title', function(ctx){
      var body = stripLineMarkers(ctx.head + ctx.tail);
      var next = '#'.repeat(level) + ' ' + body;
      applyBlockText(ctx.block, next, Math.max(0, next.length - ctx.tail.length));
    });
  });
  add('☐', 'To-do', 'Turn into', 'todo task checkbox check', function(ctx){
    var body = stripLineMarkers(ctx.head + ctx.tail);
    var next = '[ ] ' + body;
    applyBlockText(ctx.block, next, Math.max(0, next.length - ctx.tail.length));
  });
  add('¶', 'Plain text', 'Turn into', 'text paragraph normal clear reset', function(ctx){
    var next = stripLineMarkers(ctx.head + ctx.tail);
    applyBlockText(ctx.block, next, Math.max(0, next.length - ctx.tail.length));
  });
  add('{ }', 'Code block', 'Turn into', 'code fence snippet pre', function(ctx){
    var body = stripLineMarkers(ctx.head + ctx.tail);
    var next = '```\n' + body + '\n```';
    applyBlockText(ctx.block, next, 4 + Math.max(0, body.length - ctx.tail.length));
  });

  /* -- Insert at the caret -- */
  add('[[', 'Page link', 'Insert', 'link page reference wiki', function(ctx){
    var next = ctx.head + '[[]]' + ctx.tail;
    applyBlockText(ctx.block, next, ctx.head.length + 2);
  });
  add('#', 'Tag', 'Insert', 'tag hashtag label', function(ctx){
    var next = ctx.head + '#' + ctx.tail;
    applyBlockText(ctx.block, next, ctx.head.length + 1);
  });
  add('📅', "Today's date", 'Insert', 'today date daily now link', function(ctx){
    var stamp = '[[' + dateTitle(new Date()) + ']]';
    var next = ctx.head + stamp + ctx.tail;
    applyBlockText(ctx.block, next, ctx.head.length + stamp.length);
  });
  add('📎', 'Image or file', 'Insert', 'image file attachment photo upload attach', function(ctx){
    applyBlockText(ctx.block, ctx.head + ctx.tail, ctx.head.length);
    setTimeout(function(){ document.getElementById('attach-file-input').click(); }, 0);
  });
  add('⌕', 'Query…', 'Insert', 'query search filter live', function(ctx){
    applyBlockText(ctx.block, ctx.head + ctx.tail, ctx.head.length);
    setTimeout(function(){ openQueryBuilder('query', ctx.block.id, ''); }, 0);
  });
  add('▤', 'Database view…', 'Insert', 'table database view grid query', function(ctx){
    applyBlockText(ctx.block, ctx.head + ctx.tail, ctx.head.length);
    setTimeout(function(){ openQueryBuilder('table', ctx.block.id, ''); }, 0);
  });

  /* -- Templates, one command each so they're searchable by name -- */
  Object.keys(state.templates || {}).sort(function(a,b){
    return state.templates[a].name.localeCompare(state.templates[b].name);
  }).forEach(function(tid){
    var t = state.templates[tid];
    add('❏', t.name, 'Template', 'template ' + t.name.toLowerCase(), function(ctx){
      applyBlockText(ctx.block, ctx.head + ctx.tail, ctx.head.length);
      setTimeout(function(){ insertTemplateIntoPage(tid); }, 0);
    });
  });

  /* -- Act on this line -- */
  add('→', 'Indent', 'Line', 'indent nest tab right', function(ctx){
    applyBlockText(ctx.block, ctx.head + ctx.tail, ctx.head.length);
    setTimeout(function(){
      var b = state.blocks[ctx.block.id];
      if(b) doIndent(b);
    }, 0);
  });
  add('←', 'Outdent', 'Line', 'outdent unnest shift left', function(ctx){
    applyBlockText(ctx.block, ctx.head + ctx.tail, ctx.head.length);
    setTimeout(function(){
      var b = state.blocks[ctx.block.id];
      if(b) doOutdent(b);
    }, 0);
  });
  add('⧉', 'Duplicate line', 'Line', 'duplicate copy clone repeat', function(ctx){
    applyBlockText(ctx.block, ctx.head + ctx.tail, ctx.head.length);
    setTimeout(function(){
      var b = state.blocks[ctx.block.id];
      if(!b) return;
      var copy = insertSubtreeAfter(cloneBlockSubtree(b), b);
      save(); renderPage();
      focusBlock(copy.id, (copy.text || '').length);
    }, 0);
  });
  add('⚭', 'Copy block reference', 'Line', 'reference ref sync copy id', function(ctx){
    applyBlockText(ctx.block, ctx.head + ctx.tail, ctx.head.length);
    copyToClipboard('((' + ctx.block.id + '))');
    toast('Block reference copied — paste it anywhere to sync this line.');
  });
  add('⤢', 'Zoom in on this line', 'Line', 'zoom focus drill into', function(ctx){
    applyBlockText(ctx.block, ctx.head + ctx.tail, ctx.head.length);
    setTimeout(function(){ zoomToBlock(ctx.block.id); }, 0);
  });
  add('🗑', 'Delete line', 'Line', 'delete remove trash line', function(ctx){
    var el = editingBlockEl();
    if(el) el.contentEditable = 'false';
    var b = state.blocks[ctx.block.id];
    if(!b) return;
    var landAfter = removeBlockSubtree(b);
    save(); renderPage();
    if(landAfter) focusBlock(landAfter.focusId, landAfter.offset);
    toast('Block deleted.');
  });

  /* -- Elsewhere in the app -- */
  add('⌘', 'Search everything', 'Go', 'search palette jump find open goto', function(ctx){
    applyBlockText(ctx.block, ctx.head + ctx.tail, ctx.head.length);
    setTimeout(openPalette, 0);
  });
  add('⇄', 'Find & replace', 'Go', 'find replace substitute', function(ctx){
    applyBlockText(ctx.block, ctx.head + ctx.tail, ctx.head.length);
    setTimeout(openFindReplace, 0);
  });

  return cmds;
}

/* Ranks commands against the typed query: a label that starts with it
   beats one that merely contains it, which beats a keyword hit. */
function filterSlashCommands(query){
  var all = slashCommandList();
  var q = (query || '').toLowerCase();
  if(!q) return all;
  return all.map(function(c){
    var label = c.label.toLowerCase();
    var score = 0;
    if(label.indexOf(q) === 0) score = 3;
    else if(label.indexOf(q) !== -1) score = 2;
    else if((c.keywords || '').indexOf(q) !== -1) score = 1;
    return {cmd:c, score:score};
  }).filter(function(x){ return x.score > 0; })
    .sort(function(a,b){ return b.score - a.score; })
    .map(function(x){ return x.cmd; });
}

function renderSlashMenu(token){
  slashItems = filterSlashCommands(token.query);
  if(!slashItems.length){ closeSlashMenu(); return; }

  if(!slashMenuEl){
    slashMenuEl = document.createElement('div');
    slashMenuEl.className = 'slash-menu';
    slashMenuEl.addEventListener('mousedown', function(e){ e.preventDefault(); });
    document.body.appendChild(slashMenuEl);
    slashActiveIndex = 0;
  }
  if(slashActiveIndex >= slashItems.length) slashActiveIndex = 0;
  slashBlockId = token.block.id;

  slashMenuEl.innerHTML = '';
  var lastSub = null;
  slashItems.forEach(function(cmd, i){
    if(cmd.sub && cmd.sub !== lastSub){
      var head = document.createElement('div');
      head.className = 'slash-group';
      head.textContent = cmd.sub;
      slashMenuEl.appendChild(head);
      lastSub = cmd.sub;
    }
    var row = document.createElement('div');
    row.className = 'slash-item' + (i === slashActiveIndex ? ' active' : '');
    var icon = document.createElement('span');
    icon.className = 'si-icon';
    icon.textContent = cmd.icon;
    var label = document.createElement('span');
    label.className = 'si-label';
    label.textContent = cmd.label;
    row.appendChild(icon);
    row.appendChild(label);
    row.addEventListener('mouseenter', function(){ setSlashActive(i); });
    row.addEventListener('click', function(e){
      e.preventDefault();
      e.stopPropagation();
      runSlashCommand(cmd);
    });
    slashMenuEl.appendChild(row);
  });

  positionSlashMenu(token.el);
}

function positionSlashMenu(el){
  if(!slashMenuEl) return;
  var x = 0, y = 0;
  var sel = window.getSelection();
  var rect = null;
  if(sel.rangeCount){
    rect = sel.getRangeAt(0).getBoundingClientRect();
    if(!rect || (!rect.width && !rect.height && !rect.top)) rect = null;
  }
  if(!rect) rect = el.getBoundingClientRect();
  x = rect.left;
  y = rect.bottom + 6;
  /* Prefer opening downward from the caret; positionFloating flips it
     above the line when there isn't room below. */
  positionFloating(slashMenuEl, x, y);
}

function setSlashActive(i){
  if(!slashMenuEl) return;
  var rows = slashMenuEl.querySelectorAll('.slash-item');
  if(!rows.length) return;
  slashActiveIndex = (i + rows.length) % rows.length;
  Array.prototype.forEach.call(rows, function(r, idx){
    r.classList.toggle('active', idx === slashActiveIndex);
  });
  var active = rows[slashActiveIndex];
  if(active && active.scrollIntoView) active.scrollIntoView({block:'nearest'});
}

function runSlashCommand(cmd){
  /* Re-read the token rather than trusting the one captured at render
     time — the caret may have moved between opening the menu and
     picking an item. */
  var token = readSlashToken();
  closeSlashMenu();
  if(!token) return;
  var ctx = {
    block: token.block,
    head: token.raw.slice(0, token.start),
    tail: token.raw.slice(token.end)
  };
  cmd.run(ctx);
}

function refreshSlashMenu(){
  var token = readSlashToken();
  if(!token){
    slashDismissed = false; /* the token is gone, so Escape's dismissal expires with it */
    closeSlashMenu();
    return;
  }
  if(slashDismissed) return;
  if(slashBlockId && slashBlockId !== token.block.id) closeSlashMenu();
  renderSlashMenu(token);
}

/* Bubble phase, so this runs after the block's own input handler
   (autoFormatAtCaret) has already settled the DOM. */
document.addEventListener('input', function(e){
  if(appLocked) return;
  if(!e.target || !e.target.classList || !e.target.classList.contains('block-content')) return;
  refreshSlashMenu();
});

/* Capture phase, so the menu gets first refusal on Enter / arrows /
   Escape before the block's own keydown handler treats them as
   "split this line" or "move to the next line". */
document.addEventListener('keydown', function(e){
  if(!slashMenuOpen()) return;
  if(e.key === 'ArrowDown'){
    e.preventDefault(); e.stopPropagation();
    setSlashActive(slashActiveIndex + 1);
  } else if(e.key === 'ArrowUp'){
    e.preventDefault(); e.stopPropagation();
    setSlashActive(slashActiveIndex - 1);
  } else if(e.key === 'Enter' || e.key === 'Tab'){
    e.preventDefault(); e.stopPropagation();
    var cmd = slashItems[slashActiveIndex];
    if(cmd) runSlashCommand(cmd);
    else closeSlashMenu();
  } else if(e.key === 'Escape'){
    e.preventDefault(); e.stopPropagation();
    slashDismissed = true;
    closeSlashMenu();
  } else if(e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End'){
    closeSlashMenu(); /* the caret is leaving the token — let the key through untouched */
  }
}, true);

document.addEventListener('blur', function(e){
  if(e.target && e.target.classList && e.target.classList.contains('block-content')) closeSlashMenu();
}, true);
window.addEventListener('resize', closeSlashMenu);
document.addEventListener('scroll', function(e){
  if(!slashMenuOpen()) return;
  if(slashMenuEl.contains(e.target)) return; /* scrolling the menu's own list */
  closeSlashMenu();
}, true);

/* ============================================================
   RIGHT-CLICK MENUS
   ============================================================ */

/* ---------- Selected text inside a line ---------- */
function selectionMenuItems(el, selectedText){
  var items = [];
  function fmt(icon, label, tag){
    items.push({icon:icon, label:label, onClick:function(){ applyInlineFormat(el, tag); }});
  }
  fmt('B', 'Bold', 'strong');
  fmt('I', 'Italic', 'em');
  fmt('S', 'Strikethrough', 'del');
  fmt('‹›', 'Code', 'code');
  items.push({icon:'🔗', label:'Link…', onClick:function(){ applyLinkFormat(el); }});
  items.push({divider:true});
  items.push({icon:'[[', label:'Link to a page with this name', onClick:function(){
    replaceSelectionWithRawText(el, '[[' + selectedText + ']]');
  }});
  items.push({icon:'#', label:'Turn into a tag', onClick:function(){
    replaceSelectionWithRawText(el, '#' + selectedText.trim().replace(/\s+/g, '-'));
  }});
  items.push({divider:true});
  items.push({icon:'C', label:'Copy', onClick:function(){
    copyToClipboard(selectedText);
    toast('Copied.');
  }});
  items.push({icon:'⌕', label:'Search everywhere for this', onClick:function(){
    setSidebarCollapsed(false);
    var box = document.getElementById('search-box');
    box.value = selectedText;
    renderSidebar(selectedText);
    box.focus();
  }});
  return items;
}

/* Swaps the current selection for literal text and writes the result
   back to the block. Goes through the DOM (rather than raw offsets)
   because a selection has two ends and getCaretOffset only reports
   one — serializeInline afterwards gives us the authoritative text. */
function replaceSelectionWithRawText(el, newText){
  var sel = window.getSelection();
  if(!sel.rangeCount) return;
  var range = sel.getRangeAt(0);
  if(!el.contains(range.commonAncestorContainer)) return;
  range.deleteContents();
  var node = document.createTextNode(newText);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  var block = blockOfEl(el);
  if(block){ block.text = serializeInline(el); save(); }
}

/* ---------- A page (sidebar row, or the page title) ---------- */
function renamePagePrompt(pageId){
  var page = state.pages[pageId];
  if(!page) return;
  var next = prompt('Rename page:', page.title);
  if(next === null) return;
  next = next.trim();
  if(!next || next === page.title) return;
  var clash = state.titleIndex[next.toLowerCase()];
  if(clash && clash !== pageId){
    toast('There\'s already a page called "' + next + '".');
    return;
  }
  delete state.titleIndex[page.title.toLowerCase()];
  renameCascade(page.title, next);  /* rewrites every [[link]] pointing here */
  page.title = next;
  state.titleIndex[next.toLowerCase()] = pageId;
  save();
  renderAll();
  toast('Renamed to "' + next + '".');
}

function duplicatePage(pageId){
  var page = state.pages[pageId];
  if(!page) return;
  var base = page.title + ' (copy)';
  var title = base, n = 2;
  while(state.titleIndex[title.toLowerCase()]){ title = base + ' ' + n; n++; }
  var copy = resolvePage(title, page.type === 'tag' ? 'page' : page.type);
  copy.properties = JSON.parse(JSON.stringify(page.properties || []));
  copy.rootBlocks = instantiateTemplateNodes(pageToTemplateNodes(page), copy.id, null);
  save();
  openPage(copy.id);
  renderAll();
  toast('Duplicated as "' + title + '".');
}

function savePageAsTemplate(pageId){
  var page = state.pages[pageId];
  if(!page) return;
  var name = prompt('Template name:', page.title);
  if(name === null) return;
  name = name.trim();
  if(!name){ toast('A template needs a name.'); return; }
  var id = uid();
  state.templates[id] = {id:id, name:name, blocks:pageToTemplateNodes(page), updatedAt:Date.now()};
  save();
  renderSidebar(document.getElementById('search-box').value);
  toast('Saved template: ' + name);
}

function pageMenuItems(pageId){
  var page = state.pages[pageId];
  if(!page) return [];
  var items = [];
  var isCurrent = pageId === state.currentPageId;
  var isTrashed = !!page.trashedAt;

  items.push({header: page.type === 'tag' ? '#' + page.title : page.title});
  items.push({icon:'↗', label:'Open', disabled:isCurrent, onClick:function(){ openPage(pageId); }});

  if(isTrashed){
    items.push({divider:true});
    items.push({icon:'↺', label:'Restore from Trash', onClick:function(){ restorePage(pageId); }});
    items.push({icon:'✕', label:'Delete forever', danger:true, onClick:function(){ permanentlyDeletePage(pageId); }});
    return items;
  }

  items.push({icon: page.pinned ? '★' : '☆', label: page.pinned ? 'Unpin' : 'Pin to top',
    onClick:function(){ togglePinPage(pageId); }});
  items.push({icon:'[[', label:'Copy link to this page', onClick:function(){
    copyToClipboard('[[' + page.title + ']]');
    toast('Copied [[' + page.title + ']] — paste it in any line.');
  }});
  items.push({divider:true});
  items.push({icon:'✎', label:'Rename…', onClick:function(){ renamePagePrompt(pageId); }});
  items.push({icon:'⧉', label:'Duplicate', onClick:function(){ duplicatePage(pageId); }});
  items.push({icon:'❏', label:'Save as template…', onClick:function(){ savePageAsTemplate(pageId); }});
  items.push({divider:true});
  items.push({icon:'↓', label:'Export as Markdown', onClick:function(){
    if(!isCurrent) openPage(pageId);
    exportPageAsMarkdown();
  }});
  items.push({icon:'↓', label:'Export as PDF', onClick:function(){
    if(!isCurrent) openPage(pageId);
    exportPageAsPdf();
  }});
  items.push({divider:true});
  items.push({icon:'🗑', label:'Move to Trash', danger:true, onClick:function(){
    if(typeof currentSettings !== 'undefined' && currentSettings.confirmTrash === 'on'){
      if(!confirm('Move "' + page.title + '" to Trash?')) return;
    }
    trashPage(pageId);
    if(pageId === state.currentPageId) goToNextLivePageAfterRemoval();
    save();
    renderAll();
    toast('"' + page.title + '" moved to Trash.');
  }});
  return items;
}

/* ---------- A template row in the sidebar ---------- */
function templateMenuItems(templateId){
  var t = state.templates[templateId];
  if(!t) return [];
  return [
    {header: t.name},
    {icon:'↓', label:'Insert into this page', onClick:function(){ insertTemplateIntoPage(templateId); }},
    {icon:'＋', label:'New page from this template…', onClick:function(){ newPageFromTemplate(templateId); }},
    {divider:true},
    {icon:'✎', label:'Rename…', onClick:function(){
      var name = prompt('Template name:', t.name);
      if(name === null) return;
      name = name.trim();
      if(!name){ toast('A template needs a name.'); return; }
      t.name = name;
      t.updatedAt = Date.now();
      save();
      renderSidebar(document.getElementById('search-box').value);
    }},
    {icon:'✕', label:'Delete template', danger:true, onClick:function(){ deleteTemplate(templateId); }}
  ];
}

/* ---------- Empty outline space ---------- */
function outlineMenuItems(){
  var page = state.pages[state.currentPageId];
  var items = [];
  if(!page) return items;
  items.push({icon:'＋', label:'New line at the end', onClick:function(){
    var parentId = (zoomedBlockId && state.blocks[zoomedBlockId] && state.blocks[zoomedBlockId].pageId === page.id)
      ? zoomedBlockId : null;
    var id = uid();
    state.blocks[id] = mkBlock(id, page.id, parentId, '');
    if(parentId) state.blocks[parentId].children.push(id);
    else page.rootBlocks.push(id);
    save();
    focusBlock(id, 0);
  }});
  items.push({icon:'P', label:'Paste block', disabled:!blockClipboard, onClick:function(){
    var ids = (zoomedBlockId && state.blocks[zoomedBlockId]) ? state.blocks[zoomedBlockId].children : page.rootBlocks;
    var lastId = ids[ids.length - 1];
    var lastBlock = lastId ? state.blocks[lastId] : null;
    if(!lastBlock){ toast('Add a line first, then paste onto it.'); return; }
    var pasted = insertSubtreeAfter(blockClipboard, lastBlock);
    save(); renderPage();
    focusBlock(pasted.id, (pasted.text || '').length);
  }});
  if(zoomedBlockId){
    items.push({icon:'↰', label:'Zoom out to the whole page', onClick:zoomOut});
  }
  items.push({divider:true});
  items.push({icon:'▤', label: page.viewMode === 'doc' ? 'Switch to outline mode' : 'Switch to doc mode',
    onClick:function(){ document.getElementById('btn-doc-mode').click(); }});
  var tmplIds = Object.keys(state.templates || {});
  if(tmplIds.length){
    items.push({divider:true});
    items.push({header:'Insert a template'});
    tmplIds.sort(function(a,b){ return state.templates[a].name.localeCompare(state.templates[b].name); })
      .slice(0, 8).forEach(function(tid){
        items.push({icon:'❏', label:state.templates[tid].name, onClick:function(){ insertTemplateIntoPage(tid); }});
      });
  }
  items.push({divider:true});
  items.push(pageMenuItemsShortcut());
  return items;
}

function pageMenuItemsShortcut(){
  return {icon:'⋯', label:'This page…', onClick:function(){
    var items = pageMenuItems(state.currentPageId);
    openCtxMenu(items, lastContextPoint.x, lastContextPoint.y);
  }};
}

/* ---------- The router ---------- */
var lastContextPoint = {x:0, y:0};

document.addEventListener('contextmenu', function(e){
  if(appLocked) return;
  if(e.shiftKey) return; /* Shift+right-click always falls through to the browser's own menu */
  if(!state) return;

  /* Anywhere a real text input lives (search box, settings fields,
     the query builder), the native menu is the useful one — it has
     cut/paste/spelling that we can't reproduce. */
  var tag = e.target.tagName;
  if(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if(e.target.closest && e.target.closest('[id$="-overlay"], #settings-modal')) return;

  lastContextPoint = {x:e.clientX, y:e.clientY};

  /* 1. A selection inside the line being edited → formatting actions. */
  var editing = e.target.closest ? e.target.closest('.block-content.editing') : null;
  if(editing){
    var sel = window.getSelection();
    var selectedText = sel && !sel.isCollapsed ? sel.toString() : '';
    if(selectedText && editing.contains(sel.anchorNode)){
      e.preventDefault();
      closeSlashMenu();
      openCtxMenu(selectionMenuItems(editing, selectedText), e.clientX, e.clientY);
      return;
    }
  }

  /* 2. A block row → the same menu the "⋯" button opens, at the pointer. */
  var row = e.target.closest ? e.target.closest('.block-row') : null;
  if(row && row.dataset.id && state.blocks[row.dataset.id]){
    e.preventDefault();
    closeSlashMenu();
    closeCtxMenu();
    commitEditingBlock();
    openBlockMenu(row, row.dataset.id, {x:e.clientX, y:e.clientY});
    return;
  }

  /* 3. A sidebar template row. */
  var tmplRow = e.target.closest ? e.target.closest('[data-template-id]') : null;
  if(tmplRow){
    e.preventDefault();
    commitEditingBlock();
    openCtxMenu(templateMenuItems(tmplRow.dataset.templateId), e.clientX, e.clientY);
    return;
  }

  /* 4. A sidebar page/tag/trash row. */
  var pageRow = e.target.closest ? e.target.closest('[data-page-id]') : null;
  if(pageRow && state.pages[pageRow.dataset.pageId]){
    e.preventDefault();
    commitEditingBlock();
    openCtxMenu(pageMenuItems(pageRow.dataset.pageId), e.clientX, e.clientY);
    return;
  }

  /* 5. The page title / header area → this page's actions. */
  var header = e.target.closest ? e.target.closest('#page-title, #page-sub, #page-type-pill, #properties') : null;
  if(header && state.pages[state.currentPageId]){
    /* The title is contenteditable, so only take over when nothing is
       selected in it — otherwise the native copy/paste menu wins. */
    var tSel = window.getSelection();
    if(header.id === 'page-title' && tSel && !tSel.isCollapsed && header.contains(tSel.anchorNode)) return;
    e.preventDefault();
    commitEditingBlock();
    openCtxMenu(pageMenuItems(state.currentPageId), e.clientX, e.clientY);
    return;
  }

  /* 6. Empty outline space. */
  var outline = e.target.closest ? e.target.closest('#outline') : null;
  if(outline && state.pages[state.currentPageId]){
    e.preventDefault();
    commitEditingBlock();
    openCtxMenu(outlineMenuItems(), e.clientX, e.clientY);
    return;
  }
}, false);
