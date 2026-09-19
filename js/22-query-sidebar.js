/* ============================================================
 * 22-query-sidebar.js
 * Permanent Queries workspace + searchable query index.
 *
 * A "query" in Nexus is a {{query: ...}} block. This module gives those
 * blocks a discoverable home without changing the underlying query model:
 * the default Queries page contains an all-query live query, while the
 * sidebar index discovers every other live query block across the notebook.
 * ============================================================ */
"use strict";

var DEFAULT_QUERY_TITLE = 'Queries';
var querySidebarFilter = '';

function findDefaultQueryPage(){
  var key = DEFAULT_QUERY_TITLE.toLowerCase();
  var id = state && state.titleIndex ? state.titleIndex[key] : null;
  return id && state.pages[id] ? state.pages[id] : null;
}

function isQueryBlock(block){
  return !!(block && typeof block.text === 'string' && QUERY_BLOCK_RE.test(block.text) &&
    block.text.trim().match(/^\{\{\s*query\s*:/i));
}

function ensureDefaultQueryPage(){
  if(!state) return null;
  var existing = findDefaultQueryPage();
  if(existing){
    var hasQuery = (existing.rootBlocks || []).some(function(id){
      return isQueryBlock(state.blocks[id]);
    });
    if(!hasQuery){
      var repairedId = uid();
      state.blocks[repairedId] = mkBlock(repairedId, existing.id, null, '{{query: }}');
      state.blocks[repairedId].queryName = 'All queries';
      existing.rootBlocks = existing.rootBlocks || [];
      existing.rootBlocks.push(repairedId);
    }
    existing.systemQueryPage = true;
    existing.permanentSidebarQuery = true;
    return existing;
  }

  var pid = uid();
  var bid = uid();
  var page = {
    id: pid,
    title: DEFAULT_QUERY_TITLE,
    type: 'page',
    createdAt: Date.now(),
    properties: [{key:'status', value:'system'}, {key:'type', value:'query hub'}],
    icon:'⌕', banner:'slate',
    rootBlocks: [bid],
    systemQueryPage: true,
    permanentSidebarQuery: true
  };
  state.pages[pid] = page;
  state.blocks[bid] = mkBlock(bid, pid, null, '{{query: }}');
  state.blocks[bid].queryName = 'All queries';
  state.titleIndex[DEFAULT_QUERY_TITLE.toLowerCase()] = pid;
  return page;
}

function queryEntries(){
  var entries = [];
  Object.keys(state.blocks || {}).forEach(function(id){
    var block = state.blocks[id];
    if(!isQueryBlock(block)) return;
    var page = state.pages[block.pageId];
    if(!page || page.trashedAt) return;
    var m = /^\{\{\s*query\s*:\s*([\s\S]*?)\}\}\s*$/i.exec(block.text || '');
    var qstr = m ? m[1].trim() : '';
    var name = block.queryName || '';
    if(!name){
      if(qstr){
        name = qstr.length > 56 ? qstr.slice(0,56).trim() + '…' : qstr;
      } else {
        name = 'All lines query';
      }
    }
    var searchText = [name, page.title, qstr, 'query'].join(' ').toLowerCase();
    entries.push({
      blockId:id,
      pageId:page.id,
      pageTitle:page.title,
      name:name,
      query:qstr,
      searchText:searchText,
      isDefault:page.title.toLowerCase() === DEFAULT_QUERY_TITLE.toLowerCase() && !!page.systemQueryPage
    });
  });
  entries.sort(function(a,b){
    if(a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.pageTitle.localeCompare(b.pageTitle) || a.name.localeCompare(b.name);
  });
  return entries;
}

function openQueryEntry(entry){
  if(!entry || !state.pages[entry.pageId]) return;
  openPage(entry.pageId);
  setTimeout(function(){
    var safeId = String(entry.blockId).replace(/\\/g,'\\\\').replace(/"/g,'\\"');
    var el = document.querySelector('[data-query-block-id="' + safeId + '"]');
    if(el){
      el.scrollIntoView({behavior:'smooth', block:'center'});
      el.setAttribute('tabindex','-1');
      try{ el.focus({preventScroll:true}); }catch(ignore){}
      setTimeout(function(){ if(el.getAttribute('tabindex') === '-1') el.removeAttribute('tabindex'); }, 1200);
    }
  }, 0);
}

function renderQuerySidebarSection(){
  var section = document.getElementById('query-section');
  var ul = document.getElementById('list-queries');
  var filterInput = document.getElementById('query-filter');
  if(!section || !ul) return;
  if(filterInput && filterInput.value !== querySidebarFilter) filterInput.value = querySidebarFilter;

  var entries = queryEntries();
  var needle = (querySidebarFilter || '').trim().toLowerCase();
  if(needle) entries = entries.filter(function(e){ return e.searchText.indexOf(needle) !== -1; });

  ul.innerHTML = '';
  if(!entries.length){
    var empty = document.createElement('li');
    empty.className = 'query-sidebar-empty';
    empty.textContent = needle ? 'No queries match this filter.' : 'No queries created yet.';
    ul.appendChild(empty);
  } else {
    entries.forEach(function(entry){
      var li = document.createElement('li');
      var row = document.createElement('div');
      row.className = 'query-sidebar-row' + (entry.pageId === state.currentPageId ? ' active' : '');
      row.dataset.queryBlockId = entry.blockId;
      var a = document.createElement('a');
      a.href='#'; a.addEventListener('click',function(e){e.preventDefault();});
      a.textContent = entry.name;
      a.title = entry.pageTitle + (entry.query ? ' · ' + entry.query : ' · matches all lines');
      a.onclick = function(){ openQueryEntry(entry); };
      row.appendChild(a);

      var meta = document.createElement('span');
      meta.className = 'query-sidebar-meta';
      meta.textContent = entry.pageTitle;
      row.appendChild(meta);
      li.appendChild(row);
      ul.appendChild(li);
    });
  }
  var count = document.getElementById('query-count');
  if(count) count.textContent = entries.length ? String(entries.length) : '';
}

function openDefaultQuery(){
  var page = ensureDefaultQueryPage();
  if(!page) return;
  save();
  openPage(page.id);
}

function ensureQueryWorkspace(){
  if(!state) return;
  ensureDefaultQueryPage();
}

function isPermanentQueryPage(page){
  return !!(page && page.systemQueryPage && page.permanentSidebarQuery &&
    page.title.toLowerCase() === DEFAULT_QUERY_TITLE.toLowerCase());
}
