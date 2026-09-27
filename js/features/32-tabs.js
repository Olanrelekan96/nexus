/* ============================================================
 * 32-tabs.js
 * Persistent workspace tabs for pages and major Nexus hubs.
 * Tabs are a local UI preference, not notebook data.
 * ============================================================ */
"use strict";

var NEXUS_TABS_STORAGE_KEY = 'nexus_tabs_v1';
var nexusTabsState = {tabs:[], active:null};
var nexusTabsBooted = false;
var nexusOriginalOpenPageForTabs = null;
var nexusOriginalRenderAllForTabs = null;

function nexusTabsDefaultTab(){
  if(typeof state !== 'undefined' && state && state.currentPageId && state.pages[state.currentPageId]){
    return {id:'page:'+state.currentPageId, type:'page', target:state.currentPageId, pinned:false};
  }
  return null;
}
function nexusTabsRead(){
  try{
    var raw=localStorage.getItem(NEXUS_TABS_STORAGE_KEY);
    if(!raw) return;
    var parsed=JSON.parse(raw);
    if(parsed && Array.isArray(parsed.tabs)) nexusTabsState=parsed;
  }catch(e){ nexusTabsState={tabs:[],active:null}; }
}
function nexusTabsPersist(){
  try{localStorage.setItem(NEXUS_TABS_STORAGE_KEY, JSON.stringify({tabs:nexusTabsState.tabs,active:nexusTabsState.active}));}catch(ignore){}
}
function nexusTabsMeta(tab){
  if(!tab) return {label:'Tab',icon:'□',type:'page',target:null};
  if(tab.type==='page'){
    var p=(typeof state!=='undefined' && state && state.pages)?state.pages[tab.target]:null;
    if(!p) return null;
    return {label:p.title||'Untitled',icon:p.icon||defaultPageIcon(p.type),type:'page',target:p.id};
  }
  var map={
    dashboard:{label:'Dashboard',icon:'⌂'},
    command:{label:'Command Center',icon:'⚡'},
    tasks:{label:'Tasks',icon:'☑'},
    graph:{label:'Graph',icon:'◎'},
    flashcards:{label:'Flashcards',icon:'▤'},
    sticky:{label:'Sticky Notes',icon:'🗒'},
    zettel:{label:'Zettelkasten',icon:'🧠'}
  };
  var m=map[tab.target];
  return m?{label:m.label,icon:m.icon,type:'workspace',target:tab.target}:null;
}
function nexusTabsClean(){
  /* Until the notebook has loaded, page tabs cannot be resolved (their pages are not in memory
     yet). Pruning at that point discarded every saved page tab on each launch, and the next
     persist then wrote that loss back to storage. Wait for state; then prune for real. */
  if(!(typeof state !== 'undefined' && state && state.pages)) return;
  var clean=[];
  nexusTabsState.tabs.forEach(function(t){ if(nexusTabsMeta(t)) clean.push(t); });
  nexusTabsState.tabs=clean.map(function(t,i){t.pinned=!!t.pinned;if(typeof t._nexusOrder!=='number')t._nexusOrder=i;return t;});
  nexusTabsSort();
  if(nexusTabsState.active && !clean.some(function(t){return t.id===nexusTabsState.active;})) nexusTabsState.active=clean.length?clean[clean.length-1].id:null;
  if(!clean.length){var d=nexusTabsDefaultTab();if(d){clean.push(d);nexusTabsState.tabs=clean;nexusTabsState.active=d.id;}}
}
function nexusTabsEnsureTab(tab){
  if(!tab || !tab.id) return;
  if(!nexusTabsState.tabs.some(function(t){return t.id===tab.id})){ tab.pinned=!!tab.pinned; tab._nexusOrder=nexusTabsState.tabs.length; nexusTabsState.tabs.push(tab); }
  nexusTabsSort();
  nexusTabsState.active=tab.id;
  nexusTabsClean();
  nexusTabsPersist();
  renderNexusTabs();
}
function nexusTabsPage(pageId){ return {id:'page:'+pageId,type:'page',target:pageId,pinned:false}; }
function nexusTabsWorkspace(name){ return {id:'workspace:'+name,type:'workspace',target:name,pinned:false}; }
function nexusTabsSort(){
  var indexed=nexusTabsState.tabs.map(function(t,i){t.pinned=!!t.pinned;t._nexusOrder=(typeof t._nexusOrder==='number'?t._nexusOrder:i);return t;});
  indexed.sort(function(a,b){ return (b.pinned-a.pinned) || (a._nexusOrder-b._nexusOrder); });
  indexed.forEach(function(t,i){t._nexusOrder=i;});
  nexusTabsState.tabs=indexed;
}
function toggleNexusTabPinned(tabId){
  var tab=nexusTabsState.tabs.find(function(t){return t.id===tabId;}); if(!tab)return;
  tab.pinned=!tab.pinned;
  nexusTabsState.tabs.forEach(function(t,i){if(typeof t._nexusOrder!=='number')t._nexusOrder=i;});
  if(tab.pinned){
    var pinnedMax=-1; nexusTabsState.tabs.forEach(function(t){if(t.pinned&&t.id!==tab.id)pinnedMax=Math.max(pinnedMax,t._nexusOrder||0);});
    tab._nexusOrder=pinnedMax+1;
  }else{
    var max=0; nexusTabsState.tabs.forEach(function(t){max=Math.max(max,t._nexusOrder||0);}); tab._nexusOrder=max+1;
  }
  nexusTabsSort(); nexusTabsPersist(); renderNexusTabs();
}
function isNexusTabPinned(tabId){var t=nexusTabsState.tabs.find(function(x){return x.id===tabId;});return !!(t&&t.pinned);}
function nexusTabsRenderHeight(){
  var el=document.getElementById('nexus-tabs-shell');
  if(el) document.documentElement.style.setProperty('--nexus-tabs-h', (el.offsetHeight||46)+'px');
}
function renderNexusTabs(){
  if(typeof document==='undefined')return;
  var bar=document.getElementById('nexus-tabs-bar');if(!bar)return;
  nexusTabsClean();bar.innerHTML='';
  nexusTabsState.tabs.forEach(function(tab){
    var meta=nexusTabsMeta(tab);if(!meta)return;
    var wrap=document.createElement('div');
    wrap.className='nexus-tab'+(tab.id===nexusTabsState.active?' active':'')+(tab.pinned?' pinned':'');
    wrap.setAttribute('role','tab'); wrap.setAttribute('aria-selected',tab.id===nexusTabsState.active?'true':'false');
    wrap.setAttribute('tabindex','0'); wrap.title=(tab.pinned?'Pinned · ':'')+meta.label;
    var main=document.createElement('span');main.className='nexus-tab-main';main.setAttribute('role','presentation');main.style.cssText='display:inline-flex;align-items:center;gap:7px;min-width:0;';
    var ico=document.createElement('span');ico.className='nexus-tab-icon';ico.textContent=meta.icon;main.appendChild(ico);
    var label=document.createElement('span');label.className='nexus-tab-label';label.textContent=meta.label;main.appendChild(label);
    main.addEventListener('click',function(){activateNexusTab(tab.id);});
    wrap.appendChild(main);
    var pin=document.createElement('span');pin.className='nexus-tab-pin';pin.textContent=tab.pinned?'📌':'☆';pin.setAttribute('role','button');pin.setAttribute('tabindex','0');pin.setAttribute('aria-label',tab.pinned?'Unpin '+meta.label:'Pin '+meta.label);pin.title=tab.pinned?'Unpin tab':'Pin tab';
    pin.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();toggleNexusTabPinned(tab.id);});
    pin.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();toggleNexusTabPinned(tab.id);}});
    wrap.appendChild(pin);
    if(!tab.pinned){
      var close=document.createElement('span');close.className='nexus-tab-close';close.textContent='×';close.setAttribute('role','button');close.setAttribute('tabindex','0');close.setAttribute('aria-label','Close '+meta.label);close.setAttribute('title','Close tab');
      close.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();closeNexusTab(tab.id);});
      close.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();closeNexusTab(tab.id);}});
      wrap.appendChild(close);
    }
    wrap.addEventListener('keydown',function(e){if(e.target!==wrap)return;if(e.key==='Enter'||e.key===' '){e.preventDefault();activateNexusTab(tab.id);}});
    wrap.addEventListener('auxclick',function(e){if(e.button===1&&!tab.pinned){e.preventDefault();closeNexusTab(tab.id);}});
    bar.appendChild(wrap);
  });
  nexusTabsRenderHeight();
}
function nexusTabsTargetTabForClose(tabId){
  var i=nexusTabsState.tabs.findIndex(function(t){return t.id===tabId;});
  if(i<0)return null;
  return nexusTabsState.tabs[i+1]||nexusTabsState.tabs[i-1]||null;
}
function closeNexusTab(tabId){
  if(isNexusTabPinned(tabId)){toast('Unpin this tab before closing it.');return;}
  var wasActive=nexusTabsState.active===tabId;
  var next=nexusTabsTargetTabForClose(tabId);
  nexusTabsState.tabs=nexusTabsState.tabs.filter(function(t){return t.id!==tabId;});
  if(wasActive){
    if(next){nexusTabsState.active=next.id; nexusTabsPersist(); renderNexusTabs(); activateNexusTab(next.id); return;}
    var fallback=nexusTabsDefaultTab();
    nexusTabsState.active=fallback?fallback.id:null;
    if(fallback)nexusTabsState.tabs=[fallback];
  } else if(!nexusTabsState.active && nexusTabsState.tabs[0]) nexusTabsState.active=nexusTabsState.tabs[0].id;
  nexusTabsPersist();renderNexusTabs();
}
function closeOtherNexusTabs(){
  var active=nexusTabsState.active; if(!active)return;
  var keep=nexusTabsState.tabs.filter(function(t){return t.pinned||t.id===active;});
  nexusTabsState.tabs=keep; if(!nexusTabsState.tabs.some(function(t){return t.id===active;})&&keep.length)nexusTabsState.active=keep[0].id;
  nexusTabsSort(); nexusTabsPersist(); renderNexusTabs();
}
function closeAllNexusTabs(){
  var kept=nexusTabsState.tabs.filter(function(t){return t.pinned;});
  var fallback=nexusTabsDefaultTab();
  if(!kept.length && fallback)kept=[fallback];
  if(!kept.some(function(t){return t.id===nexusTabsState.active;})) nexusTabsState.active=kept.length?kept[kept.length-1].id:null;
  nexusTabsState.tabs=kept; nexusTabsSort(); nexusTabsPersist(); renderNexusTabs();
  if(nexusTabsState.active)activateNexusTab(nexusTabsState.active);
}
function activateNexusTab(tabId,silent){
  var tab=nexusTabsState.tabs.find(function(t){return t.id===tabId;});if(!tab)return;
  nexusTabsState.active=tab.id;nexusTabsPersist();renderNexusTabs();
  if(silent)return;
  if(tab.type==='page'){
    if(typeof openPage==='function') openPage(tab.target,true);
    return;
  }
  var fn={dashboard:showDashboardView,command:showCommandCenterView,flashcards:showFlashcardsView,sticky:showStickyNotesView,zettel:showZettelkastenView};
  if(fn[tab.target]){fn[tab.target]();return;}
  if(tab.target==='tasks'||tab.target==='graph'){
    var btn=document.getElementById(tab.target==='tasks'?'btn-tasks':'btn-graph');if(btn)btn.click();
  }
}
function nexusTabsActivatePage(pageId){nexusTabsEnsureTab(nexusTabsPage(pageId));}
function nexusTabsActivateWorkspace(name){nexusTabsEnsureTab(nexusTabsWorkspace(name));}
function nexusTabsWrapFunction(name,workspace){
  if(typeof window==='undefined'||typeof window[name]!=='function')return;
  var original=window[name];
  if(original.__nexusTabWrapped)return;
  var wrapped=function(){var r=original.apply(this,arguments);nexusTabsActivateWorkspace(workspace);return r;};
  wrapped.__nexusTabWrapped=true;window[name]=wrapped;
}
function initNexusTabs(){
  if(nexusTabsBooted)return;nexusTabsBooted=true;
  nexusTabsRead();nexusTabsClean();
  /* Ensure page navigation automatically creates/re-activates a page tab. */
  if(typeof window.openPage==='function' && !window.openPage.__nexusTabWrapped){
    nexusOriginalOpenPageForTabs=window.openPage;
    var wrappedOpenPage=function(pageId,skipHistory){
      var result=nexusOriginalOpenPageForTabs.apply(this,arguments);
      if(typeof state!=='undefined'&&state&&state.pages&&state.pages[pageId]) nexusTabsActivatePage(pageId);
      return result;
    };
    wrappedOpenPage.__nexusTabWrapped=true;window.openPage=wrappedOpenPage;
  }
  if(typeof window.renderPage==='function' && !window.renderPage.__nexusTabWrapped){
    var originalRenderPageForTabs=window.renderPage;
    var wrappedRenderPage=function(){var r=originalRenderPageForTabs.apply(this,arguments);renderNexusTabs();return r;};
    wrappedRenderPage.__nexusTabWrapped=true;window.renderPage=wrappedRenderPage;
  }
  if(typeof window.renderAll==='function' && !window.renderAll.__nexusTabWrapped){
    nexusOriginalRenderAllForTabs=window.renderAll;
    var wrappedRenderAll=function(){var r=nexusOriginalRenderAllForTabs.apply(this,arguments);if(typeof state!=='undefined'&&state){nexusTabsClean();var cur=nexusTabsPage(state.currentPageId);nexusTabsEnsureTab(cur);}return r;};
    wrappedRenderAll.__nexusTabWrapped=true;window.renderAll=wrappedRenderAll;
  }
  nexusTabsWrapFunction('showDashboardView','dashboard');
  nexusTabsWrapFunction('showCommandCenterView','command');
  nexusTabsWrapFunction('showFlashcardsView','flashcards');
  nexusTabsWrapFunction('showStickyNotesView','sticky');
  nexusTabsWrapFunction('showZettelkastenView','zettel');
  var bind=function(){
    renderNexusTabs();
    var newBtn=document.getElementById('nexus-tabs-new');if(newBtn)newBtn.onclick=function(){openPalette();};
    var menuBtn=document.getElementById('nexus-tabs-menu'),pop=document.getElementById('nexus-tabs-menu-popover');
    if(menuBtn&&pop){
      menuBtn.onclick=function(e){e.stopPropagation();pop.hidden=!pop.hidden;};
      pop.addEventListener('click',function(e){
        var b=e.target.closest('[data-tab-action]');
        if(!b)return;
        pop.hidden=true;
        if(b.dataset.tabAction==='close-others')closeOtherNexusTabs();else closeAllNexusTabs();
      });
      document.addEventListener('click',function(e){if(!pop.contains(e.target)&&e.target!==menuBtn)pop.hidden=true;});
      document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!pop.hidden){pop.hidden=true;menuBtn.focus();}});
    }
    document.addEventListener('click',function(e){
      var id=e.target.closest && e.target.closest('#btn-tasks,#btn-graph');
      if(!id)return;
      nexusTabsActivateWorkspace(id.id==='btn-tasks'?'tasks':'graph');
    });
    ['btn-close-graph','btn-close-tasks','btn-close-flashcards','btn-close-sticky-notes','btn-close-zettelkasten','command-center-close'].forEach(function(id){
      var b=document.getElementById(id);
      if(b)b.addEventListener('click',function(){
        if(typeof state!=='undefined'&&state&&state.currentPageId)nexusTabsActivatePage(state.currentPageId);
      });
    });
    window.addEventListener('resize',nexusTabsRenderHeight);
    document.addEventListener('keydown',function(e){
      if(typeof appLocked!=='undefined'&&appLocked)return;
      if((e.ctrlKey||e.metaKey) && e.shiftKey && e.key.toLowerCase()==='p'){e.preventDefault();if(nexusTabsState.active)toggleNexusTabPinned(nexusTabsState.active);return;}
      if((e.ctrlKey||e.metaKey) && e.shiftKey && (e.key===']'||e.key==='[')){
        e.preventDefault();
        var ids=nexusTabsState.tabs.map(function(t){return t.id;});if(!ids.length)return;
        var i=Math.max(0,ids.indexOf(nexusTabsState.active));var next=i+(e.key===']'?1:-1);if(next<0)next=ids.length-1;if(next>=ids.length)next=0;activateNexusTab(ids[next]);
      }
    });
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind);else bind();
}

if(typeof document!=='undefined')initNexusTabs();
