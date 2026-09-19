/* ============================================================
 * 02-editor-core.js
 * Per-block-type rendering (code, checkboxes, headings), navigation, trash, outline mutations (indent/outdent/reorder), caret helpers.
 *
 * Part of Nexus — loaded as a plain <script> (not a module) in
 * index.html, in numeric filename order. All files share one global
 * scope on purpose (same as the original single-file build), so
 * `state`, helper functions, etc. declared in an earlier file are
 * directly usable here without imports.
 * ============================================================ */
"use strict";

/* ============================================================
   FENCED CODE BLOCKS  ```lang\n ...code... \n```
   A block whose whole text matches this fence is rendered (in read
   mode) as a highlighted code widget instead of plain text — the
   same trick used above for {{query:}} / {{table:}}. Editing it
   shows the raw fenced text, same as query/table blocks do.
   ============================================================ */
var CODE_BLOCK_RE = /^```[ \t]*([a-zA-Z0-9_+#-]*)[ \t]*\n([\s\S]*?)\n?```$/;

/* ============================================================
   TO-DO / CHECKBOX BLOCKS
   A block whose text starts with "[ ] " or "[x] " renders as a
   real checkbox followed by the rest of the line (still fully
   formatted — bold, links, tags all still work). Clicking the
   checkbox flips done/not-done in place; clicking the ☑ button in
   a line's hover controls adds or removes the "[ ] " prefix, so a
   to-do can be created without typing anything.
   ============================================================ */
var TODO_RE = /^\[( |x|X)\]\s?([\s\S]*)$/;

function todoInfo(text){
  var m = text && text.match(TODO_RE);
  if(!m) return null;
  return {done: (m[1].toLowerCase() === 'x'), rest: m[2]};
}

/* ============================================================
   HEADINGS
   A block whose text starts with "# " through "###### " renders as a
   real heading (sized/weighted by level, same as Markdown) instead of
   plain text — inline formatting (bold, links, tags) still works in
   the rest of the line. Headings also get a fold behavior beyond the
   usual "collapse my own indented children": collapsing a heading
   hides every following *sibling* line up to (but not including) the
   next sibling heading of an equal or shallower level, the same way
   folding a heading works in a Markdown document — regardless of
   whether those lines are actually indented under it in the outline.
   ============================================================ */
