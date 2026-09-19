/* ============================================================
 * 21-database-sidebar.js
 * Permanent Database workspace + searchable database index.
 *
 * A "database" in Nexus is a {{table: ...}} block. This module gives
 * those blocks a discoverable home without changing the underlying data
 * model: the default Database page is a normal page containing an
 * all-pages database, while the sidebar index discovers every other live
 * database block across the notebook.
 * ============================================================ */
"use strict";

var DEFAULT_DATABASE_TITLE = 'Database';
var databaseSidebarFilter = '';

function findDefaultDatabasePage(){
  var key = DEFAULT_DATABASE_TITLE.toLowerCase();
  var id = state && state.titleIndex ? state.titleIndex[key] : null;
  return id && state.pages[id] ? state.pages[id] : null;
}

function ensureDefaultDatabasePage(){
  if(!state) return null;
  var existing = findDefaultDatabasePage();
  if(existing){
    var hasDb = (existing.rootBlocks || []).some(function(id){
      return isDatabaseBlock(state.blocks[id]);
    });
    if(!hasDb){
      var repairedId = uid();
      state.blocks[repairedId] = mkBlock(repairedId, existing.id, null, '{{table: }}');
      state.blocks[repairedId].dbName = 'All pages';
      existing.rootBlocks = existing.rootBlocks || [];
      existing.rootBlocks.push(repairedId);
    }
    existing.systemPage = true;
    existing.permanentSidebar = true;
    return existing;
  }

  var pid = uid();
  var bid = uid();
  var page = {
    id: pid,
    title: DEFAULT_DATABASE_TITLE,
    type: 'page',
    createdAt: Date.now(),
    properties: [{key:'status', value:'system'}, {key:'type', value:'database hub'}],
    icon:'🗃️', banner:'forest',
    rootBlocks: [bid],
    systemPage: true,
    permanentSidebar: true
  };
  state.pages[pid] = page;
  state.blocks[bid] = mkBlock(bid, pid, null, '{{table: }}');
  state.blocks[bid].dbName = 'All pages';
  state.titleIndex[DEFAULT_DATABASE_TITLE.toLowerCase()] = pid;
  return page;
}

function isDatabaseBlock(block){
  return !!(block && typeof block.text === 'string' && QUERY_BLOCK_RE.test(block.text) &&
    block.text.trim().match(/^\{\{\s*table\s*:/i));
}

function databaseEntries(){
  var entries = [];
  Object.keys(state.blocks || {}).forEach(function(id){
    var block = state.blocks[id];
    if(!isDatabaseBlock(block)) return;
    var page = state.pages[block.pageId];
    if(!page || page.trashedAt) return;
    var m = /^\{\{\s*table\s*:\s*([\s\S]*?)\}\}\s*$/i.exec(block.text || '');
    var qstr = m ? m[1].trim() : '';
    var dirs = typeof activeDbViewDirs === 'function' ? activeDbViewDirs(block.id, qstr) : (typeof extractTableDirectives === 'function' ? extractTableDirectives(qstr).dirs : {view:'table'});
    var view = (dirs && dirs.view) || 'table';
    var name = block.dbName || '';
    if(!name){
      var parsed = typeof extractTableDirectives === 'function' ? extractTableDirectives(qstr) : {remainder:''};
      name = parsed.remainder ? parsed.remainder : ((view.charAt(0).toUpperCase()+view.slice(1)) + ' database');
    }
    var searchText = [name, page.title, qstr, view].join(' ').toLowerCase();
    entries.push({
      blockId: id,
      pageId: page.id,
      pageTitle: page.title,
      name: name,
      view: view,
      searchText: searchText,
      isDefault: page.title.toLowerCase() === DEFAULT_DATABASE_TITLE.toLowerCase() && !!page.systemPage
    });
  });
  entries.sort(function(a,b){
    if(a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.pageTitle.localeCompare(b.pageTitle) || a.name.localeCompare(b.name);
  });
  return entries;
}

function openDatabaseEntry(entry){
  if(!entry || !state.pages[entry.pageId]) return;
  openPage(entry.pageId);
  setTimeout(function(){
    var safeId = String(entry.blockId).replace(/\\/g,'\\\\').replace(/"/g,'\\"');
    var el = document.querySelector('[data-db-block-id="' + safeId + '"]');
    if(el){
      el.scrollIntoView({behavior:'smooth', block:'center'});
      el.setAttribute('tabindex','-1');
      try{ el.focus({preventScroll:true}); }catch(ignore){}
      setTimeout(function(){ if(el.getAttribute('tabindex') === '-1') el.removeAttribute('tabindex'); }, 1200);
    }
  }, 0);
}

function renderDatabaseSidebarSection(){
  var section = document.getElementById('database-section');
  var ul = document.getElementById('list-databases');
  var filterInput = document.getElementById('database-filter');
  if(!section || !ul) return;
  if(filterInput && filterInput.value !== databaseSidebarFilter) filterInput.value = databaseSidebarFilter;

  var entries = databaseEntries();
  var needle = (databaseSidebarFilter || '').trim().toLowerCase();
  if(needle) entries = entries.filter(function(e){ return e.searchText.indexOf(needle) !== -1; });

  ul.innerHTML = '';
  if(!entries.length){
    var empty = document.createElement('li');
    empty.className = 'database-sidebar-empty';
    empty.textContent = needle ? 'No databases match this filter.' : 'No databases created yet.';
    ul.appendChild(empty);
  } else {
    entries.forEach(function(entry){
      var li = document.createElement('li');
      var row = document.createElement('div');
      row.className = 'database-sidebar-row' + (entry.pageId === state.currentPageId ? ' active' : '');
      row.dataset.dbBlockId = entry.blockId;
      var a = document.createElement('a');
      a.href = 'javascript:void(0)';
      a.textContent = entry.name;
      a.title = entry.pageTitle + ' · ' + entry.view + ' view';
      a.onclick = function(){ openDatabaseEntry(entry); };
      row.appendChild(a);

      var meta = document.createElement('span');
      meta.className = 'database-sidebar-meta';
      meta.textContent = entry.pageTitle + (entry.view && entry.view !== 'table' ? ' · ' + entry.view : '');
      row.appendChild(meta);
      li.appendChild(row);
      ul.appendChild(li);
    });
  }
  var count = document.getElementById('database-count');
  if(count) count.textContent = entries.length ? String(entries.length) : '';
}

function openDefaultDatabase(){
  var page = ensureDefaultDatabasePage();
  if(!page) return;
  save();
  openPage(page.id);
}

/* Install the default page even in an existing notebook, but never save it
   into the user's undo history as a content edit. initNotebook() calls this
   before its migration baseline is established. */
function ensureDatabaseWorkspace(){
  if(!state) return;
  ensureDefaultDatabasePage();
}

/* Prevent the system Database page from being trashed. It is the permanent
   database landing page exposed by the sidebar. The user can edit its
   contents, but the workspace itself remains available. */
function isPermanentDatabasePage(page){
  return !!(page && page.systemPage && page.permanentSidebar && page.title.toLowerCase() === DEFAULT_DATABASE_TITLE.toLowerCase());
}
