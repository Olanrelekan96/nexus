/* ============================================================
 * 03-sidebar-search-templates.js
 * Fuzzy search, sidebar rendering, page templates, and the attachments browser.
 *
 * Part of Nexus — loaded as a plain <script> (not a module) in
 * index.html, in numeric filename order. All files share one global
 * scope on purpose (same as the original single-file build), so
 * `state`, helper functions, etc. declared in an earlier file are
 * directly usable here without imports.
 * ============================================================ */
"use strict";

/* ============================================================
   FUZZY SEARCH
   Typo- and word-order-tolerant matching used by the sidebar
   search box, the command palette, and line/content search.
   An exact substring match still wins (highest score tier, and
   ranked by how early/tight it hits) so existing precise
   searches behave exactly as before; anything else falls back
   to per-word matching (each query word just needs to loosely
   match *some* word in the target, in any order) with a small
   edit-distance allowance for typos.
   ============================================================ */
function levenshteinDistance(a, b){
  var m = a.length, n = b.length;
  if(!m) return n;
  if(!n) return m;
  var prev = new Array(n+1), curr = new Array(n+1);
  for(var j=0;j<=n;j++) prev[j] = j;
  for(var i=1;i<=m;i++){
    curr[0] = i;
    for(var j2=1;j2<=n;j2++){
      var cost = a.charAt(i-1) === b.charAt(j2-1) ? 0 : 1;
      curr[j2] = Math.min(curr[j2-1]+1, prev[j2]+1, prev[j2-1]+cost);
    }
    var tmp = prev; prev = curr; curr = tmp;
  }
  return prev[n];
}
/* Best-effort match quality between one query word and one target
   word: exact/prefix/substring hits score highest and cheapest;
   otherwise fall back to edit distance so a typo like "meetign"
   still lands on "meeting". Returns 0 when nothing reasonable matches. */
function fuzzyWordScore(qWord, tWord){
  if(!qWord || !tWord) return 0;
  if(tWord === qWord) return 100;
  if(tWord.indexOf(qWord) === 0) return 85;
  if(tWord.indexOf(qWord) !== -1) return 65;
  if(qWord.length >= 3 && Math.abs(qWord.length - tWord.length) <= 3){
    var dist = levenshteinDistance(qWord, tWord);
    var maxLen = Math.max(qWord.length, tWord.length);
    var similarity = 1 - dist/maxLen;
    var threshold = qWord.length <= 4 ? 0.66 : 0.55;
    if(similarity >= threshold) return Math.round(similarity*55);
  }
  return 0;
}
/* Returns 0 for no match, otherwise a relevance score (higher = better).
   Exact substring hits (current phrase, in order) always outrank fuzzy
   ones, so a precise search still sorts to the very top. */
function fuzzyMatchScore(query, text){
  query = (query||"").trim().toLowerCase();
  if(!query) return 1;
  text = (text||"").toLowerCase();
  var idx = text.indexOf(query);
  if(idx !== -1) return 1000 - idx*0.1 - (text.length-query.length)*0.01;
  var qWords = query.split(/\s+/).filter(Boolean);
  var tWords = text.split(/[^a-z0-9]+/i).filter(Boolean);
  if(!qWords.length || !tWords.length) return 0;
  var total = 0;
  for(var i=0;i<qWords.length;i++){
    var best = 0;
    for(var j=0;j<tWords.length;j++){
      var s = fuzzyWordScore(qWords[i], tWords[j]);
      if(s > best) best = s;
    }
    if(best === 0) return 0; /* every query word must find some loose match */
    total += best;
  }
  return total/qWords.length;
}
/* Filters + ranks a list by relevance to `filter` (using keyFn to pull
   the searchable text off each item). Leaves order untouched when
   there's no active search, so default sorts (recency, alpha, etc.)
   are unaffected. */
function filterAndRank(list, filter, keyFn){
  if(!filter) return list;
  return rankPages(list, filter, keyFn).map(function(x){ return x.item; });
}

/* ============================================================
   RENDER: SIDEBAR
   ============================================================ */
