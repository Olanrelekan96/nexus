/* ============================================================
 * 33-footnotes.js
 * Native footnote references + definitions for Nexus.
 *
 * Supported syntax:
 *   [^note]              inline footnote reference
 *   [^note]: Footnote text   definition (can live in any block)
 *
 * The bottom-of-page footnote panel resolves references to definitions,
 * assigns readable numbers by first use, and provides bidirectional jumps
 * between a reference and its definition. Footnotes remain plain block text
 * so they continue to work with backup, sync, version history, Markdown
 * import/export, search, locks and the existing outliner.
 * ============================================================ */
"use strict";

var FOOTNOTE_REF_RE = /\[\^([A-Za-z0-9][A-Za-z0-9:_-]*)\]/g;
var FOOTNOTE_DEF_RE = /^\[\^([A-Za-z0-9][A-Za-z0-9:_-]*)\]:[ \t]?(.*)$/;
var FOOTNOTE_MAX_DEPTH = 3;

function isFootnoteDefinition(text){
  return FOOTNOTE_DEF_RE.test(text || '');
}

function footnoteDefinitionInfo(text){
  var m = (text || '').match(FOOTNOTE_DEF_RE);
  return m ? {id:m[1], text:m[2] || ''} : null;
}

function walkPageBlocksForFootnotes(page, fn){
  if(!page) return;
  function walk(ids){
    (ids || []).forEach(function(id){
      var b = state.blocks[id];
      if(!b) return;
      fn(b);
      walk(b.children || []);
    });
  }
  walk(page.rootBlocks || []);
}

function getPageFootnoteModel(page){
  var defs = {};
  var defOrder = [];
  var refs = [];
  var refSeen = {};
  var sequence = 0;

  walkPageBlocksForFootnotes(page, function(block){
    var def = footnoteDefinitionInfo(block.text || '');
    if(def){
      if(!defs[def.id]){
        defs[def.id] = {id:def.id, text:def.text, blockId:block.id, firstOrder:sequence++};
        defOrder.push(def.id);
      }
      return;
    }
    var re = new RegExp(FOOTNOTE_REF_RE.source, 'g'), m;
    while((m = re.exec(block.text || ''))){
      var id = m[1];
      if(!refSeen[id]){
        refSeen[id] = true;
        refs.push({id:id, blockId:block.id, occurrenceIndex:m.index});
      }
    }
  });

  var numberById = {};
  refs.forEach(function(ref, i){ numberById[ref.id] = i + 1; });
  var ordered = refs.map(function(ref){
    return {
      id: ref.id,
      number: numberById[ref.id],
      definition: defs[ref.id] || null,
      firstRefBlockId: ref.blockId
    };
  });
  defOrder.forEach(function(id){
    if(!numberById[id]) ordered.push({id:id, number:null, definition:defs[id], firstRefBlockId:null});
  });

  return {definitions:defs, definitionOrder:defOrder, references:refs, numberById:numberById, ordered:ordered};
}

function renderFootnoteRefHtml(id, depth, modelOverride){
  var page = state.pages[state.currentPageId];
  var model = modelOverride || getPageFootnoteModel(page);
  var n = model.numberById[id];
  var label = String(n || '?');
  var exists = !!model.definitions[id];
  return '<sup class="footnote-ref-wrap">' +
    '<span class="footnote-ref' + (exists ? '' : ' footnote-ref-missing') + '"' +
    ' data-footnote-id="'+escapeHtml(id)+'"' +
    ' title="'+escapeHtml(exists ? 'Go to footnote ' + label : 'Missing footnote definition')+'"' +
    ' role="button" tabindex="0">' + escapeHtml(label) + '</span>' +
    '</sup>';
}

