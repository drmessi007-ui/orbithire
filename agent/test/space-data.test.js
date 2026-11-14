// Offline tests for the extra space-data services (deterministic fixtures, no network).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { withCache, ttlForUrl } from "../src/cached-fetch.js";
import { parseClassification } from "../src/llm.js";
import { buildReport, regexClassify } from "../src/report-pipeline.js";
import { findPasses, isSunlit, observerGd, satrecFromOmm, sunEci, sunElevationDeg, timeGrid } from "../src/sky-math.js";
import {
  asteroidData,
  auroraData,
  conjunctionData,
  diameterRangeM,
  launchData,
  parseCoordinates,
  parseKpThreshold,
  parseSatelliteTarget,
  parseSocratesCsv,
  reentryData,
  resolveObserver,
  satellitePassData,
  starlinkTrainData,
} from "../src/space-data.js";

const ISS_OMM = JSON.parse(readFileSync(new URL("./fixtures/iss-omm.json", import.meta.url), "utf8"));
const EPOCH = Date.parse(`${ISS_OMM[0].EPOCH}Z`);
const OSORNO = { latitude: -40.574, longitude: -73.135, height: 0.04 };

// Reference values from Skyfield 1.x (find_events, DE421 Sun, 10 deg mask) for the same OMM.
const SKYFIELD_FIRST_PEAK = Date.parse("2026-11-13T10:36:09Z");
const SKYFIELD_VISIBLE_PEAKS = ["2026-11-16T08:13:12Z", "2026-11-18T08:13:56Z", "2026-11-19T07:26:13Z"].map(Date.parse);

test("regex router maps every new request type", () => {
  const cases = {
    "¿Cuándo pasa la ISS sobre Osorno?": "iss_pass",
    "¿Próximos pasos visibles de la ISS sobre Osorno?": "satellite_pass",
    "¿Cuándo pasa el Hubble sobre Osorno?": "satellite_pass",
    "Pasos de NORAD 48274 sobre Temuco": "satellite_pass",
    "¿Cuántos Starlink hay sobre mí?": "satellite_pass",
    "¿Qué satélites brillantes puedo ver esta noche?": "satellite_pass",
    "¿Hay una tormenta geomagnética hoy?": "space_weather",
    "Pronóstico de auroras en Punta Arenas, alerta Kp 6": "aurora",
    "¿Qué satélites van a caer a la Tierra?": "reentry",
    "reingreso de basura espacial": "reentry",
    "¿Hay asteroides cerca de la Tierra este mes?": "asteroids",
    "Próximos lanzamientos de cohetes": "launches",
    "¿Cuándo veo el tren de Starlink en Osorno?": "starlink_train",
    "¿Hay riesgo de choque entre satélites?": "conjunctions",
    "tamaño de la luna": "unsupported",
  };
  for (const [query, intent] of Object.entries(cases)) assert.equal(regexClassify(query), intent, query);
});

test("LLM classification accepts the new intents and keeps the city only for location intents", () => {
  assert.deepEqual(parseClassification('{"intent":"satellite_pass","city":"Osorno","language":"es"}'), {
    intent: "satellite_pass",
    city: "Osorno",
    language: "es",
  });
  assert.equal(parseClassification('{"intent":"launches","city":"Osorno","language":"es"}').city, null);
  assert.throws(() => parseClassification('{"intent":"pay_agent","city":null,"language":"es"}'));
});

test("satellite targets: NORAD ids, named objects and CelesTrak groups", () => {
  assert.deepEqual(parseSatelliteTarget("NORAD 33591 sobre Santiago"), { kind: "norad", norad: 33591 });
  assert.equal(parseSatelliteTarget("cuando pasa el hubble").norad, 20580);
  assert.equal(parseSatelliteTarget("estación china Tiangong").norad, 48274);
  assert.equal(parseSatelliteTarget("satélites GPS").group, "gps-ops");
  assert.equal(parseSatelliteTarget("cuántos satélites activos").group, "active");
  assert.equal(parseSatelliteTarget("satélites meteorológicos").group, "weather");
  assert.equal(parseSatelliteTarget("algo raro en el cielo").group, "visual");
});

test("observer: explicit coordinates, Chilean cities, default Osorno, unknown place rejected", () => {
  assert.deepEqual(parseCoordinates("pasos sobre -40.574, -73.133"), { name: "-40.574, -73.133", latitude: -40.574, longitude: -73.133, height: 0 });
  assert.equal(parseCoordinates("NORAD 25544"), null);
  assert.equal(resolveObserver(null, "Hubble sobre Valdivia").location.name, "Valdivia, Chile");
  assert.equal(resolveObserver(null, "¿Cuántos Starlink hay sobre mí?").defaulted, true);
  assert.throws(() => resolveObserver(null, "Hubble sobre Madrid"), { name: "UnsupportedLocationError" });
});

