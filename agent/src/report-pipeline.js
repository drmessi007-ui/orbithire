// Report pipeline: classify -> fetch real data -> (optional) AI prose -> deterministic footer.
// Data always comes from NOAA SWPC / CelesTrak; the LLM never produces numbers on its own.
import * as satellite from "satellite.js";
import { TransientAgentError } from "./retry-policy.js";
import {
  formatIssPassReport,
  issPassFacts,
  resolveIssLocation,
  supportedCityNames,
  UnsupportedLocationError,
} from "./iss-location.js";
import { classifyQuery, writeAiReport } from "./llm.js";
import {
  asteroidData,
  auroraData,
  conjunctionData,
  launchData,
  reentryData,
  satellitePassData,
  starlinkTrainData,
} from "./space-data.js";
import { parseRelativeTime, resolvePlace } from "./when-where.js";

const ISS_TARGET = Object.freeze({ kind: "norad", norad: 25544, name: "ISS" });

export const MAX_REPORT_CHARS = 3000;
export const NOAA_KP_URL = "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json";
export const CELESTRAK_ISS_URL = "https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=JSON";

export class UnsupportedQueryError extends Error {
  constructor() {
    super("Query does not match a supported space-data request");
    this.name = "UnsupportedQueryError";
    this.userMessage =
      "OrbitHire responde: paso de la ISS («¿A qué hora pasa la ISS sobre Santiago?»), pasos de cualquier " +
      "satélite por número NORAD o grupo («pasos visibles del Hubble sobre Osorno», «NORAD 48274», " +
      "«satélites brillantes esta noche», «cuántos Starlink hay sobre mí»), tormentas geomagnéticas («¿Hay " +
      "una tormenta geomagnética hoy?»), auroras y alertas Kp («pronóstico de auroras, alerta Kp 6»), " +
      "reingresos («qué satélites van a caer»), asteroides cercanos, próximos lanzamientos, trenes de " +
      "Starlink y riesgo de choque entre satélites (SOCRATES).";
  }
}

const VISIBLE_PASSES = /pasos visibles|a simple vista|pr[oó]ximos pasos|visible passes|next passes|naked eye/iu;

export function regexClassify(query) {
  if (/conjunci[oó]n|conjunciones|colisi[oó]n|choque|socrates|collision|conjunction/iu.test(query)) {
    return "conjunctions";
  }
  if (/asteroide|asteroid|neos?|near.earth object|objetos? cercanos? a la tierra|roca espacial|cometa/iu.test(query)) {
    return "asteroids";
  }
  if (/starlink/iu.test(query) && /tren|train|fila|l[ií]nea|row|reci[eé]n|recent|luces|lights|lanzad/iu.test(query)) {
    return "starlink_train";
  }
  if (/lanzamiento|launch|cohete|rocket|despegue/iu.test(query)) {
    return "launches";
  }
  if (/reingres|re-?entr|reentry|caer[aá]n?\b|va(?:n)? a caer|ca[ií]da de sat|decay|basura espacial|space debris/iu.test(query)) {
    return "reentry";
  }
  if (
    /aurora|ovation|luces del (?:sur|norte)|southern lights|northern lights|alerta kp|kp alert|umbral|threshold|pron[oó]stico (?:de(?:l)? )?kp|kp forecast|kp\s*(?:>=|≥|>)/iu.test(
      query,
    )
  ) {
    return "aurora";
  }
  if (/geomagn[eé]t|tormenta solar|tormenta geomagn|space weather|clima espacial|[ií]ndice kp|\bkp\b/iu.test(query)) {
    return "space_weather";
  }
  const namesIss = /\biss\b|estaci[oó]n espacial internacional|international space station/iu.test(query);
  if (!namesIss && /hubble|\bhst\b|tiangong|estaci[oó]n (?:espacial )?china|chinese space station|norad|catnr|starlink|sat[eé]lite|satellite/iu.test(query)) {
    return "satellite_pass";
  }
  if (
    /\biss\b|estaci[oó]n espacial(?: internacional)?|sobre osorno|international space station|space station/iu.test(query) &&
    !/tiangong|china|chinese/iu.test(query)
  ) {
    return VISIBLE_PASSES.test(query) ? "satellite_pass" : "iss_pass";
  }
  if (
    /sat[eé]lite|satellite|norad|catnr|hubble|\bhst\b|tiangong|estaci[oó]n (?:espacial )?china|starlink|\bgps\b|meteorol[oó]gic|simple vista|naked eye/iu.test(
      query,
    )
  ) {
    return "satellite_pass";
  }
  return "unsupported";
}