function renderSidebar(filter){
  filter = (filter||"").toLowerCase();
  var pages = livePages();

  /* A manual sortOrder/pinnedOrder (set by dragging in the sidebar)
     takes priority over the default sort; pages that have never been
     dragged fall back to their default (alphabetical / recency) and
     sort after any manually-ordered ones. */
  function byManualOrder(field, fallbackCmp){
    return function(a,b){
      var ao = a[field], bo = b[field];
      if(ao!=null || bo!=null){
        return (ao!=null?ao:Infinity) - (bo!=null?bo:Infinity) || fallbackCmp(a,b);
      }
      return fallbackCmp(a,b);
    };
  }
  function alphaCmp(a,b){ return a.title.localeCompare(b.title); }

  /* Pages the user has taken out of the sidebar stay in `state` and
     stay searchable — they're just kept out of the four lists below
     and shown under "Hidden" instead (see renderHiddenSection). */
  pages = pages.filter(function(p){ return !p.hidden; });

  var daily = pages.filter(function(p){ return p.type==='daily'; }).sort(function(a,b){ return b.createdAt-a.createdAt; });
  var normal = pages.filter(function(p){ return p.type==='page'; }).sort(byManualOrder('sortOrder', alphaCmp));
  var tags = pages.filter(function(p){ return p.type==='tag'; }).sort(alphaCmp);

  function titleOf(p){ return p.title; }

  var dailyToShow = state.dailyShowAll ? daily : daily.slice(0,5);
  document.getElementById('toggle-daily').textContent = state.dailyShowAll ? 'recent' : 'all';

  var dailyListEl = document.getElementById('list-daily');
  var dailyCalEl = document.getElementById('daily-calendar');
  var toggleDailyBtn = document.getElementById('toggle-daily');
  if(dailyViewMode === 'calendar'){
    dailyListEl.style.display = 'none';
    dailyCalEl.style.display = '';
    toggleDailyBtn.style.display = 'none'; /* recent/all only makes sense for the list */
    renderDailyCalendarWidget(daily);
  } else {
    dailyListEl.style.display = '';
    dailyCalEl.style.display = 'none';
    toggleDailyBtn.style.display = '';
  }
  document.getElementById('toggle-daily-view').textContent = dailyViewMode === 'calendar' ? 'list' : 'calendar';

  var pinned = pages.filter(function(p){ return p.pinned; })
    .sort(byManualOrder('pinnedOrder', alphaCmp));
  var pinnedSection = document.getElementById('pinned-section');
  var pinnedToShow = filterAndRank(pinned, filter, titleOf);
  pinnedSection.style.display = pinnedToShow.length ? '' : 'none';
  fillList('list-pinned', pinnedToShow, false, filter ? null : 'pinnedOrder');

  fillList('list-daily', filterAndRank(dailyToShow, filter, titleOf));
  fillList('list-pages', filterAndRank(normal, filter, titleOf), false, filter ? null : 'sortOrder');
  fillList('list-tags', filterAndRank(tags, filter, titleOf), true);

  renderHiddenSection();
  renderTrashSection();
  renderBlockMatches(filter);
  renderTemplatesSection();
}

function renderTrashSection(){
  var trashed = trashedPages();
  var section = document.getElementById('trash-section');
  var ul = document.getElementById('list-trash');
  ul.innerHTML = "";
  if(!trashed.length){ section.style.display = 'none'; return; }
  section.style.display = '';
  trashed.forEach(function(p){
    var li = document.createElement('li');
    var row = document.createElement('div');
    row.className = 'trash-row';
    row.dataset.pageId = p.id; /* lets the right-click handler identify which page this row is */
    var a = document.createElement('a');
    a.href = "javascript:void(0)";
    a.textContent = p.type === 'tag' ? '#'+p.title : p.title;
    a.title = 'Deleted ' + new Date(p.trashedAt).toLocaleDateString();
    if(p.id === state.currentPageId) a.className = 'active';
    a.onclick = function(){ openPage(p.id); };
    var restoreBtn = document.createElement('button');
    restoreBtn.type = 'button'; restoreBtn.title = 'Restore'; restoreBtn.textContent = '↺';
    restoreBtn.setAttribute('aria-label', 'Restore "' + p.title + '"');
    restoreBtn.onclick = function(e){ e.stopPropagation(); restorePage(p.id); };
    var delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.title = 'Delete forever'; delBtn.textContent = '✕';
    delBtn.setAttribute('aria-label', 'Delete "' + p.title + '" forever');
    delBtn.onclick = function(e){ e.stopPropagation(); permanentlyDeletePage(p.id); };
    row.appendChild(a); row.appendChild(restoreBtn); row.appendChild(delBtn);
    li.appendChild(row);
    ul.appendChild(li);
  });
}

/* ============================================================
   TEMPLATES
   A template is a standalone tree of {text, children} nodes — not
   real blocks, so it isn't tied to any page and can be inserted
   (fresh ids each time) into any page, any number of times.
   ============================================================ */
