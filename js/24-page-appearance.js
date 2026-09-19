/* ============================================================
 * 24-page-appearance.js
 * Page icons + banners.
 *
 * Appearance is lightweight notebook metadata: an emoji icon and a
 * named banner preset live directly on each page, so they survive
 * backup/restore/sync without introducing another storage subsystem.
 * ============================================================ */
"use strict";

var NEXUS_PAGE_ICON_CHOICES = [
  '📄','📝','📚','📖','💡','⭐','❤️','✅','🎯','🚀','💼','📌',
  '📅','🏷️','🗃️','⌕','🧠','🔬','🎨','🎵','🎬','🏠','🌱','💰',
  '✈️','🛠️','🔐','📂','🗂️','👤','👋','🔥'
];
var NEXUS_PAGE_BANNER_LABELS = {
  none:'No banner', paper:'Paper', ocean:'Ocean', forest:'Forest',
  violet:'Violet', sunset:'Sunset', rose:'Rose', slate:'Slate', aurora:'Aurora'
};
var appearancePopoverCleanup = null;

function pageIconFor(page){
  if(page && typeof page.icon === 'string' && page.icon.trim()) return page.icon;
  return defaultPageIcon(page && page.type);
}
function pageBannerFor(page){
  return page && NEXUS_PAGE_BANNER_PRESETS.indexOf(page.banner) !== -1 ? page.banner : 'none';
}
function closePageAppearancePopover(){
  var existing = document.querySelector('.page-appearance-popover');
  if(existing) existing.remove();
  if(appearancePopoverCleanup){ appearancePopoverCleanup(); appearancePopoverCleanup = null; }
}
function createAppearancePopover(anchor, titleText){
  closePageAppearancePopover();
  var pop = document.createElement('div');
  pop.className = 'page-appearance-popover';
  var title = document.createElement('div');
  title.className = 'page-appearance-popover-title';
  title.textContent = titleText;
  pop.appendChild(title);

  function place(){
    var r = anchor.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.left)) + 'px';
    pop.style.top = Math.min(window.innerHeight - pop.offsetHeight - 8, r.bottom + 8) + 'px';
  }
  document.body.appendChild(pop);
  requestAnimationFrame(place);

  function outside(e){ if(!pop.contains(e.target) && e.target !== anchor) closePageAppearancePopover(); }
  function esc(e){ if(e.key === 'Escape') closePageAppearancePopover(); }
  document.addEventListener('mousedown', outside);
  document.addEventListener('keydown', esc);
  window.addEventListener('resize', place);
  appearancePopoverCleanup = function(){
    document.removeEventListener('mousedown', outside);
    document.removeEventListener('keydown', esc);
    window.removeEventListener('resize', place);
  };
  return pop;
}
function openPageIconPicker(){
  var page = state.pages[state.currentPageId];
  if(!page || page.locked || page.trashedAt) return;
  var anchor = document.getElementById('page-icon-btn');
  var pop = createAppearancePopover(anchor, 'Page icon');
  var grid = document.createElement('div');
  grid.className = 'page-icon-grid';
  NEXUS_PAGE_ICON_CHOICES.forEach(function(icon){
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'page-icon-choice' + (pageIconFor(page) === icon ? ' selected' : '');
    b.textContent = icon;
    b.title = icon;
    b.setAttribute('aria-label', 'Use page icon ' + icon);
    b.onclick = function(){
      page.icon = icon;
      save(); renderAll();
      closePageAppearancePopover();
    };
    grid.appendChild(b);
  });
  var clear = document.createElement('button');
  clear.type = 'button'; clear.className = 'page-appearance-clear';
  clear.textContent = 'Use default icon';
  clear.onclick = function(){
    page.icon = defaultPageIcon(page.type);
    save(); renderAll();
    closePageAppearancePopover();
  };
  pop.appendChild(grid); pop.appendChild(clear);
}
function openPageBannerPicker(){
  var page = state.pages[state.currentPageId];
  if(!page || page.locked || page.trashedAt) return;
  var anchor = document.getElementById('page-banner-btn');
  var pop = createAppearancePopover(anchor, 'Page banner');
  var list = document.createElement('div');
  list.className = 'page-banner-choice-list';
  Object.keys(NEXUS_PAGE_BANNER_LABELS).forEach(function(key){
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'page-banner-choice banner-choice-'+key + (pageBannerFor(page) === key ? ' selected' : '');
    b.textContent = NEXUS_PAGE_BANNER_LABELS[key];
    b.setAttribute('aria-label', 'Use ' + NEXUS_PAGE_BANNER_LABELS[key] + ' page banner');
    b.onclick = function(){
      page.banner = key;
      save(); renderAll();
      closePageAppearancePopover();
    };
    list.appendChild(b);
  });
  pop.appendChild(list);
}
function renderPageAppearance(page){
  if(!page) return;
  normalizePageAppearance(page);
  var pageView = document.getElementById('page-view');
  var banner = document.getElementById('page-banner');
  var iconBtn = document.getElementById('page-icon-btn');
  var bannerBtn = document.getElementById('page-banner-btn');
  if(!pageView || !banner || !iconBtn || !bannerBtn) return;

  var preset = pageBannerFor(page);
  banner.className = 'page-banner page-banner-' + preset;
  banner.setAttribute('aria-hidden', preset === 'none' ? 'true' : 'false');
  bannerBtn.textContent = preset === 'none' ? '🎨 Add banner' : '🎨 Change banner';
  bannerBtn.disabled = !!page.locked || !!page.trashedAt;
  bannerBtn.title = bannerBtn.disabled ? 'Page appearance is read-only' : 'Choose page banner';

  iconBtn.textContent = pageIconFor(page);
  iconBtn.disabled = !!page.locked || !!page.trashedAt;
  iconBtn.title = iconBtn.disabled ? 'Page appearance is read-only' : 'Choose page icon';
  iconBtn.setAttribute('aria-label', 'Page icon ' + pageIconFor(page) + '. Choose page icon');
  pageView.classList.toggle('has-page-banner', preset !== 'none');
  pageView.classList.toggle('has-page-icon', true);
}

var _nexusRenderPageBeforeAppearance = renderPage;
renderPage = function(){
  _nexusRenderPageBeforeAppearance.apply(this, arguments);
  var page = state && state.pages ? state.pages[state.currentPageId] : null;
  if(page) renderPageAppearance(page);
};

document.addEventListener('click', function(e){
  if(e.target && e.target.id === 'page-icon-btn'){
    e.preventDefault();
    openPageIconPicker();
  } else if(e.target && e.target.id === 'page-banner-btn'){
    e.preventDefault();
    openPageBannerPicker();
  }
});

document.addEventListener('keydown', function(e){
  if(e.key === 'Escape') closePageAppearancePopover();
});