test("Sun model: noon is bright, midnight is dark, ISS shadow test is consistent", () => {
  const obs = observerGd(OSORNO);
  // 16:00 UTC ~ local solar noon at -73 deg; 04:00 UTC ~ local midnight.
  assert.ok(sunElevationDeg(obs, new Date("2026-12-21T16:50:00Z")) > 60);
  assert.ok(sunElevationDeg(obs, new Date("2026-12-21T04:50:00Z")) < -10);
  const sun = sunEci(new Date());
  const n = Math.hypot(sun.x, sun.y, sun.z);
  assert.equal(isSunlit({ x: (sun.x / n) * 7000, y: (sun.y / n) * 7000, z: (sun.z / n) * 7000 }, sun), true);
  assert.equal(isSunlit({ x: (-sun.x / n) * 7000, y: (-sun.y / n) * 7000, z: (-sun.z / n) * 7000 }, sun), false);
});

test("SGP4 passes and visibility match Skyfield within one minute", () => {
  const obs = observerGd(OSORNO);
  const satrec = satrecFromOmm(ISS_OMM[0]);
  const passes = findPasses(satrec, obs, timeGrid(obs, EPOCH, 168, 30), { maxPasses: 200 });
  assert.ok(Math.abs(passes[0].peak - SKYFIELD_FIRST_PEAK) <= 60_000);
  assert.ok(Math.abs((passes[0].maxElevation * 180) / Math.PI - 55.4) < 1.5);
  const visible = passes.filter((p) => p.visible).slice(0, 3);
  assert.equal(visible.length, 3);
  visible.forEach((p, i) => assert.ok(Math.abs(p.peak - SKYFIELD_VISIBLE_PEAKS[i]) <= 60_000, `visible pass ${i}`));
});

test("satellite_pass report for one NORAD id uses CelesTrak CATNR and lists visible passes", async () => {
  const urls = [];
  const fetchJson = async (url) => {
    urls.push(url);
    return ISS_OMM;
  };
  const { template, facts } = await satellitePassData(fetchJson, { query: "pasos visibles de la ISS sobre Osorno", now: EPOCH });
  assert.match(urls[0], /CATNR=25544/u);
  assert.equal(facts.next_visible_passes.length, 3);
  assert.equal(facts.next_visible_passes[0].naked_eye_visible, true);
  assert.match(template, /VISIBLE/u);
});

test("satellite_pass for a big group returns an overhead-now snapshot", async () => {
  const many = Array.from({ length: 401 }, (_, i) => ({ ...ISS_OMM[0], NORAD_CAT_ID: 90000 + i, MEAN_ANOMALY: (i * 7) % 360 }));
  const { facts } = await satellitePassData(async () => many, { query: "cuántos starlink hay sobre mí", now: EPOCH });
  assert.equal(facts.objects_in_group, 401);
  assert.ok(Number.isInteger(facts.above_horizon_now));
});

test("aurora + Kp alert threshold", async () => {
  assert.equal(parseKpThreshold("alerta kp 6"), 6);
  assert.equal(parseKpThreshold("auroras"), 5);
  const coordinates = [];
  for (let lon = 0; lon < 360; lon++) for (let lat = -90; lat <= 90; lat++) coordinates.push([lon, lat, lat <= -55 ? 30 : 0]);
  const now = Date.parse("2026-11-14T03:00:00Z");
  const kp = [
    { time_tag: "2026-11-14T00:00:00", kp: 3, observed: "observed", noaa_scale: null },
    { time_tag: "2026-11-14T06:00:00", kp: 6.33, observed: "predicted", noaa_scale: "G2" },
  ];
  const fetchJson = async (url) => (url.includes("ovation") ? { "Forecast Time": "2026-11-14T04:00:00Z", coordinates } : kp);
  const { facts, template } = await auroraData(fetchJson, { query: "auroras en Punta Arenas alerta kp 6", now });
  assert.equal(facts.oval_equatorward_edge_latitude, -55);
  assert.equal(facts.possible_low_on_horizon, true);
  assert.equal(facts.kp_alert, true);
  assert.match(template, /KP ALERT/u);
});

test("reentry ranks decaying objects by perigee", async () => {
  const low = { ...ISS_OMM[0], OBJECT_NAME: "LOW", NORAD_CAT_ID: 1, MEAN_MOTION: 16.2, MEAN_MOTION_DOT: 0.01 };
  const { facts } = await reentryData(async () => [ISS_OMM[0], low], { now: EPOCH });
  assert.match(facts.lowest_objects[0].object, /^LOW/u);
  assert.equal(facts.lowest_objects[0].rough_days_to_reentry, 10);
});

test("asteroids parse JPL CAD rows", async () => {
  assert.deepEqual(diameterRangeM(25), { min: 27, max: 59 });
  const cad = {
    fields: ["des", "orbit_id", "jd", "cd", "dist", "dist_min", "dist_max", "v_rel", "v_inf", "t_sigma_f", "h"],
    data: [["2026 AB", "1", "0", "2026-Nov-20 10:00", "0.01", "0", "0", "12.34", "0", "0", "25"]],
  };
  const { facts } = await asteroidData(async () => cad, { now: Date.parse("2026-11-14T00:00:00Z") });
  assert.equal(facts.next_approaches[0].distance_lunar, 3.89);
  assert.equal(facts.next_approaches[0].close_approach_utc, "2026-11-20 10:00 UTC");
});

