// Orbit propagation and geometric pass prediction; no DOM or renderer dependency.

export function positionAt(entry, satelliteLib, date) {
  if (!entry) return null;
  const { item, record, index } = entry;
  if (record && satelliteLib) {
    try {
      const pv = satelliteLib.propagate(record, date);
      if (!pv?.position) return null;
      const gmst = satelliteLib.gstime(date);
      const geo = satelliteLib.eciToGeodetic(pv.position, gmst);
      return {
        longitude: satelliteLib.degreesLong(geo.longitude),
        latitude: satelliteLib.degreesLat(geo.latitude),
        altitude: Math.max(0, geo.height),
        velocity: pv.velocity ? Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z) : 0,
      };
    } catch (error) { return null; }
  }
  const seconds = date.getTime() / 1000;
  const derivedAltitude = (Number(item.APOGEE_KM || 0) + Number(item.PERIGEE_KM || 0)) / 2;
  const altitude = Number(item.altitude_km || derivedAltitude || (Number(item.SEMI_MAJOR_AXIS_KM || 0) - 6378.137) || 520 + (index % 30) * 18);
  const inclination = Number(item.INCLINATION || item.inclination || 30 + (index * 13) % 70);
  const period = Number(item.PERIOD_MINUTES || 0) * 60 || 5400 + (index % 40) * 70;
  const phase = Number(item.phase || index * 1.27) + (seconds % period) / period * Math.PI * 2;
  return {
    longitude: ((phase * 180 / Math.PI * 1.42 + index * 37) % 360) - 180,
    latitude: Math.sin(phase) * inclination,
    altitude,
    velocity: 7.3 + (index % 4) * .12,
  };
}

export function elevationAt(position, station) {
  const toRad = (value) => value * Math.PI / 180;
  const lat1 = toRad(position.latitude); const lat2 = toRad(station.latitude);
  const deltaLon = toRad(position.longitude - station.longitude);
  const central = Math.acos(Math.max(-1, Math.min(1, Math.sin(lat1) * Math.sin(lat2) + Math.cos(lat1) * Math.cos(lat2) * Math.cos(deltaLon))));
  const ratio = 6378.137 / (6378.137 + Math.max(1, position.altitude));
  return Math.atan2(Math.cos(central) - ratio, Math.sin(central)) * 180 / Math.PI;
}

export function predictPasses(positionForDate, station, currentDate, hours = 24) {
  const passes = [];
  const start = currentDate?.getTime?.() || Date.now();
  let active = null;
  for (let seconds = 0; seconds <= hours * 3600; seconds += 45) {
    const date = new Date(start + seconds * 1000);
    const position = positionForDate(date);
    if (!position) continue;
    const elevation = elevationAt(position, station);
    if (elevation >= 5 && !active) active = { aos: date, los: date, maxElevation: elevation, maxAt: date };
    if (active && elevation >= 5) {
      active.los = date;
      if (elevation > active.maxElevation) { active.maxElevation = elevation; active.maxAt = date; }
    }
    if (active && elevation < 5) {
      passes.push(active); active = null;
      if (passes.length >= 3) break;
    }
  }
  if (active && passes.length < 3) passes.push(active);
  return passes.map((pass) => ({
    station: station.name,
    aos: pass.aos,
    los: pass.los,
    maxAt: pass.maxAt,
    maxElevation: pass.maxElevation,
    durationSeconds: Math.round((pass.los - pass.aos) / 1000),
  }));
}