function renderTemplatesSection(){
  var ul = document.getElementById('list-templates');
  if(!ul) return;
  ul.innerHTML = "";
  var list = Object.keys(state.templates).map(function(id){ return state.templates[id]; })
    .sort(function(a,b){ return a.name.localeCompare(b.name); });
  list.forEach(function(t){
    var li = document.createElement('li');
    var row = document.createElement('div');
    row.className = 'trash-row';
    row.dataset.templateId = t.id; /* lets the right-click handler identify which template this row is */
    var a = document.createElement('a');
    a.href = "javascript:void(0)";
    a.textContent = t.name;
    a.title = 'Insert "' + t.name + '" into the current page';
    a.onclick = function(){ insertTemplateIntoPage(t.id); };
    var newPageBtn = document.createElement('button');
    newPageBtn.type = 'button'; newPageBtn.title = 'New page from this template'; newPageBtn.textContent = '⧉';
    newPageBtn.setAttribute('aria-label', 'New page from "' + t.name + '" template');
    newPageBtn.onclick = function(e){ e.stopPropagation(); newPageFromTemplate(t.id); };
    var delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.title = 'Delete template'; delBtn.textContent = '✕';
    delBtn.setAttribute('aria-label', 'Delete "' + t.name + '" template');
    delBtn.onclick = function(e){ e.stopPropagation(); deleteTemplate(t.id); };
    row.appendChild(a); row.appendChild(newPageBtn); row.appendChild(delBtn);
    li.appendChild(row);
    ul.appendChild(li);
  });
}

/* Walks a live block subtree into plain {text, children} template
   nodes — no ids, no page/parent references, so the result has no
   ties back to the source page and is safe to stash indefinitely. */
function blockToTemplateNode(id){
  var b = state.blocks[id];
  if(!b) return null;
  return {text: b.text||"", children: (b.children||[]).map(blockToTemplateNode).filter(Boolean)};
}
function pageToTemplateNodes(page){
  return (page.rootBlocks||[]).map(blockToTemplateNode).filter(Boolean);
}

/* The reverse: stamps a template's node tree into real blocks with
   fresh ids under the given page/parent, returning the new root ids
   so the caller can attach them wherever they belong. */
function instantiateTemplateNodes(nodes, pageId, parentId){
  return (nodes||[]).map(function(n){
    var id = uid();
    var nb = mkBlock(id, pageId, parentId, n.text);
    nb.children = instantiateTemplateNodes(n.children, pageId, id);
    state.blocks[id] = nb;
    return id;
  });
}

function saveCurrentPageAsTemplate(){
  var page = state.pages[state.currentPageId];
  if(!page){ toast('Open a page first.'); return; }
  if(!page.rootBlocks || !page.rootBlocks.length){ toast('This page is empty — nothing to save as a template.'); return; }
  var name = prompt('Save as template named:', page.title);
  if(name === null) return;
  name = name.trim();
  if(!name){ toast('Template needs a name.'); return; }
  var id = uid();
  state.templates[id] = {id:id, name:name, createdAt:Date.now(), blocks: pageToTemplateNodes(page)};
  save(); renderTemplatesSection();
  toast('Saved template: ' + name);
}

/* Inserts at the root of the current page, or — while zoomed into a
   block — as children of that block, matching how "+ Click to add a
   line" already behaves so template insertion lands where expected. */
function insertTemplateIntoPage(templateId){
  var tmpl = state.templates[templateId];
  var page = state.pages[state.currentPageId];
  if(!tmpl || !page) return;
  var zoomedHere = zoomedBlockId && state.blocks[zoomedBlockId] && state.blocks[zoomedBlockId].pageId === page.id;
  var parentId = zoomedHere ? zoomedBlockId : null;
  var newIds = instantiateTemplateNodes(tmpl.blocks, page.id, parentId);
  if(parentId){
    state.blocks[parentId].children = state.blocks[parentId].children.concat(newIds);
  } else {
    page.rootBlocks = page.rootBlocks.concat(newIds);
  }
  save(); renderPage();
  if(newIds.length) focusBlock(newIds[0], 0);
  toast('Inserted template: ' + tmpl.name);
}

function newPageFromTemplate(templateId){
  var tmpl = state.templates[templateId];
  if(!tmpl) return;
  var name = prompt('New page title:', tmpl.name);
  if(name === null) return;
  name = name.trim();
  if(!name){ toast('Page needs a title.'); return; }
  var page = resolvePage(name, 'page');
  var newIds = instantiateTemplateNodes(tmpl.blocks, page.id, null);
  page.rootBlocks = page.rootBlocks.concat(newIds);
  save();
  openPage(page.id);
  toast('Created "' + name + '" from template.');
}

