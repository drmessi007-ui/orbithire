// Backup scanner helpers: find OrbitHire request records written per block via
// EXPERIMENTAL_changes (1 RPC call per block) and locate the originating
// request_service transaction only for blocks that actually touched a request.
// No external dependencies so it can be unit tested with injected RPC stubs.

export const EMPTY_TX_ROOT = "11111111111111111111111111111111";
const REQUEST_KEY_PREFIX = 0x00;

export function isUnknownBlockError(error) {
  return /UNKNOWN_BLOCK/u.test(String(error?.message || ""));
}

export function isRateLimitError(error) {
  return /HTTP 429/u.test(String(error?.message || ""));
}

// Request map key: 0x00 prefix + borsh String (u32 LE length + UTF-8 bytes).
export function decodeRequestKey(keyBase64) {
  const key = Buffer.from(String(keyBase64 || ""), "base64");
  if (key.length < 6 || key[0] !== REQUEST_KEY_PREFIX) return null;
  const length = key.readUInt32LE(1);
  if (length !== key.length - 5 || length > 64) return null;
  return key.subarray(5).toString("utf8");
}

// Request record value starts with the requester account as a borsh String.
export function decodeRequester(valueBase64) {
  const value = Buffer.from(String(valueBase64 || ""), "base64");
  if (value.length < 6) return null;
  const length = value.readUInt32LE(0);
  if (length < 2 || length > 64 || 4 + length > value.length) return null;
  return value.subarray(4, 4 + length).toString("utf8");
}

export async function requestChangesAt(rpc, contractId, height) {
  let result;
  try {
    result = await rpc("EXPERIMENTAL_changes", {
      changes_type: "data_changes",
      account_ids: [contractId],
      key_prefix_base64: Buffer.from([REQUEST_KEY_PREFIX]).toString("base64"),
      block_id: height,
    });
  } catch (error) {
    if (isUnknownBlockError(error)) return { height, items: [], skipped: true };
    throw error;
  }
  const items = [];
  const seen = new Set();
  for (const entry of result?.changes || []) {
    if (entry?.type !== "data_update" || entry.change?.account_id !== contractId) continue;
    const requestId = decodeRequestKey(entry.change.key_base64);
    if (!requestId || seen.has(requestId)) continue;
    seen.add(requestId);
    items.push({ requestId, requester: decodeRequester(entry.change.value_base64), height });
  }
  return { height, items };
}

// Scans [from, to] with bounded concurrency. Returns the contiguous prefix of
// successfully scanned heights so the cursor never skips a failed block.
export async function scanHeights(rpc, { contractId, from, to, concurrency = 4 }) {
  const heights = [];
  for (let height = from; height <= to; height += 1) heights.push(height);
  const outcomes = new Array(heights.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < heights.length) {
      const index = next;
      next += 1;
      try {
        outcomes[index] = { ok: true, value: await requestChangesAt(rpc, contractId, heights[index]) };
      } catch (error) {
        outcomes[index] = { ok: false, error };
        failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, heights.length)) }, worker));
  const results = [];
  for (const outcome of outcomes) {
    if (!outcome?.ok) {
      return { results, error: outcome?.error || null };
    }
    results.push(outcome.value);
  }
  return { results, error: null };
}

// Looks for the request_service transaction near the block where the request
// record was written (the tx is normally included 0-2 blocks earlier).
// matchTx(tx) must resolve to a truthy value when the tx is the right one.
export async function findRequestTransaction(rpc, { contractId, requester, height, window = 6, matchTx }) {
  const order = [height - 1, height, ...Array.from({ length: Math.max(0, window - 1) }, (_, i) => height - 2 - i)];
  for (const blockHeight of order) {
    if (blockHeight < 0) continue;
    let block;
    try {
      block = await rpc("block", { block_id: blockHeight });
    } catch (error) {
      if (isUnknownBlockError(error)) continue;
      throw error;
    }
    for (const chunkHeader of block?.chunks || []) {
      if (chunkHeader.tx_root === EMPTY_TX_ROOT) continue;
      const chunk = await rpc("chunk", { chunk_id: chunkHeader.chunk_hash });
      for (const tx of chunk?.transactions || []) {
        if (tx.receiver_id !== contractId) continue;
        if (requester && tx.signer_id !== requester) continue;
        const matched = await matchTx(tx);
        if (matched) return matched;
      }
    }
  }
  return null;
}

// Decodes the start of a request record: requester (borsh String),
// deposit (u128), created_at (u64 ns).
export function decodeRequestRecord(valueBase64) {
  const value = Buffer.from(String(valueBase64 || ""), "base64");
  const requester = decodeRequester(valueBase64);
  if (!requester) return null;
  const offset = 4 + Buffer.byteLength(requester, "utf8") + 16;
  if (value.length < offset + 8) return null;
  return { requester, createdAtNs: value.readBigUInt64LE(offset) };
}

function headerTimestampNs(header) {
  // timestamp_nanosec is a string; header.timestamp loses precision as a JS number.
  return BigInt(header.timestamp_nanosec ?? Math.round(header.timestamp));
}

// Finds the block whose timestamp equals targetNs (the contract stores
// env::block_timestamp of the block that executed request_service).
// Interpolation search; returns the closest height at or before the target.
export async function findHeightByTimestamp(rpc, targetNs, { maxSteps = 30 } = {}) {
  const target = BigInt(targetNs);
  const latest = (await rpc("block", { finality: "final" })).header;
  let hi = { height: latest.height, ts: headerTimestampNs(latest) };
  if (target >= hi.ts) return hi.height;
  const fetchAt = async (height) => {
    for (let candidate = height; candidate < Math.min(hi.height, height + 10); candidate += 1) {
      try {
        const header = (await rpc("block", { block_id: candidate })).header;
        return { height: header.height, ts: headerTimestampNs(header) };
      } catch (error) {
        if (!isUnknownBlockError(error)) throw error;
      }
    }
    if (height + 10 < hi.height) throw new Error(`No available block near height ${height}`);
    return hi;
  };
  let estimate = hi.height - Number((hi.ts - target) / 1_000_000_000n) - 5;
  let lo = await fetchAt(Math.max(0, estimate));
  let steps = 0;
  while (lo.ts > target && steps < maxSteps) {
    steps += 1;
    hi = lo;
    estimate = lo.height - Math.max(5, Number((lo.ts - target) / 500_000_000n));
    lo = await fetchAt(Math.max(0, estimate));
  }
  while (hi.height - lo.height > 1 && steps < maxSteps) {
    steps += 1;
    const span = Number(hi.ts - lo.ts) || 1;
    const fraction = Number(target - lo.ts) / span;
    let mid = lo.height + Math.round(fraction * (hi.height - lo.height));
    mid = Math.min(hi.height - 1, Math.max(lo.height + 1, mid));
    const probe = await fetchAt(mid);
    if (probe.ts === target) return probe.height;
    if (probe.ts < target) lo = probe;
    else if (probe.height === hi.height) break;
    else hi = probe;
  }
  return hi.ts === target ? hi.height : lo.height;
}

// Spaces out RPC calls to at most `rps` per second (shared across workers).
export function rateLimitRpc(rpc, rps) {
  const intervalMs = 1000 / rps;
  let nextSlot = 0;
  return async (method, params) => {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + intervalMs;
    if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
    return rpc(method, params);
  };
}
