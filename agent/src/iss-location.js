// Chilean cities supported for ISS pass predictions.
// Coordinates are city centres (WGS84 degrees); height in km above sea level.
export const DEFAULT_CITY_KEY = "osorno";
export const CHILE_TIME_ZONE = "America/Santiago";

export const CHILEAN_CITIES = Object.freeze([
  { key: "arica", name: "Arica", latitude: -18.4783, longitude: -70.3126, height: 0.02, aliases: [] },
  { key: "iquique", name: "Iquique", latitude: -20.2133, longitude: -70.1503, height: 0.02, aliases: [] },
  { key: "antofagasta", name: "Antofagasta", latitude: -23.6509, longitude: -70.3975, height: 0.04, aliases: [] },
  { key: "calama", name: "Calama", latitude: -22.4544, longitude: -68.9294, height: 2.26, aliases: [] },
  { key: "copiapo", name: "Copiapó", latitude: -27.3668, longitude: -70.3323, height: 0.39, aliases: [] },
  { key: "la-serena", name: "La Serena", latitude: -29.9027, longitude: -71.2519, height: 0.03, aliases: ["serena"] },
  { key: "coquimbo", name: "Coquimbo", latitude: -29.9533, longitude: -71.3436, height: 0.03, aliases: [] },
  { key: "valparaiso", name: "Valparaíso", latitude: -33.0472, longitude: -71.6127, height: 0.04, aliases: ["valpo"] },
  { key: "vina-del-mar", name: "Viña del Mar", latitude: -33.0245, longitude: -71.5518, height: 0.03, aliases: ["vina"] },
  { key: "santiago", name: "Santiago", latitude: -33.4489, longitude: -70.6693, height: 0.57, aliases: ["santiago de chile", "stgo"] },
  { key: "rancagua", name: "Rancagua", latitude: -34.1708, longitude: -70.7444, height: 0.5, aliases: [] },
  { key: "talca", name: "Talca", latitude: -35.4264, longitude: -71.6554, height: 0.1, aliases: [] },
  { key: "chillan", name: "Chillán", latitude: -36.6066, longitude: -72.1034, height: 0.12, aliases: [] },
  { key: "concepcion", name: "Concepción", latitude: -36.827, longitude: -73.0503, height: 0.01, aliases: ["conce"] },
  { key: "temuco", name: "Temuco", latitude: -38.7359, longitude: -72.5904, height: 0.11, aliases: [] },
  { key: "valdivia", name: "Valdivia", latitude: -39.8142, longitude: -73.2459, height: 0.01, aliases: [] },
  { key: "osorno", name: "Osorno", latitude: -40.574, longitude: -73.135, height: 0.04, aliases: [] },
  { key: "puerto-montt", name: "Puerto Montt", latitude: -41.4693, longitude: -72.9424, height: 0.01, aliases: ["pto montt", "pto. montt"] },
  { key: "coyhaique", name: "Coyhaique", latitude: -45.5712, longitude: -72.0685, height: 0.31, aliases: ["coihaique"] },
  { key: "punta-arenas", name: "Punta Arenas", latitude: -53.1638, longitude: -70.9171, height: 0.03, aliases: [] },
]);

export function supportedCityNames() {
  return CHILEAN_CITIES.map((city) => city.name);
}

