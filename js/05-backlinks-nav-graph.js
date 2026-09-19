/* ============================================================
 * 05-backlinks-nav-graph.js
 * Backlinks panel, command palette (Cmd+K), and graph view.
 *
 * Part of Nexus — loaded as a plain <script> (not a module) in
 * index.html, in numeric filename order. All files share one global
 * scope on purpose (same as the original single-file build), so
 * `state`, helper functions, etc. declared in an earlier file are
 * directly usable here without imports.
 * ============================================================ */
"use strict";

/* ============================================================
   BACKLINKS
   ============================================================ */
function pagesRelatingTo(page){
  var hits = [];
  livePages().forEach(function(p){
    if(p.id === page.id) return;
    (p.properties||[]).forEach(function(pp){
      if(pp.type !== 'relation') return;
      var titles = (pp.value||'').split(',').map(function(s){ return s.trim().toLowerCase(); });
      if(titles.indexOf(page.title.toLowerCase()) !== -1) hits.push({page:p, key:pp.key});
    });
  });
  return hits;
}

function renderBacklinks(page){
  var wrap = document.getElementById('backlinks');
  wrap.innerHTML = "";
  var groups = {};
  Object.keys(state.blocks).forEach(function(id){
    var blk = state.blocks[id];
    if(blk.pageId === page.id) return;
    var refs = extractRefs(blk.text);
    var hit = refs.some(function(r){ return r.title.toLowerCase() === page.title.toLowerCase(); });
    if(hit){
      groups[blk.pageId] = groups[blk.pageId] || [];
      groups[blk.pageId].push(blk);
    }
  });
  var pageIds = Object.keys(groups);
  var relHits = pagesRelatingTo(page);
  if(!pageIds.length && !relHits.length){
    wrap.innerHTML = '<div class="no-refs">Nothing links here yet.</div>';
    return;
  }
  pageIds.forEach(function(pid){
    var srcPage = state.pages[pid];
    if(!srcPage) return;
    var g = document.createElement('div'); g.className='ref-group';
    var title = document.createElement('div'); title.className='ref-group-title';
    title.textContent = srcPage.title + " (" + groups[pid].length + ")";
    title.onclick = function(){ openPage(pid); };
    g.appendChild(title);
    groups[pid].forEach(function(blk){
      var rb = document.createElement('div'); rb.className='ref-block';
      rb.innerHTML = decorateText(blk.text);
      g.appendChild(rb);
    });
    wrap.appendChild(g);
  });
  if(relHits.length){
    var relGroup = document.createElement('div'); relGroup.className = 'ref-group';
    var relTitle = document.createElement('div'); relTitle.className = 'ref-group-title';
    relTitle.textContent = 'Related pages (' + relHits.length + ')';
    relGroup.appendChild(relTitle);
    relHits.forEach(function(hit){
      var rb = document.createElement('div'); rb.className = 'ref-block';
      var link = document.createElement('span'); link.className = 'link'; link.dataset.target = hit.page.title; link.textContent = hit.page.title;
      rb.appendChild(link);
      var meta = document.createElement('span'); meta.style.cssText = 'color:var(--ink-soft); font-size:0.75rem;';
      meta.textContent = ' — via ' + hit.key;
      rb.appendChild(meta);
      relGroup.appendChild(rb);
    });
    wrap.appendChild(relGroup);
  }
}

/* ============================================================
   COMMAND PALETTE
   ============================================================ */
