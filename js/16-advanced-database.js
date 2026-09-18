/* ============================================================
 * 16-advanced-database.js
 * "Advance database" pass — extends the existing {{table:}} database
 * views (js/01-query-engine.js) and page-property system
 * (js/04-render-page.js) with:
 *
 *   1. Formulas — a new "formula" property type, computed from other
 *      properties on the same page with a small safe expression
 *      evaluator (no eval/Function — a hand-rolled tokenizer/parser).
 *   2. Aggregates — a footer row on table-view databases showing
 *      Count/Sum/Average/Min/Max per column, chosen per column and
 *      persisted as an `agg:key=fn,...` directive alongside the
 *      existing view/sort/group/cols ones.
 *   3. Richer property types — "rating" (1–5 stars) plus a display
 *      format for "number" (plain/integer/currency/percent), and
 *      deterministic colored chips for select/multi-select values
 *      everywhere they're shown.
 *   4. Multiple saved views per database — a tab bar above a
 *      {{table:}} embed so one database (one set of filters) can have
 *      several views (a Table and a Board, say) without duplicating
 *      the block. Stored as plain fields on the block object
 *      (`block.dbViews`, `block.dbActiveViewId`), the same pattern
 *      js/13a-locks-and-sidebar.js used for page/block locks — older
 *      builds and sync peers that don't know about them just ignore
 *      them.
 *   5. Inline cell editing — table/board/gallery cells are now live
 *      editors (checkbox, stars, date picker, select/multi-select
 *      with autocomplete, relation, number, text) instead of plain
 *      text, so editing a database no longer requires opening the
 *      page or the raw filter text.
 *
 * Loaded as a plain <script>, after 15-task-manager.js and before
 * 14-wiring-and-init.js (which boots the app) — same shared global
 * scope as every other file, so it both defines new globals used by
 * 01-query-engine.js/04-render-page.js and freely calls helpers
 * (state, save, renderPage, livePages, collectKnown*, uid, etc.)
 * declared in those earlier-loaded files.
 * ============================================================ */
"use strict";

/* ============================================================
   SHARED PROPERTY HELPERS
   ============================================================ */
function getPagePropObj(page, key){
  return (page.properties || []).filter(function(pp){
    return pp.key.toLowerCase() === (key || '').toLowerCase();
  })[0] || null;
}

/* A column in a database view can span pages that don't all have the
   property yet — use whichever page defines a type for it first, so
   the cell editor (and any brand-new value typed into an empty cell)
   is still the right widget instead of a bare text box. */
function inferColumnType(pages, key){
  for(var i=0;i<pages.length;i++){
    var pp = getPagePropObj(pages[i], key);
    if(pp && pp.type) return pp.type;
  }
  return 'text';
}

/* ---- Deterministic colored chips for select/multi-select ----
   No extra state to manage (no color picker, nothing to migrate) —
   the same text always lands on the same one of a small palette, so
   colors stay stable across sessions and devices. */
var ADV_CHIP_PALETTE_SIZE = 8;
function chipColorClass(value){
  var s = String(value || '');
  var h = 0;
  for(var i=0;i<s.length;i++){ h = (h * 31 + s.charCodeAt(i)) >>> 0; }
  return 'adv-chip-' + (h % ADV_CHIP_PALETTE_SIZE);
}
function makeChip(value, extraClass){
  var chip = document.createElement('span');
  chip.className = 'adv-chip ' + chipColorClass(value) + (extraClass ? ' ' + extraClass : '');
  chip.textContent = value;
  return chip;
}

function formatNumberForDisplay(rawValue, numFormat){
  var n = parseFloat(rawValue);
  if(rawValue === '' || rawValue == null) return '';
  if(isNaN(n)) return String(rawValue);
  switch(numFormat){
    case 'integer': return String(Math.round(n));
    case 'currency': return '$' + n.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2});
    case 'percent': return trimNum(n) + '%';
    default: return trimNum(n);
  }
}
function trimNum(n){ return String(Math.round(n * 1e4) / 1e4); }

/* Renders a 1–5 star rating. Read-only when onSet is omitted;
   clicking the current value again clears it back to 0, matching how
   the checkbox/select property widgets already toggle in place. */
