import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutTimeline, timeTicks, timelineMarkup, TIMELINE } from '../../../digital_twin/visualization/mission_timeline.js';

const T0 = Date.UTC(2026, 8, 8, 0, 0, 0);
const H = 3600_000;

test('rows get a y each and time maps linearly into the plot area', () => {
  const layout = layoutTimeline({ rows: [{ id: 'A', label: 'ODT-A1' }, { id: 'B', label: 'ODT-A2', note: '안전 모드' }], start: T0, end: T0 + 12 * H });
  assert.equal(layout.rows.length, 2);
  assert.equal(layout.rows[1].y, TIMELINE.header + TIMELINE.rowHeight);
  assert.equal(layout.height, TIMELINE.header + 2 * TIMELINE.rowHeight + TIMELINE.padding);
  assert.equal(layout.xOf(T0), TIMELINE.gutter);
  assert.equal(layout.xOf(T0 + 12 * H), TIMELINE.width - TIMELINE.padding);
  assert.equal(layout.xOf(T0 - H), TIMELINE.gutter, 'times before the window clamp to the gutter');
  assert.equal(layout.xOf(new Date(T0 + 6 * H).toISOString()), (TIMELINE.gutter + TIMELINE.width - TIMELINE.padding) / 2, 'ISO strings are accepted');
  assert.equal(timeTicks(T0, T0 + 3 * H).length, 7, 'half-hour ticks under four hours');
  assert.equal(timeTicks(T0, T0 + 12 * H).length, 13);
  assert.equal(timeTicks(T0, T0 + 24 * H).length, 13, 'two-hour ticks over twelve hours');
  assert.equal(timeTicks(T0, T0 + 2 * H)[0].label, '00:00');
});

test('markup carries bands, task bars with status and selection, the now line and deadlines', () => {
  const layout = layoutTimeline({ rows: [{ id: 'A', label: 'ODT-A1' }, { id: 'B', label: 'ODT-A2' }], start: T0, end: T0 + 6 * H });
  const markup = timelineMarkup(layout, {
    tasks: [
      { id: 'M1-T01', mission_id: 'M1', kind: 'collect', satellite: 'A', start: T0 + H, end: T0 + H + 45_000, label: '촬영', status: 'done', counterpart: '서울', volume_mb: 800 },
      { id: 'M1-T02', mission_id: 'M1', kind: 'transfer', satellite: 'B', start: T0 + 2 * H, end: T0 + 2.5 * H, label: '지상 전송', status: 'running' },
      { id: 'M2-T01', mission_id: 'M2', kind: 'process', satellite: 'A', start: T0 + 3 * H, end: T0 + 4 * H, label: '처리', status: 'planned', feasible: false },
      { id: 'M9-T01', mission_id: 'M9', kind: 'apply', satellite: 'Z', start: T0, end: T0 + H, label: '없는 행' },
    ],
    contacts: [{ satellite: 'B', station: 'GS-DAEJEON', station_name: '대전', start: T0 + 1.9 * H, end: T0 + 2.6 * H, max_elevation: 44 }, { satellite: 'B', station: 'GS-X', start: T0 - 3 * H, end: T0 - 2 * H }],
    eclipses: [{ satellite: 'A', start: T0 + 0.5 * H, end: T0 + 1.1 * H }],
    now: T0 + 2.2 * H, deadlines: [{ ms: T0 + 5 * H, label: '서울 관측 기한', mission_id: 'M1' }, { ms: T0 + 9 * H, label: '밖', mission_id: 'M2' }],
    selectedTaskId: 'M1-T02', selectedMissionId: 'M1', kinds: { collect: { color: '#3ddc84' }, transfer: { color: '#4ac4ee' }, process: { color: '#79b3e3' } },
  });
  assert.ok(markup.startsWith('<svg'));
  assert.match(markup, /class="mt-task collect done" data-timeline-task="M1-T01"/);
  assert.match(markup, /class="mt-task transfer running selected" data-timeline-task="M1-T02"/);
  assert.match(markup, /class="mt-task process planned other infeasible"/);
  assert.doesNotMatch(markup, /M9-T01/, 'tasks on unknown rows are skipped');
  assert.equal((markup.match(/class="mt-contact"/g) || []).length, 1, 'contacts outside the window are dropped');
  assert.match(markup, /<title>ODT-A2 ↔ 대전 접속창 01:54–02:36 UTC · 최대 고각 44°<\/title>/);
  assert.match(markup, /class="mt-eclipse"/);
  assert.match(markup, /class="mt-now"/);
  assert.equal((markup.match(/class="mt-deadline/g) || []).length, 1, 'deadlines outside the window are dropped');
  assert.match(markup, /class="mt-deadline selected"/);
  assert.match(markup, /--mt-color:#4ac4ee/);
  assert.match(markup, /<title>촬영 · ODT-A1 → 서울 · 01:00:00–01:00:45 UTC · 800 MB<\/title>/);
  const wide = layoutTimeline({ rows: [{ id: 'A' }], start: T0, end: T0 + H, width: 1500 });
  assert.equal(wide.xOf(T0 + H), 1500 - TIMELINE.padding, 'the plot spans the width the host measured');
  const wideMarkup = timelineMarkup(wide, {});
  assert.match(wideMarkup, /viewBox="0 0 1500 /, 'the viewBox is the pixel width, so nothing is stretched');
  assert.match(wideMarkup, /preserveAspectRatio="xMinYMin meet"/, 'no non-uniform scaling');
  const tall = layoutTimeline({ rows: [{ id: 'A' }, { id: 'B' }], start: T0, end: T0 + H, rowHeight: 40 });
  assert.equal(tall.height, TIMELINE.header + 2 * 40 + TIMELINE.padding, 'rows may be taller than the nominal height');
  assert.equal(tall.rows[1].y, TIMELINE.header + 40);
  assert.match(timelineMarkup(tall, {}), /height="40"/, 'row backgrounds use the row height');
  const escaped = timelineMarkup(layoutTimeline({ rows: [{ id: 'x', label: 'A&B<' }], start: T0, end: T0 + H }), {});
  assert.match(escaped, /A&amp;B&lt;/);
});
