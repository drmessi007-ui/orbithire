// Observer place and time parsing for the satellite services.
//  - Places: explicit "lat, lon", the Chilean city table, country/region names
//    (Chile as an approximate polygon, a few neighbours as bounding boxes), and a
//    fallback to Osorno with a clear note for anything unknown (never a hard failure).
//  - Times: "hace 2 horas", "2 horas atrás", "en 3 horas", "dentro de 30 minutos",
//    "ayer a las 22", "mañana a las 5:30", "hoy a las 21", English "2 hours ago" /
//    "in 3 hours". Clamped to +-7 days (current orbital elements stay accurate to a few km).
import { CHILE_TIME_ZONE, CHILEAN_CITIES, DEFAULT_CITY_KEY, normalizeText, resolveIssLocation } from "./iss-location.js";

export const MAX_TIME_OFFSET_MS = 7 * 24 * 3600_000;

// Mainland Chile + Tierra del Fuego, approximate (lon, lat), ~0.5 deg accuracy along the Andes border.
export const CHILE_POLYGON = Object.freeze([
  [-69.95, -17.5], [-69.0, -18.0], [-68.4, -19.4], [-68.6, -20.5], [-68.0, -21.5], [-67.1, -22.7],
  [-67.3, -24.0], [-68.3, -25.0], [-68.5, -27.0], [-69.0, -28.5], [-69.8, -30.0], [-70.0, -32.0],
  [-69.8, -34.0], [-70.4, -36.0], [-71.0, -38.0], [-71.6, -40.0], [-71.8, -42.0], [-71.6, -44.0],
  [-71.4, -46.0], [-72.4, -48.0], [-73.3, -49.5], [-72.3, -50.6], [-71.9, -51.9], [-69.0, -52.2],
  [-68.6, -52.6], [-68.6, -55.0], [-67.0, -55.9], [-68.5, -56.1], [-71.5, -55.0], [-74.5, -52.5],
  [-75.7, -50.0], [-75.7, -47.0], [-74.5, -44.0], [-74.3, -42.0], [-73.8, -40.0], [-73.7, -37.5],
  [-72.6, -35.0], [-71.8, -33.0], [-71.6, -30.0], [-71.0, -27.0], [-70.6, -24.0], [-70.2, -21.0],
  [-70.4, -18.4],
]);

const box = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n]];
export const REGIONS = Object.freeze([
  { key: "chile", name: "Chile", aliases: ["chile", "territorio chileno", "cielo chileno"], polygon: CHILE_POLYGON, shape: "approximate country outline" },
  { key: "argentina", name: "Argentina", aliases: ["argentina"], polygon: box(-73.6, -55.1, -53.6, -21.8), shape: "bounding box" },
  { key: "peru", name: "Perú", aliases: ["peru"], polygon: box(-81.4, -18.4, -68.7, -0.04), shape: "bounding box" },
  { key: "bolivia", name: "Bolivia", aliases: ["bolivia"], polygon: box(-69.7, -22.9, -57.5, -9.7), shape: "bounding box" },
  { key: "uruguay", name: "Uruguay", aliases: ["uruguay"], polygon: box(-58.5, -35.0, -53.1, -30.1), shape: "bounding box" },
  { key: "sudamerica", name: "Sudamérica", aliases: ["sudamerica", "sud america", "america del sur", "south america"], polygon: box(-81.5, -56.0, -34.8, 12.5), shape: "bounding box" },
]);

