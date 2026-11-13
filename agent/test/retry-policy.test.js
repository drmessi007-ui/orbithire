import assert from "node:assert/strict";
import test from "node:test";
import {
  isTransientError,
  MAX_REQUEST_ATTEMPTS,
  nextAttemptNumber,
  retryDelayMs,
  TransientAgentError,
} from "../src/retry-policy.js";

test("limits request processing to three total attempts with exponential backoff", () => {
  assert.equal(MAX_REQUEST_ATTEMPTS, 3);
  assert.equal(retryDelayMs(1), 5000);
  assert.equal(retryDelayMs(2), 10000);
  assert.throws(() => retryDelayMs(3), RangeError);
  assert.equal(nextAttemptNumber({ status: "queued" }), 1);
  assert.equal(nextAttemptNumber({ status: "retrying", attempts: 1 }), 2);
  assert.equal(nextAttemptNumber({ status: "processing", attempts: 2 }), 2);
  assert.equal(nextAttemptNumber({ status: "submitting", attempts: 3 }), 3);
});

test("classifies infrastructure and timeout failures as transient", () => {
  assert.equal(isTransientError(new TransientAgentError("NEAR RPC unavailable")), true);
  assert.equal(isTransientError(Object.assign(new Error("rate limited"), { status: 429 })), true);
  assert.equal(isTransientError(Object.assign(new Error("server unavailable"), { status: 503 })), true);
  assert.equal(isTransientError(Object.assign(new Error("request timed out"), { name: "APITimeoutError" })), true);
  assert.equal(isTransientError(Object.assign(new Error("bad request"), { status: 400 })), false);
  assert.equal(isTransientError(Object.assign(new Error("unauthorized"), { status: 401 })), false);
  assert.equal(isTransientError(new Error("Unsupported question")), false);
});
