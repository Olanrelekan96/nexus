/* ============================================================
 * 26-flashcards.js
 * Native Flashcards workspace with decks and lightweight spaced repetition.
 * Cards are ordinary JSON state so they travel through undo, backups and sync.
 * ============================================================ */
"use strict";

var DEFAULT_FLASHCARD_DECK_TITLE = 'General';
var flashcardsVisible = false;
var flashcardSidebarFilter = '';
var flashcardState = (typeof flashcardState !== 'undefined' && flashcardState) || {
  deckId:'all', status:'all', query:'', reviewId:null, revealed:false, selectedId:null
};

function ensureFlashcardState(){
  if(!state) return;
  if(!state.flashcards || typeof state.flashcards !== 'object') state.flashcards = {decks:{}, cards:{}};
  if(!state.flashcards.decks || typeof state.flashcards.decks !== 'object') state.flashcards.decks = {};
  if(!state.flashcards.cards || typeof state.flashcards.cards !== 'object') state.flashcards.cards = {};
  var liveDecks = Object.keys(state.flashcards.decks).filter(function(id){ return !state.flashcards.decks[id].deletedAt; });
  if(!liveDecks.length){
    var id=uid(); state.flashcards.decks[id]={id:id,name:DEFAULT_FLASHCARD_DECK_TITLE,createdAt:Date.now()};
  }
  var currentLive = Object.keys(state.flashcards.decks).some(function(id){ return state.flashcards.decks[id] && !state.flashcards.decks[id].deletedAt && id===flashcardState.deckId; });
  if(flashcardState.deckId!=='all' && !currentLive) flashcardState.deckId='all';
}

function flashcardDecks(){
  ensureFlashcardState();
  return Object.keys(state.flashcards.decks).map(function(id){ return state.flashcards.decks[id]; })
    .filter(function(d){ return d && !d.deletedAt; })
    .sort(function(a,b){ return (a.name||'').localeCompare(b.name||''); });
}
function flashcardCards(){
  ensureFlashcardState();
  return Object.keys(state.flashcards.cards).map(function(id){ return state.flashcards.cards[id]; })
    .filter(function(c){ return c && !c.deletedAt; });
}
function flashcardDeckName(deckId){
  var d=state.flashcards.decks[deckId]; return d && !d.deletedAt ? d.name : 'Unassigned';
}
function flashcardIsDue(card){ return !card.suspended && !card.deletedAt && (!card.dueAt || card.dueAt <= Date.now()); }
function flashcardStatus(card){
  if(card.suspended) return 'suspended';
  if(!card.reps) return 'new';
  return card.state || 'review';
}
function flashcardSearchText(card){
  return [card.front,card.back,(card.tags||[]).join(' '),flashcardDeckName(card.deckId),
    card.sourcePageId && state.pages[card.sourcePageId] ? state.pages[card.sourcePageId].title : ''].join(' ').toLowerCase();
}
function visibleFlashcards(){
  var q=(flashcardState.query||'').trim().toLowerCase();
  return flashcardCards().filter(function(c){
    if(flashcardState.deckId!=='all' && c.deckId!==flashcardState.deckId) return false;
    var st=flashcardStatus(c);
    if(flashcardState.status==='due' && !flashcardIsDue(c)) return false;
    if(flashcardState.status==='new' && st!=='new') return false;
    if(flashcardState.status==='learning' && st!=='learning') return false;
    if(flashcardState.status==='review' && st!=='review') return false;
    if(q && flashcardSearchText(c).indexOf(q)===-1) return false;
    return true;
  }).sort(function(a,b){
    var ad=flashcardIsDue(a)?0:1, bd=flashcardIsDue(b)?0:1;
    return ad-bd || (a.dueAt||Infinity)-(b.dueAt||Infinity) || (a.createdAt||0)-(b.createdAt||0);
  });
}
function scheduleFlashcard(card, rating){
  var now=Date.now();
  var ease=typeof card.ease==='number' ? card.ease : 2.5;
  var interval=typeof card.interval==='number' ? card.interval : 0;
  var result={interval:interval,ease:ease,reps:card.reps||0,lapses:card.lapses||0,state:card.state||'new'};
  if(rating==='again'){
    result.interval=0; result.ease=Math.max(1.3,ease-0.2); result.lapses++; result.state='learning';
    card.dueAt=now+10*60*1000;
  }else if(rating==='hard'){
    result.interval=Math.max(1,interval?Math.round(interval*1.2):1);
    result.ease=Math.max(1.3,ease-0.15); result.reps++; result.state=result.interval<=1?'learning':'review';
    card.dueAt=now+result.interval*86400000;
  }else if(rating==='good'){
    result.interval=interval?Math.max(1,Math.round(interval*ease)):1;
    result.reps++; result.state=result.interval<=1?'learning':'review';
    card.dueAt=now+result.interval*86400000;
  }else{
    result.interval=interval?Math.max(2,Math.round(interval*ease*1.35)):4;
    result.ease=Math.min(3.2,ease+0.15); result.reps++; result.state='review';
    card.dueAt=now+result.interval*86400000;
  }
  card.interval=result.interval; card.ease=result.ease; card.reps=result.reps; card.lapses=result.lapses; card.state=result.state; card.lastReviewedAt=now;
}

