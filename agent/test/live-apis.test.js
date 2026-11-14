// Live checks against the real public APIs. Skipped unless ORBITHIRE_LIVE_TESTS=1
// (they need Internet and must not hammer CelesTrak: run them by hand, not in a loop).
import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { diskStore, withCache } from "../src/cached-fetch.js";
import { buildReport } from "../src/report-pipeline.js";

const live = process.env.ORBITHIRE_LIVE_TESTS === "1";
// Disk cache so repeated runs respect CelesTrak's one-download-per-2-hours rule.
const store = diskStore(path.join(tmpdir(), "orbithire-live-cache"));
const fetchJson = withCache(
  async (url) => {
    const r = await fetch(url, { headers: { "user-agent": "OrbitHire-agent/0.2 (tests)" }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`${new URL(url).hostname} HTTP ${r.status}`);
    const text = await r.text();
    if (/^GP data has not updated/u.test(text)) throw new Error("CelesTrak 2-hour rule");
    return JSON.parse(text);
  },
  { store },
);
const fetchText = withCache(
  async (url, { range } = {}) => {
    const r = await fetch(url, { headers: range ? { range } : {}, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`${new URL(url).hostname} HTTP ${r.status}`);
    return r.text();
  },
  { store },
);

const CASES = [
  ["¿Próximos pasos visibles de la ISS sobre Osorno?", "satellite_pass", /ISS \(NORAD 25544\)/u],
  ["¿Cuándo pasa el Hubble sobre -40.574, -73.133?", "satellite_pass", /Hubble Space Telescope/u],
  ["Pasos de Tiangong sobre Osorno", "satellite_pass", /NORAD 48274/u],
  ["¿Qué satélites brillantes puedo ver esta noche en Osorno?", "satellite_pass", /Brightest/u],
  ["¿Cuántos Starlink hay sobre Osorno ahora?", "satellite_pass", /above the horizon/u],
  ["Pronóstico de auroras en Punta Arenas, alerta Kp 6", "aurora", /NOAA OVATION/u],
  ["¿Qué satélites van a reingresar a la Tierra?", "reentry", /perigee/u],
  ["¿Hay asteroides que pasen cerca de la Tierra?", "asteroids", /lunar distances/u],
  ["Próximos lanzamientos de cohetes", "launches", /Chile time/u],
  ["¿Cuándo veo el tren de Starlink en Osorno?", "starlink_train", /Starlink/u],
  ["¿Hay riesgo de choque entre satélites?", "conjunctions", /SOCRATES/u],
  ["¿Hay una tormenta geomagnética hoy?", "space_weather", /K-index/u],
  ["¿Cuántos satélites activos hay sobre Osorno ahora?", "satellite_pass", /All active satellites/u],
];

for (const [query, intent, pattern] of CASES) {
  test(`live: ${intent} - ${query}`, { skip: !live && "set ORBITHIRE_LIVE_TESTS=1", timeout: 90_000 }, async () => {
    const { report, meta } = await buildReport(query, { fetchJson, fetchText, llm: [] });
    assert.equal(meta.intent, intent);
    assert.match(report, pattern);
    assert.ok(report.length <= 3000);
    if (process.env.ORBITHIRE_LIVE_PRINT === "1") console.log(`\n### ${query}\n${report}`);
  });
}
