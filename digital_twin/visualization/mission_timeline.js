// Schedule view of the mission console: one row per satellite on a UTC time axis with eclipse and
// contact bands behind the task bars, the analysis time and deadlines as vertical lines. Layout
// and markup are pure functions of their inputs so they can be tested without a browser. The
// caller passes the host's pixel width so the SVG is drawn 1:1 (text and bars keep their shape);
// TIMELINE.width is only the fallback for an unmeasured host.
export const TIMELINE = Object.freeze({ width: 1200, gutter: 150, header: 30, rowHeight: 26, padding: 6 });

function escape(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

const ms = value => (value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(String(value ?? '')));

export function layoutTimeline({ rows = [], start, end, width = TIMELINE.width, gutter = TIMELINE.gutter, header = TIMELINE.header, rowHeight = TIMELINE.rowHeight } = {}) {
  const startMs = ms(start); const endMs = ms(end);
  const span = Math.max(1, endMs - startMs);
  const plot = Math.max(1, width - gutter - TIMELINE.padding);
  const xOf = time => gutter + Math.max(0, Math.min(1, (ms(time) - startMs) / span)) * plot;
  const laid = rows.map((row, index) => ({ id: String(row.id), label: row.label || String(row.id), y: header + index * rowHeight, note: row.note || '' }));
  return { width, height: header + laid.length * rowHeight + TIMELINE.padding, gutter, header, rowHeight, start: startMs, end: endMs, xOf, rows: laid, rowIndex: new Map(laid.map(row => [row.id, row])) };
}

// Hour ticks; half hours under 4 h of span, two-hour ticks over 12 h.
export function timeTicks(startMs, endMs) {
  const span = endMs - startMs;
  const step = span <= 4 * 3600_000 ? 1800_000 : span > 12 * 3600_000 ? 7200_000 : 3600_000;
  const ticks = [];
  for (let t = Math.ceil(startMs / step) * step; t <= endMs; t += step) {
    const date = new Date(t);
    ticks.push({ ms: t, label: `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`, day: date.getUTCHours() === 0 && date.getUTCMinutes() === 0 });
  }
  return ticks;
}

// tasks: [{ id, mission_id, kind, satellite, start, end, label, status, feasible }]
// contacts: [{ satellite, station, start, end }], eclipses: [{ satellite, start, end }]
// options: { now, deadlines: [{ ms, label, mission_id }], selectedTaskId, selectedMissionId, kinds: { kind: { color } } }
// accesses: [{ satellite, start, end, max_elevation }] imaging passes of the selected mission's target.
export function timelineMarkup(layout, { tasks = [], contacts = [], eclipses = [], accesses = [], now = null, deadlines = [], selectedTaskId = null, selectedMissionId = null, kinds = {} } = {}) {
  const { width, height, gutter, header, rowHeight, xOf } = layout;
  const clip = (a, b) => [Math.max(layout.start, ms(a)), Math.min(layout.end, ms(b))];
  const rowsMarkup = layout.rows.map((row, index) => `<g class="mt-row ${index % 2 ? 'odd' : ''}" data-timeline-row="${escape(row.id)}"><rect x="0" y="${row.y}" width="${width}" height="${rowHeight}"/><text x="10" y="${row.y + rowHeight / 2 + 4}">${escape(row.label)}</text>${row.note ? `<text class="note" x="${gutter - 8}" y="${row.y + rowHeight / 2 + 4}" text-anchor="end">${escape(row.note)}</text>` : ''}</g>`).join('');
  const ticks = timeTicks(layout.start, layout.end).map(tick => `<g class="mt-tick ${tick.day ? 'day' : ''}"><line x1="${xOf(tick.ms).toFixed(1)}" x2="${xOf(tick.ms).toFixed(1)}" y1="${header - 6}" y2="${height}"/><text x="${xOf(tick.ms).toFixed(1)}" y="${header - 10}" text-anchor="middle">${tick.label}</text></g>`).join('');
  const bands = [];
  for (const eclipse of eclipses) {
    const row = layout.rowIndex.get(String(eclipse.satellite)); if (!row) continue;
    const [a, b] = clip(eclipse.start, eclipse.end); if (b <= a) continue;
    bands.push(`<rect class="mt-eclipse" x="${xOf(a).toFixed(1)}" y="${row.y + 2}" width="${Math.max(1, xOf(b) - xOf(a)).toFixed(1)}" height="${rowHeight - 4}"><title>${escape(row.label)} 식 ${escape(new Date(a).toISOString().slice(11, 16))}–${escape(new Date(b).toISOString().slice(11, 16))} UTC</title></rect>`);
  }
  for (const contact of contacts) {
    const row = layout.rowIndex.get(String(contact.satellite)); if (!row) continue;
    const [a, b] = clip(contact.start, contact.end); if (b <= a) continue;
    bands.push(`<rect class="mt-contact" x="${xOf(a).toFixed(1)}" y="${row.y + 6}" width="${Math.max(2, xOf(b) - xOf(a)).toFixed(1)}" height="${rowHeight - 12}"><title>${escape(row.label)} ↔ ${escape(contact.station_name || contact.station)} 접속창 ${escape(new Date(a).toISOString().slice(11, 16))}–${escape(new Date(b).toISOString().slice(11, 16))} UTC${contact.max_elevation != null ? ` · 최대 고각 ${escape(contact.max_elevation)}°` : ''}</title></rect>`);
  }
  for (const access of accesses) {
    const row = layout.rowIndex.get(String(access.satellite)); if (!row) continue;
    const [a, b] = clip(access.start, access.end); if (b <= a) continue;
    bands.push(`<rect class="mt-access" x="${xOf(a).toFixed(1)}" y="${row.y + 8}" width="${Math.max(2, xOf(b) - xOf(a)).toFixed(1)}" height="${rowHeight - 16}"><title>${escape(row.label)} 관측 통과 ${escape(new Date(a).toISOString().slice(11, 16))}–${escape(new Date(b).toISOString().slice(11, 16))} UTC${access.max_elevation != null ? ` · 최대 고각 ${escape(access.max_elevation)}°` : ''}</title></rect>`);
  }
  const ordered = [...tasks].sort((p, q) => Number(p.mission_id === selectedMissionId) - Number(q.mission_id === selectedMissionId));
  const bars = ordered.map(task => {
    const row = layout.rowIndex.get(String(task.satellite)); if (!row) return '';
    const [a, b] = clip(task.start, task.end); if (b < a) return '';
    const x = xOf(a); const w = Math.max(3, xOf(b) - x);
    const color = kinds[task.kind]?.color || '#8ea4b8';
    const classes = ['mt-task', task.kind, task.status || 'planned', task.id === selectedTaskId ? 'selected' : '', selectedMissionId && task.mission_id !== selectedMissionId ? 'other' : '', task.feasible === false ? 'infeasible' : ''].filter(Boolean).join(' ');
    const title = `${task.label || task.kind} · ${escape(row.label)}${task.counterpart ? ` → ${task.counterpart}` : ''} · ${new Date(ms(task.start)).toISOString().slice(11, 19)}–${new Date(ms(task.end)).toISOString().slice(11, 19)} UTC${task.volume_mb ? ` · ${task.volume_mb} MB` : ''}`;
    const label = w > 46 ? `<text x="${(x + 5).toFixed(1)}" y="${row.y + rowHeight / 2 + 4}">${escape(task.label || task.kind)}</text>` : '';
    return `<g class="${classes}" data-timeline-task="${escape(task.id)}" data-timeline-mission="${escape(task.mission_id)}" tabindex="0" role="button" aria-label="${escape(title)}" style="--mt-color:${color}"><title>${escape(title)}</title><rect x="${x.toFixed(1)}" y="${row.y + 4}" width="${w.toFixed(1)}" height="${rowHeight - 8}" rx="3"/>${label}</g>`;
  }).join('');
  const nowLine = now != null && ms(now) >= layout.start && ms(now) <= layout.end ? `<g class="mt-now"><line x1="${xOf(now).toFixed(1)}" x2="${xOf(now).toFixed(1)}" y1="${header - 4}" y2="${height}"/><text x="${(xOf(now) + 4).toFixed(1)}" y="${header + 10}">현재</text></g>` : '';
  const deadlineLines = deadlines.filter(item => ms(item.ms) >= layout.start && ms(item.ms) <= layout.end).map(item => `<g class="mt-deadline ${item.mission_id === selectedMissionId ? 'selected' : ''}"><line x1="${xOf(item.ms).toFixed(1)}" x2="${xOf(item.ms).toFixed(1)}" y1="${header - 4}" y2="${height}"/><text x="${(xOf(item.ms) - 4).toFixed(1)}" y="${header + 10}" text-anchor="end">${escape(item.label || '기한')}</text></g>`).join('');
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMinYMin meet" role="img" aria-label="임무 일정표" class="mt" width="100%" height="${height}"><g class="mt-rows">${rowsMarkup}</g><g class="mt-ticks">${ticks}</g><g class="mt-bands">${bands.join('')}</g><g class="mt-tasks">${bars}</g>${deadlineLines}${nowLine}<line class="mt-gutter" x1="${gutter}" x2="${gutter}" y1="0" y2="${height}"/></svg>`;
}
