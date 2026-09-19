/* ============================================================
 * 17-advanced-search.js
 * A shared "advanced search" language, wired into every search
 * surface in the app so the same syntax works everywhere:
 *   - the sidebar search box + its "matching lines" results
 *   - the ⌘K command palette
 *   - the task manager's filter box
 *   - the {{query:}} / {{table:}} database engine
 *
 * This sits ALONGSIDE the original simple filter language already
 * in 01-query-engine.js (parseQueryFilters / pageMatchesProps),
 * which is left untouched on purpose: the no-code query-builder
 * popup reads and writes that exact shape, and changing it would
 * mean rewriting the builder's UI. Everything in this file is
 * additive — a plain query with no operators behaves exactly like
 * the old fuzzy/substring search it replaces, and every operator
 * below is a superset written on top of that.
 *
 * Because every other file only calls these functions from inside
 * other functions (never at load time), it doesn't matter that this
 * file loads after them in index.html — by the time a search
 * actually runs (a keystroke, a render), every file has loaded.
 *
 * Syntax:
 *   word  "a phrase"        free text (typo-tolerant, same fuzzy
 *                           matching as before)
 *   #tag   [[Page]]         same tag / page-reference filters the
 *                           {{query:}} language already has
 *   key:value               page property "key" contains "value"
 *   key>value  key<value  key>=value  key<=value  key!=value
 *                           numeric/date-aware property comparison
 *   priority:high (or !p1, or 1/2/3, or none)
 *   due:today  on:2026-09-20  before:friday  after:+3d
 *                           due-date filters (blocks/tasks only) —
 *                           same date words the task quick-add uses
 *   is:done / is:open / is:task / is:overdue / is:pinned /
 *   is:hidden / is:locked / is:daily / is:tag / is:page
 *   has:due / has:repeat / has:priority / has:tag / has:link /
 *   has:attachment / has:children
 *   /pattern/flags           regex against the raw line/title text
 *   -token                   negates any filter above
 *   a OR b                   top-level alternatives — matches if
 *                           either side matches (everything else on
 *                           one side of OR is still AND'd together);
 *                           "|" inside one token (e.g. #a|b) is the
 *                           same idea scoped to one filter's values
 * ============================================================ */
"use strict";

/* ============================================================
   TOKENIZER + PARSER
   ============================================================ */