var paletteActiveIndex = 0;
function openPalette(){
  document.getElementById('palette-overlay').classList.add('visible');
  var input = document.getElementById('palette-input');
  input.value = "";
  renderPaletteResults("");
  setTimeout(function(){ input.focus(); }, 0);
}
function closePalette(){
  document.getElementById('palette-overlay').classList.remove('visible');
}
function renderPaletteResults(q){
  paletteActiveIndex = 0;
  var results = document.getElementById('palette-results');
  results.innerHTML = "";
  var qTrim = q.trim();
  var pages = livePages();
  /* Same advanced operators as the sidebar search box (#tag, is:,
     has:, due:, /regex/, "OR", etc. — see 17-advanced-search.js);
     plain text still ranks exactly as it did before. */
  var pageMatches = rankPages(pages, q).slice(0,6).map(function(x){ return x.item; });
  var items = pageMatches.map(function(p){
    return {label:p.title, sub:p.type, action:function(){ openPage(p.id); }};
  });

  /* A single command registry makes Cmd/Ctrl+K useful for actions as well
     as navigation. Slash commands continue to handle editor-local actions;
     this palette is for app-wide actions. */
  var globalCommands = [
    {label:'Command Center', sub:'Command', keywords:'control room commands hub center', action:function(){ if(typeof showCommandCenterView==='function') showCommandCenterView(); }},
    {label:'New page', sub:'Command', keywords:'new create page', action:function(){ document.getElementById('btn-new-page').click(); }},
    {label:'Search everything', sub:'Command', keywords:'search find all notes', action:function(){ openGlobalSearch(); }},
    {label:'Tasks', sub:'Command', keywords:'tasks todo checklist', action:function(){ document.getElementById('btn-tasks').click(); }},
    {label:'Graph view', sub:'Command', keywords:'graph links network', action:function(){ document.getElementById('btn-graph').click(); }},
    {label:'Settings', sub:'Command', keywords:'preferences options', action:function(){ openSettings(); }},
    {label:'Backup now', sub:'Command', keywords:'backup export save', action:function(){ backup(); }},
    {label:'Version history', sub:'Command', keywords:'history restore snapshot', action:function(){ openVersions(); }},
    {label:'Data health', sub:'Command', keywords:'storage diagnostics attachments health', action:function(){ if(typeof openDataHealth==='function') openDataHealth(); }},
    {label:'Sync devices', sub:'Command', keywords:'sync lan webrtc devices', action:function(){ openSyncModal(); }}
  ];
  if(qTrim){
    var ql=qTrim.toLowerCase();
    var commandMatches=globalCommands.filter(function(c){ return c.label.toLowerCase().indexOf(ql)!==-1 || c.keywords.indexOf(ql)!==-1; });
    commandMatches.slice(0,6).forEach(function(c){ items.push(c); });
  }
  if(qTrim && !findPageByTitle(qTrim)){
    items.unshift({label: 'Create page "'+qTrim+'"', sub:'new', action:function(){ openPageByTitle(qTrim, 'page'); }});
  }

  var divider = null;
  if(qTrim.length > 1){
    var blockHits = findMatchingBlocks(qTrim, 6);
    if(blockHits.length){
      divider = items.length;
      blockHits.forEach(function(hit){
        var pageLabel = hit.page.type === 'tag' ? '#'+hit.page.title : hit.page.title;
        items.push({
          label: buildSnippetHtml(hit.block.text, qTrim),
          sub: 'in ' + pageLabel,
          isHtml: true,
          action: function(){ revealBlock(hit.block.id); }
        });
      });
    }
  }

  if(!items.length){
    results.innerHTML = '<div class="palette-item">No pages or lines yet — type a name to create a page</div>';
    return;
  }
  items.forEach(function(it, i){
    if(divider !== null && i === divider){
      var head = document.createElement('div');
      head.className = 'palette-divider';
      head.textContent = 'Matching lines';
      results.appendChild(head);
    }
    var div = document.createElement('div');
    div.className = 'palette-item' + (i===0 ? ' active' : '');
    var labelHtml = it.isHtml ? it.label : escapeHtml(it.label);
    div.innerHTML = '<span class="pi-snippet">'+labelHtml+'</span><span class="pi-type">'+escapeHtml(it.sub)+'</span>';
    div.onclick = function(){ it.action(); closePalette(); };
    div._action = it.action;
    results.appendChild(div);
  });
}