function buildFootnoteRefNode(id){
  var page = state.pages[state.currentPageId];
  var model = getPageFootnoteModel(page);
  var el = document.createElement('span');
  el.className = 'footnote-ref' + (model.definitions[id] ? '' : ' footnote-ref-missing');
  el.dataset.footnoteId = id;
  el.contentEditable = 'false';
  el.setAttribute('role','button');
  el.setAttribute('tabindex','0');
  el.textContent = model.numberById[id] || '?';
  el.title = model.definitions[id] ? ('Go to footnote ' + (model.numberById[id] || id)) : 'Missing footnote definition';
  return el;
}

/* Preserve the existing rich inline renderer while adding footnote tokens.
   Splitting before delegation keeps all existing syntax and nesting behavior
   intact, and the serializer can reconstitute the original [^id] token. */
if(typeof decorateText === 'function' && !decorateText.__nexusFootnotesWrapped){
  var nexusOriginalDecorateText = decorateText;
  var wrappedDecorateTextFootnotes = function(text, depth){
    depth = depth || 0;
    if(!text) return '';
    var re = new RegExp(FOOTNOTE_REF_RE.source, 'g');
    var model = getPageFootnoteModel(state.pages[state.currentPageId]);
    var out = '', last = 0, m;
    while((m = re.exec(text))){
      out += nexusOriginalDecorateText(text.slice(last, m.index), depth);
      out += renderFootnoteRefHtml(m[1], depth, model);
      last = re.lastIndex;
    }
    out += nexusOriginalDecorateText(text.slice(last), depth);
    return out;
  };
  wrappedDecorateTextFootnotes.__nexusFootnotesWrapped = true;
  decorateText = wrappedDecorateTextFootnotes;
}

if(typeof buildInlineNodes === 'function' && !buildInlineNodes.__nexusFootnotesWrapped){
  var nexusOriginalBuildInlineNodes = buildInlineNodes;
  var wrappedBuildInlineNodesFootnotes = function(text){
    var frag = document.createDocumentFragment();
    if(!text) return frag;
    var re = new RegExp(FOOTNOTE_REF_RE.source, 'g');
    var last = 0, m;
    function appendPlain(s){ if(s) frag.appendChild(nexusOriginalBuildInlineNodes(s)); }
    while((m = re.exec(text))){
      appendPlain(text.slice(last, m.index));
      frag.appendChild(buildFootnoteRefNode(m[1]));
      last = re.lastIndex;
    }
    appendPlain(text.slice(last));
    return frag;
  };
  wrappedBuildInlineNodesFootnotes.__nexusFootnotesWrapped = true;
  buildInlineNodes = wrappedBuildInlineNodesFootnotes;
}

/* [^id] serialisation lives in serializeInline() itself (00-state-and-helpers.js).
   It used to be a wrapper here that handed each child *element* to the original as if it were
   the parent; the original serialises an element's children, not the element, so every <strong>,
   <em>, <del>, <code>, highlight/colour span, link and attachment widget in an editing block was
   flattened to bare text on save (typed **bold**, toolbar formatting and attached images were
   silently lost). */

function footnoteSelectorEscape(value){
  value = String(value || '');
  if(window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, function(ch){ return '\\' + ch; });
}

function scrollToFootnoteDefinition(id){
  var page = state.pages[state.currentPageId];
  var model = getPageFootnoteModel(page);
  var def = model.definitions[id];
  if(!def) return false;
  var row = document.querySelector('.block-row[data-id="'+footnoteSelectorEscape(def.blockId)+'"]');
  if(row){
    row.scrollIntoView({behavior:'smooth', block:'center'});
    row.classList.add('footnote-target-highlight');
    setTimeout(function(){ row.classList.remove('footnote-target-highlight'); }, 1200);
    return true;
  }
  var panel = document.querySelector('.footnote-item[data-footnote-id="'+footnoteSelectorEscape(id)+'"]');
  if(panel){ panel.scrollIntoView({behavior:'smooth', block:'center'}); return true; }
  return false;
}