/** Fetch real data for an intent. Each intent is one hireable request type. */
export async function dataForIntent(intent, { query, aiCity, fetchJson, fetchText, now }) {
  switch (intent) {
    case "space_weather":
      return geomagneticData(fetchJson);
    case "iss_pass": {
      // Unknown places, regions ("sobre Chile") and other times go through the general
      // satellite service (Osorno fallback with a note) instead of failing.
      const location = resolveLocation(aiCity, query);
      const place = resolvePlace(aiCity, query);
      if (location.unknownPlace || place.region || parseRelativeTime(query, now)) {
        return satellitePassData(fetchJson, { query, aiCity, now, fetchText, forceTarget: ISS_TARGET });
      }
      return issData(fetchJson, location, now);
    }
    case "satellite_pass":
      return satellitePassData(fetchJson, { query, aiCity, now, fetchText });
    case "aurora":
      return auroraData(fetchJson, { query, aiCity, now });
    case "reentry":
      return reentryData(fetchJson, { now });
    case "asteroids":
      return asteroidData(fetchJson, { now });
    case "launches":
      return launchData(fetchJson, { now });
    case "starlink_train":
      return starlinkTrainData(fetchJson, { query, aiCity, now });
    case "conjunctions":
      if (!fetchText) throw new TransientAgentError("text fetcher not configured");
      return conjunctionData(fetchText);
    default:
      throw new UnsupportedQueryError();
  }
}

/** Resolve the ISS observer: AI-proposed city is only accepted through the fixed city table. */
export function resolveLocation(aiCity, query) {
  if (!aiCity) return resolveIssLocation(query);
  const fromAi = resolveIssLocation(aiCity);
  if (fromAi.city && !fromAi.defaulted) return fromAi;
  const fromQuery = resolveIssLocation(query);
  if (fromQuery.city && !fromQuery.defaulted) return fromQuery;
  return { unknownPlace: aiCity };
}

export async function geomagneticData(fetchJson) {
  const data = await fetchJson(NOAA_KP_URL);
  if (!Array.isArray(data) || data.length === 0) {
    throw new TransientAgentError("NOAA returned no planetary K-index observations");
  }
  const latest = data[data.length - 1];
  const kp = Number(latest.kp_index);
  if (!Number.isFinite(kp)) throw new TransientAgentError("NOAA returned an invalid Kp index");
  const storm = kp >= 5 ? "A geomagnetic storm level is indicated." : "No storm-level Kp is indicated.";
  return {
    template: `NOAA planetary K-index: ${kp.toFixed(1)} at ${latest.time_tag}. ${storm}`,
    facts: {
      topic: "space_weather",
      source: "NOAA SWPC planetary K-index (1-minute)",
      kp_index: kp.toFixed(1),
      observed_at_utc: String(latest.time_tag),
      storm_threshold_kp: 5,
      storm_level_indicated: kp >= 5,
    },
  };
}

export function computeIssPass(satrec, city, start = Date.now()) {
  const observer = {
    longitude: satellite.degreesToRadians(city.longitude),
    latitude: satellite.degreesToRadians(city.latitude),
    height: city.height,
  };
  const end = start + 24 * 60 * 60 * 1000;
  let activePass = null;
  for (let time = start; time <= end; time += 30_000) {
    const date = new Date(time);
    const propagated = satellite.propagate(satrec, date);
    if (!propagated?.position) continue;
    const ecf = satellite.eciToEcf(propagated.position, satellite.gstime(date));
    const elevation = satellite.ecfToLookAngles(observer, ecf).elevation;
    if (elevation >= satellite.degreesToRadians(10)) {
      if (!activePass) activePass = { rise: time, maxElevation: elevation };
      activePass.maxElevation = Math.max(activePass.maxElevation, elevation);
    } else if (activePass) {
      return { ...activePass, set: time };
    }
  }
  return activePass ? { ...activePass, set: end } : null;
}

