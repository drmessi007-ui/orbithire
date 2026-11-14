// Orbital helpers shared by the satellite services: SGP4 pass search (satellite.js),
// low-precision Sun position, Earth-shadow test and naked-eye visibility.
import * as satellite from "satellite.js";

export const EARTH_RADIUS_KM = 6378.137;
const AU_KM = 149597870.7;
const DEG = Math.PI / 180;
export const MIN_ELEVATION_DEG = 10;
// Observer is in darkness when the Sun is below civil twilight.
export const DARK_SUN_ELEVATION_DEG = -6;

export function toDegrees(rad) {
  return rad / DEG;
}

/** Sun position in an Earth-centred inertial frame (km). Astronomical Almanac low-precision formula (~0.01 deg). */
export function sunEci(date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) * DEG;
  const g = (357.528 + 0.9856003 * n) * DEG;
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;
  const r = (1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g)) * AU_KM;
  return {
    x: r * Math.cos(lambda),
    y: r * Math.cos(eps) * Math.sin(lambda),
    z: r * Math.sin(eps) * Math.sin(lambda),
  };
}

/** Cylindrical Earth-shadow model: true when the satellite is lit by the Sun. */
export function isSunlit(satEci, sun) {
  const sunNorm = Math.hypot(sun.x, sun.y, sun.z);
  const s = { x: sun.x / sunNorm, y: sun.y / sunNorm, z: sun.z / sunNorm };
  const dot = satEci.x * s.x + satEci.y * s.y + satEci.z * s.z;
  if (dot >= 0) return true;
  const px = satEci.x - dot * s.x;
  const py = satEci.y - dot * s.y;
  const pz = satEci.z - dot * s.z;
  return Math.hypot(px, py, pz) > EARTH_RADIUS_KM;
}

export function observerGd(location) {
  return {
    latitude: location.latitude * DEG,
    longitude: location.longitude * DEG,
    height: location.height ?? 0,
  };
}

export function sunElevationDeg(observer, date, gmst = satellite.gstime(date)) {
  const ecf = satellite.eciToEcf(sunEci(date), gmst);
  return toDegrees(satellite.ecfToLookAngles(observer, ecf).elevation);
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
export function compass(azimuthRad) {
  const deg = ((toDegrees(azimuthRad) % 360) + 360) % 360;
  return COMPASS[Math.round(deg / 45) % 8];
}

export function satrecFromOmm(omm) {
  const satrec = satellite.json2satrec(omm);
  if (!satrec || satrec.error) throw new Error("invalid orbital elements");
  return satrec;
}

/** Mean altitude (km) from OMM mean motion (rev/day) and eccentricity: perigee and apogee. */
export function altitudesKm(omm) {
  const mu = 398600.4418;
  const n = (Number(omm.MEAN_MOTION) * 2 * Math.PI) / 86400;
  const a = Math.cbrt(mu / (n * n));
  const e = Number(omm.ECCENTRICITY) || 0;
  return { perigee: a * (1 - e) - EARTH_RADIUS_KM, apogee: a * (1 + e) - EARTH_RADIUS_KM };
}

/** Precompute time samples shared by many satellites (GMST, Sun ECI and Sun elevation). */
export function timeGrid(observer, start, hours, stepSeconds) {
  const grid = [];
  const end = start + hours * 3600_000;
  for (let t = start; t <= end; t += stepSeconds * 1000) {
    const date = new Date(t);
    const gmst = satellite.gstime(date);
    const sun = sunEci(date);
    const sunEl = toDegrees(satellite.ecfToLookAngles(observer, satellite.eciToEcf(sun, gmst)).elevation);
    grid.push({ t, date, gmst, sun, dark: sunEl <= DARK_SUN_ELEVATION_DEG });
  }
  return grid;
}

/**
 * Find passes above minElevation for one satellite over a precomputed time grid.
 * A pass is visible when, at some sample above minElevation, the satellite is sunlit
 * and the observer is in darkness (Sun below -6 degrees).
 */
export function findPasses(satrec, observer, grid, { minElevationDeg = MIN_ELEVATION_DEG, maxPasses = 20 } = {}) {
  const minEl = minElevationDeg * DEG;
  const passes = [];
  let active = null;
  for (const sample of grid) {
    const pv = satellite.propagate(satrec, sample.date);
    if (!pv?.position || typeof pv.position === "boolean") {
      active = null;
      continue;
    }
    const look = satellite.ecfToLookAngles(observer, satellite.eciToEcf(pv.position, sample.gmst));
    if (look.elevation >= minEl) {
      const lit = isSunlit(pv.position, sample.sun);
      const visibleNow = lit && sample.dark;
      if (!active) {
        active = {
          rise: sample.t,
          riseAzimuth: look.azimuth,
          peak: sample.t,
          maxElevation: look.elevation,
          peakAzimuth: look.azimuth,
          visible: false,
          visibleStart: null,
          visibleEnd: null,
          rangeAtPeakKm: look.rangeSat,
          startsAtWindow: sample === grid[0],
        };
      }
      if (look.elevation > active.maxElevation) {
        active.maxElevation = look.elevation;
        active.peak = sample.t;
        active.peakAzimuth = look.azimuth;
        active.rangeAtPeakKm = look.rangeSat;
      }
      if (visibleNow) {
        active.visible = true;
        active.visibleStart ??= sample.t;
        active.visibleEnd = sample.t;
      }
      active.set = sample.t;
      active.setAzimuth = look.azimuth;
    } else if (active) {
      passes.push(active);
      active = null;
      if (passes.length >= maxPasses) break;
    }
  }
  if (active) passes.push({ ...active, endsAfterWindow: true });
  return passes;
}

/** Instantaneous look angles (for "what is above me right now"). */
export function lookNow(satrec, observer, sample) {
  const pv = satellite.propagate(satrec, sample.date);
  if (!pv?.position || typeof pv.position === "boolean") return null;
  const look = satellite.ecfToLookAngles(observer, satellite.eciToEcf(pv.position, sample.gmst));
  return { ...look, sunlit: isSunlit(pv.position, sample.sun) };
}
