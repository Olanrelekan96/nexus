/* ============================================================
 * 31-command-center.js
 * Central Command Center — a first-class Nexus control surface.
 * It does not replace Dashboard; it centralizes executable navigation,
 * creation, search, review and system actions in one workspace.
 * ============================================================ */
"use strict";

var commandCenterVisible = false;
var commandCenterState = (typeof commandCenterState !== 'undefined' && commandCenterState) || {query:''};

function commandCenterSetActive(active){
  var b=document.getElementById('btn-command-center');
  if(!b) return;
  b.classList.toggle('active',!!active);
  var app=document.getElementById('app');
  if(app) app.classList.toggle('command-center-active',!!active);
  if(active) b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current');
}

function hideCommandCenterView(){
  var v=document.getElementById('command-center-view');
  if(v) v.classList.remove('visible');
  commandCenterVisible=false;
  commandCenterSetActive(false);
}

function commandCenterOpenCurrentPage(){
  if(state && state.currentPageId) openPage(state.currentPageId);
}

function commandCenterCountTasks(){
  try{ return typeof collectTasks==='function' ? collectTasks() : []; }catch(e){ return []; }
}
function commandCenterData(){
  var pages=[]; try{pages=typeof livePages==='function'?livePages():[];}catch(e){}
  var tasks=commandCenterCountTasks();
  var dbs=[]; try{dbs=typeof databaseEntries==='function'?databaseEntries():[];}catch(e){}
  var qs=[]; try{qs=typeof queryEntries==='function'?queryEntries():[];}catch(e){}
  var z=[]; try{z=typeof zettelPages==='function'?zettelPages():[];}catch(e){}
  var fc=[]; try{fc=typeof flashcardCards==='function'?flashcardCards():[];}catch(e){}
  var sticky=[]; try{sticky=typeof stickyNoteCards==='function'?stickyNoteCards():[];}catch(e){}
  var dueTasks=tasks.filter(function(t){return !t.done && (t.bucket==='overdue'||t.bucket==='today'||!!t.due);}).length;
  var dueCards=fc.filter(function(c){return typeof flashcardIsDue==='function' ? flashcardIsDue(c) : false;}).length;
  return {pages:pages,tasks:tasks,dbs:dbs,queries:qs,zettels:z,flashcards:fc,sticky:sticky,dueTasks:dueTasks,dueCards:dueCards};
}

