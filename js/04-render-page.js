/* ============================================================
 * 04-render-page.js
 * Main page rendering, block zoom, and word/character count.
 *
 * Part of Nexus — loaded as a plain <script> (not a module) in
 * index.html, in numeric filename order. All files share one global
 * scope on purpose (same as the original single-file build), so
 * `state`, helper functions, etc. declared in an earlier file are
 * directly usable here without imports.
 * ============================================================ */
"use strict";

/* ============================================================
   RENDER: PAGE
   ============================================================ */
var editingBlockId = null;
var dragBlockId = null; /* set while a block is being dragged via its ⠿ handle */
var dockBlockId = null; /* last block the edit-dock toolbar (WYSIWYG + indent) targets */
var zoomedBlockId = null; /* when set, the outline shows just this block's subtree — reset per page */
var blockClipboard = null; /* set by a block row's Cut/Copy action — a detached {text, children:[...]} snapshot, independent of any block id, ready for Paste to re-materialize with fresh ids (in memory only; resets on reload) */

function renderAll(){
  renderSidebar(document.getElementById('search-box').value);
  renderPage();
  if(typeof dashboardRefreshIfVisible === 'function') dashboardRefreshIfVisible();
}

function renderPage(){
  var page = state.pages[state.currentPageId];
  if(!page) return;
  document.getElementById('page-type-pill').textContent =
    page.type === 'daily' ? 'Daily note' : page.type === 'tag' ? 'Tag' : 'Page';

  var trashBanner = document.getElementById('trash-banner');
  var deleteBtn = document.getElementById('btn-delete-page');
  if(page.trashedAt){
    trashBanner.classList.add('visible');
    document.getElementById('trash-banner-text').textContent =
      'This page is in Trash (deleted ' + new Date(page.trashedAt).toLocaleDateString() + '). Restore it to edit or link to it again.';
    deleteBtn.style.display = 'none';
  } else {
    trashBanner.classList.remove('visible');
    deleteBtn.style.display = '';
  }

  var titleEl = document.getElementById('page-title');
  if(document.activeElement !== titleEl) titleEl.textContent = page.title;
  titleEl.contentEditable = page.locked ? 'false' : 'true';
  titleEl.title = page.locked ? 'This page is locked — right-click to unlock' : '';
  document.getElementById('page-view').classList.toggle('page-locked', !!page.locked);

  document.getElementById('page-sub').textContent =
    "Created " + new Date(page.createdAt).toLocaleDateString();

  var isDocMode = page.viewMode === 'doc';
  document.getElementById('outline').classList.toggle('doc-mode', isDocMode);
  document.getElementById('page-view').classList.toggle('doc-mode-active', isDocMode);
  var docModeBtn = document.getElementById('btn-doc-mode');
  docModeBtn.textContent = isDocMode ? '☰ Outline mode' : '▤ Doc mode';
  docModeBtn.title = isDocMode
    ? 'Switch back to the block outline'
    : 'Switch to a continuous document view for longform writing';

  recomputeAllSupertags(); /* must run before rollups/formulas: it's what adds those properties in the first place */
  recomputeAllRollups();
  recomputeAllFormulas();
  renderSupertagBadges(page);
  renderProperties(page);
  renderSupertagPanel(page);
  renderOutline(page);
  renderBacklinks(page);
  renderWordCount(page);
  updateEditDock();
}

/* Keep the edit-dock's Indent/Outdent buttons in sync with whichever
   block was most recently focused (it stays the target even after the
   block blurs, so tapping the dock still acts on the right line). */
function updateEditDock(){
  var page = state.pages[state.currentPageId];
  var block = dockBlockId ? state.blocks[dockBlockId] : null;
  if(block && page && block.pageId !== page.id) block = null;
  if(!block) dockBlockId = null;
  document.getElementById('dock-outdent-btn').disabled = !block || !block.parent;
  document.getElementById('dock-indent-btn').disabled = !block || indexInSiblings(block) <= 0;
  document.getElementById('dock-up-btn').disabled = !block || !canMoveBlockStep(block, -1);
  document.getElementById('dock-down-btn').disabled = !block || !canMoveBlockStep(block, 1);
}

var PROP_TYPES = [
  ['text','Text'], ['number','Number'], ['date','Date'],
  ['checkbox','Checkbox'], ['select','Select'], ['multiselect','Multi-select'],
  ['rating','Rating'], ['relation','Relation'], ['rollup','Rollup'], ['formula','Formula']
];

/* ============================================================
   SUPERTAGS
   A "supertag" is a tag page (page.type === 'tag') with
   isSupertag = true and a schema of fields in supertagFields:
   [{key, type, default, formula}]. Any page that uses that
   #tag anywhere in its own blocks is an "instance" of it, and
   automatically gets those fields merged into its own
   properties — the tag defines the shape, the page holds the
   data, exactly like the rest of this app's property system.
   Nothing is ever overwritten: a field already present on the
   page (by key, case-insensitive) is left alone, so editing an
   instance's value is always safe even as the schema evolves.
   ============================================================ */

/* Every #tag referenced anywhere within a page's own outline
   (not other pages that merely mention it — that's a backlink,
   this is "what is this page tagged as"). */
function pageTagTitles(page){
  var found = {};
  function walk(id){
    var blk = state.blocks[id];
    if(!blk) return;
    extractRefs(blk.text).forEach(function(r){
      if(r.type === 'tag') found[r.title.toLowerCase()] = r.title;
    });
    (blk.children||[]).forEach(walk);
  }
  (page.rootBlocks||[]).forEach(walk);
  return Object.keys(found).map(function(k){ return found[k]; });
}

/* Pages that currently count as instances of a given supertag page. */
function supertagInstances(tagPage){
  return livePages().filter(function(p){
    if(p.id === tagPage.id) return false;
    return pageTagTitles(p).some(function(t){ return t.toLowerCase() === tagPage.title.toLowerCase(); });
  });
}

function applySupertagFields(page){
  if(!page) return;
  var tagTitles = pageTagTitles(page);
  if(!tagTitles.length) return;
  if(!Array.isArray(page.properties)) page.properties = [];
  var existingKeys = {};
  page.properties.forEach(function(pp){ existingKeys[(pp.key||'').toLowerCase()] = true; });
  tagTitles.forEach(function(t){
    var tagPage = findPageByTitle(t);
    if(!tagPage || tagPage.type !== 'tag' || !tagPage.isSupertag) return;
    (tagPage.supertagFields||[]).forEach(function(f){
      if(!f || !f.key) return;
      var k = f.key.toLowerCase();
      if(existingKeys[k]) return;
      var newProp = {key:f.key, type:f.type || 'text', value:''};
      if(newProp.type === 'checkbox') newProp.value = f.default === 'true' ? 'true' : 'false';
      else if(newProp.type === 'rating') newProp.value = /^[0-5]$/.test(f.default) ? f.default : '0';
      else if(newProp.type === 'formula') newProp.formula = f.formula || '';
      else newProp.value = f.default || '';
      page.properties.push(newProp);
      existingKeys[k] = true;
    });
  });
}

function recomputeAllSupertags(){
  livePages().forEach(function(p){ applySupertagFields(p); });
}

/* Small clickable "#tagname" badges under the title for every
   supertag this page is currently an instance of — a quick visual
   cue that the page is "typed", separate from its editable
   properties list below. */
function renderSupertagBadges(page){
  var wrap = document.getElementById('supertag-badges');
  wrap.innerHTML = '';
  var tagTitles = pageTagTitles(page).filter(function(t){
    var tp = findPageByTitle(t);
    return tp && tp.type === 'tag' && tp.isSupertag;
  });
  tagTitles.forEach(function(t){
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'supertag-badge';
    b.textContent = '#' + t;
    b.title = 'Open the #' + t + ' supertag';
    b.onclick = function(){ openPageByTitle(t, 'tag'); };
    wrap.appendChild(b);
  });
}