var HEADING_RE = /^(#{1,6})[ \t]+([\s\S]*)$/;

function headingInfo(text){
  var m = text && text.match(HEADING_RE);
  if(!m) return null;
  return {level: m[1].length, rest: m[2]};
}
/* Cycle a line through no-heading -> H1 -> H2 -> H3 -> no-heading.
   Deeper levels (H4-6) are still available by typing "####" etc.
   directly — the toggle button only cycles the three most common. */
function cycleHeadingText(text){
  var info = headingInfo(text || '');
  if(!info) return '# ' + (text || '');
  if(info.level < 3) return '#'.repeat(info.level + 1) + ' ' + info.rest;
  return info.rest;
}

/* Todo due dates are stored inline in the block's own text, as a trailing
   `!due(YYYY-MM-DD)` marker on the line — no new field on the block/page
   schema, so due dates ride along for free through undo, sync, backup,
   and version history exactly like the rest of the line's text does. */
var TODO_DUE_RE = /\s*!due\((\d{4}-\d{2}-\d{2})\)\s*$/;
function splitTodoDue(rest){
  var m = rest && rest.match(TODO_DUE_RE);
  if(!m) return {clean: rest || '', due: null};
  return {clean: rest.slice(0, m.index), due: m[1]};
}
function setTodoDue(rest, dueOrNull){
  var clean = splitTodoDue(rest).clean;
  return dueOrNull ? (clean + ' !due(' + dueOrNull + ')') : clean;
}
function todoDueStatus(dueStr){
  if(!dueStr) return '';
  var today = new Date(); today.setHours(0,0,0,0);
  var due = new Date(dueStr + 'T00:00:00');
  if(due.getTime() < today.getTime()) return 'due-overdue';
  if(due.getTime() === today.getTime()) return 'due-today';
  return '';
}
function formatTodoDue(dueStr){
  var d = new Date(dueStr + 'T00:00:00');
  return d.toLocaleDateString(undefined, {month:'short', day:'numeric'});
}
/* Every todo with a due date of today or earlier, across every non-trashed
   page — used both for the "due today" reminder on open and could be
   reused anywhere else a flat due list is useful. */
function collectDueTodos(){
  var today = new Date(); today.setHours(0,0,0,0);
  var out = [];
  Object.keys(state.blocks).forEach(function(id){
    var b = state.blocks[id];
    var page = state.pages[b.pageId];
    if(!page || page.trashedAt) return;
    var info = todoInfo(b.text || '');
    if(!info || info.done) return;
    var parts = splitTodoDue(info.rest);
    if(!parts.due) return;
    var due = new Date(parts.due + 'T00:00:00');
    if(due.getTime() <= today.getTime()) out.push({blockId:id, pageId:b.pageId, pageTitle:page.title, text:parts.clean, due:parts.due, overdue: due.getTime() < today.getTime()});
  });
  return out;
}
/* Every to-do across every non-trashed page, done or not — powers the
   Tasks view. Unlike collectDueTodos() (due-or-overdue, not-done only,
   used for the reminder toast), this is the full flat list so the Tasks
   view can filter/sort/show-done itself. */
function collectAllTodos(){
  var out = [];
  Object.keys(state.blocks).forEach(function(id){
    var b = state.blocks[id];
    var page = state.pages[b.pageId];
    if(!page || page.trashedAt) return;
    var info = todoInfo(b.text || '');
    if(!info) return;
    var parts = splitTodoDue(info.rest);
    out.push({
      blockId: id,
      pageId: b.pageId,
      pageTitle: page.title,
      text: parts.clean,
      due: parts.due,
      done: info.done,
      overdue: !info.done && !!parts.due && todoDueStatus(parts.due) === 'due-overdue'
    });
  });
  return out;
}

/* A light, local, one-per-session nudge about anything due — not a real
   push notification (that needs a service worker + server), just a toast
   plus (if the person already granted permission) a Notification so it
   surfaces even if Nexus is in a background tab. */
var dueRemindersShownThisSession = false;
function checkTodoDueReminders(){
  if(dueRemindersShownThisSession) return;
  dueRemindersShownThisSession = true;
  var due = collectDueTodos();
  if(!due.length) return;
  var overdueCount = due.filter(function(d){ return d.overdue; }).length;
  var msg = due.length + ' to-do' + (due.length===1?'':'s') + ' due' + (overdueCount ? ' (' + overdueCount + ' overdue)' : ' today') + '.';
  toast(msg);
  if(window.Notification && Notification.permission === 'granted'){
    try{ new Notification('Nexus', {body: msg}); }catch(e){}
  }
}

function escapeRegExp(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

var CODE_LANG_ALIASES = {
  js:'javascript', jsx:'javascript', mjs:'javascript', cjs:'javascript',
  ts:'typescript', tsx:'typescript',
  py:'python', py3:'python',
  sh:'bash', shell:'bash', zsh:'bash', console:'bash',
  yml:'yaml',
  htm:'html', xml:'html',
  'c++':'cpp', h:'c', hpp:'cpp'
};

var CODE_LANG_CONFIG = {
  javascript:{kw:['break','case','catch','class','const','continue','debugger','default','delete','do','else','export','extends','finally','for','function','if','import','from','in','instanceof','let','new','return','super','switch','this','throw','try','typeof','var','void','while','with','yield','async','await','static','get','set','of','null','true','false','undefined'], lineComment:'//', blockComment:['/*','*/']},
  typescript:{kw:['break','case','catch','class','const','continue','debugger','default','delete','do','else','export','extends','finally','for','function','if','import','from','in','instanceof','let','new','return','super','switch','this','throw','try','typeof','var','void','while','with','yield','async','await','static','get','set','of','null','true','false','undefined','interface','type','implements','enum','namespace','readonly','public','private','protected','as'], lineComment:'//', blockComment:['/*','*/']},
  java:{kw:['abstract','assert','boolean','break','byte','case','catch','char','class','const','continue','default','do','double','else','enum','extends','final','finally','float','for','goto','if','implements','import','instanceof','int','interface','long','native','new','package','private','protected','public','return','short','static','strictfp','super','switch','synchronized','this','throw','throws','transient','try','void','volatile','while','true','false','null'], lineComment:'//', blockComment:['/*','*/']},
  c:{kw:['auto','break','case','char','const','continue','default','do','double','else','enum','extern','float','for','goto','if','int','long','register','return','short','signed','sizeof','static','struct','switch','typedef','union','unsigned','void','volatile','while','include','define'], lineComment:'//', blockComment:['/*','*/']},
  cpp:{kw:['auto','break','case','catch','char','class','const','continue','default','delete','do','double','else','enum','explicit','extern','float','for','friend','goto','if','inline','int','long','namespace','new','operator','private','protected','public','register','return','short','signed','sizeof','static','struct','switch','template','this','throw','try','typedef','typename','union','unsigned','using','virtual','void','volatile','while','true','false','nullptr','include'], lineComment:'//', blockComment:['/*','*/']},
  python:{kw:['False','None','True','and','as','assert','async','await','break','class','continue','def','del','elif','else','except','finally','for','from','global','if','import','in','is','lambda','nonlocal','not','or','pass','raise','return','try','while','with','yield','self'], lineComment:'#'},
  ruby:{kw:['begin','break','case','class','def','defined','do','else','elsif','end','ensure','false','for','if','in','module','next','nil','not','or','redo','rescue','retry','return','self','super','then','true','undef','unless','until','when','while','yield','require','require_relative'], lineComment:'#'},
  go:{kw:['break','case','chan','const','continue','default','defer','else','fallthrough','for','func','go','goto','if','import','interface','map','package','range','return','select','struct','switch','type','var','true','false','nil'], lineComment:'//', blockComment:['/*','*/']},
  rust:{kw:['as','break','const','continue','crate','dyn','else','enum','extern','false','fn','for','if','impl','in','let','loop','match','mod','move','mut','pub','ref','return','self','Self','static','struct','super','trait','true','type','unsafe','use','where','while'], lineComment:'//', blockComment:['/*','*/']},
  php:{kw:['abstract','and','array','as','break','case','catch','class','clone','const','continue','declare','default','do','echo','else','elseif','empty','endif','endforeach','endwhile','extends','final','finally','for','foreach','function','global','if','implements','include','instanceof','interface','isset','namespace','new','or','print','private','protected','public','require','return','static','switch','throw','trait','try','unset','use','var','while','xor','true','false','null'], lineComment:'//', blockComment:['/*','*/']},
  bash:{kw:['if','then','else','elif','fi','for','while','until','do','done','function','return','case','esac','in','echo','export','local','break','continue','exit','set'], lineComment:'#'},
  sql:{kw:['SELECT','FROM','WHERE','INSERT','INTO','VALUES','UPDATE','SET','DELETE','JOIN','LEFT','RIGHT','INNER','OUTER','FULL','ON','GROUP','BY','ORDER','HAVING','AS','AND','OR','NOT','NULL','CREATE','TABLE','PRIMARY','KEY','FOREIGN','REFERENCES','DROP','ALTER','LIMIT','DISTINCT','UNION','ALL','IN','EXISTS','BETWEEN','LIKE','CASE','WHEN','THEN','END','ASC','DESC','DEFAULT'], lineComment:'--', blockComment:['/*','*/'], caseInsensitiveKw:true},
  json:{kw:['true','false','null']},
  yaml:{kw:['true','false','null'], lineComment:'#'},
  swift:{kw:['associatedtype','class','deinit','enum','extension','fileprivate','func','import','init','inout','internal','let','open','operator','private','protocol','public','rethrows','static','struct','subscript','typealias','var','break','case','continue','default','defer','do','else','fallthrough','for','guard','if','in','repeat','return','switch','where','while','true','false','nil','self','Self'], lineComment:'//', blockComment:['/*','*/']},
  kotlin:{kw:['as','break','class','continue','do','else','false','for','fun','if','in','interface','is','null','object','package','return','super','this','throw','true','try','typealias','val','var','when','while','import'], lineComment:'//', blockComment:['/*','*/']}
};

function resolveCodeLang(lang){
  lang = (lang||'').toLowerCase();
  if(CODE_LANG_ALIASES[lang]) return CODE_LANG_ALIASES[lang];
  return lang;
}

/* Generic tokenizer driven by a per-language config of keywords and
   comment styles. Shared by every language that isn't HTML or CSS
   (those two need structural, not just lexical, highlighting). */
function highlightGeneric(code, cfg){
  cfg = cfg || {kw:[]};
  var kwSet = {};
  (cfg.kw||[]).forEach(function(k){ kwSet[cfg.caseInsensitiveKw ? k.toUpperCase() : k] = true; });
  var parts = [];
  if(cfg.blockComment) parts.push(escapeRegExp(cfg.blockComment[0]) + '[\\s\\S]*?' + escapeRegExp(cfg.blockComment[1]));
  if(cfg.lineComment) parts.push(escapeRegExp(cfg.lineComment) + '[^\\n]*');
  parts.push('"(?:\\\\.|[^"\\\\\\n])*"');
  parts.push("'(?:\\\\.|[^'\\\\\\n])*'");
  parts.push('`(?:\\\\.|[^`\\\\])*`');
  parts.push('\\b\\d+\\.?\\d*\\b');
  parts.push('\\b[A-Za-z_$][\\w$]*\\b');
  var re = new RegExp(parts.join('|'), 'g');
  var out = "", last = 0, m;
  while((m = re.exec(code))){
    out += escapeHtml(code.slice(last, m.index));
    var tok = m[0];
    var isComment = (cfg.blockComment && tok.indexOf(cfg.blockComment[0]) === 0) ||
                     (cfg.lineComment && tok.indexOf(cfg.lineComment) === 0);
    if(isComment){
      out += '<span class="tok-com">'+escapeHtml(tok)+'</span>';
    } else if(tok[0] === '"' || tok[0] === "'" || tok[0] === '`'){
      out += '<span class="tok-str">'+escapeHtml(tok)+'</span>';
    } else if(/^\d/.test(tok)){
      out += '<span class="tok-num">'+escapeHtml(tok)+'</span>';
    } else if(kwSet[cfg.caseInsensitiveKw ? tok.toUpperCase() : tok]){
      out += '<span class="tok-kw">'+escapeHtml(tok)+'</span>';
    } else if(code[re.lastIndex] === '('){
      out += '<span class="tok-fn">'+escapeHtml(tok)+'</span>';
    } else {
      out += escapeHtml(tok);
    }
    last = re.lastIndex;
  }
  out += escapeHtml(code.slice(last));
  return out;
}

function highlightHtml(code){
  var out = "", last = 0;
  var re = /<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>/g;
  var m;
  while((m = re.exec(code))){
    out += escapeHtml(code.slice(last, m.index));
    var token = m[0];
    if(token.slice(0,4) === '<!--'){
      out += '<span class="tok-com">'+escapeHtml(token)+'</span>';
    } else {
      var tagMatch = token.match(/^(<\/?)([a-zA-Z][\w:-]*)([\s\S]*?)(\/?>)$/);
      if(tagMatch){
        out += '<span class="tok-punc">'+escapeHtml(tagMatch[1])+'</span>';
        out += '<span class="tok-tag">'+escapeHtml(tagMatch[2])+'</span>';
        var rest = tagMatch[3];
        var attrRe = /([a-zA-Z_:][\w:.-]*)(\s*=\s*)("[^"]*"|'[^']*')|([a-zA-Z_:][\w:.-]*)/g;
        var alast = 0, am;
        while((am = attrRe.exec(rest))){
          out += escapeHtml(rest.slice(alast, am.index));
          if(am[1]){
            out += '<span class="tok-attr">'+escapeHtml(am[1])+'</span>'+escapeHtml(am[2])+'<span class="tok-str">'+escapeHtml(am[3])+'</span>';
          } else {
            out += '<span class="tok-attr">'+escapeHtml(am[4])+'</span>';
          }
          alast = attrRe.lastIndex;
        }
        out += escapeHtml(rest.slice(alast));
        out += '<span class="tok-punc">'+escapeHtml(tagMatch[4])+'</span>';
      } else {
        out += escapeHtml(token);
      }
    }
    last = re.lastIndex;
  }
  out += escapeHtml(code.slice(last));
  return out;
}

function highlightCss(code){
  var out = "", last = 0;
  var re = /\/\*[\s\S]*?\*\/|"[^"]*"|'[^']*'|#[0-9a-fA-F]{3,8}\b|([a-zA-Z-]+)(\s*:\s*)|\b\d+\.?\d*(px|em|rem|%|vh|vw|s|ms|deg|fr)?\b|([.#]?[a-zA-Z][\w-]*)(?=[^{}]*\{)/g;
  var m;
  while((m = re.exec(code))){
    out += escapeHtml(code.slice(last, m.index));
    var tok = m[0];
    if(tok.slice(0,2) === '/*'){
      out += '<span class="tok-com">'+escapeHtml(tok)+'</span>';
    } else if(tok[0] === '"' || tok[0] === "'"){
      out += '<span class="tok-str">'+escapeHtml(tok)+'</span>';
    } else if(m[1] !== undefined){
      out += '<span class="tok-attr">'+escapeHtml(m[1])+'</span>'+escapeHtml(m[2]);
    } else if(m[4] !== undefined){
      out += '<span class="tok-tag">'+escapeHtml(m[4])+'</span>';
    } else if(tok[0] === '#' || /^\d/.test(tok)){
      out += '<span class="tok-num">'+escapeHtml(tok)+'</span>';
    } else {
      out += escapeHtml(tok);
    }
    last = re.lastIndex;
  }
  out += escapeHtml(code.slice(last));
  return out;
}

function highlightCode(code, lang){
  var resolved = resolveCodeLang(lang);
  if(resolved === 'html') return highlightHtml(code);
  if(resolved === 'css') return highlightCss(code);
  var cfg = CODE_LANG_CONFIG[resolved];
  if(!cfg){
    /* Unknown/plain language: still light up strings, numbers and
       // comments so it doesn't look completely inert. */
    cfg = {kw:[], lineComment:'//'};
  }
  return highlightGeneric(code, cfg);
}

function renderCodeBlockWidget(container, lang, code){
  container.innerHTML = "";
  var box = document.createElement('div');
  box.className = 'code-block';

  var head = document.createElement('div');
  head.className = 'code-block-head';
  var label = document.createElement('span');
  label.textContent = lang ? lang : 'code';
  head.appendChild(label);
  var copyBtn = document.createElement('button');
  copyBtn.className = 'cb-copy';
  copyBtn.type = 'button';
  copyBtn.textContent = 'Copy';
  copyBtn.onclick = function(e){
    e.stopPropagation();
    var done = function(){ copyBtn.textContent = 'Copied'; setTimeout(function(){ copyBtn.textContent = 'Copy'; }, 1200); };
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(code).then(done, done);
    } else {
      done();
    }
  };
  head.appendChild(copyBtn);
  box.appendChild(head);

  var pre = document.createElement('pre');
  var codeEl = document.createElement('code');
  codeEl.innerHTML = highlightCode(code, lang);
  pre.appendChild(codeEl);
  box.appendChild(pre);

  container.appendChild(box);
}