var ADV_TOK_RE = /-?\[\[[^\]]+\]\]|-?\/(?:\\.|[^\/\\])+\/[a-z]*|-?[a-zA-Z0-9_-]+(?:>=|<=|!=|:|>|<)"[^"]*"|-?[a-zA-Z0-9_-]+(?:>=|<=|!=|:|>|<)\S+|-?"[^"]*"|-?\S+/g;

function advSplitAlts(s){
  return (s || '').split('|').map(function(v){ return v.trim(); }).filter(Boolean);
}

/* Classifies one raw token (as matched by ADV_TOK_RE) into a
   {kind, negate, ...} shape. "OR" is checked before negation is
   stripped, so a real query never accidentally eats a leading dash
   meant for the word after it. */
function advClassifyToken(raw){
  if(raw === 'OR') return {kind:'or'};
  var negate = false;
  if(raw[0] === '-' && raw.length > 1){ negate = true; raw = raw.slice(1); }

  var pageMatch = raw.match(/^\[\[([^\]]+)\]\]$/);
  if(pageMatch) return {kind:'page', negate:negate, values: advSplitAlts(pageMatch[1])};

  var regexMatch = raw.match(/^\/((?:\\.|[^\/\\])+)\/([a-z]*)$/);
  if(regexMatch) return {kind:'regex', negate:negate, source:regexMatch[1], flags:regexMatch[2].replace(/[^gimsuy]/g,'')};

  if(raw[0] === '#' && raw.length > 1) return {kind:'tag', negate:negate, values: advSplitAlts(raw.slice(1))};

  var opMatch = raw.match(/^([a-zA-Z0-9_-]+)(>=|<=|!=|:|>|<)(.+)$/);
  if(opMatch){
    var val = opMatch[3].replace(/^"|"$/g,'');
    /* "http://…", "https://…" etc: a URL parses as key="http" op=":"
       value="//…", which would otherwise make pasting a link into
       search silently look for a "http" page property. Treat the
       whole thing as plain text instead — this is a strict fix, not
       a behavior anyone could have been relying on. */
    if(/^\/\//.test(val)) return {kind:'text', negate:negate, values: advSplitAlts(raw)};
    return {
      kind:'prop', negate:negate, key: opMatch[1].toLowerCase(), op: opMatch[2],
      values: opMatch[2] === ':' ? advSplitAlts(val) : [val]
    };
  }

  return {kind:'text', negate:negate, values: advSplitAlts(raw.replace(/^"|"$/g,''))};
}

function advParseUncached(qstr){
  var groups = [[]];
  var isAdvanced = false;
  ADV_TOK_RE.lastIndex = 0;
  var m;
  while((m = ADV_TOK_RE.exec(qstr || ''))){
    var tok = advClassifyToken(m[0]);
    if(tok.kind === 'or'){ groups.push([]); isAdvanced = true; continue; }
    if(tok.kind !== 'text' || tok.negate) isAdvanced = true;
    groups[groups.length - 1].push(tok);
  }
  return {groups: groups.filter(function(g){ return g.length; }), isAdvanced: isAdvanced};
}

/* Parsing is pure but happens per-item in the naive version of every
   caller below (once per block/page/task); a tiny one-entry cache
   means a render pass over thousands of items only parses the query
   string once. */
var advParseCache = {qstr: null, parsed: null};
function parseAdvancedQuery(qstr){
  qstr = qstr || '';
  if(advParseCache.qstr === qstr) return advParseCache.parsed;
  var parsed = advParseUncached(qstr);
  advParseCache = {qstr: qstr, parsed: parsed};
  return parsed;
}

/* ============================================================
   RECORD BUILDERS
   Every search surface has a different native shape (a block, a
   page, a task). Each gets normalized into the same small record
   so one matcher can serve all of them.

   Note: tagsLower and pagesLower are deliberately kept separate.
   #tag references are tags; [[Page]] references are page links. The
   advanced search layer must preserve that distinction so tag filters
   never match page links and page-link filters never match tags.
   ============================================================ */
function extractSearchRefLists(text){
  var refs = extractRefs(text || '') || [];
  return {
    tagsLower: refs.filter(function(r){ return r.type === 'tag'; }).map(function(r){ return r.title.toLowerCase(); }),
    pagesLower: refs.filter(function(r){ return r.type === 'page'; }).map(function(r){ return r.title.toLowerCase(); })
  };
}

function searchRecordForBlock(block, page){
  var refLists = extractSearchRefLists(block.text || '');
  var todo = todoInfo(block.text || '');
  var rest = todo ? todo.rest : '';
  return {
    text: block.text || '',
    tagsLower: refLists.tagsLower,
    pagesLower: refLists.pagesLower,
    page: page,
    block: block,
    isTask: !!todo,
    done: todo ? todo.done : false,
    due: todo ? splitTodoDue(rest).due : null,
    pri: todo ? taskPriOf(rest) : 0,
    rep: todo ? taskRepOf(rest) : null,
    locked: typeof blockIsLocked === 'function' && blockIsLocked(block)
  };
}

function searchRecordForPage(page, refLists){
  refLists = refLists || {tagsLower:[],pagesLower:[]};
  return {
    text: page.title || '',
    tagsLower: refLists.tagsLower || [],
    pagesLower: refLists.pagesLower || [],
    page: page,
    block: null,
    isTask: false, done:false, due:null, pri:0, rep:null,
    locked: typeof pageIsLocked === 'function' && pageIsLocked(page.id)
  };
}

function searchRecordForTask(t){
  var block = state.blocks[t.id];
  var refLists = block ? extractSearchRefLists(block.text || '') : {tagsLower:(t.tags || []).map(function(x){ return x.toLowerCase(); }),pagesLower:[]};
  return {
    /* Free-text matching should still find a task by the page it's
       on, same as the old plain-substring task filter did. */
    text: (t.text || '') + ' ' + (t.pageTitle || ''),
    tagsLower: refLists.tagsLower,
    pagesLower: refLists.pagesLower,
    page: state.pages[t.pageId],
    block: block,
    isTask: true,
    done: !!t.done,
    due: t.due,
    pri: t.pri,
    rep: t.rep,
    locked: !!t.locked
  };
}

/* Every page a block or ((tag)) reference points at, across the
   whole notebook, keyed by the referencing block's pageId — the same
   map runTableQuery already built inline; pulled out here so the
   sidebar/palette page search can use it too.

   This is a derived index, so repeated advanced searches during one
   render should not re-parse every block. The cache is explicitly
   invalidated at mutation/state-replacement boundaries (save, history,
   restore, and sync). It never becomes authoritative notebook data. */
var pageRefsMapCache = {state:null, map:null};
function invalidatePageRefsMapCache(){
  pageRefsMapCache.state = null;
  pageRefsMapCache.map = null;
}
function computePageRefsMap(){
  if(pageRefsMapCache.state === state && pageRefsMapCache.map) return pageRefsMapCache.map;
  var map = {};
  Object.keys(state.blocks).forEach(function(id){
    var blk = state.blocks[id];
    var refs = extractSearchRefLists(blk.text || '');
    var entry = map[blk.pageId] || {tagsLower:[],pagesLower:[]};
    entry.tagsLower = entry.tagsLower.concat(refs.tagsLower);
    entry.pagesLower = entry.pagesLower.concat(refs.pagesLower);
    map[blk.pageId] = entry;
  });
  pageRefsMapCache = {state:state, map:map};
  return map;
}

/* ============================================================
   DATE / PRIORITY HELPERS
   Reuses the exact date words the task quick-add already parses
   (today/tomorrow/a weekday/+3d/an ISO date), so "before:friday"
   here and "due:friday" typed into quick-add always mean the same
   Friday.
   ============================================================ */
function advTodayYmd(){ return ymd(startOfToday()); }

function advResolveDateWord(w){
  w = (w || '').trim().toLowerCase();
  if(w === 'yesterday'){ var d = startOfToday(); d.setDate(d.getDate() - 1); return ymd(d); }
  if(typeof parseDueWord === 'function'){
    var r = parseDueWord(w);
    if(r) return r;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(w) ? w : null;
}

function advParsePriorityValue(v){
  v = (v || '').toLowerCase().replace(/^!/, '').replace(/^p/, '');
  if(v === 'high' || v === '1') return 1;
  if(v === 'medium' || v === 'med' || v === '2') return 2;
  if(v === 'low' || v === '3') return 3;
  if(v === 'none' || v === 'no' || v === '0' || v === '') return v === '' ? null : 0;
  return null;
}

function advCompareValues(a, b){
  var an = parseFloat(a), bn = parseFloat(b);
  if(a !== '' && b !== '' && !isNaN(an) && !isNaN(bn)) return an - bn;
  if(/^\d{4}-\d{2}-\d{2}/.test(a) && /^\d{4}-\d{2}-\d{2}/.test(b)) return a < b ? -1 : (a > b ? 1 : 0);
  return String(a).localeCompare(String(b));
}

function advOpMatches(op, actual, expected){
  actual = actual == null ? '' : actual;
  if(op === ':') return String(actual).toLowerCase().indexOf(String(expected).toLowerCase()) !== -1;
  if(op === '!=') return String(actual).toLowerCase() !== String(expected).toLowerCase();
  var cmp = advCompareValues(String(actual), String(expected));
  if(op === '>') return cmp > 0;
  if(op === '<') return cmp < 0;
  if(op === '>=') return cmp >= 0;
  if(op === '<=') return cmp <= 0;
  return false;
}

/* ============================================================
   is: / has: FLAGS
   ============================================================ */
function advIsFlag(value, rec){
  switch(value){
    case 'done': case 'complete': case 'completed': return !!rec.isTask && !!rec.done;
    case 'open': case 'undone': case 'incomplete': return !!rec.isTask && !rec.done;
    case 'task': case 'todo': return !!rec.isTask;
    case 'overdue': return !!rec.isTask && !rec.done && !!rec.due && rec.due < advTodayYmd();
    case 'pinned': return !!(rec.page && rec.page.pinned);
    case 'hidden': return !!(rec.page && rec.page.hidden);
    case 'locked': return !!rec.locked;
    case 'daily': return !!(rec.page && rec.page.type === 'daily');
    case 'tag': return !!(rec.page && rec.page.type === 'tag');
    case 'page': return !!(rec.page && rec.page.type === 'page');
    default: return false;
  }
}
function advHasFlag(value, rec){
  switch(value){
    case 'due': return !!rec.due;
    case 'repeat': case 'recurring': return !!rec.rep;
    case 'priority': return !!rec.pri;
    case 'tag': return rec.tagsLower.length > 0;
    case 'link': return rec.pagesLower.length > 0;
    case 'attachment': case 'image': case 'file': return /\{\{(img|file):/.test(rec.text || '');
    case 'children': return !!(rec.block && rec.block.children && rec.block.children.length > 0);
    default: return false;
  }
}

/* ============================================================
   PER-TOKEN MATCHERS
   Each returns a plain boolean except matchTextToken, which also
   contributes to the relevance score used for ranking results.
   ============================================================ */
function advMatchTag(tok, rec){
  var has = tok.values.some(function(v){ return rec.tagsLower.indexOf(v.toLowerCase()) !== -1; });
  return tok.negate ? !has : has;
}
function advMatchPage(tok, rec){
  var has = tok.values.some(function(v){ return rec.pagesLower.indexOf(v.toLowerCase()) !== -1; });
  return tok.negate ? !has : has;
}
function advMatchRegex(tok, rec){
  try{
    var re = new RegExp(tok.source, tok.flags);
    var has = re.test(rec.text || '');
    return tok.negate ? !has : has;
  }catch(e){
    return false; /* an invalid pattern never matches, negated or not */
  }
}
function advMatchIs(tok, rec){
  var has = tok.values.some(function(v){ return advIsFlag(v.toLowerCase(), rec); });
  return tok.negate ? !has : has;
}
function advMatchHas(tok, rec){
  var has = tok.values.some(function(v){ return advHasFlag(v.toLowerCase(), rec); });
  return tok.negate ? !has : has;
}
function advMatchPriority(tok, rec){
  var actual = rec.pri || 0;
  var result;
  if(tok.op === ':'){
    result = tok.values.some(function(v){ var pv = advParsePriorityValue(v); return pv !== null && actual === pv; });
  } else {
    var val = advParsePriorityValue(tok.values[0]);
    if(val === null) return false;
    result = tok.op === '!=' ? actual !== val
      : tok.op === '>' ? actual > val
      : tok.op === '<' ? actual < val
      : tok.op === '>=' ? actual >= val
      : tok.op === '<=' ? actual <= val
      : actual === val;
  }
  return tok.negate ? !result : result;
}
function advMatchDueEquals(tok, rec){
  var has = tok.values.some(function(v){
    v = v.toLowerCase();
    if(v === 'overdue') return !!rec.due && !rec.done && rec.due < advTodayYmd();
    var d = advResolveDateWord(v);
    return !!d && rec.due === d;
  });
  return tok.negate ? !has : has;
}
function advMatchDueCompare(tok, rec, dir){
  if(!rec.due) return !!tok.negate;
  var d = advResolveDateWord(tok.values[0]);
  if(!d) return false;
  var result = dir === 'before' ? rec.due < d : rec.due > d;
  return tok.negate ? !result : result;
}
function advMatchPageProp(tok, rec){
  var title = rec.page ? rec.page.title.toLowerCase() : '';
  var has = tok.values.some(function(v){ return title.indexOf(v.toLowerCase()) !== -1; });
  return tok.negate ? !has : has;
}
function advMatchGenericProp(tok, rec){
  if(!rec.page || !rec.page.properties || !rec.page.properties.length) return !!tok.negate;
  var matching = rec.page.properties.filter(function(p){ return p.key.toLowerCase() === tok.key; });
  if(!matching.length) return !!tok.negate;
  var has;
  if(tok.op === ':'){
    has = matching.some(function(p){ return tok.values.some(function(v){ return p.value.toLowerCase().indexOf(v.toLowerCase()) !== -1; }); });
  } else {
    has = matching.some(function(p){ return advOpMatches(tok.op, p.value, tok.values[0]); });
  }
  return tok.negate ? !has : has;
}
function advMatchProp(tok, rec){
  if(tok.key === 'is') return advMatchIs(tok, rec);
  if(tok.key === 'has') return advMatchHas(tok, rec);
  if(tok.key === 'priority' || tok.key === 'pri') return advMatchPriority(tok, rec);
  if(tok.key === 'due' || tok.key === 'on') return advMatchDueEquals(tok, rec);
  if(tok.key === 'before') return advMatchDueCompare(tok, rec, 'before');
  if(tok.key === 'after') return advMatchDueCompare(tok, rec, 'after');
  if(tok.key === 'page') return advMatchPageProp(tok, rec);
  return advMatchGenericProp(tok, rec);
}
function advMatchText(tok, rec){
  var best = 0;
  tok.values.forEach(function(v){
    var s = fuzzyMatchScore(v, rec.text || '');
    if(s > best) best = s;
  });
  var has = best > 0;
  return {match: tok.negate ? !has : has, score: tok.negate ? 0 : best};
}

/* ============================================================
   GROUP + TOP-LEVEL EVALUATION
   Everything inside one group is AND'd; a record matches the whole
   query if it matches ANY group (i.e. groups are OR'd) — this is
   what the "a OR b" syntax produces.
   ============================================================ */
function advEvalGroup(group, rec){
  var score = 0;
  for(var i = 0; i < group.length; i++){
    var tok = group[i], ok;
    if(tok.kind === 'text'){ var r = advMatchText(tok, rec); ok = r.match; score += r.score; }
    else if(tok.kind === 'tag') ok = advMatchTag(tok, rec);
    else if(tok.kind === 'page') ok = advMatchPage(tok, rec);
    else if(tok.kind === 'regex') ok = advMatchRegex(tok, rec);
    else if(tok.kind === 'prop') ok = advMatchProp(tok, rec);
    else ok = true;
    if(!ok) return null;
  }
  return score;
}

function matchAdvancedQuery(parsed, rec){
  if(!parsed.groups.length) return {match:true, score:1};
  var best = null;
  parsed.groups.forEach(function(g){
    var s = advEvalGroup(g, rec);
    if(s !== null && (best === null || s > best)) best = s;
  });
  return best === null ? {match:false, score:0} : {match:true, score: best || 1};
}

function advancedQueryMatch(qstr, rec){
  return matchAdvancedQuery(parseAdvancedQuery(qstr), rec);
}

/* ============================================================
   PAGE RANKING
   Shared by the sidebar's pinned/daily/pages/tags lists and the
   ⌘K palette. A plain-text filter (the overwhelmingly common case)
   takes the exact old code path — same fuzzyMatchScore call, same
   tie-break — so existing search behavior is unchanged; only a
   filter that actually uses an operator switches to record-based
   matching (which needs the extra page-refs map for #tag/[[Page]]).
   ============================================================ */
function rankPages(pages, filter, keyFn){
  keyFn = keyFn || function(p){ return p.title; };
  filter = filter || '';
  var parsed = parseAdvancedQuery(filter);
  var pageRefs = parsed.isAdvanced ? computePageRefsMap() : null;
  var scored = pages.map(function(p){
    var score;
    if(parsed.isAdvanced){
      var res = matchAdvancedQuery(parsed, searchRecordForPage(p, pageRefs[p.id] || {tagsLower:[],pagesLower:[]}));
      score = res.match ? res.score : 0;
    } else {
      score = fuzzyMatchScore(filter, keyFn(p));
    }
    return {item:p, score:score};
  });
  return scored.filter(function(x){ return x.score > 0; })
    .sort(function(a,b){ return b.score - a.score || keyFn(a.item).localeCompare(keyFn(b.item)); });
}
