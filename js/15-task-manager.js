/* ============================================================
 * 15-task-manager.js
 * A full task manager built on the to-do lines that already exist —
 * it does not introduce a task record. A task IS a block whose text
 * starts with "[ ] ", and everything about it is stored inline in
 * that same text:
 *
 *   [ ] Draft the brief #work !p1 !due(2026-09-20) !every(1w)
 *
 *   !due(YYYY-MM-DD)  due date        (already existed)
 *   !p1 / !p2 / !p3   priority        (new)
 *   !every(Nd|w|m|y)  recurrence      (new)
 *   #tag              tag             (ordinary inline tag)
 *
 * Keeping it in the text is the whole trick: due dates, priorities and
 * recurrence ride through undo, LAN sync, Google Drive merge, backups
 * and version history with no schema change, and a line stays readable
 * and editable on its own page. Nothing here owns state that isn't
 * either in state.blocks or in tasksViewState (view preferences only).
 *
 * This file redefines renderTasksView(), replacing the simple list in
 * 03-sidebar-search-templates.js. It must load after that file and
 * before 14-wiring-and-init.js.
 * ============================================================ */
"use strict";

/* ============================================================
   INLINE MARKERS — read/write
   ============================================================ */
var TASK_PRI_RE  = /\s*!p([1-3])\b/;
var TASK_REP_RE  = /\s*!every\((\d+)([dwmy])\)/;

function taskPriOf(rest){ var m = (rest||'').match(TASK_PRI_RE); return m ? +m[1] : 0; }
function taskRepOf(rest){
  var m = (rest||'').match(TASK_REP_RE);
  return m ? {n:+m[1], unit:m[2]} : null;
}
function setTaskPri(rest, pri){
  var out = (rest||'').replace(TASK_PRI_RE, '');
  return pri ? out + ' !p' + pri : out;
}
function setTaskRep(rest, rep){
  var out = (rest||'').replace(TASK_REP_RE, '');
  return rep ? out + ' !every(' + rep.n + rep.unit + ')' : out;
}
/* The display text: the line with every marker stripped back out. */
function taskCleanText(rest){
  return splitTodoDue((rest||'').replace(TASK_PRI_RE,'').replace(TASK_REP_RE,'')).clean.trim();
}

var PRI_LABEL = {0:'None', 1:'High', 2:'Medium', 3:'Low'};
var REP_LABEL = {d:'day', w:'week', m:'month', y:'year'};

