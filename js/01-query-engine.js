/* ============================================================
 * 01-query-engine.js
 * The {{query:}} / {{table:}} filter engine and the no-code query builder popup.
 *
 * Part of Nexus — loaded as a plain <script> (not a module) in
 * index.html, in numeric filename order. All files share one global
 * scope on purpose (same as the original single-file build), so
 * `state`, helper functions, etc. declared in an earlier file are
 * directly usable here without imports.
 * ============================================================ */
"use strict";

/* ============================================================
   QUERY / DATABASE ENGINE
   A block whose entire text is {{query: ...}} or {{table: ...}}
   renders as a live, auto-updating embed instead of plain text.
   Filter syntax inside the braces (all filters AND together):
     #tag            -> must reference this tag
     [[Page Name]]   -> must reference this page
     key:value       -> page property "key" contains "value"
     bare words      -> free-text substring match
   Any filter can be negated with a leading "-" (must NOT match),
   and any filter can offer several alternatives separated by "|"
   (matches if ANY of them match) — e.g. -#done or #urgent|important
   or [[Q1|Q2]] or status:"open|in progress".
   ============================================================ */
var QUERY_BLOCK_RE = /^\{\{\s*(query|table)\s*:\s*([\s\S]*?)\}\}\s*$/i;

function parseQueryFilters(qstr){
  var filters = {tags:[], pages:[], props:[], text:[]};
  var tokRe = /-?\[\[[^\]]+\]\]|-?[a-zA-Z0-9_-]+:"[^"]*"|-?"[^"]*"|-?\S+/g;
  var m;
  function splitAlts(s){
    return s.split('|').map(function(v){ return v.trim(); }).filter(Boolean);
  }
  while((m = tokRe.exec(qstr||""))){
    var raw = m[0];
    var negate = false;
    if(raw[0] === '-' && raw.length > 1){ negate = true; raw = raw.slice(1); }
    var pageMatch = raw.match(/^\[\[([^\]]+)\]\]$/);
    if(pageMatch){ filters.pages.push({values: splitAlts(pageMatch[1]), negate: negate}); continue; }
    if(raw[0] === '#' && raw.length > 1){ filters.tags.push({values: splitAlts(raw.slice(1)), negate: negate}); continue; }
    var propMatch = raw.match(/^([a-zA-Z0-9_-]+):(.+)$/);
    if(propMatch){
      filters.props.push({key:propMatch[1], values: splitAlts(propMatch[2].replace(/^"|"$/g,'')), negate: negate});
      continue;
    }
    filters.text.push({values: splitAlts(raw.replace(/^"|"$/g,'')), negate: negate});
  }
  return filters;
}

function pageMatchesProps(page, propFilters){
  return propFilters.every(function(pf){
    var isMatch = page.properties.some(function(pp){
      return pp.key.toLowerCase() === pf.key.toLowerCase() &&
        pf.values.some(function(v){ return pp.value.toLowerCase().indexOf(v.toLowerCase()) !== -1; });
    });
    return pf.negate ? !isMatch : isMatch;
  });
}

/* True if any of a filter group's alternatives is present in `haystackLower`
   (an array of lowercased ref titles) — used for tag/page filters. */
function anyRefMatches(group, haystackLower){
  return group.values.some(function(v){ return haystackLower.indexOf(v.toLowerCase()) !== -1; });
}

/* Pulls view/sort/group/cols directives out of a {{table: ...}} qstr
   before it reaches parseQueryFilters, so they control layout rather
   than being mistaken for property filters. Only ever used for table
   (database) blocks — {{query: ...}} block queries are unaffected. */
function extractTableDirectives(qstr){
  var dirs = {view:'table', sort:'', sortDesc:false, group:'', cols:null, agg:{}};
  var remainder = (qstr||'').replace(/(^|\s)(view|sort|group|cols|agg):(\S+)/gi, function(full, pre, key, val){
    key = key.toLowerCase();
    if(key === 'view'){
      var v = val.toLowerCase();
      dirs.view = (v === 'board' || v === 'kanban') ? 'board'
        : (v === 'gallery' || v === 'cards') ? 'gallery'
        : (v === 'calendar' || v === 'cal') ? 'calendar'
        : 'table';
    } else if(key === 'sort'){
      if(val[0] === '-'){ dirs.sortDesc = true; dirs.sort = val.slice(1); }
      else { dirs.sortDesc = false; dirs.sort = val; }
    } else if(key === 'group'){
      dirs.group = val;
    } else if(key === 'cols'){
      dirs.cols = val.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
    } else if(key === 'agg'){
      dirs.agg = {};
      val.split(',').forEach(function(pair){
        var kv = pair.split('=');
        if(kv.length === 2 && kv[0]) dirs.agg[kv[0]] = kv[1];
      });
    }
    return pre;
  }).trim();
  return {dirs: dirs, remainder: remainder};
}

function sortPages(pages, sortKey, desc){
  if(!sortKey) return pages;
  var keyLower = sortKey.toLowerCase();
  function valueOf(p){
    if(keyLower === 'title') return p.title || '';
    var pp = (p.properties||[]).filter(function(x){ return x.key.toLowerCase() === keyLower; })[0];
    return pp ? pp.value : '';
  }
  return pages.slice().sort(function(a,b){
    var av = valueOf(a), bv = valueOf(b);
    var an = parseFloat(av), bn = parseFloat(bv);
    var cmp = (av !== '' && bv !== '' && !isNaN(an) && !isNaN(bn)) ? (an - bn) : String(av).localeCompare(String(bv));
    return desc ? -cmp : cmp;
  });
}