/* Inserts a fresh ```\n\n``` block and lands the cursor on the
   empty line in between, ready to type or paste code into. */
function insertCodeBlockSpecial(){
  var page = state.pages[state.currentPageId];
  if(!page) return;
  var text = '```\n\n```';
  var id = uid();
  var nb = mkBlock(id, page.id, null, text);
  state.blocks[id] = nb;
  page.rootBlocks.push(id);
  save(); renderPage();
  focusBlock(id, 4);
}

function insertSpecialBlock(text){
  var page = state.pages[state.currentPageId];
  if(!page) return;
  var id = uid();
  var nb = mkBlock(id, page.id, null, text);
  state.blocks[id] = nb;
  page.rootBlocks.push(id);
  save(); renderPage();
  focusBlock(id, Math.max(0, text.length - 2));
}

function findPageByTitle(title){
  var id = state.titleIndex[title.toLowerCase()];
  return id ? state.pages[id] : null;
}

function resolvePage(title, type){
  var existing = findPageByTitle(title);
  if(existing) return existing;
  var id = uid();
  var resolvedType = type||'page';
  state.pages[id] = {id:id, title:title, type:resolvedType, createdAt:Date.now(), properties:[], rootBlocks:[], icon:defaultPageIcon(resolvedType), banner:resolvedType === 'daily' ? 'ocean' : 'none'};
  if(resolvedType === 'page' && typeof currentSettings !== 'undefined' && currentSettings.defaultPageView === 'doc'){
    state.pages[id].viewMode = 'doc';
  }
  state.titleIndex[title.toLowerCase()] = id;
  return state.pages[id];
}

