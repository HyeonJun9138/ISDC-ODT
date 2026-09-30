// Deterministic orbital-plane topology: satellite rings above a ground-station tier.
// This is connectivity, not geographic position; all state and click handling come from the caller.
// Ground contacts are drawn as small tags beside the satellite they belong to (station name and
// quality) instead of long lines to the ground tier, so nothing crosses the rings; a line is drawn
// only for the contact that carries the computed route or is selected.
export const DIAGRAM_SIZE = Object.freeze({ width: 1200, height: 680 });
export const DIAGRAM_COLORS = Object.freeze({
  usable: '#3ddc84', degraded: '#ffc357', unusable: '#8ea4b8', fault: '#ff6b6b', ground: '#4ac4ee', terrestrial: '#7c8ea0', route: '#a78bfa', selected: '#ffffff',
});
const TAG_HEIGHT = 16;
const TAG_GAP = 12;

function escape(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

// Formation indices keep node positions stable as anomalies advance. Loose nodes group by RAAN.
// Rings fill the grid in serpentine order so planes with neighbouring RAAN sit next to each other
// and the cross-plane links between them stay short.
export function layoutNetwork({ satellites = [], stations = [], width = DIAGRAM_SIZE.width, height = DIAGRAM_SIZE.height } = {}) {
  const groups = new Map();
  for (const satellite of satellites) {
    const key = satellite.formation ? `${satellite.formation.id}:${satellite.formation.plane}` : `raan:${Math.round(Number(satellite.raan) || 0)}`;
    if (!groups.has(key)) groups.set(key, { key, raan: Number(satellite.raan) || 0, members: [] });
    groups.get(key).members.push(satellite);
  }
  const planes = [...groups.values()].sort((a,b) => a.raan-b.raan || a.key.localeCompare(b.key));
  const radiusFor = count => Math.max(140, count > 2 ? 48 / Math.sin(Math.PI / count) : 140);
  const maxRadius = Math.max(140, ...planes.map(p => radiusFor(p.members.length)));
  const columns = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(planes.length))));
  const cellHeight = maxRadius * 2 + 130;
  width = Math.max(width, columns * (maxRadius * 2 + 144) + 48);
  const cellWidth = (width - 48) / columns;
  const gridRows = Math.ceil(planes.length / columns);
  const positions = new Map();
  const rings = planes.map((plane, index) => {
    const gridRow = Math.floor(index / columns);
    const rowCount = Math.min(columns, planes.length-gridRow*columns);
    const slot = gridRow % 2 ? rowCount - 1 - index % columns : index % columns;
    const cx = 24 + (columns-rowCount)*cellWidth/2 + (slot+.5)*cellWidth;
    const cy = 72 + gridRow*cellHeight + cellHeight/2 - 10;
    const radius = radiusFor(plane.members.length);
    const members = [...plane.members].sort((a,b) => (a.formation && b.formation
      ? (Number(a.formation.index)||0)-(Number(b.formation.index)||0)
      : (Number(a.meanAnomaly)||0)-(Number(b.meanAnomaly)||0)) || String(a.id).localeCompare(String(b.id)));
    members.forEach((satellite, column) => {
      const angle = -Math.PI/2 + column*2*Math.PI/members.length;
      positions.set(String(satellite.id), { x:cx+radius*Math.cos(angle), y:cy+radius*Math.sin(angle),
        w:84, h:32, row:index, column, angle, kind:'satellite', label:satellite.name || satellite.id });
    });
    return {key:plane.key, raan:plane.raan, index, cx, cy, radius, count:members.length};
  });
  const groundTop = Math.max(72+gridRows*cellHeight+12, height-(stations.length ? 126 : 24));
  const stationColumns = Math.max(1, Math.min(6, Math.floor((width-48)/196)));
  const sorted = [...stations].sort((a,b)=>(Number(a.longitude)||0)-(Number(b.longitude)||0) || String(a.id).localeCompare(String(b.id)));
  sorted.forEach((station,index) => {
    const row = Math.floor(index/stationColumns);
    const rowCount = Math.min(stationColumns, sorted.length-row*stationColumns);
    positions.set(String(station.id), {x:width/2+(index%stationColumns-(rowCount-1)/2)*196,
      y:groundTop+70+row*76, w:172, h:58, row:-1, column:index, kind:'ground', label:station.name || station.id});
  });
  height = Math.max(height, groundTop+(stations.length ? 110+76*(Math.ceil(stations.length/stationColumns)-1) : 24));
  return {width,height,positions,rings,groundTop};
}

