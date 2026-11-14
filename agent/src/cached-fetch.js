// Small TTL cache for public data sources. CelesTrak asks clients not to download
// the same GP data more than once every 2 hours: a repeated download returns
// "GP data has not updated since your last successful download" instead of JSON
// and abusive IPs get blocked. The Starlink/active groups are also several MB.
// So responses are cached in memory and, optionally, on disk (survives restarts),
// and a stale copy (up to MAX_STALE_MS old) is served if the source fails.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const MAX_STALE_MS = 24 * 60 * 60 * 1000;

export function ttlForUrl(url) {
  const host = new URL(url).hostname;
  if (host === "celestrak.org" && url.includes("/SOCRATES/")) return 60 * 60 * 1000;
  if (host === "celestrak.org") return 2 * 60 * 60 * 1000;
  if (host.endsWith("thespacedevs.com")) return 15 * 60 * 1000;
  if (host === "ssd-api.jpl.nasa.gov") return 60 * 60 * 1000;
  if (host === "services.swpc.noaa.gov") return 5 * 60 * 1000;
  return 0;
}

/** Disk store: one 0600 JSON file per cache key in `dir`. Errors are ignored (cache is best effort). */
export function diskStore(dir) {
  const file = (key) => path.join(dir, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);
  return {
    async get(key) {
      try {
        const entry = JSON.parse(await readFile(file(key), "utf8"));
        return entry && entry.key === key ? entry : null;
      } catch {
        return null;
      }
    },
    async set(key, entry) {
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(file(key), JSON.stringify({ key, ...entry }), { mode: 0o600 });
      } catch {}
    },
  };
}

export function withCache(fetcher, { ttl = ttlForUrl, now = Date.now, maxEntries = 50, store = null, maxStaleMs = MAX_STALE_MS } = {}) {
  const cache = new Map();
  const inflight = new Map();
  return async function cached(url, options = {}) {
    const key = `${url}|${options.range || ""}`;
    const life = ttl(url);
    if (life <= 0) return fetcher(url, options);
    let hit = cache.get(key);
    if (!hit && store) {
      hit = await store.get(key);
      if (hit) cache.set(key, hit);
    }
    if (hit && now() - hit.at < life) return hit.value;
    if (inflight.has(key)) return inflight.get(key);
    const promise = (async () => {
      try {
        const value = await fetcher(url, options);
        const entry = { at: now(), value };
        cache.set(key, entry);
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
        if (store) await store.set(key, entry);
        return value;
      } catch (error) {
        if (hit && now() - hit.at < maxStaleMs) return hit.value;
        throw error;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, promise);
    return promise;
  };
}