function renameCascade(oldTitle, newTitle){
  if(oldTitle.toLowerCase() === newTitle.toLowerCase()) return;
  var escapedOld = oldTitle.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  Object.keys(state.blocks).forEach(function(id){
    var blk = state.blocks[id];
    if(!blk || typeof blk.text !== 'string') return;
    var testPattern = new RegExp("\\[\\[" + escapedOld + "\\]\\]", "i");
    if(testPattern.test(blk.text)){
      var replacePattern = new RegExp("\\[\\[" + escapedOld + "\\]\\]", "gi");
      blk.text = blk.text.replace(replacePattern, "[["+newTitle+"]]");
    }
  });
}

function dateTitle(d){
  var months=["January","February","March","April","May","June","July","August","September","October","November","December"];
  return months[d.getMonth()]+" "+d.getDate()+", "+d.getFullYear();
}

/* ---------- Daily notes: calendar view (sidebar) ----------
   An alternative to the flat "recent/all" list — a real month grid so
   it's easy to spot gaps or jump straight to "two Tuesdays ago" instead
   of scrolling a long list. Daily page titles are plain "Month D, YYYY"
   strings (see dateTitle above), which the JS Date constructor parses
   back natively, so no extra date field is needed on the page itself. */
var DAILY_VIEW_KEY = STORAGE_KEY + '_dailyviewmode';
var dailyViewMode = (function(){
  try{ return localStorage.getItem(DAILY_VIEW_KEY) || 'list'; }catch(e){ return 'list'; }
})();
var dailyCalCursor = new Date();
function isoLocal(d){
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function toggleDailyViewMode(){
  dailyViewMode = dailyViewMode === 'calendar' ? 'list' : 'calendar';
  try{ localStorage.setItem(DAILY_VIEW_KEY, dailyViewMode); }catch(e){}
  renderSidebar(document.getElementById('search-box').value);
}
function renderDailyCalendarWidget(dailyPages){
  var wrap = document.getElementById('daily-calendar');
  wrap.innerHTML = '';
  var byDate = {};
  dailyPages.forEach(function(p){
    var d = new Date(p.title);
    if(isNaN(d.getTime())) return;
    byDate[isoLocal(d)] = p.id;
  });
  var today = new Date(); today.setHours(0,0,0,0);
  var cal = document.createElement('div'); cal.className = 'daily-cal';
  var head = document.createElement('div'); head.className = 'daily-cal-head';
  var prevBtn = document.createElement('button'); prevBtn.type = 'button'; prevBtn.textContent = '‹';
  var titleEl = document.createElement('span'); titleEl.className = 'daily-cal-title';
  var nextBtn = document.createElement('button'); nextBtn.type = 'button'; nextBtn.textContent = '›';
  prevBtn.addEventListener('click', function(){ dailyCalCursor.setMonth(dailyCalCursor.getMonth()-1); renderDailyCalendarWidget(dailyPages); });
  nextBtn.addEventListener('click', function(){ dailyCalCursor.setMonth(dailyCalCursor.getMonth()+1); renderDailyCalendarWidget(dailyPages); });
  head.appendChild(prevBtn); head.appendChild(titleEl); head.appendChild(nextBtn);
  cal.appendChild(head);

  var grid = document.createElement('div'); grid.className = 'daily-cal-grid';
  ['S','M','T','W','T','F','S'].forEach(function(d){
    var dow = document.createElement('div'); dow.className = 'daily-cal-dow'; dow.textContent = d;
    grid.appendChild(dow);
  });
  titleEl.textContent = dailyCalCursor.toLocaleDateString(undefined, {month:'long', year:'numeric'});
  var firstOfMonth = new Date(dailyCalCursor.getFullYear(), dailyCalCursor.getMonth(), 1);
  var gridStart = new Date(firstOfMonth);
  gridStart.setDate(gridStart.getDate() - firstOfMonth.getDay());
  for(var i=0;i<42;i++){
    var d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate()+i);
    var cell = document.createElement('div'); cell.className = 'daily-cal-cell';
    if(d.getMonth() !== dailyCalCursor.getMonth()) cell.classList.add('other-month');
    if(d.getTime() === today.getTime()) cell.classList.add('today');
    var key = isoLocal(d);
    var hasNote = !!byDate[key];
    if(hasNote) cell.classList.add('has-note');
    cell.textContent = d.getDate();
    cell.title = hasNote ? 'Open ' + dateTitle(d) : 'Create ' + dateTitle(d);
    (function(dCopy){
      cell.addEventListener('click', function(){
        var p = resolvePage(dateTitle(dCopy), 'daily');
        save();
        openPage(p.id);
      });
    })(d);
    grid.appendChild(cell);
  }
  cal.appendChild(grid);
  wrap.appendChild(cal);
}
document.getElementById('toggle-daily-view').onclick = toggleDailyViewMode;

function toast(msg){
  var t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(function(){ t.classList.remove('show'); }, 2200);
}

/* ============================================================
   NAVIGATION
   ============================================================ */
var navHistory = [];
var navIndex = -1;
function pushHistory(pageId){
  if(navIndex >= 0 && navHistory[navIndex] === pageId) return;
  navHistory = navHistory.slice(0, navIndex+1);
  navHistory.push(pageId);
  navIndex = navHistory.length - 1;
  updateNavButtons();
}
function updateNavButtons(){
  var backBtn = document.getElementById('btn-nav-back');
  var fwdBtn = document.getElementById('btn-nav-forward');
  if(backBtn) backBtn.disabled = navIndex <= 0;
  if(fwdBtn) fwdBtn.disabled = navIndex >= navHistory.length - 1;
}
function goBack(){
  if(navIndex > 0){ navIndex--; openPage(navHistory[navIndex], true); updateNavButtons(); }
}
function goForward(){
  if(navIndex < navHistory.length - 1){ navIndex++; openPage(navHistory[navIndex], true); updateNavButtons(); }
}

