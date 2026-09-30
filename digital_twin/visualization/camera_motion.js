// Camera distances are metres (2D: orthographic width). Motion uses a monotonic
// wall clock, never the paused, accelerated or reversed orbital analysis clock.
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
export const cameraNow = () => globalThis.performance?.now?.() ?? Date.now();
export const cameraEase = t => t * t * (3 - 2 * t);

const unit = v => {
  const length = Math.hypot(v.x, v.y, v.z);
  return length > 1e-12 ? { x: v.x / length, y: v.y / length, z: v.z / length } : { x: 0, y: 0, z: -1 };
};
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

// Spherical interpolation also handles a 180-degree turn (linear interpolation
// would produce a zero vector). Returned axes are independent value objects.
export function cameraDirection(from, to, fraction) {
  const a = unit(from), b = unit(to), t = clamp(fraction, 0, 1);
  const cosine = clamp(dot(a, b), -1, 1);
  if (t === 0) return a;
  if (t === 1) return b;
  if (cosine > .9995) return unit({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
  const tangent = cosine < -.9995
    ? unit(cross(a, Math.abs(a.z) < .9 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 }))
    : unit({ x: b.x - a.x * cosine, y: b.y - a.y * cosine, z: b.z - a.z * cosine });
  const angle = Math.acos(cosine) * t;
  return unit({ x: a.x * Math.cos(angle) + tangent.x * Math.sin(angle), y: a.y * Math.cos(angle) + tangent.y * Math.sin(angle), z: a.z * Math.cos(angle) + tangent.z * Math.sin(angle) });
}

export function cameraBasis(direction, preferredUp) {
  direction = unit(direction);
  let right = cross(direction, preferredUp);
  if (Math.hypot(right.x, right.y, right.z) < 1e-6) right = cross(direction, Math.abs(direction.z) < .9 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 });
  right = unit(right);
  return { direction, right, up: unit(cross(right, direction)) };
}

function attitudeQuaternion(direction, up) {
  const basis = cameraBasis(direction, up), r = basis.right, u = basis.up, d = basis.direction;
  const m = [[r.x, u.x, -d.x], [r.y, u.y, -d.y], [r.z, u.z, -d.z]];
  const trace = m[0][0] + m[1][1] + m[2][2];
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return [(m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s, s / 4];
  }
  const i = m[0][0] > m[1][1] && m[0][0] > m[2][2] ? 0 : m[1][1] > m[2][2] ? 1 : 2;
  const j = (i + 1) % 3, k = (i + 2) % 3;
  const s = Math.sqrt(1 + m[i][i] - m[j][j] - m[k][k]) * 2, q = [0, 0, 0, 0];
  q[i] = s / 4; q[j] = (m[i][j] + m[j][i]) / s; q[k] = (m[i][k] + m[k][i]) / s; q[3] = (m[k][j] - m[j][k]) / s;
  return q;
}

// Rotate a complete orthonormal camera frame. Interpolating direction and up
// independently can align the two axes and flip roll halfway through a focus.
export function cameraAttitude(fromDirection, fromUp, toDirection, toUp, fraction) {
  const a = attitudeQuaternion(fromDirection, fromUp), b = attitudeQuaternion(toDirection, toUp);
  const t = clamp(fraction, 0, 1);
  let cosine = a.reduce((sum, value, i) => sum + value * b[i], 0);
  if (cosine < 0) { for (let i = 0; i < 4; i++) b[i] *= -1; cosine = -cosine; }
  const angle = Math.acos(clamp(cosine, -1, 1));
  const left = cosine > .9995 ? 1 - t : Math.sin((1 - t) * angle) / Math.sin(angle);
  const right = cosine > .9995 ? t : Math.sin(t * angle) / Math.sin(angle);
  const q = a.map((value, i) => value * left + b[i] * right), length = Math.hypot(...q);
  const [x, y, z, w] = q.map(value => value / length);
  return {
    right: { x: 1 - 2 * (y * y + z * z), y: 2 * (x * y + z * w), z: 2 * (x * z - y * w) },
    up: { x: 2 * (x * y - z * w), y: 1 - 2 * (x * x + z * z), z: 2 * (y * z + x * w) },
    direction: { x: -2 * (x * z + y * w), y: -2 * (y * z - x * w), z: -(1 - 2 * (x * x + y * y)) },
  };
}

export class CameraRangeMotion {
  constructor({ now = cameraNow } = {}) {
    this.now = now;
    this.cancel();
  }

  get active() { return this.target !== null; }

  cancel() {
    this.target = null;
    this.direction = 0;
    this.stamp = null;
  }

  moveTo(current, target) {
    if (!(current > 0) || !Number.isFinite(current) || !(target > 0) || !Number.isFinite(target)) return false;
    if (!this.active) this.stamp = this.now();
    this.direction = Math.sign(current - target);
    this.target = target;
    return true;
  }

  wheel(current, delta, { minimum = 1, maximum = Number.MAX_VALUE, focusRange = 0 } = {}) {
    if (!Number.isFinite(delta) || !delta || !(current > 0) || !Number.isFinite(current)) return false;
    // Accumulate same-direction input, but reverse from the displayed distance,
    // not from an unseen goal. A reverse wheel immediately cancels auto-approach.
    const base = this.active && Math.sign(delta) === this.direction ? this.target : current;
    const gain = focusRange > 0
      ? .0015 + clamp(Math.log(base / (focusRange * 5)) * .0009, 0, .006)
      : .0015;
    let target = base * Math.exp(-clamp(delta, -240, 240) * gain);
    if (delta > 0 && focusRange > 0 && base > focusRange * 8 && target <= Math.max(20_000, focusRange * 100)) {
      target = focusRange;
    }
    // Continued input during the approach must not drive through the model.
    if (delta > 0 && focusRange > 0 && current > focusRange * 8 && base <= focusRange) target = focusRange;
    return this.moveTo(current, clamp(target, minimum, maximum));
  }

  advance(current) {
    if (!this.active) return current;
    if (!(current > 0) || !Number.isFinite(current)) { this.cancel(); return current; }
    const now = this.now();
    // Dropped/background frames are not replayed as a single huge camera jump.
    const dt = clamp(now - this.stamp, 0, 50);
    this.stamp = now;
    const error = Math.log(this.target / current);
    if (Math.abs(error) < 1e-5) {
      const target = this.target; this.cancel(); return target;
    }
    const step = clamp(error * -Math.expm1(-dt / 180), -dt * .012, dt * .012);
    return current * Math.exp(step);
  }
}
