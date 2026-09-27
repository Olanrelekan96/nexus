/* ============================================================
 * 34-sidebar-ui-ordering.js
 * Sidebar command ordering and drag/drop controls.
 * This is local UI preference state, not notebook data.
 * ============================================================ */
"use strict";
var NEXUS_SIDEBAR_ORDER_KEY = 'nexus_sidebar_nav_order_v1';
var nexusSidebarOrderBooted = false;
var nexusSidebarInitialOrder = null;

function nexusSidebarDefaultOrder(){
  var list=document.getElementById('sidebar-nav-list');
  if(!list)return [];
  return Array.prototype.map.call(list.children,function(el){return el.id;}).filter(Boolean);
}
function nexusSidebarReadOrder(){
  try{
    var raw=localStorage.getItem(NEXUS_SIDEBAR_ORDER_KEY); if(!raw)return null;
    var arr=JSON.parse(raw); return Array.isArray(arr)?arr:null;
  }catch(e){return null;}
}
function nexusSidebarPersistOrder(){
  var list=document.getElementById('sidebar-nav-list'); if(!list)return;
  var ids=Array.prototype.map.call(list.children,function(el){return el.id;}).filter(Boolean);
  try{localStorage.setItem(NEXUS_SIDEBAR_ORDER_KEY,JSON.stringify(ids));}catch(ignore){}
}
function nexusSidebarApplyOrder(){
  var list=document.getElementById('sidebar-nav-list'); if(!list)return;
  var saved=nexusSidebarReadOrder(); if(!saved)return;
  var children=Array.prototype.slice.call(list.children);
  var byId={};children.forEach(function(el){if(el.id)byId[el.id]=el;});
  saved.forEach(function(id){if(byId[id])list.appendChild(byId[id]);});
  children.forEach(function(el){if(saved.indexOf(el.id)===-1)list.appendChild(el);});
}
function nexusSidebarMoveBefore(id, targetId, after){
  var list=document.getElementById('sidebar-nav-list');if(!list||id===targetId)return;
  var src=document.getElementById(id),target=document.getElementById(targetId);if(!src||!target||src.parentNode!==list||target.parentNode!==list)return;
  if(after) list.insertBefore(src,target.nextSibling); else list.insertBefore(src,target);
  nexusSidebarPersistOrder();
  toast('Sidebar order updated.');
}
function nexusSidebarDecorate(){
  var list=document.getElementById('sidebar-nav-list');if(!list)return;
  if(!nexusSidebarInitialOrder) nexusSidebarInitialOrder=nexusSidebarDefaultOrder();
  nexusSidebarApplyOrder();
  var dragId=null;
  Array.prototype.forEach.call(list.children,function(item){
    if(item.dataset.nexusSidebarReady)return;
    item.dataset.nexusSidebarReady='1';
    var handle=document.createElement('span');
    handle.className='sidebar-nav-drag-handle'; handle.textContent='⠿'; handle.title='Drag to reorder sidebar';
    handle.setAttribute('role','button'); handle.setAttribute('aria-label','Drag to reorder '+(item.textContent||'sidebar item').trim()); handle.draggable=true;
    handle.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();});
    handle.addEventListener('mousedown',function(e){e.stopPropagation();});
    handle.addEventListener('dragstart',function(e){
      dragId=item.id; item.classList.add('sidebar-nav-dragging');
      try{e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',item.id);e.dataTransfer.setData('application/x-nexus-sidebar',item.id);}catch(ignore){}
    });
    handle.addEventListener('dragend',function(){dragId=null;item.classList.remove('sidebar-nav-dragging');list.querySelectorAll('.sidebar-nav-drag-over-before,.sidebar-nav-drag-over-after').forEach(function(el){el.classList.remove('sidebar-nav-drag-over-before','sidebar-nav-drag-over-after');});});
    handle.addEventListener('keydown',function(e){
      if(e.altKey && (e.key==='ArrowUp'||e.key==='ArrowDown')){
        e.preventDefault(); var sib=e.key==='ArrowUp'?item.previousElementSibling:item.nextElementSibling;
        if(!sib)return; var after=e.key==='ArrowDown'; nexusSidebarMoveBefore(item.id,sib.id,after); var nextHandle=sib.querySelector('.sidebar-nav-drag-handle'); if(nextHandle)nextHandle.focus();
      }
    });
    item.insertBefore(handle,item.firstChild);
    item.addEventListener('dragover',function(e){
      if(!dragId||dragId===item.id)return;
      e.preventDefault(); e.dataTransfer.dropEffect='move';
      var rect=item.getBoundingClientRect();var after=(e.clientY-rect.top)>rect.height/2;
      item.classList.remove('sidebar-nav-drag-over-before','sidebar-nav-drag-over-after');
      item.classList.add(after?'sidebar-nav-drag-over-after':'sidebar-nav-drag-over-before');item.dataset.nexusDropAfter=after?'1':'0';
    });
    item.addEventListener('dragleave',function(){item.classList.remove('sidebar-nav-drag-over-before','sidebar-nav-drag-over-after');});
    item.addEventListener('drop',function(e){
      e.preventDefault();
      var src=dragId; var after=item.dataset.nexusDropAfter==='1';
      item.classList.remove('sidebar-nav-drag-over-before','sidebar-nav-drag-over-after');
      dragId=null;
      if(src&&src!==item.id)nexusSidebarMoveBefore(src,item.id,after);
    });
  });
}
function nexusSidebarResetOrder(){
  try{localStorage.removeItem(NEXUS_SIDEBAR_ORDER_KEY);}catch(ignore){}
  var list=document.getElementById('sidebar-nav-list');if(!list)return;
  if(!nexusSidebarInitialOrder) nexusSidebarInitialOrder=nexusSidebarDefaultOrder();
  var defaults=nexusSidebarInitialOrder.slice();
  var current=Array.prototype.slice.call(list.children);
  var byId={};current.forEach(function(el){if(el.id)byId[el.id]=el;});
  defaults.forEach(function(id){if(byId[id])list.appendChild(byId[id]);});
  toast('Sidebar order reset.');
}
function initNexusSidebarOrdering(){
  if(nexusSidebarOrderBooted)return;nexusSidebarOrderBooted=true;
  var bind=function(){
    nexusSidebarDecorate();
    var reset=document.getElementById('sidebar-order-reset-btn'); if(reset){reset.onclick=function(){nexusSidebarResetOrder();};}
    window.NexusSidebar={resetOrder:nexusSidebarResetOrder,getOrder:function(){return (nexusSidebarReadOrder()||nexusSidebarDefaultOrder()).slice();}};
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind);else bind();
}
if(typeof document!=='undefined')initNexusSidebarOrdering();