function deleteTemplate(id){
  var tmpl = state.templates[id];
  if(!tmpl) return;
  if(!confirm('Delete template "' + tmpl.name + '"? This cannot be undone.')) return;
  delete state.templates[id];
  save(); renderTemplatesSection();
  toast('Deleted template: ' + tmpl.name);
}

/* ============================================================
   ATTACHMENTS BROWSER
   Cross-references the {{img:ID|name}} / {{file:ID|name}} references
   scattered across every block's text with the actual blobs sitting
   in IndexedDB, so there's one place to see every attachment in the
   notebook, jump to where it's used, and spot ones that got orphaned
   (still taking up storage, but no longer referenced from any page).
   ============================================================ */
/* Strips every {{img:ID...}} / {{file:ID...}} reference to a given
   attachment id out of block text across the whole notebook (all pages,
   including trashed ones — an orphaned reference is still an orphaned
   reference there). Used to clean up references to attachments that
   aren't stored on this device (see renderAttachmentsSection) — there's
   no blob to delete, so this just removes the dangling link itself. */
function removeAttachmentReferences(id){
  var re = new RegExp('\\{\\{(?:img|file):' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\|[^}]*)?\\}\\}', 'g');
  var touched = [];
  Object.keys(state.blocks).forEach(function(bid){
    var b = state.blocks[bid];
    if(b.text && re.test(b.text)){
      re.lastIndex = 0;
      b.text = b.text.replace(re, '');
      touched.push(bid);
    }
  });
  return touched;
}
function collectAttachmentRefs(){
  var map = {};
  Object.keys(state.blocks).forEach(function(id){
    var b = state.blocks[id];
    var page = state.pages[b.pageId];
    if(!page || page.trashedAt) return;
    var re = /\{\{(img|file):([^}]+)\}\}/g, m;
    while((m = re.exec(b.text||''))){
      var parsed = parseAttRef(m[2]);
      if(!map[parsed.id]) map[parsed.id] = [];
      map[parsed.id].push({blockId: b.id, pageId: b.pageId, kind: m[1], name: parsed.name});
    }
  });
  return map;
}

function renderAttachmentsSection(){
  var section = document.getElementById('attachments-section');
  var ul = document.getElementById('list-attachments');
  if(!section || !ul) return;
  var refMap = collectAttachmentRefs();
  listAllAttachments().then(function(records){
    var byId = {};
    records.forEach(function(r){ byId[r.id] = r; });
    var seen = {};
    var allIds = Object.keys(refMap).concat(Object.keys(byId)).filter(function(id){
      if(seen[id]) return false;
      seen[id] = true;
      return true;
    });

    ul.innerHTML = "";
    if(!allIds.length){ section.style.display = 'none'; return; }
    section.style.display = '';

    allIds.sort(function(a,b){
      var an = (refMap[a] && refMap[a][0].name) || (byId[a] && byId[a].name) || '';
      var bn = (refMap[b] && refMap[b][0].name) || (byId[b] && byId[b].name) || '';
      return an.localeCompare(bn);
    });

    allIds.forEach(function(id){
      var refs = refMap[id] || [];
      var rec = byId[id];
      var name = (refs[0] && refs[0].name) || (rec && rec.name) || '(unnamed)';
      var kind = (refs[0] && refs[0].kind) || (rec && rec.type && rec.type.indexOf('image/')===0 ? 'img' : 'file');

      var li = document.createElement('li');
      var row = document.createElement('div');
      row.className = 'trash-row';

      var a = document.createElement('a');
      a.href = "javascript:void(0)";
      a.textContent = (kind === 'img' ? '🖼 ' : '📎 ') + name;
      if(refs.length){
        var page = state.pages[refs[0].pageId];
        a.title = 'Jump to "' + (page ? page.title : 'that page') + '"' + (refs.length > 1 ? ' (used in ' + refs.length + ' places)' : '');
        a.onclick = function(){ revealBlock(refs[0].blockId); };
      } else {
        a.style.opacity = '.6';
        a.title = 'Not used on any page';
        a.onclick = function(){ toast('This attachment is not used on any page.'); };
      }
      row.appendChild(a);

      if(!rec){
        var missing = document.createElement('span');
        missing.style.cssText = 'color:var(--ink-soft); font-size:0.6875rem; margin-right:4px; white-space:nowrap;';
        missing.textContent = 'not on this device';
        row.appendChild(missing);

        var removeRefBtn = document.createElement('button');
        removeRefBtn.type = 'button';
        removeRefBtn.title = 'Remove this broken reference from your notes';
        removeRefBtn.textContent = '✕';
        removeRefBtn.setAttribute('aria-label', 'Remove reference to missing attachment "' + name + '"');
        removeRefBtn.onclick = function(e){
          e.stopPropagation();
          var placeCount = refs.length;
          if(!confirm('Remove the link to "' + name + '" from ' + placeCount + ' place' + (placeCount===1?'':'s') + '? The file isn\'t stored on this device, so this just clears the broken reference — nothing else changes.')) return;
          removeAttachmentReferences(id);
          save();
          renderAll();
          renderAttachmentsSection();
          toast('Removed reference: ' + name);
        };
        row.appendChild(removeRefBtn);
      }

      if(!refs.length && rec){
        var delBtn = document.createElement('button');
        delBtn.type = 'button'; delBtn.title = 'Delete this unused attachment'; delBtn.textContent = '✕';
        delBtn.setAttribute('aria-label', 'Delete unused attachment "' + name + '"');
        delBtn.onclick = function(e){
          e.stopPropagation();
          if(!confirm('Delete "' + name + '"? It is not used on any page, and this cannot be undone.')) return;
          deleteAttachmentRecord(id).then(function(){
            renderAttachmentsSection();
            updateStorageHint();
            toast('Deleted: ' + name);
          });
        };
        row.appendChild(delBtn);
      }

      li.appendChild(row);
      ul.appendChild(li);
    });
  }).catch(function(){ /* IndexedDB unavailable in this browser — leave the section hidden */ });
}