document.getElementById('palette-input').addEventListener('input', function(e){
  renderPaletteResults(e.target.value);
});
document.getElementById('palette-input').addEventListener('keydown', function(e){
  var items = Array.prototype.slice.call(document.querySelectorAll('.palette-item'));
  if(e.key === 'ArrowDown'){ e.preventDefault(); movePaletteSel(items, 1); }
  else if(e.key === 'ArrowUp'){ e.preventDefault(); movePaletteSel(items, -1); }
  else if(e.key === 'Enter'){
    e.preventDefault();
    var active = items[paletteActiveIndex];
    if(active && active._action){ active._action(); closePalette(); }
  } else if(e.key === 'Escape'){ closePalette(); }
});
function movePaletteSel(items, dir){
  if(!items.length) return;
  items[paletteActiveIndex].classList.remove('active');
  paletteActiveIndex = (paletteActiveIndex + dir + items.length) % items.length;
  items[paletteActiveIndex].classList.add('active');
}
document.getElementById('palette-overlay').addEventListener('click', function(e){
  if(e.target.id === 'palette-overlay') closePalette();
});

/* ============================================================
   GRAPH VIEW
   ============================================================ */
var graphView = {scale:1, tx:0, ty:0};

function graphClampScale(s){ return Math.max(0.4, Math.min(3, s)); }

function graphApplyTransform(){
  var viewport = document.getElementById('graph-viewport');
  if(viewport) viewport.setAttribute('transform',
    'translate(' + graphView.tx + ',' + graphView.ty + ') scale(' + graphView.scale + ')');
}

/* Converts a mouse/pointer event's screen coordinates into the graph's
   own (pre-transform) coordinate space, so panning/zooming/dragging all
   stay anchored under the cursor regardless of current pan/zoom. */
function graphPointFromEvent(svg, evt){
  var rect = svg.getBoundingClientRect();
  var vb = svg.viewBox.baseVal;
  var sx = (evt.clientX - rect.left) * (vb.width / rect.width);
  var sy = (evt.clientY - rect.top) * (vb.height / rect.height);
  return {x: (sx - graphView.tx) / graphView.scale, y: (sy - graphView.ty) / graphView.scale};
}