export function linkTone(link) {
  if (!link) return 'unusable';
  if (link.reason === 'fault' || link.faulted) return 'fault';
  if (link.kind === 'terrestrial') return link.usable ? 'terrestrial' : 'unusable';
  if (!link.usable) return 'unusable';
  if (link.kind === 'ground') return 'ground';
  return link.quality >= 75 ? 'usable' : 'degraded';
}

// Point on a card's edge in the direction of an angle from its centre.
function cardEdge(card, angle) {
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const t = Math.min(Math.abs(dx) > 1e-9 ? card.w / 2 / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-9 ? card.h / 2 / Math.abs(dy) : Infinity);
  return { x: card.x + dx * t, y: card.y + dy * t };
}

const round1 = value => Math.round(value * 10) / 10;

function linkGeometry(p, q, kind, layout) {
  const mid = {x:(p.x+q.x)/2,y:(p.y+q.y)/2};
  if (kind === 'oisl' && p.row === q.row) {
    const ring = layout.rings[p.row];
    const gap = Math.abs(p.column-q.column);
    if (ring.count > 1 && (gap === 1 || gap === ring.count-1)) {
      const delta = ((q.angle-p.angle+3*Math.PI)%(2*Math.PI))-Math.PI;
      const angle = p.angle+delta/2;
      return {path:`M ${p.x} ${p.y} A ${ring.radius} ${ring.radius} 0 0 ${delta > 0 ? 1 : 0} ${q.x} ${q.y}`,
        // Place the quality pill just outside the arc, clear of its endpoint cards.
        mid:{x:ring.cx+(ring.radius+34)*Math.cos(angle),y:ring.cy+(ring.radius+34)*Math.sin(angle)}};
    }
  }
  if (kind === 'ground') {
    // Only the routed or selected contact is drawn as a line: it leaves the satellite card outward
    // from its ring and lands on the top of the station card.
    const station = p.kind === 'ground' ? p : q;
    const satellite = p.kind === 'ground' ? q : p;
    const start = satellite.angle == null ? satellite : cardEdge(satellite, satellite.angle);
    const c1 = satellite.angle == null ? { x: satellite.x, y: satellite.y + 80 } : { x: start.x + 90 * Math.cos(satellite.angle), y: start.y + 90 * Math.sin(satellite.angle) };
    const end = { x: station.x, y: station.y - station.h / 2 };
    const c2 = { x: end.x, y: end.y - 90 };
    return {path:`M ${round1(start.x)} ${round1(start.y)} C ${round1(c1.x)} ${round1(c1.y)} ${round1(c2.x)} ${round1(c2.y)} ${round1(end.x)} ${round1(end.y)}`,
      mid:{x:(start.x+3*c1.x+3*c2.x+end.x)/8,y:(start.y+3*c1.y+3*c2.y+end.y)/8}};
  }
  if (kind === 'terrestrial') {
    const y = Math.max(p.y,q.y)+38;
    return {path:`M ${p.x} ${p.y} Q ${mid.x} ${y} ${q.x} ${q.y}`,mid:{x:mid.x,y:(p.y+2*y+q.y)/4}};
  }
  return {path:`M ${p.x} ${p.y} L ${q.x} ${q.y}`,mid};
}

// Reserve two narrow-character units for the ellipsis; Korean glyphs need more room.
const units = character => /[^\x00-\x7f]/.test(character) ? 2 : /[MWmw]/.test(character) ? 1.5 : /[ .,:%°|·]/.test(character) ? .6 : 1;
const textUnits = text => [...String(text)].reduce((sum, character) => sum + units(character), 0);
const shortLabel = (label, limit) => {
  const chars = [...String(label)];
  if (textUnits(label) <= limit) return label;
  let result = '', used = 0;
  for (const character of chars) {
    if (used + units(character) > limit - 2) break;
    result += character;
    used += units(character);
  }
  return result + '…';
};

