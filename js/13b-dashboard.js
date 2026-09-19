/* ============================================================
 * 13b-dashboard.js
 * Nexus Home Dashboard — a permanent live hub for the notebook.
 *
 * The dashboard is intentionally not a persisted page. It is a workspace
 * surface that reads the same notebook state as pages, tasks, databases,
 * queries and Data Health, so it never creates a second source of truth.
 * ============================================================ */
"use strict";

var dashboardVisible = false;

function dashboardSetViewActive(active){
  var btn = document.getElementById('btn-dashboard');
  if(btn){
    btn.classList.toggle('active', !!active);
    if(active) btn.setAttribute('aria-current','page');
    else btn.removeAttribute('aria-current');
  }
}

function hideDashboardView(){
  var view = document.getElementById('dashboard-view');
  if(view) view.classList.remove('visible');
  dashboardVisible = false;
  dashboardSetViewActive(false);
}

function showDashboardView(){
  if(typeof hideFlashcardsView === 'function') hideFlashcardsView();
  if(typeof hideStickyNotesView === 'function') hideStickyNotesView();
  var page = document.getElementById('page-view');
  var graph = document.getElementById('graph-view');
  var tasks = document.getElementById('tasks-view');
  var view = document.getElementById('dashboard-view');
  if(!view) return;
  if(page) page.classList.remove('visible');
  if(graph) graph.classList.remove('visible');
  if(tasks) tasks.classList.remove('visible');
  view.classList.add('visible');
  dashboardVisible = true;
  dashboardSetViewActive(true);
  renderDashboard();
  if(typeof closeSidebarIfNarrow === 'function') closeSidebarIfNarrow();
}

function dashboardButton(label, icon, action, meta){
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'dashboard-action-card';
  var ico = document.createElement('span'); ico.className='dashboard-action-icon'; ico.textContent=icon;
  var copy = document.createElement('span'); copy.className='dashboard-action-copy';
  var title = document.createElement('strong'); title.textContent=label; copy.appendChild(title);
  if(meta){ var sub=document.createElement('span'); sub.textContent=meta; copy.appendChild(sub); }
  b.appendChild(ico); b.appendChild(copy); b.onclick=action;
  return b;
}

function dashboardStat(value, label, icon, tone, action){
  var b = document.createElement('button');
  b.type='button';
  b.className='dashboard-stat ' + (tone||'');
  if(action) b.onclick=action;
  var top=document.createElement('div'); top.className='dashboard-stat-top';
  var i=document.createElement('span'); i.textContent=icon; i.className='dashboard-stat-icon';
  top.appendChild(i);
  var v=document.createElement('strong'); v.textContent=String(value); top.appendChild(v);
  var l=document.createElement('span'); l.className='dashboard-stat-label'; l.textContent=label;
  b.appendChild(top); b.appendChild(l);
  return b;
}

function existingDailyPage(){
  var title = dateTitle(new Date());
  return findPageByTitle(title);
}

function dashboardTaskSummary(tasks){
  var open = tasks.filter(function(t){ return !t.done; });
  var overdue = open.filter(function(t){ return t.bucket === 'overdue'; });
  var today = open.filter(function(t){ return t.bucket === 'today'; });
  return {all:tasks, open:open, overdue:overdue, today:today};
}

function dashboardOpenTasks(filter){
  if(typeof hideFlashcardsView === 'function') hideFlashcardsView();
  document.getElementById('dashboard-view').classList.remove('visible');
  dashboardVisible=false;
  dashboardSetViewActive(false);
  document.getElementById('page-view').classList.remove('visible');
  document.getElementById('graph-view').classList.remove('visible');
  document.getElementById('tasks-view').classList.add('visible');
  if(filter){
    tasksViewState.query = filter;
    var input=document.getElementById('tasks-search');
    if(input) input.value=filter;
  }
  renderTasksView();
  if(typeof closeSidebarIfNarrow === 'function') closeSidebarIfNarrow();
}

function dashboardOpenPage(pageId){
  hideDashboardView();
  openPage(pageId);
}