/* Blocks matching every filter — used by {{query: ...}}.
   The actual filter parsing/matching (including everything from
   17-advanced-search.js: is:/has:/due:/before:/after:/priority:,
   comparisons, regex, and "OR") lives in parseAdvancedQuery /
   matchAdvancedQuery — this just builds one record per block and
   asks whether it matches. Plain #tag / [[Page]] / key:value / text
   queries (the only kind parseQueryFilters ever produced) behave
   exactly as before; the query-builder popup still reads/writes that
   original simple shape via parseQueryFilters below, unaffected. */
function runBlockQuery(qstr){
  var parsed = parseAdvancedQuery(qstr);
  var results = [];
  Object.keys(state.blocks).forEach(function(id){
    var blk = state.blocks[id];
    if(!blk.text || QUERY_BLOCK_RE.test(blk.text)) return;
    var page = state.pages[blk.pageId];
    if(!page || page.trashedAt) return;
    if(matchAdvancedQuery(parsed, searchRecordForBlock(blk, page)).match) results.push(blk);
  });
  return results;
}

/* Pages matching every filter — used by {{table: ...}}. A page "has" a
   tag/link if any of its own blocks reference it. */
function runTableQuery(qstr){
  var parsed = parseAdvancedQuery(qstr);
  var pageRefs = computePageRefsMap();
  return livePages().filter(function(p){
    return matchAdvancedQuery(parsed, searchRecordForPage(p, pageRefs[p.id] || [])).match;
  });
}

/* Keyed by query-block id: remembers which month each calendar view
   was showing, since the widget's own DOM (and any local vars) gets
   torn down and rebuilt on every re-render — without this, navigating
   to next/prev month would snap back to the current month on the very
   next edit anywhere on the page. */
var calendarCursors = {};
var querySelections = {}; /* query block id -> selected page ids, survives re-renders */
var CAL_MAX_CHIPS = 3;