// Tag text for a ground contact: station and quality, or the reason it is not usable.
function tagText(link, station) {
  const name = shortLabel(station.label, 8);
  if (link.reason === 'fault' || link.faulted) return `${name} 장애`;
  if (link.usable) return `${name} ${Number.isFinite(Number(link.quality)) ? `${link.quality}%` : ''}`.trim();
  return `${name} 가시`;
}

// Tags stack outward from the satellite card along its ring angle; sideways cards stack side by
// side so the tags never cover one another.
function tagPlacement(satellite, index, tagWidth, widest) {
  const angle = satellite.angle ?? Math.PI / 2;
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const edge = cardEdge(satellite, angle);
  const sideways = Math.abs(dx) >= .5;
  const step = sideways ? widest + 6 : TAG_HEIGHT + 4;
  const anchor = { x: edge.x + dx * (TAG_GAP + index * step), y: edge.y + dy * (TAG_GAP + index * step) };
  if (dx > .35) return { x: anchor.x, y: anchor.y - TAG_HEIGHT / 2, textX: anchor.x + 14, anchorMode: 'start', dotX: anchor.x + 7 };
  if (dx < -.35) return { x: anchor.x - tagWidth, y: anchor.y - TAG_HEIGHT / 2, textX: anchor.x - 6, anchorMode: 'end', dotX: anchor.x - tagWidth + 7 };
  const y = dy < 0 ? anchor.y - TAG_HEIGHT : anchor.y;
  return { x: anchor.x - tagWidth / 2, y, textX: anchor.x - tagWidth / 2 + 14, anchorMode: 'start', dotX: anchor.x - tagWidth / 2 + 7 };
}