function ymd(d){
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function parseYmd(s){ return new Date(s + 'T00:00:00'); }
function startOfToday(){ var d = new Date(); d.setHours(0,0,0,0); return d; }
function addInterval(date, rep){
  var d = new Date(date.getTime());
  if(rep.unit === 'd') d.setDate(d.getDate() + rep.n);
  else if(rep.unit === 'w') d.setDate(d.getDate() + rep.n * 7);
  else if(rep.unit === 'm') d.setMonth(d.getMonth() + rep.n);
  else d.setFullYear(d.getFullYear() + rep.n);
  return d;
}
/* Which bucket a task falls in — the spine of both the board columns
   and the due filter, so the two can never disagree. */
function taskBucket(t){
  if(t.done) return 'done';
  if(!t.due) return 'someday';
  var today = startOfToday().getTime();
  var due = parseYmd(t.due).getTime();
  if(due < today) return 'overdue';
  if(due === today) return 'today';
  var week = startOfToday(); week.setDate(week.getDate() + 7);
  return due <= week.getTime() ? 'week' : 'later';
}
var BUCKETS = [
  {key:'overdue', label:'Overdue',      icon:'⚠'},
  {key:'today',   label:'Today',        icon:'●'},
  {key:'week',    label:'Next 7 days',  icon:'›'},
  {key:'later',   label:'Later',        icon:'·'},
  {key:'someday', label:'No date',      icon:'○'},
  {key:'done',    label:'Done',         icon:'✓'}
];

/* ============================================================
   COLLECT
   One pass over state.blocks, producing the shape everything else
   here reads. Locked lines (see 13a) are included but flagged, so
   they display and can be opened but never edited from here.
   ============================================================ */
function collectTasks(){
  var out = [];
  Object.keys(state.blocks).forEach(function(id){
    var b = state.blocks[id];
    var page = state.pages[b.pageId];
    if(!page || page.trashedAt) return;
    var info = todoInfo(b.text || '');
    if(!info) return;
    var rest = info.rest;
    var text = taskCleanText(rest);
    var tags = [];
    (text.match(/#([A-Za-z0-9_\-\/]+)/g) || []).forEach(function(t){ tags.push(t.slice(1).toLowerCase()); });
    var t = {
      id: id, pageId: b.pageId, pageTitle: page.title,
      text: text, raw: rest,
      due: splitTodoDue(rest).due,
      pri: taskPriOf(rest),
      rep: taskRepOf(rest),
      done: info.done,
      tags: tags,
      locked: (typeof blockIsLocked === 'function') && blockIsLocked(b),
      createdAt: b.createdAt || 0
    };
    t.bucket = taskBucket(t);
    t.overdue = t.bucket === 'overdue';
    out.push(t);
  });
  return out;
}

/* ============================================================
   WRITE
   Every mutation goes through here: it refuses locked lines, rewrites
   the one block's text, saves, and repaints both this view and the
   page underneath if it happens to be open.
   ============================================================ */
function updateTask(taskId, mutateRest){
  var b = state.blocks[taskId];
  if(!b) return false;
  if(typeof blockIsLocked === 'function' && blockIsLocked(b)){
    if(typeof lockedNudge === 'function') lockedNudge(b);
    return false;
  }
  var info = todoInfo(b.text || '');
  if(!info) return false;
  var res = mutateRest(info.rest, info.done);
  var rest = typeof res === 'string' ? res : res.rest;
  var done = typeof res === 'string' ? info.done : res.done;
  b.text = '[' + (done ? 'x' : ' ') + '] ' + rest.replace(/\s+/g,' ').trim();
  return true;
}
function commitTasks(pageId){
  save();
  renderTasksView();
  if(!pageId || state.currentPageId === pageId) renderPage();
  renderSidebar(document.getElementById('search-box').value);
}

/* Completing a recurring task doesn't tick it off — it rolls the due
   date forward by one interval and leaves it open, which is what
   "every week" has to mean for it to be worth marking at all. The
   roll is from the old due date (not today), so a weekly task stays
   on its weekday even when it's ticked late. */
function toggleTaskDone(taskId, wantDone){
  var t = null;
  var changed = updateTask(taskId, function(rest, done){
    var target = typeof wantDone === 'boolean' ? wantDone : !done;
    var rep = taskRepOf(rest);
    var due = splitTodoDue(rest).due;
    if(target && rep && due){
      var next = addInterval(parseYmd(due), rep);
      /* If it's been ignored for several cycles, roll past all of them
         rather than leaving it stuck in the past. */
      var today = startOfToday();
      while(next.getTime() < today.getTime()) next = addInterval(next, rep);
      t = ymd(next);
      return {rest: setTodoDue(rest, t), done: false};
    }
    return {rest: rest, done: target};
  });
  if(!changed) return;
  var blk = state.blocks[taskId];
  commitTasks(blk && blk.pageId);
  if(t) toast('Recurring task rolled forward to ' + formatTodoDue(t) + '.');
}

function setTaskDue(taskId, dueOrNull){
  if(updateTask(taskId, function(rest){ return setTodoDue(rest, dueOrNull); })){
    var b = state.blocks[taskId];
    commitTasks(b && b.pageId);
  }
}
function setTaskPriority(taskId, pri){
  if(updateTask(taskId, function(rest){ return setTaskPri(rest, pri); })){
    var b = state.blocks[taskId];
    commitTasks(b && b.pageId);
  }
}
function setTaskRepeat(taskId, rep){
  if(updateTask(taskId, function(rest){ return setTaskRep(rest, rep); })){
    var b = state.blocks[taskId];
    commitTasks(b && b.pageId);
  }
}

/* ============================================================
   VIEW STATE
   ============================================================ */
var tasksViewState = (typeof tasksViewState !== 'undefined' && tasksViewState) || {};
tasksViewState.query = tasksViewState.query || '';
tasksViewState.sort = (tasksViewState.sort && tasksViewState.sort !== 'due') ? tasksViewState.sort : 'smart';
tasksViewState.layout = ['board','list','gallery'].indexOf(tasksViewState.layout) !== -1 ? tasksViewState.layout : 'board';
tasksViewState.group = tasksViewState.group || 'due';
tasksViewState.status = tasksViewState.status || 'open';   /* open | done | all */
tasksViewState.pri = tasksViewState.pri || 'all';          /* all | 1 | 2 | 3 | none */
tasksViewState.page = tasksViewState.page || 'all';
tasksViewState.tag = tasksViewState.tag || 'all';
var taskSelection = {};

function tasksSortComparator(mode){
  var rank = {overdue:0, today:1, week:2, later:3, someday:4, done:5};
  return function(a,b){
    if(mode === 'due') return (a.due||'9999').localeCompare(b.due||'9999') || a.text.localeCompare(b.text);
    if(mode === 'pri') return (a.pri||9) - (b.pri||9) || (a.due||'9999').localeCompare(b.due||'9999');
    if(mode === 'page') return a.pageTitle.localeCompare(b.pageTitle) || a.text.localeCompare(b.text);
    if(mode === 'added') return (b.createdAt - a.createdAt) || String(b.id).localeCompare(String(a.id));
    /* "smart": bucket first, then priority, then due, then title —
       the order you'd actually work through a day in. */
    return rank[a.bucket] - rank[b.bucket]
        || (a.pri||9) - (b.pri||9)
        || (a.due||'9999').localeCompare(b.due||'9999')
        || a.text.localeCompare(b.text);
  };
}

/* The search box above the board takes the same advanced syntax as
   the sidebar search and {{query:}} (see 17-advanced-search.js) —
   #tag, page:, priority:, due:/before:/after:, is:overdue, /regex/,
   "OR", and so on — AND'd together with whatever the dropdowns above
   are set to. A plain word or phrase with no operators still just
   fuzzy-matches the task's text/page exactly as the old filter did. */
function filterTasks(all){
  var qstr = tasksViewState.query.trim();
  var parsed = parseAdvancedQuery(qstr);
  return all.filter(function(t){
    if(tasksViewState.status === 'open' && t.done) return false;
    if(tasksViewState.status === 'done' && !t.done) return false;
    if(tasksViewState.pri !== 'all'){
      if(tasksViewState.pri === 'none' ? t.pri !== 0 : t.pri !== +tasksViewState.pri) return false;
    }
    if(tasksViewState.page !== 'all' && t.pageId !== tasksViewState.page) return false;
    if(tasksViewState.tag !== 'all' && t.tags.indexOf(tasksViewState.tag) === -1) return false;
    if(qstr && !matchAdvancedQuery(parsed, searchRecordForTask(t)).match) return false;
    return true;
  }).sort(tasksSortComparator(tasksViewState.sort));
}

/* ============================================================
   QUICK ADD
   One line in, one to-do out, with the shorthand people already type:
     Pay rent #home !p1 due:friday every:1m >Money
   ">Page" picks the page (created if new); without one the task lands
   on today's daily note, which is where a thought you just had
   belongs by default.
   ============================================================ */
function parseDueWord(w){
  w = (w||'').toLowerCase();
  var today = startOfToday();
  if(/^\d{4}-\d{2}-\d{2}$/.test(w)) return w;
  if(w === 'today') return ymd(today);
  if(w === 'tomorrow' || w === 'tmr'){ var d = new Date(today); d.setDate(d.getDate()+1); return ymd(d); }
  var rel = w.match(/^\+(\d+)([dwm])$/);
  if(rel) return ymd(addInterval(today, {n:+rel[1], unit:rel[2]}));
  var days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  var idx = days.indexOf(w) !== -1 ? days.indexOf(w) : days.map(function(x){ return x.slice(0,3); }).indexOf(w);
  if(idx !== -1){
    var n = new Date(today);
    var delta = (idx - n.getDay() + 7) % 7 || 7; /* always the *next* one */
    n.setDate(n.getDate() + delta);
    return ymd(n);
  }
  return null;
}

function quickAddTask(input){
  var text = (input||'').trim();
  if(!text) return;
  var pageTitle = null, due = null, pri = 0, rep = null;
  text = text.replace(/\s*>([^>]+)$/, function(_, p){ pageTitle = p.trim(); return ''; });
  text = text.replace(/\s*\bdue:(\S+)/i, function(_, w){ var d = parseDueWord(w); if(d){ due = d; return ''; } return _; });
  text = text.replace(/\s*\bevery:(\d+)([dwmy])\b/i, function(_, n, u){ rep = {n:+n, unit:u.toLowerCase()}; return ''; });
  text = text.replace(TASK_PRI_RE, function(_, p){ pri = +p; return ''; });
  text = text.trim();
  if(!text){ toast('Give the task some words as well as its dates.'); return; }

  var page = pageTitle ? resolvePage(pageTitle, 'page') : resolvePage(dateTitle(new Date()), 'daily');
  if(page.locked){ toast('"' + page.title + '" is locked — unlock it to add tasks.'); return; }
  var rest = text;
  if(pri) rest = setTaskPri(rest, pri);
  if(rep) rest = setTaskRep(rest, rep);
  if(due) rest = setTodoDue(rest, due);

  var id = uid();
  state.blocks[id] = mkBlock(id, page.id, null, '[ ] ' + rest);
  page.rootBlocks.push(id);
  save();
  renderTasksView();
  renderSidebar(document.getElementById('search-box').value);
  if(state.currentPageId === page.id) renderPage();
  toast('Added to "' + page.title + '".');
}

/* ============================================================
   RENDER
   ============================================================ */
function tasksGroupsOf(list){
  var g = tasksViewState.layout === 'board' ? tasksViewState.group : tasksViewState.group;
  var groups = [];
  function push(key, label, items){ if(items.length || g === 'due') groups.push({key:key, label:label, items:items}); }
  if(g === 'due'){
    BUCKETS.forEach(function(b){
      var items = list.filter(function(t){ return t.bucket === b.key; });
      if(b.key === 'done' && tasksViewState.status === 'open') return;
      push(b.key, b.icon + ' ' + b.label, items);
    });
  } else if(g === 'pri'){
    [1,2,3,0].forEach(function(p){
      push('p'+p, p ? PRI_LABEL[p] + ' priority' : 'No priority',
        list.filter(function(t){ return t.pri === p; }));
    });
  } else if(g === 'page'){
    var seen = {};
    list.forEach(function(t){ seen[t.pageId] = t.pageTitle; });
    Object.keys(seen).sort(function(a,b){ return seen[a].localeCompare(seen[b]); }).forEach(function(pid){
      push('pg'+pid, seen[pid], list.filter(function(t){ return t.pageId === pid; }));
    });
  } else { /* tag */
    var tagSeen = {}, untagged = [];
    list.forEach(function(t){
      if(!t.tags.length){ untagged.push(t); return; }
      t.tags.forEach(function(tg){ (tagSeen[tg] = tagSeen[tg] || []).push(t); });
    });
    Object.keys(tagSeen).sort().forEach(function(tg){ push('tg'+tg, '#' + tg, tagSeen[tg]); });
    push('tg-none', 'Untagged', untagged);
  }
  return groups.filter(function(gr){ return gr.items.length || tasksViewState.layout === 'board'; });
}

function taskCard(t){
  var card = document.createElement('div');
  card.className = 'task-card' + (t.done ? ' is-done' : '') + (t.overdue ? ' is-overdue' : '') +
                   (t.locked ? ' is-locked' : '') + (t.pri ? ' pri-' + t.pri : '');

  var sel = document.createElement('input');
  sel.type = 'checkbox';
  sel.className = 'task-select';
  sel.checked = !!taskSelection[t.id];
  sel.title = 'Select for bulk actions';
  sel.onclick = function(e){
    e.stopPropagation();
    if(sel.checked) taskSelection[t.id] = true; else delete taskSelection[t.id];
    renderTasksView();
  };
  card.appendChild(sel);

  var cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'todo-checkbox';
  cb.checked = t.done;
  cb.disabled = t.locked;
  cb.title = t.rep ? 'Completing this rolls it forward one ' + REP_LABEL[t.rep.unit] : 'Mark done';
  cb.onclick = function(e){ e.stopPropagation(); toggleTaskDone(t.id); };
  card.appendChild(cb);

  var main = document.createElement('div');
  main.className = 'task-main';
  var txt = document.createElement('div');
  txt.className = 'task-text' + (t.done ? ' todo-done-text' : '');
  txt.innerHTML = decorateText(t.text);
  main.appendChild(txt);

  var meta = document.createElement('div');
  meta.className = 'task-meta';

  if(t.pri){
    var pc = document.createElement('span');
    pc.className = 'task-chip pri-chip p' + t.pri;
    pc.textContent = '!' + PRI_LABEL[t.pri];
    meta.appendChild(pc);
  }
  var dueBtn = document.createElement('button');
  dueBtn.type = 'button';
  dueBtn.className = 'task-chip due-chip ' + (t.due ? todoDueStatus(t.due) : 'is-empty');
  dueBtn.textContent = t.due ? '📅 ' + formatTodoDue(t.due) : '📅 add date';
  dueBtn.disabled = t.locked;
  dueBtn.onclick = function(e){
    e.stopPropagation();
    openTodoDuePopover(dueBtn, state.blocks[t.id], t.due, function(){ commitTasks(t.pageId); });
  };
  meta.appendChild(dueBtn);

  if(t.rep){
    var rc = document.createElement('span');
    rc.className = 'task-chip rep-chip';
    rc.textContent = '↻ every ' + (t.rep.n > 1 ? t.rep.n + ' ' + REP_LABEL[t.rep.unit] + 's' : REP_LABEL[t.rep.unit]);
    meta.appendChild(rc);
  }
  if(t.locked){
    var lc = document.createElement('span');
    lc.className = 'task-chip';
    lc.textContent = '🔒 locked';
    meta.appendChild(lc);
  }

  var pageLink = document.createElement('button');
  pageLink.type = 'button';
  pageLink.className = 'task-page-link';
  pageLink.textContent = t.pageTitle;
  pageLink.title = 'Open this line in its page';
  pageLink.onclick = function(){
    document.getElementById('tasks-view').classList.remove('visible');
    document.getElementById('page-view').classList.add('visible');
    revealBlock(t.id);
  };
  meta.appendChild(pageLink);

  var more = document.createElement('button');
  more.type = 'button';
  more.className = 'task-more';
  more.textContent = '⋯';
  more.title = 'Priority, repeat, and more';
  more.onclick = function(e){ e.stopPropagation(); openTaskMenu(t, e.clientX, e.clientY); };
  meta.appendChild(more);

  main.appendChild(meta);
  card.appendChild(main);
  return card;
}

/* Reuses the shared dropdown from 13-slash-and-context-menus.js, so a
   task's menu looks and behaves like every other menu in the app. */
function openTaskMenu(t, x, y){
  var items = [{header: t.text.slice(0, 40) || 'Task'}];
  items.push({icon:'☑', label: t.done ? 'Mark not done' : 'Mark done', disabled:t.locked,
    onClick:function(){ toggleTaskDone(t.id); }});
  items.push({divider:true});
  items.push({header:'Priority'});
  [1,2,3,0].forEach(function(p){
    items.push({icon: t.pri === p ? '•' : ' ', label: p ? PRI_LABEL[p] : 'Clear priority',
      disabled:t.locked, onClick:function(){ setTaskPriority(t.id, p); }});
  });
  items.push({divider:true});
  items.push({header:'Repeat'});
  [{n:1,unit:'d',l:'Every day'},{n:1,unit:'w',l:'Every week'},{n:2,unit:'w',l:'Every 2 weeks'},
   {n:1,unit:'m',l:'Every month'},{n:1,unit:'y',l:'Every year'}].forEach(function(r){
    var on = t.rep && t.rep.n === r.n && t.rep.unit === r.unit;
    items.push({icon: on ? '•' : ' ', label: r.l, disabled:t.locked,
      onClick:function(){ setTaskRepeat(t.id, {n:r.n, unit:r.unit}); }});
  });
  if(t.rep) items.push({icon:'✕', label:'Stop repeating', disabled:t.locked,
    onClick:function(){ setTaskRepeat(t.id, null); }});
  items.push({divider:true});
  items.push({icon:'📅', label:'Due today', disabled:t.locked, onClick:function(){ setTaskDue(t.id, ymd(startOfToday())); }});
  items.push({icon:'→', label:'Push to tomorrow', disabled:t.locked, onClick:function(){
    var d = t.due ? parseYmd(t.due) : startOfToday();
    var base = d.getTime() < startOfToday().getTime() ? startOfToday() : d;
    setTaskDue(t.id, ymd(addInterval(base, {n:1, unit:'d'})));
  }});
  items.push({icon:'✕', label:'Clear due date', disabled:t.locked || !t.due, onClick:function(){ setTaskDue(t.id, null); }});
  items.push({divider:true});
  items.push({icon:'↗', label:'Open in its page', onClick:function(){
    document.getElementById('tasks-view').classList.remove('visible');
    document.getElementById('page-view').classList.add('visible');
    revealBlock(t.id);
  }});
  openCtxMenu(items, x, y);
}

/* Gallery is intentionally a presentation mode over the same task data
   and grouping/filtering pipeline as Board and List. This keeps every task
   action, bulk operation and advanced filter identical across layouts. */
function renderTasksView(){
  var listEl = document.getElementById('tasks-list');
  if(!listEl) return;
  var all = collectTasks();
  var visible = filterTasks(all);

  renderTaskFilters(all);
  renderTaskSummary(all, visible);
  renderTaskBulkBar(visible);

  listEl.innerHTML = '';
  listEl.className = tasksViewState.layout === 'board' ? 'tasks-board' :
                      (tasksViewState.layout === 'gallery' ? 'tasks-gallery' : 'tasks-list');

  if(!visible.length && (tasksViewState.layout === 'list' || tasksViewState.layout === 'gallery')){
    var empty = document.createElement('div');
    empty.className = 'tasks-empty';
    empty.textContent = all.length
      ? 'Nothing matches these filters.'
      : 'No tasks yet — add one above, or turn any line into a to-do with the ☐ item in its ⋯ menu.';
    listEl.appendChild(empty);
    return;
  }

  tasksGroupsOf(visible).forEach(function(g){
    var col = document.createElement('div');
    col.className = 'task-group';
    var head = document.createElement('div');
    head.className = 'task-group-head';
    var label = document.createElement('span');
    label.textContent = g.label;
    var count = document.createElement('span');
    count.className = 'task-group-count';
    count.textContent = String(g.items.length);
    head.appendChild(label);
    head.appendChild(count);
    col.appendChild(head);
    if(!g.items.length){
      var none = document.createElement('div');
      none.className = 'task-group-empty';
      none.textContent = '—';
      col.appendChild(none);
    }
    g.items.forEach(function(t){ col.appendChild(taskCard(t)); });
    listEl.appendChild(col);
  });
}

function renderTaskSummary(all, visible){
  var el = document.getElementById('tasks-summary');
  if(!el) return;
  var open = all.filter(function(t){ return !t.done; });
  var overdue = all.filter(function(t){ return t.bucket === 'overdue'; }).length;
  var today = all.filter(function(t){ return t.bucket === 'today'; }).length;
  var done = all.length - open.length;
  var pct = all.length ? Math.round(done / all.length * 100) : 0;
  el.innerHTML = '';
  [[open.length, 'open'], [overdue, 'overdue', overdue ? 'bad' : ''], [today, 'due today'],
   [done, 'done'], [pct + '%', 'complete']].forEach(function(s){
    var stat = document.createElement('span');
    stat.className = 'task-stat' + (s[2] ? ' ' + s[2] : '');
    stat.innerHTML = '<b>' + s[0] + '</b> ' + s[1];
    el.appendChild(stat);
  });
  var shown = document.createElement('span');
  shown.className = 'task-stat muted';
  shown.textContent = 'showing ' + visible.length;
  el.appendChild(shown);
}

/* The page and tag dropdowns are rebuilt from whatever tasks exist, so
   they never offer a filter that would return nothing. */
function renderTaskFilters(all){
  var pageSel = document.getElementById('tasks-page');
  var tagSel = document.getElementById('tasks-tag');
  if(pageSel){
    var pages = {};
    all.forEach(function(t){ pages[t.pageId] = t.pageTitle; });
    var pageIds = Object.keys(pages).sort(function(a,b){ return pages[a].localeCompare(pages[b]); });
    if(pageSel.dataset.sig !== pageIds.join(',')){
      pageSel.dataset.sig = pageIds.join(',');
      pageSel.innerHTML = '<option value="all">All pages</option>';
      pageIds.forEach(function(id){
        var o = document.createElement('option'); o.value = id; o.textContent = pages[id];
        pageSel.appendChild(o);
      });
    }
    if(tasksViewState.page !== 'all' && !pages[tasksViewState.page]) tasksViewState.page = 'all';
    pageSel.value = tasksViewState.page;
  }
  if(tagSel){
    var tags = {};
    all.forEach(function(t){ t.tags.forEach(function(x){ tags[x] = 1; }); });
    var tagList = Object.keys(tags).sort();
    if(tagSel.dataset.sig !== tagList.join(',')){
      tagSel.dataset.sig = tagList.join(',');
      tagSel.innerHTML = '<option value="all">All tags</option>';
      tagList.forEach(function(x){
        var o = document.createElement('option'); o.value = x; o.textContent = '#' + x;
        tagSel.appendChild(o);
      });
    }
    if(tasksViewState.tag !== 'all' && !tags[tasksViewState.tag]) tasksViewState.tag = 'all';
    tagSel.value = tasksViewState.tag;
  }
}

/* ============================================================
   BULK ACTIONS
   The bar only exists while something is selected, and every action
   runs through updateTask, so locked lines are skipped and reported
   rather than silently ignored.
   ============================================================ */
function selectedTaskIds(visible){
  var ids = {};
  visible.forEach(function(t){ if(taskSelection[t.id]) ids[t.id] = true; });
  return Object.keys(ids);
}
function bulkApply(ids, fn, verb){
  var n = 0, blocked = 0;
  ids.forEach(function(id){
    var b = state.blocks[id];
    if(typeof blockIsLocked === 'function' && blockIsLocked(b)){ blocked++; return; }
    if(updateTask(id, fn)) n++;
  });
  taskSelection = {};
  save();
  renderTasksView();
  renderPage();
  toast(n + ' task' + (n === 1 ? '' : 's') + ' ' + verb +
    (blocked ? ' — ' + blocked + ' skipped (locked)' : '') + '.');
}

function renderTaskBulkBar(visible){
  var bar = document.getElementById('tasks-bulk');
  if(!bar) return;
  var ids = selectedTaskIds(visible);
  if(!ids.length){ bar.style.display = 'none'; bar.innerHTML = ''; return; }
  bar.style.display = '';
  bar.innerHTML = '';
  var label = document.createElement('span');
  label.className = 'tasks-bulk-label';
  label.textContent = ids.length + ' selected';
  bar.appendChild(label);

  function act(text, fn, verb){
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.onclick = function(){ bulkApply(ids, fn, verb); };
    bar.appendChild(b);
  }
  act('Mark done', function(rest){ return {rest:rest, done:true}; }, 'marked done');
  act('Mark open', function(rest){ return {rest:rest, done:false}; }, 'reopened');
  act('Due today', function(rest){ return setTodoDue(rest, ymd(startOfToday())); }, 'due today');
  act('Push a day', function(rest){
    var due = splitTodoDue(rest).due;
    var base = due ? parseYmd(due) : startOfToday();
    if(base.getTime() < startOfToday().getTime()) base = startOfToday();
    return setTodoDue(rest, ymd(addInterval(base, {n:1, unit:'d'})));
  }, 'pushed a day');
  act('High priority', function(rest){ return setTaskPri(rest, 1); }, 'set to high');
  act('Clear priority', function(rest){ return setTaskPri(rest, 0); }, 'cleared');
  act('Clear date', function(rest){ return setTodoDue(rest, null); }, 'cleared');

  var clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'tasks-bulk-clear';
  clear.textContent = 'Deselect';
  clear.onclick = function(){ taskSelection = {}; renderTasksView(); };
  bar.appendChild(clear);
}

/* ============================================================
   WIRING
   Done here rather than in 14 so this whole feature stays in one
   file; 14 still owns opening/closing the view itself.
   ============================================================ */
function wireTaskManager(){
  /* The view's state outlives a repaint, so the controls are set from
     it rather than the other way round — otherwise the markup's
     default selection would silently disagree with what's shown. */
  [['tasks-search','query'],['tasks-sort','sort'],['tasks-group','group'],
   ['tasks-status','status'],['tasks-pri','pri']].forEach(function(pair){
    var el = document.getElementById(pair[0]);
    if(el) el.value = tasksViewState[pair[1]];
  });
  var layoutBtn = document.getElementById('tasks-layout');
  function setTaskLayoutLabel(){
    var btn = document.getElementById('tasks-layout');
    if(!btn) return;
    var labels = {board:'\u25a4 Board', list:'\u2630 List', gallery:'\u25a6 Gallery'};
    btn.textContent = labels[tasksViewState.layout] || labels.board;
    btn.title = 'Switch task layout (Board, List, Gallery)';
    btn.setAttribute('aria-label', 'Task layout: ' + (tasksViewState.layout === 'board' ? 'Board' : tasksViewState.layout === 'list' ? 'List' : 'Gallery') + '. Click to switch.');
  }
  setTaskLayoutLabel();

  function on(id, ev, fn){
    var el = document.getElementById(id);
    if(el) el.addEventListener(ev, fn);
  }
  on('tasks-search', 'input', function(e){ tasksViewState.query = e.target.value; renderTasksView(); });
  on('tasks-sort', 'change', function(e){ tasksViewState.sort = e.target.value; renderTasksView(); });
  on('tasks-group', 'change', function(e){ tasksViewState.group = e.target.value; renderTasksView(); });
  on('tasks-status', 'change', function(e){ tasksViewState.status = e.target.value; renderTasksView(); });
  on('tasks-pri', 'change', function(e){ tasksViewState.pri = e.target.value; renderTasksView(); });
  on('tasks-page', 'change', function(e){ tasksViewState.page = e.target.value; renderTasksView(); });
  on('tasks-tag', 'change', function(e){ tasksViewState.tag = e.target.value; renderTasksView(); });
  on('tasks-layout', 'click', function(){
    var order = ['board','list','gallery'];
    var i = order.indexOf(tasksViewState.layout);
    tasksViewState.layout = order[(i + 1) % order.length];
    setTaskLayoutLabel();
    renderTasksView();
  });
  on('tasks-quickadd', 'keydown', function(e){
    if(e.key !== 'Enter') return;
    e.preventDefault();
    quickAddTask(e.target.value);
    e.target.value = '';
  });
  on('tasks-quickadd-btn', 'click', function(){
    var input = document.getElementById('tasks-quickadd');
    quickAddTask(input.value);
    input.value = '';
    input.focus();
  });
  on('tasks-clear-filters', 'click', function(){
    tasksViewState.query = '';
    tasksViewState.status = 'open';
    tasksViewState.pri = 'all';
    tasksViewState.page = 'all';
    tasksViewState.tag = 'all';
    var s = document.getElementById('tasks-search'); if(s) s.value = '';
    ['tasks-status','tasks-pri'].forEach(function(id){
      var el = document.getElementById(id); if(el) el.value = id === 'tasks-status' ? 'open' : 'all';
    });
    renderTasksView();
  });
}
document.addEventListener('DOMContentLoaded', wireTaskManager);
if(document.readyState !== 'loading') wireTaskManager();
