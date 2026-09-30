import { escapeMarkup as esc, epochAgeHours, displayNumber } from './catalog.js';

const ROW_HEIGHT = 32;
const BUFFER = 8;

export function virtualWindow(scrollTop, height, total) {
  const count = Math.ceil(Math.max(0, height) / ROW_HEIGHT);
  const first = Math.min(Math.max(0, total - count), Math.floor(Math.max(0, scrollTop) / ROW_HEIGHT));
  return { start: Math.max(0, first - BUFFER), end: Math.min(total, first + count + BUFFER) };
}

export function rowMarkup(item, index, total, selectedId, favorites, now) {
  const id = String(item.NORAD_CAT_ID);
  const age = epochAgeHours(item, now);
  const orbit = ['LEO', 'MEO', 'GEO', 'HEO'].includes(item.ORBIT_REGIME) ? item.ORBIT_REGIME : '—';
  return `<div id="orbit-row-${esc(id)}" class="oc-satellite-row" role="option" aria-selected="${id === selectedId}" aria-posinset="${index + 1}" aria-setsize="${total}" data-satellite-id="${esc(id)}" style="top:${index * ROW_HEIGHT}px" title="${esc(item.OBJECT_NAME)} / NORAD ${esc(id)}">
    <span class="oc-star ${favorites.has(id) ? 'saved' : ''}" aria-hidden="true">${favorites.has(id) ? '★' : '·'}</span><b>${esc(item.OBJECT_NAME)}</b><span>${esc(id)}</span><span data-orbit="${orbit}">${orbit}</span><span class="${age != null && Math.abs(age) > 120 ? 'oc-old' : ''}" title="${age == null ? 'Epoch 미제공' : '현재 UTC에서 Epoch까지의 시간 (h)'}">${displayNumber(age, 0)}</span></div>`;
}

export function createCatalogList({ element, onSelect }) {
  let items = [], selectedId = null, favorites = new Set(), frame = 0;
  function paint() {
    frame = 0;
    if (!items.length) {
      element.innerHTML = '<div class="oc-empty">조건에 맞는 위성이 없습니다.<br>검색어 또는 필터를 확인하세요.</div>';
      element.removeAttribute('aria-activedescendant');
      return;
    }
    let space = element.firstElementChild;
    if (!space?.classList.contains('oc-list-space')) {
      element.innerHTML = '<div class="oc-list-space"></div>';
      space = element.firstElementChild;
    }
    space.style.height = `${items.length * ROW_HEIGHT}px`;
    const { start, end } = virtualWindow(element.scrollTop, element.clientHeight || 320, items.length);
    space.innerHTML = items.slice(start, end).map((item, i) => rowMarkup(item, i + start, items.length, selectedId, favorites, Date.now())).join('');
    if (items.slice(start, end).some(item => String(item.NORAD_CAT_ID) === selectedId)) element.setAttribute('aria-activedescendant', `orbit-row-${selectedId}`);
    else element.removeAttribute('aria-activedescendant');
  }
  function select(id, reveal = false) {
    selectedId = id == null ? null : String(id);
    const previousScroll = element.scrollTop;
    if (reveal) {
      const index = items.findIndex(item => String(item.NORAD_CAT_ID) === selectedId);
      if (index >= 0) {
        const top = index * ROW_HEIGHT;
        if (top < element.scrollTop) element.scrollTop = top;
        else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
      }
    }
    if (previousScroll !== element.scrollTop) paint();
    else {
      let present = false;
      element.querySelectorAll('[data-satellite-id]').forEach(row => {
        const selected = row.dataset.satelliteId === selectedId;
        row.setAttribute('aria-selected', String(selected));
        if (selected) present = true;
      });
      if (present) element.setAttribute('aria-activedescendant', `orbit-row-${selectedId}`);
      else element.removeAttribute('aria-activedescendant');
    }
  }
  element.addEventListener('scroll', () => { if (!frame) frame = requestAnimationFrame(paint); });
  element.addEventListener('click', event => {
    const row = event.target.closest('[data-satellite-id]');
    if (row) { element.focus({ preventScroll: true }); onSelect(row.dataset.satelliteId, false); }
  });
  element.addEventListener('dblclick', event => {
    const row = event.target.closest('[data-satellite-id]');
    if (row) onSelect(row.dataset.satelliteId, true);
  });
  element.addEventListener('keydown', event => {
    if (!items.length || !['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    let index = items.findIndex(item => String(item.NORAD_CAT_ID) === selectedId);
    if (event.key === 'Enter') { if (index >= 0) onSelect(selectedId, true); return; }
    const page = Math.max(1, Math.floor(element.clientHeight / ROW_HEIGHT));
    index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : index < 0 ? 0 : index + ({ ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page })[event.key];
    const id = String(items[Math.max(0, Math.min(items.length - 1, index))].NORAD_CAT_ID);
    onSelect(id, false); select(id, true);
  });
  new ResizeObserver(() => paint()).observe(element);
  return {
    setItems(next, saved = favorites) { items = next; favorites = saved; element.scrollTop = 0; paint(); },
    select,
    paint,
  };
}
