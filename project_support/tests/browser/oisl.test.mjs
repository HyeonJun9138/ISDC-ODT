import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeStateAt } from '../../../digital_twin/simulation/browser/satellite_dynamics.js';
import * as oisl from '../../../digital_twin/simulation/browser/oisl.js';

const { lineOfSightClear, pointingTo, gimbalCommand, linkGeometry, linkMargin, createTerminalState, advanceTerminal, chooseTarget, pairState, acquisitionProgress } = oisl;
const T0 = Date.UTC(2026, 8, 7, 0, 0, 0);
const terminal = { max_range_km: 5000, min_range_km: 30, slew_rate_deg_s: 2, acquisition_time_s: 20, jitter_deg: 0.002, field_of_regard: { azimuth_half_angle: 180, elevation: [-20, 90] } };
const stateOf = (meanAnomaly, raan = 0, date = T0) => nodeStateAt({ altitude_km: 550, inclination: 53, raan, mean_anomaly: meanAnomaly, epoch: T0 }, date);

function close(actual, expected, tolerance, message = '') {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} differs from ${expected}`);
}

test('line of sight clears above the atmosphere margin and is blocked through Earth', () => {
  const thirty = [7000 * Math.cos(Math.PI / 6), 7000 * Math.sin(Math.PI / 6), 0];
  assert.equal(lineOfSightClear([7000, 0, 0], thirty), true, 'a 30 degree chord at 7000 km dips to 6761 km, above the margin');
  assert.equal(lineOfSightClear([7000, 0, 0], [0, 7000, 0]), false, 'a 90 degree chord dips to 4950 km, through Earth');
  assert.equal(lineOfSightClear([7000, 0, 0], [-7000, 0, 0]), false, 'antipodal bodies look through Earth');
  assert.equal(lineOfSightClear([6500, 0, 0], [6500 * Math.cos(0.3), 6500 * Math.sin(0.3), 0]), false, 'the chord grazes inside the 100 km margin');
  assert.equal(lineOfSightClear([6500, 0, 0], [6500 * Math.cos(0.3), 6500 * Math.sin(0.3), 0], -100), true, 'a negative margin ignores the atmosphere');
  assert.equal(lineOfSightClear([7000, 0, 0], [7000, 0, 0]), false, 'zero separation is not a link');
});

test('pointing uses the owner LVLH frame: fore is azimuth 0 slightly below horizontal, aft is 180', () => {
  const owner = stateOf(0);
  const fore = pointingTo(owner, stateOf(30));
  close(fore.azimuth, 0, 0.5);
  close(fore.elevation, -15, 0.2, 'a 30 degree lead sits 15 degrees below the local horizontal');
  close(fore.range_km, 2 * 6928.137 * Math.sin(15 * Math.PI / 180), 5);
  const aft = pointingTo(owner, stateOf(-30));
  close(Math.abs(aft.azimuth), 180, 0.5);
  // At its ascending node the owner heads north-east, so a node whose plane crosses 20 degrees
  // further east along the equator lies to the right of the direction of motion.
  const east = pointingTo(owner, stateOf(0, 20));
  assert.ok(east.azimuth < -45 && east.azimuth > -135, `a node in a plane 20 degrees east appears on the right at ${east.azimuth}`);
  const west = pointingTo(owner, stateOf(0, -20));
  assert.ok(west.azimuth > 45 && west.azimuth < 135, `a node in a plane 20 degrees west appears on the left at ${west.azimuth}`);
  close(pointingTo(owner, stateOf(30)).range_rate_km_s, 0, 1e-3, 'same circular orbit keeps a constant range');
});

test('gimbal commands are relative to the mounting boresight and honour the field of regard', () => {
  const aftMount = gimbalCommand(terminal, 'aft', { azimuth: 170, elevation: -5 });
  close(aftMount.azimuth, -10, 1e-9);
  assert.equal(aftMount.reachable, true);
  const narrow = { ...terminal, field_of_regard: { azimuth_half_angle: 60, elevation: [-15, 45] } };
  assert.equal(gimbalCommand(narrow, 'fore', { azimuth: 70, elevation: 0 }).reachable, false);
  assert.equal(gimbalCommand(narrow, 'fore', { azimuth: 20, elevation: -16 }).reachable, false);
  assert.equal(gimbalCommand(narrow, 'left', { azimuth: 100, elevation: 10 }).reachable, true);
  assert.equal(gimbalCommand({}, 'auto', { azimuth: -179, elevation: 89 }).reachable, true, 'no field of regard means a full sphere');
});

test('link geometry reports the first blocking reason in order earth, range, field of regard', () => {
  const owner = stateOf(0);
  assert.equal(linkGeometry(owner, stateOf(180), terminal, 'fore').blockedBy, 'earth');
  assert.equal(linkGeometry(owner, stateOf(60), terminal, 'fore').blockedBy, 'earth', 'at 550 km the horizon closes a chord before 5000 km');
  assert.equal(linkGeometry(owner, stateOf(30), { ...terminal, max_range_km: 3000 }, 'fore').blockedBy, 'range');
  const narrow = { ...terminal, field_of_regard: { azimuth_half_angle: 30, elevation: [-20, 90] } };
  assert.equal(linkGeometry(owner, stateOf(20), narrow, 'aft').blockedBy, 'field_of_regard');
  const fine = linkGeometry(owner, stateOf(20), terminal, 'fore');
  assert.equal(fine.feasible, true);
  assert.equal(fine.blockedBy, null);
  assert.equal(linkGeometry(owner, owner, terminal), null);
});

test('margin is the geometric loss relative to the rated range and quality is a display heuristic', () => {
  close(linkMargin(500, terminal).margin_db, 20, 1e-9);
  assert.equal(linkMargin(500, terminal).quality, 100);
  assert.equal(linkMargin(5000, terminal).quality, 50);
  assert.equal(linkMargin(10000, terminal).quality, 20);
  assert.deepEqual(linkMargin(0, terminal), { margin_db: null, quality: null });
  assert.deepEqual(linkMargin(100, {}), { margin_db: null, quality: null });
});

test('a terminal slews at its rate, dwells for acquisition and then tracks; retargeting restarts', () => {
  const geometry = { feasible: true, blockedBy: null, gimbal: { azimuth: 20, elevation: -10, reachable: true } };
  let state = advanceTerminal(createTerminalState(), terminal, { targetId: 'B' }, geometry, T0);
  assert.equal(state.phase, 'slewing');
  assert.equal(state.target, 'B');
  state = advanceTerminal(state, terminal, { targetId: 'B' }, geometry, T0 + 5000);
  assert.equal(state.phase, 'slewing');
  close(Math.hypot(state.azimuth, state.elevation), 10, 1e-9, '2 deg/s for 5 s covers 10 of the 22.4 degrees');
  state = advanceTerminal(state, terminal, { targetId: 'B' }, geometry, T0 + 12000);
  assert.equal(state.phase, 'acquiring');
  close(state.azimuth, 20, 1e-9); close(state.elevation, -10, 1e-9);
  const progress = acquisitionProgress(state, terminal, T0 + 12000);
  assert.ok(progress > 0 && progress < 0.1, `arrival is back-dated to the true end of the slew, progress ${progress}`);
  state = advanceTerminal(state, terminal, { targetId: 'B' }, geometry, T0 + 40000);
  assert.equal(state.phase, 'tracking');
  assert.equal(state.pointingError, 0.002);
  close(state.lockedAt, T0 + 31180, 1, 'lock at slew end (11.18 s) plus the 20 s acquisition dwell');
  const retarget = advanceTerminal(state, terminal, { targetId: 'C' }, { ...geometry, gimbal: { azimuth: -60, elevation: 0, reachable: true } }, T0 + 41000);
  assert.equal(retarget.phase, 'slewing');
  assert.equal(retarget.lockedAt, null);
  const idle = advanceTerminal(retarget, terminal, null, null, T0 + 42000);
  assert.equal(idle.phase, 'idle');
  assert.equal(idle.target, null);
});

test('a lost line of sight blocks the terminal and a recovered one restarts acquisition; time reversal resets', () => {
  const clear = { feasible: true, blockedBy: null, gimbal: { azimuth: 0, elevation: 0, reachable: true } };
  const blocked = { feasible: false, blockedBy: 'earth', gimbal: { azimuth: 0, elevation: 0, reachable: true } };
  let state = advanceTerminal(createTerminalState(), terminal, { targetId: 'B' }, clear, T0);
  state = advanceTerminal(state, terminal, { targetId: 'B' }, clear, T0 + 30000);
  assert.equal(state.phase, 'tracking');
  state = advanceTerminal(state, terminal, { targetId: 'B' }, blocked, T0 + 31000);
  assert.equal(state.phase, 'blocked');
  assert.equal(state.blockedBy, 'earth');
  state = advanceTerminal(state, terminal, { targetId: 'B' }, clear, T0 + 32000);
  assert.equal(state.phase, 'acquiring', 'the gimbal is already on target, so only the dwell remains');
  state = advanceTerminal(state, terminal, { targetId: 'B' }, clear, T0 + 60000);
  assert.equal(state.phase, 'tracking');
  const rewound = advanceTerminal(state, terminal, { targetId: 'B' }, clear, T0 + 1000);
  assert.equal(rewound.phase, 'acquiring', 'no reverse history: the sequence restarts at the earlier time');
  assert.equal(rewound.since, T0 + 1000);
});

test('target selection prefers the nearest feasible candidate inside the mounting sector', () => {
  const owner = stateOf(0);
  const candidates = [
    { id: 'lead', state: stateOf(20) }, { id: 'far-lead', state: stateOf(35) }, { id: 'trail', state: stateOf(-20) },
    { id: 'east', state: stateOf(0, 15) }, { id: 'hidden', state: stateOf(180) }, { id: 'nothing', state: null },
  ];
  assert.equal(chooseTarget(owner, candidates, terminal, 'fore').id, 'lead');
  assert.equal(chooseTarget(owner, candidates, terminal, 'aft').id, 'trail');
  assert.equal(chooseTarget(owner, candidates, terminal, 'right').id, 'east', 'the eastern plane lies to the right at the ascending node');
  assert.equal(chooseTarget(owner, candidates, terminal, 'left'), null);
  assert.equal(chooseTarget(owner, candidates, terminal, 'auto', new Set(['lead', 'trail'])).id, 'east');
  assert.equal(chooseTarget(owner, [], terminal, 'auto'), null);
});

test('pair states combine both directions for display', () => {
  assert.equal(pairState('tracking', 'tracking'), 'locked');
  assert.equal(pairState('tracking', 'acquiring'), 'one_way');
  assert.equal(pairState('tracking', undefined), 'one_way');
  assert.equal(pairState('slewing', 'acquiring'), 'acquiring');
  assert.equal(pairState('slewing', 'blocked'), 'slewing');
  assert.equal(pairState('blocked', 'idle'), 'blocked');
  assert.equal(pairState(undefined, undefined), 'none');
});