function renderRatingStars(value, onSet){
  var wrap = document.createElement('span'); wrap.className = 'adv-rating';
  var cur = parseInt(value, 10) || 0;
  var _loop = function(s){
    var star = document.createElement('span');
    star.className = 'adv-star' + (s <= cur ? ' filled' : '');
    star.textContent = s <= cur ? '★' : '☆';
    if(onSet){
      star.classList.add('interactive');
      star.addEventListener('click', function(e){
        e.stopPropagation();
        onSet(cur === s ? 0 : s);
      });
    }
    wrap.appendChild(star);
  };
  for(var s=1; s<=5; s++) _loop(s);
  return wrap;
}

/* ============================================================
   FORMULAS
   A "formula" property is computed from OTHER properties on the same
   page. Reference a property either as a bare identifier (`Price *
   Qty`) or, if its key has spaces/punctuation, in braces (`{Total
   Price} * 1.1`). Supports + - * / % ^, parentheses, unary minus, and
   round/abs/floor/ceil/sqrt/min/max — deliberately not eval/Function,
   so a formula can never run arbitrary JS.
   ============================================================ */
var FORMULA_FUNCS = {
  round: function(v, n){ var f = Math.pow(10, n || 0); return Math.round(v * f) / f; },
  abs: Math.abs, floor: Math.floor, ceil: Math.ceil, sqrt: Math.sqrt,
  min: function(){ return Math.min.apply(null, arguments); },
  max: function(){ return Math.max.apply(null, arguments); }
};

function tokenizeFormula(expr){
  var tokens = []; var i = 0; expr = expr || '';
  while(i < expr.length){
    var c = expr[i];
    if(/\s/.test(c)){ i++; continue; }
    if(c === '{'){
      var end = expr.indexOf('}', i);
      if(end === -1){ tokens.push({type:'ref', value: expr.slice(i+1)}); i = expr.length; }
      else { tokens.push({type:'ref', value: expr.slice(i+1, end)}); i = end + 1; }
      continue;
    }
    if(/[0-9.]/.test(c)){
      var j = i; while(j < expr.length && /[0-9.]/.test(expr[j])) j++;
      tokens.push({type:'num', value: parseFloat(expr.slice(i, j))}); i = j; continue;
    }
    if(/[a-zA-Z_]/.test(c)){
      var k = i; while(k < expr.length && /[a-zA-Z_0-9]/.test(expr[k])) k++;
      tokens.push({type:'ident', value: expr.slice(i, k)}); i = k; continue;
    }
    if('+-*/%^(),'.indexOf(c) !== -1){ tokens.push({type:'op', value:c}); i++; continue; }
    i++; /* skip anything else rather than fail the whole formula */
  }
  return tokens;
}

function parseFormula(tokens){
  var pos = 0;
  function peek(){ return tokens[pos]; }
  function next(){ return tokens[pos++]; }
  function parseExpr(){ return parseAdd(); }
  function parseAdd(){
    var node = parseMul();
    while(peek() && peek().type === 'op' && (peek().value === '+' || peek().value === '-')){
      var op = next().value; node = {op:op, left:node, right:parseMul()};
    }
    return node;
  }
  function parseMul(){
    var node = parsePow();
    while(peek() && peek().type === 'op' && (peek().value === '*' || peek().value === '/' || peek().value === '%')){
      var op = next().value; node = {op:op, left:node, right:parsePow()};
    }
    return node;
  }
  function parsePow(){
    var node = parseUnary();
    if(peek() && peek().type === 'op' && peek().value === '^'){
      next(); node = {op:'^', left:node, right:parsePow()};
    }
    return node;
  }
  function parseUnary(){
    if(peek() && peek().type === 'op' && peek().value === '-'){ next(); return {op:'neg', arg:parseUnary()}; }
    return parseAtom();
  }
  function parseAtom(){
    var t = peek();
    if(!t) return {op:'num', value:0};
    if(t.type === 'num'){ next(); return {op:'num', value:t.value}; }
    if(t.type === 'ref'){ next(); return {op:'ref', key:t.value}; }
    if(t.type === 'op' && t.value === '('){
      next(); var node = parseExpr();
      if(peek() && peek().value === ')') next();
      return node;
    }
    if(t.type === 'ident'){
      next();
      if(peek() && peek().type === 'op' && peek().value === '('){
        next();
        var args = [];
        if(!(peek() && peek().value === ')')){
          args.push(parseExpr());
          while(peek() && peek().value === ','){ next(); args.push(parseExpr()); }
        }
        if(peek() && peek().value === ')') next();
        return {op:'call', name:t.value.toLowerCase(), args:args};
      }
      return {op:'ref', key:t.value};
    }
    next();
    return {op:'num', value:0};
  }
  return parseExpr();
}