test("launches parse Launch Library 2", async () => {
  const ll2 = {
    results: [
      {
        name: "Falcon 9 | Test",
        net: "2026-11-18T03:14:00Z",
        status: { abbrev: "Go" },
        launch_service_provider: { name: "SpaceX" },
        pad: { name: "SLC-4E", location: { name: "Vandenberg" } },
        vid_urls: [{ url: "https://example.com/live" }],
      },
    ],
  };
  const { facts, template } = await launchData(async () => ll2, { now: Date.parse("2026-11-14T00:00:00Z") });
  assert.equal(facts.upcoming_launches[0].net_chile, "Wed 18 Nov 00:14");
  assert.match(template, /SpaceX/u);
});

test("Starlink trains group recent launches by designator", async () => {
  const sats = [1, 2, 3].map((i) => ({ ...ISS_OMM[0], OBJECT_NAME: `STARLINK-${i}`, OBJECT_ID: `2026-246${"ABC"[i - 1]}`, NORAD_CAT_ID: i }));
  const { facts } = await starlinkTrainData(async () => sats, { query: "tren de starlink en osorno", now: EPOCH });
  assert.equal(facts.recent_starlink_launches[0].launch, "2026-246");
  assert.equal(facts.recent_starlink_launches[0].satellites, 3);
});

const CSV =
  "NORAD_CAT_ID_1,OBJECT_NAME_1,DSE_1,NORAD_CAT_ID_2,OBJECT_NAME_2,DSE_2,TCA,TCA_RANGE,TCA_RELATIVE_SPEED,MAX_PROB,DILUTION\n" +
  "1,SAT A [+],2,2,DEB B [-],3,2026-11-15 14:51:56.196,0.007,2.143,1.000E+00,0.000\n" +
  "3,SAT C [+],2,4,SAT D [+],3,2026-11-16 09:19:04.600,0.012,12.2";
test("SOCRATES CSV: header check and truncated last line skipped", async () => {
  assert.equal(parseSocratesCsv(CSV).length, 1);
  assert.throws(() => parseSocratesCsv("<html>"));
  const ranges = [];
  const { facts } = await conjunctionData(async (url, { range }) => {
    ranges.push(range);
    return CSV;
  });
  assert.deepEqual(ranges, ["bytes=0-2047", "bytes=0-2047"]);
  assert.equal(facts.closest_by_min_range[0].min_range_km, 0.007);
  assert.equal(facts.closest_by_min_range[0].closest_approach_utc, "2026-11-15 14:51 UTC");
});

test("buildReport routes a new intent end to end without an LLM", async () => {
  const { report, meta } = await buildReport("Próximos lanzamientos de cohetes", {
    fetchJson: async () => ({ results: [] }),
    llm: [],
  });
  assert.equal(meta.intent, "launches");
  assert.match(report, /Launch Library 2/u);
});

test("cache: CelesTrak cached for 2 h, NOAA for 5 min, concurrent calls share one request", async () => {
  assert.equal(ttlForUrl("https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=JSON"), 7_200_000);
  assert.equal(ttlForUrl("https://services.swpc.noaa.gov/json/ovation_aurora_latest.json"), 300_000);
  let calls = 0;
  let clock = 0;
  const cached = withCache(async () => ++calls, { now: () => clock });
  const url = "https://celestrak.org/NORAD/elements/gp.php?CATNR=1";
  assert.deepEqual(await Promise.all([cached(url), cached(url)]), [1, 1]);
  clock = 7_200_001;
  assert.equal(await cached(url), 2);
});

test("cache: serves the last copy when the source fails (e.g. CelesTrak 2-hour rule) and reads a disk store", async () => {
  let clock = 0;
  let fail = false;
  const saved = new Map();
  const store = { get: async (k) => saved.get(k) ?? null, set: async (k, v) => saved.set(k, v) };
  const fetcher = async () => {
    if (fail) throw new Error("GP data has not updated");
    return ["fresh"];
  };
  const url = "https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=JSON";
  assert.deepEqual(await withCache(fetcher, { now: () => clock, store })(url), ["fresh"]);
  // A restarted process (new cache instance) reuses the disk copy without a download.
  fail = true;
  clock = 60_000;
  assert.deepEqual(await withCache(fetcher, { now: () => clock, store })(url), ["fresh"]);
  // Past the TTL the download fails, but a copy younger than 24 h is still served.
  clock = 3 * 3_600_000;
  assert.deepEqual(await withCache(fetcher, { now: () => clock, store })(url), ["fresh"]);
  clock = 25 * 3_600_000;
  await assert.rejects(withCache(fetcher, { now: () => clock, store })(url));
});