function renderGraph(){
  var svg = document.getElementById('graph-svg');
  svg.innerHTML = "";
  svg.classList.remove('hover-active', 'panning');
  graphView = {scale:1, tx:0, ty:0};

  var pages = livePages();
  var nodes = pages.map(function(p){
    return {id:p.id, title:p.title, type:p.type, x: Math.random()*900+50, y: Math.random()*580+30, vx:0, vy:0, degree:0};
  });
  var nodeById = {};
  nodes.forEach(function(n){ nodeById[n.id]=n; });

  var edges = [];
  Object.keys(state.blocks).forEach(function(bid){
    var blk = state.blocks[bid];
    var refs = extractRefs(blk.text);
    refs.forEach(function(r){
      var target = findPageByTitle(r.title);
      if(target && target.id !== blk.pageId && nodeById[target.id] && nodeById[blk.pageId]){
        edges.push({a: blk.pageId, b: target.id});
      }
    });
  });
  edges.forEach(function(e){ if(nodeById[e.a]) nodeById[e.a].degree++; if(nodeById[e.b]) nodeById[e.b].degree++; });

  // simple force simulation (initial layout only — dragging takes over after this)
  for(var iter=0; iter<120; iter++){
    nodes.forEach(function(n1){
      nodes.forEach(function(n2){
        if(n1===n2) return;
        var dx=n1.x-n2.x, dy=n1.y-n2.y;
        var dist = Math.sqrt(dx*dx+dy*dy)||1;
        var force = 1800/(dist*dist);
        n1.vx += (dx/dist)*force; n1.vy += (dy/dist)*force;
      });
    });
    edges.forEach(function(e){
      var n1=nodeById[e.a], n2=nodeById[e.b];
      var dx=n2.x-n1.x, dy=n2.y-n1.y;
      var dist = Math.sqrt(dx*dx+dy*dy)||1;
      var force = dist*0.02;
      n1.vx += (dx/dist)*force; n1.vy += (dy/dist)*force;
      n2.vx -= (dx/dist)*force; n2.vy -= (dy/dist)*force;
    });
    nodes.forEach(function(n){
      n.x += Math.max(-8,Math.min(8,n.vx))*0.5;
      n.y += Math.max(-8,Math.min(8,n.vy))*0.5;
      n.vx*=0.7; n.vy*=0.7;
      n.x = Math.max(30, Math.min(970, n.x));
      n.y = Math.max(20, Math.min(620, n.y));
    });
  }

  var ns = "http://www.w3.org/2000/svg";
  var viewport = document.createElementNS(ns,'g');
  viewport.setAttribute('id','graph-viewport');
  svg.appendChild(viewport);

  var edgesByNode = {}; // nodeId -> [{line, otherId}]
  nodes.forEach(function(n){ edgesByNode[n.id] = []; });

  edges.forEach(function(e){
    var n1=nodeById[e.a], n2=nodeById[e.b];
    var line = document.createElementNS(ns,'line');
    line.setAttribute('x1', n1.x); line.setAttribute('y1', n1.y);
    line.setAttribute('x2', n2.x); line.setAttribute('y2', n2.y);
    line.setAttribute('class','graph-edge');
    viewport.appendChild(line);
    edgesByNode[e.a].push({line:line, otherId:e.b, end:1});
    edgesByNode[e.b].push({line:line, otherId:e.a, end:2});
  });

  var nodeGroups = {}; // nodeId -> <g>

  function setHighlight(nodeId, on){
    svg.classList.toggle('hover-active', on);
    if(!on){
      Object.keys(nodeGroups).forEach(function(id){ nodeGroups[id].classList.remove('hi'); });
      viewport.querySelectorAll('.graph-edge.hi').forEach(function(l){ l.classList.remove('hi'); });
      return;
    }
    var g = nodeGroups[nodeId];
    if(g) g.classList.add('hi');
    (edgesByNode[nodeId]||[]).forEach(function(link){
      link.line.classList.add('hi');
      var other = nodeGroups[link.otherId];
      if(other) other.classList.add('hi');
    });
  }

  nodes.forEach(function(n){
    var g = document.createElementNS(ns,'g');
    g.setAttribute('class', 'graph-node' + (n.type==='tag' ? ' tag' : ''));
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', 'Open ' + n.title);
    var r = 4 + Math.min(10, n.degree*1.6);
    var c = document.createElementNS(ns,'circle');
    c.setAttribute('cx', n.x); c.setAttribute('cy', n.y); c.setAttribute('r', r);
    var t = document.createElementNS(ns,'text');
    t.setAttribute('x', n.x+r+4); t.setAttribute('y', n.y+4);
    t.textContent = n.title;
    g.appendChild(c); g.appendChild(t);
    viewport.appendChild(g);
    nodeGroups[n.id] = g;

    function moveNodeTo(x, y){
      n.x = x; n.y = y;
      c.setAttribute('cx', x); c.setAttribute('cy', y);
      t.setAttribute('x', x+r+4); t.setAttribute('y', y+4);
      (edgesByNode[n.id]||[]).forEach(function(link){
        if(link.end === 1){ link.line.setAttribute('x1', x); link.line.setAttribute('y1', y); }
        else { link.line.setAttribute('x2', x); link.line.setAttribute('y2', y); }
      });
    }

    var dragState = null; // {startClientX, startClientY, moved}
    g.addEventListener('pointerdown', function(e){
      e.stopPropagation();
      g.setPointerCapture(e.pointerId);
      var p = graphPointFromEvent(svg, e);
      dragState = {offX: p.x - n.x, offY: p.y - n.y, moved:false};
      g.classList.add('dragging');
    });
    g.addEventListener('pointermove', function(e){
      if(!dragState) return;
      var p = graphPointFromEvent(svg, e);
      dragState.moved = true;
      moveNodeTo(p.x - dragState.offX, p.y - dragState.offY);
    });
    function endDrag(e){
      if(!dragState) return;
      var wasClick = !dragState.moved;
      dragState = null;
      g.classList.remove('dragging');
      if(wasClick){
        document.getElementById('graph-view').classList.remove('visible');
        document.getElementById('page-view').classList.add('visible');
        openPage(n.id);
      }
    }
    g.addEventListener('pointerup', endDrag);
    g.addEventListener('pointercancel', endDrag);
    g.addEventListener('mouseenter', function(){ setHighlight(n.id, true); });
    g.addEventListener('mouseleave', function(){ setHighlight(n.id, false); });
    g.addEventListener('keydown', function(e){
      if(e.key === 'Enter' || e.key === ' '){
        e.preventDefault();
        document.getElementById('graph-view').classList.remove('visible');
        document.getElementById('page-view').classList.add('visible');
        openPage(n.id);
      }
    });
  });

  graphApplyTransform();
  graphWirePanZoom(svg);
}

