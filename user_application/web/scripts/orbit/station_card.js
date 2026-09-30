// Ground-station card for the orbit console: pure helpers that turn a site definition plus the live
// geometry the console already computes (look angles of the selected body, catalogue visibility,
// next pass) into the rows the card shows, and the observer selector markup. No DOM access here.

const escapeMarkup = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

export function coordinateLabel(latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return '—';
  return `${Math.abs(latitude).toFixed(4)}° ${latitude >= 0 ? 'N' : 'S'}, ${Math.abs(longitude).toFixed(4)}° ${longitude >= 0 ? 'E' : 'W'}`;
}

const number = (value, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : '—');
const utc = date => (date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString().slice(5, 16).replace('T', ' ') : '—');

// <optgroup> markup for the observer selector, one group per SITE_GROUPS entry that has sites.
export function stationOptionMarkup(groups, selectedKey) {
  return groups.map(group => `<optgroup label="${escapeMarkup(group.label)}">${group.sites.map(site =>
    `<option value="${escapeMarkup(site.key)}"${site.key === selectedKey ? ' selected' : ''}>${escapeMarkup(site.name)}</option>`).join('')}</optgroup>`).join('');
}

// Number of bodies whose current position clears the site's elevation mask. `positions` is any
// iterable of position objects; `elevationAt(position, site)` is the console's geometric elevation.
export function visibleSatelliteCount(positions, site, maskDegrees, elevationAt) {
  let count = 0;
  for (const position of positions) {
    const elevation = position ? elevationAt(position, site) : null;
    if (elevation != null && elevation >= maskDegrees) count++;
  }
  return count;
}

export function stationCardModel(site, {
  selectedName = null, look = null, maskDegrees = 5, visibleCount = null, catalogCount = null, nextPass = null, isObserver = false,
} = {}) {
  if (!site) return null;
  const visible = look != null && Number.isFinite(look.elevation) && look.elevation >= maskDegrees;
  const state = !selectedName ? 'none' : !look ? 'unknown' : visible ? 'visible' : 'hidden';
  const facts = [
    ['좌표', coordinateLabel(site.latitude, site.longitude)],
    ['고도', `${number(site.altitudeKm, 2)} km`],
    ['안테나', site.dishMeters ? `${site.dishMeters} m 급` : '—'],
    ['대역', site.bands?.length ? site.bands.join(' · ') : '—'],
    ['최소 고각', `${number(site.minElevationDeg, 0)}°`],
    ['역할', site.role || '—'],
  ];
  const live = [
    ['선택 위성', selectedName || '위성 미선택'],
    ['방위각 / 고각', look ? `${number(look.azimuth)}° / ${number(look.elevation)}°` : '—'],
    ['경사거리', look ? `${number(look.rangeKm, 1)} km` : '—'],
    ['가시 여부', { none: '—', unknown: '전파값 미제공', visible: `마스크 ${maskDegrees}° 이상`, hidden: `마스크 ${maskDegrees}° 미만` }[state]],
    ['마스크 이상 위성', Number.isFinite(visibleCount) ? `${visibleCount.toLocaleString()}${Number.isFinite(catalogCount) ? ` / ${catalogCount.toLocaleString()}` : ''}` : '—'],
    ['다음 관측창', nextPass?.aos ? `${utc(nextPass.aos)} UTC · 최대 ${number(nextPass.maxElevation)}°` : selectedName ? '24 h 내 없음' : '—'],
  ];
  return {
    key: site.key,
    title: site.name,
    subtitle: site.region || '',
    kicker: [site.operator, site.network].filter(Boolean).join(' · ') || '지상국',
    facts,
    live,
    state,
    isObserver,
    note: '공개 자료 기준 대표 위치와 장비 수치이며, 실시간 운용 상태를 받아오지 않습니다. 가시 여부와 관측창은 GP 기반 기하 계산입니다.',
  };
}
