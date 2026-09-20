/* ============================================================
 * 28-zettelkasten.js
 * Native Zettelkasten hub — a standalone system for atomic notes,
 * fleeting/literature/permanent notes, IDs, links, review and MOCs.
 *
 * Zetteln are ordinary Nexus pages with a small `page.zettel` metadata
 * object. That keeps them compatible with existing search, backlinks,
 * graph, backup/restore, sync, locks and page appearance.
 * ============================================================ */
"use strict";

var zettelkastenVisible = false;
var zettelkastenFilter = 'all';
var zettelkastenQuery = '';
var zettelkastenSelectedId = null;
var zettelConnectionCache = null;

var ZETTEL_TYPES = ['fleeting','literature','permanent','moc'];
var ZETTEL_TYPE_LABELS = {
  fleeting:'Fleeting',
  literature:'Literature',
  permanent:'Permanent',
  moc:'MOC / Index'
};
var ZETTEL_TYPE_ICONS = {
  fleeting:'💭',
  literature:'📚',
  permanent:'🧠',
  moc:'🗺️'
};
var ZETTEL_TYPE_BANNERS = {
  fleeting:'paper',
  literature:'ocean',
  permanent:'forest',
  moc:'violet'
};

function zettelPages(){
  return livePages().filter(function(p){ return p && p.zettel && ZETTEL_TYPES.indexOf(p.zettel.type)!==-1; });
}
function normalizeZettelPage(page){
  if(!page || !page.zettel || typeof page.zettel!=='object') return page;
  var z=page.zettel;
  if(ZETTEL_TYPES.indexOf(z.type)===-1) z.type='fleeting';
  z.id=String(z.id||'').trim() || zettelIdFor(page);
  z.stage=z.stage==='inbox'?'inbox':(z.stage|| (z.type==='fleeting'?'inbox':'active'));
  z.tags=Array.isArray(z.tags)?z.tags:[];
  z.createdAt=z.createdAt||page.createdAt||Date.now();
  return page;
}
function zettelIdFor(page){
  var base=page && page.createdAt ? new Date(page.createdAt) : new Date();
  var stamp=base.getFullYear()+String(base.getMonth()+1).padStart(2,'0')+String(base.getDate()).padStart(2,'0')+
    String(base.getHours()).padStart(2,'0')+String(base.getMinutes()).padStart(2,'0')+String(base.getSeconds()).padStart(2,'0');
  var suffix=uid().slice(-6);
  return stamp+'-'+suffix;
}
function zettelSearchText(page){
  var z=page.zettel||{};
  var text=[];
  (page.rootBlocks||[]).forEach(function(id){
    var b=state.blocks[id]; if(b) text.push(b.text||'');
  });
  Object.keys(state.blocks||{}).forEach(function(id){
    var b=state.blocks[id]; if(b && b.pageId===page.id) text.push(b.text||'');
  });
  return [z.id,z.type,z.stage,page.title,(z.tags||[]).join(' '),text.join(' ')].join(' ').toLowerCase();
}
function buildZettelConnectionIndex(){
  var out={}, incoming={};
  zettelPages().forEach(function(p){out[p.id]={};incoming[p.id]=incoming[p.id]||{};});
  Object.keys(state.blocks||{}).forEach(function(id){
    var b=state.blocks[id];
    if(!b || !b.pageId || !state.pages[b.pageId] || !state.pages[b.pageId].zettel) return;
    var source=b.pageId;
    (extractRefs(b.text||'')||[]).forEach(function(r){
      var target=findPageByTitle(r.title);
      if(!target || target.trashedAt || !target.zettel || target.id===source) return;
      if(!out[source])out[source]={};
      out[source][target.id]=true;
      if(!incoming[target.id])incoming[target.id]={};
      incoming[target.id][source]=true;
    });
  });
  zettelConnectionCache={out:out,incoming:incoming};
  return zettelConnectionCache;
}
function getZettelConnectionIndex(){return zettelConnectionCache||buildZettelConnectionIndex();}
function invalidateZettelConnections(){zettelConnectionCache=null;}
function zettelOutgoingTargets(page){
  var idx=getZettelConnectionIndex(), ids=Object.keys((idx.out[page.id]||{}));
  return ids.map(function(id){return state.pages[id];}).filter(Boolean);
}
function zettelIncomingSources(page){
  var idx=getZettelConnectionIndex(), ids=Object.keys((idx.incoming[page.id]||{}));
  return ids.map(function(id){return state.pages[id];}).filter(Boolean);
}
function zettelRelatedPages(page){
  var idx=getZettelConnectionIndex(), out=(idx.out[page.id]||{}), incoming=(idx.incoming[page.id]||{});
  var candidates=[], tags=(page.zettel&&page.zettel.tags)||[], tagSet={}; tags.forEach(function(t){tagSet[String(t).toLowerCase()]=true;});
  zettelPages().forEach(function(p){
    if(p.id===page.id) return;
    var score=0;
    if(out[p.id])score+=8;
    if((idx.out[p.id]||{})[page.id])score+=8;
    var ptags=(p.zettel&&p.zettel.tags)||[]; ptags.forEach(function(t){if(tagSet[String(t).toLowerCase()])score+=2;});
    if(incoming[p.id])score+=2;
    if(score)candidates.push({page:p,score:score});
  });
  return candidates.sort(function(a,b){return b.score-a.score||a.page.title.localeCompare(b.page.title);}).slice(0,8);
}

