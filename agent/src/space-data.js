// Extra hireable space-data services (all public, keyless or DEMO-key sources):
//   satellite_pass  any NORAD id / named object / CelesTrak group, SGP4 passes + visibility
//   aurora          NOAA SWPC OVATION aurora nowcast + 3-day Kp forecast alert with threshold
//   reentry         CelesTrak decaying objects (lowest perigee, rough decay estimate)
//   asteroids       NASA/JPL SBDB Close-Approach Data (CAD) API
//   launches        Launch Library 2 (The Space Devs, dev endpoint)
//   starlink_train  recently launched Starlink groups (CelesTrak last-30-days) + visible passes
//   conjunctions    CelesTrak SOCRATES Plus top conjunctions
// Every number in a report comes from these sources or from deterministic math in the agent.
import { TransientAgentError } from "./retry-policy.js";
import { CHILE_TIME_ZONE, formatChileTime, resolveIssLocation, UnsupportedLocationError } from "./iss-location.js";
import {
  altitudesKm,
  compass,
  findPasses,
  lookNow,
  MIN_ELEVATION_DEG,
  observerGd,
  satrecFromOmm,
  timeGrid,
  toDegrees,
} from "./sky-math.js";

export const CELESTRAK_GP = "https://celestrak.org/NORAD/elements/gp.php";
export const NOAA_OVATION_URL = "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json";
export const NOAA_KP_FORECAST_URL = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json";
export const JPL_CAD_URL = "https://ssd-api.jpl.nasa.gov/cad.api";
export const LL2_URL = "https://lldev.thespacedevs.com/2.3.0/launches/upcoming/";
export const SOCRATES_MIN_RANGE_CSV = "https://celestrak.org/SOCRATES/sort-minRange.csv";
export const SOCRATES_MAX_PROB_CSV = "https://celestrak.org/SOCRATES/sort-maxProb.csv";

const LUNAR_DISTANCE_KM = 384400;
const AU_KM = 149597870.7;