function commandCenterCommands(){
  return [
    {id:'dashboard',label:'Dashboard',description:'Open the maintained Nexus Home hub.',group:'Navigate',icon:'⌂',keywords:'home dashboard overview hub',action:function(){showDashboardView();}},
    {id:'today',label:"Today's note",description:'Open or create today’s journal page.',group:'Navigate',icon:'📅',keywords:'daily journal today note',action:function(){goToday();}},
    {id:'search',label:'Search all notes',description:'Search every page and line with the full query language.',group:'Navigate',icon:'🔎',keywords:'search find everything notes global',action:function(){openGlobalSearch();}},
    {id:'graph',label:'Graph view',description:'Explore page and tag relationships visually.',group:'Navigate',icon:'◎',keywords:'graph links network backlinks map',action:function(){document.getElementById('btn-graph').click();}},
    {id:'tasks',label:'Tasks',description:'Review and manage every task across the notebook.',group:'Work',icon:'☑',keywords:'todo task checklist due priority gallery board',action:function(){document.getElementById('btn-tasks').click();}},
    {id:'database',label:'Database',description:'Open the permanent Database workspace and created-database index.',group:'Work',icon:'▤',keywords:'database table board gallery calendar',action:function(){document.getElementById('btn-database').click();}},
    {id:'queries',label:'Queries',description:'Open the permanent Queries workspace and created-query index.',group:'Work',icon:'⌕',keywords:'query filter search builder lines',action:function(){document.getElementById('btn-queries').click();}},
    {id:'zettelkasten',label:'Zettelkasten',description:'Capture, develop and connect atomic knowledge notes.',group:'Knowledge',icon:'🧠',keywords:'zettel atomic fleeting literature permanent moc links',action:function(){document.getElementById('btn-zettelkasten').click();}},
    {id:'flashcards',label:'Flashcards',description:'Study due cards with spaced repetition.',group:'Knowledge',icon:'▤',keywords:'flashcard study review spaced repetition deck',action:function(){document.getElementById('btn-flashcards').click();}},
    {id:'sticky',label:'Sticky Notes',description:'Open colorful quick-capture note cards.',group:'Capture',icon:'🗒',keywords:'sticky note capture reminder cards',action:function(){document.getElementById('btn-sticky-notes').click();}},
    {id:'new-page',label:'New page',description:'Open the command palette to create a page.',group:'Create',icon:'＋',keywords:'new create page',action:function(){openPalette();}},
    {id:'new-query',label:'Insert query',description:'Insert a live query using the visual builder.',group:'Create',icon:'⌕',keywords:'query insert live builder filter',action:function(){openQueryBuilder('query',null,'');}},
    {id:'new-database',label:'Insert database',description:'Insert a live database view using the visual builder.',group:'Create',icon:'▤',keywords:'database insert table view builder',action:function(){openQueryBuilder('table',null,'');}},
    {id:'new-code',label:'Insert code block',description:'Insert a code block into the current page.',group:'Create',icon:'❯_',keywords:'code block insert',action:function(){insertCodeBlockSpecial();}},
    {id:'new-flashcard',label:'New flashcard',description:'Open Flashcards and start a new card.',group:'Create',icon:'＋',keywords:'flashcard card study new',action:function(){showFlashcardsView(); var b=document.getElementById('flashcards-add-btn'); if(b)b.click();}},
    {id:'new-sticky',label:'New sticky note',description:'Open Sticky Notes and start a new card.',group:'Create',icon:'＋',keywords:'sticky note capture new',action:function(){showStickyNotesView(); var b=document.getElementById('sticky-notes-add-btn'); if(b)b.click();}},
    {id:'new-zettel',label:'New Zettelkasten note',description:'Open the Zettelkasten capture form for an atomic idea.',group:'Create',icon:'🧠',keywords:'zettel fleeting permanent literature atomic new',action:function(){showZettelkastenView(); var b=document.getElementById('zettel-new-body'); if(b){setTimeout(function(){b.focus();},0);}}},
    {id:'new-folder',label:'New folder',description:'Create a top-level folder from the sidebar.',group:'Create',icon:'📁',keywords:'folder directory organize',action:function(){var b=document.getElementById('new-root-folder-btn');if(b)b.click();}},
    {id:'open-current',label:'Open current page',description:'Return to the page you were last editing.',group:'Context',icon:'↗',keywords:'current page continue resume',action:function(){commandCenterOpenCurrentPage();}},
    {id:'back',label:'Go back',description:'Move backward through page navigation history.',group:'Context',icon:'←',keywords:'back history previous',action:function(){goBack();}},
    {id:'forward',label:'Go forward',description:'Move forward through page navigation history.',group:'Context',icon:'→',keywords:'forward history next',action:function(){goForward();}},
    {id:'palette',label:'Command palette',description:'Open the compact ⌘K action palette.',group:'System',icon:'⌘',keywords:'palette quick command shortcut',action:function(){openPalette();}},
    {id:'help',label:'Help & tutorial',description:'Open the maintained Nexus Help guide.',group:'System',icon:'📖',keywords:'help tutorial documentation guide',action:function(){openPageByTitle(DOCS_TITLE,'page');}},
    {id:'settings',label:'Settings',description:'Change Nexus appearance, safety and connection settings.',group:'System',icon:'⚙',keywords:'settings preferences options theme',action:function(){openSettings();}},
    {id:'health',label:'Data health',description:'Inspect storage, attachments, backups, sync and diagnostics.',group:'System',icon:'♥',keywords:'health diagnostics storage backup attachments',action:function(){if(typeof openDataHealth==='function')openDataHealth();}},
    {id:'backup',label:'Backup now',description:'Create a full portable notebook backup.',group:'System',icon:'⭳',keywords:'backup export save recovery',action:function(){backup();}},
    {id:'versions',label:'Version history',description:'Inspect or restore safety snapshots.',group:'System',icon:'↺',keywords:'version history snapshot restore diff',action:function(){openVersions();}},
    {id:'sync',label:'Sync devices',description:'Open device-sync controls and pairing.',group:'System',icon:'⇄',keywords:'sync lan webrtc devices',action:function(){openSyncModal();}},
    {id:'sync-cleanup',label:'Sync cleanup & recovery',description:'Review conflicts, duplicates and recovery history.',group:'System',icon:'♻',keywords:'sync cleanup conflict duplicate recovery versions history',action:function(){if(typeof openSyncCenter==='function')openSyncCenter();}},
    {id:'find-replace',label:'Find & replace',description:'Run controlled notebook-wide text replacements.',group:'System',icon:'⇄',keywords:'find replace bulk edit',action:function(){openFindReplace();}},
    {id:'lock',label:'Lock Nexus now',description:'Clear the unlocked key and return to the passcode screen.',group:'Security',icon:'🔒',keywords:'lock privacy passcode secure',action:function(){if(typeof lockNow==='function')lockNow();}},
    {id:'toggle-sidebar',label:'Toggle main sidebar',description:'Show or hide the main navigation sidebar.',group:'System',icon:'☰',keywords:'sidebar navigation collapse expand',action:function(){if(typeof setSidebarCollapsed==='function'){var app=document.getElementById('app');setSidebarCollapsed(!(app&&app.classList.contains('sidebar-collapsed')));}}}
  ];
}