function openPage(pageId, skipHistory){
  if(!state.pages[pageId]) return;
  if(typeof hideDashboardView === 'function') hideDashboardView();
  if(typeof hideFlashcardsView === 'function') hideFlashcardsView();
  if(typeof hideStickyNotesView === 'function') hideStickyNotesView();
  if(typeof hideZettelkastenView === 'function') hideZettelkastenView();
  state.currentPageId = pageId;
  document.getElementById('graph-view').classList.remove('visible');
  var tasksViewEl = document.getElementById('tasks-view');
  if(tasksViewEl) tasksViewEl.classList.remove('visible');
  document.getElementById('page-view').classList.add('visible');
  renderAll();
  save();
  if(!skipHistory) pushHistory(pageId);
  if(typeof closeSidebarIfNarrow === 'function') closeSidebarIfNarrow();
}

function openPageByTitle(title, type){
  var p = resolvePage(title, type);
  openPage(p.id);
}

function goToday(){
  var t = dateTitle(new Date());
  var p = resolvePage(t, 'daily');
  openPage(p.id);
}

/* ============================================================
   TRASH
   Deleting a page is a soft delete: the page and its lines stay in
   state, marked with trashedAt, and its title is freed up for reuse.
   Nothing is actually destroyed until the user empties the Trash or
   deletes an item forever, so a delete is always a one-click Restore
   away — on top of (not instead of) the regular ⌘Z undo stack.
   ============================================================ */
function livePages(){
  return Object.keys(state.pages).map(function(id){ return state.pages[id]; })
    .filter(function(p){ return !p.trashedAt; });
}
function trashedPages(){
  return Object.keys(state.pages).map(function(id){ return state.pages[id]; })
    .filter(function(p){ return !!p.trashedAt; })
    .sort(function(a,b){ return b.trashedAt - a.trashedAt; });
}

function trashPage(pageId){
  var page = state.pages[pageId];
  if(!page || page.trashedAt) return;
  page.trashedAt = Date.now();
  if(state.titleIndex[page.title.toLowerCase()] === pageId){
    delete state.titleIndex[page.title.toLowerCase()];
  }
}

function goToNextLivePageAfterRemoval(){
  var remaining = livePages();
  state.currentPageId = remaining.length ? remaining[0].id : null;
  if(!state.currentPageId){
    var np = resolvePage("Welcome to Nexus", 'page');
    state.currentPageId = np.id;
  }
}

function deleteCurrentPage(){
  var id = state.currentPageId;
  var page = state.pages[id];
  if(!page) return;
  if((typeof isPermanentDatabasePage === 'function' && isPermanentDatabasePage(page)) || (typeof isPermanentQueryPage === 'function' && isPermanentQueryPage(page)) || (typeof isPermanentStickyNotesPage === 'function' && isPermanentStickyNotesPage(page))){ toast(isPermanentQueryPage && isPermanentQueryPage(page) ? 'The default Queries workspace cannot be moved to Trash.' : 'The default Database workspace cannot be moved to Trash.'); return; }
  if(typeof currentSettings !== 'undefined' && currentSettings.confirmTrash === 'on'){
    if(!confirm('Move "'+page.title+'" to Trash?')) return;
  }
  trashPage(id);
  goToNextLivePageAfterRemoval();
  save();
  renderAll();
  toast('"'+page.title+'" moved to Trash.');
}

function restorePage(pageId){
  var page = state.pages[pageId];
  if(!page || !page.trashedAt) return;
  var key = page.title.toLowerCase();
  if(state.titleIndex[key] && state.titleIndex[key] !== pageId){
    /* another page claimed this title while it was trashed */
    var n = 2, base = page.title;
    while(state.titleIndex[(base+' ('+n+')').toLowerCase()]) n++;
    page.title = base + ' (' + n + ')';
    key = page.title.toLowerCase();
  }
  state.titleIndex[key] = pageId;
  delete page.trashedAt;
  save();
  renderAll();
  toast('Restored "'+page.title+'".');
}

function hardDeletePageBlocks(page){
  (function collectAndDelete(blockIds){
    blockIds.forEach(function(bid){
      var b = state.blocks[bid];
      if(b){ collectAndDelete(b.children); delete state.blocks[bid]; }
    });
  })(page.rootBlocks);
  delete state.pages[page.id];
  if(state.titleIndex[page.title.toLowerCase()] === page.id){
    delete state.titleIndex[page.title.toLowerCase()];
  }
}

function permanentlyDeletePage(pageId){
  var page = state.pages[pageId];
  if(!page) return;
  if((typeof isPermanentDatabasePage === 'function' && isPermanentDatabasePage(page)) || (typeof isPermanentQueryPage === 'function' && isPermanentQueryPage(page)) || (typeof isPermanentStickyNotesPage === 'function' && isPermanentStickyNotesPage(page))){ toast(isPermanentQueryPage && isPermanentQueryPage(page) ? 'The default Queries workspace is permanent.' : 'The default Database workspace is permanent.'); return; }
  if(!confirm('Permanently delete "'+page.title+'" and all its lines? This cannot be undone.')) return;
  hardDeletePageBlocks(page);
  if(state.currentPageId === pageId) goToNextLivePageAfterRemoval();
  save();
  renderAll();
  toast('Permanently deleted "'+page.title+'".');
}

function emptyTrash(){
  var trashed = trashedPages();
  if(!trashed.length){ toast('Trash is already empty.'); return; }
  if(!confirm('Permanently delete all '+trashed.length+' item(s) in Trash? This cannot be undone.')) return;
  trashed.forEach(hardDeletePageBlocks);
  if(!state.pages[state.currentPageId]) goToNextLivePageAfterRemoval();
  save();
  renderAll();
  toast('Trash emptied.');
}

/* ============================================================
   OUTLINE MUTATIONS
   ============================================================ */
function siblingsArrayOf(block){
  if(block.parent) return state.blocks[block.parent].children;
  return state.pages[block.pageId].rootBlocks;
}

function indexInSiblings(block){
  return siblingsArrayOf(block).indexOf(block.id);
}

/* True if targetId is blockId itself or lives anywhere in blockId's
   own subtree — used to stop a drag-and-drop from dropping a block
   onto (or into) one of its own descendants, which would orphan it. */
