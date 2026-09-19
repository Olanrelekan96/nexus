/* ============================================================
 * 29-folders.js
 * First-class folder organization for Nexus: folders can contain pages
 * and other folders, pages can be moved by context menu or drag/drop,
 * and the hierarchy persists/syncs as normal notebook state.
 * ============================================================ */
"use strict";

var folderSidebarFilter = '';

function ensureFolderState(){
  if(!state.folders || typeof state.folders !== 'object' || Array.isArray(state.folders)) state.folders = {};
  Object.keys(state.folders).forEach(function(id){
    var f=state.folders[id];
    if(!f || typeof f!=='object'){ delete state.folders[id]; return; }
    f.id=f.id||id;
    f.name=String(f.name==null?'Untitled folder':f.name).trim()||'Untitled folder';
    f.parentId=f.parentId||null;
    f.collapsed=!!f.collapsed;
  });
  Object.keys(state.pages||{}).forEach(function(id){
    var p=state.pages[id];
    if(p && p.folderId && (!state.folders[p.folderId] || state.folders[p.folderId].deletedAt)) delete p.folderId;
  });
  Object.keys(state.folders).forEach(function(id){
    var seen={},cur=id;
    while(cur && state.folders[cur]){
      if(seen[cur]){state.folders[id].parentId=null;break;}
      seen[cur]=true;
      var next=state.folders[cur].parentId;
      if(next && (!state.folders[next] || state.folders[next].deletedAt)){state.folders[cur].parentId=null;break;}
      cur=next;
    }
  });
}