/* The schema editor + instance list shown on a tag's own page. */
function renderSupertagPanel(page){
  var panel = document.getElementById('supertag-panel');
  if(!panel) return;
  if(page.type !== 'tag'){ panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  document.getElementById('supertag-name').textContent = page.title;

  var toggle = document.getElementById('supertag-toggle-input');
  toggle.checked = !!page.isSupertag;
  toggle.disabled = !!page.locked;
  toggle.onchange = function(){
    page.isSupertag = toggle.checked;
    if(page.isSupertag && !Array.isArray(page.supertagFields)) page.supertagFields = [];
    save(); renderPage();
  };

  var addBtn = document.getElementById('add-supertag-field');
  addBtn.style.display = (page.isSupertag && !page.locked) ? '' : 'none';
  addBtn.onclick = function(){
    if(!Array.isArray(page.supertagFields)) page.supertagFields = [];
    page.supertagFields.push({key:'field', type:'text', default:''});
    save(); renderPage();
  };

  var fieldsWrap = document.getElementById('supertag-fields');
  fieldsWrap.innerHTML = '';
  fieldsWrap.style.display = page.isSupertag ? 'block' : 'none';
  if(page.isSupertag){
    (page.supertagFields||[]).forEach(function(f, i){
      if(!f.type) f.type = 'text';
      var row = document.createElement('div'); row.className = 'prop-row';

      var key = document.createElement('input'); key.type = 'text'; key.className = 'prop-val-input';
      key.style.flex = '0 1 140px';
      key.value = f.key; key.placeholder = 'field name';
      key.disabled = !!page.locked;
      key.onblur = function(){ f.key = key.value.trim() || 'field'; save(); };
      row.appendChild(key);

      var typeSel = document.createElement('select'); typeSel.className = 'prop-type-sel';
      typeSel.style.opacity = 1; typeSel.disabled = !!page.locked;
      typeSel.title = 'Field type';
      PROP_TYPES.forEach(function(t){
        var opt = document.createElement('option'); opt.value = t[0]; opt.textContent = t[1];
        if(f.type === t[0]) opt.selected = true;
        typeSel.appendChild(opt);
      });
      typeSel.onchange = function(){ f.type = typeSel.value; save(); renderSupertagPanel(page); };
      row.appendChild(typeSel);

      if(page.locked){
        /* read-only summary instead of editable default controls */
        var ro = document.createElement('span'); ro.className = 'prop-val'; ro.style.color = 'var(--ink-soft)';
        ro.textContent = f.type === 'formula' ? ('= ' + (f.formula || '—')) : (f.default || '—');
        row.appendChild(ro);
      } else if(f.type === 'checkbox'){
        var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = f.default === 'true';
        cb.onchange = function(){ f.default = cb.checked ? 'true' : 'false'; save(); renderSupertagPanel(page); };
        row.appendChild(cb);
      } else if(f.type === 'rating'){
        row.appendChild(renderRatingStars(f.default || '0', function(v){ f.default = String(v); save(); renderSupertagPanel(page); }));
      } else if(f.type === 'formula'){
        var fxInput = document.createElement('input'); fxInput.type = 'text'; fxInput.className = 'prop-val-input';
        fxInput.placeholder = 'formula, e.g. Price * Qty';
        fxInput.value = f.formula || '';
        fxInput.onblur = function(){ f.formula = fxInput.value; save(); };
        row.appendChild(fxInput);
      } else if(f.type === 'rollup'){
        var roNote = document.createElement('span'); roNote.className = 'prop-val'; roNote.style.color = 'var(--ink-soft)';
        roNote.textContent = 'configure per page once tagged';
        row.appendChild(roNote);
      } else {
        var defInput = document.createElement('input'); defInput.type = 'text'; defInput.className = 'prop-val-input';
        defInput.placeholder = 'default value (optional)';
        defInput.value = f.default || '';
        defInput.onblur = function(){ f.default = defInput.value; save(); };
        row.appendChild(defInput);
      }

      if(!page.locked){
        var del = document.createElement('button'); del.className = 'prop-del'; del.textContent = '✕';
        del.title = 'Remove field';
        del.setAttribute('aria-label', 'Remove field "' + (f.key || 'field') + '"');
        del.onclick = function(){ page.supertagFields.splice(i,1); save(); renderPage(); };
        row.appendChild(del);
      }
      fieldsWrap.appendChild(row);
    });
  }

  var instWrap = document.getElementById('supertag-instances');
  instWrap.innerHTML = '';
  if(page.isSupertag){
    var instances = supertagInstances(page);
    var heading = document.createElement('div'); heading.className = 'side-label';
    heading.textContent = instances.length
      ? (instances.length + (instances.length === 1 ? ' page tagged #' : ' pages tagged #') + page.title)
      : ('No pages tagged #' + page.title + ' yet');
    instWrap.appendChild(heading);
    if(instances.length){
      var list = document.createElement('div'); list.className = 'prop-chips';
      instances.forEach(function(tp){
        var chip = document.createElement('span'); chip.className = 'link prop-chip';
        chip.dataset.target = tp.title; chip.textContent = tp.title;
        list.appendChild(chip);
      });
      instWrap.appendChild(list);
    }
  }
}

/* ---- Relations & rollups ----
   A "relation" property stores a comma-separated list of OTHER page
   titles (like multi-select, but the values are real pages and the
   chips are clickable links). A "rollup" property is read-only: it
   follows one of this page's own relation properties out to those
   related pages and pulls back / aggregates one of their properties.
   Rollups are recomputed every render, so they always reflect the
   current state of the pages they point at. */
function getRelatedPagesForRelation(page, relationKey){
  var relProp = (page.properties||[]).filter(function(pp){
    return pp.type === 'relation' && pp.key.toLowerCase() === (relationKey||'').toLowerCase();
  })[0];
  if(!relProp) return [];
  return (relProp.value||'').split(',').map(function(s){ return s.trim(); }).filter(Boolean)
    .map(function(t){ return findPageByTitle(t); }).filter(Boolean);
}

function computeRollupValue(page, prop){
  var relatedPages = getRelatedPagesForRelation(page, prop.relationKey);
  var targetKey = (prop.targetKey || '').toLowerCase();
  var vals = relatedPages.map(function(rp){
    if(targetKey === 'title') return rp.title;
    var pp = (rp.properties||[]).filter(function(x){ return x.key.toLowerCase() === targetKey; })[0];
    return pp ? pp.value : '';
  }).filter(function(v){ return v !== ''; });
  var nums = vals.map(function(v){ return parseFloat(v); }).filter(function(n){ return !isNaN(n); });
  switch(prop.agg){
    case 'count': return String(relatedPages.length);
    case 'sum': return nums.length ? String(nums.reduce(function(a,b){ return a+b; }, 0)) : '';
    case 'avg': return nums.length ? String(nums.reduce(function(a,b){ return a+b; },0) / nums.length) : '';
    case 'min': return nums.length ? String(Math.min.apply(null, nums)) : '';
    case 'max': return nums.length ? String(Math.max.apply(null, nums)) : '';
    default: return vals.join(', '); /* 'list' */
  }
}

function recomputeRollups(page){
  (page.properties||[]).forEach(function(pp){
    if(pp.type === 'rollup') pp.value = computeRollupValue(page, pp);
  });
}

function recomputeAllRollups(){
  livePages().forEach(function(p){ recomputeRollups(p); });
}

function renderProperties(page){
  recomputeAllRollups(); /* keeps every rollup fresh whenever this panel redraws, not just on full page loads */
  recomputeAllFormulas(); /* same, for formula properties */
  var wrap = document.getElementById('properties');
  wrap.innerHTML = "";
  if(!page.properties.length){ wrap.style.display='none'; }
  else wrap.style.display='block';
  page.properties.forEach(function(prop, i){
    if(!prop.type) prop.type = 'text';
    var row = document.createElement('div'); row.className='prop-row';

    var key = document.createElement('span'); key.className='prop-key'; key.contentEditable = page.locked ? 'false' : 'true';
    key.textContent = prop.key; key.spellcheck = (typeof currentSettings !== 'undefined' && currentSettings.spellcheck === 'off') ? false : true;
    key.onblur = function(){ prop.key = key.textContent.trim() || 'property'; save(); renderProperties(page); };
    row.appendChild(key);

    var typeSel = document.createElement('select'); typeSel.className = 'prop-type-sel';
    typeSel.title = 'Property type';
    PROP_TYPES.forEach(function(t){
      var opt = document.createElement('option'); opt.value = t[0]; opt.textContent = t[1];
      if(prop.type === t[0]) opt.selected = true;
      typeSel.appendChild(opt);
    });
    typeSel.onchange = function(){
      prop.type = typeSel.value;
      if(prop.type === 'checkbox' && prop.value !== 'true' && prop.value !== 'false') prop.value = 'false';
      if(prop.type === 'rating' && !/^[0-5]$/.test(prop.value)) prop.value = '0';
      if(prop.type === 'formula' && prop.formula === undefined) prop.formula = '';
      save(); renderProperties(page);
    };
    row.appendChild(typeSel);

    if(prop.type === 'number'){
      var numInput = document.createElement('input'); numInput.type = 'number'; numInput.className = 'prop-val-input';
      numInput.value = prop.value; numInput.step = 'any';
      numInput.oninput = function(){ prop.value = numInput.value; save(); numFmtPreview.textContent = formatNumberForDisplay(prop.value, prop.numFormat); };
      numInput.onblur = function(){ renderProperties(page); };
      row.appendChild(numInput);
      var fmtSel = document.createElement('select'); fmtSel.className = 'prop-fmt-sel'; fmtSel.title = 'Number format';
      fmtSel.style.flex = '0 0 auto';
      [['plain','123'],['integer','123 (rounded)'],['currency','$123.00'],['percent','123%']].forEach(function(o){
        var opt = document.createElement('option'); opt.value = o[0]; opt.textContent = o[1];
        if((prop.numFormat || 'plain') === o[0]) opt.selected = true;
        fmtSel.appendChild(opt);
      });
      fmtSel.onchange = function(){ prop.numFormat = fmtSel.value; save(); renderProperties(page); };
      row.appendChild(fmtSel);
      var numFmtPreview = document.createElement('span'); numFmtPreview.className = 'prop-val'; numFmtPreview.style.cssText = 'flex:0 0 auto; color:var(--ink-soft);';
      numFmtPreview.textContent = (prop.numFormat && prop.numFormat !== 'plain') ? formatNumberForDisplay(prop.value, prop.numFormat) : '';
      row.appendChild(numFmtPreview);
    } else if(prop.type === 'rating'){
      row.appendChild(renderRatingStars(prop.value, function(v){ prop.value = String(v); save(); renderProperties(page); }));
    } else if(prop.type === 'formula'){
      row.style.flexWrap = 'wrap';
      var fxInput = document.createElement('input'); fxInput.type = 'text'; fxInput.className = 'prop-val-input';
      fxInput.placeholder = 'e.g. Price * Qty, or {Total Price} * 1.1';
      fxInput.value = prop.formula || '';
      fxInput.oninput = function(){
        prop.formula = fxInput.value;
        prop.value = computeFormulaValue(page, prop.formula);
        save();
        fxResult.textContent = '= ' + (prop.value || '—');
      };
      row.appendChild(fxInput);
      var fxResult = document.createElement('span'); fxResult.className = 'prop-val'; fxResult.style.color = 'var(--ink-soft)';
      fxResult.textContent = '= ' + (prop.value || '—');
      row.appendChild(fxResult);
    } else if(prop.type === 'date'){
      var dateInput = document.createElement('input'); dateInput.type = 'date'; dateInput.className = 'prop-val-input';
      dateInput.value = /^\d{4}-\d{2}-\d{2}$/.test(prop.value) ? prop.value : '';
      dateInput.onchange = function(){ prop.value = dateInput.value; save(); renderProperties(page); };
      row.appendChild(dateInput);
    } else if(prop.type === 'checkbox'){
      var cbWrap = document.createElement('span'); cbWrap.className = 'prop-val-checkbox';
      var cb = document.createElement('input'); cb.type = 'checkbox';
      cb.checked = prop.value === 'true';
      cb.onchange = function(){ prop.value = cb.checked ? 'true' : 'false'; save(); renderProperties(page); };
      cbWrap.appendChild(cb);
      row.appendChild(cbWrap);
    } else if(prop.type === 'select'){
      var selInput = document.createElement('input'); selInput.type = 'text'; selInput.className = 'prop-val-input';
      var selListId = 'proplist-sel-' + i;
      selInput.setAttribute('list', selListId);
      selInput.value = prop.value; selInput.placeholder = 'pick or type a value';
      selInput.oninput = function(){ prop.value = selInput.value; save(); };
      selInput.onblur = function(){ renderProperties(page); };
      row.appendChild(selInput);
      var selList = document.createElement('datalist'); selList.id = selListId;
      collectKnownPropValues(prop.key).forEach(function(v){
        var opt = document.createElement('option'); opt.value = v; selList.appendChild(opt);
      });
      row.appendChild(selList);
    } else if(prop.type === 'multiselect'){
      var chips = document.createElement('div'); chips.className = 'prop-chips';
      (prop.value || '').split(',').map(function(s){ return s.trim(); }).filter(Boolean).forEach(function(v){
        chips.appendChild(makeChip(v, 'prop-chip'));
      });
      chips.tabIndex = 0;
      chips.onclick = function(){
        var msListId = 'proplist-ms-' + i;
        var msInput = document.createElement('input'); msInput.type = 'text'; msInput.className = 'prop-val-input';
        msInput.setAttribute('list', msListId);
        msInput.value = prop.value; msInput.placeholder = 'comma-separated values';
        msInput.onblur = function(){ prop.value = msInput.value; save(); renderProperties(page); };
        var msList = document.createElement('datalist'); msList.id = msListId;
        collectKnownPropValueParts(prop.key).forEach(function(v){
          var opt = document.createElement('option'); opt.value = v; msList.appendChild(opt);
        });
        chips.replaceWith(msInput);
        row.appendChild(msList);
        msInput.focus();
      };
      row.appendChild(chips);
    } else if(prop.type === 'relation'){
      var relChips = document.createElement('div'); relChips.className = 'prop-chips';
      (prop.value || '').split(',').map(function(s){ return s.trim(); }).filter(Boolean).forEach(function(t){
        var chip = document.createElement('span'); chip.className = 'link prop-chip'; chip.dataset.target = t; chip.textContent = t;
        relChips.appendChild(chip);
      });
      relChips.tabIndex = 0;
      relChips.onclick = function(e){
        if(e.target !== relChips) return; /* a chip click navigates instead — see the delegated listener */
        var relListId = 'proplist-rel-' + i;
        var relInput = document.createElement('input'); relInput.type = 'text'; relInput.className = 'prop-val-input';
        relInput.setAttribute('list', relListId);
        relInput.value = prop.value; relInput.placeholder = 'comma-separated page names';
        relInput.onblur = function(){ prop.value = relInput.value; save(); renderProperties(page); };
        var relList = document.createElement('datalist'); relList.id = relListId;
        collectKnownPageTitles().forEach(function(t){ var opt = document.createElement('option'); opt.value = t; relList.appendChild(opt); });
        relChips.replaceWith(relInput);
        row.appendChild(relList);
        relInput.focus();
      };
      row.appendChild(relChips);
    } else if(prop.type === 'rollup'){
      row.style.flexWrap = 'wrap';
      var relKeys = (page.properties||[]).filter(function(pp){ return pp.type === 'relation'; }).map(function(pp){ return pp.key; });
      var viaSel = document.createElement('select'); viaSel.className = 'prop-val-input'; viaSel.style.flex = '0 1 auto';
      var viaNone = document.createElement('option'); viaNone.value = ''; viaNone.textContent = '(via a relation)'; viaSel.appendChild(viaNone);
      relKeys.forEach(function(k){
        var opt = document.createElement('option'); opt.value = k; opt.textContent = 'via ' + k;
        if(prop.relationKey === k) opt.selected = true;
        viaSel.appendChild(opt);
      });
      viaSel.onchange = function(){ prop.relationKey = viaSel.value; save(); renderProperties(page); };
      row.appendChild(viaSel);

      var relatedPages = getRelatedPagesForRelation(page, prop.relationKey);
      var targetKeys = {title:true};
      relatedPages.forEach(function(rp){ (rp.properties||[]).forEach(function(pp){ targetKeys[pp.key] = true; }); });
      var getSel = document.createElement('select'); getSel.className = 'prop-val-input'; getSel.style.flex = '0 1 auto';
      Object.keys(targetKeys).forEach(function(k){
        var opt = document.createElement('option'); opt.value = k; opt.textContent = 'get ' + k;
        if(prop.targetKey === k) opt.selected = true;
        getSel.appendChild(opt);
      });
      getSel.onchange = function(){ prop.targetKey = getSel.value; save(); renderProperties(page); };
      row.appendChild(getSel);

      var aggSel = document.createElement('select'); aggSel.className = 'prop-val-input'; aggSel.style.flex = '0 1 auto';
      [['list','as list'],['count','as count'],['sum','as sum'],['avg','as average'],['min','as min'],['max','as max']].forEach(function(o){
        var opt = document.createElement('option'); opt.value = o[0]; opt.textContent = o[1];
        if((prop.agg||'list') === o[0]) opt.selected = true;
        aggSel.appendChild(opt);
      });
      aggSel.onchange = function(){ prop.agg = aggSel.value; save(); renderProperties(page); };
      row.appendChild(aggSel);

      var computed = document.createElement('span'); computed.className = 'prop-val'; computed.style.color = 'var(--ink-soft)';
      computed.textContent = prop.value || '—';
      row.appendChild(computed);
    } else {
      var val = document.createElement('span'); val.className='prop-val'; val.contentEditable = page.locked ? 'false' : 'true';
      val.textContent = prop.value; val.spellcheck = (typeof currentSettings !== 'undefined' && currentSettings.spellcheck === 'off') ? false : true;
      val.onblur = function(){ prop.value = val.textContent; save(); renderProperties(page); };
      row.appendChild(val);
    }

    var del = document.createElement('button'); del.className='prop-del'; del.textContent='✕';
    del.title = 'Remove property';
    del.setAttribute('aria-label', 'Remove property "' + (prop.key || 'property') + '"');
    del.onclick = function(){ page.properties.splice(i,1); save(); renderProperties(page); };
    row.appendChild(del);
    wrap.appendChild(row);
  });
}

function renderOutline(page){
  var container = document.getElementById('outline');
  container.innerHTML = "";
  if(page.rootBlocks.length === 0){
    var id = uid();
    state.blocks[id] = mkBlock(id, page.id, null, "");
    page.rootBlocks.push(id);
  }
  renderZoomBreadcrumb(page);
  var rootIds = (zoomedBlockId && state.blocks[zoomedBlockId]) ? [zoomedBlockId] : page.rootBlocks;
  renderBlockList(rootIds, container);
}

/* ============================================================
   BLOCK ZOOM
   Clicking a bullet narrows the outline down to just that block
   and its descendants — a breadcrumb trail above the outline lets
   you climb back out to any ancestor or the page itself.
   ============================================================ */
function blockAncestors(blockId){
  var chain = [];
  var b = state.blocks[blockId];
  while(b && b.parent){
    b = state.blocks[b.parent];
    if(b) chain.unshift(b);
  }
  return chain;
}

function blockPreviewText(blk){
  var t = (blk.text || '').trim();
  if(!t) return '(empty block)';
  if(CODE_BLOCK_RE.test(t)) return '(code block)';
  var qMatch = t.match(QUERY_BLOCK_RE);
  if(qMatch){
    var qstr = qMatch[2].trim();
    return (qMatch[1].toLowerCase() === 'table' ? 'Database' : 'Query') + (qstr ? ': ' + qstr : '');
  }
  var plain = t
    .replace(/!\[\[[^\]]+\]\]/g, '(transcluded section/page)')
    .replace(/!\(\([a-zA-Z0-9_-]+\)\)/g, '(transcluded block)')
    .replace(/\{\{transclude:(?:page|block|section)\|[^}]+\}\}/g, '(transclusion)')
    .replace(/\(\([a-zA-Z0-9_-]+\)\)/g, '(embedded block)')
    .replace(/\{\{img:[^}]*\}\}/g, '(image)')
    .replace(/\{\{file:[^}]*\}\}/g, '(file)')
    .replace(TODO_RE, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/[*_~`#]/g, '');
  return plain.length > 60 ? plain.slice(0,60) + '…' : plain;
}

function zoomToBlock(blockId){
  if(!state.blocks[blockId]) return;
  zoomedBlockId = blockId;
  renderPage();
}

function zoomOut(){
  zoomedBlockId = null;
  renderPage();
}

function renderZoomBreadcrumb(page){
  var wrap = document.getElementById('zoom-breadcrumb');
  if(zoomedBlockId && (!state.blocks[zoomedBlockId] || state.blocks[zoomedBlockId].pageId !== page.id)){
    /* Stale: the zoomed block was deleted, or we've since navigated
       to a different page — either way, stop zooming. */
    zoomedBlockId = null;
  }
  if(!zoomedBlockId){
    wrap.classList.remove('visible');
    wrap.innerHTML = "";
    return;
  }
  wrap.classList.add('visible');
  wrap.innerHTML = "";

  var home = document.createElement('span');
  home.className = 'crumb';
  home.textContent = page.title;
  home.title = 'Back to the whole page';
  home.onclick = function(){ zoomOut(); };
  wrap.appendChild(home);

  blockAncestors(zoomedBlockId).forEach(function(anc){
    var sep = document.createElement('span'); sep.className = 'crumb-sep'; sep.textContent = '›';
    wrap.appendChild(sep);
    var c = document.createElement('span');
    c.className = 'crumb';
    c.textContent = blockPreviewText(anc);
    c.onclick = function(){ zoomToBlock(anc.id); };
    wrap.appendChild(c);
  });

  var sep2 = document.createElement('span'); sep2.className = 'crumb-sep'; sep2.textContent = '›';
  wrap.appendChild(sep2);
  var current = document.createElement('span');
  current.className = 'crumb crumb-current';
  current.textContent = blockPreviewText(state.blocks[zoomedBlockId]);
  wrap.appendChild(current);
}

/* ============================================================
   WORD / CHARACTER COUNT
   Recomputed from the same committed state the outline renders
   from, plus (optionally) whatever's live in the block someone is
   actively typing in, so the count updates as you type rather than
   only after you click away.
   ============================================================ */
function textForWordCount(text){
  if(!text) return '';
  var codeMatch = text.match(CODE_BLOCK_RE);
  if(codeMatch) return codeMatch[2] || '';
  if(QUERY_BLOCK_RE.test(text.trim())) return ''; /* queries/databases aren't authored prose */
  return text
    .replace(/!\[\[[^\]]+\]\]/g, '')                  /* page/section transclusions */
    .replace(/!\(\([a-zA-Z0-9_-]+\)\)/g, '')             /* block transclusions */
    .replace(/\{\{transclude:(?:page|block|section)\|[^}]+\}\}/g, '') /* explicit transclusions */
    .replace(/\(\([a-zA-Z0-9_-]+\)\)/g, '')             /* block refs — counted at their source */
    .replace(/\{\{img:[^}]*\}\}/g, '')                  /* image embeds */
    .replace(/\{\{file:[^}]*\}\}/g, '')                 /* file embeds */
    .replace(/\[\[([^\]]+)\]\]/g, '$1')                 /* page links — keep the visible text */
    .replace(/[*_~`#]/g, '');                           /* strip leftover markdown punctuation */
}

function countWordsPage(page, liveBlockId, liveText){
  var words = 0, chars = 0;
  function walk(ids){
    ids.forEach(function(id){
      var blk = state.blocks[id];
      if(!blk) return;
      var raw = (id === liveBlockId) ? liveText : blk.text;
      var text = textForWordCount(raw);
      if(text){
        chars += text.length;
        var w = text.trim().split(/\s+/).filter(Boolean);
        words += w.length;
      }
      walk(blk.children);
    });
  }
  walk(page.rootBlocks);
  return {words:words, chars:chars};
}

function renderWordCount(page, liveBlockId, liveText){
  var el = document.getElementById('word-count');
  if(!el) return;
  var counts = countWordsPage(page, liveBlockId, liveText);
  el.textContent = counts.words.toLocaleString() + (counts.words === 1 ? ' word' : ' words') +
    ' · ' + counts.chars.toLocaleString() + (counts.chars === 1 ? ' character' : ' characters');
}

function renderBlockList(ids, container){
  var foldUntilLevel = null; /* set while a collapsed heading is folding away its following siblings */
  ids.forEach(function(id){
    var block = state.blocks[id];
    if(!block) return;
    var hInfo = headingInfo(block.text || '');
    if(foldUntilLevel !== null){
      if(hInfo && hInfo.level <= foldUntilLevel){
        foldUntilLevel = null; /* an equal-or-shallower heading ends the fold */
      } else {
        return; /* still inside a collapsed section — skip this sibling entirely */
      }
    }
    container.appendChild(renderBlockRow(block));
    if(block.children.length){
      var childWrap = document.createElement('div');
      childWrap.className = 'block-children';
      if(block.collapsed) childWrap.style.display = 'none';
      renderBlockList(block.children, childWrap);
      container.appendChild(childWrap);
    }
    if(hInfo && block.collapsed) foldUntilLevel = hInfo.level;
  });
}

function renderBlockRow(block){
  var row = document.createElement('div');
  row.className = 'block-row';
  row.dataset.id = block.id;
  var rowLocked = blockIsLocked(block);
  if(rowLocked) row.classList.add('is-locked');

  var dragHandle = document.createElement('div');
  dragHandle.className = 'drag-handle';
  dragHandle.title = 'Drag to move this line';
  dragHandle.textContent = '⠿';
  dragHandle.draggable = !rowLocked;
  if(rowLocked) dragHandle.title = 'Locked — unlock this line to move it';
  dragHandle.addEventListener('dragstart', function(e){
    dragBlockId = block.id;
    if(editingBlockId === block.id){
      var editingEl = document.querySelector('.block-content.editing');
      if(editingEl) block.text = serializeInline(editingEl);
    }
    e.dataTransfer.effectAllowed = 'move';
    try{ e.dataTransfer.setData('text/plain', block.id); }catch(err){}
    setTimeout(function(){ row.classList.add('dragging'); }, 0);
  });
  dragHandle.addEventListener('dragend', function(){
    row.classList.remove('dragging');
    dragBlockId = null;
    document.querySelectorAll('.drag-over-before,.drag-over-after,.drag-over-child').forEach(function(el){
      el.classList.remove('drag-over-before','drag-over-after','drag-over-child');
    });
  });
  row.appendChild(dragHandle);

  row.addEventListener('dragover', function(e){
    if(!dragBlockId || dragBlockId === block.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    var rect = row.getBoundingClientRect();
    var y = e.clientY - rect.top;
    var pos = y < rect.height * 0.25 ? 'before' : (y > rect.height * 0.75 ? 'after' : 'child');
    row.classList.remove('drag-over-before','drag-over-after','drag-over-child');
    row.classList.add('drag-over-' + pos);
    row.dataset.dropPos = pos;
  });
  row.addEventListener('dragleave', function(){
    row.classList.remove('drag-over-before','drag-over-after','drag-over-child');
  });
  row.addEventListener('drop', function(e){
    e.preventDefault();
    row.classList.remove('drag-over-before','drag-over-after','drag-over-child');
    var srcId = dragBlockId;
    var pos = row.dataset.dropPos || 'after';
    dragBlockId = null;
    if(!srcId || srcId === block.id) return;
    if(moveBlockRelative(srcId, block.id, pos)){ save(); renderPage(); }
  });

  var bulletWrap = document.createElement('div');
  bulletWrap.className = 'bullet-wrap';
  var rowHeadingInfo = headingInfo(block.text || '');
  if(block.children.length || rowHeadingInfo){
    var tri = document.createElement('span');
    tri.className = 'collapse-tri' + (block.collapsed ? ' collapsed' : '');
    tri.textContent = '▾';
    tri.title = block.collapsed
      ? (rowHeadingInfo ? 'Expand this section' : 'Expand')
      : (rowHeadingInfo ? 'Collapse this section' : 'Collapse');
    tri.onclick = function(e){ e.stopPropagation(); block.collapsed = !block.collapsed; save(); renderPage(); };
    bulletWrap.appendChild(tri);
  }
  var dot = document.createElement('span');
  dot.className = 'bullet' + (block.children.length ? ' has-children' : '');
  dot.title = 'Click to zoom in on this line';
  dot.onclick = function(e){ e.stopPropagation(); zoomToBlock(block.id); };
  bulletWrap.appendChild(dot);
  row.appendChild(bulletWrap);

  if(rowLocked){
    var lockFlag = document.createElement('span');
    lockFlag.className = 'block-lock-flag';
    lockFlag.textContent = '🔒';
    lockFlag.title = block.locked
      ? 'This line is locked — click to unlock'
      : (pageIsLocked(block.pageId)
          ? 'This page is locked, so this line is read-only'
          : 'A line above this one is locked, so this one is read-only');
    if(block.locked) lockFlag.onclick = function(e){ e.stopPropagation(); toggleBlockLock(block.id); };
    row.appendChild(lockFlag);
  }

  var syncCount = findBlockRefsTo(block.id).length;
  if(syncCount > 0){
    var badge = document.createElement('span');
    badge.className = 'blockref-badge';
    badge.textContent = syncCount;
    badge.title = 'Synced with ' + syncCount + ' other place' + (syncCount === 1 ? '' : 's') + ' — editing this line updates all of them.';
    row.appendChild(badge);
  }

  if(block.conflict){
    row.classList.add('has-conflict');
    var flag = document.createElement('span');
    flag.className = 'block-conflict-flag';
    flag.textContent = '⚠';
    flag.title = 'This line conflicted during sync — an edit from another device was dropped in favor of a newer one. Click to view both.';
    flag.onclick = function(e){ e.stopPropagation(); openConflicts(); };
    row.appendChild(flag);
  }

  var content = document.createElement('div');
  content.className = 'block-content';
  content.tabIndex = 0;
  content.spellcheck = (typeof currentSettings !== 'undefined' && currentSettings.spellcheck === 'off') ? false : true;

  function enterEditMode(focusOffset){
    /* One gate for every way into edit mode (click, keyboard nav,
       focusBlock, the "Edit" menu item) — see blockIsLocked. */
    if(blockIsLocked(block)){ lockedNudge(block); return; }
    if(editingBlockId && editingBlockId !== block.id){
      var prevEl = document.querySelector('.block-content.editing');
      if(prevEl) commitEdit(prevEl);
    }
    editingBlockId = block.id;
    dockBlockId = block.id;
    updateEditDock();
    content.contentEditable = 'true';
    content.classList.add('editing');
    content.innerHTML = "";
    if(CODE_BLOCK_RE.test(block.text)){
      /* Fenced code shouldn't run through inline markdown parsing —
         the triple backticks collide with the single-backtick inline
         `code` rule, and nothing inside a code fence should turn into
         bold/italic/links anyway. Edit it as plain text. */
      content.appendChild(document.createTextNode(block.text));
    } else {
      content.appendChild(buildInlineNodes(block.text));
    }
    content.focus();
    var endOffset = content.textContent.length;
    setCaretOffset(content, typeof focusOffset === 'number' ? focusOffset : endOffset);
  }

  function commitEdit(el){
    var b = state.blocks[row.dataset.id];
    if(!b) return;
    b.text = serializeInline(el);
    el.contentEditable = 'false';
    el.classList.remove('editing');
    el.innerHTML = decorateText(b.text);
    editingBlockId = null;
    save();
    renderSidebar(document.getElementById('search-box').value);
  }

  if(block.id === editingBlockId && !blockIsLocked(block)){
    content.contentEditable = 'true';
    content.classList.add('editing');
    if(CODE_BLOCK_RE.test(block.text)){
      content.appendChild(document.createTextNode(block.text));
    } else {
      content.appendChild(buildInlineNodes(block.text));
    }
  } else {
    content.contentEditable = 'false';
    var qMatch = block.text && block.text.trim().match(QUERY_BLOCK_RE);
    var codeMatch = block.text && block.text.match(CODE_BLOCK_RE);
    var todo = !qMatch && !codeMatch && todoInfo(block.text || '');
    if(qMatch){
      renderQueryWidget(content, qMatch[1].toLowerCase(), qMatch[2].trim(), block.id);
    } else if(codeMatch){
      renderCodeBlockWidget(content, codeMatch[1], codeMatch[2]);
    } else if(todo){
      content.innerHTML = '';
      var todoRow = document.createElement('label');
      todoRow.className = 'todo-row';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'todo-checkbox';
      cb.checked = todo.done;
      var dueParts = splitTodoDue(todo.rest);
      var todoText = document.createElement('span');
      todoText.className = 'todo-text' + (todo.done ? ' todo-done-text' : '');
      todoText.innerHTML = decorateText(dueParts.clean);
      cb.disabled = rowLocked;
      cb.addEventListener('click', function(e){
        e.stopPropagation();
        if(rowLocked){ e.preventDefault(); lockedNudge(block); return; }
        var cur = todoInfo(block.text || '');
        var rest = cur ? cur.rest : '';
        block.text = '[' + (cb.checked ? 'x' : ' ') + '] ' + rest;
        todoText.innerHTML = decorateText(splitTodoDue(rest).clean);
        todoText.classList.toggle('todo-done-text', cb.checked);
        save();
        renderSidebar(document.getElementById('search-box').value);
      });
      todoRow.appendChild(cb);
      todoRow.appendChild(todoText);

      if(dueParts.due){
        var dueChip = document.createElement('button');
        dueChip.type = 'button';
        dueChip.className = 'todo-due-chip ' + todoDueStatus(dueParts.due);
        dueChip.textContent = '📅 ' + formatTodoDue(dueParts.due);
        dueChip.title = 'Due ' + dueParts.due + ' — click to change';
        dueChip.addEventListener('click', function(e){
          e.stopPropagation();
          openTodoDuePopover(dueChip, block, dueParts.due);
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
          openTodoDuePopover(addDueBtn, block, null);
        });
        todoRow.appendChild(addDueBtn);
      }
      content.appendChild(todoRow);
    } else if(!qMatch && !codeMatch && headingInfo(block.text || '')){
      var hInfo = headingInfo(block.text || '');
      var hSpan = document.createElement('span');
      hSpan.className = 'block-heading level-' + hInfo.level;
      hSpan.innerHTML = decorateText(hInfo.rest);
      content.innerHTML = '';
      content.appendChild(hSpan);
    } else {
      content.innerHTML = decorateText(block.text);
    }
  }

  content.addEventListener('click', function(e){
    if(content.contentEditable === 'true') return;
    var t = e.target;
    if(t.classList && t.classList.contains('link')){
      openPageByTitle(t.dataset.target, 'page');
      return;
    }
    if(t.classList && t.classList.contains('tag')){
      openPageByTitle(t.dataset.tag, 'tag');
      return;
    }
    var txEl = t.classList && t.classList.contains('transclusion') ? t : (t.closest ? t.closest('.transclusion') : null);
    if(txEl){
      var txRaw = txEl.dataset.transclusionRaw || '';
      if(txRaw.indexOf('!((') === 0){
        var txm = txRaw.match(/^!\(\(([a-zA-Z0-9_-]+)\)\)$/);
        var txb = txm ? state.blocks[txm[1]] : null;
        if(txb && state.pages[txb.pageId]) openPage(txb.pageId);
      } else {
        var txTarget = '';
        var txPage = txRaw.match(/^!\[\[([^\]]+)\]\]$/);
        var txExplicit = txRaw.match(/^\{\{transclude:(?:page|section)\|([^}]+)\}\}$/);
        txTarget = txPage ? txPage[1] : (txExplicit ? txExplicit[1] : '');
        var parsedTx = parseTransclusionTarget(txTarget, state.currentPageId);
        var txp = parsedTx.page ? findPageByTitle(parsedTx.page) : null;
        if(txp) openPage(txp.id);
      }
      return;
    }
    var refEl = t.classList && t.classList.contains('blockref') ? t : (t.closest ? t.closest('.blockref') : null);
    if(refEl){
      var refBlk = state.blocks[refEl.dataset.refid];
      if(refBlk && state.pages[refBlk.pageId]) openPage(refBlk.pageId);
      return;
    }
    var dlBtn = t.closest ? t.closest('.att-dl-btn') : null;
    if(dlBtn){
      var attWrap = dlBtn.closest('.att-img, .att-file');
      if(attWrap) downloadAttachment(attWrap.dataset.attId, attWrap.dataset.attName);
      return;
    }
    var fileLink = t.closest ? t.closest('.att-file-link') : null;
    if(fileLink){
      if((fileLink.closest('.att-missing')) || fileLink.href.endsWith('#')) e.preventDefault();
      return; /* let the browser's normal <a> open/download behavior run */
    }
    var imgHit = t.closest ? t.closest('.att-img-el') : null;
    if(imgHit){
      if(imgHit.src && !imgHit.src.endsWith('#')) window.open(imgHit.src, '_blank');
      return;
    }
    if(t.classList && t.classList.contains('qb-raw-edit')){
      enterEditMode(0);
      return;
    }
    var qbClickMatch = block.text && block.text.trim().match(QUERY_BLOCK_RE);
    if(qbClickMatch){
      openQueryBuilder(qbClickMatch[1].toLowerCase(), block.id, qbClickMatch[2].trim());
      return;
    }
    /* Land the caret where the user actually tapped/clicked, rather
       than at the start (or, as this used to do, selecting the whole
       line — see below). caretRangeFromPoint only makes sense against
       the DOM as it is right now (read-mode markup), and enterEditMode
       is about to tear that DOM down and rebuild it for editing, so
       the raw-text offset has to be captured *before* that happens;
       afterwards there'd be nothing left to measure against. */
    var range = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
    if(!range && document.caretPositionFromPoint){
      /* Firefox (desktop and Android) only has the standardized name. */
      var cp = document.caretPositionFromPoint(e.clientX, e.clientY);
      if(cp && cp.offsetNode){
        try{ range = document.createRange(); range.setStart(cp.offsetNode, cp.offset); range.collapse(true); }
        catch(err){ range = null; }
      }
    }
    var clickOffset = null;
    if(range){
      try{
        var probeSel = window.getSelection();
        probeSel.removeAllRanges();
        probeSel.addRange(range);
        clickOffset = getCaretOffset(content);
      }catch(err){ clickOffset = null; }
    }
    enterEditMode(clickOffset !== null ? clickOffset : 0);
  });

  content.addEventListener('blur', function(){
    if(content.contentEditable === 'true') commitEdit(content);
  });

  content.addEventListener('input', function(){
    autoFormatAtCaret(content);
    if(typeof scheduleEditAutosave === 'function') scheduleEditAutosave();
    var page = state.pages[block.pageId];
    if(page) renderWordCount(page, block.id, content.textContent);
  });

  /* Enter (split the line at the caret) and Backspace-at-the-start
     (merge into the line above) live in named functions because two
     different events can trigger them: the keydown handler below, and
     the beforeinput handler after it. Phone keyboards frequently send
     keydown with key "Unidentified"/keyCode 229 for these keys (Android
     Gboard especially), so keydown alone silently does nothing there;
     beforeinput's inputType is reliable everywhere. On a desktop
     keyboard keydown calls preventDefault first, so beforeinput never
     fires and nothing runs twice. */
  function splitBlockAtCaret(b){
    var sel = window.getSelection();
    if(!sel.rangeCount) return;
    var range = sel.getRangeAt(0);
    var afterRange = range.cloneRange();
    afterRange.selectNodeContents(content);
    afterRange.setStart(range.endContainer, range.endOffset);
    var afterFrag = afterRange.extractContents();
    var afterText = serializeInline(afterFrag);
    var nb;
    if(b.id === zoomedBlockId){
      /* Splitting the block you're currently zoomed into would
         normally create a sibling outside the zoomed view, where
         it'd immediately vanish from sight — make it a first
         child instead, right where the new line visually lands. */
      var nid = uid();
      nb = mkBlock(nid, b.pageId, b.id, afterText);
      state.blocks[nid] = nb;
      b.children.unshift(nid);
    } else {
      nb = createBlockAfter(b, afterText);
    }
    commitEdit(content);
    save(); renderPage();
    focusBlock(nb.id, 0);
  }
  function mergeBlockUpAtStart(b){
    b.text = serializeInline(content);
    var res = deleteBlockMergeUp(b);
    save(); renderPage();
    if(res) focusBlock(res.focusId, res.offset);
  }

  content.addEventListener('beforeinput', function(e){
    if(!e.cancelable || content.contentEditable !== 'true') return;
    var b = state.blocks[row.dataset.id];
    if(!b) return;
    if(e.inputType === 'insertParagraph'){
      e.preventDefault();
      if(CODE_BLOCK_RE.test(b.text)) document.execCommand('insertLineBreak');
      else splitBlockAtCaret(b);
    } else if(e.inputType === 'deleteContentBackward'){
      var bsel = window.getSelection();
      if(bsel.isCollapsed && getCaretOffset(content) === 0){
        e.preventDefault();
        mergeBlockUpAtStart(b);
      }
    }
  });

  content.addEventListener('keydown', function(e){
    var b = state.blocks[row.dataset.id];
    var isMod = e.metaKey || e.ctrlKey;
    if(e.key === 'Enter' && !e.shiftKey && CODE_BLOCK_RE.test(b.text)){
      /* Inside a fenced code block, Enter should add a line to the
         code, not split into a new block — that's what Shift+Enter
         is for everywhere else in the app. */
      e.preventDefault();
      document.execCommand('insertLineBreak');
    } else if(e.key === 'Enter' && !e.shiftKey){
      e.preventDefault();
      splitBlockAtCaret(b);
    } else if(isMod && (e.key === 'b' || e.key === 'B')){
      e.preventDefault(); e.stopPropagation();
      applyInlineFormat(content, 'strong');
    } else if(isMod && (e.key === 'i' || e.key === 'I')){
      e.preventDefault(); e.stopPropagation();
      applyInlineFormat(content, 'em');
    } else if(isMod && (e.key === 'e' || e.key === 'E')){
      e.preventDefault(); e.stopPropagation();
      applyInlineFormat(content, 'code');
    } else if(isMod && e.shiftKey && (e.key === 'x' || e.key === 'X')){
      e.preventDefault(); e.stopPropagation();
      applyInlineFormat(content, 'del');
    } else if(e.key === 'Tab'){
      e.preventDefault();
      b.text = serializeInline(content);
      var off = getCaretOffset(content);
      if(e.shiftKey){ outdentBlock(b); } else { indentBlock(b); }
      save(); renderPage();
      focusBlock(b.id, off);
    } else if(e.key === 'Backspace'){
      var off2 = getCaretOffset(content);
      var hasSel = !window.getSelection().isCollapsed;
      if(off2 === 0 && !hasSel){
        e.preventDefault();
        mergeBlockUpAtStart(b);
      }
    } else if(e.key === 'ArrowUp' || e.key === 'ArrowDown'){
      var flat = flattenVisible(b.pageId);
      var idx = flat.findIndex(function(x){ return x.id === b.id; });
      if(idx !== -1){
        var target = e.key === 'ArrowUp' ? flat[idx-1] : flat[idx+1];
        if(target){
          e.preventDefault();
          var curOff = getCaretOffset(content);
          commitEdit(content);
          save(); renderPage();
          focusBlock(target.id, curOff);
        }
      }
    } else if((e.key === 'k' || e.key==='K') && isMod){
      e.preventDefault();
      commitEdit(content);
      openPalette();
    }
  });

  if(block.id === editingBlockId){
    var editLen = content.textContent.length;
    setTimeout(function(){ content.focus(); setCaretOffset(content, editLen); }, 0);
  }

  /* The five per-row actions (outdent/indent/ref/todo/heading) live
     behind a single "⋯" trigger now — see openBlockMenu — instead of
     five always-hoverable buttons competing for row width. */
  var controls = document.createElement('div');
  controls.className = 'block-controls';
  var menuBtn = document.createElement('button');
  menuBtn.className = 'block-menu-btn';
  menuBtn.textContent = '⋯';
  menuBtn.title = 'More actions (outdent, indent, collapse, cut, copy, paste, duplicate, zoom, block reference, to-do, heading) — right-clicking the line opens the same menu';
  menuBtn.onclick = function(e){
    e.stopPropagation();
    if(editingBlockId === block.id) commitEdit(content);
    openBlockMenu(menuBtn, block.id);
  };
  controls.appendChild(menuBtn);

  row.appendChild(content);
  row.appendChild(controls);
  return row;
}

