export const MAX_REQUEST_ATTEMPTS = 3;

export class TransientAgentError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "TransientAgentError";
  }
}

export function retryDelayMs(attempt) {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt >= MAX_REQUEST_ATTEMPTS) {
    throw new RangeError(`attempt must be between 1 and ${MAX_REQUEST_ATTEMPTS - 1}`);
  }
  return 5000 * 2 ** (attempt - 1);
}

export function nextAttemptNumber(previousResult) {
  const attempts = Number.isInteger(previousResult?.attempts) ? previousResult.attempts : 0;
  if (["processing", "submitting"].includes(previousResult?.status)) {
    return Math.max(1, attempts);
  }
  return attempts + 1;
}

export function isTransientError(error) {
  if (!error || typeof error !== "object") return false;
  if (error instanceof TransientAgentError) return true;

  const status = error.status ?? error.statusCode;
  if (status === 408 || status === 429 || (Number.isInteger(status) && status >= 500)) {
    return true;
  }

  const transientNames = new Set([
    "APIConnectionError",
    "APITimeoutError",
    "InternalServerError",
    "RateLimitError",
    "TimeoutError",
    "AbortError",
  ]);
  if (transientNames.has(error.name)) return true;

  const transientCodes = new Set([
    "ECONNABORTED",
    "ECONNREFUSED",
    "ECONNRESET",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET",
  ]);
  if (transientCodes.has(error.code)) return true;
  if (
    typeof error.message === "string" &&
    /fetch failed|network error|socket hang up|timed? ?out|temporarily unavailable/iu.test(
      error.message,
    )
  ) {
    return true;
  }

  return error.cause ? isTransientError(error.cause) : false;
}