function deleteAttachmentRecord(id){
  return openAttachmentDb().then(function(db){
    return new Promise(function(resolve, reject){
      var tx = db.transaction(ATT_STORE, 'readwrite');
      tx.objectStore(ATT_STORE).delete(id);
      tx.oncomplete = function(){ resolve(); };
      tx.onerror = function(){ reject(tx.error); };
    });
  });
}

/* Full-text search over line content (not just page titles). */
/* Same operator syntax as everywhere else (#tag, [[Page]], key:value,
   is:/has:/due:/before:/after:/priority:, /regex/, "OR" — see
   17-advanced-search.js). A plain word or phrase with no operators
   still just fuzzy-matches the line's text exactly as before. */
function findMatchingBlocks(q, limit){
  q = (q||"").trim();
  if(!q) return [];
  var parsed = parseAdvancedQuery(q);
  var out = [];
  Object.keys(state.blocks).forEach(function(id){
    var b = state.blocks[id];
    if(!b.text) return;
    var page = state.pages[b.pageId];
    if(!page || page.trashedAt) return;
    var res = matchAdvancedQuery(parsed, searchRecordForBlock(b, page));
    if(!res.match) return;
    out.push({block:b, page:page, score:res.score});
  });
  out.sort(function(a,b){ return b.score - a.score || a.page.title.localeCompare(b.page.title); });
  return limit ? out.slice(0, limit) : out;
}

function buildSnippetHtml(text, q){
  var lower = text.toLowerCase();
  var idx = lower.indexOf(q.toLowerCase());
  if(idx === -1){
    return escapeHtml(text.length > 80 ? text.slice(0,80)+'…' : text);
  }
  var start = Math.max(0, idx-24);
  var end = Math.min(text.length, idx+q.length+40);
  var pre = (start>0?'…':'') + text.slice(start, idx);
  var mid = text.slice(idx, idx+q.length);
  var post = text.slice(idx+q.length, end) + (end<text.length?'…':'');
  return escapeHtml(pre) + '<mark>' + escapeHtml(mid) + '</mark>' + escapeHtml(post);
}

function renderBlockMatches(filter){
  var section = document.getElementById('search-matches-section');
  var ul = document.getElementById('list-block-matches');
  ul.innerHTML = "";
  if(!filter){
    section.style.display = 'none';
    return;
  }
  section.style.display = '';
  var hits = findMatchingBlocks(filter, 30);
  if(!hits.length){
    var empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = 'No matching lines.';
    ul.appendChild(empty);
    return;
  }
  hits.forEach(function(hit){
    var li = document.createElement('li');
    var a = document.createElement('a');
    a.href = "javascript:void(0)";
    a.className = 'block-match-link';
    var pageLabel = hit.page.type === 'tag' ? '#'+hit.page.title : hit.page.title;
    a.innerHTML = '<div class="bm-snippet">'+buildSnippetHtml(hit.block.text, filter)+'</div>'+
                  '<div class="bm-page">in '+escapeHtml(pageLabel)+'</div>';
    a.onclick = function(){ revealBlock(hit.block.id); };
    li.appendChild(a);
    ul.appendChild(li);
  });
}

