// Ground-to-satellite link geometry for the communication console: which of the user's satellites
// each ground station can see above its elevation mask, on which RF band, and the figures the data
// fabric needs for its budget (range, elevation, satellite EIRP, station G/T). Also the terrestrial
// mesh between stations. No DOM, transport or storage; representative RF values, not measurements.
import { lookAnglesAt } from '/static/simulation/orbit.js';
import { BAND_FREQUENCY_GHZ, figureOfMeritDbK, surfaceDistanceKm } from '/static/model_library/ground_stations.js';
import { equipmentActive, equipmentSpec } from '/static/model_library/satellite_nodes.js';

// Satellite transmit antenna gain per band (dBi). The equipment catalogue carries power and data
// rate; the antenna is a representative body-mounted or small steerable antenna.
export const SATELLITE_TX_GAIN_DBI = Object.freeze({ S: 3, X: 15, Ka: 20 });
export const TERRESTRIAL_RATE_MBPS = 10_000;
const BAND_PRIORITY = ['Ka', 'X', 'S'];

// Active RF equipment on a node keyed by band, keeping the highest data rate per band.
export function radioLinksOf(node) {
  const radios = new Map();
  for (const item of node?.equipment || []) {
    const spec = equipmentSpec(item);
    if (!spec || spec.kind !== 'rf' || !equipmentActive(node, item)) continue;
    const band = String(spec.band || '').trim();
    if (!band) continue;
    const current = radios.get(band);
    if (!current || Number(spec.data_rate_mbps) > Number(current.data_rate_mbps)) radios.set(band, spec);
  }
  return radios;
}

export function eirpDbw(spec, band) {
  const power = Number(spec?.power_w);
  const gain = SATELLITE_TX_GAIN_DBI[band];
  if (!(power > 0) || gain === undefined) return null;
  return 10 * Math.log10(power) + gain;
}

// The best band both the satellite and the station support, highest data rate first.
export function chooseBand(radios, station) {
  const supported = new Set(station?.bands || []);
  for (const band of BAND_PRIORITY) if (supported.has(band) && radios.has(band)) return band;
  return null;
}

export function pairId(a, b) {
  return [String(a), String(b)].sort().join('|');
}

// One ground link record per (station, satellite) pair whose geometry is known, visible or not.
// position: the satellite's { latitude, longitude, altitude } at the analysis time.
export function groundLink(station, node, position) {
  if (!station || !node || !position) return null;
  const angles = lookAnglesAt(position, station);
  if (!angles) return null;
  const radios = radioLinksOf(node);
  const band = chooseBand(radios, station);
  const spec = band ? radios.get(band) : null;
  const visible = angles.elevation >= Number(station.min_elevation_deg || 0);
  return {
    id: pairId(station.id, node.id),
    a: station.id,
    b: node.id,
    kind: 'ground',
    state: !band ? 'no_radio' : visible ? 'visible' : 'below_mask',
    band,
    elevation_deg: Math.round(angles.elevation * 100) / 100,
    azimuth_deg: Math.round(angles.azimuth * 100) / 100,
    range_km: Math.round(angles.rangeKm * 10) / 10,
    min_elevation_deg: Number(station.min_elevation_deg || 0),
    data_rate_mbps: spec ? Number(spec.data_rate_mbps) || 0 : 0,
    frequency_ghz: band ? BAND_FREQUENCY_GHZ[band] : null,
    eirp_dbw: spec ? eirpDbw(spec, band) : null,
    gt_dbk: band ? figureOfMeritDbK(station.dish_m, band) : null,
  };
}

// Every station pair joined by the ground network.
export function terrestrialLinks(stations) {
  const links = [];
  for (let i = 0; i < stations.length; i += 1) {
    for (let j = i + 1; j < stations.length; j += 1) {
      const a = stations[i]; const b = stations[j];
      links.push({ id: pairId(a.id, b.id), a: a.id, b: b.id, kind: 'terrestrial', state: 'connected',
        distance_km: Math.round(surfaceDistanceKm(a, b) * 10) / 10, data_rate_mbps: TERRESTRIAL_RATE_MBPS });
    }
  }
  return links;
}