function scrollToFootnoteReference(id){
  var row = document.querySelector('.footnote-ref[data-footnote-id="'+footnoteSelectorEscape(id)+'"]');
  if(row){
    row.scrollIntoView({behavior:'smooth', block:'center'});
    row.classList.add('footnote-ref-highlight');
    setTimeout(function(){ row.classList.remove('footnote-ref-highlight'); }, 1000);
    return true;
  }
  return false;
}

function renderFootnotes(page){
  var existing = document.getElementById('page-footnotes');
  if(existing) existing.remove();
  var anchor = document.getElementById('add-root-block');
  if(!anchor || !page) return;
  var model = getPageFootnoteModel(page);
  if(!model.ordered.length) return;

  var panel = document.createElement('section');
  panel.id = 'page-footnotes';
  panel.className = 'page-footnotes';
  panel.setAttribute('aria-labelledby','page-footnotes-title');

  var head = document.createElement('div');
  head.className = 'page-footnotes-head';
  var title = document.createElement('h3');
  title.id = 'page-footnotes-title';
  title.textContent = 'Footnotes';
  var addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'page-footnotes-add';
  addBtn.textContent = '＋ Add footnote';
  addBtn.title = 'Create a footnote definition on this page';
  addBtn.addEventListener('click', function(){
    createFootnoteOnPage(page, null, true);
  });
  head.appendChild(title); head.appendChild(addBtn); panel.appendChild(head);

  var list = document.createElement('ol');
  list.className = 'footnote-list';
  model.ordered.forEach(function(item){
    var li = document.createElement('li');
    li.className = 'footnote-item' + (!item.definition ? ' footnote-item-missing' : '');
    li.dataset.footnoteId = item.id;
    var num = document.createElement('button');
    num.type = 'button';
    num.className = 'footnote-number';
    num.textContent = item.number || '•';
    num.title = item.firstRefBlockId ? 'Jump to reference' : 'Unreferenced footnote';
    num.onclick = function(){
      if(!item.firstRefBlockId || !scrollToFootnoteReference(item.id)){
        var r = document.querySelector('.block-row[data-id="'+footnoteSelectorEscape(item.definition && item.definition.blockId || '')+'"]');
        if(r) r.scrollIntoView({behavior:'smooth', block:'center'});
      }
    };
    var body = document.createElement('div');
    body.className = 'footnote-body';
    if(item.definition){
      var text = document.createElement('div');
      text.innerHTML = decorateText(item.definition.text);
      body.appendChild(text);
      var meta = document.createElement('div');
      meta.className = 'footnote-meta';
      meta.textContent = item.firstRefBlockId ? ('Reference ' + (item.number || '') + ' · source block') : 'Unreferenced definition';
      body.appendChild(meta);
    } else {
      var missing = document.createElement('div');
      missing.className = 'footnote-missing-copy';
      missing.textContent = 'Missing definition for [^' + item.id + ']';
      body.appendChild(missing);
    }
    li.appendChild(num); li.appendChild(body); list.appendChild(li);
  });
  panel.appendChild(list);
  anchor.parentNode.insertBefore(panel, anchor.nextSibling);

  panel.addEventListener('click', function(e){
    var link = e.target.closest && e.target.closest('.link');
    if(link && link.dataset.target){ openPageByTitle(link.dataset.target, 'page'); }
  });
}

function createFootnoteId(page){
  var model = getPageFootnoteModel(page);
  var i = 1, candidate = 'fn-' + i;
  while(model.definitions[candidate]){ i++; candidate = 'fn-' + i; }
  return candidate;
}

function appendFootnoteDefinition(page, id, text){
  id = (id || '').trim().replace(/[^A-Za-z0-9:_-]/g,'-') || createFootnoteId(page);
  var model = getPageFootnoteModel(page);
  if(model.definitions[id]){
    var n = 2, base = id;
    while(model.definitions[id]){ id = base + '-' + n++; }
  }
  var bid = uid();
  state.blocks[bid] = mkBlock(bid, page.id, null, '[^' + id + ']: ' + (text || '').trim());
  page.rootBlocks.push(bid);
  save();
  return {id:id, blockId:bid};
}

