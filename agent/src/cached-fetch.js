// Small in-memory TTL cache for public data sources. CelesTrak asks clients not to
// download the same GP data more than once every 2 hours and blocks abusive IPs,
// and the Starlink/active groups are several MB, so their responses are cached.
export function ttlForUrl(url) {
  const host = new URL(url).hostname;
  if (host === "celestrak.org" && url.includes("/SOCRATES/")) return 60 * 60 * 1000;
  if (host === "celestrak.org") return 2 * 60 * 60 * 1000;
  if (host.endsWith("thespacedevs.com")) return 15 * 60 * 1000;
  if (host === "ssd-api.jpl.nasa.gov") return 60 * 60 * 1000;
  if (host === "services.swpc.noaa.gov") return 5 * 60 * 1000;
  return 0;
}

export function withCache(fetcher, { ttl = ttlForUrl, now = Date.now, maxEntries = 50 } = {}) {
  const cache = new Map();
  const inflight = new Map();
  return async function cached(url, options = {}) {
    const key = `${url}|${options.range || ""}`;
    const life = ttl(url);
    const hit = cache.get(key);
    if (life > 0 && hit && now() - hit.at < life) return hit.value;
    if (inflight.has(key)) return inflight.get(key);
    const promise = (async () => {
      try {
        const value = await fetcher(url, options);
        if (life > 0) {
          cache.set(key, { at: now(), value });
          while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
        }
        return value;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, promise);
    return promise;
  };
}