function liveFolders(){
  ensureFolderState();
  return Object.keys(state.folders).map(function(id){return state.folders[id];}).filter(function(f){return f && !f.deletedAt;});
}
function folderById(id){return id && state.folders ? state.folders[id] : null;}
function folderChildren(parentId){
  return liveFolders().filter(function(f){return (f.parentId||null)===(parentId||null);})
    .sort(function(a,b){return a.name.localeCompare(b.name)||a.id.localeCompare(b.id);});
}
function folderPath(id){
  var names=[],seen={},cur=id,hops=0;
  while(cur && state.folders[cur] && !state.folders[cur].deletedAt && hops<100){
    if(seen[cur]) break; seen[cur]=true;
    names.unshift(state.folders[cur].name); cur=state.folders[cur].parentId; hops++;
  }
  return names.join(' / ');
}
function folderDescendant(folderId, possibleParentId){
  if(!folderId || !possibleParentId) return false;
  var cur=possibleParentId,seen={},hops=0;
  while(cur && state.folders[cur] && hops<100){
    if(cur===folderId) return true;
    if(seen[cur]) return true;
    seen[cur]=true; cur=state.folders[cur].parentId; hops++;
  }
  return false;
}
function folderDirectPageCount(folderId){
  return livePages().filter(function(p){return !p.hidden && (p.folderId||null)===folderId;}).length;
}
function folderTotalPageCount(folderId){
  var count=folderDirectPageCount(folderId);
  folderChildren(folderId).forEach(function(f){count+=folderTotalPageCount(f.id);});
  return count;
}
function folderPromptPathList(excludeId){
  var out=['Unfiled'];
  function walk(parent,prefix){
    folderChildren(parent).forEach(function(f){
      if(f.id===excludeId) return;
      out.push((prefix?prefix+' / ':'')+f.name);
      walk(f.id,(prefix?prefix+' / ':'')+f.name);
    });
  }
  walk(null,'');
  return out;
}
function folderByPath(path){
  path=String(path||'').trim();
  if(!path || path.toLowerCase()==='unfiled') return null;
  var parts=path.split('/').map(function(x){return x.trim();}).filter(Boolean), parent=null;
  for(var i=0;i<parts.length;i++){
    var match=folderChildren(parent).find(function(f){return f.name.toLowerCase()===parts[i].toLowerCase();});
    if(!match) return undefined;
    parent=match.id;
  }
  return parent;
}
function movePageToFolder(pageId,folderId){
  var page=state.pages[pageId], folder=folderId?folderById(folderId):null;
  if(!page || page.trashedAt) return;
  if(folderId && (!folder || folder.deletedAt)){toast('That folder no longer exists.');return;}
  if(page.folderId===folderId || (!page.folderId&&!folderId)) return;
  page.folderId=folderId||null;
  save(); renderAll();
  toast('Moved “'+page.title+'” to '+(folder?folderPath(folder.id):'Unfiled')+'.');
}
function movePageToFolderPrompt(pageId){
  var page=state.pages[pageId]; if(!page) return;
  var options=folderPromptPathList();
  var current=page.folderId?folderPath(page.folderId):'Unfiled';
  var answer=prompt('Move “'+page.title+'” to a folder.\n\nAvailable: '+options.join(' | ')+'\n\nType the folder path or Unfiled:',current);
  if(answer===null) return;
  answer=answer.trim();
  var target=folderByPath(answer);
  if(target===undefined){toast('Folder path not found.');return;}
  movePageToFolder(pageId,target);
}
function createFolder(name,parentId){
  ensureFolderState();
  name=String(name||'').trim(); parentId=parentId||null;
  if(!name){toast('Folder needs a name.');return null;}
  if(parentId && (!folderById(parentId) || folderById(parentId).deletedAt)){parentId=null;}
  var clash=folderChildren(parentId).some(function(f){return f.name.toLowerCase()===name.toLowerCase();});
  if(clash){toast('A folder with that name already exists here.');return null;}
  var id=uid(); state.folders[id]={id:id,name:name,parentId:parentId,collapsed:false,createdAt:Date.now()};
  save(); renderAll(); toast('Created folder: '+folderPath(id)); return id;
}
function createFolderPrompt(parentId){
  var parent=parentId?folderById(parentId):null;
  var name=prompt(parent?'Create subfolder inside “'+folderPath(parentId)+'”:':'Create new folder:');
  if(name!==null) createFolder(name,parentId||null);
}
function renameFolder(folderId){
  var f=folderById(folderId); if(!f) return;
  var name=prompt('Rename folder:',f.name);
  if(name===null) return;
  name=name.trim(); if(!name||name===f.name) return;
  if(folderChildren(f.parentId).some(function(x){return x.id!==f.id&&x.name.toLowerCase()===name.toLowerCase();})){toast('A sibling folder already has that name.');return;}
  f.name=name; save(); renderAll(); toast('Folder renamed to “'+name+'”.');
}
function moveFolderPrompt(folderId){
  var f=folderById(folderId); if(!f) return;
  var options=folderPromptPathList(folderId), current=folderPath(folderId), answer=prompt('Move “'+current+'” inside another folder.\n\nAvailable: '+options.join(' | ')+'\n\nType the destination path or Unfiled:', f.parentId?folderPath(f.parentId):'Unfiled');
  if(answer===null) return; answer=answer.trim();
  var target=folderByPath(answer);
  if(target===undefined){toast('Folder path not found.');return;}
  if(target===folderId || folderDescendant(folderId,target)){toast('A folder cannot be moved inside itself or one of its children.');return;}
  if(target===f.parentId) return;
  if(folderChildren(target).some(function(x){return x.id!==folderId&&x.name.toLowerCase()===f.name.toLowerCase();})){toast('A sibling folder already has that name.');return;}
  f.parentId=target; f.collapsed=false; save(); renderAll(); toast('Moved folder to '+(target?folderPath(target):'Unfiled')+'.');
}
function deleteFolder(folderId){
  var f=folderById(folderId); if(!f) return;
  var pages=livePages().filter(function(p){return p.folderId===folderId;}), children=folderChildren(folderId), childCount=children.length;
  var dest=f.parentId||null;
  var msg='Delete folder “'+folderPath(folderId)+'”?\n\n'+pages.length+' page(s) and '+childCount+' subfolder(s) will be moved to '+(dest?folderPath(dest):'Unfiled')+'.';
  if(!confirm(msg)) return;
  pages.forEach(function(p){p.folderId=dest;});
  children.forEach(function(c){c.parentId=dest;});
  f.deletedAt=Date.now(); f.updatedAt=f.deletedAt; f.updatedBy=state.deviceId||'';
  save(); renderAll(); toast('Deleted folder “'+f.name+'”; contents were moved safely.');
}
function toggleFolderCollapsed(folderId){var f=folderById(folderId);if(!f)return;f.collapsed=!f.collapsed;save();renderFolderSidebarSection(document.getElementById('search-box')?document.getElementById('search-box').value:'',folderSidebarFilter);}
function folderPageMatches(page,filter){
  if(!filter) return true;
  var text=[page.title,folderPath(page.folderId||'')].join(' ').toLowerCase();
  return fuzzyMatchScore(filter,text)>0;
}
function folderMatches(f,filter){
  if(!filter) return true;
  if(fuzzyMatchScore(filter,f.name)>0 || fuzzyMatchScore(filter,folderPath(f.id))>0) return true;
  return livePages().some(function(p){return !p.hidden&&p.folderId&& (p.folderId===f.id || folderDescendant(f.id,p.folderId)) && folderPageMatches(p,filter);});
}
function renderFolderPageRow(container,page,depth){
  var li=document.createElement('div'); li.className='folder-page-row'; li.style.paddingLeft=(28+Math.max(0,depth-1)*12)+'px';
  var row=document.createElement('div'); row.className='trash-row'; row.dataset.pageId=page.id; row.draggable=!page.locked;
  row.addEventListener('dragstart',function(e){try{e.dataTransfer.setData('text/plain',page.id);e.dataTransfer.setData('application/x-nexus-page',page.id);}catch(ignore){} row.classList.add('dragging');});
  row.addEventListener('dragend',function(){row.classList.remove('dragging');});
  var a=document.createElement('a'); a.href='#'; a.addEventListener('click',function(e){e.preventDefault();}); a.className=page.id===state.currentPageId?'active':''; a.title='Open '+page.title; a.onclick=function(){openPage(page.id);};
  var icon=document.createElement('span'); icon.className='page-list-icon'; icon.textContent=typeof pageIconFor==='function'?pageIconFor(page):(page.icon||defaultPageIcon(page.type)); icon.setAttribute('aria-hidden','true'); a.appendChild(icon);
  var label=document.createElement('span'); label.textContent=page.title+(page.locked?' 🔒':''); a.appendChild(label); row.appendChild(a);
  var pin=document.createElement('button'); pin.type='button'; pin.className='pin-btn'+(page.pinned?' pinned':''); pin.textContent=page.pinned?'★':'☆'; pin.title=page.pinned?'Unpin':'Pin'; pin.setAttribute('aria-label',(page.pinned?'Unpin ':'Pin ')+page.title); pin.onclick=function(e){e.stopPropagation();togglePinPage(page.id);}; row.appendChild(pin);
  var grip=document.createElement('span'); grip.className='sidebar-drag-handle'; grip.textContent='⠿'; grip.title='Drag page into a folder'; grip.draggable=true; grip.addEventListener('dragstart',function(e){try{e.dataTransfer.setData('text/plain',page.id);e.dataTransfer.setData('application/x-nexus-page',page.id);}catch(ignore){}}); row.insertBefore(grip,a);
  li.appendChild(row); container.appendChild(li);
}
function renderFolderBranch(parentId,host,depth,filter){
  var folders=folderChildren(parentId);
  var pages=livePages().filter(function(p){return !p.hidden&&(p.folderId||null)===(parentId||null);}).sort(function(a,b){return a.title.localeCompare(b.title);});
  folders.forEach(function(f){
    if(!folderMatches(f,filter)) return;
    var node=document.createElement('div'); node.className='folder-node'; node.dataset.folderId=f.id;
    var row=document.createElement('div'); row.className='folder-row'; row.dataset.folderId=f.id;
    var toggle=document.createElement('button'); toggle.type='button'; toggle.className='folder-toggle'; toggle.textContent=f.collapsed?'▸':'▾'; toggle.title=f.collapsed?'Expand':'Collapse'; toggle.setAttribute('aria-label',(f.collapsed?'Expand ':'Collapse ')+f.name); toggle.onclick=function(e){e.stopPropagation();toggleFolderCollapsed(f.id);}; row.appendChild(toggle);
    var name=document.createElement('button'); name.type='button'; name.className='folder-name'; name.title=folderPath(f.id);
    var ico=document.createElement('span'); ico.textContent=f.collapsed?'📁':'📂'; ico.setAttribute('aria-hidden','true'); name.appendChild(ico);
    var lbl=document.createElement('span'); lbl.className='folder-label'; lbl.textContent=f.name; name.appendChild(lbl);
    var ct=document.createElement('span'); ct.className='folder-count'; ct.textContent=String(folderTotalPageCount(f.id)); name.appendChild(ct); name.onclick=function(){f.collapsed=!f.collapsed;save();renderFolderSidebarSection(document.getElementById('folder-filter').value);}; row.appendChild(name);
    var add=document.createElement('button'); add.type='button'; add.className='folder-action'; add.textContent='+'; add.title='Create subfolder'; add.setAttribute('aria-label','Create subfolder inside '+f.name); add.onclick=function(e){e.stopPropagation();createFolderPrompt(f.id);}; row.appendChild(add);
    var menu=document.createElement('button'); menu.type='button'; menu.className='folder-action'; menu.textContent='⋯'; menu.title='Folder actions'; menu.setAttribute('aria-label','Folder actions for '+f.name); menu.onclick=function(e){e.stopPropagation(); if(typeof openCtxMenu==='function'&&typeof folderMenuItems==='function') openCtxMenu(folderMenuItems(f.id),e.clientX,e.clientY);}; row.appendChild(menu);
    ['dragover','dragenter'].forEach(function(ev){row.addEventListener(ev,function(e){var id='';try{id=e.dataTransfer.getData('application/x-nexus-page')||e.dataTransfer.getData('text/plain');}catch(ignore){} if(id&&state.pages[id]&&!state.pages[id].locked){e.preventDefault();row.classList.add('drop-target');}});});
    row.addEventListener('dragleave',function(){row.classList.remove('drop-target');});
    row.addEventListener('drop',function(e){e.preventDefault();row.classList.remove('drop-target');var id='';try{id=e.dataTransfer.getData('application/x-nexus-page')||e.dataTransfer.getData('text/plain');}catch(ignore){} if(id&&state.pages[id]&&!state.pages[id].locked)movePageToFolder(id,f.id);});
    node.appendChild(row); host.appendChild(node);
    if(!f.collapsed || filter){var kids=document.createElement('div'); kids.className='folder-children'; node.appendChild(kids); renderFolderBranch(f.id,kids,depth+1,filter); if(!kids.childElementCount&&!filter){var empty=document.createElement('div');empty.className='folder-drop-hint';empty.textContent='Drag a page here or use + for a subfolder';kids.appendChild(empty);}}
  });
  pages.forEach(function(p){if(folderPageMatches(p,filter))renderFolderPageRow(host,p,depth);});
}
function renderFolderSidebarSection(mainFilter,localFilter){
  ensureFolderState(); var host=document.getElementById('folder-tree'); if(!host)return; host.innerHTML='';
  var filter=[mainFilter||'',localFilter||folderSidebarFilter||''].filter(Boolean).join(' ').trim().toLowerCase();
  renderFolderBranch(null,host,0,filter);
  if(!host.childElementCount){var empty=document.createElement('div');empty.className='folder-empty';empty.textContent=filter?'No folders or pages match this filter.':'No folders yet. Create one with + folder.';host.appendChild(empty);}
}
function folderMenuItems(folderId){
  var f=folderById(folderId); if(!f) return [];
  return [
    {header:folderPath(folderId)},
    {icon:'＋',label:'New subfolder…',onClick:function(){createFolderPrompt(folderId);}},
    {icon:'✎',label:'Rename…',onClick:function(){renameFolder(folderId);}},
    {icon:'↔',label:'Move folder…',onClick:function(){moveFolderPrompt(folderId);}},
    {icon:f.collapsed?'▾':'▸',label:f.collapsed?'Expand':'Collapse',onClick:function(){toggleFolderCollapsed(folderId);}},
    {divider:true},
    {icon:'🗑',label:'Delete folder…',danger:true,onClick:function(){deleteFolder(folderId);}}
  ];
}
function wireFolderSidebar(){
  if(typeof state !== 'undefined' && state) ensureFolderState();
  var add=document.getElementById('new-folder-btn');if(add)add.onclick=function(){createFolderPrompt(null);};
  var addRoot=document.getElementById('new-root-folder-btn');if(addRoot)addRoot.onclick=function(){createFolderPrompt(null);};
  var filter=document.getElementById('folder-filter');if(filter){filter.value=folderSidebarFilter||'';filter.addEventListener('input',function(e){folderSidebarFilter=e.target.value||'';renderFolderSidebarSection(document.getElementById('search-box')?document.getElementById('search-box').value:'',folderSidebarFilter);});}
  if(typeof state !== 'undefined' && state) renderFolderSidebarSection(document.getElementById('search-box')?document.getElementById('search-box').value:'',folderSidebarFilter);
}
if(typeof window!=='undefined') window.NexusFolders={createFolder:createFolder,movePageToFolder:movePageToFolder};