function ensureZettelkastenMetadata(){
  if(!state) return;
  zettelPages().forEach(normalizeZettelPage);
}

function createZettelPage(type,title,body){
  if(ZETTEL_TYPES.indexOf(type)===-1) type='fleeting';
  var now=Date.now();
  var zid=zettelIdFor({createdAt:now});
  var cleanTitle=String(title||'').trim();
  var pageTitle=zid + (cleanTitle ? ' — '+cleanTitle : '');
  while(state.titleIndex[pageTitle.toLowerCase()]) pageTitle=zid+'-'+uid().slice(-3)+(cleanTitle?' — '+cleanTitle:'');
  var pid=uid(),bid=uid();
  var page={
    id:pid,title:pageTitle,type:'page',createdAt:now,
    properties:[{key:'zettelkasten',value:'yes'},{key:'type',value:ZETTEL_TYPE_LABELS[type]}],
    rootBlocks:[bid],
    zettel:{id:zid,type:type,stage:type==='fleeting'?'inbox':'active',tags:[],createdAt:now}
  };
  page.icon=ZETTEL_TYPE_ICONS[type]; page.banner=ZETTEL_TYPE_BANNERS[type];
  state.pages[pid]=page; state.blocks[bid]=mkBlock(bid,pid,null,String(body||'').trim());
  state.titleIndex[pageTitle.toLowerCase()]=pid; state.currentPageId=pid; invalidateZettelConnections();
  return page;
}
function createZettelFromForm(type){
  var titleEl=document.getElementById('zettel-new-title'),bodyEl=document.getElementById('zettel-new-body'),tagsEl=document.getElementById('zettel-new-tags');
  var title=titleEl?titleEl.value:''; var body=bodyEl?bodyEl.value:'';
  if(!title.trim() && !body.trim()){toast('Add an idea or title first.');return;}
  var page=createZettelPage(type,title,body);
  if(page && tagsEl) page.zettel.tags=tagsEl.value.split(',').map(function(x){return x.trim().toLowerCase();}).filter(Boolean);
  save(); renderAll(); zettelkastenSelectedId=page.id; openPage(page.id);
  if(bodyEl) bodyEl.value=''; if(titleEl) titleEl.value=''; if(tagsEl) tagsEl.value='';
  toast(ZETTEL_TYPE_LABELS[type]+' note created · '+page.zettel.id);
}