function createFootnoteOnPage(page, insertIntoBlock, promptText){
  if(!page || page.locked || page.trashedAt){ toast('This page cannot be edited.'); return null; }
  var text = window.prompt('Footnote text:', '');
  if(text === null) return null;
  text = text.trim();
  if(!text){ toast('Footnote not created — text is empty.'); return null; }
  var id = createFootnoteId(page);
  var made = appendFootnoteDefinition(page, id, text);
  if(insertIntoBlock){
    var b = insertIntoBlock;
    var caretText = (b.text || '');
    b.text = caretText + ' [^' + made.id + ']';
    save();
  }
  renderAll();
  toast('Footnote ' + made.id + ' created.');
  return made;
}

/* Slash-command integration is deliberately additive so existing command
   ordering and all other commands stay untouched. */
if(typeof slashCommandList === 'function' && !slashCommandList.__nexusFootnotesWrapped){
  var nexusOriginalSlashCommandListFootnotes = slashCommandList;
  var wrappedSlashCommandListFootnotes = function(){
    var cmds = nexusOriginalSlashCommandListFootnotes();
    cmds.splice(8, 0, {
      icon:'¹', label:'Footnote…', sub:'Insert', keywords:'footnote citation reference note source scholar',
      run:function(ctx){
        var page = state.pages[state.currentPageId];
        if(!page || page.locked){ toast('Unlock this page before adding a footnote.'); return; }
        var text = window.prompt('Footnote text:', '');
        if(text === null || !text.trim()) return;
        var next = ctx.head + '[^fn-placeholder]' + ctx.tail;
        applyBlockText(ctx.block, next, ctx.head.length + 15);
        var made = appendFootnoteDefinition(page, createFootnoteId(page), text.trim());
        ctx.block.text = ctx.block.text.replace('[^fn-placeholder]', '[^' + made.id + ']');
        save(); renderPage();
        focusBlock(ctx.block.id, ctx.head.length + made.id.length + 4);
        toast('Footnote ' + made.id + ' inserted.');
      }
    });
    return cmds;
  };
  wrappedSlashCommandListFootnotes.__nexusFootnotesWrapped = true;
  slashCommandList = wrappedSlashCommandListFootnotes;
}

/* Render after the normal page renderer so the footnote panel is rebuilt from
   committed state on every navigation/edit/reload. */
if(typeof renderPage === 'function' && !renderPage.__nexusFootnotesWrapped){
  var nexusOriginalRenderPageFootnotes = renderPage;
  var wrappedRenderPageFootnotes = function(){
    var r = nexusOriginalRenderPageFootnotes.apply(this, arguments);
    var page = state.pages[state.currentPageId];
    renderFootnotes(page);
    return r;
  };
  wrappedRenderPageFootnotes.__nexusFootnotesWrapped = true;
  renderPage = wrappedRenderPageFootnotes;
}

/* Click/keyboard activation for inline refs. */
if(typeof document !== 'undefined'){
  var footnoteUiBind = function(){
    if(document.__nexusFootnotesBound) return;
    document.__nexusFootnotesBound = true;
    document.addEventListener('click', function(e){
      var ref = e.target.closest && e.target.closest('.footnote-ref');
      if(!ref) return;
      if(document.activeElement && document.activeElement.contentEditable === 'true') return;
      e.preventDefault(); e.stopPropagation();
      scrollToFootnoteDefinition(ref.dataset.footnoteId || '');
    });
    document.addEventListener('keydown', function(e){
      var ref = e.target.closest && e.target.closest('.footnote-ref');
      if(!ref || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      scrollToFootnoteDefinition(ref.dataset.footnoteId || '');
    });
  };
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', footnoteUiBind); else footnoteUiBind();
}