function commandCenterScore(cmd,q){
  if(!q) return 1;
  var hay=(cmd.label+' '+cmd.description+' '+cmd.group+' '+cmd.keywords).toLowerCase();
  return typeof fuzzyMatchScore==='function' ? fuzzyMatchScore(q,hay) : (hay.indexOf(q.toLowerCase())!==-1?1000:0);
}

function commandCenterVisibleCommands(q){
  var all=commandCenterCommands(), needle=(q||'').trim();
  if(!needle) return all;
  return all.map(function(c){return {c:c,s:commandCenterScore(c,needle)};}).filter(function(x){return x.s>0;}).sort(function(a,b){return b.s-a.s||a.c.group.localeCompare(b.c.group)||a.c.label.localeCompare(b.c.label);}).map(function(x){return x.c;});
}

function commandCenterRun(cmd){
  if(!cmd || typeof cmd.action!=='function') return;
  try{cmd.action();}catch(e){if(typeof toast==='function')toast('Could not run “'+cmd.label+'”.');}
}

function commandCenterStat(value,label,icon,action){
  var b=document.createElement('button'); b.type='button'; b.className='command-center-stat'; if(action)b.onclick=action;
  var i=document.createElement('span');i.className='command-center-stat-icon';i.textContent=icon;b.appendChild(i);
  var strong=document.createElement('strong');strong.textContent=String(value);b.appendChild(strong);
  var l=document.createElement('span');l.className='command-center-stat-label';l.textContent=label;b.appendChild(l);return b;
}

function renderCommandCenterStats(){
  var el=document.getElementById('command-center-stats'); if(!el)return; el.innerHTML=''; var d=commandCenterData();
  var open=d.tasks.filter(function(t){return !t.done;}).length;
  el.appendChild(commandCenterStat(d.pages.length,'Pages','□',function(){commandCenterOpenCurrentPage();}));
  el.appendChild(commandCenterStat(open,'Open tasks','☑',function(){document.getElementById('btn-tasks').click();}));
  el.appendChild(commandCenterStat(d.dueTasks,'Due tasks','●',function(){document.getElementById('btn-tasks').click();}));
  el.appendChild(commandCenterStat(d.dbs.length,'Databases','▤',function(){document.getElementById('btn-database').click();}));
  el.appendChild(commandCenterStat(d.queries.length,'Queries','⌕',function(){document.getElementById('btn-queries').click();}));
  el.appendChild(commandCenterStat(d.zettels.length,'Zettels','🧠',function(){document.getElementById('btn-zettelkasten').click();}));
  el.appendChild(commandCenterStat(d.dueCards,'Cards due','▤',function(){document.getElementById('btn-flashcards').click();}));
  el.appendChild(commandCenterStat(d.sticky.filter(function(c){return !c.archived;}).length,'Sticky notes','🗒',function(){document.getElementById('btn-sticky-notes').click();}));
}