function evalFormulaAst(node, page){
  if(!node) return 0;
  switch(node.op){
    case 'num': return node.value;
    case 'neg': return -evalFormulaAst(node.arg, page);
    case 'ref': {
      var pp = getPagePropObj(page, node.key);
      var n = pp ? parseFloat(pp.value) : NaN;
      return isNaN(n) ? 0 : n;
    }
    case 'call': {
      var fn = FORMULA_FUNCS[node.name];
      if(!fn) return 0;
      var vals = node.args.map(function(a){ return evalFormulaAst(a, page); });
      var r = fn.apply(null, vals);
      return (typeof r === 'number' && isFinite(r)) ? r : 0;
    }
    case '+': return evalFormulaAst(node.left, page) + evalFormulaAst(node.right, page);
    case '-': return evalFormulaAst(node.left, page) - evalFormulaAst(node.right, page);
    case '*': return evalFormulaAst(node.left, page) * evalFormulaAst(node.right, page);
    case '/': { var d = evalFormulaAst(node.right, page); return d ? evalFormulaAst(node.left, page) / d : 0; }
    case '%': { var d2 = evalFormulaAst(node.right, page); return d2 ? evalFormulaAst(node.left, page) % d2 : 0; }
    case '^': return Math.pow(evalFormulaAst(node.left, page), evalFormulaAst(node.right, page));
    default: return 0;
  }
}

function computeFormulaValue(page, expr){
  if(!expr || !expr.trim()) return '';
  try{
    var result = evalFormulaAst(parseFormula(tokenizeFormula(expr)), page);
    if(typeof result !== 'number' || !isFinite(result)) return 'Error';
    return trimNum(result);
  }catch(e){ return 'Error'; }
}

function recomputeFormulas(page){
  (page.properties || []).forEach(function(pp){
    if(pp.type === 'formula') pp.value = computeFormulaValue(page, pp.formula || '');
  });
}
function recomputeAllFormulas(){
  livePages().forEach(function(p){ recomputeFormulas(p); });
}

/* ============================================================
   INLINE CELL EDITING
   Builds a small live control for one page's property, used by the
   table/board/gallery cell renderers in 01-query-engine.js. Typing
   saves silently (like the property panel does); the onChange
   callback — a full renderPage() from the caller — only fires on
   blur/change, both so a keystroke never yanks focus away mid-edit
   and because a full render is what actually recomputes any
   formula/rollup that depends on the edited property.

   Checkbox, rating and date are always shown as their live widget
   (that already *is* the compact, rich form). Select, multi-select,
   relation and number instead show a read-only rich value — a
   colored chip, chips-with-links, or a formatted number — that turns
   into the same editor the property panel would use the moment it's
   clicked, exactly like a multi-select/relation property's chips do
   there; clicking a relation chip still navigates instead, since the
   row-level .link click handling underneath keeps working. */
