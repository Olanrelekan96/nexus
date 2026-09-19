/* ============================================================
 * 11-import-export.js
 * Markdown export, markdown import, and PDF export.
 *
 * Part of Nexus — loaded as a plain <script> (not a module) in
 * index.html, in numeric filename order. All files share one global
 * scope on purpose (same as the original single-file build), so
 * `state`, helper functions, etc. declared in an earlier file are
 * directly usable here without imports.
 * ============================================================ */
"use strict";

/* ============================================================
   MARKDOWN EXPORT
   Walks the current page's block tree into a plain .md file.
   Formatting (**bold**, ~~strike~~, `code`, ``` fences, [[links]],
   #tags) is already close to Markdown, so it passes through mostly
   unchanged. Block refs ((id)) are flattened to the referenced
   text (Markdown has no live-embed equivalent), and attachments are
   inlined as data-URI images/links so the .md file stays a single,
   self-contained, portable file — same philosophy as Backup.
   ============================================================ */
function blockRefPreview(id){
  var b = state.blocks[id];
  if(!b) return '(missing reference)';
  return (b.text||'').replace(/\s+/g,' ').trim().slice(0,140);
}
function collectAttachmentIds(ids, set){
  ids.forEach(function(id){
    var b = state.blocks[id];
    if(!b) return;
    var re = /\{\{(?:img|file):([^}]+)\}\}/g, m;
    while((m = re.exec(b.text||''))){ set.add(parseAttRef(m[1]).id); }
    collectAttachmentIds(b.children||[], set);
  });
}
function buildPageMarkdown(page){
  var attIds = new Set();
  collectAttachmentIds(page.rootBlocks||[], attIds);

  return Promise.all(Array.from(attIds).map(function(id){
    return getAttachment(id).then(function(rec){
      if(!rec) return [id, null];
      return blobToBase64(rec.blob).then(function(b64){
        return [id, 'data:' + (rec.type||'application/octet-stream') + ';base64,' + b64];
      });
    }).catch(function(){ return [id, null]; });
  })).then(function(pairs){
    var attData = {};
    pairs.forEach(function(p){ attData[p[0]] = p[1]; });

    function replaceAttachments(text){
      return text.replace(/\{\{(img|file):([^}]+)\}\}/g, function(_, kind, raw){
        var parsed = parseAttRef(raw);
        var uri = attData[parsed.id];
        var name = parsed.name || (kind==='img' ? 'image' : 'file');
        if(!uri) return '*(' + (kind==='img'?'image':'file') + ' not available on this device: ' + name + ')*';
        return kind==='img' ? '![' + name + '](' + uri + ')' : '[' + name + '](' + uri + ')';
      });
    }
    function replaceBlockRefs(text){
      return text.replace(/\(\(([a-zA-Z0-9_-]{4,})\)\)/g, function(match, id, offset, full){
        if(offset > 0 && full.charAt(offset - 1) === '!') return match; /* preserve !((id)) block transclusions */
        return blockRefPreview(id);
      });
    }

    var lines = [];
    function emitBlock(id, depth){
      var b = state.blocks[id];
      if(!b) return;
      var text = replaceBlockRefs(replaceAttachments(b.text||''));
      var textLines = text.split('\n');
      var indent = '  '.repeat(depth);
      if(/^```/.test(textLines[0]||'')){
        /* Fenced code blocks are left unindented so they still render
           as real code fences rather than being swallowed into the
           list-item's own indentation rules. */
        lines.push(indent + '- ');
        textLines.forEach(function(l){ lines.push(l); });
      } else {
        lines.push(indent + '- ' + textLines[0]);
        for(var i=1;i<textLines.length;i++){ lines.push(indent + '  ' + textLines[i]); }
      }
      (b.children||[]).forEach(function(cid){ emitBlock(cid, depth+1); });
    }

    lines.push('# ' + (page.title || 'Untitled'));
    if(page.properties && page.properties.length){
      lines.push('');
      page.properties.forEach(function(p){ lines.push('*' + p.key + ':* ' + p.value); });
    }
    lines.push('');
    (page.rootBlocks||[]).forEach(function(id){ emitBlock(id, 0); });
    return lines.join('\n') + '\n';
  });
}
/* ============================================================
   MARKDOWN IMPORT
   Best-effort: turns a folder of .md files (dragged/selected via the
   file picker — browsers don't allow silently reading a whole folder
   without one click of consent) into real Nexus pages. Each file
   becomes one page named after its filename; headers become bold
   lines, "- [ ]"/"- [x]" become real todo blocks, and indentation
   (spaces or tabs) becomes outline nesting. Inline markdown syntax
   (bold/italic/links) is left as-is in the text, since Nexus's own
   renderer already understands the common subset.
   ============================================================ */
function mdPageTitleFor(filename){
  var base = filename.replace(/\.md$/i, '').replace(/\.markdown$/i, '');
  var title = base;
  var n = 2;
  while(findPageByTitle(title)){
    title = base + ' (imported ' + n + ')';
    n++;
  }
  return title;
}
function parseMarkdownIntoBlocks(pageId, text){
  var page = state.pages[pageId];
  var lines = text.replace(/\r\n/g, '\n').split('\n');
  var stack = []; /* {indent, id, heading, level} from root down */
  var HEADING_SCALE = 1000;
  var headingBase = 0;

  function addLine(depth, lineText, isHeading, headingLevel){
    if(!lineText) return;
    while(stack.length && stack[stack.length-1].indent >= depth) stack.pop();
    var parent = stack.length ? stack[stack.length-1] : null;
    var id = uid();
    state.blocks[id] = mkBlock(id, pageId, parent ? parent.id : null, lineText);
    if(parent){ state.blocks[parent.id].children.push(id); }
    else { page.rootBlocks.push(id); }
    stack.push({
      indent: depth,
      id: id,
      heading: !!isHeading,
      level: headingLevel || 0
    });
  }

  lines.forEach(function(raw){
    if(!raw.trim()) return;
    var m = raw.match(/^(\s*)(.*)$/);
    var leading = m[1].replace(/\t/g, '  ');
    var indentLevel = Math.floor(leading.length / 2);
    var rest = m[2];

    var heading = rest.match(/^(#{1,6})\s+(.*)$/);
    var todoBullet = rest.match(/^[-*]\s+\[( |x|X)\]\s?(.*)$/);
    var bullet = rest.match(/^[-*]\s+(.*)$/);
    var numbered = rest.match(/^\d+[.)]\s+(.*)$/);

    if(heading){
      var level = heading[1].length;
      var headingDepth = (level - 1) * HEADING_SCALE;

      /* Heading levels define hierarchy independently of the indentation of
         preceding list/paragraph items. Pop non-heading content first, then
         pop headings at the same or deeper level. */
      while(stack.length && !stack[stack.length-1].heading) stack.pop();
      while(stack.length && stack[stack.length-1].heading && stack[stack.length-1].level >= level) stack.pop();

      addLine(headingDepth, heading[1] + ' ' + heading[2].trim(), true, level);
      headingBase = headingDepth + 1;
    } else if(todoBullet){
      addLine(headingBase + indentLevel, '[' + (todoBullet[1].toLowerCase()==='x'?'x':' ') + '] ' + todoBullet[2]);
    } else if(bullet){
      addLine(headingBase + indentLevel, bullet[1]);
    } else if(numbered){
      addLine(headingBase + indentLevel, numbered[1]);
    } else {
      addLine(headingBase + indentLevel, rest);
    }
  });
}
function importMarkdownFiles(fileList){
  var files = Array.prototype.filter.call(fileList, function(f){
    return /\.(md|markdown)$/i.test(f.name);
  });
  if(!files.length){ toast('No .md files found in that selection.'); return; }
  toast('Importing ' + files.length + ' file' + (files.length===1?'':'s') + '…');
  Promise.all(files.map(function(f){
    return f.text().then(function(text){ return {name: f.name, text: text}; });
  })).then(function(results){
    results.forEach(function(r){
      var title = mdPageTitleFor(r.name);
      var id = uid();
      state.pages[id] = {id:id, title:title, type:'page', createdAt: Date.now(), properties:[], rootBlocks:[]};
      state.titleIndex[title.toLowerCase()] = id;
      parseMarkdownIntoBlocks(id, r.text);
    });
    save();
    renderAll();
    toast('Imported ' + results.length + ' page' + (results.length===1?'':'s') + ' from Markdown.');
  }).catch(function(){
    toast('Could not read one or more of those files.');
  });
}

function exportPageAsMarkdown(){
  var page = state.pages[state.currentPageId];
  if(!page){ toast('Open a page first.'); return; }
  toast('Preparing Markdown export…');
  buildPageMarkdown(page).then(function(md){
    var fname = (page.title||'untitled').replace(/[\\/:*?"<>|]+/g,'_').trim() + '.md';
    var blob = new Blob([md], {type:'text/markdown'});
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = fname;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('Markdown exported: ' + fname);
  }).catch(function(){ toast('Could not export this page as Markdown.'); });
}

/* ============================================================
   PDF EXPORT
   Rather than re-rendering the page in a separate library (which
   would risk drifting from what's actually on screen), this hands
   the already-hydrated live page off to the browser's own print
   pipeline — the @media print rules above strip the sidebar/toolbar
   chrome down to just the outline, and "Save as PDF" in the print
   dialog is a real destination in every major browser.
   ============================================================ */
function exportPageAsPdf(){
  if(!document.getElementById('page-view').classList.contains('visible')){
    toast('Switch to a page (out of Graph view) to export it as PDF.');
    return;
  }
  toast('Opening the print dialog — choose "Save as PDF" as the destination.');
  setTimeout(function(){ window.print(); }, 80);
}