function adoptCurrentPageAsZettel(type){
  var page=state.pages[state.currentPageId];
  if(!page || page.trashedAt) return;
  if(page.zettel){toast('This page is already a Zettelkasten note.'); return;}
  if(typeof isPermanentDatabasePage==='function'&&isPermanentDatabasePage(page)){toast('System pages cannot be adopted as Zettelkasten notes.');return;}
  if(typeof isPermanentQueryPage==='function'&&isPermanentQueryPage(page)){toast('System pages cannot be adopted as Zettelkasten notes.');return;}
  if(typeof isPermanentStickyNotesPage==='function'&&isPermanentStickyNotesPage(page)){toast('System pages cannot be adopted as Zettelkasten notes.');return;}
  var promptTitle=window.prompt('Zettelkasten note type: fleeting, literature or permanent',type||'permanent');
  if(ZETTEL_TYPES.indexOf(promptTitle||'')===-1){toast('Use fleeting, literature or permanent.');return;}
  page.zettel={id:zettelIdFor(page),type:promptTitle,stage:promptTitle==='fleeting'?'inbox':'active',tags:[],createdAt:page.createdAt||Date.now()};
  page.properties=Array.isArray(page.properties)?page.properties:[];
  page.properties.push({key:'zettelkasten',value:'yes'},{key:'type',value:ZETTEL_TYPE_LABELS[promptTitle]});
  page.icon=page.icon||ZETTEL_TYPE_ICONS[promptTitle]; page.banner=page.banner||ZETTEL_TYPE_BANNERS[promptTitle];
  invalidateZettelConnections(); save(); renderAll(); renderZettelkastenView(); toast('Page added to Zettelkasten.');
}

function zettelSetType(page,type){
  if(!page || !page.zettel || ZETTEL_TYPES.indexOf(type)===-1) return;
  if(page.locked){toast('Unlock the note before changing its Zettelkasten type.');return;}
  page.zettel.type=type; page.zettel.stage=type==='fleeting'?'inbox':(type==='permanent'?'permanent':'active');
  page.icon=ZETTEL_TYPE_ICONS[type]; page.banner=ZETTEL_TYPE_BANNERS[type];
  page.properties=Array.isArray(page.properties)?page.properties:[]; invalidateZettelConnections();
  var found=page.properties.find(function(p){return p.key==='type';}); if(found) found.value=ZETTEL_TYPE_LABELS[type]; else page.properties.push({key:'type',value:ZETTEL_TYPE_LABELS[type]});
  save(); renderAll(); renderZettelkastenView();
}
function zettelAddTag(page){
  var raw=window.prompt('Add topic tags (comma separated)',(page.zettel.tags||[]).join(', '));
  if(raw==null)return;
  page.zettel.tags=raw.split(',').map(function(x){return x.trim().toLowerCase();}).filter(Boolean);
  invalidateZettelConnections(); save(); renderAll(); renderZettelkastenView();
}
function zettelCopyLink(page){
  var s='[['+page.title+']]';
  if(navigator.clipboard && navigator.clipboard.writeText){navigator.clipboard.writeText(s).then(function(){toast('Page link copied.');}).catch(function(){toast(s);});}
  else toast(s);
}
function zettelProcessNext(){
  var next=zettelPages().filter(function(p){return (p.zettel.stage==='inbox'||p.zettel.type==='fleeting')&&!p.locked;}).sort(function(a,b){return (a.zettel.createdAt||a.createdAt)-(b.zettel.createdAt||b.createdAt);})[0];
  if(!next){toast('Zettelkasten inbox is clear.');return;}
  zettelkastenSelectedId=next.id; showZettelkastenView(); openPage(next.id);
}
function zettelCreateMoc(){
  var name=window.prompt('MOC / index name','');
  if(!name || !name.trim()) return;
  var p=createZettelPage('moc',name,'');
  p.zettel.stage='active';
  save(); renderAll(); zettelkastenSelectedId=p.id; openPage(p.id);
  toast('MOC created. Add [[links]] to your notes to build an index.');
}
function zettelCountBy(type){ return zettelPages().filter(function(p){return p.zettel.type===type;}).length; }
function zettelOrphans(){
  return zettelPages().filter(function(p){
    var out=zettelOutgoingTargets(p), incoming=zettelIncomingSources(p);
    return out.length===0 && incoming.length===0 && p.zettel.type!=='moc';
  });
}
function zettelNotesForFilter(){
  var pages=zettelPages().slice();
  if(zettelkastenFilter!=='all'){
    pages=pages.filter(function(p){
      if(zettelkastenFilter==='inbox') return p.zettel.stage==='inbox';
      if(zettelkastenFilter==='orphan') return zettelOrphans().some(function(x){return x.id===p.id;});
      return p.zettel.type===zettelkastenFilter;
    });
  }
  var q=(zettelkastenQuery||'').trim().toLowerCase();
  if(q) pages=pages.filter(function(p){return zettelSearchText(p).indexOf(q)!==-1;});
  return pages.sort(function(a,b){return (b.zettel.createdAt||b.createdAt)-(a.zettel.createdAt||a.createdAt);});
}

