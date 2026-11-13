import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  extractNotifiedRequest,
  extractRequestCreated,
} from "../src/chain-events.js";

const requestId = "550e8400-e29b-41d4-a716-446655440000";
const query = "¿hay tormenta geomagnética hoy?";
const queryHash = createHash("sha256").update(query, "utf8").digest("hex");
const fee = "100000000000000000000000";

function transaction({ receiverId = "orbit-hire.testnet", deposit = fee, args = { request_id: requestId, query }, status = { SuccessValue: "" } } = {}) {
  const encodedArgs = Buffer.from(JSON.stringify(args), "utf8").toString("base64");
  return {
    status,
    transaction: {
      hash: "transaction-hash",
      signer_id: "client.testnet",
      receiver_id: receiverId,
      actions: [
        {
          FunctionCall: {
            method_name: "request_service",
            args: encodedArgs,
            deposit,
          },
        },
      ],
    },
    transaction_outcome: {
      outcome: {
        executor_id: "orbit-hire.testnet",
        status: { SuccessValue: "" },
        logs: [
          `EVENT_JSON:${JSON.stringify({
            standard: "orbit_hire",
            event: "request_created",
            data: [{ request_id: requestId, query_hash: queryHash }],
          })}`,
        ],
      },
    },
    receipts_outcome: [],
  };
}

test("extracts a query only when event, transaction, commitment, and fee can be checked", () => {
  assert.deepEqual(extractRequestCreated(transaction(), "orbit-hire.testnet", fee), {
    request_id: requestId,
    query,
    query_hash: queryHash,
    transaction_hash: "transaction-hash",
    signer_id: "client.testnet",
  });
});

test("accepts a notification only when request, transaction, and signer match", () => {
  assert.deepEqual(
    extractNotifiedRequest(transaction(), "orbit-hire.testnet", fee, {
      requestId,
      transactionHash: "transaction-hash",
      senderAccountId: "client.testnet",
    }),
    extractRequestCreated(transaction(), "orbit-hire.testnet", fee),
  );
});

test("rejects notifications that misidentify the request, transaction, or signer", () => {
  const cases = [
    [{ requestId: "550e8400-e29b-41d4-a716-446655440001", transactionHash: "transaction-hash", senderAccountId: "client.testnet" }, /request ID/u],
    [{ requestId, transactionHash: "different-hash", senderAccountId: "client.testnet" }, /transaction hash/u],
    [{ requestId, transactionHash: "transaction-hash", senderAccountId: "other.testnet" }, /signer/u],
  ];
  for (const [notification, message] of cases) {
    assert.throws(
      () => extractNotifiedRequest(transaction(), "orbit-hire.testnet", fee, notification),
      message,
    );
  }
});

test("ignores transactions without an OrbitHire request event", () => {
  const tx = transaction();
  tx.transaction_outcome.outcome.logs = [];
  assert.equal(extractRequestCreated(tx, "orbit-hire.testnet", fee), null);
});

test("rejects a failed transaction", () => {
  assert.throws(
    () => extractRequestCreated(transaction({ status: { Failure: { error_message: "failed" } } }), "orbit-hire.testnet", fee),
    /transaction failed/u,
  );
});

test("rejects a transaction sent to a different contract", () => {
  assert.throws(
    () => extractRequestCreated(transaction({ receiverId: "other.testnet" }), "orbit-hire.testnet", fee),
    /did not target OrbitHire/u,
  );
});

test("rejects a mismatched deposit", () => {
  assert.throws(
    () => extractRequestCreated(transaction({ deposit: "1" }), "orbit-hire.testnet", fee),
    /deposit does not match/u,
  );
});

test("rejects a query that does not match the on-chain commitment", () => {
  assert.throws(
    () =>
      extractRequestCreated(
        transaction({ args: { request_id: requestId, query: "different query" } }),
        "orbit-hire.testnet",
        fee,
      ),
    /does not match the on-chain commitment/u,
  );
});