function buildInlineCellEditor(page, key, colType, onChange){
  var pp = getPagePropObj(page, key);
  var type = pp ? pp.type : (colType || 'text');

  /* A locked page's properties are read-only everywhere, including
     here — the property panel already enforces this (see
     js/13a-locks-and-sidebar.js), so a database view can't become a
     backdoor around it. */
  if(typeof pageIsLocked === 'function' && pageIsLocked(page.id)){
    if(type === 'checkbox'){
      var lockedCb = document.createElement('span'); lockedCb.className = 'adv-check' + (pp && pp.value === 'true' ? ' checked' : '');
      lockedCb.textContent = (pp && pp.value === 'true') ? '☑' : '☐';
      return lockedCb;
    }
    if(type === 'rating') return renderRatingStars(pp ? pp.value : '0', null);
    if(type === 'select') return (pp && pp.value) ? makeChip(pp.value) : emptyDash();
    if(type === 'multiselect' || type === 'relation'){
      var lockedWrap = document.createElement('span'); lockedWrap.className = 'adv-chip-group';
      (pp && pp.value ? pp.value : '').split(',').map(function(s){ return s.trim(); }).filter(Boolean).forEach(function(v){
        if(type === 'relation'){
          var lockedLink = document.createElement('span'); lockedLink.className = 'link adv-chip'; lockedLink.dataset.target = v; lockedLink.textContent = v;
          lockedWrap.appendChild(lockedLink);
        } else {
          lockedWrap.appendChild(makeChip(v));
        }
      });
      return lockedWrap;
    }
    if(type === 'number'){
      var lockedNum = document.createElement('span');
      lockedNum.textContent = (pp && pp.value !== '') ? formatNumberForDisplay(pp.value, pp.numFormat) : '—';
      return lockedNum;
    }
    var lockedText = document.createElement('span'); lockedText.className = 'adv-cell-readonly';
    lockedText.textContent = (pp && pp.value) ? pp.value : ((type === 'rollup' || type === 'formula') ? '—' : '');
    return lockedText;
  }

  function ensureProp(){
    if(pp) return pp;
    page.properties = page.properties || [];
    pp = {key:key, value:'', type: type || 'text'};
    page.properties.push(pp);
    return pp;
  }
  function stop(e){ e.stopPropagation(); }
  function emptyDash(){ var e = document.createElement('span'); e.className = 'adv-cell-empty'; e.textContent = '—'; return e; }

  if(type === 'checkbox'){
    var cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'adv-cell-checkbox';
    cb.checked = pp ? pp.value === 'true' : false;
    cb.addEventListener('click', stop);
    cb.addEventListener('change', function(){ ensureProp().value = cb.checked ? 'true' : 'false'; save(); onChange && onChange(); });
    return cb;
  }
  if(type === 'rating'){
    return renderRatingStars(pp ? pp.value : '0', function(v){ ensureProp().value = String(v); save(); onChange && onChange(); });
  }
  if(type === 'rollup' || type === 'formula'){
    var ro = document.createElement('span'); ro.className = 'adv-cell-readonly';
    ro.title = type === 'formula' ? 'Computed by a formula' : 'Computed rollup — read-only';
    ro.textContent = (pp && pp.value) ? pp.value : '—';
    return ro;
  }
  if(type === 'date'){
    var d = document.createElement('input'); d.type = 'date'; d.className = 'adv-cell-input';
    d.value = (pp && /^\d{4}-\d{2}-\d{2}$/.test(pp.value)) ? pp.value : '';
    d.addEventListener('click', stop);
    d.addEventListener('change', function(){ ensureProp().value = d.value; save(); onChange && onChange(); });
    return d;
  }
  if(type === 'number'){
    return buildClickToEditCell(false, function(){
      if(!pp || pp.value === '') return emptyDash();
      var span = document.createElement('span'); span.textContent = formatNumberForDisplay(pp.value, pp.numFormat);
      return span;
    }, function(){
      var n = document.createElement('input'); n.type = 'number'; n.step = 'any'; n.className = 'adv-cell-input';
      n.value = pp ? pp.value : '';
      n.addEventListener('click', stop);
      n.addEventListener('input', function(){ ensureProp().value = n.value; save(); });
      n.addEventListener('blur', function(){ onChange && onChange(); });
      return n;
    });
  }
  if(type === 'select'){
    return buildClickToEditCell(false, function(){
      return (pp && pp.value) ? makeChip(pp.value) : emptyDash();
    }, function(){
      var listId = 'adv-sel-' + Math.random().toString(36).slice(2);
      var frag = document.createDocumentFragment();
      var s = document.createElement('input'); s.type = 'text'; s.className = 'adv-cell-input'; s.setAttribute('list', listId);
      s.value = pp ? pp.value : ''; s.placeholder = 'pick or type';
      var dl = document.createElement('datalist'); dl.id = listId;
      collectKnownPropValues(key).forEach(function(v){ var o = document.createElement('option'); o.value = v; dl.appendChild(o); });
      s.addEventListener('click', stop);
      s.addEventListener('input', function(){ ensureProp().value = s.value; save(); });
      s.addEventListener('blur', function(){ onChange && onChange(); });
      frag.appendChild(s); frag.appendChild(dl);
      return frag;
    });
  }
  if(type === 'multiselect' || type === 'relation'){
    return buildClickToEditCell(type === 'relation', function(){
      var wrap = document.createElement('span'); wrap.className = 'adv-chip-group';
      (pp && pp.value ? pp.value : '').split(',').map(function(s){ return s.trim(); }).filter(Boolean).forEach(function(v){
        if(type === 'relation'){
          var link = document.createElement('span'); link.className = 'link adv-chip'; link.dataset.target = v; link.textContent = v;
          wrap.appendChild(link);
        } else {
          wrap.appendChild(makeChip(v));
        }
      });
      return wrap;
    }, function(){
      var listId2 = 'adv-ms-' + Math.random().toString(36).slice(2);
      var frag2 = document.createDocumentFragment();
      var m = document.createElement('input'); m.type = 'text'; m.className = 'adv-cell-input'; m.setAttribute('list', listId2);
      m.value = pp ? pp.value : ''; m.placeholder = 'comma-separated';
      var dl2 = document.createElement('datalist'); dl2.id = listId2;
      (type === 'relation' ? collectKnownPageTitles() : collectKnownPropValueParts(key)).forEach(function(v){
        var o = document.createElement('option'); o.value = v; dl2.appendChild(o);
      });
      m.addEventListener('click', stop);
      m.addEventListener('input', function(){ ensureProp().value = m.value; save(); });
      m.addEventListener('blur', function(){ onChange && onChange(); });
      frag2.appendChild(m); frag2.appendChild(dl2);
      return frag2;
    });
  }
  /* text (and any unrecognized type) — a persistent borderless input
     is already as unobtrusive as a rich display would be. */
  var t = document.createElement('input'); t.type = 'text'; t.className = 'adv-cell-input';
  t.value = pp ? pp.value : '';
  t.addEventListener('click', stop);
  t.addEventListener('input', function(){ ensureProp().value = t.value; save(); });
  t.addEventListener('blur', function(){ onChange && onChange(); });
  return t;
}