function renderDashboardStats(){
  var el=document.getElementById('dashboard-stats'); if(!el) return;
  el.innerHTML='';
  var pages=livePages().filter(function(p){ return !p.systemDatabasePage && !p.systemQueryPage; });
  var tasks=typeof collectTasks==='function' ? collectTasks() : [];
  var ts=dashboardTaskSummary(tasks);
  var dbs=typeof databaseEntries==='function' ? databaseEntries() : [];
  var qs=typeof queryEntries==='function' ? queryEntries() : [];
  var fcDue=typeof flashcardCards==='function' ? flashcardCards().filter(flashcardIsDue).length : 0;
  el.appendChild(dashboardStat(pages.length,'Live pages','▱','',function(){
    document.getElementById('search-box').value='';
    showDashboardView();
  }));
  el.appendChild(dashboardStat(ts.open.length,'Open tasks','☑',ts.overdue.length?'warning':'',function(){ dashboardOpenTasks(''); }));
  el.appendChild(dashboardStat(ts.today.length,'Due today','●',ts.today.length?'focus':'',function(){ dashboardOpenTasks('due:today'); }));
  el.appendChild(dashboardStat(dbs.length,'Databases','▤','',function(){ openDefaultDatabase(); }));
  el.appendChild(dashboardStat(qs.length,'Queries','⌕','',function(){ openDefaultQuery(); }));
  el.appendChild(dashboardStat(fcDue,'Due cards','▤',fcDue?'focus':'',function(){ showFlashcardsView(); }));
}

function renderDashboardFocus(){
  var wrap=document.getElementById('dashboard-focus-grid'); if(!wrap) return;
  wrap.innerHTML='';
  var daily=existingDailyPage();
  var tasks=typeof collectTasks==='function' ? collectTasks() : [];
  var ts=dashboardTaskSummary(tasks);

  var note=document.createElement('div'); note.className='dashboard-focus-card';
  var noteIcon=document.createElement('div'); noteIcon.className='dashboard-focus-icon'; noteIcon.textContent=daily ? (daily.icon || '📅') : '📅';
  note.appendChild(noteIcon);
  var noteCopy=document.createElement('div'); noteCopy.className='dashboard-focus-copy';
  var noteTitle=document.createElement('strong'); noteTitle.textContent=daily ? daily.title : 'Today’s note not created yet'; noteCopy.appendChild(noteTitle);
  var noteMeta=document.createElement('span'); noteMeta.textContent=daily ? ((daily.rootBlocks||[]).length + ((daily.rootBlocks||[]).length===1?' block':' blocks')) : 'Start a daily journal with one click'; noteCopy.appendChild(noteMeta);
  note.appendChild(noteCopy);
  var noteBtn=document.createElement('button'); noteBtn.type='button'; noteBtn.className='dashboard-inline-btn'; noteBtn.textContent=daily ? 'Open' : 'Create'; noteBtn.onclick=function(){ if(typeof openDailyToday==='function') openDailyToday(); else goToday(); };
  note.appendChild(noteBtn);
  wrap.appendChild(note);

  var task=document.createElement('div'); task.className='dashboard-focus-card';
  var taskIcon=document.createElement('div'); taskIcon.className='dashboard-focus-icon'; taskIcon.textContent=ts.overdue.length?'⚠':'☑'; task.appendChild(taskIcon);
  var taskCopy=document.createElement('div'); taskCopy.className='dashboard-focus-copy';
  var taskTitle=document.createElement('strong'); taskTitle.textContent=ts.today.length ? (ts.today.length+' task'+(ts.today.length===1?'':'s')+' due today') : 'No open tasks due today'; taskCopy.appendChild(taskTitle);
  var taskMeta=document.createElement('span'); taskMeta.textContent=ts.overdue.length ? ts.overdue.length+' overdue · '+ts.open.length+' open total' : ts.open.length+' open task'+(ts.open.length===1?'':'s')+' total'; taskCopy.appendChild(taskMeta);
  task.appendChild(taskCopy);
  var taskBtn=document.createElement('button'); taskBtn.type='button'; taskBtn.className='dashboard-inline-btn'; taskBtn.textContent='Tasks'; taskBtn.onclick=function(){ dashboardOpenTasks(ts.today.length?'due:today':''); };
  task.appendChild(taskBtn); wrap.appendChild(task);
}

