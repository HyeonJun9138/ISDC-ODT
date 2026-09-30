// Display policy for GP/SATCAT. Missing values are not physical zeroes.
export function finiteNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function displayNumber(value, digits = 1) {
  const number = finiteNumber(value);
  return number === null ? '—' : number.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function utcMillis(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  const time = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`);
  return Number.isFinite(time) ? time : null;
}

export function utcLabel(value, seconds = true) {
  const time = value instanceof Date ? value.getTime() : utcMillis(value);
  return time === null || !Number.isFinite(time) ? '—' : new Date(time).toISOString().slice(0, seconds ? 19 : 16).replace('T', ' ');
}

export function epochAgeHours(item, now = Date.now()) {
  const epoch = utcMillis(item.EPOCH);
  return epoch === null ? null : (Number(now) - epoch) / 3600000;
}

export function escapeMarkup(value) {
  return String(value ?? '—').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
}

export function selectCatalog(items, { query = '', orbit = 'all', favoritesOnly = false, favorites = new Set(), sort = 'name', direction = 'asc', now = Date.now() } = {}) {
  const needle = query.trim().toLowerCase();
  const filtered = items.filter(item =>
    (!needle || [item.OBJECT_NAME, item.OBJECT_ID, item.NORAD_CAT_ID].some(x => String(x ?? '').toLowerCase().includes(needle))) &&
    (orbit === 'all' || item.ORBIT_REGIME === orbit) &&
    (!favoritesOnly || favorites.has(String(item.NORAD_CAT_ID))));
  const value = item => sort === 'id' ? finiteNumber(item.NORAD_CAT_ID) : sort === 'age' ? epochAgeHours(item, now) : sort === 'orbit' ? item.ORBIT_REGIME ?? null : item.OBJECT_NAME ?? null;
  return filtered.sort((a, b) => {
    const x = value(a), y = value(b);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    const compared = typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'en', { numeric: true });
    return compared * (direction === 'desc' ? -1 : 1) || Number(a.NORAD_CAT_ID) - Number(b.NORAD_CAT_ID);
  });
}
