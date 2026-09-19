/* ============================================================
 * 23-daily-notes.js
 * Logseq-inspired Daily Notes presentation and navigation.
 *
 * Keeps Nexus' existing page/block model intact. Daily notes remain
 * ordinary type=daily pages; this layer adds journal-first chrome,
 * adjacent-day navigation, a date picker, and a focused outliner style.
 * ============================================================ */
"use strict";

var DAILY_NOTE_DATE_FORMAT_HINT = 'Daily journal';

function parseDailyDate(page){
  if(!page || page.type !== 'daily') return null;
  var d = new Date(page.title);
  return isNaN(d.getTime()) ? null : d;
}

function dailyDateKey(d){
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}

function dailyPrettyDate(d){
  if(!d) return '';
  var weekday = d.toLocaleDateString(undefined, {weekday:'long'});
  var date = d.toLocaleDateString(undefined, {month:'long', day:'numeric', year:'numeric'});
  return weekday + ' · ' + date;
}

function dailyDateInputValue(d){
  return d ? dailyDateKey(d) : '';
}

function getDailyPageForDate(d){
  return resolvePage(dateTitle(d), 'daily');
}

function openDailyDate(d, options){
  options = options || {};
  if(!(d instanceof Date) || isNaN(d.getTime())) return;
  var page = getDailyPageForDate(d);
  if(!page.rootBlocks.length && options.addStarter !== false){
    var id = uid();
    state.blocks[id] = mkBlock(id, page.id, null, '');
    page.rootBlocks.push(id);
  }
  save();
  openPage(page.id);
  setTimeout(function(){
    var row = page.rootBlocks.length ? document.querySelector('.block-row[data-id="'+page.rootBlocks[0]+'"] .block-content') : null;
    if(row && !row.textContent.trim() && options.focusNew !== false) row.click();
  }, 0);
}

function shiftDailyPage(delta){
  var page = state.pages[state.currentPageId];
  var d = parseDailyDate(page) || new Date();
  d.setHours(12,0,0,0);
  d.setDate(d.getDate()+delta);
  openDailyDate(d, {focusNew:false});
}

function openDailyToday(){
  var d = new Date();
  d.setHours(12,0,0,0);
  openDailyDate(d, {focusNew:false});
}

function applyDailyDatePicker(value){
  if(!value) return;
  var parts = value.split('-').map(Number);
  if(parts.length !== 3 || parts.some(isNaN)) return;
  openDailyDate(new Date(parts[0], parts[1]-1, parts[2]), {focusNew:true});
}

function ensureDailyJournalChrome(){
  var page = state.pages[state.currentPageId];
  var pageView = document.getElementById('page-view');
  var anchor = document.querySelector('.page-sub-row');
  if(!pageView || !anchor) return;

  var existing = document.getElementById('daily-journal-chrome');
  if(page && page.type === 'daily'){
    var d = parseDailyDate(page);
    pageView.classList.add('daily-note-active');
    if(!existing){
      existing = document.createElement('div');
      existing.id = 'daily-journal-chrome';
      existing.className = 'daily-journal-chrome';
      anchor.insertAdjacentElement('afterend', existing);
    }
    existing.style.display = '';
    existing.innerHTML = '';

    var top = document.createElement('div');
    top.className = 'daily-journal-heading';

    var copy = document.createElement('div');
    copy.className = 'daily-journal-date-copy';
    var eyebrow = document.createElement('div');
    eyebrow.className = 'daily-journal-eyebrow';
    eyebrow.textContent = 'Daily journal';
    var label = document.createElement('div');
    label.className = 'daily-journal-date-label';
    label.textContent = d ? dailyPrettyDate(d) : page.title;
    var hint = document.createElement('div');
    hint.className = 'daily-journal-hint';
    hint.textContent = page.rootBlocks.length + (page.rootBlocks.length === 1 ? ' block' : ' blocks') + ' · everything here behaves like a normal Nexus page';
    copy.appendChild(eyebrow); copy.appendChild(label); copy.appendChild(hint);

    var actions = document.createElement('div');
    actions.className = 'daily-journal-actions';
    function actionButton(labelText, title, handler, cls){
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'daily-journal-btn' + (cls ? ' '+cls : '');
      b.textContent = labelText; b.title = title; b.addEventListener('click', handler);
      return b;
    }
    actions.appendChild(actionButton('‹', 'Previous day', function(){ shiftDailyPage(-1); }));
    actions.appendChild(actionButton('Today', 'Open today\'s daily note', openDailyToday, 'today-btn'));
    actions.appendChild(actionButton('›', 'Next day', function(){ shiftDailyPage(1); }));

    var dateWrap = document.createElement('label');
    dateWrap.className = 'daily-date-picker-wrap';
    dateWrap.title = 'Jump to a date';
    var dateIcon = document.createElement('span'); dateIcon.textContent = '📅';
    var dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.value = dailyDateInputValue(d);
    dateInput.setAttribute('aria-label','Jump to daily note date');
    dateInput.addEventListener('change', function(){ applyDailyDatePicker(this.value); });
    dateWrap.appendChild(dateIcon); dateWrap.appendChild(dateInput);
    actions.appendChild(dateWrap);

    top.appendChild(copy); top.appendChild(actions);
    existing.appendChild(top);

    var rule = document.createElement('div');
    rule.className = 'daily-journal-rule';
    existing.appendChild(rule);
  } else {
    pageView.classList.remove('daily-note-active');
    if(existing) existing.style.display = 'none';
  }
}

/* Wrap the existing renderer so the journal chrome stays synchronized
   with page navigation, boot, undo/redo, and other rerenders. */
var _nexusRenderPageBeforeDailyNotes = renderPage;
renderPage = function(){
  _nexusRenderPageBeforeDailyNotes.apply(this, arguments);
  ensureDailyJournalChrome();
};

/* Improve the top-level Today's note action without changing the original
   command's semantics: it now gets the same daily-page scaffold. */
document.addEventListener('DOMContentLoaded', function(){
  var todayBtn = document.getElementById('btn-today');
  if(todayBtn){
    todayBtn.title = 'Open or create today\'s Logseq-style daily journal';
  }
});