function isDescendantOrSelf(blockId, targetId){
  if(blockId === targetId) return true;
  var blk = state.blocks[blockId];
  if(!blk) return false;
  for(var i=0;i<blk.children.length;i++){
    if(isDescendantOrSelf(blk.children[i], targetId)) return true;
  }
  return false;
}

/* Moves `block` next to (or inside) `target` — used by drag-and-drop.
   position is 'before' / 'after' (becomes target's sibling) or
   'child' (becomes target's last child). Returns false (no-op) for
   any move that would be a no-op or create a cycle. */
function moveBlockRelative(blockId, targetId, position){
  var block = state.blocks[blockId];
  var target = state.blocks[targetId];
  if(!block || !target || block.id === target.id) return false;
  if(block.pageId !== target.pageId) return false;
  if(isDescendantOrSelf(block.id, target.id)) return false;

  var oldArr = siblingsArrayOf(block);
  var oldIdx = oldArr.indexOf(block.id);
  if(oldIdx > -1) oldArr.splice(oldIdx, 1);

  if(position === 'child'){
    block.parent = target.id;
    target.children.push(block.id);
    target.collapsed = false;
  } else {
    block.parent = target.parent;
    var newArr = siblingsArrayOf(target);
    var idx = newArr.indexOf(target.id);
    newArr.splice(position === 'before' ? idx : idx + 1, 0, block.id);
  }
  return true;
}

/* ---------- PWA share target ----------
   Handles the GET request that lands here when the person shares a link
   or selected text into Nexus from another app (see manifest.share_target
   in registerPwa). The shared content is appended as a new line on
   today's daily note, then the query string is stripped from the URL so
   a later reload doesn't re-add it. */
function handleIncomingShare(){
  var params = new URLSearchParams(location.search);
  var title = params.get('title'), text = params.get('text'), url = params.get('url');
  if(!title && !text && !url) return;
  var parts = [];
  if(title) parts.push(title);
  if(text) parts.push(text);
  if(url) parts.push(url);
  var line = parts.join(' — ');
  var todayPage = resolvePage(dateTitle(new Date()), 'daily');
  var id = uid();
  state.blocks[id] = mkBlock(id, todayPage.id, null, line);
  todayPage.rootBlocks.push(id);
  save();
  openPage(todayPage.id);
  toast('Added shared content to today\'s note.');
  history.replaceState(null, '', location.pathname);
}

function createBlockAfter(refBlock, text){
  var id = uid();
  var nb = mkBlock(id, refBlock.pageId, refBlock.parent, text||"");
  state.blocks[id] = nb;
  var arr = siblingsArrayOf(refBlock);
  arr.splice(arr.indexOf(refBlock.id)+1, 0, id);
  return nb;
}

function indentBlock(block){
  var arr = siblingsArrayOf(block);
  var idx = arr.indexOf(block.id);
  if(idx <= 0) return false;
  var newParentId = arr[idx-1];
  arr.splice(idx,1);
  var newParent = state.blocks[newParentId];
  newParent.children.push(block.id);
  block.parent = newParentId;
  newParent.collapsed = false;
  return true;
}

function outdentBlock(block){
  if(!block.parent) return false;
  var parent = state.blocks[block.parent];
  var grandArr = parent.parent ? state.blocks[parent.parent].children : state.pages[block.pageId].rootBlocks;
  var pIdx = grandArr.indexOf(parent.id);
  parent.children.splice(parent.children.indexOf(block.id),1);
  grandArr.splice(pIdx+1, 0, block.id);
  block.parent = parent.parent;
  return true;
}

function doIndent(block){
  var editingEl = document.querySelector('.block-content.editing');
  var wasEditingThis = editingBlockId === block.id && editingEl;
  var offset = 0;
  if(wasEditingThis){ offset = getCaretOffset(editingEl); block.text = serializeInline(editingEl); }
  if(indentBlock(block)){
    save(); renderPage();
    if(wasEditingThis) focusBlock(block.id, offset);
  }
}

function doOutdent(block){
  var editingEl = document.querySelector('.block-content.editing');
  var wasEditingThis = editingBlockId === block.id && editingEl;
  var offset = 0;
  if(wasEditingThis){ offset = getCaretOffset(editingEl); block.text = serializeInline(editingEl); }
  if(outdentBlock(block)){
    save(); renderPage();
    if(wasEditingThis) focusBlock(block.id, offset);
  }
}

/* Swaps a line with the sibling above (dir -1) or below (dir +1). This
   is the touch-friendly stand-in for drag-and-drop, which native HTML5
   drag can't do on a phone. Stays within the same parent — use
   indent/outdent to change level. Returns false at the top/bottom of
   its group. */
function canMoveBlockStep(block, dir){
  if(!block) return false;
  var arr = siblingsArrayOf(block);
  var idx = arr.indexOf(block.id);
  var to = idx + dir;
  return idx > -1 && to >= 0 && to < arr.length;
}
function moveBlockStep(block, dir){
  if(!canMoveBlockStep(block, dir)) return false;
  var arr = siblingsArrayOf(block);
  var idx = arr.indexOf(block.id);
  arr.splice(idx, 1);
  arr.splice(idx + dir, 0, block.id);
  return true;
}
function doMoveBlock(block, dir){
  var editingEl = document.querySelector('.block-content.editing');
  var wasEditingThis = editingBlockId === block.id && editingEl;
  var offset = 0;
  if(wasEditingThis){ offset = getCaretOffset(editingEl); block.text = serializeInline(editingEl); }
  if(moveBlockStep(block, dir)){
    save(); renderPage();
    if(wasEditingThis) focusBlock(block.id, offset);
  }
}

function deleteBlockMergeUp(block){
  var arr = siblingsArrayOf(block);
  var idx = arr.indexOf(block.id);
  if(idx > 0){
    var prev = state.blocks[arr[idx-1]];
    var mergeOffset = prev.text.length;
    prev.text = prev.text + block.text;
    block.children.forEach(function(cid){ state.blocks[cid].parent = prev.id; prev.children.push(cid); });
    arr.splice(idx,1);
    delete state.blocks[block.id];
    return {focusId: prev.id, offset: mergeOffset};
  } else if(block.parent){
    outdentBlockKeepText(block);
    return {focusId: block.id, offset:0};
  }
  return null;
}

function outdentBlockKeepText(block){ outdentBlock(block); }

/* ---------- Block-level clipboard (Cut / Copy / Paste on the "⋯" menu) ----------
   Cut/Copy detach a plain {text, children:[...]} snapshot of a block's own
   subtree into blockClipboard, independent of the original block ids, so the
   same clipboard can be pasted more than once — or onto a different page —
   without ever colliding with where it came from. Paste re-materializes
   that snapshot into real blocks with brand-new ids. */
