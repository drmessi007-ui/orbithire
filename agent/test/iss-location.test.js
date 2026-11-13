import assert from "node:assert/strict";
import test from "node:test";
import { isTransientError } from "../src/retry-policy.js";
import {
  CHILEAN_CITIES,
  formatChileTime,
  formatIssPassReport,
  resolveIssLocation,
  supportedCityNames,
  UnsupportedLocationError,
} from "../src/iss-location.js";

const cityOf = (query) => {
  const result = resolveIssLocation(query);
  return result.city ? result.city.name : `UNKNOWN:${result.unknownPlace}`;
};

test("supports the twenty requested Chilean cities with plausible coordinates", () => {
  assert.deepEqual(supportedCityNames(), [
    "Arica", "Iquique", "Antofagasta", "Calama", "Copiapó", "La Serena", "Coquimbo",
    "Valparaíso", "Viña del Mar", "Santiago", "Rancagua", "Talca", "Chillán", "Concepción",
    "Temuco", "Valdivia", "Osorno", "Puerto Montt", "Coyhaique", "Punta Arenas",
  ]);
  for (const city of CHILEAN_CITIES) {
    assert.ok(city.latitude < -17 && city.latitude > -56, city.name);
    assert.ok(city.longitude < -66 && city.longitude > -76, city.name);
  }
  const osorno = CHILEAN_CITIES.find((city) => city.key === "osorno");
  assert.equal(osorno.latitude, -40.574);
  assert.equal(osorno.longitude, -73.135);
});

test("resolves the city named in the question (accent and case insensitive)", () => {
  assert.equal(cityOf("¿A qué hora pasa la estación espacial internacional en Santiago de Chile?"), "Santiago");
  assert.equal(cityOf("¿A qué hora pasa la ISS sobre Osorno?"), "Osorno");
  assert.equal(cityOf("iss en VIÑA DEL MAR"), "Viña del Mar");
  assert.equal(cityOf("iss sobre vina del mar"), "Viña del Mar");
  assert.equal(cityOf("ISS over Punta Arenas tonight"), "Punta Arenas");
  assert.equal(cityOf("iss sobre Copiapo"), "Copiapó");
  assert.equal(cityOf("¿Cuándo pasa la ISS por CHILLAN?"), "Chillán");
  assert.equal(cityOf("iss sobre la serena"), "La Serena");
  assert.equal(cityOf("ISS en Concepción, por favor"), "Concepción");
  assert.equal(cityOf("ISS en Coihaique"), "Coyhaique");
  assert.equal(cityOf("¿A qué hora pasa la ISS sobre Santiago, por favor?"), "Santiago");
});

test("defaults to Osorno only when no place is named", () => {
  for (const query of [
    "¿A qué hora pasa la ISS?",
    "cuando pasa la ISS en las próximas horas",
    "iss por la noche",
    "¿Cuándo es visible la estación espacial en Chile?",
  ]) {
    const result = resolveIssLocation(query);
    assert.equal(result.city?.name, "Osorno", query);
    assert.equal(result.defaulted, true, query);
  }
  assert.equal(resolveIssLocation("ISS sobre Osorno").defaulted, false);
});

test("reports unsupported places instead of silently using Osorno", () => {
  assert.equal(cityOf("ISS sobre puerto varas hoy"), "UNKNOWN:puerto varas");
  assert.equal(cityOf("ISS sobre Talcahuano"), "UNKNOWN:talcahuano");
  assert.equal(cityOf("ISS en el cielo de Lima"), "UNKNOWN:lima");
  assert.equal(cityOf("pasa la ISS por encima de Buenos Aires"), "UNKNOWN:buenos aires");
  const error = new UnsupportedLocationError("lima");
  assert.match(error.userMessage, /No reconozco la ciudad "lima"/);
  assert.match(error.userMessage, /Santiago/);
  assert.match(error.userMessage, /Punta Arenas/);
  assert.equal(isTransientError(error), false);
});

test("report names the city and gives Chile time plus UTC", () => {
  const santiago = CHILEAN_CITIES.find((city) => city.key === "santiago");
  const report = formatIssPassReport(santiago, {
    rise: Date.UTC(2026, 10, 14, 0, 5),
    set: Date.UTC(2026, 10, 14, 0, 11),
    maxElevation: (40 * Math.PI) / 180,
  });
  assert.match(report, /ISS pass over Santiago, Chile:/);
  assert.match(report, /21:05 to 21:11 Chile time, Fri, 13 Nov 2026 \(America\/Santiago, UTC-3\)/);
  assert.match(report, /2026-11-14 00:05 to 00:11 UTC/);
  assert.match(report, /maximum elevation about 40 degrees/);
  const none = formatIssPassReport(santiago, null);
  assert.match(none, /no pass above 10 degrees is predicted over Santiago, Chile/);
  const osorno = CHILEAN_CITIES.find((city) => city.key === "osorno");
  assert.match(formatIssPassReport(osorno, null, { defaulted: true }), /Osorno, Chile \(no city named; default location\)/);
});

test("Chile time follows daylight saving (UTC-3 summer, UTC-4 winter)", () => {
  assert.match(formatChileTime(Date.UTC(2026, 10, 14, 0, 5)), /21:05 \(UTC-3\)/);
  assert.match(formatChileTime(Date.UTC(2026, 6, 1, 12, 0)), /08:00 \(UTC-4\)/);
});