/* Navigate to a line's page, expand any collapsed ancestors so it's
   actually visible, then scroll to it and briefly flash-highlight it
   (without forcing edit mode — this is for jumping to read/skim). */
/* Small floating date-picker used by the todo due-date chip / "add due
   date" button — anchored to whichever element was clicked, closed by
   Escape, blur-out, or Save/Remove. Only one is ever open at a time. */
var todoDuePopoverCleanup = null;
function closeTodoDuePopover(){
  var existing = document.querySelector('.todo-due-popover');
  if(existing) existing.remove();
  if(todoDuePopoverCleanup){
    todoDuePopoverCleanup();
    todoDuePopoverCleanup = null;
  }
}
function openTodoDuePopover(anchorEl, block, currentDue, onSaved){
  onSaved = onSaved || renderPage;
  closeTodoDuePopover();
  var rect = anchorEl.getBoundingClientRect();
  var pop = document.createElement('div');
  pop.className = 'todo-due-popover';
  var input = document.createElement('input');
  input.type = 'date';
  input.value = currentDue || '';
  var saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save';

  function onOutsideClick(e){
    if(!pop.contains(e.target) && e.target !== anchorEl){
      closeTodoDuePopover();
    }
  }
  function onEscKey(e){
    if(e.key === 'Escape'){
      closeTodoDuePopover();
    }
  }

  saveBtn.addEventListener('click', function(e){
    e.stopPropagation();
    var cur = todoInfo(block.text || '');
    if(!cur){ closeTodoDuePopover(); return; }
    var doneChar = cur.done ? 'x' : ' ';
    block.text = '[' + doneChar + '] ' + setTodoDue(cur.rest, input.value || null);
    save(); onSaved();
    closeTodoDuePopover();
  });
  pop.appendChild(input);
  pop.appendChild(saveBtn);

  if(currentDue){
    var removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', function(e){
      e.stopPropagation();
      var cur = todoInfo(block.text || '');
      if(!cur){ closeTodoDuePopover(); return; }
      var doneChar = cur.done ? 'x' : ' ';
      block.text = '[' + doneChar + '] ' + setTodoDue(cur.rest, null);
      save(); onSaved();
      closeTodoDuePopover();
    });
    pop.appendChild(removeBtn);
  }

  /* Attach listeners before any synchronous close can occur. This makes the
     cleanup handle valid even when Save/Remove is clicked immediately. */
  document.addEventListener('mousedown', onOutsideClick);
  document.addEventListener('keydown', onEscKey);
  todoDuePopoverCleanup = function(){
    document.removeEventListener('mousedown', onOutsideClick);
    document.removeEventListener('keydown', onEscKey);
    todoDuePopoverCleanup = null;
  };

  document.body.appendChild(pop);
  var top = rect.bottom + 4, left = rect.left;
  var maxLeft = window.innerWidth - pop.offsetWidth - 8;
  if(left > maxLeft) left = Math.max(8, maxLeft);
  pop.style.top = top + 'px';
  pop.style.left = left + 'px';
  input.focus();
}
function revealBlock(blockId){
  var blk = state.blocks[blockId];
  if(!blk){ toast('That line no longer exists.'); return; }
  var p = blk.parent;
  while(p){
    var pb = state.blocks[p];
    if(!pb) break;
    pb.collapsed = false;
    p = pb.parent;
  }
  save();
  openPage(blk.pageId);
  setTimeout(function(){
    var row = document.querySelector('.block-row[data-id="'+blockId+'"]');
    if(row){
      row.scrollIntoView({block:'center', behavior:'smooth'});
      row.classList.add('flash-highlight');
      setTimeout(function(){ row.classList.remove('flash-highlight'); }, 1600);
    }
  }, 30);
}

/* ============================================================
   TASKS VIEW
   A flat, filterable, sortable list of every to-do across every
   non-trashed page (built on collectAllTodos() in 02-editor-core.js).
   Opened from the sidebar like Graph view; reuses the exact same
   .todo-row/.todo-checkbox/.todo-due-chip markup and behavior the
   in-page checkboxes use, so ticking one here is identical to ticking
   it on its own page — same block, same save() path. */