function hideZettelkastenView(){
  var v=document.getElementById('zettelkasten-view'); if(v) v.classList.remove('visible');
  zettelkastenVisible=false;
  var b=document.getElementById('btn-zettelkasten'); if(b){b.classList.remove('active');b.removeAttribute('aria-current');}
  if(typeof clearZettelkastenMobileVisualState==='function') clearZettelkastenMobileVisualState();
}
function showZettelkastenView(){
  if(typeof hideCommandCenterView==='function')hideCommandCenterView();
  if(typeof hideDashboardView==='function')hideDashboardView();
  if(typeof hideFlashcardsView==='function')hideFlashcardsView();
  if(typeof hideStickyNotesView==='function')hideStickyNotesView();
  var page=document.getElementById('page-view'),graph=document.getElementById('graph-view'),tasks=document.getElementById('tasks-view'),view=document.getElementById('zettelkasten-view');
  if(!view)return;
  if(page)page.classList.remove('visible'); if(graph)graph.classList.remove('visible'); if(tasks)tasks.classList.remove('visible');
  view.classList.add('visible'); zettelkastenVisible=true;
  var b=document.getElementById('btn-zettelkasten'); if(b){b.classList.add('active');b.setAttribute('aria-current','page');}
  ensureZettelkastenMetadata(); renderZettelkastenView(); renderZettelkastenSidebar();
  /* On mobile the Zettelkasten is an independent drawer. Do not mutate the
     main navigation sidebar state when opening/closing this hub. */
  if(typeof applyZettelkastenMobileMode==='function') applyZettelkastenMobileMode();
  else if(typeof closeSidebarIfNarrow==='function' && !window.matchMedia('(max-width:860px)').matches) closeSidebarIfNarrow();
}