// ---------------------------------------------------------------- formatting
const chileTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: CHILE_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const chileDay = new Intl.DateTimeFormat("en-GB", { timeZone: CHILE_TIME_ZONE, weekday: "short", day: "2-digit", month: "short" });
export function chileShort(ms) {
  return `${chileDay.format(new Date(ms))} ${chileTime.format(new Date(ms))}`;
}
export function utcShort(ms) {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
const round = (x, d = 0) => Number(Number(x).toFixed(d));

// ---------------------------------------------------------------- observer
const COORDINATES = /(-?\d{1,2}(?:\.\d+))\s*[,;]?\s*(-?\d{1,3}(?:\.\d+))/u;

/** Explicit "lat, lon" decimal coordinates in the query (both need a decimal point). */
export function parseCoordinates(query) {
  const match = COORDINATES.exec(String(query));
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { name: `${latitude.toFixed(3)}, ${longitude.toFixed(3)}`, latitude, longitude, height: 0 };
}

/** Observer for location-based services: explicit coordinates, else the Chilean city table (Osorno default). */
export function resolveObserver(aiCity, query) {
  const coords = parseCoordinates(query);
  if (coords) return { location: coords, defaulted: false };
  let result = null;
  if (aiCity) {
    const fromAi = resolveIssLocation(aiCity);
    if (fromAi.city && !fromAi.defaulted) result = fromAi;
  }
  if (!result) {
    const fromQuery = resolveIssLocation(query);
    if (fromQuery.city && !fromQuery.defaulted) result = fromQuery;
    else result = aiCity ? { unknownPlace: aiCity } : fromQuery;
  }
  if (result.unknownPlace) throw new UnsupportedLocationError(result.unknownPlace);
  return { location: { ...result.city, name: `${result.city.name}, Chile` }, defaulted: Boolean(result.defaulted) };
}

// ---------------------------------------------------------------- satellite targets
export const NAMED_SATELLITES = Object.freeze([
  { pattern: /\biss\b|estaci[oó]n espacial internacional|international space station|zarya/iu, norad: 25544, name: "ISS" },
  { pattern: /hubble|\bhst\b/iu, norad: 20580, name: "Hubble Space Telescope" },
  { pattern: /tiangong|estaci[oó]n (?:espacial )?china|chinese space station|\bcss\b|tianhe/iu, norad: 48274, name: "Tiangong (CSS Tianhe)" },
]);

export const SATELLITE_GROUPS = Object.freeze([
  { pattern: /starlink/iu, group: "starlink", label: "Starlink" },
  { pattern: /\bgps\b|navegaci[oó]n/iu, group: "gps-ops", label: "GPS operational" },
  { pattern: /meteorol[oó]gic|weather|clima|goes|noaa sat/iu, group: "weather", label: "Weather" },
  { pattern: /estaciones|space stations|\bstations\b/iu, group: "stations", label: "Space stations" },
  { pattern: /todos los sat[eé]lites|all satellites|activos|active satellites|\bactive\b|cu[aá]ntos sat[eé]lites/iu, group: "active", label: "All active satellites" },
  { pattern: /brillantes|bright|visual|simple vista|naked eye|puedo ver|visibles?/iu, group: "visual", label: "Brightest (visual)" },
]);
// Groups above this size get an "overhead right now" snapshot instead of a 24 h pass search.
export const MAX_GROUP_FOR_PASSES = 400;

export function parseSatelliteTarget(query) {
  const text = String(query);
  const norad = /(?:norad|catnr|cat(?:a|á)logo|n[uú]mero)\s*(?:id|n[º°o.]*|#|:)?\s*(\d{1,6})\b/iu.exec(text) ||
    /\b(?:sat[eé]lite|satellite)\s+(\d{3,6})\b/iu.exec(text);
  if (norad) return { kind: "norad", norad: Number(norad[1]) };
  for (const sat of NAMED_SATELLITES) if (sat.pattern.test(text)) return { kind: "norad", norad: sat.norad, name: sat.name };
  for (const g of SATELLITE_GROUPS) if (g.pattern.test(text)) return { kind: "group", group: g.group, label: g.label };
  return { kind: "group", group: "visual", label: "Brightest (visual)", defaulted: true };
}

function ommArray(data, what) {
  if (!Array.isArray(data) || data.length === 0) {
    throw new TransientAgentError(`CelesTrak returned no orbital elements for ${what}`);
  }
  return data;
}

// Above ~2,000 km a sunlit satellite is far too faint for the naked eye (GPS ~ mag 11).
export const NAKED_EYE_MAX_PERIGEE_KM = 2000;

function passFacts(pass, objectName, { lowOrbit = true } = {}) {
  const visible = pass.visible && lowOrbit;
  return {
    object: objectName,
    rise_chile: chileShort(pass.rise),
    peak_chile: chileShort(pass.peak),
    set_chile: chileShort(pass.set),
    rise_utc: utcShort(pass.rise),
    max_elevation_degrees: round(toDegrees(pass.maxElevation)),
    rise_direction: compass(pass.riseAzimuth),
    peak_direction: compass(pass.peakAzimuth),
    set_direction: compass(pass.setAzimuth),
    naked_eye_visible: visible,
    sunlit_in_dark_sky_but_too_faint: pass.visible && !lowOrbit,
    visible_from_chile: visible ? chileShort(pass.visibleStart) : null,
    visible_to_chile: visible ? chileShort(pass.visibleEnd) : null,
  };
}

function passLine(p) {
  const vis = p.naked_eye_visible
    ? `VISIBLE ${p.visible_from_chile.slice(-5)}-${p.visible_to_chile.slice(-5)}`
    : p.sunlit_in_dark_sky_but_too_faint
      ? "sunlit but too faint for the naked eye (high orbit; binoculars/telescope)"
      : "not visible (daylight or Earth shadow)";
  return `${p.object}: ${p.rise_chile}-${p.set_chile.slice(-5)} Chile time (${p.rise_utc}), max ${p.max_elevation_degrees} deg ${p.peak_direction}, ${p.rise_direction}->${p.set_direction}, ${vis}`;
}

export async function satellitePassData(fetchJson, { query, aiCity = null, now = Date.now() }) {
  const { location, defaulted } = resolveObserver(aiCity, query);
  const observer = observerGd(location);
  const target = parseSatelliteTarget(query);
  const where = `${location.name}${defaulted ? " (default location)" : ""}`;
  const baseFacts = {
    topic: "satellite_pass",
    source: "CelesTrak GP orbital elements, SGP4 computed by the agent; visibility = satellite sunlit while the Sun is below -6 deg at the observer",
    location: location.name,
    default_location_used: defaulted,
    observer_latitude: location.latitude.toFixed(3),
    observer_longitude: location.longitude.toFixed(3),
    minimum_elevation_degrees: MIN_ELEVATION_DEG,
  };

  if (target.kind === "norad") {
    const omm = ommArray(await fetchJson(`${CELESTRAK_GP}?CATNR=${target.norad}&FORMAT=JSON`), `NORAD ${target.norad}`)[0];
    const name = target.name ? `${target.name} (NORAD ${target.norad})` : `${omm.OBJECT_NAME} (NORAD ${target.norad})`;
    let satrec;
    try {
      satrec = satrecFromOmm(omm);
    } catch (error) {
      throw new TransientAgentError(`CelesTrak returned invalid elements for NORAD ${target.norad}`, { cause: error });
    }
    const grid = timeGrid(observer, now, 72, 30);
    const passes = findPasses(satrec, observer, grid, { maxPasses: 40 });
    const nextPasses = passes.slice(0, 3).map((p) => passFacts(p, name, { lowOrbit: altitudesKm(omm).perigee < NAKED_EYE_MAX_PERIGEE_KM }));
    let visibleRaw = passes.filter((p) => p.visible);
    let visibleWindowHours = 72;
    if (visibleRaw.length < 3 && !(passes.length === 1 && passes[0].startsAtWindow)) {
      // Visible passes cluster in a few days of each month: look up to 7 days ahead.
      visibleWindowHours = 168;
      visibleRaw = findPasses(satrec, observer, timeGrid(observer, now, 168, 30), { maxPasses: 120 }).filter((p) => p.visible);
    }
    const alt = altitudesKm(omm);
    const lowOrbit = alt.perigee < NAKED_EYE_MAX_PERIGEE_KM;
    if (!lowOrbit) visibleRaw = [];
    const visible = visibleRaw.slice(0, 3).map((p) => passFacts(p, name));
    const facts = {
      ...baseFacts,
      object: name,
      elements_epoch_utc: String(omm.EPOCH),
      perigee_km: round(alt.perigee),
      apogee_km: round(alt.apogee),
      search_window_hours: 72,
      visible_search_window_hours: visibleWindowHours,
      next_passes: nextPasses,
      next_visible_passes: visible,
    };
    if (passes.length === 1 && passes[0].startsAtWindow && passes[0].endsAfterWindow) {
      facts.always_above_horizon = true;
    }
    let template = `${name} over ${where} (next 72 h, min elevation ${MIN_ELEVATION_DEG} deg). `;
    if (facts.always_above_horizon) {
      template += `The object stays above the horizon the whole window (geostationary/high orbit), max ${nextPasses[0].max_elevation_degrees} deg.`;
    } else if (!passes.length) {
      template += "No pass above 10 degrees in the next 72 hours.";
    } else {
      template += `Naked-eye visible passes (next ${visibleWindowHours / 24} days): ${visible.length ? visible.map(passLine).join(" | ") : "none"}. `;
      template += `All next passes: ${nextPasses.map(passLine).join(" | ")}.`;
    }
    template += ` Orbit ${facts.perigee_km}-${facts.apogee_km} km. Elements epoch ${omm.EPOCH} UTC. Approximate SGP4 prediction.`;
    return { template, facts };
  }

  const data = ommArray(await fetchJson(`${CELESTRAK_GP}?GROUP=${target.group}&FORMAT=JSON`), `group ${target.group}`);
  const sats = [];
  for (const omm of data) {
    try {
      sats.push({ omm, satrec: satrecFromOmm(omm) });
    } catch {}
  }
  if (sats.length > MAX_GROUP_FOR_PASSES) {
    const [sample] = timeGrid(observer, now, 0, 60);
    const above = [];
    for (const s of sats) {
      const look = lookNow(s.satrec, observer, sample);
      if (look && look.elevation > 0) above.push({ s, look });
    }
    above.sort((a, b) => b.look.elevation - a.look.elevation);
    const sunlitAbove = above.filter((a) => a.look.sunlit).length;
    const top = above.slice(0, 5).map(({ s, look }) => ({
      object: `${s.omm.OBJECT_NAME} (NORAD ${s.omm.NORAD_CAT_ID})`,
      elevation_degrees: round(toDegrees(look.elevation)),
      direction: compass(look.azimuth),
      range_km: round(look.rangeSat),
    }));
    const facts = {
      ...baseFacts,
      group: target.label,
      objects_in_group: sats.length,
      snapshot_chile: chileShort(now),
      snapshot_utc: utcShort(now),
      above_horizon_now: above.length,
      above_horizon_sunlit_now: sunlitAbove,
      observer_in_darkness: sample.dark,
      highest_now: top,
    };
    const template =
      `${target.label} (${sats.length} objects, CelesTrak) above ${where} right now (${facts.snapshot_chile} Chile time, ${facts.snapshot_utc}): ` +
      `${above.length} above the horizon, ${sunlitAbove} of them sunlit; observer ${sample.dark ? "in darkness" : "in daylight/twilight"}. ` +
      `Highest: ${top.map((t) => `${t.object} ${t.elevation_degrees} deg ${t.direction}, ${t.range_km} km`).join("; ")}. SGP4 snapshot, approximate.`;
    return { template, facts };
  }

  const grid = timeGrid(observer, now, 24, 30);
  const passes = [];
  for (const s of sats) {
    const lowOrbit = altitudesKm(s.omm).perigee < NAKED_EYE_MAX_PERIGEE_KM;
    for (const p of findPasses(s.satrec, observer, grid)) passes.push({ p, lowOrbit, name: `${s.omm.OBJECT_NAME} (NORAD ${s.omm.NORAD_CAT_ID})` });
  }
  const visible = passes.filter(({ p, lowOrbit }) => lowOrbit && p.visible && toDegrees(p.maxElevation) >= 25);
  visible.sort((a, b) => a.p.rise - b.p.rise);
  const shown = visible.length ? visible : passes.slice().sort((a, b) => a.p.rise - b.p.rise);
  const list = shown.slice(0, 6).map(({ p, name, lowOrbit }) => passFacts(p, name, { lowOrbit }));
  const facts = {
    ...baseFacts,
    group: target.label,
    group_defaulted: Boolean(target.defaulted),
    objects_in_group: sats.length,
    search_window_hours: 24,
    passes_found: passes.length,
    visible_passes_above_25_degrees: visible.length,
    next_visible_passes: list,
  };
  const template =
    `${target.label} satellites (${sats.length} objects) over ${where}, next 24 h: ${passes.length} passes above ${MIN_ELEVATION_DEG} deg, ` +
    `${visible.length} naked-eye visible with max elevation >= 25 deg. ${visible.length ? "Next visible" : "Next passes"}: ` +
    `${list.length ? list.map(passLine).join(" | ") : "none"}. Approximate SGP4 prediction.`;
  return { template, facts };
}

// ---------------------------------------------------------------- aurora + Kp alert
export function parseKpThreshold(query) {
  const m = /(?:kp|umbral|threshold)\s*(?:>=|≥|>|=|de|of|mayor a|sobre|over)?\s*(\d(?:\.\d)?)/iu.exec(String(query));
  const value = m ? Number(m[1]) : 5;
  return value >= 1 && value <= 9 ? value : 5;
}

export function ovationAt(coordinates, latitude, longitude) {
  const lon = ((Math.round(longitude) % 360) + 360) % 360;
  const lat = Math.round(latitude);
  const row = coordinates.find((c) => c[0] === lon && c[1] === lat);
  return row ? Number(row[2]) : null;
}

export async function auroraData(fetchJson, { query, aiCity = null, now = Date.now() }) {
  const { location, defaulted } = resolveObserver(aiCity, query);
  const threshold = parseKpThreshold(query);
  const [ovation, kpForecast] = await Promise.all([fetchJson(NOAA_OVATION_URL), fetchJson(NOAA_KP_FORECAST_URL)]);
  const coords = ovation?.coordinates;
  if (!Array.isArray(coords) || coords.length < 1000) throw new TransientAgentError("NOAA OVATION returned no aurora grid");
  const rows = Array.isArray(kpForecast) && !Array.isArray(kpForecast[0])
    ? kpForecast
    : Array.isArray(kpForecast)
      ? kpForecast.slice(1).map((r) => ({ time_tag: r[0], kp: r[1], observed: r[2], noaa_scale: r[3] }))
      : [];
  if (!rows.length) throw new TransientAgentError("NOAA returned no Kp forecast");

  const south = location.latitude < 0;
  const lon = ((Math.round(location.longitude) % 360) + 360) % 360;
  const local = ovationAt(coords, location.latitude, location.longitude);
  // Equatorward edge of the oval (>= 10 % probability) along the observer's longitude band (+-15 deg).
  let edge = null;
  let hemiMax = 0;
  for (const [cLon, cLat, value] of coords) {
    if (south ? cLat >= 0 : cLat <= 0) continue;
    hemiMax = Math.max(hemiMax, value);
    const dLon = Math.min(Math.abs(cLon - lon), 360 - Math.abs(cLon - lon));
    if (dLon <= 15 && value >= 10 && (edge === null || Math.abs(cLat) < Math.abs(edge))) edge = cLat;
  }
  const upcoming = rows
    .map((r) => ({ t: Date.parse(`${r.time_tag}Z`), kp: Number(r.kp), observed: r.observed, scale: r.noaa_scale }))
    .filter((r) => Number.isFinite(r.t) && Number.isFinite(r.kp) && r.t + 3 * 3600_000 > now);
  const predicted = upcoming.filter((r) => r.observed !== "observed");
  const maxKp = predicted.reduce((m, r) => (r.kp > m.kp ? r : m), predicted[0] || { kp: NaN });
  const alerts = upcoming.filter((r) => r.kp >= threshold);
  // Rule of thumb (NOAA "view line"): aurora can be seen low on the horizon up to ~9 deg of latitude equatorward of the oval edge.
  const degreesToEdge = edge === null ? null : Math.abs(edge) - Math.abs(location.latitude);
  const horizonChance = degreesToEdge !== null && degreesToEdge <= 9;
  const facts = {
    topic: "aurora",
    source: "NOAA SWPC OVATION aurora model (30-90 min forecast) and NOAA SWPC 3-day planetary Kp forecast",
    location: location.name,
    default_location_used: defaulted,
    hemisphere: south ? "south (aurora australis)" : "north (aurora borealis)",
    ovation_forecast_time_utc: String(ovation["Forecast Time"]),
    aurora_probability_overhead_percent: local,
    max_probability_in_hemisphere_percent: hemiMax,
    oval_equatorward_edge_latitude: edge,
    degrees_of_latitude_to_oval_edge: degreesToEdge,
    possible_low_on_horizon: horizonChance,
    kp_alert_threshold: threshold,
    max_forecast_kp: Number.isFinite(maxKp?.kp) ? round(maxKp.kp, 2) : null,
    max_forecast_kp_at_utc: Number.isFinite(maxKp?.kp) ? utcShort(maxKp.t) : null,
    kp_alert: alerts.length > 0,
    kp_alert_periods: alerts.slice(0, 6).map((r) => ({ start_chile: chileShort(r.t), start_utc: utcShort(r.t), kp: round(r.kp, 2), noaa_scale: r.scale || null })),
  };
  const alertText = alerts.length
    ? `KP ALERT: Kp >= ${threshold} expected in ${alerts.length} 3-hour period(s), first ${facts.kp_alert_periods[0].start_chile} Chile time (${facts.kp_alert_periods[0].start_utc}), Kp ${facts.kp_alert_periods[0].kp}.`
    : `No Kp >= ${threshold} in the NOAA 3-day forecast (max forecast Kp ${facts.max_forecast_kp} at ${facts.max_forecast_kp_at_utc}).`;
  const template =
    `Aurora forecast for ${location.name}${defaulted ? " (default location)" : ""} (NOAA OVATION, valid ${facts.ovation_forecast_time_utc}): ` +
    `probability overhead ${local ?? "n/a"} %; strongest in the ${south ? "southern" : "northern"} oval ${hemiMax} %; ` +
    (edge === null
      ? "no oval edge >= 10 % near this longitude. "
      : `oval edge (>= 10 %) near latitude ${edge}, ${round(degreesToEdge)} deg ${south ? "south" : "north"} of you; ${horizonChance ? "aurora may be visible low on the horizon if skies are dark and clear" : "too far to see from here now"}. `) +
    alertText;
  return { template, facts };
}

// ---------------------------------------------------------------- reentry
export async function reentryData(fetchJson, { now = Date.now() } = {}) {
  const data = ommArray(await fetchJson(`${CELESTRAK_GP}?SPECIAL=DECAYING&FORMAT=JSON`), "decaying objects");
  const items = data
    .map((omm) => {
      const alt = altitudesKm(omm);
      const ndot = Number(omm.MEAN_MOTION_DOT) * 2; // rev/day^2 (OMM field is n-dot/2)
      // Crude linear estimate of days until mean motion reaches ~16.4 rev/day (~180 km), where objects reenter within hours.
      const days = ndot > 0 ? Math.max(0, (16.4 - Number(omm.MEAN_MOTION)) / ndot) : null;
      return { omm, alt, days };
    })
    .filter((x) => Number.isFinite(x.alt.perigee))
    .sort((a, b) => a.alt.perigee - b.alt.perigee);
  const top = items.slice(0, 6).map(({ omm, alt, days }) => ({
    object: `${omm.OBJECT_NAME} (NORAD ${omm.NORAD_CAT_ID}, ${omm.OBJECT_ID})`,
    perigee_km: round(alt.perigee),
    apogee_km: round(alt.apogee),
    inclination_degrees: round(omm.INCLINATION, 1),
    elements_epoch_utc: String(omm.EPOCH),
    rough_days_to_reentry: days === null ? null : round(days, 1),
    rough_reentry_date_utc: days === null ? null : new Date(now + days * 86400_000).toISOString().slice(0, 10),
  }));
  const facts = {
    topic: "reentry",
    source: "CelesTrak GP data, SPECIAL=DECAYING list; reentry date is the agent's crude linear decay estimate, not an official prediction",
    decaying_objects_tracked: items.length,
    lowest_objects: top,
  };
  const template =
    `Objects closest to reentry (CelesTrak decaying list, ${items.length} objects): ` +
    top
      .map((t) => `${t.object}: perigee ${t.perigee_km} km, inc ${t.inclination_degrees} deg${t.rough_reentry_date_utc ? `, rough estimate ~${t.rough_reentry_date_utc}` : ""}`)
      .join(" | ") +
    ". Dates are crude estimates (+- days to weeks); reentry location cannot be predicted this way. Official windows: Aerospace Corp / Space-Track TIP.";
  return { template, facts };
}

// ---------------------------------------------------------------- asteroids
export function diameterRangeM(h) {
  if (!Number.isFinite(h)) return null;
  const d = (albedo) => (1329 / Math.sqrt(albedo)) * 10 ** (-h / 5) * 1000;
  return { min: round(d(0.25)), max: round(d(0.05)) };
}

export async function asteroidData(fetchJson, { now = Date.now() } = {}) {
  const url = `${JPL_CAD_URL}?dist-max=0.05&date-min=now&date-max=%2B30&sort=date&body=Earth`;
  const data = await fetchJson(url);
  if (!data || !Array.isArray(data.fields) || !Array.isArray(data.data)) throw new TransientAgentError("JPL CAD returned no data");
  const idx = Object.fromEntries(data.fields.map((f, i) => [f, i]));
  const rows = data.data.map((r) => {
    const au = Number(r[idx.dist]);
    const t = Date.parse(`${r[idx.cd].replace(/-(\w{3})-/u, " $1 ")} UTC`);
    const h = Number(r[idx.h]);
    return {
      des: String(r[idx.des]),
      t,
      ld: au * (AU_KM / LUNAR_DISTANCE_KM),
      km: au * AU_KM,
      v: Number(r[idx.v_rel]),
      h,
      size: diameterRangeM(h),
    };
  });
  const fmt = (r) => ({
    designation: r.des,
    close_approach_chile: Number.isFinite(r.t) ? chileShort(r.t) : null,
    close_approach_utc: Number.isFinite(r.t) ? utcShort(r.t) : null,
    distance_lunar: round(r.ld, 2),
    distance_km: round(r.km),
    relative_speed_km_s: round(r.v, 1),
    estimated_diameter_m: r.size ? `${r.size.min}-${r.size.max}` : null,
  });
  const next = rows.filter((r) => !Number.isFinite(r.t) || r.t >= now - 3600_000).slice(0, 5).map(fmt);
  const closest = rows.length ? fmt(rows.reduce((a, b) => (b.ld < a.ld ? b : a))) : null;
  const facts = {
    topic: "asteroids",
    source: "NASA/JPL SBDB Close-Approach Data API (next 30 days, within 0.05 au ~ 19.5 lunar distances)",
    approaches_found: rows.length,
    next_approaches: next,
    closest_approach: closest,
    note: "diameter estimated from absolute magnitude H with albedo 0.05-0.25",
  };
  const line = (a) =>
    `${a.designation}: ${a.close_approach_chile} Chile time (${a.close_approach_utc}), ${a.distance_lunar} lunar distances (${a.distance_km} km), ${a.relative_speed_km_s} km/s, ~${a.estimated_diameter_m} m`;
  const template =
    `Near-Earth asteroid close approaches, next 30 days (NASA/JPL CAD, within 0.05 au): ${rows.length} found. ` +
    `Next: ${next.map(line).join(" | ")}. ` +
    (closest ? `Closest: ${line(closest)}. ` : "") +
    "None of these is an impact prediction.";
  return { template, facts };
}

// ---------------------------------------------------------------- launches
export async function launchData(fetchJson, { now = Date.now() } = {}) {
  const since = new Date(now - 3600_000).toISOString().slice(0, 19) + "Z";
  const data = await fetchJson(`${LL2_URL}?limit=6&mode=detailed&net__gte=${encodeURIComponent(since)}&ordering=net`);
  const results = data?.results;
  if (!Array.isArray(results)) throw new TransientAgentError("Launch Library 2 returned no launches");
  const list = results.slice(0, 5).map((l) => {
    const t = Date.parse(l.net);
    const video = (l.vid_urls || []).map((v) => v?.url).find((u) => typeof u === "string" && /^https:\/\//u.test(u)) || null;
    return {
      name: String(l.name),
      provider: String(l.launch_service_provider?.name || "unknown"),
      pad: `${l.pad?.name || "?"}, ${l.pad?.location?.name || "?"}`,
      net_chile: Number.isFinite(t) ? chileShort(t) : null,
      net_utc: Number.isFinite(t) ? utcShort(t) : null,
      status: String(l.status?.abbrev || l.status?.name || "?"),
      probability_percent: Number.isFinite(l.probability) ? l.probability : null,
      webcast: video,
    };
  });
  const facts = {
    topic: "launches",
    source: "Launch Library 2 by The Space Devs (lldev.thespacedevs.com; the dev endpoint may lag the live feed)",
    upcoming_launches: list,
  };
  const template =
    `Next rocket launches (Launch Library 2): ` +
    list
      .map((l) => `${l.name} [${l.provider}] ${l.net_chile} Chile time (${l.net_utc}), ${l.pad}, status ${l.status}${l.webcast ? `, webcast ${l.webcast}` : ""}`)
      .join(" | ") +
    ". Launch times often slip; check the provider before watching.";
  return { template, facts };
}

// ---------------------------------------------------------------- Starlink trains
export async function starlinkTrainData(fetchJson, { query, aiCity = null, now = Date.now() }) {
  const { location, defaulted } = resolveObserver(aiCity, query);
  const observer = observerGd(location);
  const data = ommArray(await fetchJson(`${CELESTRAK_GP}?GROUP=last-30-days&FORMAT=JSON`), "last-30-days");
  const groups = new Map();
  for (const omm of data) {
    if (!/^STARLINK/iu.test(String(omm.OBJECT_NAME))) continue;
    const launch = String(omm.OBJECT_ID).slice(0, 8);
    if (!groups.has(launch)) groups.set(launch, []);
    groups.get(launch).push(omm);
  }
  // Newest launches first (international designator YYYY-NNN).
  const launches = [...groups.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 3);
  const grid = timeGrid(observer, now, 72, 30);
  const trains = launches.map(([launch, members]) => {
    const alts = members.map((m) => altitudesKm(m).perigee).sort((a, b) => a - b);
    const lead = members.slice().sort((a, b) => altitudesKm(a).perigee - altitudesKm(b).perigee)[Math.floor(members.length / 2)];
    let visible = [];
    try {
      visible = findPasses(satrecFromOmm(lead), observer, grid, { maxPasses: 40 }).filter((p) => p.visible).slice(0, 3);
    } catch {}
    return {
      launch,
      satellites: members.length,
      median_perigee_km: round(alts[Math.floor(alts.length / 2)]),
      representative: `${lead.OBJECT_NAME} (NORAD ${lead.NORAD_CAT_ID})`,
      visible_passes: visible.map((p) => passFacts(p, `Starlink ${launch} train`)),
    };
  });
  const facts = {
    topic: "starlink_train",
    source: "CelesTrak last-30-days GP data (Starlink launches), SGP4 passes for a mid-train satellite; trains are brightest while still low (< ~400 km)",
    location: location.name,
    default_location_used: defaulted,
    search_window_hours: 72,
    recent_starlink_launches: trains,
  };
  const template =
    `Recent Starlink trains over ${location.name}${defaulted ? " (default location)" : ""}, next 72 h: ` +
    (trains.length
      ? trains
          .map(
            (t) =>
              `${t.launch} (${t.satellites} sats, median perigee ${t.median_perigee_km} km${t.median_perigee_km < 400 ? ", still raising: train likely visible" : ", already spread out: faint"}): ` +
              (t.visible_passes.length ? t.visible_passes.map(passLine).join(" ; ") : "no visible pass"),
          )
          .join(" | ")
      : "no Starlink launch in the last 30 days") +
    ". Approximate SGP4 prediction for the middle of the train.";
  return { template, facts };
}

// ---------------------------------------------------------------- SOCRATES conjunctions
export function parseSocratesCsv(text, max = 5) {
  const lines = String(text).split(/\r?\n/u);
  const header = lines[0]?.split(",") ?? [];
  if (header[0] !== "NORAD_CAT_ID_1") throw new TransientAgentError("SOCRATES returned an unexpected format");
  const out = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    if (cols.length !== header.length || !cols[10]) continue; // skip the truncated last line of a range request
    const row = Object.fromEntries(header.map((h, i) => [h, cols[i].trim()]));
    out.push(row);
    if (out.length >= max) break;
  }
  return out;
}

export async function conjunctionData(fetchText) {
  // SOCRATES CSVs are ~18 MB; a byte range returns just the top rows.
  const [byRange, byProb] = await Promise.all([
    fetchText(SOCRATES_MIN_RANGE_CSV, { range: "bytes=0-2047" }),
    fetchText(SOCRATES_MAX_PROB_CSV, { range: "bytes=0-2047" }),
  ]);
  const fmt = (r) => {
    const t = Date.parse(`${r.TCA.replace(" ", "T")}Z`);
    return {
      objects: `${r.OBJECT_NAME_1} (NORAD ${r.NORAD_CAT_ID_1}) vs ${r.OBJECT_NAME_2} (NORAD ${r.NORAD_CAT_ID_2})`,
      closest_approach_chile: Number.isFinite(t) ? chileShort(t) : null,
      closest_approach_utc: Number.isFinite(t) ? utcShort(t) : null,
      min_range_km: Number(r.TCA_RANGE),
      relative_speed_km_s: Number(r.TCA_RELATIVE_SPEED),
      max_probability: r.MAX_PROB,
    };
  };
  const closest = parseSocratesCsv(byRange, 4).map(fmt);
  const seen = new Set(closest.map((c) => c.objects));
  const likely = parseSocratesCsv(byProb, 8).map(fmt).filter((c) => !seen.has(c.objects)).slice(0, 3);
  const facts = {
    topic: "conjunctions",
    source: "CelesTrak SOCRATES Plus (next 7 days, active payloads vs full catalog, computed 3 times a day)",
    closest_by_min_range: closest,
    highest_max_probability: likely,
    note: "max probability is a worst-case bound, not the real collision probability; [+] marks an active payload",
  };
  const line = (c) => `${c.objects}: ${c.closest_approach_chile} Chile time (${c.closest_approach_utc}), ${c.min_range_km} km, ${c.relative_speed_km_s} km/s, max prob ${c.max_probability}`;
  const template =
    `Satellite conjunctions, next 7 days (CelesTrak SOCRATES). Closest: ${closest.map(line).join(" | ")}. ` +
    `Also high max-probability: ${likely.length ? likely.map(line).join(" | ") : "same pairs as above"}. Max probability is a worst-case bound; operators usually maneuver.`;
  return { template, facts };
}

export { formatChileTime };
