import test from 'node:test';
import assert from 'node:assert/strict';

const module = await import('../../../digital_twin/visualization/camera_motion.js').catch(() => ({}));
function fixture() {
  assert.equal(typeof module.CameraRangeMotion, 'function', 'camera ranges need a frame-driven motion, not wheel-event jumps');
  let time = 0;
  const motion = new module.CameraRangeMotion({ now: () => time });
  let distance = 1000;
  return {
    motion, get distance() { return distance; }, set distance(value) { distance = value; },
    advance(ms, frame = 1000 / 60) {
      for (let elapsed = 0; elapsed < ms - 1e-8;) {
        const step = Math.min(frame, ms - elapsed); elapsed += step; time += step;
        distance = motion.advance(distance);
      }
      return distance;
    },
  };
}

test('wheel motion starts at the displayed range, settles monotonically, and has no overshoot', () => {
  const f = fixture();
  f.motion.wheel(f.distance, 120, { minimum: 20, maximum: 10000 });
  assert.equal(f.distance, 1000);
  const first = f.advance(16);
  assert.ok(first < 1000 && first > 950, 'first rendered step must not jump to the wheel target');
  const halfway = f.advance(150);
  assert.ok(halfway < first && halfway > 835);
  f.advance(3000);
  assert.ok(Math.abs(f.distance - 835.2702114) < .001);
  assert.equal(f.motion.active, false);
});

test('reversing the wheel discards the pending approach and immediately moves outward', () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) f.motion.wheel(f.distance, 240);
  f.advance(32);
  const turningPoint = f.distance;
  f.motion.wheel(f.distance, -120);
  assert.ok(f.advance(16) > turningPoint, 'a reverse wheel must not finish the old inward goal');
  f.advance(3000);
  assert.ok(f.distance > turningPoint && f.distance < 1000);
});

test('30, 60 and 144 Hz give the same zoom after the same elapsed time', () => {
  const distances = [30, 60, 144].map(fps => {
    const f = fixture(); f.motion.wheel(f.distance, 120); return f.advance(400, 1000 / fps);
  });
  assert.ok(Math.max(...distances) - Math.min(...distances) < 1e-6);
});

test('a delayed frame cannot teleport to a close-up and cancelling prevents later drift', () => {
  const f = fixture(); f.distance = 20_000_000;
  f.motion.moveTo(f.distance, 87);
  f.advance(10000, 10000);
  assert.ok(f.distance > 10_000_000, 'a background-tab gap must not be replayed in one frame');
  f.motion.cancel();
  const stopped = f.distance;
  f.advance(1000);
  assert.equal(f.distance, stopped);
});

test('a short sequence of deliberate wheel steps reaches a real-size model, then allows fine control', () => {
  const f = fixture(); f.distance = 20_000_000;
  let steps = 0;
  while (f.distance > 100 && steps < 16) {
    f.motion.wheel(f.distance, 120, { minimum: 17.4, focusRange: 87 });
    f.advance(2500); steps++;
  }
  assert.ok(f.distance >= 80 && f.distance <= 100, `model should be framed without dozens of notches: ${steps}, ${f.distance}`);
  const before = f.distance;
  f.motion.wheel(before, 120, { minimum: 17.4, focusRange: 87 }); f.advance(2500);
  assert.ok(f.distance > before * .8 && f.distance < before, 'near the body one notch is a small refinement');
});

test('range limits and invalid input cannot collapse the camera or create NaN', () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) f.motion.wheel(f.distance, 240, { minimum: 20, maximum: 2000 });
  f.advance(4000); assert.ok(Math.abs(f.distance - 20) < .001);
  f.motion.moveTo(f.distance, NaN); f.motion.wheel(f.distance, Infinity);
  f.advance(100); assert.ok(Number.isFinite(f.distance));
  for (let i = 0; i < 100; i++) f.motion.wheel(f.distance, -240, { minimum: 20, maximum: 2000 });
  f.advance(4000); assert.ok(Math.abs(f.distance - 2000) < .001);
});

test('camera orientation turns continuously through opposite directions without a degenerate basis', () => {
  assert.equal(typeof module.cameraDirection, 'function');
  assert.equal(typeof module.cameraBasis, 'function');
  const start = { x: 0, y: 0, z: 1 }, end = { x: 0, y: 0, z: -1 };
  const first = module.cameraDirection(start, end, .01);
  assert.ok(first.z > .99);
  const middle = module.cameraDirection(start, end, .5);
  assert.ok(Math.abs(middle.z) < 1e-8);
  for (const t of [0, .01, .25, .5, .99, 1]) {
    const basis = module.cameraBasis(module.cameraDirection(start, end, t), { x: 0, y: 0, z: 1 });
    for (const v of [basis.direction, basis.up, basis.right]) assert.ok(Math.abs(Math.hypot(v.x, v.y, v.z) - 1) < 1e-8);
    assert.ok(Math.abs(basis.direction.x * basis.up.x + basis.direction.y * basis.up.y + basis.direction.z * basis.up.z) < 1e-8);
  }
});

test('an upside-down focus rotates the whole camera attitude without a mid-flight roll flip', () => {
  assert.equal(typeof module.cameraAttitude, 'function');
  let previous;
  for (let i = 0; i <= 1000; i++) {
    const basis = module.cameraAttitude({ x: 0, y: 0, z: 1 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 }, i / 1000);
    if (previous) assert.ok(basis.up.x * previous.up.x + basis.up.y * previous.up.y + basis.up.z * previous.up.z > .999);
    assert.ok(Math.abs(basis.direction.x * basis.up.x + basis.direction.y * basis.up.y + basis.direction.z * basis.up.z) < 1e-8);
    previous = basis;
  }
  assert.ok(previous.direction.z < -.999 && previous.up.y > .999);
});
