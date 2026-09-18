/* ============================================================
 * 18-global-search.js
 * Full-screen "search everything" modal: live, full-text search over
 * every line in every page, grouped by page (like Obsidian's search
 * pane) rather than the sidebar's flat "Matching lines" list.
 *
 * Reuses findMatchingBlocks / buildSnippetHtml / escapeHtml / revealBlock
 * from 03-sidebar-search-templates.js and 00-state-and-helpers.js — same
 * query language as everywhere else (#tag, [[Page]], is:/has:/due:/
 * before:/after:/priority:, /regex/, "OR" — see 17-advanced-search.js).
 *
 * Part of Nexus — loaded as a plain <script> (not a module) in
 * index.html, in numeric filename order (after 17, before 14, which
 * must load last). All files share one global scope on purpose, so
 * `state`, helper functions, etc. declared in an earlier file are
 * directly usable here without imports.
 * ============================================================ */
"use strict";

var gsActiveIndex = 0;
var gsCollapsedPages = {}; /* pageId -> true while the user has collapsed that group */
var GS_MATCH_LIMIT = 300;  /* generous vs. the sidebar's 30 — this view has room */
var GS_GROUP_SHOWN = 12;   /* per-page cap before "+N more in this page" kicks in */

function openGlobalSearch(prefill){
  var overlay = document.getElementById('gs-overlay');
  var input = document.getElementById('gs-input');
  overlay.classList.add('visible');
  input.value = prefill != null ? prefill : (document.getElementById('search-box').value || '');
  renderGlobalSearchResults(input.value);
  setTimeout(function(){ input.focus(); input.select(); }, 0);
}

function closeGlobalSearch(){
  document.getElementById('gs-overlay').classList.remove('visible');
}

function gsFlatItems(){
  return Array.prototype.slice.call(document.querySelectorAll('#gs-results .gs-item'));
}

function gsSetActive(items, i){
  items.forEach(function(el){ el.classList.remove('active'); });
  if(!items.length) return;
  gsActiveIndex = (i + items.length) % items.length;
  var el = items[gsActiveIndex];
  el.classList.add('active');
  el.scrollIntoView({block:'nearest'});
}

function renderGlobalSearchResults(q){
  gsActiveIndex = 0;
  var resultsEl = document.getElementById('gs-results');
  var countEl = document.getElementById('gs-count');
  resultsEl.innerHTML = "";
  q = (q||"").trim();

  if(!q){
    countEl.textContent = "";
    resultsEl.innerHTML = '<div class="search-empty">Type to search every page and line — same operators as the sidebar search (#tag, [[Page]], is:done, due:, /regex/, "OR"…).</div>';
    return;
  }

  var hits = findMatchingBlocks(q, GS_MATCH_LIMIT);
  if(!hits.length){
    countEl.textContent = "No matches";
    resultsEl.innerHTML = '<div class="search-empty">No matching lines.</div>';
    return;
  }

  /* Group by page, keeping the order pages first appear in (hits are
     already sorted by relevance, so the strongest page naturally
     ends up first). */
  var order = [];
  var groups = {};
  hits.forEach(function(hit){
    var pid = hit.page.id;
    if(!groups[pid]){ groups[pid] = {page:hit.page, hits:[]}; order.push(pid); }
    groups[pid].hits.push(hit);
  });

  var truncated = hits.length >= GS_MATCH_LIMIT;
  countEl.textContent = hits.length + (truncated ? '+' : '') + ' match' + (hits.length===1?'':'es') +
    ' in ' + order.length + ' page' + (order.length===1?'':'s');

  order.forEach(function(pid){
    var group = groups[pid];
    var pageLabel = group.page.type === 'tag' ? '#'+group.page.title : group.page.title;
    var collapsed = !!gsCollapsedPages[pid];

    var wrap = document.createElement('div');
    wrap.className = 'gs-group';

    var head = document.createElement('div');
    head.className = 'gs-group-head';
    head.innerHTML = '<span class="gs-chevron">'+(collapsed?'▸':'▾')+'</span>'+
                      '<span class="gs-group-title">'+escapeHtml(pageLabel)+'</span>'+
                      '<span class="gs-group-count">'+group.hits.length+'</span>';
    head.onclick = function(){
      gsCollapsedPages[pid] = !collapsed;
      renderGlobalSearchResults(q);
    };
    wrap.appendChild(head);

    if(!collapsed){
      var itemsWrap = document.createElement('div');
      itemsWrap.className = 'gs-group-items';
      var shown = group.hits.slice(0, GS_GROUP_SHOWN);
      shown.forEach(function(hit){
        var item = document.createElement('div');
        item.className = 'gs-item';
        item.innerHTML = buildSnippetHtml(hit.block.text, q);
        item.onclick = function(){ revealBlock(hit.block.id); closeGlobalSearch(); };
        itemsWrap.appendChild(item);
      });
      if(group.hits.length > shown.length){
        var more = document.createElement('div');
        more.className = 'search-empty';
        more.style.padding = '4px 10px';
        more.textContent = '+' + (group.hits.length - shown.length) + ' more in this page';
        itemsWrap.appendChild(more);
      }
      wrap.appendChild(itemsWrap);
    }
    resultsEl.appendChild(wrap);
  });

  var items = gsFlatItems();
  if(items.length) gsSetActive(items, 0);
}

document.getElementById('btn-global-search').onclick = function(){
  openGlobalSearch();
  if(typeof closeSidebarIfNarrow === 'function') closeSidebarIfNarrow();
};
document.getElementById('search-matches-expand').onclick = function(e){
  e.stopPropagation();
  openGlobalSearch(document.getElementById('search-box').value);
};
document.getElementById('gs-close').onclick = closeGlobalSearch;
document.getElementById('gs-overlay').addEventListener('click', function(e){
  if(e.target.id === 'gs-overlay') closeGlobalSearch();
});
document.getElementById('gs-input').addEventListener('input', function(e){
  renderGlobalSearchResults(e.target.value);
});
document.getElementById('gs-input').addEventListener('keydown', function(e){
  var items = gsFlatItems();
  if(e.key === 'ArrowDown'){ e.preventDefault(); gsSetActive(items, gsActiveIndex+1); }
  else if(e.key === 'ArrowUp'){ e.preventDefault(); gsSetActive(items, gsActiveIndex-1); }
  else if(e.key === 'Enter'){
    e.preventDefault();
    var active = items[gsActiveIndex];
    if(active) active.click();
  }
  /* Escape is handled by the app-wide keydown handler in
     14-wiring-and-init.js, which also calls closeGlobalSearch(). */
});