function makeFlashcard(front,back,deckId,sourcePageId,sourceBlockId){
  ensureFlashcardState();
  var deck=flashcardDecks().find(function(d){ return d.id===deckId; }) || flashcardDecks()[0];
  var id=uid();
  state.flashcards.cards[id]={id:id,deckId:deck.id,front:String(front||'').trim(),back:String(back||'').trim(),tags:[],
    sourcePageId:sourcePageId||null,sourceBlockId:sourceBlockId||null,createdAt:Date.now(),dueAt:0,interval:0,ease:2.5,reps:0,lapses:0,state:'new',suspended:false};
  return state.flashcards.cards[id];
}
function saveFlashcards(){ save(); renderFlashcardsView(); renderFlashcardSidebar(); if(typeof renderDashboard==='function') renderDashboard(); }

function showFlashcardsView(){
  if(typeof hideCommandCenterView === 'function') hideCommandCenterView();
  if(typeof hideStickyNotesView === 'function') hideStickyNotesView();
  var page=document.getElementById('page-view'), graph=document.getElementById('graph-view'), tasks=document.getElementById('tasks-view'), dash=document.getElementById('dashboard-view'), view=document.getElementById('flashcards-view');
  if(!view) return;
  if(page) page.classList.remove('visible'); if(graph) graph.classList.remove('visible'); if(tasks) tasks.classList.remove('visible'); if(dash) dash.classList.remove('visible');
  view.classList.add('visible'); flashcardsVisible=true;
  var btn=document.getElementById('btn-flashcards'); if(btn) btn.classList.add('active');
  renderFlashcardsView(); renderFlashcardSidebar();
  if(typeof closeSidebarIfNarrow==='function') closeSidebarIfNarrow();
}
function hideFlashcardsView(){
  var view=document.getElementById('flashcards-view'); if(view) view.classList.remove('visible');
  flashcardsVisible=false; var btn=document.getElementById('btn-flashcards'); if(btn) btn.classList.remove('active');
}
function renderFlashcardStats(){
  var el=document.getElementById('flashcards-stats'); if(!el) return; el.innerHTML='';
  var all=flashcardCards(), due=all.filter(flashcardIsDue).length, neu=all.filter(function(c){return flashcardStatus(c)==='new';}).length,
      learn=all.filter(function(c){return flashcardStatus(c)==='learning';}).length, review=all.filter(function(c){return flashcardStatus(c)==='review';}).length;
  [[''+due,'Due now','●','focus'],[''+neu,'New','＋',''],[''+learn,'Learning','◔',''],[''+review,'In review','✓',''],[''+all.length,'Total','▤','']].forEach(function(x){
    var b=document.createElement('div'); b.className='flashcard-stat '+x[3]; b.innerHTML='<span class="flashcard-stat-icon">'+x[2]+'</span><strong>'+x[0]+'</strong><span>'+x[1]+'</span>'; el.appendChild(b);
  });
}
function renderFlashcardControls(){
  var deckEl=document.getElementById('flashcards-deck'); if(deckEl){ deckEl.innerHTML='<option value="all">All decks</option>'; flashcardDecks().forEach(function(d){ var o=document.createElement('option');o.value=d.id;o.textContent=d.name;deckEl.appendChild(o); }); deckEl.value=flashcardState.deckId; }
  var status=document.getElementById('flashcards-status'); if(status) status.value=flashcardState.status;
  var search=document.getElementById('flashcards-search'); if(search) search.value=flashcardState.query;
}
function renderFlashcardList(){
  var el=document.getElementById('flashcards-list'); if(!el) return; el.innerHTML='';
  var cards=visibleFlashcards();
  if(!cards.length){ var empty=document.createElement('div'); empty.className='flashcards-empty'; empty.textContent=flashcardCards().length?'No cards match these filters.':'No flashcards yet — create your first card.'; el.appendChild(empty); return; }
  cards.forEach(function(card){
    var row=document.createElement('button'); row.type='button'; row.className='flashcard-list-row'+(card.id===flashcardState.selectedId?' selected':'');
    var stateEl=document.createElement('span'); stateEl.className='flashcard-row-state '+flashcardStatus(card); stateEl.textContent=flashcardStatus(card); row.appendChild(stateEl);
    var copy=document.createElement('span'); copy.className='flashcard-row-copy'; var f=document.createElement('strong'); f.textContent=card.front||'(empty front)'; copy.appendChild(f);
    var meta=document.createElement('span'); meta.textContent=flashcardDeckName(card.deckId)+' · '+(flashcardIsDue(card)?'Due now':card.dueAt?'Due '+new Date(card.dueAt).toLocaleDateString():'New'); copy.appendChild(meta); row.appendChild(copy);
    row.onclick=function(){ flashcardState.selectedId=card.id; editFlashcard(card.id); renderFlashcardList(); };
    el.appendChild(row);
  });
}
function renderFlashcardEditor(card){
  var el=document.getElementById('flashcards-editor'); if(!el) return; el.style.display=card?'block':'none'; el.innerHTML=''; if(!card) return;
  var head=document.createElement('div'); head.className='flashcard-editor-head'; var title=document.createElement('strong'); title.textContent='Edit card'; head.appendChild(title); var close=document.createElement('button'); close.type='button';close.textContent='Done';close.onclick=function(){el.style.display='none';flashcardState.selectedId=null;renderFlashcardList();};head.appendChild(close);el.appendChild(head);
  function field(label,value,multiline){ var wrap=document.createElement('label');wrap.className='flashcard-field';var l=document.createElement('span');l.textContent=label;wrap.appendChild(l);var input=document.createElement(multiline?'textarea':'input');input.value=value||'';input.rows=4;wrap.appendChild(input);wrap._input=input;el.appendChild(wrap);return wrap; }
  var front=field('Front',card.front,false), back=field('Back',card.back,true);
  var deckWrap=document.createElement('label');deckWrap.className='flashcard-field';var dl=document.createElement('span');dl.textContent='Deck';deckWrap.appendChild(dl);var ds=document.createElement('select');flashcardDecks().forEach(function(d){var o=document.createElement('option');o.value=d.id;o.textContent=d.name;ds.appendChild(o);});ds.value=card.deckId;deckWrap.appendChild(ds);el.appendChild(deckWrap);
  var tags=field('Tags (comma separated)',(card.tags||[]).join(', '),false);
  var actions=document.createElement('div');actions.className='flashcard-editor-actions';var saveBtn=document.createElement('button');saveBtn.className='primary';saveBtn.type='button';saveBtn.textContent='Save card';saveBtn.onclick=function(){card.front=front._input.value.trim();card.back=back._input.value.trim();card.deckId=ds.value;card.tags=tags._input.value.split(',').map(function(x){return x.trim().toLowerCase();}).filter(Boolean);saveFlashcards();toast('Flashcard saved.');};actions.appendChild(saveBtn);
  var suspend=document.createElement('button');suspend.type='button';suspend.textContent=card.suspended?'Resume review':'Suspend';suspend.onclick=function(){card.suspended=!card.suspended;saveFlashcards();};actions.appendChild(suspend);
  var reset=document.createElement('button');reset.type='button';reset.textContent='Reset schedule';reset.onclick=function(){card.dueAt=0;card.interval=0;card.ease=2.5;card.reps=0;card.lapses=0;card.state='new';saveFlashcards();};actions.appendChild(reset);
  var del=document.createElement('button');del.type='button';del.className='danger';del.textContent='Delete';del.onclick=function(){if(confirm('Delete this flashcard? It will be removed from active decks but retained in sync history.')){card.deletedAt=Date.now();flashcardState.selectedId=null;saveFlashcards();}};actions.appendChild(del);el.appendChild(actions);
}
function editFlashcard(id){ renderFlashcardEditor(state.flashcards.cards[id]); }
function openFlashcardCreator(){
  var el=document.getElementById('flashcards-editor'); if(!el) return; el.style.display='block';el.innerHTML='';
  var head=document.createElement('div');head.className='flashcard-editor-head';var title=document.createElement('strong');title.textContent='New flashcard';head.appendChild(title);var close=document.createElement('button');close.type='button';close.textContent='Cancel';close.onclick=function(){el.style.display='none';};head.appendChild(close);el.appendChild(head);
  function field(label,placeholder,multiline){var wrap=document.createElement('label');wrap.className='flashcard-field';var l=document.createElement('span');l.textContent=label;wrap.appendChild(l);var input=document.createElement(multiline?'textarea':'input');input.placeholder=placeholder;if(multiline)input.rows=5;wrap.appendChild(input);wrap._input=input;el.appendChild(wrap);return wrap;}
  var front=field('Front','Question or prompt…',false),back=field('Back','Answer, explanation, example…',true);
  var deckWrap=document.createElement('label');deckWrap.className='flashcard-field';var dl=document.createElement('span');dl.textContent='Deck';deckWrap.appendChild(dl);var ds=document.createElement('select');flashcardDecks().forEach(function(d){var o=document.createElement('option');o.value=d.id;o.textContent=d.name;ds.appendChild(o);});deckWrap.appendChild(ds);el.appendChild(deckWrap);
  var actions=document.createElement('div');actions.className='flashcard-editor-actions';var add=document.createElement('button');add.type='button';add.className='primary';add.textContent='Create card';add.onclick=function(){if(!front._input.value.trim()||!back._input.value.trim()){toast('Add both a front and back first.');return;}var pageId=state.currentPageId, c=makeFlashcard(front._input.value,back._input.value,ds.value,pageId,null);flashcardState.selectedId=c.id;saveFlashcards();editFlashcard(c.id);toast('Flashcard created.');};actions.appendChild(add);el.appendChild(actions);
}
function openFlashcardReview(){
  var due=visibleFlashcards().filter(flashcardIsDue);
  if(!due.length){toast('No cards are due with the current filters.');return;}
  flashcardState.reviewId=due[0].id;flashcardState.revealed=false;renderFlashcardReview();
}
function renderFlashcardReview(){
  var el=document.getElementById('flashcards-review');if(!el)return;
  var card=flashcardState.reviewId?state.flashcards.cards[flashcardState.reviewId]:null;
  if(!card || card.deletedAt || card.suspended || !flashcardIsDue(card)){el.style.display='none';return;}
  el.style.display='block';el.innerHTML='';
  var top=document.createElement('div');top.className='flashcard-review-top';var deck=document.createElement('span');deck.textContent=flashcardDeckName(card.deckId);top.appendChild(deck);var close=document.createElement('button');close.type='button';close.textContent='Exit review';close.onclick=function(){flashcardState.reviewId=null;flashcardState.revealed=false;renderFlashcardsView();};top.appendChild(close);el.appendChild(top);
  var cardBox=document.createElement('div');cardBox.className='flashcard-review-card '+(flashcardState.revealed?'revealed':'');var kind=document.createElement('div');kind.className='flashcard-review-kind';kind.textContent=flashcardState.revealed?'Answer':'Question';cardBox.appendChild(kind);var body=document.createElement('div');body.className='flashcard-review-body';body.textContent=flashcardState.revealed?card.back:card.front;cardBox.appendChild(body);el.appendChild(cardBox);
  if(!flashcardState.revealed){var reveal=document.createElement('button');reveal.type='button';reveal.className='primary flashcard-reveal';reveal.textContent='Reveal answer';reveal.onclick=function(){flashcardState.revealed=true;renderFlashcardReview();};el.appendChild(reveal);}
  else{
    var rates=document.createElement('div');rates.className='flashcard-ratings';[['again','Again','10 min'],['hard','Hard','~1 day'],['good','Good',card.interval?('~'+Math.max(1,Math.round(card.interval*(card.ease||2.5)))+' days'):'~1 day'],['easy','Easy',card.interval?('~'+Math.max(2,Math.round(card.interval*(card.ease||2.5)*1.35))+' days'):'~4 days']].forEach(function(x){var b=document.createElement('button');b.type='button';b.className='flashcard-rate '+x[0];var st=document.createElement('strong');st.textContent=x[1];var sm=document.createElement('span');sm.textContent=x[2];b.appendChild(st);b.appendChild(sm);b.onclick=function(){scheduleFlashcard(card,x[0]);saveFlashcards();var next=visibleFlashcards().filter(flashcardIsDue);if(next.length){flashcardState.reviewId=next[0].id;flashcardState.revealed=false;renderFlashcardReview();}else{flashcardState.reviewId=null;flashcardState.revealed=false;renderFlashcardsView();toast('Review complete.');}};rates.appendChild(b);});el.appendChild(rates);
  }
}
function renderFlashcardsView(){
  ensureFlashcardState();
  renderFlashcardStats(); renderFlashcardControls(); renderFlashcardEditor(flashcardState.selectedId?state.flashcards.cards[flashcardState.selectedId]:null); renderFlashcardList();
  if(flashcardState.reviewId) renderFlashcardReview(); else {var r=document.getElementById('flashcards-review');if(r)r.style.display='none';}
}
function createFlashcardDeck(){
  ensureFlashcardState();var name=prompt('New deck name:','Study');if(!name)return;name=name.trim();if(!name)return;
  if(flashcardDecks().some(function(d){return d.name.toLowerCase()===name.toLowerCase();})){toast('A deck with that name already exists.');return;}
  var id=uid();state.flashcards.decks[id]={id:id,name:name,createdAt:Date.now()};flashcardState.deckId=id;saveFlashcards();toast('Deck created.');
}
function renderFlashcardSidebar(){
  var ul=document.getElementById('list-flashcards');if(!ul)return;ensureFlashcardState();var needle=(flashcardSidebarFilter||'').trim().toLowerCase();var cards=flashcardCards().filter(function(c){return !needle || flashcardSearchText(c).indexOf(needle)!==-1;});
  ul.innerHTML='';cards.sort(function(a,b){return flashcardDeckName(a.deckId).localeCompare(flashcardDeckName(b.deckId))||a.front.localeCompare(b.front);}).slice(0,30).forEach(function(card){var li=document.createElement('li');var row=document.createElement('div');row.className='flashcard-sidebar-row';var a=document.createElement('a');a.href='javascript:void(0)';a.textContent=card.front||'(empty front)';a.title=flashcardDeckName(card.deckId)+' · '+flashcardStatus(card);a.onclick=function(){showFlashcardsView();flashcardState.selectedId=card.id;editFlashcard(card.id);};row.appendChild(a);var meta=document.createElement('span');meta.className='flashcard-sidebar-meta';meta.textContent=flashcardDeckName(card.deckId);row.appendChild(meta);li.appendChild(row);ul.appendChild(li);});
  if(!cards.length){var e=document.createElement('li');e.className='flashcard-sidebar-empty';e.textContent=needle?'No flashcards match this filter.':'No flashcards created yet.';ul.appendChild(e);}var c=document.getElementById('flashcard-count');if(c)c.textContent=cards.length?String(cards.length):'';
}