function renderCommandCenterResults(){
  var el=document.getElementById('command-center-results'), count=document.getElementById('command-center-command-count'); if(!el)return; el.innerHTML='';
  var q=(commandCenterState.query||'').trim(); var cmds=commandCenterVisibleCommands(q);
  if(count) count.textContent=cmds.length+' command'+(cmds.length===1?'':'s');
  var groups={}; cmds.forEach(function(c){(groups[c.group]||(groups[c.group]=[])).push(c);});
  Object.keys(groups).forEach(function(g){
    var sec=document.createElement('section');sec.className='command-center-group';
    var h=document.createElement('h3');h.textContent=g;sec.appendChild(h);
    var grid=document.createElement('div');grid.className='command-center-command-grid';sec.appendChild(grid);
    groups[g].forEach(function(c){
      var b=document.createElement('button');b.type='button';b.className='command-center-command';b.title=c.description;
      var i=document.createElement('span');i.className='command-center-command-icon';i.textContent=c.icon; b.appendChild(i);
      var copy=document.createElement('span');copy.className='command-center-command-copy';var t=document.createElement('strong');t.textContent=c.label;copy.appendChild(t);var d=document.createElement('span');d.textContent=c.description;copy.appendChild(d);b.appendChild(copy);
      b.onclick=function(){commandCenterRun(c);};grid.appendChild(b);
    }); el.appendChild(sec);
  });
  if(!cmds.length){var empty=document.createElement('div');empty.className='command-center-empty';empty.textContent='No commands match that search. Try “task”, “backup”, “Zettelkasten”, “database” or “settings”.';el.appendChild(empty);}
}

function renderCommandCenterRecent(){
  var el=document.getElementById('command-center-recent'); if(!el)return; el.innerHTML='';
  var recent=[];
  try{
    if(Array.isArray(navHistory)){
      for(var i=navHistory.length-1;i>=0 && recent.length<8;i--){var p=state.pages[navHistory[i]];if(p&&!p.trashedAt&&recent.every(function(x){return x.id!==p.id;}))recent.push(p);}
    }
  }catch(e){}
  if(!recent.length){try{recent=(typeof livePages==='function'?livePages():[]).sort(function(a,b){return (b.createdAt||0)-(a.createdAt||0);}).slice(0,8);}catch(e){recent=[];}}
  if(!recent.length){var empty=document.createElement('div');empty.className='command-center-empty';empty.textContent='No pages to show yet.';el.appendChild(empty);return;}
  recent.forEach(function(p){
    var b=document.createElement('button');b.type='button';b.className='command-center-recent-item';var icon=document.createElement('span');icon.textContent=p.icon||defaultPageIcon(p.type);b.appendChild(icon);var c=document.createElement('span');var t=document.createElement('strong');t.textContent=p.title;c.appendChild(t);var meta=document.createElement('span');meta.textContent=p.type==='daily'?'Daily note':p.type==='tag'?'Tag':'Page';c.appendChild(meta);b.appendChild(c);b.onclick=function(){openPage(p.id);};el.appendChild(b);
  });
}