function renderDashboardRecent(){
  var el=document.getElementById('dashboard-recent-pages'); if(!el) return;
  el.innerHTML='';
  var pages=livePages().filter(function(p){ return !p.hidden; }).sort(function(a,b){ return (b.updatedAt||b.createdAt||0)-(a.updatedAt||a.createdAt||0); });
  var currentId=state.currentPageId;
  var shown=pages.slice(0,6);
  if(!shown.length){ var empty=document.createElement('div'); empty.className='dashboard-empty'; empty.textContent='No pages yet.'; el.appendChild(empty); return; }
  shown.forEach(function(p){
    var row=document.createElement('button'); row.type='button'; row.className='dashboard-list-row' + (p.id===currentId?' current':'');
    var icon=document.createElement('span'); icon.className='dashboard-list-icon'; icon.textContent=p.icon || defaultPageIcon(p.type); row.appendChild(icon);
    var copy=document.createElement('span'); copy.className='dashboard-list-copy';
    var title=document.createElement('strong'); title.textContent=p.title; copy.appendChild(title);
    var meta=document.createElement('span'); meta.textContent=(p.type==='daily'?'Daily note':p.type==='tag'?'Tag':'Page')+' · '+new Date(p.updatedAt||p.createdAt||Date.now()).toLocaleDateString(); copy.appendChild(meta);
    row.appendChild(copy);
    var arrow=document.createElement('span'); arrow.textContent='→'; arrow.className='dashboard-list-arrow'; row.appendChild(arrow);
    row.onclick=function(){ dashboardOpenPage(p.id); };
    el.appendChild(row);
  });
}

function renderDashboardWorkspaces(){
  var el=document.getElementById('dashboard-workspaces'); if(!el) return;
  el.innerHTML='';
  var dbs=typeof databaseEntries==='function' ? databaseEntries() : [];
  var qs=typeof queryEntries==='function' ? queryEntries() : [];
  el.appendChild(dashboardButton('Tasks','☑',function(){dashboardOpenTasks('');},'Board · List · Gallery'));
  el.appendChild(dashboardButton('Database','▤',function(){openDefaultDatabase();},String(dbs.length)+' database'+(dbs.length===1?'':'s')+' indexed'));
  el.appendChild(dashboardButton('Queries','⌕',function(){openDefaultQuery();},String(qs.length)+' quer'+(qs.length===1?'y':'ies')+' indexed'));
  var fc=typeof flashcardCards==='function' ? flashcardCards() : []; el.appendChild(dashboardButton('Flashcards','▤',function(){showFlashcardsView();},String(fc.filter(flashcardIsDue).length)+' due now'));
  el.appendChild(dashboardButton('Graph view','◎',function(){hideDashboardView(); document.getElementById('graph-view').classList.add('visible'); renderGraph();},'Linked thinking map'));
  el.appendChild(dashboardButton('Search all notes','🔎',function(){hideDashboardView(); openGlobalSearch();},'Search every page and line'));
  el.appendChild(dashboardButton('Templates','▣',function(){hideDashboardView(); document.getElementById('search-box').focus();},'Create from reusable page patterns'));
}