function zettelStat(value,label,icon){
  var b=document.createElement('button');b.type='button';b.className='zettel-stat';
  var i=document.createElement('span');i.textContent=icon;i.className='zettel-stat-icon';b.appendChild(i);
  var v=document.createElement('strong');v.textContent=String(value);b.appendChild(v);
  var l=document.createElement('span');l.textContent=label;b.appendChild(l);
  return b;
}
function zettelCard(page){
  var z=page.zettel||{}, a=document.createElement('article');a.className='zettel-card'+(zettelkastenSelectedId===page.id?' selected':'');
  var head=document.createElement('div');head.className='zettel-card-head';
  var icon=document.createElement('span');icon.textContent=ZETTEL_TYPE_ICONS[z.type]||'🧠';head.appendChild(icon);
  var id=document.createElement('code');id.textContent=z.id||'';head.appendChild(id);
  var type=document.createElement('span');type.className='zettel-type-badge';type.textContent=ZETTEL_TYPE_LABELS[z.type]||z.type;head.appendChild(type);
  a.appendChild(head);
  var h=document.createElement('h3');h.textContent=page.title.replace(/^[0-9]{8,14}-[^—]+\s*—\s*/,'');a.appendChild(h);
  var excerpt=document.createElement('p');
  var body=[];Object.keys(state.blocks||{}).forEach(function(id){var b=state.blocks[id];if(b&&b.pageId===page.id&&b.text)body.push(b.text);});
  excerpt.textContent=(body.join(' ').replace(/[*_~`]/g,'').slice(0,180))||'Atomic note — add the idea in your own words.';a.appendChild(excerpt);
  var meta=document.createElement('div');meta.className='zettel-card-meta';
  var links=zettelOutgoingTargets(page).length, incoming=zettelIncomingSources(page).length;
  meta.textContent='↗ '+links+' outgoing · ↙ '+incoming+' incoming';a.appendChild(meta);
  if(z.tags&&z.tags.length){var tg=document.createElement('div');tg.className='zettel-tags';tg.textContent=z.tags.slice(0,5).map(function(t){return '#'+t;}).join(' ');a.appendChild(tg);}
  var actions=document.createElement('div');actions.className='zettel-card-actions';
  var open=document.createElement('button');open.type='button';open.textContent='Open';open.onclick=function(e){e.stopPropagation();zettelkastenSelectedId=page.id;openPage(page.id);};actions.appendChild(open);
  if(z.type==='fleeting'||z.type==='literature'){
    var promote=document.createElement('button');promote.type='button';promote.textContent='Make permanent';promote.onclick=function(e){e.stopPropagation();zettelSetType(page,'permanent');};actions.appendChild(promote);
  }
  var tag=document.createElement('button');tag.type='button';tag.textContent='Topics';tag.onclick=function(e){e.stopPropagation();zettelkastenSelectedId=page.id;zettelAddTag(page);};actions.appendChild(tag);
  var copy=document.createElement('button');copy.type='button';copy.textContent='Copy link';copy.onclick=function(e){e.stopPropagation();zettelCopyLink(page);};actions.appendChild(copy);
  a.appendChild(actions);
  a.onclick=function(){zettelkastenSelectedId=page.id;renderZettelkastenView();};
  return a;
}
function renderZettelDetails(){
  var el=document.getElementById('zettel-details');if(!el)return;el.innerHTML='';
  var page=state.pages[zettelkastenSelectedId];
  if(!page||!page.zettel){el.innerHTML='<div class="zettel-details-empty">Select a note to inspect its connections.</div>';return;}
  normalizeZettelPage(page);var z=page.zettel;
  var h=document.createElement('h3');h.textContent='Note details';el.appendChild(h);
  var p=document.createElement('p');p.className='zettel-detail-id';p.textContent=z.id;el.appendChild(p);
  var controls=document.createElement('div');controls.className='zettel-detail-controls';
  ZETTEL_TYPES.forEach(function(type){var b=document.createElement('button');b.type='button';b.className=(z.type===type?'active ':'')+'zettel-mini-type';b.textContent=ZETTEL_TYPE_ICONS[type]+' '+ZETTEL_TYPE_LABELS[type];b.onclick=function(){zettelSetType(page,type);};controls.appendChild(b);});el.appendChild(controls);
  var out=zettelOutgoingTargets(page), incoming=zettelIncomingSources(page), related=zettelRelatedPages(page);
  function linkGroup(title,items,empty){var sec=document.createElement('div');sec.className='zettel-detail-group';var sh=document.createElement('strong');sh.textContent=title+' ('+items.length+')';sec.appendChild(sh);if(!items.length){var em=document.createElement('div');em.className='zettel-muted';em.textContent=empty;sec.appendChild(em);}else{items.forEach(function(item){var row=document.createElement('button');row.type='button';row.className='zettel-detail-link';row.textContent=(item.page?ZETTEL_TYPE_ICONS[item.page.zettel.type]+' ':'')+(item.page?item.page.title:item.title);row.onclick=function(){openPage(item.id||item.page.id);};sec.appendChild(row);});}el.appendChild(sec);}
  linkGroup('Outgoing links',out,'No page links yet. Add [[Another Note]] while writing.');
  linkGroup('Incoming backlinks',incoming,'Nothing links here yet.');
  linkGroup('Related notes',related,'No related notes yet — shared topics or links will surface here.');
}
function renderZettelkastenStats(){
  var el=document.getElementById('zettelkasten-stats');if(!el)return;el.innerHTML='';var pages=zettelPages(), orphan=zettelOrphans(), inbox=pages.filter(function(p){return p.zettel.stage==='inbox';});
  el.appendChild(zettelStat(pages.length,'Total notes','🧠'));el.appendChild(zettelStat(inbox.length,'Inbox','📥'));el.appendChild(zettelStat(zettelCountBy('permanent'),'Permanent','✨'));el.appendChild(zettelStat(zettelCountBy('literature'),'Literature','📚'));el.appendChild(zettelStat(orphan.length,'Unconnected','○'));
}
function renderZettelkastenView(){
  ensureZettelkastenMetadata(); invalidateZettelConnections(); renderZettelkastenStats();
  var filters=document.querySelectorAll('.zettel-filter');filters.forEach(function(b){b.classList.toggle('active',(b.dataset.filter||'all')===zettelkastenFilter);});
  var search=document.getElementById('zettelkasten-search');if(search && search.value!==zettelkastenQuery)search.value=zettelkastenQuery;
  var list=document.getElementById('zettelkasten-list');if(!list)return;list.innerHTML='';
  var pages=zettelNotesForFilter();
  if(!pages.length){var empty=document.createElement('div');empty.className='zettel-empty';empty.textContent='No notes match this view. Create a fleeting note to start the inbox.';list.appendChild(empty);} else pages.forEach(function(p){list.appendChild(zettelCard(p));});
  renderZettelDetails();
}
function renderZettelkastenSidebar(){
  var ul=document.getElementById('list-zettelkasten');if(!ul)return;ensureZettelkastenMetadata();var q=(document.getElementById('zettelkasten-filter')?document.getElementById('zettelkasten-filter').value:'').trim().toLowerCase();ul.innerHTML='';var pages=zettelPages().filter(function(p){return !q||zettelSearchText(p).indexOf(q)!==-1;}).sort(function(a,b){return (b.zettel.createdAt||b.createdAt)-(a.zettel.createdAt||a.createdAt);});
  pages.slice(0,30).forEach(function(p){var li=document.createElement('li'),a=document.createElement('a');a.href='javascript:void(0)';a.textContent=(ZETTEL_TYPE_ICONS[p.zettel.type]||'🧠')+' '+(p.title.length>48?p.title.slice(0,48)+'…':p.title);a.title=(p.zettel.id||'')+' · '+ZETTEL_TYPE_LABELS[p.zettel.type];a.onclick=function(){zettelkastenSelectedId=p.id;openPage(p.id);};li.appendChild(a);ul.appendChild(li);});
  if(!pages.length){var e=document.createElement('li');e.className='zettel-sidebar-empty';e.textContent=q?'No Zettels match this filter.':'No Zettels created yet.';ul.appendChild(e);}var c=document.getElementById('zettelkasten-count');if(c)c.textContent=pages.length?String(pages.length):'';
}
function wireZettelkasten(){
  ensureZettelkastenMetadata();
  var btn=document.getElementById('btn-zettelkasten');if(btn)btn.onclick=showZettelkastenView;
  var close=document.getElementById('btn-close-zettelkasten');if(close)close.onclick=function(){hideZettelkastenView();document.getElementById('page-view').classList.add('visible');};
  var filter=document.getElementById('zettelkasten-filter');if(filter)filter.addEventListener('input',renderZettelkastenSidebar);
  var search=document.getElementById('zettelkasten-search');if(search)search.addEventListener('input',function(e){zettelkastenQuery=e.target.value||'';renderZettelkastenView();});
  document.querySelectorAll('.zettel-filter').forEach(function(b){b.addEventListener('click',function(){zettelkastenFilter=b.dataset.filter||'all';renderZettelkastenView();});});
  var newF=document.getElementById('zettel-new-fleeting');if(newF)newF.onclick=function(){createZettelFromForm('fleeting');};
  var newL=document.getElementById('zettel-new-literature');if(newL)newL.onclick=function(){createZettelFromForm('literature');};
  var newP=document.getElementById('zettel-new-permanent');if(newP)newP.onclick=function(){createZettelFromForm('permanent');};
  var moc=document.getElementById('zettel-new-moc');if(moc)moc.onclick=zettelCreateMoc;
  var process=document.getElementById('zettel-process-next');if(process)process.onclick=zettelProcessNext;
  var adopt=document.getElementById('zettel-adopt-page');if(adopt)adopt.onclick=function(){adoptCurrentPageAsZettel('permanent');};
}
if(typeof document!=='undefined'&&document.addEventListener)document.addEventListener('DOMContentLoaded',wireZettelkasten);