function renderCommandCenterCurrent(){
  var el=document.getElementById('command-center-current'); if(!el)return; el.innerHTML=''; var p=state.pages[state.currentPageId];
  if(p){var title=document.createElement('div');title.className='command-center-current-title';title.textContent=(p.icon||defaultPageIcon(p.type))+' '+p.title;el.appendChild(title);var meta=document.createElement('div');meta.className='command-center-current-meta';meta.textContent=(p.type==='daily'?'Daily note':p.type==='tag'?'Tag':'Page')+' · '+(p.locked?'Locked':'Editable');el.appendChild(meta);var actions=document.createElement('div');actions.className='command-center-current-actions';[['Open','commandCenterOpenCurrentPage'],['Dashboard','showDashboardView'],['Help',function(){openPageByTitle(DOCS_TITLE,'page');}]].forEach(function(pair){var b=document.createElement('button');b.type='button';b.textContent=pair[0];b.onclick=typeof pair[1]==='string'?window[pair[1]]:pair[1];actions.appendChild(b);});el.appendChild(actions);}
  var health=document.createElement('div');health.className='command-center-health-row';var chip=typeof nexusHealthState!=='undefined'?nexusHealthState:{kind:'saved',text:'Saved locally'};health.innerHTML='<span class="command-center-health-dot '+(chip.kind||'saved')+'"></span><span>'+escapeHtml(chip.text||'Saved locally')+'</span>';el.appendChild(health);
}

function renderCommandCenter(){renderCommandCenterStats();renderCommandCenterResults();renderCommandCenterRecent();renderCommandCenterCurrent();}

function showCommandCenterView(){
  if(typeof hideDashboardView==='function')hideDashboardView();
  if(typeof hideFlashcardsView==='function')hideFlashcardsView();
  if(typeof hideStickyNotesView==='function')hideStickyNotesView();
  if(typeof hideZettelkastenView==='function')hideZettelkastenView();
  var page=document.getElementById('page-view'),graph=document.getElementById('graph-view'),tasks=document.getElementById('tasks-view'),view=document.getElementById('command-center-view');
  if(!view)return;
  if(page)page.classList.remove('visible');if(graph)graph.classList.remove('visible');if(tasks)tasks.classList.remove('visible');view.classList.add('visible');commandCenterVisible=true;commandCenterSetActive(true);renderCommandCenter();
  if(typeof closeSidebarIfNarrow==='function')closeSidebarIfNarrow();
  var input=document.getElementById('command-center-search');if(input){input.value=commandCenterState.query||'';setTimeout(function(){input.focus();input.select();},0);}
}

function commandCenterEscape(e){if(e.key==='Escape'){var input=document.getElementById('command-center-search');if(input&&input.value){input.value='';commandCenterState.query='';renderCommandCenterResults();return;}hideCommandCenterView();document.getElementById('page-view').classList.add('visible');}}

function wireCommandCenter(){
  var btn=document.getElementById('btn-command-center');if(btn)btn.onclick=showCommandCenterView;
  var close=document.getElementById('command-center-close');if(close)close.onclick=function(){hideCommandCenterView();document.getElementById('page-view').classList.add('visible');};
  var palette=document.getElementById('command-center-open-palette');if(palette)palette.onclick=openPalette;
  var focus=document.getElementById('command-center-focus-search');if(focus)focus.onclick=function(){var i=document.getElementById('command-center-search');if(i){i.focus();i.select();}};
  var input=document.getElementById('command-center-search');if(input){input.addEventListener('input',function(e){commandCenterState.query=e.target.value||'';renderCommandCenterResults();});input.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();var cmds=commandCenterVisibleCommands(commandCenterState.query);if(cmds.length){commandCenterRun(cmds[0]);}} else if(e.key==='Escape')commandCenterEscape(e);});}
  document.addEventListener('keydown',function(e){if(appLocked)return;if((e.metaKey||e.ctrlKey)&&e.shiftKey&&(e.key==='k'||e.key==='K')){e.preventDefault();showCommandCenterView();}});
  window.addEventListener('resize',function(){if(commandCenterVisible)renderCommandCenter();});
}

if(typeof document!=='undefined'&&document.addEventListener)document.addEventListener('DOMContentLoaded',wireCommandCenter);