/* ---------- Block row "more actions" menu ----------
   Builds the outdent/indent/ref/todo/heading action list on demand from
   current block state (so it always reflects the latest text/position,
   even though the button that opened it is shared) and shows it as a
   small dropdown anchored under the "⋯" trigger. Mirrors the
   open/outside-click/Escape pattern used by openTodoDuePopover. */
var blockMenuCleanup = null;
var blockMenuAnchor = null;
function closeBlockMenu(){
  var existing = document.querySelector('.block-menu-dropdown');
  if(existing) existing.remove();
  if(blockMenuCleanup){
    blockMenuCleanup();
    blockMenuCleanup = null;
  }
}
function openBlockMenu(anchorEl, blockId, coords){
  var wasOpenForThisAnchor = !coords && !!document.querySelector('.block-menu-dropdown') && blockMenuAnchor === anchorEl;
  closeBlockMenu();
  if(wasOpenForThisAnchor) return; /* clicking the trigger again just toggles it shut */
  var b = state.blocks[blockId];
  if(!b) return;
  blockMenuAnchor = anchorEl;

  var menu = document.createElement('div');
  menu.className = 'block-menu-dropdown';

  function addItem(icon, label, disabled, onClick){
    var item = document.createElement('button');
    item.type = 'button';
    item.className = 'block-menu-item';
    item.disabled = !!disabled;
    var iconSpan = document.createElement('span');
    iconSpan.className = 'bmi-icon';
    iconSpan.textContent = icon;
    var labelSpan = document.createElement('span');
    labelSpan.textContent = label;
    item.appendChild(iconSpan);
    item.appendChild(labelSpan);
    if(!disabled){
      item.onclick = function(e){
        e.stopPropagation();
        closeBlockMenu();
        onClick();
      };
    }
    menu.appendChild(item);
    return item;
  }
  function addDivider(){
    var d = document.createElement('div');
    d.className = 'block-menu-divider';
    menu.appendChild(d);
  }

  /* Locked lines keep the read-only actions (copy, reference, zoom,
     collapse) and lose the ones that would change text or position —
     same list the right-click menu shows, since both open this. */
  var locked = blockIsLocked(b);
  var byAncestor = blockLockedByAncestor(b);

  addItem('✎', 'Edit this line', locked, function(){
    var row = document.querySelector('.block-row[data-id="' + blockId + '"]');
    var el = row ? row.querySelector('.block-content') : null;
    if(el) el.click(); /* the row's own click handler is what opens edit mode */
  });
  if(byAncestor){
    addItem('🔒', 'Locked from above', true, function(){});
  } else {
    addItem(b.locked ? '🔓' : '🔒',
      b.locked ? 'Unlock this line' : 'Lock this line',
      pageIsLocked(b.pageId),
      function(){ toggleBlockLock(blockId); });
  }
  addDivider();

  addItem('←', 'Outdent', locked || !b.parent, function(){ doOutdent(b); });
  addItem('→', 'Indent', locked || indexInSiblings(b) <= 0, function(){ doIndent(b); });
  addItem('↑', 'Move up', locked || !canMoveBlockStep(b, -1), function(){ doMoveBlock(b, -1); });
  addItem('↓', 'Move down', locked || !canMoveBlockStep(b, 1), function(){ doMoveBlock(b, 1); });
  var canToggleCollapse = !!(b.children.length || headingInfo(b.text || ''));
  var isHeadingForToggle = !!headingInfo(b.text || '');
  addItem(b.collapsed ? '▸' : '▾',
    b.collapsed ? (isHeadingForToggle ? 'Expand this section' : 'Expand') : (isHeadingForToggle ? 'Collapse this section' : 'Collapse'),
    !canToggleCollapse,
    function(){
      var cb = state.blocks[blockId];
      if(!cb) return;
      cb.collapsed = !cb.collapsed;
      save(); renderPage();
    });
  addDivider();
  addItem('X', 'Cut', locked, function(){
    var cb = state.blocks[blockId];
    if(!cb) return;
    blockClipboard = cloneBlockSubtree(cb);
    copyToClipboard(blockClipboardToText(blockClipboard));
    var landAfter = removeBlockSubtree(cb);
    save(); renderPage();
    if(landAfter) focusBlock(landAfter.focusId, landAfter.offset);
    toast('Cut — use Paste on any line to drop it back in.');
  });
  addItem('C', 'Copy', false, function(){
    var cb = state.blocks[blockId];
    if(!cb) return;
    blockClipboard = cloneBlockSubtree(cb);
    copyToClipboard(blockClipboardToText(blockClipboard));
    toast('Copied — use Paste on any line to drop it in.');
  });
  addItem('P', 'Paste', locked || !blockClipboard, function(){
    var cb = state.blocks[blockId];
    if(!cb || !blockClipboard) return;
    var pasted = insertSubtreeAfter(blockClipboard, cb);
    save(); renderPage();
    focusBlock(pasted.id, (pasted.text || '').length);
  });
  addItem('⧉', 'Duplicate', locked, function(){
    var cb = state.blocks[blockId];
    if(!cb) return;
    var copy = insertSubtreeAfter(cloneBlockSubtree(cb), cb);
    save(); renderPage();
    focusBlock(copy.id, (copy.text || '').length);
  });
  addItem('⤢', 'Zoom in on this line', false, function(){
    zoomToBlock(blockId);
  });
  addItem('⚭', 'Copy block reference', false, function(){
    copyToClipboard('((' + b.id + '))');
    toast('Block reference copied — paste it anywhere to sync this line.');
  });
  addItem('↳', 'Copy block transclusion', false, function(){
    copyToClipboard('!((' + b.id + '))');
    toast('Copied block transclusion — paste it anywhere to embed this block live.');
  });
  addItem('🗑', 'Delete', locked, function(){
    var cb = state.blocks[blockId];
    if(!cb) return;
    var hasChildren = !!cb.children.length;
    var confirmOn = typeof currentSettings !== 'undefined' && currentSettings.confirmTrash === 'on';
    if(hasChildren || confirmOn){
      var msg = hasChildren
        ? 'Delete this block and everything nested under it? This can\'t be undone from here — use Undo (Ctrl+Z) right after if you change your mind.'
        : 'Delete this block? Use Undo (Ctrl+Z) right after if you change your mind.';
      if(!confirm(msg)) return;
    }
    var landAfter = removeBlockSubtree(cb);
    save(); renderPage();
    if(landAfter) focusBlock(landAfter.focusId, landAfter.offset);
    toast('Block deleted.');
  });
  addDivider();
  var isTodoNow = !!todoInfo(b.text || '');
  addItem(isTodoNow ? '☑' : '☐', isTodoNow ? 'Remove checkbox' : 'Turn into a to-do', locked, function(){
    var cb = state.blocks[blockId];
    if(!cb) return;
    var cur = todoInfo(cb.text || '');
    cb.text = cur ? cur.rest : ('[ ] ' + (cb.text || ''));
    save(); renderPage();
  });
  var curHeadingInfo = headingInfo(b.text || '');
  var headingLabel = curHeadingInfo
    ? (curHeadingInfo.level < 3 ? 'Make H' + (curHeadingInfo.level + 1) + ' heading' : 'Remove heading')
    : 'Make H1 heading';
  addItem(curHeadingInfo ? ('H' + curHeadingInfo.level) : 'H', headingLabel, locked, function(){
    var cb = state.blocks[blockId];
    if(!cb) return;
    cb.text = cycleHeadingText(cb.text || '');
    save(); renderPage();
  });

  function onOutsideClick(e){
    if(!menu.contains(e.target) && e.target !== anchorEl){
      closeBlockMenu();
    }
  }
  function onEscKey(e){
    if(e.key === 'Escape') closeBlockMenu();
  }
  /* Attach listeners before any synchronous close can occur, same
     reasoning as openTodoDuePopover. */
  document.addEventListener('mousedown', onOutsideClick);
  document.addEventListener('keydown', onEscKey);
  blockMenuCleanup = function(){
    document.removeEventListener('mousedown', onOutsideClick);
    document.removeEventListener('keydown', onEscKey);
    blockMenuAnchor = null;
  };

  document.body.appendChild(menu);
  /* This menu has ~20 rows; on a short phone screen (or with the
     keyboard up) that's taller than what's visible, and a fixed-position
     menu that overflows can't be scrolled to its bottom rows. Cap its
     height to the visible area and let it scroll inside. */
  var menuVp = usableViewport();
  var menuMaxH = menuVp.bottom - menuVp.top - 16;
  if(menu.offsetHeight > menuMaxH){
    menu.style.maxHeight = Math.max(160, menuMaxH) + 'px';
    menu.style.overflowY = 'auto';
    menu.style.overscrollBehavior = 'contain';
  }
  /* `coords` (set when this menu was opened by a right-click rather
     than by the "⋯" button) pins the menu to the pointer instead of
     under the trigger — the anchor element is still used for the
     outside-click check either way. */
  if(coords){
    var cLeft = Math.min(coords.x, Math.max(8, window.innerWidth - menu.offsetWidth - 8));
    var cTop = coords.y;
    var cBottom = usableViewport().bottom;
    if(cTop + menu.offsetHeight > cBottom - 8){
      cTop = Math.max(8, coords.y - menu.offsetHeight);
    }
    if(cTop + menu.offsetHeight > menuVp.bottom - 8) cTop = Math.max(menuVp.top + 8, menuVp.bottom - 8 - menu.offsetHeight);
    menu.style.top = cTop + 'px';
    menu.style.left = Math.max(8, cLeft) + 'px';
    return;
  }
  var rect = anchorEl.getBoundingClientRect();
  var left = rect.right - menu.offsetWidth;
  if(left < 8) left = 8;
  var maxLeft = window.innerWidth - menu.offsetWidth - 8;
  if(left > maxLeft) left = Math.max(8, maxLeft);
  var top = rect.bottom + 4;
  var maxTop = usableViewport().bottom - menu.offsetHeight - 8;
  if(top > maxTop) top = Math.max(8, rect.top - menu.offsetHeight - 4);
  if(top + menu.offsetHeight > menuVp.bottom - 8) top = Math.max(menuVp.top + 8, menuVp.bottom - 8 - menu.offsetHeight);
  menu.style.top = top + 'px';
  menu.style.left = left + 'px';
}

function focusBlock(blockId, offset){
  /* Keyboard navigation and every "…then put the caret here" call
     land here, so a locked line has to be refused at this level too
     rather than only on click. */
  if(blockIsLocked(state.blocks[blockId])){
    editingBlockId = null;
    renderPage();
    lockedNudge(state.blocks[blockId]);
    return;
  }
  editingBlockId = blockId;
  dockBlockId = blockId;
  renderPage();
  function placeCaret(){
    var row = document.querySelector('.block-row[data-id="'+blockId+'"]');
    if(row){
      var el = row.querySelector('.block-content');
      if(el){ el.focus(); setCaretOffset(el, offset); }
    }
  }
  /* Focus synchronously first, then again on the next tick. The
     synchronous call matters on iOS: Safari only keeps the on-screen
     keyboard up when the new field is focused inside the same event
     that removed the old one — deferring it (as this used to, via
     setTimeout alone) makes the keyboard drop every time Enter, a
     dock button, or a menu action re-renders the page. The deferred
     call stays as a backstop for anything that settles later. */
  placeCaret();
  setTimeout(placeCaret, 0);
}