function cloneBlockSubtree(block){
  return {
    text: block.text || '',
    children: (block.children || []).map(function(cid){
      return cloneBlockSubtree(state.blocks[cid]);
    })
  };
}

function subtreeNodeToLines(node, depth){
  var indent = '  '.repeat(depth);
  var textLines = (node.text || '').split('\n');
  var lines = [indent + '- ' + textLines[0]];
  for(var i=1;i<textLines.length;i++){ lines.push(indent + '  ' + textLines[i]); }
  node.children.forEach(function(child){
    lines = lines.concat(subtreeNodeToLines(child, depth + 1));
  });
  return lines;
}
function blockClipboardToText(node){
  return subtreeNodeToLines(node, 0).join('\n');
}

/* Re-materializes a cloned subtree as real blocks with fresh ids, and
   inserts the new top-level block as refBlock's next sibling (same
   parent as refBlock). Returns the new top-level block. */
function insertSubtreeAfter(node, refBlock){
  function build(n, pageId, parent){
    var id = uid();
    var nb = mkBlock(id, pageId, parent, n.text);
    state.blocks[id] = nb;
    n.children.forEach(function(child){
      nb.children.push(build(child, pageId, id));
    });
    return id;
  }
  var newId = build(node, refBlock.pageId, refBlock.parent);
  var arr = siblingsArrayOf(refBlock);
  arr.splice(arr.indexOf(refBlock.id) + 1, 0, newId);
  return state.blocks[newId];
}

/* Fully removes a block and its whole subtree — unlike deleteBlockMergeUp,
   which folds a single block's text into its previous sibling, this drops
   the block and everything nested under it. Returns where focus should
   land afterward (previous sibling, else next sibling, else parent), or
   null when nothing on the page is left to focus. */
function removeBlockSubtree(block){
  var arr = siblingsArrayOf(block);
  var idx = arr.indexOf(block.id);
  var focus = null;
  if(idx > 0){
    var prev = state.blocks[arr[idx - 1]];
    focus = {focusId: prev.id, offset: (prev.text || '').length};
  } else if(idx === 0 && arr.length > 1){
    focus = {focusId: arr[1], offset: 0};
  } else if(block.parent){
    var parentBlk = state.blocks[block.parent];
    focus = {focusId: parentBlk.id, offset: (parentBlk.text || '').length};
  }
  if(idx > -1) arr.splice(idx, 1);
  (function collectAndDelete(ids){
    ids.forEach(function(cid){
      var cb = state.blocks[cid];
      if(cb){ collectAndDelete(cb.children); delete state.blocks[cid]; }
    });
  })(block.children);
  delete state.blocks[block.id];
  return focus;
}

function flattenVisible(pageId){
  var page = state.pages[pageId];
  var out = [];
  function walk(ids){
    ids.forEach(function(id){
      var b = state.blocks[id];
      out.push(b);
      if(b.children.length && !b.collapsed) walk(b.children);
    });
  }
  walk(page.rootBlocks);
  return out;
}

/* ============================================================
   CARET HELPERS
   ============================================================ */
