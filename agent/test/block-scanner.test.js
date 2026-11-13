import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeRequestKey,
  decodeRequester,
  EMPTY_TX_ROOT,
  findRequestTransaction,
  requestChangesAt,
  scanHeights,
} from "../src/block-scanner.js";

const contractId = "orbit-hire.testnet";
const requestId = "75e01338-9be8-4ff8-8799-0575aa5a3b04";

function borshString(text) {
  const bytes = Buffer.from(text, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}
const keyBase64 = Buffer.concat([Buffer.from([0]), borshString(requestId)]).toString("base64");
const valueBase64 = Buffer.concat([borshString("client.testnet"), Buffer.alloc(40)]).toString("base64");

function unknownBlock() {
  return new Error('NEAR RPC failed: {"cause":{"name":"UNKNOWN_BLOCK"}}');
}

test("decodes request keys and requester from contract state", () => {
  assert.equal(decodeRequestKey(keyBase64), requestId);
  assert.equal(decodeRequester(valueBase64), "client.testnet");
  assert.equal(decodeRequestKey(Buffer.from("STATE").toString("base64")), null);
});

test("requestChangesAt returns request ids and treats skipped heights as empty", async () => {
  const rpc = async (method, params) => {
    assert.equal(method, "EXPERIMENTAL_changes");
    if (params.block_id === 2) throw unknownBlock();
    return {
      changes: [
        { type: "data_update", change: { account_id: contractId, key_base64: keyBase64, value_base64: valueBase64 } },
        { type: "data_update", change: { account_id: contractId, key_base64: keyBase64, value_base64: valueBase64 } },
      ],
    };
  };
  assert.deepEqual((await requestChangesAt(rpc, contractId, 1)).items, [
    { requestId, requester: "client.testnet", height: 1 },
  ]);
  assert.deepEqual(await requestChangesAt(rpc, contractId, 2), { height: 2, items: [], skipped: true });
});

test("scanHeights catches up a batch of blocks with bounded concurrency", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const calls = [];
  const rpc = async (_method, params) => {
    calls.push(params.block_id);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    inFlight -= 1;
    return params.block_id === 140
      ? { changes: [{ type: "data_update", change: { account_id: contractId, key_base64: keyBase64, value_base64: valueBase64 } }] }
      : { changes: [] };
  };
  const { results, error } = await scanHeights(rpc, { contractId, from: 100, to: 179, concurrency: 5 });
  assert.equal(error, null);
  assert.equal(results.length, 80);
  assert.deepEqual(results.map((r) => r.height), Array.from({ length: 80 }, (_, i) => 100 + i));
  assert.equal(results.flatMap((r) => r.items).length, 1);
  assert.equal(calls.length, 80);
  assert.ok(maxInFlight <= 5 && maxInFlight > 1);
});

test("scanHeights stops at the first failed height so the cursor never skips it", async () => {
  const rpc = async (_method, params) => {
    if (params.block_id === 105) throw new Error("NEAR RPC EXPERIMENTAL_changes returned HTTP 429");
    return { changes: [] };
  };
  const { results, error } = await scanHeights(rpc, { contractId, from: 100, to: 120, concurrency: 1 });
  assert.match(error.message, /429/u);
  assert.deepEqual(results.map((r) => r.height), [100, 101, 102, 103, 104]);
});

test("findRequestTransaction searches nearby blocks and skips empty chunks", async () => {
  const fetched = [];
  const rpc = async (method, params) => {
    fetched.push(`${method}:${params.block_id ?? params.chunk_id}`);
    if (method === "block") {
      if (params.block_id === 49) throw unknownBlock();
      return {
        chunks: [
          { chunk_hash: `empty-${params.block_id}`, tx_root: EMPTY_TX_ROOT },
          { chunk_hash: `full-${params.block_id}`, tx_root: "abc" },
        ],
      };
    }
    const height = Number(params.chunk_id.split("-")[1]);
    return {
      transactions:
        height === 48
          ? [
              { hash: "other", signer_id: "someone.testnet", receiver_id: contractId },
              { hash: "wanted", signer_id: "client.testnet", receiver_id: contractId },
            ]
          : [],
    };
  };
  const found = await findRequestTransaction(rpc, {
    contractId,
    requester: "client.testnet",
    height: 50,
    window: 4,
    matchTx: async (tx) => (tx.hash === "wanted" ? tx : null),
  });
  assert.equal(found.hash, "wanted");
  assert.ok(!fetched.some((entry) => entry.startsWith("chunk:empty")));
});

test("decodeRequestRecord reads requester and created_at", async () => {
  const { decodeRequestRecord } = await import("../src/block-scanner.js");
  const created = Buffer.alloc(8);
  created.writeBigUInt64LE(1794582146008885927n);
  const value = Buffer.concat([borshString("client.testnet"), Buffer.alloc(16), created, Buffer.alloc(8)]);
  assert.deepEqual(decodeRequestRecord(value.toString("base64")), {
    requester: "client.testnet",
    createdAtNs: 1794582146008885927n,
  });
});

test("findHeightByTimestamp locates the block that executed a request", async () => {
  const { findHeightByTimestamp } = await import("../src/block-scanner.js");
  const base = 1_700_000_000_000_000_000n;
  // heights 1000..5000, ~1.1 s per block, height 2000 skipped
  const tsOf = (height) => base + BigInt(height) * 1_100_000_000n + BigInt(height % 7) * 1000n;
  let calls = 0;
  const rpc = async (_method, params) => {
    calls += 1;
    const height = params.finality ? 5000 : params.block_id;
    if (height === 2000 || height < 1000 || height > 5000) {
      throw new Error('{"cause":{"name":"UNKNOWN_BLOCK"}}');
    }
    return { header: { height, timestamp_nanosec: String(tsOf(height)), timestamp: Number(tsOf(height)) } };
  };
  assert.equal(await findHeightByTimestamp(rpc, tsOf(3210)), 3210);
  assert.equal(await findHeightByTimestamp(rpc, tsOf(2001)), 2001);
  assert.ok(calls < 60);
});

test("rateLimitRpc spaces calls", async () => {
  const { rateLimitRpc } = await import("../src/block-scanner.js");
  const times = [];
  const limited = rateLimitRpc(async () => times.push(Date.now()), 50);
  await Promise.all([limited(), limited(), limited(), limited()]);
  assert.ok(times[3] - times[0] >= 55);
});