function renderDashboardContinue(){
  var el=document.getElementById('dashboard-continue'); if(!el) return;
  el.innerHTML='';
  var page=state.pages[state.currentPageId];
  if(!page){ var e=document.createElement('div'); e.className='dashboard-empty'; e.textContent='No current page yet.'; el.appendChild(e); return; }
  var card=document.createElement('div'); card.className='dashboard-continue-card';
  var icon=document.createElement('div'); icon.className='dashboard-continue-icon'; icon.textContent=page.icon || defaultPageIcon(page.type); card.appendChild(icon);
  var copy=document.createElement('div'); copy.className='dashboard-continue-copy';
  var title=document.createElement('strong'); title.textContent=page.title; copy.appendChild(title);
  var meta=document.createElement('span'); meta.textContent=page.type==='daily'?'Daily journal':page.type==='tag'?'Tag page':'Last opened page'; copy.appendChild(meta);
  card.appendChild(copy);
  var btn=document.createElement('button'); btn.type='button'; btn.className='dashboard-inline-btn'; btn.textContent='Continue'; btn.onclick=function(){dashboardOpenPage(page.id);}; card.appendChild(btn);
  el.appendChild(card);
}

function renderDashboardHealth(){
  var el=document.getElementById('dashboard-health'); if(!el) return;
  el.innerHTML='';
  var status=(typeof nexusHealthState!=='undefined' && nexusHealthState) ? nexusHealthState : {kind:'saved',text:'Saved locally'};
  var badge=document.createElement('div'); badge.className='dashboard-health-status '+(status.kind||'saved');
  badge.textContent=(status.kind==='warning'?'⚠ ':status.kind==='error'?'! ':'✓ ')+(status.text||'Saved locally'); el.appendChild(badge);

  var meta=typeof loadMeta==='function' ? loadMeta() : {};
  var lastBackup=document.createElement('div'); lastBackup.className='dashboard-health-row';
  var l1=document.createElement('span'); l1.textContent='Last backup'; lastBackup.appendChild(l1);
  var v1=document.createElement('strong'); v1.textContent=meta.lastBackupAt ? new Date(meta.lastBackupAt).toLocaleString() : 'Not recorded'; lastBackup.appendChild(v1); el.appendChild(lastBackup);

  var online=document.createElement('div'); online.className='dashboard-health-row';
  var l2=document.createElement('span'); l2.textContent='Connection'; online.appendChild(l2);
  var v2=document.createElement('strong'); v2.textContent=navigator.onLine===false?'Offline — local saves continue':'Online'; online.appendChild(v2); el.appendChild(online);

  var gdrive=document.getElementById('gdrive-autosync-status');
  var drive=document.createElement('div'); drive.className='dashboard-health-row';
  var l3=document.createElement('span'); l3.textContent='Google Drive'; drive.appendChild(l3);
  var v3=document.createElement('strong'); v3.textContent=(gdrive && gdrive.textContent.trim()) || (typeof gdriveAutoSyncEnabled==='function' && gdriveAutoSyncEnabled()?'Auto-sync enabled':'Not syncing'); drive.appendChild(v3); el.appendChild(drive);
}

function renderDashboard(){
  if(!state) return;
  renderDashboardStats();
  renderDashboardFocus();
  renderDashboardRecent();
  renderDashboardWorkspaces();
  renderDashboardContinue();
  renderDashboardHealth();
}

function wireDashboard(){
  var btn=document.getElementById('btn-dashboard');
  if(btn) btn.onclick=showDashboardView;
  var brand=document.querySelector('.brand');
  if(brand){
    brand.setAttribute('role','button'); brand.setAttribute('tabindex','0'); brand.setAttribute('title','Open Dashboard');
    brand.addEventListener('click', showDashboardView);
    brand.addEventListener('keydown', function(e){ if(e.key==='Enter' || e.key===' '){ e.preventDefault(); showDashboardView(); } });
  }
  var today=document.getElementById('dashboard-today-btn'); if(today) today.onclick=function(){ if(typeof openDailyToday==='function') openDailyToday(); else goToday(); };
  var np=document.getElementById('dashboard-new-page-btn'); if(np) np.onclick=function(){ openPalette(); };
  var openDaily=document.getElementById('dashboard-open-daily'); if(openDaily) openDaily.onclick=function(){ if(typeof openDailyToday==='function') openDailyToday(); else goToday(); };
  var health=document.getElementById('dashboard-open-health'); if(health) health.onclick=openDataHealth;
}

function dashboardRefreshIfVisible(){ if(dashboardVisible) renderDashboard(); }

if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireDashboard); else wireDashboard();