function renderQueryWidget(container, kind, qstr, blockId){
  container.innerHTML = "";
  var box = document.createElement('div');
  box.className = 'query-embed';
  if(kind === 'table' && blockId) box.dataset.dbBlockId = blockId;
  if(kind === 'query' && blockId) box.dataset.queryBlockId = blockId;
  var head = document.createElement('div');
  head.className = 'query-embed-head';
  var headLabel = kind === 'table' ? '▤ Database' : '⌕ Query';
  var effectiveDirs = null; /* the dirs actually driving this render — from a saved view when one is active, else parsed straight from qstr */
  if(kind === 'table'){
    effectiveDirs = activeDbViewDirs(blockId, qstr);
    if(effectiveDirs.view !== 'table') headLabel += ' (' + effectiveDirs.view + ')';
  }
  head.textContent = headLabel + (qstr ? ': ' + qstr : ' (all)');
  var editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'query-embed-editbtn qb-raw-edit';
  editBtn.title = 'Edit the raw filter text instead';
  editBtn.textContent = '✎ raw';
  head.appendChild(editBtn);
  box.appendChild(head);

  if(kind === 'table') renderDbViewTabsBar(box, blockId);

  if(kind === 'table'){
    var parsed = extractTableDirectives(qstr);
    var dirs = effectiveDirs;
    var pages = runTableQuery(parsed.remainder);
    pages = dirs.sort ? sortPages(pages, dirs.sort, dirs.sortDesc) : sortPages(pages, 'title', false);
    if(!pages.length){
      var e1 = document.createElement('div'); e1.className = 'query-empty'; e1.textContent = 'No matching pages.';
      box.appendChild(e1);
    } else {
      var propKeys = dirs.cols;
      if(!propKeys){
        propKeys = [];
        pages.forEach(function(p){
          p.properties.forEach(function(pp){ if(propKeys.indexOf(pp.key) === -1) propKeys.push(pp.key); });
        });
      }
      function pagePropValue(p, k){
        var found = p.properties.filter(function(pp){ return pp.key.toLowerCase() === k.toLowerCase(); })[0];
        return found ? found.value : '';
      }
      function pageLink(p, cls){
        var link = document.createElement('span'); link.className = cls || 'link'; link.dataset.target = p.title; link.textContent = p.title;
        return link;
      }
      if(dirs.view === 'board'){
        var groupKey = dirs.group || propKeys[0] || '';
        var columns = {}; var order = [];
        pages.forEach(function(p){
          var v = groupKey ? (pagePropValue(p, groupKey) || '(none)') : '(none)';
          if(!columns[v]){ columns[v] = []; order.push(v); }
          columns[v].push(p);
        });
        var board = document.createElement('div'); board.className = 'query-board';
        order.forEach(function(colName){
          var col = document.createElement('div'); col.className = 'query-board-col';
          var colHead = document.createElement('div'); colHead.className = 'query-board-col-head';
          colHead.textContent = colName + ' · ' + columns[colName].length;
          col.appendChild(colHead);
          columns[colName].forEach(function(p){
            var card = document.createElement('div'); card.className = 'query-card';
            var title = document.createElement('div'); title.className = 'query-card-title';
            title.appendChild(pageLink(p));
            card.appendChild(title);
            propKeys.filter(function(k){ return k.toLowerCase() !== groupKey.toLowerCase(); }).forEach(function(k){
              var pp = getPagePropObj(p, k);
              if(!pp || pp.value === '') return;
              var meta = document.createElement('div'); meta.className = 'query-card-meta adv-card-meta';
              var lbl = document.createElement('span'); lbl.className = 'adv-card-meta-label'; lbl.textContent = k + ': ';
              meta.appendChild(lbl);
              meta.appendChild(buildInlineCellEditor(p, k, pp.type, function(){ renderPage(); }));
              card.appendChild(meta);
            });
            col.appendChild(card);
          });
          board.appendChild(col);
        });
        box.appendChild(board);
      } else if(dirs.view === 'gallery'){
        var gallery = document.createElement('div'); gallery.className = 'query-gallery';
        pages.forEach(function(p){
          var card = document.createElement('div'); card.className = 'query-card';
          var title = document.createElement('div'); title.className = 'query-card-title';
          title.appendChild(pageLink(p));
          card.appendChild(title);
          propKeys.forEach(function(k){
            var pp = getPagePropObj(p, k);
            if(!pp || pp.value === '') return;
            var meta = document.createElement('div'); meta.className = 'query-card-meta adv-card-meta';
            var lbl = document.createElement('span'); lbl.className = 'adv-card-meta-label'; lbl.textContent = k + ': ';
            meta.appendChild(lbl);
            meta.appendChild(buildInlineCellEditor(p, k, pp.type, function(){ renderPage(); }));
            card.appendChild(meta);
          });
          gallery.appendChild(card);
        });
        box.appendChild(gallery);
      } else if(dirs.view === 'calendar'){
        var dateKey = dirs.group || propKeys.filter(function(k){
          return pages.some(function(p){
            var pp = (p.properties||[]).filter(function(x){ return x.key.toLowerCase() === k.toLowerCase(); })[0];
            return pp && pp.type === 'date';
          });
        })[0] || propKeys[0] || 'date';

        function parseISODate(s){
          var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
          return m ? new Date(+m[1], +m[2]-1, +m[3]) : null;
        }
        function isoOf(d){
          return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
        }

        var byDate = {}, undatedPages = [], autoDatedIds = {};
        pages.forEach(function(p){
          var d = parseISODate(pagePropValue(p, dateKey));
          if(!d && p.createdAt){
            d = new Date(p.createdAt); d.setHours(0,0,0,0);
            autoDatedIds[p.id] = true;
          }
          if(!d){ undatedPages.push(p); return; }
          var k2 = isoOf(d);
          (byDate[k2] = byDate[k2] || []).push(p);
        });

        var today = new Date(); today.setHours(0,0,0,0);
        var calKey = blockId || 'default';
        var savedCursor = calendarCursors[calKey];
        var cursor = savedCursor
          ? new Date(savedCursor.year, savedCursor.month, 1)
          : new Date(today.getFullYear(), today.getMonth(), 1);

        var cal = document.createElement('div'); cal.className = 'query-calendar';
        var head = document.createElement('div'); head.className = 'query-cal-head';
        var prevBtn = document.createElement('button'); prevBtn.type = 'button'; prevBtn.textContent = '‹'; prevBtn.title = 'Previous month';
        var titleEl = document.createElement('div'); titleEl.className = 'query-cal-title';
        var nextBtn = document.createElement('button'); nextBtn.type = 'button'; nextBtn.textContent = '›'; nextBtn.title = 'Next month';
        [prevBtn, nextBtn].forEach(function(btn){ btn.addEventListener('click', function(e){ e.stopPropagation(); }); });
        head.appendChild(prevBtn); head.appendChild(titleEl); head.appendChild(nextBtn);
        cal.appendChild(head);

        var grid = document.createElement('div'); grid.className = 'query-cal-grid';
        cal.appendChild(grid);

        var undatedWrap = document.createElement('div'); undatedWrap.className = 'query-cal-undated';
        var undatedLabel = document.createElement('div'); undatedLabel.className = 'query-cal-undated-label';
        undatedLabel.textContent = 'No date info';
        var undatedList = document.createElement('div'); undatedList.className = 'query-cal-undated-list';
        undatedWrap.appendChild(undatedLabel); undatedWrap.appendChild(undatedList);
        cal.appendChild(undatedWrap);

        function renderCalChip(p, list){
          var isAuto = !!autoDatedIds[p.id];
          var chip = document.createElement('div'); chip.className = 'query-cal-chip' + (isAuto ? ' auto-dated' : '');
          chip.textContent = p.title;
          chip.title = p.title + (isAuto ? ' — no ' + dateKey + ' set, showing by creation date' : '');
          chip.addEventListener('click', function(e){ e.stopPropagation(); openPage(p.id); });
          list.appendChild(chip);
        }

        function renderDayChips(cell, dayPages, expanded){
          cell.querySelectorAll('.query-cal-chip, .query-cal-more').forEach(function(n){ n.remove(); });
          cell.classList.toggle('expanded', expanded);
          var over = dayPages.length - CAL_MAX_CHIPS;
          var toShow = (expanded || over <= 0) ? dayPages : dayPages.slice(0, CAL_MAX_CHIPS);
          toShow.forEach(function(p){ renderCalChip(p, cell); });
          if(over > 0){
            var toggle = document.createElement('div');
            toggle.className = 'query-cal-more';
            toggle.textContent = expanded ? 'Show less' : ('+' + over + ' more');
            toggle.addEventListener('click', function(e){
              e.stopPropagation();
              renderDayChips(cell, dayPages, !expanded);
            });
            cell.appendChild(toggle);
          }
        }

        function renderMonth(){
          calendarCursors[calKey] = {year: cursor.getFullYear(), month: cursor.getMonth()};
          titleEl.textContent = cursor.toLocaleDateString(undefined, {month:'long', year:'numeric'});
          grid.innerHTML = '';
          ['S','M','T','W','T','F','S'].forEach(function(d){
            var dow = document.createElement('div'); dow.className = 'query-cal-dow'; dow.textContent = d;
            grid.appendChild(dow);
          });
          var firstOfMonth = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
          var gridStart = new Date(firstOfMonth);
          gridStart.setDate(gridStart.getDate() - firstOfMonth.getDay());
          for(var i=0;i<42;i++){
            var d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate()+i);
            var cell = document.createElement('div'); cell.className = 'query-cal-day';
            if(d.getMonth() !== cursor.getMonth()) cell.classList.add('other-month');
            if(d.getTime() === today.getTime()) cell.classList.add('today');
            var num = document.createElement('div'); num.className = 'query-cal-daynum'; num.textContent = d.getDate();
            cell.appendChild(num);
            renderDayChips(cell, byDate[isoOf(d)] || [], false);
            grid.appendChild(cell);
          }
          undatedList.innerHTML = '';
          undatedWrap.style.display = undatedPages.length ? '' : 'none';
          undatedPages.forEach(function(p){ renderCalChip(p, undatedList); });
        }
        prevBtn.addEventListener('click', function(){ cursor.setMonth(cursor.getMonth()-1); renderMonth(); });
        nextBtn.addEventListener('click', function(){ cursor.setMonth(cursor.getMonth()+1); renderMonth(); });
        renderMonth();
        box.appendChild(cal);
      } else {
        var selected = querySelections[blockId] || (querySelections[blockId] = {});
        var rows = [];
        var table = document.createElement('table'); table.className = 'query-table';
        var thead = document.createElement('tr');
        var thSel = document.createElement('th'); thSel.className = 'qsel-cell';
        var selAllCb = document.createElement('input');
        selAllCb.type = 'checkbox';
        selAllCb.title = 'Select all rows';
        selAllCb.addEventListener('click', function(e){ e.stopPropagation(); });
        thSel.appendChild(selAllCb);
        thead.appendChild(thSel);
        var thPage = document.createElement('th'); thPage.textContent = 'Page'; thead.appendChild(thPage);
        propKeys.forEach(function(k){ var th = document.createElement('th'); th.textContent = k; thead.appendChild(th); });
        table.appendChild(thead);
        pages.forEach(function(p){
          var tr = document.createElement('tr');
          var tdSel = document.createElement('td'); tdSel.className = 'qsel-cell';
          var rowCb = document.createElement('input');
          rowCb.type = 'checkbox';
          rowCb.className = 'qsel';
          rowCb.addEventListener('click', function(e){ e.stopPropagation(); });
          rowCb.addEventListener('change', function(){
            if(rowCb.checked) selected[p.id] = true; else delete selected[p.id];
            querySelections[blockId] = selected;
            updateBulkBar();
          });
          rows.push({p:p, cb:rowCb});
          tdSel.appendChild(rowCb); tr.appendChild(tdSel);
          var td0 = document.createElement('td');
          td0.appendChild(pageLink(p)); tr.appendChild(td0);
          propKeys.forEach(function(k){
            var td = document.createElement('td'); td.className = 'adv-cell';
            var colType = inferColumnType(pages, k);
            td.appendChild(buildInlineCellEditor(p, k, colType, function(){ renderPage(); }));
            tr.appendChild(td);
          });
          table.appendChild(tr);
        });
        rows.forEach(function(r){
          r.cb.checked = !!selected[r.p.id];
        });
        selAllCb.checked = rows.length > 0 && rows.every(function(r){ return r.cb.checked; });
        appendAggregateFooterRow(table, propKeys, pages, dirs, blockId, pagePropValue);

        selAllCb.addEventListener('change', function(){
          rows.forEach(function(r){
            r.cb.checked = selAllCb.checked;
            if(selAllCb.checked) selected[r.p.id] = true; else delete selected[r.p.id];
            querySelections[blockId] = selected;
          });
          updateBulkBar();
        });
        box.appendChild(table);

        /* Bulk-edit bar: pick a property (existing or new), set or clear
           its value across every currently-checked row in one action. */
        var listId = 'bulk-propkeys-' + Math.random().toString(36).slice(2);
        var datalist = document.createElement('datalist');
        datalist.id = listId;
        collectKnownPropKeys().forEach(function(k){
          var opt = document.createElement('option'); opt.value = k; datalist.appendChild(opt);
        });
        box.appendChild(datalist);

        var bar = document.createElement('div'); bar.className = 'query-bulkbar';
        var countLabel = document.createElement('span');
        var keyInput = document.createElement('input');
        keyInput.type = 'text'; keyInput.placeholder = 'Property'; keyInput.setAttribute('list', listId);
        var valueInput = document.createElement('input');
        valueInput.type = 'text'; valueInput.placeholder = 'Value';
        var applyBtn = document.createElement('button'); applyBtn.type = 'button'; applyBtn.textContent = 'Set on selected';
        var clearBtn = document.createElement('button'); clearBtn.type = 'button'; clearBtn.textContent = 'Clear on selected';
        [keyInput, valueInput, applyBtn, clearBtn].forEach(function(el){
          el.addEventListener('click', function(e){ e.stopPropagation(); });
        });
        keyInput.addEventListener('input', updateBulkBar);
        applyBtn.addEventListener('click', function(){
          var key = keyInput.value.trim();
          var ids = Object.keys(selected);
          if(!key || !ids.length) return;
          bulkSetProperty(ids, key, valueInput.value);
        });
        clearBtn.addEventListener('click', function(){
          var key = keyInput.value.trim();
          var ids = Object.keys(selected);
          if(!key || !ids.length) return;
          bulkClearProperty(ids, key);
        });
        bar.appendChild(countLabel);
        bar.appendChild(keyInput);
        bar.appendChild(valueInput);
        bar.appendChild(applyBtn);
        bar.appendChild(clearBtn);
        box.appendChild(bar);

        function updateBulkBar(){
          var n = Object.keys(selected).length;
          countLabel.textContent = n ? (n + ' selected') : 'Select rows to bulk-edit a property';
          applyBtn.disabled = !n || !keyInput.value.trim();
          clearBtn.disabled = !n || !keyInput.value.trim();
        }
        updateBulkBar();
      }
    }
  } else {
    var results = runBlockQuery(qstr);
    var count = document.createElement('div'); count.className = 'query-count';
    count.textContent = results.length + (results.length === 1 ? ' result' : ' results');
    box.appendChild(count);
    if(!results.length){
      var e2 = document.createElement('div'); e2.className = 'query-empty'; e2.textContent = 'No matching lines.';
      box.appendChild(e2);
    } else {
      results.forEach(function(blk){
        var page = state.pages[blk.pageId];
        var row = document.createElement('div'); row.className = 'query-result';
        var src = document.createElement('div'); src.className = 'query-result-src';
        var srcLink = document.createElement('span'); srcLink.className = 'link';
        srcLink.dataset.target = page ? page.title : '';
        srcLink.textContent = page ? page.title : '(unknown page)';
        src.appendChild(srcLink);
        var body = document.createElement('div'); body.className = 'query-result-body';
        body.innerHTML = decorateText(blk.text);
        row.appendChild(src); row.appendChild(body);
        box.appendChild(row);
      });
    }
  }
  container.appendChild(box);
}