export function pointInPolygon(lon, lat, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function findRegion(text) {
  const t = ` ${normalizeText(text)} `;
  return REGIONS.find((r) => r.aliases.some((a) => t.includes(` ${a} `))) || null;
}

const COORDINATES = /(-?\d{1,2}(?:\.\d+))\s*[,;]?\s*(-?\d{1,3}(?:\.\d+))/u;
export function parseCoordinates(query) {
  const match = COORDINATES.exec(String(query));
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { name: `${latitude.toFixed(3)}, ${longitude.toFixed(3)}`, latitude, longitude, height: 0 };
}

const osorno = () => {
  const city = CHILEAN_CITIES.find((c) => c.key === DEFAULT_CITY_KEY);
  return { ...city, name: `${city.name}, Chile` };
};

/**
 * Resolve where the user asks about. Never throws.
 * Returns { location, defaulted, region, note }:
 *   location: a point observer (always set; Osorno when nothing usable is named)
 *   region:   { name, polygon, shape } when a country/region is named and no city is
 *   note:     human-readable explanation when a fallback was used
 */
export function resolvePlace(aiPlace, query) {
  const coords = parseCoordinates(query);
  if (coords) return { location: coords, defaulted: false, region: null, note: null };
  const asCity = (text) => {
    const r = resolveIssLocation(text);
    return r.city && !r.defaulted ? { ...r.city, name: `${r.city.name}, Chile` } : null;
  };
  const city = (aiPlace && asCity(aiPlace)) || asCity(query);
  if (city) return { location: city, defaulted: false, region: null, note: null };
  const region = (aiPlace && findRegion(aiPlace)) || findRegion(query);
  if (region) {
    return {
      location: osorno(),
      defaulted: true,
      region,
      note: `${region.name} is a region; point predictions use Osorno, Chile`,
    };
  }
  const fromQuery = resolveIssLocation(query);
  const unknown = aiPlace || fromQuery.unknownPlace || null;
  if (unknown) {
    return { location: osorno(), defaulted: true, region: null, note: `place "${String(unknown).slice(0, 40)}" not recognised; using Osorno, Chile` };
  }
  return { location: osorno(), defaulted: true, region: null, note: null };
}

// ---------------------------------------------------------------- time
const NUMBER_WORDS = { un: 1, una: 1, uno: 1, a: 1, an: 1, one: 1, dos: 2, two: 2, tres: 3, three: 3, cuatro: 4, four: 4, cinco: 5, five: 5, seis: 6, six: 6, siete: 7, ocho: 8, diez: 10, doce: 12, media: 0.5, half: 0.5 };
const UNIT_MS = { minuto: 60_000, minutos: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000, hora: 3600_000, horas: 3600_000, hour: 3600_000, hours: 3600_000, h: 3600_000, hr: 3600_000, hrs: 3600_000, dia: 86400_000, dias: 86400_000, day: 86400_000, days: 86400_000 };
const NUM = "(\\d+(?:[.,]\\d+)?|un|una|uno|a|an|one|dos|two|tres|three|cuatro|four|cinco|five|seis|six|siete|ocho|diez|doce|media|half)";
const UNIT = "(minutos?|mins?|minutes?|horas?|hours?|hrs?|h|dias?|days?)";

function amount(token) {
  return NUMBER_WORDS[token] ?? Number(String(token).replace(",", "."));
}

const chileParts = new Intl.DateTimeFormat("en-US", {
  timeZone: CHILE_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZoneName: "shortOffset",
});
function chileDateAndOffset(ms) {
  const parts = Object.fromEntries(chileParts.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const m = /GMT([+-]\d+)?(?::(\d+))?/u.exec(parts.timeZoneName || "GMT");
  const offsetMin = m && m[1] ? Number(m[1]) * 60 + Math.sign(Number(m[1])) * Number(m[2] || 0) : 0;
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), offsetMin };
}

/** Chile wall-clock time -> UTC ms (DST-aware). */
export function chileLocalToUtc(y, m, d, hh, mm) {
  let guess = Date.UTC(y, m - 1, d, hh, mm) + 3 * 3600_000;
  for (let i = 0; i < 2; i++) guess = Date.UTC(y, m - 1, d, hh, mm) - chileDateAndOffset(guess).offsetMin * 60_000;
  return guess;
}

/**
 * Parse a relative or day-anchored time. Returns null when the query has no time
 * expression, else { at, label, clamped }.
 */
export function parseRelativeTime(query, now = Date.now()) {
  const t = String(query ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9.,:\s]/g, " ")
    .replace(/\s+/g, " ");
  let at = null;
  let label = null;
  let m;
  if ((m = new RegExp(`\\bhace\\s+${NUM}\\s+${UNIT}\\b`, "u").exec(t)) || (m = new RegExp(`\\b${NUM}\\s+${UNIT}\\s+(?:atras|antes|ago)\\b`, "u").exec(t))) {
    at = now - amount(m[1]) * UNIT_MS[m[2]];
    label = m[0].trim();
  } else if ((m = /\bhace\s+(media hora|un rato)\b/u.exec(t))) {
    at = now - 30 * 60_000;
    label = m[0].trim();
  } else if ((m = new RegExp(`\\b(?:en|dentro de|in|within)\\s+${NUM}\\s+${UNIT}\\b`, "u").exec(t))) {
    at = now + amount(m[1]) * UNIT_MS[m[2]];
    label = m[0].trim();
  } else if ((m = /\b(anteayer|antier|ayer|hoy|esta noche|manana|pasado manana|yesterday|today|tonight|tomorrow)\b(?:\s+(?:a|en)?\s*(?:las?|la|at)?\s*(\d{1,2})(?:[:,h](\d{2}))?\s*(am|pm|hrs?|horas)?)?/u.exec(t))) {
    const dayWord = m[1];
    const shift = { anteayer: -2, antier: -2, ayer: -1, yesterday: -1, hoy: 0, today: 0, "esta noche": 0, tonight: 0, manana: 1, tomorrow: 1, "pasado manana": 2 }[dayWord];
    let hh = m[2] !== undefined ? Number(m[2]) : null;
    const mm = m[3] !== undefined ? Number(m[3]) : 0;
    if (m[4] === "pm" && hh < 12) hh += 12;
    if (m[4] === "am" && hh === 12) hh = 0;
    if (hh === null) {
      if (shift === 0) return null; // "hoy" / "esta noche" alone: start from now
      at = now + shift * 86400_000; // same clock time on another day
    } else if (hh <= 23 && mm <= 59) {
      const today = chileDateAndOffset(now);
      const base = new Date(Date.UTC(today.y, today.m - 1, today.d + shift));
      at = chileLocalToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), hh, mm);
    }
    label = m[0].trim();
  }
  if (at === null || !Number.isFinite(at)) return null;
  let clamped = false;
  if (Math.abs(at - now) > MAX_TIME_OFFSET_MS) {
    at = now + Math.sign(at - now) * MAX_TIME_OFFSET_MS;
    clamped = true;
  }
  return { at, label, clamped };
}