export function normalizeText(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9.\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const CITY_PATTERNS = CHILEAN_CITIES.flatMap((city) =>
  [city.name, ...city.aliases].map((alias) => ({ city, alias: normalizeText(alias) })),
).sort((a, b) => b.alias.length - a.alias.length);

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Words that may follow "en"/"sobre"/"over"... without naming a place.
const NON_PLACE_WORDS = new Set([
  "el", "la", "los", "las", "un", "una", "unos", "unas", "mi", "mis", "tu", "tus", "su", "sus",
  "nuestro", "nuestra", "este", "esta", "estos", "estas", "ese", "esa", "aquel", "aquella",
  "que", "cuanto", "cuantos", "cuanta", "cuantas", "cual", "cuales", "donde", "cuando", "como",
  "chile", "hoy", "manana", "noche", "tarde", "cielo", "orbita", "vivo", "directo", "tiempo",
  "horas", "hora", "minutos", "utc", "punto", "general", "promedio", "total", "concreto",
  "the", "a", "an", "my", "our", "this", "that", "today", "tonight", "tomorrow", "orbit", "sky",
  "iss", "estacion", "espacial", "internacional", "international", "space", "station", "pasa",
  "pasara", "pasar", "visible", "verla", "ver", "si", "no", "y", "o", "de", "del", "favor", "encima",
  "please", "next", "proximas", "proxima", "proximo", "proximos", "cima", "arriba",
]);

// Lookahead keeps matches overlapping ("por encima de X" also tries "de X").
const PLACE_PREPOSITION =
  /(?:^|\s)(?=(?:encima de|cielo de|ciudad de|city of|sobre|en|por|para|desde|over|above|in|for|from)\s+([a-z][a-z.]*(?:\s+[a-z][a-z.]*){0,2}))/g;

function candidatePlace(words) {
  const tokens = words.split(" ");
  if (NON_PLACE_WORDS.has(tokens[0])) return null;
  // Keep up to three words but stop at the first non-place word ("puerto varas hoy").
  const kept = [];
  for (const token of tokens) {
    if (NON_PLACE_WORDS.has(token) && !["de", "del"].includes(token)) break;
    kept.push(token);
  }
  while (kept.length && ["de", "del"].includes(kept[kept.length - 1])) kept.pop();
  return kept.length ? kept.join(" ") : null;
}

/**
 * Resolve the observer location for an ISS question.
 * Returns { city, defaulted } for a supported city (Osorno when none is named),
 * or { unknownPlace } when the query names a place we do not support.
 */
export function resolveIssLocation(query) {
  const text = ` ${normalizeText(query)} `;
  let best = null;
  for (const { city, alias } of CITY_PATTERNS) {
    const match = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(alias)}(?=$|[^a-z0-9])`).exec(text);
    if (match && (!best || match.index < best.index)) best = { city, index: match.index };
  }
  if (best) return { city: best.city, defaulted: false };

  for (const match of text.matchAll(PLACE_PREPOSITION)) {
    const place = candidatePlace(match[1]);
    if (place) return { unknownPlace: place };
  }
  return { city: CHILEAN_CITIES.find((city) => city.key === DEFAULT_CITY_KEY), defaulted: true };
}

export class UnsupportedLocationError extends Error {
  constructor(place) {
    const list = supportedCityNames().join(", ");
    super(`Unsupported ISS location: ${place}`);
    this.name = "UnsupportedLocationError";
    this.place = place;
    this.userMessage =
      `No reconozco la ciudad "${place}" para calcular el paso de la ISS. ` +
      `Ciudades disponibles: ${list}.`;
  }
}

const chileDateFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: CHILE_TIME_ZONE,
  weekday: "short",
  day: "2-digit",
  month: "short",
  year: "numeric",
});
const chileTimeOnly = new Intl.DateTimeFormat("en-GB", {
  timeZone: CHILE_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const chileOffsetFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: CHILE_TIME_ZONE,
  timeZoneName: "shortOffset",
});

function chileOffset(ms) {
  const part = chileOffsetFormatter.formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName");
  return (part?.value || "GMT").replace("GMT", "UTC");
}

export function formatChileTime(ms) {
  const date = new Date(ms);
  return `${chileDateFormatter.format(date)} ${chileTimeOnly.format(date)} (${chileOffset(ms)})`;
}

function utcMinute(ms) {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

export function formatIssPassReport(city, pass, { defaulted = false } = {}) {
  const where = `${city.name}, Chile`;
  const note = defaulted ? " (no city named; default location)" : "";
  if (!pass) {
    return `CelesTrak ISS elements were updated, but no pass above 10 degrees is predicted over ${where}${note} in the next 24 hours.`;
  }
  const elevation = Math.round((pass.maxElevation * 180) / Math.PI);
  return (
    `ISS pass over ${where}${note}: approximately ${chileTimeOnly.format(new Date(pass.rise))} to ` +
    `${chileTimeOnly.format(new Date(pass.set))} Chile time, ${chileDateFormatter.format(new Date(pass.rise))} ` +
    `(${CHILE_TIME_ZONE}, ${chileOffset(pass.rise)}); ` +
    `${utcMinute(pass.rise)} to ${utcMinute(pass.set).slice(11)} UTC; ` +
    `maximum elevation about ${elevation} degrees. ` +
    `Observer: ${city.latitude.toFixed(3)}, ${city.longitude.toFixed(3)}. ` +
    `Prediction uses current CelesTrak orbital elements and is approximate.`
  );
}

/** Structured, verifiable facts for an ISS pass (used by the AI writer and tests). */
export function issPassFacts(city, pass, { defaulted = false } = {}) {
  const facts = {
    topic: "iss_pass",
    source: "CelesTrak ISS orbital elements (NORAD 25544), SGP4 computation by the agent",
    location: `${city.name}, Chile`,
    default_location_used: defaulted,
    observer_latitude: city.latitude.toFixed(3),
    observer_longitude: city.longitude.toFixed(3),
    minimum_elevation_degrees: 10,
    search_window_hours: 24,
    pass: null,
  };
  if (pass) {
    facts.pass = {
      date_chile: chileDateFormatter.format(new Date(pass.rise)),
      start_chile_time: chileTimeOnly.format(new Date(pass.rise)),
      end_chile_time: chileTimeOnly.format(new Date(pass.set)),
      chile_utc_offset: chileOffset(pass.rise),
      start_utc: `${utcMinute(pass.rise)} UTC`,
      end_utc: `${utcMinute(pass.set)} UTC`,
      max_elevation_degrees: Math.round((pass.maxElevation * 180) / Math.PI),
      note: "approximate prediction",
    };
  }
  return facts;
}