/* Shows `buildDisplay()`'s read-only node; clicking swaps in
   `buildEditor()`'s live control in place. A full renderPage() (via
   the editor's own onChange) rebuilds everything from scratch on the
   next change anyway, so there's no need to swap back manually — the
   next render just starts in display mode again.
   When `chipsAreClickable` is true (relation cells), a click that
   landed on an actual chip is left alone so its own .link navigation
   fires instead of entering edit mode — only clicks on the cell's
   empty space open the editor. */
function buildClickToEditCell(chipsAreClickable, buildDisplay, buildEditor){
  var wrap = document.createElement('span'); wrap.className = 'adv-clicktoedit';
  var displayNode = buildDisplay();
  wrap.appendChild(displayNode);
  wrap.addEventListener('click', function(e){
    if(chipsAreClickable && e.target !== wrap && e.target !== displayNode) return;
    wrap.innerHTML = '';
    wrap.appendChild(buildEditor());
    var toFocus = wrap.querySelector('input, select');
    if(toFocus) toFocus.focus();
  });
  return wrap;
}

/* ============================================================
   AGGREGATES — a footer row under table-view databases
   ============================================================ */
var ADV_AGG_OPTIONS = [['none','—'], ['count','Count'], ['sum','Sum'], ['avg','Average'], ['min','Min'], ['max','Max']];

function computeAggregateDisplay(fn, values, nums){
  if(!fn || fn === 'none') return '';
  if(fn === 'count') return String(values.length);
  if(!nums.length) return '—';
  var sum = nums.reduce(function(a,b){ return a+b; }, 0);
  if(fn === 'sum') return trimNum(sum);
  if(fn === 'avg') return trimNum(sum / nums.length);
  if(fn === 'min') return trimNum(Math.min.apply(null, nums));
  if(fn === 'max') return trimNum(Math.max.apply(null, nums));
  return '';
}

/* Appended after a table view's data rows. `pagePropValue` is passed
   in from the caller so this reuses the exact same lookup the table
   body just used, rather than redefining it here. */