export async function issData(fetchJson, location, now = Date.now()) {
  if (location.unknownPlace) throw new UnsupportedLocationError(location.unknownPlace);
  const { city, defaulted } = location;
  const elements = await fetchJson(CELESTRAK_ISS_URL);
  if (!Array.isArray(elements) || elements.length === 0) {
    throw new TransientAgentError("CelesTrak returned no ISS orbital elements");
  }
  let satrec;
  try {
    satrec = satellite.json2satrec(elements[0]);
  } catch (error) {
    throw new TransientAgentError("CelesTrak returned invalid ISS orbital elements", { cause: error });
  }
  const pass = computeIssPass(satrec, city, now);
  return {
    template: formatIssPassReport(city, pass, { defaulted }),
    facts: issPassFacts(city, pass, { defaulted }),
  };
}

export function composeReport(aiText, template) {
  if (!aiText) return template;
  const report = `${aiText}\n\n---\nVerified data: ${template}`;
  return report.length <= MAX_REPORT_CHARS ? report : template;
}

function reasonOf(error) {
  return error?.name === "LlmError" ? error.message : "error";
}

/**
 * Build the report for a query. Providers are tried in order (NEAR AI Cloud, then
 * OpenAI) for classification and for writing; the local regex/template pipeline is
 * the final fallback. Returns { report, meta }; meta is safe to log (no query text,
 * no prompts, no secrets).
 */
export async function buildReport(query, { fetchJson, fetchText = null, llm, nearAi = null, log = () => {}, now } = {}) {
  const providers = (llm ?? (nearAi ? [nearAi] : [])).filter((client) => client?.enabled);
  const meta = { intent: null, classifier: "regex", writer: "template", model: null, fallbacks: [] };
  const regexIntent = regexClassify(query);
  let intent = regexIntent;
  let aiCity = null;
  let language = null;
  // Providers that were unreachable in this request are not retried for writing.
  const unreachable = new Set();

  const classifyStarted = Date.now();
  for (const client of providers) {
    if (client.isAvailable && !client.isAvailable()) {
      meta.fallbacks.push({ step: "classify", provider: client.name, reason: "circuit open" });
      continue;
    }
    const started = Date.now();
    try {
      const plan = await classifyQuery(client, query);
      language = plan.language;
      // A supported regex match is never downgraded to "unsupported" by a model.
      if (plan.intent === "unsupported" && regexIntent !== "unsupported") {
        intent = regexIntent;
      } else {
        intent = plan.intent;
        aiCity = plan.city;
      }
      meta.classifier = client.name;
      meta.classify_model = client.model;
      break;
    } catch (error) {
      if (error?.kind === "unreachable") unreachable.add(client);
      meta.fallbacks.push({ step: "classify", provider: client.name, reason: reasonOf(error), ms: Date.now() - started });
    }
  }
  if (providers.length) meta.classify_ms = Date.now() - classifyStarted;
  meta.intent = intent;

  try {
    if (intent === "unsupported") throw new UnsupportedQueryError();
    const data = await dataForIntent(intent, { query, aiCity, fetchJson, fetchText, now: now ?? Date.now() });

    let aiText = null;
    const writeStarted = Date.now();
    for (const client of providers) {
      if (unreachable.has(client)) continue;
      if (client.isAvailable && !client.isAvailable()) {
        meta.fallbacks.push({ step: "write", provider: client.name, reason: "circuit open" });
        continue;
      }
      const started = Date.now();
      try {
        aiText = await writeAiReport(client, { query, language: language || "es", facts: data.facts });
        meta.writer = client.name;
        meta.model = client.model;
        break;
      } catch (error) {
        if (error?.kind === "unreachable") unreachable.add(client);
        meta.fallbacks.push({ step: "write", provider: client.name, reason: reasonOf(error), ms: Date.now() - started });
      }
    }
    if (providers.length) meta.write_ms = Date.now() - writeStarted;
    return { report: composeReport(aiText, data.template), meta };
  } finally {
    log(meta);
  }
}

export { supportedCityNames };