function wireFlashcards(){
  ensureFlashcardState();
  var btn=document.getElementById('btn-flashcards'); if(btn) btn.onclick=showFlashcardsView;
  var close=document.getElementById('btn-close-flashcards');if(close)close.onclick=function(){hideFlashcardsView();document.getElementById('page-view').classList.add('visible');};
  var filter=document.getElementById('flashcard-filter');if(filter)filter.addEventListener('input',function(e){flashcardSidebarFilter=e.target.value||'';renderFlashcardSidebar();});
  var add=document.getElementById('flashcards-add-btn');if(add)add.onclick=openFlashcardCreator;
  var nd=document.getElementById('flashcards-new-deck-btn');if(nd)nd.onclick=createFlashcardDeck;
  var deck=document.getElementById('flashcards-deck');if(deck)deck.addEventListener('change',function(e){flashcardState.deckId=e.target.value;renderFlashcardsView();});
  var status=document.getElementById('flashcards-status');if(status)status.addEventListener('change',function(e){flashcardState.status=e.target.value;renderFlashcardsView();});
  var search=document.getElementById('flashcards-search');if(search)search.addEventListener('input',function(e){flashcardState.query=e.target.value;renderFlashcardsView();});
  var review=document.getElementById('flashcards-start-review');if(review)review.onclick=openFlashcardReview;
  document.addEventListener('keydown',function(e){if(!flashcardsVisible)return;if((e.key===' '||e.key==='Spacebar') && flashcardState.reviewId && !flashcardState.revealed){e.preventDefault();flashcardState.revealed=true;renderFlashcardReview();}if(flashcardState.reviewId&&flashcardState.revealed&&['1','2','3','4'].indexOf(e.key)!==-1){var r={1:'again',2:'hard',3:'good',4:'easy'}[e.key],c=state.flashcards.cards[flashcardState.reviewId];if(c){scheduleFlashcard(c,r);saveFlashcards();var next=visibleFlashcards().filter(flashcardIsDue);flashcardState.reviewId=next.length?next[0].id:null;flashcardState.revealed=false;renderFlashcardsView();}}});
}

if(typeof document !== 'undefined' && document.addEventListener) document.addEventListener('DOMContentLoaded',wireFlashcards);