var tasksViewState = { query: '', hideDone: false, sort: 'due' };

function tasksSortComparator(sort){
  return function(a, b){
    if(a.done !== b.done) return a.done ? 1 : -1; /* done always sinks to the bottom */
    if(sort === 'page'){
      return a.pageTitle.localeCompare(b.pageTitle) || a.text.localeCompare(b.text);
    }
    /* sort === 'due' (default): overdue/soonest first, no-due-date last */
    if(!!a.due !== !!b.due) return a.due ? -1 : 1;
    if(a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
    return a.pageTitle.localeCompare(b.pageTitle) || a.text.localeCompare(b.text);
  };
}

function renderTasksView(){
  var listEl = document.getElementById('tasks-list');
  var summaryEl = document.getElementById('tasks-summary');
  if(!listEl) return;
  var all = collectAllTodos();
  var q = tasksViewState.query.trim().toLowerCase();
  var visible = all.filter(function(t){
    if(tasksViewState.hideDone && t.done) return false;
    if(q && t.text.toLowerCase().indexOf(q) === -1 && t.pageTitle.toLowerCase().indexOf(q) === -1) return false;
    return true;
  }).sort(tasksSortComparator(tasksViewState.sort));

  var openCount = all.filter(function(t){ return !t.done; }).length;
  var overdueCount = all.filter(function(t){ return t.overdue; }).length;
  summaryEl.textContent = all.length === 0 ? 'No to-dos yet.' :
    openCount + ' open' + (overdueCount ? ' · ' + overdueCount + ' overdue' : '') +
    ' · ' + (all.length - openCount) + ' done';

  listEl.innerHTML = '';
  if(!visible.length){
    var empty = document.createElement('div');
    empty.className = 'tasks-empty';
    empty.textContent = all.length ? 'Nothing matches.' : 'Nothing tracked yet — check a line off as a to-do with the ☐ hover button on any page.';
    listEl.appendChild(empty);
    return;
  }

  visible.forEach(function(t){
    var block = state.blocks[t.blockId];
    if(!block) return; /* stale between collectAllTodos() and render, extremely rare */

    var row = document.createElement('div');
    row.className = 'task-row';

    var todoRow = document.createElement('label');
    todoRow.className = 'todo-row';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'todo-checkbox';
    cb.checked = t.done;
    var todoText = document.createElement('span');
    todoText.className = 'todo-text' + (t.done ? ' todo-done-text' : '');
    todoText.innerHTML = decorateText(t.text);
    cb.addEventListener('click', function(e){
      e.stopPropagation();
      var cur = todoInfo(block.text || '');
      var rest = cur ? cur.rest : '';
      block.text = '[' + (cb.checked ? 'x' : ' ') + '] ' + rest;
      save();
      renderTasksView();
      if(state.currentPageId === t.pageId) renderPage();
    });
    todoRow.appendChild(cb);
    todoRow.appendChild(todoText);

    if(t.due){
      var dueChip = document.createElement('button');
      dueChip.type = 'button';
      dueChip.className = 'todo-due-chip ' + todoDueStatus(t.due);
      dueChip.textContent = '📅 ' + formatTodoDue(t.due);
      dueChip.title = 'Due ' + t.due + ' — click to change';
      dueChip.addEventListener('click', function(e){
        e.stopPropagation();
        openTodoDuePopover(dueChip, block, t.due, renderTasksView);
      });
      todoRow.appendChild(dueChip);
    } else {
      var addDueBtn = document.createElement('button');
      addDueBtn.type = 'button';
      addDueBtn.className = 'todo-due-add-btn';
      addDueBtn.title = 'Add a due date';
      addDueBtn.textContent = '📅+';
      addDueBtn.addEventListener('click', function(e){
        e.stopPropagation();
        openTodoDuePopover(addDueBtn, block, null, renderTasksView);
      });
      todoRow.appendChild(addDueBtn);
    }
    row.appendChild(todoRow);

    var pageLink = document.createElement('button');
    pageLink.type = 'button';
    pageLink.className = 'task-page-link';
    pageLink.textContent = t.pageTitle;
    pageLink.addEventListener('click', function(){
      document.getElementById('tasks-view').classList.remove('visible');
      revealBlock(t.blockId);
    });
    row.appendChild(pageLink);

    listEl.appendChild(row);
  });
}

/* dragField: when set (e.g. 'sortOrder' or 'pinnedOrder'), rows in
   this list get a drag handle and can be manually reordered; the
   resulting order is written to that field on every page in `list`.
   Left null/undefined to render a plain, non-reorderable list (used
   while a search filter is active, since the displayed order is a
   relevance ranking rather than the list you'd want to rearrange). */
function fillList(elId, list, forceTag, dragField){
  var ul = document.getElementById(elId);
  ul.innerHTML = "";
  var dragSrcId = null;
  list.forEach(function(p){
    var isTag = forceTag || p.type === 'tag';
    var li = document.createElement('li');
    var row = document.createElement('div');
    row.className = 'trash-row' + (isTag ? ' tagitem' : '');
    row.dataset.pageId = p.id; /* lets the right-click handler identify which page this row is */
    var a = document.createElement('a');
    a.href = "javascript:void(0)";
    a.textContent = (isTag ? "#"+p.title : p.title) + (isTag && p.isSupertag ? ' ⚡' : '') + (p.locked ? ' 🔒' : '');
    if(isTag && p.isSupertag) a.title = (a.title ? a.title + ' — ' : '') + 'Supertag';
    if(p.locked) a.title = 'Locked — read-only';
    if(p.id === state.currentPageId) a.className = "active";
    a.onclick = function(){ openPage(p.id); };
    var pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'pin-btn' + (p.pinned ? ' pinned' : '');
    pinBtn.title = p.pinned ? 'Unpin' : 'Pin to top';
    pinBtn.setAttribute('aria-label', (p.pinned ? 'Unpin ' : 'Pin ') + '"' + p.title + '"' + (p.pinned ? '' : ' to top'));
    pinBtn.textContent = p.pinned ? '★' : '☆';
    pinBtn.onclick = function(e){ e.stopPropagation(); togglePinPage(p.id); };
    if(dragField){
      var handle = document.createElement('span');
      handle.className = 'sidebar-drag-handle';
      handle.title = 'Drag to reorder';
      handle.textContent = '⠿';
      handle.draggable = true;
      handle.addEventListener('dragstart', function(e){
        dragSrcId = p.id;
        e.dataTransfer.effectAllowed = 'move';
        try{ e.dataTransfer.setData('text/plain', p.id); }catch(err){}
        setTimeout(function(){ row.classList.add('dragging'); }, 0);
      });
      handle.addEventListener('dragend', function(){
        row.classList.remove('dragging');
        dragSrcId = null;
        ul.querySelectorAll('.drag-over-before,.drag-over-after').forEach(function(el){
          el.classList.remove('drag-over-before','drag-over-after');
        });
      });
      row.appendChild(handle);
      row.addEventListener('dragover', function(e){
        if(!dragSrcId || dragSrcId === p.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        var rect = row.getBoundingClientRect();
        var pos = (e.clientY - rect.top) < rect.height/2 ? 'before' : 'after';
        row.classList.remove('drag-over-before','drag-over-after');
        row.classList.add('drag-over-'+pos);
        row.dataset.dropPos = pos;
      });
      row.addEventListener('dragleave', function(){
        row.classList.remove('drag-over-before','drag-over-after');
      });
      row.addEventListener('drop', function(e){
        e.preventDefault();
        row.classList.remove('drag-over-before','drag-over-after');
        var srcId = dragSrcId, pos = row.dataset.dropPos || 'after';
        dragSrcId = null;
        if(!srcId || srcId === p.id) return;
        reorderSidebarList(list, dragField, srcId, p.id, pos);
      });
    }
    row.appendChild(a);
    row.appendChild(pinBtn);
    li.appendChild(row);
    ul.appendChild(li);
  });
}

/* Re-derives sequential values for `field` (sortOrder/pinnedOrder) on
   every page in `list`, from the new position of `srcId` relative to
   `targetId` — mirrors deriveOrder's approach for blocks, just flat
   instead of tree-shaped. */
function reorderSidebarList(list, field, srcId, targetId, pos){
  var ids = list.map(function(p){ return p.id; });
  var from = ids.indexOf(srcId);
  if(from === -1) return;
  ids.splice(from, 1);
  var to = ids.indexOf(targetId);
  if(to === -1) return;
  if(pos === 'after') to++;
  ids.splice(to, 0, srcId);
  ids.forEach(function(id, i){
    var pg = state.pages[id];
    if(pg) pg[field] = i;
  });
  save();
  renderSidebar(document.getElementById('search-box').value);
}

function togglePinPage(pageId){
  var page = state.pages[pageId];
  if(!page) return;
  if(page.pinned) delete page.pinned; else page.pinned = true;
  save();
  renderSidebar(document.getElementById('search-box').value);
}


