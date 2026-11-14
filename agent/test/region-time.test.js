// The user's real failing request (80eafed5…, 14 Nov 2026): "que satelites orbitaban chile hace 2 horas atrás ?"
// plus similar Spanish phrasings: routing, country/region places, relative times.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildReport, regexClassify } from "../src/report-pipeline.js";
import { iterateTle, regionSnapshot } from "../src/space-data.js";
import { CHILE_POLYGON, chileLocalToUtc, parseRelativeTime, pointInPolygon, resolvePlace } from "../src/when-where.js";

const TLE = readFileSync(new URL("./fixtures/active-sample.tle", import.meta.url), "utf8");
const ISS_OMM = JSON.parse(readFileSync(new URL("./fixtures/iss-omm.json", import.meta.url), "utf8"));
const NOW = Date.parse("2026-11-14T03:36:00Z"); // 00:36 Chile time, when the user paid
const fetchText = async (url) => {
  assert.match(url, /GROUP=active&FORMAT=TLE/u);
  return TLE;
};
const fetchJson = async (url) => {
  if (url.includes("CATNR=")) return ISS_OMM;
  throw new Error(`unexpected ${url}`);
};

test("generic satellite questions route to satellite_pass, never to the old ISS-only type", () => {
  for (const q of [
    "que satelites orbitaban chile hace 2 horas atrás ?",
    "¿Qué satélites hay sobre Chile ahora?",
    "satélites sobre Chile en 3 horas",
    "cuantos satelites pasaron por Chile ayer a las 22",
    "¿Qué satélites estaban encima de Chile hace 30 minutos?",
  ]) {
    assert.equal(regexClassify(q), "satellite_pass", q);
  }
  assert.equal(regexClassify("¿A qué hora pasa la ISS sobre Osorno?"), "iss_pass");
});

test("Chile polygon contains Chilean cities and excludes neighbours and the ocean", () => {
  for (const [lon, lat] of [[-70.67, -33.45], [-73.13, -40.57], [-70.3, -18.48], [-70.9, -53.16], [-68.93, -22.45], [-72.07, -45.57]]) {
    assert.equal(pointInPolygon(lon, lat, CHILE_POLYGON), true, `${lat},${lon}`);
  }
  for (const [lon, lat] of [[-68.8, -32.9], [-58.4, -34.6], [-80, -35], [-77.0, -12.0], [-65.0, -45.0]]) {
    assert.equal(pointInPolygon(lon, lat, CHILE_POLYGON), false, `${lat},${lon}`);
  }
});

test("relative times in Spanish and English", () => {
  const at = (q) => new Date(parseRelativeTime(q, NOW).at).toISOString();
  assert.equal(at("que satelites orbitaban chile hace 2 horas atrás ?"), "2026-11-14T01:36:00.000Z");
  assert.equal(at("satélites sobre Chile 3 horas atrás"), "2026-11-14T00:36:00.000Z");
  assert.equal(at("hace media hora"), "2026-11-14T03:06:00.000Z");
  assert.equal(at("en 3 horas"), "2026-11-14T06:36:00.000Z");
  assert.equal(at("dentro de 30 minutos"), "2026-11-14T04:06:00.000Z");
  assert.equal(at("ayer a las 22"), "2026-11-14T01:00:00.000Z"); // 13 Nov 22:00 Chile (UTC-3)
  assert.equal(at("mañana a las 5:30"), "2026-11-15T08:30:00.000Z");
  assert.equal(at("hoy a las 21"), "2026-11-15T00:00:00.000Z");
  assert.equal(at("2 hours ago"), "2026-11-14T01:36:00.000Z");
  assert.equal(parseRelativeTime("satélites brillantes esta noche", NOW), null);
  assert.equal(parseRelativeTime("hace 30 días", NOW).clamped, true);
  assert.equal(new Date(chileLocalToUtc(2026, 7, 1, 12, 0)).toISOString(), "2026-07-01T16:00:00.000Z"); // winter UTC-4
});

test("places: country names become regions, unknown places fall back to Osorno with a note", () => {
  assert.equal(resolvePlace(null, "que satelites orbitaban chile").region.name, "Chile");
  assert.equal(resolvePlace("Argentina", "satélites sobre Argentina").region.name, "Argentina");
  const p = resolvePlace("Atlantis", "satélites sobre Atlantis");
  assert.equal(p.region, null);
  assert.equal(p.location.name, "Osorno, Chile");
  assert.match(p.note, /not recognised/u);
});

test("region snapshot streams TLEs and is consistent with the polygon", () => {
  const sats = [...iterateTle(TLE)];
  assert.ok(sats.length > 200);
  const snap = regionSnapshot({ tle: TLE }, { name: "Chile", polygon: CHILE_POLYGON }, NOW - 2 * 3600_000);
  assert.equal(snap.total, sats.length);
  assert.equal(snap.byFamily.reduce((n, f) => n + f.count, 0), snap.inside);
  const iss = snap.notable.find((n) => n.object === "ISS");
  assert.ok(iss.subpoint);
  const [lat, lon] = iss.subpoint.split(",").map(Number);
  assert.equal(iss.over_region, pointInPolygon(lon, lat, CHILE_POLYGON));
});

test("the user's exact query is answered (no ISS-location failure)", async () => {
  const query = "que satelites orbitaban chile hace 2 horas atrás ?";
  const { report, meta } = await buildReport(query, { fetchJson, fetchText, llm: [], now: NOW });
  assert.equal(meta.intent, "satellite_pass");
  assert.match(report, /over Chile at Sat 14 Nov 22:36|over Chile at Fri 13 Nov 22:36/u);
  assert.match(report, /satellites had their ground point inside Chile/u);
  assert.match(report, /ISS: (OVER|not over) Chile/u);
  assert.doesNotMatch(report, /No reconozco/u);
});

test("an AI-proposed country is accepted as the place", async () => {
  const ai = {
    name: "nearai",
    enabled: true,
    model: "m",
    isAvailable: () => true,
    calls: 0,
    async chat() {
      this.calls++;
      if (this.calls === 1) return '{"intent":"satellite_pass","city":"Chile","language":"es"}';
      throw new Error("no writer");
    },
  };
  const { report } = await buildReport("¿qué satélites estaban sobre el país hace 2 horas?", { fetchJson, fetchText, llm: [ai], now: NOW });
  assert.match(report, /inside Chile/u);
});

test("ISS questions with a region or a time use the general satellite service", async () => {
  const { report } = await buildReport("¿La ISS pasó sobre Chile hace 2 horas?", { fetchJson, fetchText, llm: [], now: NOW });
  assert.match(report, /ISS \(NORAD 25544\)/u);
  assert.match(report, /(OVER|not over) Chile \(ground point/u);
});