/* Panning the empty background + wheel-to-zoom + the +/-/reset
   buttons. Wired once per render since renderGraph rebuilds the svg
   contents from scratch each time. */
function graphWirePanZoom(svg){
  var panState = null;
  svg.addEventListener('pointerdown', function(e){
    if(e.target !== svg && e.target.id !== 'graph-viewport') return; // let node handlers own their own drags
    svg.setPointerCapture(e.pointerId);
    panState = {lastX: e.clientX, lastY: e.clientY};
    svg.classList.add('panning');
  });
  svg.addEventListener('pointermove', function(e){
    if(!panState) return;
    var rect = svg.getBoundingClientRect();
    var vb = svg.viewBox.baseVal;
    var scaleX = vb.width / rect.width, scaleY = vb.height / rect.height;
    graphView.tx += (e.clientX - panState.lastX) * scaleX;
    graphView.ty += (e.clientY - panState.lastY) * scaleY;
    panState.lastX = e.clientX; panState.lastY = e.clientY;
    graphApplyTransform();
  });
  function endPan(){ panState = null; svg.classList.remove('panning'); }
  svg.addEventListener('pointerup', endPan);
  svg.addEventListener('pointercancel', endPan);

  function zoomAt(clientPoint, factor){
    var rect = svg.getBoundingClientRect();
    var vb = svg.viewBox.baseVal;
    var sx = (clientPoint.clientX - rect.left) * (vb.width / rect.width);
    var sy = (clientPoint.clientY - rect.top) * (vb.height / rect.height);
    var oldScale = graphView.scale;
    var newScale = graphClampScale(oldScale * factor);
    if(newScale === oldScale) return;
    /* Keep the exact graph-space point under the cursor stationary:
       screen = graph * scale + translate. */
    var graphX = (sx - graphView.tx) / oldScale;
    var graphY = (sy - graphView.ty) / oldScale;
    graphView.scale = newScale;
    graphView.tx = sx - graphX * newScale;
    graphView.ty = sy - graphY * newScale;
    graphApplyTransform();
  }

  svg.addEventListener('wheel', function(e){
    e.preventDefault();
    zoomAt(e, e.deltaY < 0 ? 1.12 : 1/1.12);
  }, {passive:false});

  var svgCenter = function(){
    var rect = svg.getBoundingClientRect();
    return {clientX: rect.left + rect.width/2, clientY: rect.top + rect.height/2};
  };
  document.getElementById('btn-graph-zoom-in').onclick = function(){ zoomAt(svgCenter(), 1.25); };
  document.getElementById('btn-graph-zoom-out').onclick = function(){ zoomAt(svgCenter(), 1/1.25); };
  document.getElementById('btn-graph-reset-view').onclick = function(){
    graphView = {scale:1, tx:0, ty:0};
    graphApplyTransform();
  };
}