/* ============================================================
   QUERY BUILDER — a no-code, Notion/Anytype-style filter picker
   that sits on top of the {{query:}}/{{table:}} text syntax above.
   It only ever reads/writes that same qstr format, so the engine
   above (parseQueryFilters, runBlockQuery, runTableQuery) needs no
   changes — the builder is just a friendlier way to produce it.
   ============================================================ */
var qbKind = 'query';
var qbTargetBlockId = null; /* null => inserting a brand-new block */
var qbFilters = [];
var qbView = null; /* {view, sort, sortDesc, group, cols} — only used when qbKind === 'table' */

function qbQuoteIfNeeded(s){
  s = (s || '').replace(/"/g, '');
  return /\s/.test(s) ? '"' + s + '"' : s;
}

function qstrToFilters(qstr){
  var f = parseQueryFilters(qstr);
  var rows = [];
  f.tags.forEach(function(g){ rows.push({type:'tag', negate:g.negate, values:g.values.slice()}); });
  f.pages.forEach(function(g){ rows.push({type:'page', negate:g.negate, values:g.values.slice()}); });
  f.props.forEach(function(g){ rows.push({type:'prop', negate:g.negate, key:g.key, values:g.values.slice()}); });
  f.text.forEach(function(g){ rows.push({type:'text', negate:g.negate, values:g.values.slice()}); });
  return rows;
}

function filtersToQstr(rows){
  var parts = [];
  rows.forEach(function(r){
    var vals = (r.values || []).filter(Boolean);
    if(!vals.length) return;
    var neg = r.negate ? '-' : '';
    if(r.type === 'tag'){
      parts.push(neg + '#' + vals.map(function(v){ return v.replace(/\s/g, ''); }).join('|'));
    } else if(r.type === 'page'){
      parts.push(neg + '[[' + vals.join('|') + ']]');
    } else if(r.type === 'prop' && r.key){
      parts.push(neg + r.key.replace(/\s/g, '') + ':' + qbQuoteIfNeeded(vals.join('|')));
    } else if(r.type === 'text'){
      parts.push(neg + qbQuoteIfNeeded(vals.join('|')));
    }
  });
  return parts.join(' ');
}

function collectKnownTags(){
  var set = {};
  Object.keys(state.blocks).forEach(function(id){
    var blk = state.blocks[id];
    if(!blk.text) return;
    extractRefs(blk.text).forEach(function(r){ if(r.type === 'tag') set[r.title] = true; });
  });
  return Object.keys(set).sort(function(a,b){ return a.localeCompare(b); });
}

function collectKnownPageTitles(){
  return livePages().map(function(p){ return p.title; }).sort(function(a,b){ return a.localeCompare(b); });
}

function collectKnownPropKeys(){
  var set = {};
  livePages().forEach(function(p){ (p.properties||[]).forEach(function(pp){ set[pp.key] = true; }); });
  return Object.keys(set).sort(function(a,b){ return a.localeCompare(b); });
}

/* Bulk property editing — used by the database (table view) bulk-edit
   bar, so changing a property across many pages doesn't mean opening
   each one individually. */
function bulkSetProperty(pageIds, key, value){
  var n = 0;
  pageIds.forEach(function(id){
    var pg = state.pages[id];
    if(!pg) return;
    pg.properties = pg.properties || [];
    var existing = pg.properties.filter(function(pp){ return pp.key.toLowerCase() === key.toLowerCase(); })[0];
    if(existing) existing.value = value;
    else pg.properties.push({key:key, value:value, type:'text'});
    n++;
  });
  save();
  renderPage();
  toast('Set "'+key+'" on '+n+' page'+(n===1?'':'s')+'.');
}
function bulkClearProperty(pageIds, key){
  var n = 0;
  pageIds.forEach(function(id){
    var pg = state.pages[id];
    if(!pg || !pg.properties) return;
    var before = pg.properties.length;
    pg.properties = pg.properties.filter(function(pp){ return pp.key.toLowerCase() !== key.toLowerCase(); });
    if(pg.properties.length !== before) n++;
  });
  save();
  renderPage();
  toast('Cleared "'+key+'" from '+n+' page'+(n===1?'':'s')+'.');
}

function collectKnownPropValues(key){
  var set = {};
  livePages().forEach(function(p){
    (p.properties||[]).forEach(function(pp){
      if(pp.key.toLowerCase() === (key||'').toLowerCase()) set[pp.value] = true;
    });
  });
  return Object.keys(set).sort(function(a,b){ return a.localeCompare(b); });
}

/* Like collectKnownPropValues, but for multi-select properties: splits
   each stored comma-separated value into its individual options. */
function collectKnownPropValueParts(key){
  var set = {};
  livePages().forEach(function(p){
    (p.properties||[]).forEach(function(pp){
      if(pp.key.toLowerCase() === (key||'').toLowerCase()){
        pp.value.split(',').forEach(function(v){ v = v.trim(); if(v) set[v] = true; });
      }
    });
  });
  return Object.keys(set).sort(function(a,b){ return a.localeCompare(b); });
}

function refreshQBDatalists(){
  function fill(id, values){
    var dl = document.getElementById(id);
    dl.innerHTML = '';
    values.forEach(function(v){
      var opt = document.createElement('option');
      opt.value = v;
      dl.appendChild(opt);
    });
  }
  fill('qb-taglist', collectKnownTags());
  fill('qb-pagelist', collectKnownPageTitles());
  fill('qb-proplist', collectKnownPropKeys());
}

function updateQBPreview(){
  var qstr = filtersToQstr(qbFilters);
  var el = document.getElementById('qb-preview');
  if(qbKind === 'table'){
    var pages = runTableQuery(qstr);
    el.textContent = pages.length + (pages.length === 1 ? ' matching page' : ' matching pages');
  } else {
    var results = runBlockQuery(qstr);
    el.textContent = results.length + (results.length === 1 ? ' matching line' : ' matching lines');
  }
}

function buildQBRow(r, idx){
  var row = document.createElement('div');
  row.className = 'qb-row';

  var typeSel = document.createElement('select');
  [['tag','Tag'],['page','Page link'],['prop','Property'],['text','Text contains']].forEach(function(o){
    var opt = document.createElement('option'); opt.value = o[0]; opt.textContent = o[1];
    if(r.type === o[0]) opt.selected = true;
    typeSel.appendChild(opt);
  });
  typeSel.onchange = function(){
    var newType = typeSel.value;
    qbFilters[idx] = {type:newType, negate:false, values:[]};
    if(newType === 'prop') qbFilters[idx].key = '';
    renderQBRows();
  };
  row.appendChild(typeSel);

  var negSel = document.createElement('select');
  [['','is'],['neg','is not']].forEach(function(o){
    var opt = document.createElement('option'); opt.value = o[0]; opt.textContent = o[1];
    if((r.negate ? 'neg' : '') === o[0]) opt.selected = true;
    negSel.appendChild(opt);
  });
  negSel.title = 'Whether the page or line must match this, or must not match it';
  negSel.onchange = function(){ r.negate = (negSel.value === 'neg'); updateQBPreview(); };
  row.appendChild(negSel);

  if(r.type === 'prop'){
    var keyInput = document.createElement('input');
    keyInput.type = 'text'; keyInput.placeholder = 'property'; keyInput.setAttribute('list', 'qb-proplist');
    keyInput.style.flex = '0 1 34%';
    keyInput.value = r.key || '';
    keyInput.oninput = function(){ r.key = keyInput.value; updateQBPreview(); };
    row.appendChild(keyInput);

    var valInput = document.createElement('input');
    valInput.type = 'text'; valInput.placeholder = 'value (comma-separate for "any of")';
    var valListId = 'qb-propvals-' + idx;
    valInput.setAttribute('list', valListId);
    valInput.value = (r.values || []).join(', ');
    valInput.oninput = function(){
      r.values = valInput.value.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
      updateQBPreview();
    };
    row.appendChild(valInput);

    var valList = document.createElement('datalist');
    valList.id = valListId;
    collectKnownPropValues(r.key).forEach(function(v){
      var opt = document.createElement('option'); opt.value = v; valList.appendChild(opt);
    });
    row.appendChild(valList);
  } else {
    var valInput2 = document.createElement('input');
    valInput2.type = 'text';
    valInput2.placeholder = (r.type === 'tag' ? 'tag name' : r.type === 'page' ? 'page name' : 'word or phrase') + ' (comma-separate for "any of")';
    if(r.type === 'tag') valInput2.setAttribute('list', 'qb-taglist');
    if(r.type === 'page') valInput2.setAttribute('list', 'qb-pagelist');
    valInput2.value = (r.values || []).join(', ');
    valInput2.oninput = function(){
      r.values = valInput2.value.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
      updateQBPreview();
    };
    row.appendChild(valInput2);
  }

  var removeBtn = document.createElement('button');
  removeBtn.type = 'button'; removeBtn.className = 'qb-row-remove'; removeBtn.title = 'Remove this filter';
  removeBtn.setAttribute('aria-label', 'Remove this filter');
  removeBtn.textContent = '✕';
  removeBtn.onclick = function(){ qbFilters.splice(idx, 1); renderQBRows(); };
  row.appendChild(removeBtn);

  return row;
}

function renderQBRows(){
  var wrap = document.getElementById('qb-filters');
  wrap.innerHTML = '';
  if(!qbFilters.length){
    var empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = 'No filters yet — this will show everything. Add a filter to narrow it down.';
    wrap.appendChild(empty);
  } else {
    qbFilters.forEach(function(r, idx){ wrap.appendChild(buildQBRow(r, idx)); });
  }
  updateQBPreview();
}

function buildDirectivesStr(v){
  if(!v) return '';
  var parts = [];
  if(v.view && v.view !== 'table') parts.push('view:' + v.view);
  if((v.view === 'board' || v.view === 'calendar') && v.group) parts.push('group:' + v.group.replace(/\s/g, ''));
  if(v.sort) parts.push('sort:' + (v.sortDesc ? '-' : '') + v.sort.replace(/\s/g, ''));
  if(v.cols && v.cols.length) parts.push('cols:' + v.cols.join(','));
  if(v.agg){
    var aggParts = [];
    Object.keys(v.agg).forEach(function(k){
      if(v.agg[k] && v.agg[k] !== 'none') aggParts.push(k.replace(/[\s,=]/g, '') + '=' + v.agg[k]);
    });
    if(aggParts.length) parts.push('agg:' + aggParts.join(','));
  }
  return parts.join(' ');
}

function renderQBViewControls(){
  var wrap = document.getElementById('qb-view-controls');
  if(qbKind !== 'table' || !qbView){
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }
  wrap.style.display = 'flex';
  wrap.style.flexDirection = 'column';
  wrap.style.gap = '8px';
  wrap.innerHTML = '';
  var propKeys = collectKnownPropKeys();

  function labeled(text, els){
    var r = document.createElement('div'); r.className = 'qb-row';
    var lbl = document.createElement('span'); lbl.className = 'hint'; lbl.style.cssText = 'flex:0 0 62px;'; lbl.textContent = text;
    r.appendChild(lbl);
    els.forEach(function(el){ r.appendChild(el); });
    return r;
  }

  var viewSel = document.createElement('select');
  [['table','Table'],['board','Board'],['gallery','Gallery'],['calendar','Calendar']].forEach(function(o){
    var opt = document.createElement('option'); opt.value = o[0]; opt.textContent = o[1];
    if(qbView.view === o[0]) opt.selected = true;
    viewSel.appendChild(opt);
  });
  viewSel.onchange = function(){ qbView.view = viewSel.value; renderQBViewControls(); updateQBPreview(); };
  wrap.appendChild(labeled('View', [viewSel]));

  if(qbView.view === 'board' || qbView.view === 'calendar'){
    var groupSel = document.createElement('select');
    var noneOpt = document.createElement('option'); noneOpt.value = '';
    noneOpt.textContent = qbView.view === 'calendar' ? '(auto-detect a Date property)' : '(pick a property)';
    groupSel.appendChild(noneOpt);
    propKeys.forEach(function(k){
      var opt = document.createElement('option'); opt.value = k; opt.textContent = k;
      if(qbView.group === k) opt.selected = true;
      groupSel.appendChild(opt);
    });
    groupSel.onchange = function(){ qbView.group = groupSel.value; updateQBPreview(); };
    wrap.appendChild(labeled(qbView.view === 'calendar' ? 'Date property' : 'Group by', [groupSel]));
  }

  var sortSel = document.createElement('select');
  [['','Title (default)'],['title','Title']].forEach(function(o){
    var opt = document.createElement('option'); opt.value = o[0]; opt.textContent = o[1];
    sortSel.appendChild(opt);
  });
  propKeys.forEach(function(k){ var opt = document.createElement('option'); opt.value = k; opt.textContent = k; sortSel.appendChild(opt); });
  sortSel.value = qbView.sort || '';
  sortSel.onchange = function(){ qbView.sort = sortSel.value; updateQBPreview(); };
  var dirSel = document.createElement('select');
  [['','Ascending'],['desc','Descending']].forEach(function(o){
    var opt = document.createElement('option'); opt.value = o[0]; opt.textContent = o[1];
    if((qbView.sortDesc ? 'desc' : '') === o[0]) opt.selected = true;
    dirSel.appendChild(opt);
  });
  dirSel.onchange = function(){ qbView.sortDesc = (dirSel.value === 'desc'); updateQBPreview(); };
  wrap.appendChild(labeled('Sort by', [sortSel, dirSel]));

  var colsInput = document.createElement('input');
  colsInput.type = 'text';
  colsInput.placeholder = 'auto (every property used), or comma-separated to pick';
  colsInput.value = qbView.cols ? qbView.cols.join(', ') : '';
  colsInput.oninput = function(){
    var v = colsInput.value.trim();
    qbView.cols = v ? v.split(',').map(function(s){ return s.trim(); }).filter(Boolean) : null;
  };
  wrap.appendChild(labeled('Columns', [colsInput]));
}

function openQueryBuilder(kind, targetBlockId, existingQstr){
  qbKind = kind;
  qbTargetBlockId = targetBlockId || null;
  if(kind === 'table'){
    var parsed = extractTableDirectives(existingQstr || '');
    var qbBlock = targetBlockId ? state.blocks[targetBlockId] : null;
    if(qbBlock && Array.isArray(qbBlock.dbViews) && qbBlock.dbViews.length){
      /* This database has saved views (see js/16-advanced-database.js) —
         edit the active one's own dirs object directly (by reference)
         rather than the now-vestigial directives in the raw text, so
         View/Sort/Columns changes made here land where the tab bar
         actually reads them from. */
      var qbActiveView = qbBlock.dbViews.filter(function(v){ return v.id === qbBlock.dbActiveViewId; })[0] || qbBlock.dbViews[0];
      qbView = qbActiveView.dirs;
    } else {
      qbView = parsed.dirs;
    }
    qbFilters = qstrToFilters(parsed.remainder);
  } else {
    qbView = null;
    qbFilters = qstrToFilters(existingQstr || '');
  }
  document.getElementById('qb-title').textContent =
    (kind === 'table' ? '▤ Database view' : '⌕ Query') + (targetBlockId ? ' — edit filters' : ' — new');
  document.getElementById('qb-save').textContent = targetBlockId ? 'Save changes' : 'Insert';
  refreshQBDatalists();
  renderQBViewControls();
  renderQBRows();
  document.getElementById('querybuilder-overlay').style.display = 'flex';
}

function closeQueryBuilder(){
  document.getElementById('querybuilder-overlay').style.display = 'none';
}

function insertQueryBlockFinal(kind, qstr){
  var page = state.pages[state.currentPageId];
  if(!page) return;
  var id = uid();
  var text = '{{' + kind + ': ' + qstr + '}}';
  var nb = mkBlock(id, page.id, null, text);
  state.blocks[id] = nb;
  page.rootBlocks.push(id);
  save(); renderPage();
}

function updateQueryBlockFinal(blockId, kind, qstr){
  var b = state.blocks[blockId];
  if(!b) return;
  b.text = '{{' + kind + ': ' + qstr + '}}';
  if(editingBlockId === blockId) editingBlockId = null;
  save(); renderPage();
}

document.getElementById('qb-add-filter').onclick = function(){
  qbFilters.push({type:'tag', negate:false, values:[]});
  renderQBRows();
};
document.getElementById('qb-cancel').onclick = closeQueryBuilder;
document.getElementById('qb-save').onclick = function(){
  var filterStr = filtersToQstr(qbFilters);
  var qbBlockOnSave = qbTargetBlockId ? state.blocks[qbTargetBlockId] : null;
  var qbUsesSavedViews = qbKind === 'table' && qbBlockOnSave && Array.isArray(qbBlockOnSave.dbViews) && qbBlockOnSave.dbViews.length;
  /* When a saved view is being edited, qbView already *is* that view's
     dirs object (see openQueryBuilder above) and every control above
     mutated it live, so there's nothing left to fold into the text —
     the text only needs to carry the filters. */
  var qstr = (qbKind === 'table' && !qbUsesSavedViews) ? [buildDirectivesStr(qbView), filterStr].filter(Boolean).join(' ').trim() : filterStr;
  if(qbTargetBlockId) updateQueryBlockFinal(qbTargetBlockId, qbKind, qstr);
  else insertQueryBlockFinal(qbKind, qstr);
  closeQueryBuilder();
};
document.getElementById('querybuilder-overlay').addEventListener('click', function(e){
  if(e.target.id === 'querybuilder-overlay') closeQueryBuilder();
});