// links: fabric link reports merged with the twin's link records (kind, a, b, usable, quality,
// reason, faulted). options: { selected: { type, id }, routeLinkIds: Set, hideUnusable, showLabels }.
export function diagramMarkup(layout, links = [], options = {}) {
  const { positions, width, height } = layout;
  const selected = options.selected || null;
  const routeIds = options.routeLinkIds instanceof Set ? options.routeLinkIds : new Set();
  const nodeStates = options.nodeStates || new Map();
  const planeMarkup = layout.rings.map(ring => `<g class="nd-plane"><circle cx="${ring.cx}" cy="${ring.cy}" r="${ring.radius}"/><circle class="inner" cx="${ring.cx}" cy="${ring.cy}" r="${ring.radius-24}"/></g>`).join('');
  const planeLabels = layout.rings.map(ring => `<g class="nd-plane-label" transform="translate(${ring.cx},${ring.cy})"><rect x="-66" y="-37" width="132" height="74" rx="8"/><text class="kicker" y="-15" text-anchor="middle">ORBITAL PLANE</text><text class="name" y="5" text-anchor="middle">궤도면 ${String(ring.index+1).padStart(2,'0')}</text><text class="meta" y="25" text-anchor="middle">${ring.count}기 / Ω ${Math.round(ring.raan)}°</text></g>`).join('');
  const groundCount = [...positions.values()].filter(p=>p.kind === 'ground').length;
  const groundMarkup = groundCount ? `<g class="nd-ground-tier"><rect x="24" y="${layout.groundTop+24}" width="${width-48}" height="${height-layout.groundTop-30}" rx="10"/><text x="38" y="${layout.groundTop+12}">GROUND SEGMENT</text><text x="${width-38}" y="${layout.groundTop+12}" text-anchor="end">지상국 ${groundCount}</text></g>` : '';
  const header = `<g class="nd-heading"><text x="32" y="29" class="name">위성 네트워크</text><text x="32" y="48" class="meta">궤도면 기반 연결 구조 / 지리적 위치 아님</text><text x="${width-32}" y="29" class="meta" text-anchor="end">${layout.rings.length}개 궤도면 / ${positions.size-groundCount}기</text></g>`;
  // Negative wall-clock delay preserves phase when the snapshot rebuilds the SVG every second.
  const elapsed = Number.isFinite(options.flowTimeSeconds) ? Math.max(0, options.flowTimeSeconds) : 0;
  const stateOf = link => {
    const routed = routeIds.has(link.id);
    const isSelected = selected?.type === 'link' && selected.id === link.id;
    const touchesSelected = selected?.type !== 'link' && selected && (String(link.a) === String(selected.id) || String(link.b) === String(selected.id));
    // With a selection in place the links that do not touch it fade, so the chosen node's or link's
    // own connections read first. Nothing is removed; the faded links stay clickable.
    return { routed, isSelected, touchesSelected, dimmed: selected && !routed && !isSelected && !touchesSelected };
  };
  const titleOf = (link, p, q) => `${p.label} ↔ ${q.label} · ${link.kind} · ${link.usable ? `품질 ${link.quality}%` : link.reason === 'fault' || link.faulted ? '장애' : '사용 불가'}${link.delay_ms != null ? ` · ${Number(link.delay_ms).toFixed(1)} ms` : ''}`;
  const isGroundContact = link => {
    const p = positions.get(String(link.a)); const q = positions.get(String(link.b));
    return link.kind === 'ground' && !!p && !!q && (p.kind === 'ground') !== (q.kind === 'ground');
  };
  const drawable = link => {
    const p = positions.get(String(link.a)); const q = positions.get(String(link.b));
    if (!p || !q) return false;
    if (!options.hideUnusable || link.usable || link.kind === 'oisl') return true;
    return isGroundContact(link) && (link.reason === 'fault' || link.faulted === true);
  };
  const ordered = [...links].filter(drawable).sort((p, q) => Number(routeIds.has(p.id)) - Number(routeIds.has(q.id)));
  // Ground contacts become tags beside their satellite, stacked outward per satellite.
  const perSatellite = new Map();
  for (const link of ordered.filter(isGroundContact)) {
    const p = positions.get(String(link.a)); const q = positions.get(String(link.b));
    const satellite = p.kind === 'ground' ? q : p; const station = p.kind === 'ground' ? p : q;
    const text = tagText(link, station);
    const list = perSatellite.get(satellite) || [];
    list.push({ link, satellite, station, text, width: Math.round(18 + textUnits(text) * 5.4) });
    perSatellite.set(satellite, list);
  }
  const tagMarkup = [];
  const lineMarkup = [];
  for (const [satellite, list] of perSatellite) {
    list.sort((a, b) => a.station.x - b.station.x || String(a.link.id).localeCompare(String(b.link.id)));
    const widest = Math.max(...list.map(entry => entry.width));
    list.forEach((entry, index) => {
      const { link, station, text, width: tagWidth } = entry;
      const { routed, isSelected, touchesSelected, dimmed } = stateOf(link);
      const tone = linkTone(link);
      const classes = ['nd-link', 'nd-tag', tone, link.kind, routed ? 'routed' : '', isSelected ? 'selected' : '', touchesSelected ? 'related' : '', dimmed ? 'dimmed' : ''].filter(Boolean).join(' ');
      const place = tagPlacement(satellite, index, tagWidth, widest);
      const title = titleOf(link, satellite, station);
      tagMarkup.push(`<g class="${classes}" data-diagram-link="${escape(link.id)}" tabindex="0" role="button" aria-label="${escape(title)}"><title>${escape(title)}</title><rect x="${round1(place.x)}" y="${round1(place.y)}" width="${tagWidth}" height="${TAG_HEIGHT}" rx="3"/><circle class="dot" cx="${round1(place.dotX)}" cy="${round1(place.y + TAG_HEIGHT / 2)}" r="2.4"/><text x="${round1(place.textX)}" y="${round1(place.y + TAG_HEIGHT / 2 + 3.4)}" text-anchor="${place.anchorMode}">${escape(text)}</text></g>`);
      if (routed || isSelected) {
        const {path, mid} = linkGeometry(satellite, station, 'ground', layout);
        const flow = routed && link.usable ? `<path class="nd-flow forward" d="${path}" style="animation-delay:-${elapsed}s"/><path class="nd-flow reverse" d="${path}" style="animation-delay:-${elapsed}s"/>` : '';
        const label = link.usable ? `<g class="nd-pill" transform="translate(${round1(mid.x)},${round1(mid.y)})"><rect x="-17" y="-8" width="34" height="16" rx="3"/><text text-anchor="middle" y="3.5">${escape(link.quality)}%</text></g>` : '';
        lineMarkup.push(`<g class="nd-ground-line ${tone} ${routed ? 'routed' : ''} ${isSelected ? 'selected' : ''}"><path class="line" d="${path}"/>${flow}${label}</g>`);
      }
    });
  }
  const linkMarkup = ordered.filter(link => !isGroundContact(link)).map(link => {
    const p = positions.get(String(link.a)); const q = positions.get(String(link.b));
    const tone = linkTone(link);
    const { routed, isSelected, touchesSelected, dimmed } = stateOf(link);
    const cross = link.kind === 'oisl' && p.row !== q.row;
    const classes = ['nd-link', tone, link.kind, cross ? 'cross' : '', routed ? 'routed' : '', isSelected ? 'selected' : '', touchesSelected ? 'related' : '', dimmed ? 'dimmed' : ''].filter(Boolean).join(' ');
    const title = titleOf(link, p, q);
    const {path,mid} = linkGeometry(p,q,link.kind,layout);
    const label = (routed || isSelected || options.showLabels) && link.usable && link.kind !== 'terrestrial'
      ? `<g class="nd-pill" transform="translate(${mid.x},${mid.y})"><rect x="-17" y="-8" width="34" height="16" rx="3"/><text text-anchor="middle" y="3.5">${escape(link.quality)}%</text></g>` : '';
    const flow = (link.kind === 'oisl' || link.kind === 'ground') && link.usable
      ? `<path class="nd-flow forward" d="${path}" style="animation-delay:-${elapsed}s"/><path class="nd-flow reverse" d="${path}" style="animation-delay:-${elapsed}s"/>` : '';
    return `<g class="${classes}" data-diagram-link="${escape(link.id)}" tabindex="0" role="button" aria-label="${escape(title)}"><title>${escape(title)}</title><path class="hit" d="${path}"/><path class="line" d="${path}"/>${flow}${label}</g>`;
  }).join('');
  const nodeMarkup = [...positions.entries()].map(([id, place]) => {
    const state = nodeStates.get(id) || {};
    const isSelected = selected && selected.type !== 'link' && String(selected.id) === id;
    const classes = ['nd-node', place.kind, state.tone || 'neutral', isSelected ? 'selected' : ''].filter(Boolean).join(' ');
    const title = `${place.label}${state.title ? ` · ${state.title}` : ''}`;
    const ground = place.kind === 'ground';
    const shape = `<rect class="body" x="${-place.w/2}" y="${-place.h/2}" width="${place.w}" height="${place.h}" rx="${ground ? 7 : 5}"/><circle class="status" cx="${ground ? -68 : -30}" cy="${ground ? -7 : 0}" r="3"/>`;
    const text = ground
      ? `<text class="label" x="-55" y="-3">${escape(shortLabel(place.label,14))}</text><text class="badge" x="-55" y="16">${escape(state.badge || '지상국')}</text>`
      : `<text class="label" x="6" y="${state.badge ? -2 : 4}" text-anchor="middle">${escape(shortLabel(place.label,11))}</text>${state.badge ? `<text class="badge" x="6" y="11" text-anchor="middle">${escape(state.badge)}</text>` : ''}`;
    return `<g class="${classes}" data-diagram-node="${escape(id)}" tabindex="0" role="button" aria-label="${escape(title)}" transform="translate(${place.x},${place.y})"><title>${escape(title)}</title>${shape}${text}</g>`;
  }).join('');
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="통신 네트워크 연결도" class="nd" style="min-width:${Math.round(width*.68)}px;min-height:${Math.round(height*.68)}px">${groundMarkup}${planeMarkup}${linkMarkup}${lineMarkup.join('')}${planeLabels}${nodeMarkup}${tagMarkup.join('')}${header}</svg>`;
}