function getCaretOffset(el){
  var sel = window.getSelection();
  if(!sel.rangeCount || !el.contains(sel.anchorNode)) return 0;
  var target = sel.anchorNode, targetOffset = sel.anchorOffset;

  function visibleLength(node){
    return node ? node.textContent.length : 0;
  }
  function rawLength(node){
    if(node.nodeType === 3) return node.nodeValue.length;
    if(node.nodeType !== 1) return 0;
    var tag = node.tagName;
    if(node.classList && node.classList.contains('link')){
      return 4 + (node.dataset.target || node.textContent || '').length;
    }
    if(node.classList && node.classList.contains('blockref')){
      return 4 + (node.dataset.refid || '').length;
    }
    if(node.classList && node.classList.contains('transclusion')){
      return (node.dataset.transclusionRaw || '').length;
    }
    if(node.classList && node.classList.contains('att-img')){
      return 9 + (node.dataset.attId || '').length + (node.dataset.attName || '').length;
    }
    if(node.classList && node.classList.contains('att-file')){
      return 10 + (node.dataset.attId || '').length + (node.dataset.attName || '').length;
    }
    if(node.classList && node.classList.contains('hl-swatch')){
      var hlPre = ('{{mark:' + (node.dataset.color || '') + '|').length;
      return hlPre + 2 + Array.prototype.reduce.call(node.childNodes, function(n,c){ return n + rawLength(c); }, 0);
    }
    if(node.classList && node.classList.contains('clr-swatch')){
      var clPre = ('%%color:' + (node.dataset.color || '') + '|').length;
      return clPre + 2 + Array.prototype.reduce.call(node.childNodes, function(n,c){ return n + rawLength(c); }, 0);
    }
    if(tag === 'STRONG' || tag === 'B') return 4 + Array.prototype.reduce.call(node.childNodes, function(n,c){ return n + rawLength(c); }, 0);
    if(tag === 'EM' || tag === 'I') return 2 + Array.prototype.reduce.call(node.childNodes, function(n,c){ return n + rawLength(c); }, 0);
    if(tag === 'DEL' || tag === 'S' || tag === 'STRIKE') return 4 + Array.prototype.reduce.call(node.childNodes, function(n,c){ return n + rawLength(c); }, 0);
    if(tag === 'CODE') return 2 + node.textContent.length;
    if(tag === 'BR') return 1;
    return Array.prototype.reduce.call(node.childNodes, function(n,c){ return n + rawLength(c); }, 0);
  }
  function rawOffsetInside(node, off){
    if(node.nodeType === 3) return Math.min(off, node.nodeValue.length);
    if(node.nodeType !== 1) return 0;
    var tag = node.tagName;
    if(node.classList && node.classList.contains('link')){
      var len = (node.dataset.target || node.textContent || '').length;
      return 2 + Math.min(off, len);
    }
    if(node.classList && node.classList.contains('blockref')){
      return off <= 0 ? 0 : rawLength(node);
    }
    if(node.classList && node.classList.contains('transclusion')){
      return off <= 0 ? 0 : rawLength(node);
    }
    if(node.classList && node.classList.contains('att-img')) return off <= 0 ? 0 : rawLength(node);
    if(node.classList && node.classList.contains('att-file')) return off <= 0 ? 0 : rawLength(node);
    if(node.classList && node.classList.contains('hl-swatch')){
      var hlPre2 = ('{{mark:' + (node.dataset.color || '') + '|').length;
      var hlTotal = hlPre2;
      for(var hi=0; hi<off && hi<node.childNodes.length; hi++) hlTotal += rawLength(node.childNodes[hi]);
      return hlTotal;
    }
    if(node.classList && node.classList.contains('clr-swatch')){
      var clPre2 = ('%%color:' + (node.dataset.color || '') + '|').length;
      var clTotal = clPre2;
      for(var ci=0; ci<off && ci<node.childNodes.length; ci++) clTotal += rawLength(node.childNodes[ci]);
      return clTotal;
    }
    var prefix = (tag === 'STRONG' || tag === 'B') ? 2 :
                 (tag === 'EM' || tag === 'I') ? 1 :
                 (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') ? 2 :
                 (tag === 'CODE') ? 1 : 0;
    var total = prefix;
    for(var i=0;i<off && i<node.childNodes.length;i++) total += rawLength(node.childNodes[i]);
    return total;
  }
  function walk(node){
    if(node === target) return rawOffsetInside(node, targetOffset);
    if(node.nodeType === 1 && node.contains(target)){
      var total = 0;
      for(var i=0;i<node.childNodes.length;i++){
        var child = node.childNodes[i];
        if(child === target || (child.nodeType === 1 && child.contains(target))){
          return total + walk(child);
        }
        total += rawLength(child);
      }
    }
    return 0;
  }
  return walk(el);
}
function findTextNodeAtOffset(el, offset){
  var remaining = Math.max(0, offset);
  var result = null;

  function rawLength(node){
    if(node.nodeType === 3) return node.nodeValue.length;
    if(node.nodeType !== 1) return 0;
    var tag = node.tagName;
    if(node.classList && node.classList.contains('link')) return 4 + (node.dataset.target || node.textContent || '').length;
    if(node.classList && node.classList.contains('blockref')) return 4 + (node.dataset.refid || '').length;
    if(node.classList && node.classList.contains('transclusion')) return (node.dataset.transclusionRaw || '').length;
    if(node.classList && node.classList.contains('att-img')) return 9 + (node.dataset.attId || '').length + (node.dataset.attName || '').length;
    if(node.classList && node.classList.contains('att-file')) return 10 + (node.dataset.attId || '').length + (node.dataset.attName || '').length;
    if(node.classList && node.classList.contains('hl-swatch')) return ('{{mark:' + (node.dataset.color || '') + '|').length + 2 + Array.prototype.reduce.call(node.childNodes, function(n,c){ return n + rawLength(c); }, 0);
    if(node.classList && node.classList.contains('clr-swatch')) return ('%%color:' + (node.dataset.color || '') + '|').length + 2 + Array.prototype.reduce.call(node.childNodes, function(n,c){ return n + rawLength(c); }, 0);
    if(tag === 'STRONG' || tag === 'B') return 4 + Array.prototype.reduce.call(node.childNodes, function(n,c){ return n + rawLength(c); }, 0);
    if(tag === 'EM' || tag === 'I') return 2 + Array.prototype.reduce.call(node.childNodes, function(n,c){ return n + rawLength(c); }, 0);
    if(tag === 'DEL' || tag === 'S' || tag === 'STRIKE') return 4 + Array.prototype.reduce.call(node.childNodes, function(n,c){ return n + rawLength(c); }, 0);
    if(tag === 'CODE') return 2 + node.textContent.length;
    if(tag === 'BR') return 1;
    return Array.prototype.reduce.call(node.childNodes, function(n,c){ return n + rawLength(c); }, 0);
  }
  function visibleLength(node){ return node ? node.textContent.length : 0; }
  function locate(node){
    if(result) return;
    if(node.nodeType === 3){
      var len = node.nodeValue.length;
      if(remaining <= len){ result = {node:node, offset:remaining}; return; }
      remaining -= len;
      return;
    }
    if(node.nodeType !== 1) return;

    var tag = node.tagName;
    if(node.classList && node.classList.contains('link')){
      var visible = visibleLength(node), raw = rawLength(node);
      if(remaining <= visible){ result = {node:node.firstChild || node, offset:Math.min(remaining, visible)}; return; }
      remaining -= raw;
      return;
    }
    if(node.classList && node.classList.contains('transclusion')){
      var txRawLen = rawLength(node);
      if(remaining <= txRawLen){ result = {node:node, offset:0}; return; }
      remaining -= txRawLen;
      return;
    }
    if(node.classList && (node.classList.contains('blockref') || node.classList.contains('att-img') || node.classList.contains('att-file'))){
      if(remaining <= visibleLength(node)){ result = {node:node.firstChild || node, offset:0}; return; }
      remaining -= rawLength(node);
      return;
    }
    if(node.classList && node.classList.contains('hl-swatch')){
      var hlPre = ('{{mark:' + (node.dataset.color || '') + '|').length;
      if(remaining <= hlPre){
        var hlFirst = node.firstChild;
        if(hlFirst && hlFirst.nodeType === 3) result = {node:hlFirst, offset:0};
        else if(hlFirst) result = {node:hlFirst.firstChild || hlFirst, offset:0};
        return;
      }
      remaining -= hlPre;
      for(var hi=0; hi<node.childNodes.length; hi++) locate(node.childNodes[hi]);
      return;
    }
    if(node.classList && node.classList.contains('clr-swatch')){
      var clPre = ('%%color:' + (node.dataset.color || '') + '|').length;
      if(remaining <= clPre){
        var clFirst = node.firstChild;
        if(clFirst && clFirst.nodeType === 3) result = {node:clFirst, offset:0};
        else if(clFirst) result = {node:clFirst.firstChild || clFirst, offset:0};
        return;
      }
      remaining -= clPre;
      for(var ci=0; ci<node.childNodes.length; ci++) locate(node.childNodes[ci]);
      return;
    }
    var prefix = (tag === 'STRONG' || tag === 'B') ? 2 :
                 (tag === 'EM' || tag === 'I') ? 1 :
                 (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') ? 2 :
                 (tag === 'CODE') ? 1 : 0;
    if(prefix){
      if(remaining <= prefix){
        var first = node.firstChild;
        if(first && first.nodeType === 3) result = {node:first, offset:0};
        else if(first) result = {node:first.firstChild || first, offset:0};
        return;
      }
      remaining -= prefix;
    }
    for(var i=0;i<node.childNodes.length;i++) locate(node.childNodes[i]);
  }
  locate(el);
  if(result) return result;

  /* Empty content or an offset beyond the end: put the caret at the end. */
  var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  var last = null;
  while(walker.nextNode()) last = walker.currentNode;
  if(last) return {node:last, offset:last.nodeValue.length};
  var t = document.createTextNode('');
  el.appendChild(t);
  return {node:t, offset:0};
}

function setCaretOffset(el, offset){
  var range = document.createRange();
  var sel = window.getSelection();
  var pos = findTextNodeAtOffset(el, offset);
  range.setStart(pos.node, Math.min(pos.offset, pos.node.nodeValue ? pos.node.nodeValue.length : 0));
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}