function appendAggregateFooterRow(table, propKeys, pages, dirs, blockId, pagePropValue){
  var footTr = document.createElement('tr'); footTr.className = 'query-table-foot';
  var footSel = document.createElement('td'); footSel.className = 'qsel-cell';
  footTr.appendChild(footSel);
  var footLabel = document.createElement('td'); footLabel.className = 'adv-agg-rowcount';
  footLabel.textContent = pages.length + (pages.length === 1 ? ' row' : ' rows');
  footTr.appendChild(footLabel);
  propKeys.forEach(function(k){
    var td = document.createElement('td'); td.className = 'adv-agg-cell';
    var fn = (dirs.agg && dirs.agg[k]) || 'none';
    var values = pages.map(function(p){ return pagePropValue(p, k); }).filter(function(v){ return v !== ''; });
    var nums = values.map(function(v){ return parseFloat(v); }).filter(function(n){ return !isNaN(n); });
    var resultSpan = document.createElement('span'); resultSpan.className = 'adv-agg-result';
    resultSpan.textContent = computeAggregateDisplay(fn, values, nums);
    var sel = document.createElement('select'); sel.className = 'adv-agg-select'; sel.title = 'Aggregate for "' + k + '"';
    ADV_AGG_OPTIONS.forEach(function(o){
      var opt = document.createElement('option'); opt.value = o[0]; opt.textContent = o[1];
      if(fn === o[0]) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('click', function(e){ e.stopPropagation(); });
    sel.addEventListener('change', function(){
      patchTableDirs(blockId, function(d){
        d.agg = d.agg || {};
        if(sel.value === 'none') delete d.agg[k]; else d.agg[k] = sel.value;
      });
    });
    td.appendChild(sel); td.appendChild(resultSpan);
    footTr.appendChild(td);
  });
  table.appendChild(footTr);
}

/* ============================================================
   MULTIPLE SAVED VIEWS PER DATABASE
   A block's filters (its {{table: ...}} qstr, minus directives) are
   the one underlying "database"; `block.dbViews` is an optional list
   of {id, name, dirs} view configs on top of it, so the same filters
   can be looked at as a Table and a Board without two blocks. Absent
   dbViews, a block behaves exactly as it always has — the directives
   embedded in its own qstr are the only view. Plain fields on the
   block object, same pattern as page.locked/block.locked in
   js/13a-locks-and-sidebar.js: older builds and sync peers that
   don't know about them just ignore them.
   ============================================================ */
var DB_VIEW_TYPE_LABEL = {table:'Table', board:'Board', gallery:'Gallery', calendar:'Calendar'};
function viewUid(){ return 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

function activeDbViewDirs(blockId, qstr){
  var block = state.blocks[blockId];
  var views = (block && Array.isArray(block.dbViews) && block.dbViews.length) ? block.dbViews : null;
  if(!views) return extractTableDirectives(qstr).dirs;
  var active = views.filter(function(v){ return v.id === block.dbActiveViewId; })[0] || views[0];
  return active.dirs;
}

/* Applies `patchFn(dirs)` to whichever dirs are currently driving this
   block's rendering — the active saved view if there is one, else the
   directives embedded in the block's own raw text (which get
   rewritten back into it, exactly like the query builder already
   does when it saves). */
function patchTableDirs(blockId, patchFn){
  var block = state.blocks[blockId];
  if(!block) return;
  if(Array.isArray(block.dbViews) && block.dbViews.length){
    var active = block.dbViews.filter(function(v){ return v.id === block.dbActiveViewId; })[0] || block.dbViews[0];
    patchFn(active.dirs);
  } else {
    var m = QUERY_BLOCK_RE.exec(block.text);
    var kind = m ? m[1].toLowerCase() : 'table';
    var qstr = m ? m[2] : '';
    var parsed = extractTableDirectives(qstr);
    patchFn(parsed.dirs);
    block.text = '{{' + kind + ': ' + [buildDirectivesStr(parsed.dirs), parsed.remainder].filter(Boolean).join(' ').trim() + '}}';
  }
  save(); renderPage();
}

function addDbView(blockId, viewType){
  var block = state.blocks[blockId];
  if(!block) return;
  if(!Array.isArray(block.dbViews) || !block.dbViews.length){
    var m = QUERY_BLOCK_RE.exec(block.text);
    var parsed = extractTableDirectives(m ? m[2] : '');
    block.dbViews = [{id: viewUid(), name: DB_VIEW_TYPE_LABEL[parsed.dirs.view] || 'Table', dirs: parsed.dirs}];
  }
  var newDirs = {view:viewType, sort:'', sortDesc:false, group:'', cols:null, agg:{}};
  var baseName = DB_VIEW_TYPE_LABEL[viewType] || 'View';
  var n = block.dbViews.filter(function(v){ return (v.name || '').indexOf(baseName) === 0; }).length;
  var newId = viewUid();
  block.dbViews.push({id:newId, name: n ? baseName + ' ' + (n + 1) : baseName, dirs:newDirs});
  block.dbActiveViewId = newId;
  save(); renderPage();
}

function removeDbView(blockId, viewId){
  var block = state.blocks[blockId];
  if(!block || !Array.isArray(block.dbViews) || block.dbViews.length <= 1) return;
  var idx = block.dbViews.map(function(v){ return v.id; }).indexOf(viewId);
  if(idx === -1) return;
  block.dbViews.splice(idx, 1);
  if(block.dbActiveViewId === viewId) block.dbActiveViewId = block.dbViews[0].id;
  save(); renderPage();
}

function renderDbViewTabsBar(box, blockId){
  var block = state.blocks[blockId];
  if(!block) return;
  var bar = document.createElement('div'); bar.className = 'db-view-tabs';
  var views = (Array.isArray(block.dbViews) && block.dbViews.length) ? block.dbViews : null;

  if(views){
    views.forEach(function(v){
      var tab = document.createElement('div');
      tab.className = 'db-view-tab' + (v.id === block.dbActiveViewId ? ' active' : '');
      var label = document.createElement('span'); label.className = 'db-view-tab-label';
      label.textContent = v.name || DB_VIEW_TYPE_LABEL[v.dirs.view] || 'View';
      label.spellcheck = false;
      tab.appendChild(label);
      tab.addEventListener('click', function(e){
        e.stopPropagation();
        if(label.isContentEditable) return;
        block.dbActiveViewId = v.id; save(); renderPage();
      });
      label.addEventListener('dblclick', function(e){
        e.stopPropagation();
        label.contentEditable = 'true'; label.focus();
        var range = document.createRange(); range.selectNodeContents(label);
        var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      });
      label.addEventListener('click', function(e){ if(label.isContentEditable) e.stopPropagation(); });
      label.addEventListener('blur', function(){
        label.contentEditable = 'false';
        v.name = label.textContent.trim() || DB_VIEW_TYPE_LABEL[v.dirs.view] || 'View';
        save(); renderPage();
      });
      label.addEventListener('keydown', function(e){
        e.stopPropagation();
        if(e.key === 'Enter'){ e.preventDefault(); label.blur(); }
      });
      if(views.length > 1){
        var closeBtn = document.createElement('span'); closeBtn.className = 'db-view-tab-close';
        closeBtn.textContent = '✕'; closeBtn.title = 'Delete this view';
        closeBtn.addEventListener('click', function(e){ e.stopPropagation(); removeDbView(blockId, v.id); });
        tab.appendChild(closeBtn);
      }
      bar.appendChild(tab);
    });
  }

  var addWrap = document.createElement('div'); addWrap.className = 'db-view-add-wrap';
  var addBtn = document.createElement('button'); addBtn.type = 'button'; addBtn.className = 'db-view-add-btn';
  addBtn.textContent = '+ view'; addBtn.title = 'Add another view of this database';
  addBtn.addEventListener('click', function(e){
    e.stopPropagation();
    var existing = addWrap.querySelector('.db-view-add-menu');
    if(existing){ existing.remove(); return; }
    var menu = document.createElement('div'); menu.className = 'db-view-add-menu';
    [['table','▤ Table'], ['board','▥ Board'], ['gallery','▦ Gallery'], ['calendar','▤ Calendar']].forEach(function(o){
      var item = document.createElement('div'); item.className = 'db-view-add-item'; item.textContent = o[1];
      item.addEventListener('click', function(ev){ ev.stopPropagation(); addDbView(blockId, o[0]); menu.remove(); });
      menu.appendChild(item);
    });
    addWrap.appendChild(menu);
    setTimeout(function(){
      document.addEventListener('click', function closeMenu(ev){
        if(!addWrap.contains(ev.target)){ menu.remove(); document.removeEventListener('click', closeMenu); }
      });
    }, 0);
  });
  addWrap.appendChild(addBtn);
  bar.appendChild(addWrap);
  box.appendChild(bar);
}
