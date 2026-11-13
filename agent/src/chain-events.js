import { createHash } from "node:crypto";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function isFailure(status) {
  return Boolean(status && typeof status === "object" && "Failure" in status);
}

function decodeArgs(args) {
  if (typeof args !== "string") {
    throw new Error("request_service transaction args are not base64 encoded");
  }
  try {
    return JSON.parse(Buffer.from(args, "base64").toString("utf8"));
  } catch {
    throw new Error("request_service transaction args are invalid JSON");
  }
}

function findRequestEvents(txStatus, contractId) {
  const outcomes = [
    txStatus.transaction_outcome,
    ...(txStatus.receipts_outcome || []),
  ];
  const events = [];
  for (const outcome of outcomes) {
    if (outcome?.outcome?.executor_id && outcome.outcome.executor_id !== contractId) continue;
    for (const log of outcome?.outcome?.logs || []) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      try {
        const event = JSON.parse(log.slice("EVENT_JSON:".length));
        if (
          event.standard === "orbit_hire" &&
          event.event === "request_created" &&
          Array.isArray(event.data)
        ) {
          events.push(...event.data);
        }
      } catch {
        continue;
      }
    }
  }
  return events.filter(
    (event) =>
      typeof event.request_id === "string" &&
      UUID_V4_PATTERN.test(event.request_id) &&
      typeof event.query_hash === "string" &&
      SHA256_PATTERN.test(event.query_hash),
  );
}

export function extractRequestCreated(txStatus, contractId, expectedFee) {
  const events = findRequestEvents(txStatus, contractId);
  if (events.length === 0) return null;

  if (
    isFailure(txStatus.status) ||
    isFailure(txStatus.transaction_outcome?.outcome?.status)
  ) {
    throw new Error("request_created transaction failed on NEAR");
  }
  const transaction = txStatus.transaction;
  if (transaction?.receiver_id !== contractId) {
    throw new Error("request_created transaction did not target OrbitHire");
  }

  for (const action of transaction.actions || []) {
    const functionCall = action?.FunctionCall || action?.function_call;
    if (functionCall?.method_name !== "request_service") continue;
    const args = decodeArgs(functionCall.args);
    if (
      typeof args.request_id !== "string" ||
      typeof args.query !== "string" ||
      !UUID_V4_PATTERN.test(args.request_id)
    ) {
      throw new Error("request_service transaction is missing a valid request ID or query");
    }
    const event = events.find((candidate) => candidate.request_id === args.request_id);
    if (!event) continue;

    let deposit;
    try {
      deposit = BigInt(functionCall.deposit);
    } catch {
      throw new Error("request_service transaction has an invalid attached deposit");
    }
    if (deposit !== BigInt(expectedFee)) {
      throw new Error("request_service transaction deposit does not match the contract fee");
    }
    const actualHash = createHash("sha256").update(args.query, "utf8").digest("hex");
    if (actualHash !== event.query_hash) {
      throw new Error("request_service query does not match the on-chain commitment");
    }
    return {
      request_id: args.request_id,
      query: args.query,
      query_hash: event.query_hash,
      transaction_hash: txStatus.transaction.hash,
      signer_id: txStatus.transaction.signer_id,
    };
  }
  throw new Error("request_created event does not match a request_service transaction");
}

export function extractNotifiedRequest(
  txStatus,
  contractId,
  expectedFee,
  { requestId, transactionHash, senderAccountId },
) {
  const extracted = extractRequestCreated(txStatus, contractId, expectedFee);
  if (!extracted) throw new Error("transaction has no OrbitHire request_created event");
  if (extracted.request_id !== requestId) {
    throw new Error("transaction request ID does not match the notification");
  }
  if (extracted.transaction_hash !== transactionHash) {
    throw new Error("transaction hash does not match the notification");
  }
  if (extracted.signer_id !== senderAccountId) {
    throw new Error("transaction signer does not match the notification");
  }
  return extracted;
}
