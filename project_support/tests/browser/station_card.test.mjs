import test from 'node:test';
import assert from 'node:assert/strict';

const { stationCardModel, stationOptionMarkup, visibleSatelliteCount, coordinateLabel } = await import('../../../user_application/web/scripts/orbit/station_card.js');

const daejeon = { key: 'DAEJEON', name: '대전', region: '대한민국', operator: '한국항공우주연구원 (KARI)', network: '위성운영센터', role: '국가 위성 관제·추적', latitude: 36.3742, longitude: 127.3567, altitudeKm: 0.07, dishMeters: 13, bands: ['S', 'X', 'Ka'], minElevationDeg: 5 };

test('coordinates are shown with hemisphere letters', () => {
  assert.equal(coordinateLabel(36.3742, 127.3567), '36.3742° N, 127.3567° E');
  assert.equal(coordinateLabel(-35.4014, -69.398), '35.4014° S, 69.3980° W');
  assert.equal(coordinateLabel(NaN, 1), '—');
});

test('the card carries the site facts and the live geometry of the selected body', () => {
  const model = stationCardModel(daejeon, {
    selectedName: 'ISS (ZARYA)', look: { azimuth: 245.26, elevation: 31.04, rangeKm: 812.3 }, maskDegrees: 5,
    visibleCount: 1234, catalogCount: 16510, nextPass: { aos: new Date('2026-09-07T13:46:28Z'), maxElevation: 11.49 }, isObserver: false,
  });
  assert.equal(model.title, '대전');
  assert.equal(model.subtitle, '대한민국');
  assert.equal(model.kicker, '한국항공우주연구원 (KARI) · 위성운영센터');
  assert.deepEqual(Object.fromEntries(model.facts), { '좌표': '36.3742° N, 127.3567° E', '고도': '0.07 km', '안테나': '13 m 급', '대역': 'S · X · Ka', '최소 고각': '5°', '역할': '국가 위성 관제·추적' });
  const live = Object.fromEntries(model.live);
  assert.equal(live['선택 위성'], 'ISS (ZARYA)');
  assert.equal(live['방위각 / 고각'], '245.3° / 31.0°');
  assert.equal(live['경사거리'], '812.3 km');
  assert.equal(live['가시 여부'], '마스크 5° 이상');
  assert.equal(live['마스크 이상 위성'], '1,234 / 16,510');
  assert.equal(live['다음 관측창'], '09-07 13:46 UTC · 최대 11.5°');
  assert.equal(model.state, 'visible');
  assert.equal(model.isObserver, false);
  assert.match(model.note, /실시간 운용 상태를 받아오지 않습니다/);
});

test('without a selected body the live rows stay neutral, and a body below the mask reads as hidden', () => {
  const none = stationCardModel(daejeon, { visibleCount: 0, catalogCount: 0 });
  assert.equal(none.state, 'none');
  assert.equal(Object.fromEntries(none.live)['선택 위성'], '위성 미선택');
  assert.equal(Object.fromEntries(none.live)['다음 관측창'], '—');
  const hidden = stationCardModel(daejeon, { selectedName: 'A', look: { azimuth: 10, elevation: -20, rangeKm: 4000 }, maskDegrees: 5, nextPass: null });
  assert.equal(hidden.state, 'hidden');
  assert.equal(Object.fromEntries(hidden.live)['가시 여부'], '마스크 5° 미만');
  assert.equal(Object.fromEntries(hidden.live)['다음 관측창'], '24 h 내 없음');
  const unknown = stationCardModel(daejeon, { selectedName: 'A', look: null });
  assert.equal(unknown.state, 'unknown');
  assert.equal(stationCardModel(null), null);
});

test('the observer selector groups sites and escapes their labels', () => {
  const markup = stationOptionMarkup([
    { key: 'korea', label: '대한민국', sites: [{ key: 'DAEJEON', name: '대전' }, { key: 'SEOUL', name: '서울' }] },
    { key: 'polar', label: '극지', sites: [{ key: 'TROLL', name: '<트롤>' }] },
  ], 'SEOUL');
  assert.match(markup, /<optgroup label="대한민국"><option value="DAEJEON">대전<\/option><option value="SEOUL" selected>서울<\/option><\/optgroup>/);
  assert.match(markup, /&lt;트롤&gt;/);
});

test('the visible count applies the mask to every live position and skips missing ones', () => {
  const positions = [{ el: 40 }, { el: 5 }, { el: 4.9 }, null, { el: -10 }];
  const count = visibleSatelliteCount(positions, daejeon, 5, position => position.el);
  assert.equal(count, 2);
});
