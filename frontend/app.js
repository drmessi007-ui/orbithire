const CONTRACT_ID = "orbit-hire.shortemail369.testnet";
const NETWORK_ID = "testnet";
const RPC_URL = "https://rpc.testnet.near.org";
const AGENT_API_URL = "https://agent.deosorno.cl";
const FEE_YOCTO = "100000000000000000000000";
const REQUEST_GAS = "100000000000000";
const EXPLORER_URL = "https://explorer.testnet.near.org/transactions/";
const RESULT_POLL_INTERVAL_MS = 2500;
const RESULT_POLL_ATTEMPTS = 48;
const AGENT_HEALTH_POLL_INTERVAL_MS = 30000;
const AGENT_HEALTH_RETRY_MS = 5000;
const AGENT_HEALTH_FAILURES_BEFORE_BLOCK = 2;
const REQUEST_RATE_LIMIT_MS = 60 * 60 * 1000;
// The contract has no view method for the per-account rate limit, but its
// storage is small and public: key 0x01 + borsh(account_id) holds the last
// successful request_service timestamp (u64 ns) and STATE holds the window.
const RATE_LIMIT_STATE_KEY_PREFIX = 0x01;
const CHAIN_FINALITY_GRACE_MS = 30000;
const REQUEST_COOLDOWN_STORAGE_PREFIX = "orbithire:request-cooldown:";
const REQUEST_HISTORY_STORAGE_PREFIX = "orbithire:request-history:";
const MAX_HISTORY_ENTRIES = 100;
const HISTORY_STATUSES = new Set(["pending", "completed", "failed", "under_review"]);
const FINAL_RESULT_STATUSES = new Set(["completed", "failed", "under_review"]);
const PENDING_RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PENDING_UNSIGNED_STALE_MS = 15 * 60 * 1000;
const HISTORY_RESUME_INTERVAL_MS = 20000;
const HISTORY_RESULT_MAX_CHARS = 1500;
const RESULT_PROGRESS_STEPS = [
  ["pago_enviado", "Pago enviado"],
  ["verificando", "Verificando en la cadena"],
  ["en_cola", "En cola"],
  ["procesando", "Procesando"],
  ["registrando", "Registrando recibo"],
  ["completado", "Completado"],
];
const RESULT_PROGRESS_LABELS = Object.fromEntries(RESULT_PROGRESS_STEPS);
RESULT_PROGRESS_LABELS.failed = "Error";
RESULT_PROGRESS_LABELS.under_review = "En revisión";
const TERMINAL_PROGRESS_STAGES = new Set(["completado", "failed", "under_review"]);
const REFUND_HINT =
  "La solicitud permanece abierta en el contrato y se puede reembolsar después del plazo.";

const walletButton = document.querySelector("#wallet-button");
const submitButton = document.querySelector("#submit-button");
const queryInput = document.querySelector("#query");
const charCount = document.querySelector("#char-count");
const agentApiNote = document.querySelector("#agent-api-note");
const statusLabel = document.querySelector("#status-label");
const emptyState = document.querySelector("#empty-state");
const resultContent = document.querySelector("#result-content");
const resultCopy = document.querySelector("#result-copy");
const resultProgress = document.querySelector("#result-progress");
const progressStages = document.querySelector("#progress-stages");
const progressLive = document.querySelector("#progress-live");
const progressLiveText = document.querySelector("#progress-live-text");
const progressMeta = document.querySelector("#progress-meta");
const requestIdLabel = document.querySelector("#request-id");
const transactionLink = document.querySelector("#transaction-link");
const historyWallet = document.querySelector("#history-wallet");
const historyStorageNote = document.querySelector("#history-storage-note");
const historyEmpty = document.querySelector("#history-empty");
const historyList = document.querySelector("#history-list");

let walletSelector;
let meteorWallet;
let walletReady = false;
let actionCreators;
let setupWalletSelector;
let setupMeteorWallet;
let isSubmitting = false;
let isPreparingPayment = false;
let agentHealthReady = false;
let agentHealthCheckInProgress = false;
let agentHealthCheckPromise;
let agentHealthConsecutiveFailures = 0;
let agentHealthRetryTimer;
let agentApiStatusText = "";
const inMemoryRequestCooldowns = new Map();
const chainCooldowns = new Map();
const chainCooldownRequests = new Set();
let rateLimitWindowMs = REQUEST_RATE_LIMIT_MS;
let rateLimitWindowLoaded = false;
let cooldownTimer;
let cooldownAccountId = null;
const requestHistoryCache = new Map();
const activeResultPolls = new Set();
const renotifiedRequests = new Set();
let historyResumeTimer;
let historyResumeRunning = false;
let uiAccountId = null;
let resultProgressTimer;
let resultProgressRequestId = "";
let resultProgressAccountId = "";
let resultProgressStage = "";
let resultProgressStartedAt = 0;
let resultProgressUpdatedAt = 0;
const historyStorageErrors = new Map();
const agentApiConfigured = isValidAgentApiUrl();

function isValidAgentApiUrl() {
  try {
    const url = new URL(AGENT_API_URL);
    return url.protocol === "https:" && !url.hostname.endsWith(".example.com");
  } catch {
    return false;
  }
}

function showStatus(message, state = "idle") {
  statusLabel.textContent = message;
  statusLabel.dataset.state = state;
}

function showMessage(message, requestId = "", transactionHash = "") {
  emptyState.hidden = true;
  resultContent.hidden = false;
  resultCopy.textContent = message;
  requestIdLabel.textContent = requestId || "—";
  if (transactionHash) {
    transactionLink.href = `${EXPLORER_URL}${encodeURIComponent(transactionHash)}`;
    transactionLink.hidden = false;
  } else {
    transactionLink.removeAttribute("href");
    transactionLink.hidden = true;
  }
  if (!requestId || resultProgressRequestId !== requestId) hideResultProgress();
}

function resetResultPanel() {
  hideResultProgress();
  emptyState.hidden = false;
  resultContent.hidden = true;
  resultCopy.textContent = "";
  requestIdLabel.textContent = "";
  transactionLink.removeAttribute("href");
  transactionLink.hidden = true;
}

function hideResultProgress() {
  if (resultProgressTimer) {
    window.clearInterval(resultProgressTimer);
    resultProgressTimer = undefined;
  }
  resultProgressRequestId = "";
  resultProgressAccountId = "";
  resultProgressStage = "";
  resultProgressStartedAt = 0;
  resultProgressUpdatedAt = 0;
  if (resultProgress) resultProgress.hidden = true;
  if (progressStages) progressStages.replaceChildren();
  if (progressLive) progressLive.hidden = true;
  if (progressMeta) progressMeta.hidden = true;
}

function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${totalSeconds} s`;
  return `${minutes} min ${String(seconds).padStart(2, "0")} s`;
}

function formatClock(timestamp) {
  return new Date(timestamp).toLocaleTimeString("es-CL", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function progressStageFromAgent(result, { hasTransactionHash = false, localStage = "" } = {}) {
  const status = result?.status;
  if (status === "queued") return "en_cola";
  if (status === "processing" || status === "retrying") return "procesando";
  if (status === "submitting") return "registrando";
  if (status === "completed") return "completado";
  if (status === "failed") return "failed";
  if (status === "under_review") return "under_review";
  if (status === "waiting_for_event" || status === "not_found") {
    return hasTransactionHash ? "verificando" : "pago_enviado";
  }
  if (RESULT_PROGRESS_LABELS[localStage]) return localStage;
  return hasTransactionHash ? "pago_enviado" : "";
}

function failedResultMessage(result) {
  const message =
    (result && agentResultMessage(result)) || "No se pudo completar la consulta.";
  return /reembol/i.test(message) ? message : `${message} ${REFUND_HINT}`;
}

function canPaintRequest(accountId, requestId) {
  return (
    Boolean(accountId) &&
    getActiveAccountId() === accountId &&
    (!resultProgressRequestId || resultProgressRequestId === requestId)
  );
}

function refreshProgressMeta() {
  if (!progressMeta || !resultProgressStartedAt) return;
  progressMeta.hidden = false;
  const elapsed = formatElapsed(Date.now() - resultProgressStartedAt);
  const updated = formatClock(resultProgressUpdatedAt || resultProgressStartedAt);
  progressMeta.textContent = `Transcurridos ${elapsed} · última actualización a las ${updated}`;
}

function renderProgressSteps(stage) {
  if (!progressStages) return;
  const happyIndex = RESULT_PROGRESS_STEPS.findIndex(([id]) => id === stage);
  const currentIndex =
    stage === "failed" || stage === "under_review"
      ? Math.max(
          0,
          RESULT_PROGRESS_STEPS.findIndex(([id]) => id === "registrando"),
        )
      : happyIndex;
  progressStages.replaceChildren();
  for (const [index, [id, label]] of RESULT_PROGRESS_STEPS.entries()) {
    const item = document.createElement("li");
    item.className = "progress-stage";
    item.dataset.stage = id;
    if (stage === "failed" && index === currentIndex) item.dataset.state = "error";
    else if (stage === "completado" || (happyIndex !== -1 && index < happyIndex) || (stage === "under_review" && index <= currentIndex)) {
      item.dataset.state = "done";
    } else if (happyIndex !== -1 && index === happyIndex) {
      item.dataset.state = "current";
    } else {
      item.dataset.state = "todo";
    }
    const dot = document.createElement("span");
    dot.className = "progress-stage-dot";
    dot.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = label;
    item.append(dot, text);
    progressStages.append(item);
  }
}

function showResultProgress({
  accountId,
  requestId,
  transactionHash = "",
  stage,
  message = "",
  startedAt,
  updatedAt,
} = {}) {
  if (!resultProgress || !requestId || !canPaintRequest(accountId, requestId)) return;
  emptyState.hidden = true;
  resultContent.hidden = false;
  resultProgress.hidden = false;
  resultProgressRequestId = requestId;
  resultProgressAccountId = accountId || "";
  resultProgressStage = stage;
  resultProgressStartedAt = startedAt || resultProgressStartedAt || Date.now();
  resultProgressUpdatedAt = updatedAt || Date.now();
  requestIdLabel.textContent = requestId || "—";
  if (transactionHash) {
    transactionLink.href = `${EXPLORER_URL}${encodeURIComponent(transactionHash)}`;
    transactionLink.hidden = false;
  }
  renderProgressSteps(stage);
  const inFlight = !TERMINAL_PROGRESS_STAGES.has(stage);
  if (progressLive) {
    progressLive.hidden = !inFlight;
    if (inFlight && progressLiveText) {
      const label = RESULT_PROGRESS_LABELS[stage] || "En proceso";
      progressLiveText.textContent = `Cargando el resultado… ${label}`;
    }
  }
  if (message) resultCopy.textContent = message;
  refreshProgressMeta();
  if (inFlight) {
    if (!resultProgressTimer) {
      resultProgressTimer = window.setInterval(refreshProgressMeta, 1000);
    }
  } else if (resultProgressTimer) {
    window.clearInterval(resultProgressTimer);
    resultProgressTimer = undefined;
  }
}

function getActiveAccountId() {
  return walletSelector?.isSignedIn()
    ? walletSelector.store.getState().accounts[0]?.accountId || ""
    : "";
}

function truncateResult(text) {
  const value = typeof text === "string" ? text : "";
  return value.length > HISTORY_RESULT_MAX_CHARS
    ? `${value.slice(0, HISTORY_RESULT_MAX_CHARS)}…`
    : value;
}

function readLocalCooldownUntil(accountId) {
  const memoryCooldown = inMemoryRequestCooldowns.get(accountId) || 0;
  let storedCooldown = 0;
  try {
    const stored = Number(
      window.localStorage.getItem(`${REQUEST_COOLDOWN_STORAGE_PREFIX}${accountId}`),
    );
    if (Number.isFinite(stored) && stored > Date.now()) {
      storedCooldown = stored;
    } else {
      window.localStorage.removeItem(`${REQUEST_COOLDOWN_STORAGE_PREFIX}${accountId}`);
    }
  } catch (error) {
    console.warn("No se pudo leer el límite local de solicitudes:", error);
  }
  const localCooldown = Math.max(memoryCooldown, storedCooldown);
  return localCooldown > Date.now() ? localCooldown : 0;
}

function storeLocalCooldown(accountId, cooldownUntil) {
  inMemoryRequestCooldowns.set(accountId, cooldownUntil);
  try {
    window.localStorage.setItem(
      `${REQUEST_COOLDOWN_STORAGE_PREFIX}${accountId}`,
      String(cooldownUntil),
    );
  } catch (error) {
    console.warn("No se pudo guardar el límite local de solicitudes:", error);
  }
}

function clearLocalCooldown(accountId) {
  inMemoryRequestCooldowns.delete(accountId);
  try {
    window.localStorage.removeItem(`${REQUEST_COOLDOWN_STORAGE_PREFIX}${accountId}`);
  } catch (error) {
    console.warn("No se pudo limpiar el límite local de solicitudes:", error);
  }
}

function getRequestCooldownUntil(accountId) {
  if (!accountId) return 0;
  const now = Date.now();
  const localCooldown = readLocalCooldownUntil(accountId);
  const chain = chainCooldowns.get(accountId);
  if (chain) {
    // Chain state is the source of truth once it was read after the local
    // record had time to reach finality.
    const localRecordedAt = localCooldown ? localCooldown - rateLimitWindowMs : 0;
    if (!localCooldown || chain.checkedAt > localRecordedAt + CHAIN_FINALITY_GRACE_MS) {
      return chain.until > now ? chain.until : 0;
    }
    return Math.max(localCooldown, chain.until > now ? chain.until : 0);
  }
  return localCooldown;
}

// Only call after the transaction succeeded on chain.
function recordRequestCooldown(accountId) {
  storeLocalCooldown(accountId, Date.now() + rateLimitWindowMs);
  window.setTimeout(() => {
    void refreshChainCooldown(accountId);
  }, CHAIN_FINALITY_GRACE_MS + 5000);
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary);
}

function base64ToBytes(base64) {
  return Uint8Array.from(window.atob(base64), (char) => char.charCodeAt(0));
}

function readUnsignedLE(bytes, offset, length) {
  if (offset + length > bytes.length) throw new Error("estado del contrato truncado");
  let value = 0n;
  for (let index = length - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[offset + index]);
  }
  return value;
}

function borshStringKey(prefixByte, text) {
  const encoded = new TextEncoder().encode(text);
  const key = new Uint8Array(5 + encoded.length);
  key[0] = prefixByte;
  new DataView(key.buffer).setUint32(1, encoded.length, true);
  key.set(encoded, 5);
  return key;
}

async function rpcQuery(params) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "orbithire", method: "query", params }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`RPC respondió HTTP ${response.status}`);
  const body = await response.json();
  if (body.error || !body.result || body.result.error) {
    throw new Error(body.error?.message || body.result?.error || "respuesta RPC inválida");
  }
  return body.result;
}

async function viewContractState(prefixBytes) {
  const result = await rpcQuery({
    request_type: "view_state",
    finality: "final",
    account_id: CONTRACT_ID,
    prefix_base64: bytesToBase64(prefixBytes),
  });
  if (!Array.isArray(result.values)) throw new Error("view_state sin valores");
  return result.values;
}

async function loadRateLimitWindow() {
  if (rateLimitWindowLoaded) return rateLimitWindowMs;
  const stateKey = new TextEncoder().encode("STATE");
  const values = await viewContractState(stateKey);
  const entry = values.find((value) => value.key === bytesToBase64(stateKey));
  if (!entry) throw new Error("el contrato no expone STATE");
  const bytes = base64ToBytes(entry.value);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (let field = 0; field < 3; field += 1) {
    offset += 4 + view.getUint32(offset, true);
  }
  const fee = readUnsignedLE(bytes, offset, 16);
  if (fee !== BigInt(FEE_YOCTO)) throw new Error("formato de STATE inesperado");
  offset += 16;
  const windowMs = Number(readUnsignedLE(bytes, offset, 8) / 1000000n);
  if (windowMs < 60 * 1000 || windowMs > 7 * 24 * 60 * 60 * 1000) {
    throw new Error("ventana de límite fuera de rango");
  }
  rateLimitWindowMs = windowMs;
  rateLimitWindowLoaded = true;
  return rateLimitWindowMs;
}

async function fetchChainCooldownUntil(accountId) {
  const windowMs = await loadRateLimitWindow();
  const key = borshStringKey(RATE_LIMIT_STATE_KEY_PREFIX, accountId);
  const values = await viewContractState(key);
  const entry = values.find((value) => value.key === bytesToBase64(key));
  if (!entry) return 0;
  const bytes = base64ToBytes(entry.value);
  if (bytes.length !== 8) throw new Error("formato de límite inesperado");
  const lastRequestMs = Number(readUnsignedLE(bytes, 0, 8) / 1000000n);
  if (lastRequestMs < Date.UTC(2024, 0, 1) || lastRequestMs > Date.now() + 10 * 60 * 1000) {
    throw new Error("marca de tiempo del límite fuera de rango");
  }
  return lastRequestMs + windowMs;
}

async function refreshChainCooldown(accountId) {
  if (!accountId) return;
  const checkedAt = Date.now();
  try {
    const until = await fetchChainCooldownUntil(accountId);
    chainCooldowns.set(accountId, { until, checkedAt });
    const localCooldown = readLocalCooldownUntil(accountId);
    if (until > Date.now()) {
      if (until !== localCooldown) storeLocalCooldown(accountId, until);
    } else if (
      localCooldown &&
      checkedAt > localCooldown - rateLimitWindowMs + CHAIN_FINALITY_GRACE_MS
    ) {
      clearLocalCooldown(accountId);
    }
  } catch (error) {
    console.warn("No se pudo leer el límite de solicitudes desde la cadena:", error);
  }
  updateWalletUi();
}

function formatCooldown(remainingMs) {
  const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = String(remainingSeconds % 60).padStart(2, "0");
  return minutes > 0 ? `${minutes} min ${seconds} s` : `${remainingSeconds} s`;
}

function cooldownNoteText(cooldownUntil) {
  const remaining = cooldownUntil - Date.now();
  const availableAt = new Date(cooldownUntil).toLocaleTimeString("es-CL", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Esta cuenta ya tiene una solicitud registrada en la última hora (límite del contrato). Podrás pagar de nuevo en ${formatCooldown(remaining)} · a las ${availableAt}.`;
}

function syncCooldownTimer(accountId, cooldownUntil) {
  if (cooldownUntil > Date.now()) {
    cooldownAccountId = accountId;
    if (!cooldownTimer) {
      cooldownTimer = window.setInterval(() => {
        const until = getRequestCooldownUntil(cooldownAccountId);
        if (until > Date.now()) {
          agentApiNote.textContent = cooldownNoteText(until);
        } else {
          window.clearInterval(cooldownTimer);
          cooldownTimer = undefined;
          updateWalletUi();
        }
      }, 1000);
    }
  } else if (cooldownTimer) {
    window.clearInterval(cooldownTimer);
    cooldownTimer = undefined;
  }
}

function getRequestHistory(accountId) {
  if (!accountId) return [];
  if (requestHistoryCache.has(accountId)) {
    return requestHistoryCache.get(accountId);
  }

  try {
    const stored = window.localStorage.getItem(
      `${REQUEST_HISTORY_STORAGE_PREFIX}${accountId}`,
    );
    const entries = stored ? JSON.parse(stored) : [];
    if (!Array.isArray(entries)) {
      throw new Error("El formato del historial local no es válido.");
    }
    const history = entries.filter(
      (entry) =>
        entry &&
        entry.wallet === accountId &&
        typeof entry.requestId === "string" &&
        typeof entry.query === "string" &&
        HISTORY_STATUSES.has(entry.status) &&
        typeof entry.date === "string",
    );
    requestHistoryCache.set(accountId, history);
    historyStorageErrors.delete(accountId);
    return history;
  } catch (error) {
    console.error("No se pudo leer el historial local:", error);
    requestHistoryCache.set(accountId, []);
    historyStorageErrors.set(accountId, "No se pudo leer el historial local de esta wallet.");
    return [];
  }
}

function saveRequestHistory(accountId, entries) {
  const sortedEntries = entries
    .sort((left, right) => Date.parse(right.date) - Date.parse(left.date))
    .slice(0, MAX_HISTORY_ENTRIES);
  requestHistoryCache.set(accountId, sortedEntries);
  try {
    window.localStorage.setItem(
      `${REQUEST_HISTORY_STORAGE_PREFIX}${accountId}`,
      JSON.stringify(sortedEntries),
    );
    historyStorageErrors.delete(accountId);
    return true;
  } catch (error) {
    console.error("No se pudo guardar el historial local:", error);
    historyStorageErrors.set(accountId, "No se pudo guardar en este navegador; el historial solo se conserva en esta sesión.");
    return false;
  }
}

function renderHistory(accountId) {
  historyList.replaceChildren();
  historyStorageNote.hidden = true;
  historyEmpty.hidden = false;
  historyList.hidden = true;

  if (!accountId) {
    historyWallet.textContent = "Conecta una wallet para ver su historial";
    historyEmpty.textContent = "Las consultas de la wallet conectada aparecerán aquí.";
    return;
  }

  historyWallet.textContent = accountId;
  const entries = getRequestHistory(accountId);
  const storageError = historyStorageErrors.get(accountId);
  if (storageError) {
    historyStorageNote.textContent = storageError;
    historyStorageNote.hidden = false;
  }
  if (entries.length === 0) {
    historyEmpty.textContent = "Esta wallet todavía no tiene consultas guardadas en este navegador.";
    return;
  }

  historyEmpty.hidden = true;
  historyList.hidden = false;
  const statusLabels = {
    pending: "Pendiente",
    completed: "Completada",
    failed: "Fallida",
    under_review: "En revisión",
  };
  for (const entry of entries) {
    const item = document.createElement("li");
    item.className = "history-entry";

    const header = document.createElement("div");
    header.className = "history-entry-header";
    const status = document.createElement("span");
    status.className = "history-status";
    status.dataset.state = entry.status;
    status.textContent = statusLabels[entry.status];
    if (entry.status === "pending" && RESULT_PROGRESS_LABELS[entry.stage]) {
      status.textContent = `Pendiente · ${RESULT_PROGRESS_LABELS[entry.stage]}`;
    }
    const date = document.createElement("time");
    date.className = "history-date";
    date.dateTime = entry.date;
    const parsedDate = new Date(entry.date);
    date.textContent = Number.isNaN(parsedDate.getTime())
      ? entry.date
      : parsedDate.toLocaleString();
    header.append(status, date);

    const query = document.createElement("p");
    query.className = "history-query";
    query.textContent = entry.query;

    const requestId = document.createElement("p");
    requestId.className = "history-id";
    requestId.textContent = `Request ID: ${entry.requestId}`;
    item.append(header, query, requestId);

    if (entry.status === "pending" && RESULT_PROGRESS_LABELS[entry.stage]) {
      const stageLine = document.createElement("p");
      stageLine.className = "history-stage";
      const updated = entry.stageUpdatedAt || entry.date;
      const parsedUpdate = new Date(updated);
      const updateLabel = Number.isNaN(parsedUpdate.getTime())
        ? ""
        : ` · actualizado a las ${parsedUpdate.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
      stageLine.textContent = `Etapa: ${RESULT_PROGRESS_LABELS[entry.stage]}${updateLabel}`;
      item.append(stageLine);
    }

    if (typeof entry.resultMessage === "string" && entry.resultMessage) {
      const resultText = document.createElement("p");
      resultText.className = "history-result";
      resultText.textContent = entry.resultMessage;
      item.append(resultText);
    }

    if (entry.transactionHash) {
      const transaction = document.createElement("a");
      transaction.className = "history-transaction";
      transaction.href = `${EXPLORER_URL}${encodeURIComponent(entry.transactionHash)}`;
      transaction.target = "_blank";
      transaction.rel = "noopener noreferrer";
      transaction.textContent = "Ver transacción en NEAR Explorer";
      item.append(transaction);
    }
    historyList.append(item);
  }
}

function updateHistoryEntry(accountId, requestId, changes) {
  const entries = getRequestHistory(accountId);
  const index = entries.findIndex((entry) => entry.requestId === requestId);
  if (index === -1) return;

  entries[index] = { ...entries[index], ...changes, wallet: accountId, requestId };
  saveRequestHistory(accountId, entries);
  if (getActiveAccountId() === accountId) renderHistory(accountId);
}

function addHistoryEntry(entry) {
  const entries = getRequestHistory(entry.wallet);
  entries.push(entry);
  saveRequestHistory(entry.wallet, entries);
  if (getActiveAccountId() === entry.wallet) renderHistory(entry.wallet);
}

function notifyAgent(requestId, transactionHash, accountId) {
  if (!transactionHash) return;
  void fetch(`${AGENT_API_URL}/api/notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: requestId,
      tx_hash: transactionHash,
      sender_account_id: accountId,
    }),
    signal: AbortSignal.timeout(10000),
  }).then((response) => {
    if (!response.ok) {
      throw new Error(`Notification endpoint responded HTTP ${response.status}`);
    }
  }).catch((error) => {
    console.warn("Agent notification failed; the agent can still scan the chain:", error);
  });
}

// Returns the agent's view of a request, {status: "not_found"} on 404, or
// null when the agent API is unreachable.
async function fetchAgentRequestStatus(requestId) {
  try {
    const response = await fetch(
      `${AGENT_API_URL}/api/requests/${encodeURIComponent(requestId)}`,
      { mode: "cors", cache: "no-store", signal: AbortSignal.timeout(5000) },
    );
    const result = await response.json().catch(() => null);
    if (response.status === 404) {
      return result && result.status === "waiting_for_event"
        ? result
        : { status: "not_found" };
    }
    if (!response.ok) return null;
    return result && typeof result.status === "string" ? result : null;
  } catch {
    return null;
  }
}

function agentResultMessage(result) {
  if (result.status === "completed") {
    return result.report || result.message || "El agente registró el recibo.";
  }
  return result.message || "";
}

// Returns the contract's status string, null when the request does not exist
// on chain, or undefined when the RPC could not be reached.
async function fetchChainRequestStatus(requestId) {
  try {
    const result = await rpcQuery({
      request_type: "call_function",
      finality: "final",
      account_id: CONTRACT_ID,
      method_name: "get_request_status",
      args_base64: bytesToBase64(new TextEncoder().encode(JSON.stringify({ request_id: requestId }))),
    });
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result)));
  } catch (error) {
    console.warn("No se pudo consultar el estado on-chain de la solicitud:", error);
    return undefined;
  }
}

function scheduleHistoryResume(delay = HISTORY_RESUME_INTERVAL_MS) {
  if (historyResumeTimer) window.clearTimeout(historyResumeTimer);
  historyResumeTimer = window.setTimeout(() => {
    historyResumeTimer = undefined;
    void resumePendingHistory(getActiveAccountId());
  }, delay);
}

// Keeps "pending" history entries moving after a reload or a wallet switch:
// asks the agent for the result, re-notifies it once per page load for paid
// requests it has not seen, and marks unsigned attempts that never reached
// the chain as failed.
async function resumePendingHistory(accountId) {
  if (!accountId || historyResumeRunning) return;
  historyResumeRunning = true;
  let stillPending = false;
  try {
    const now = Date.now();
    const pendingEntries = getRequestHistory(accountId).filter((entry) => {
      const age = now - Date.parse(entry.date);
      return (
        entry.status === "pending" &&
        !activeResultPolls.has(entry.requestId) &&
        Number.isFinite(age) &&
        age < PENDING_RESUME_MAX_AGE_MS
      );
    });
    for (const entry of pendingEntries) {
      if (getActiveAccountId() !== accountId) return;
      const result = await fetchAgentRequestStatus(entry.requestId);
      const stage = progressStageFromAgent(result, {
        hasTransactionHash: Boolean(entry.transactionHash),
        localStage: entry.stage,
      });
      const stageUpdatedAt = new Date().toISOString();
      if (result && FINAL_RESULT_STATUSES.has(result.status)) {
        const resultMessage =
          result.status === "failed"
            ? truncateResult(failedResultMessage(result))
            : truncateResult(agentResultMessage(result));
        updateHistoryEntry(accountId, entry.requestId, {
          status: result.status,
          resultMessage,
          stage,
          stageUpdatedAt,
        });
        if (canPaintRequest(accountId, entry.requestId) || resultProgressRequestId === entry.requestId) {
          showResultProgress({
            accountId,
            requestId: entry.requestId,
            transactionHash: entry.transactionHash,
            stage,
            message: resultMessage,
            startedAt: Date.parse(entry.date) || Date.now(),
            updatedAt: Date.now(),
          });
          showStatus(
            result.status === "completed"
              ? "Respuesta recibida"
              : result.status === "under_review"
                ? "En revisión humana"
                : "Revisar agente",
            result.status === "completed" ? "success" : "warning",
          );
        }
        continue;
      }
      if (stage) {
        updateHistoryEntry(accountId, entry.requestId, { stage, stageUpdatedAt });
      }
      if (entry.transactionHash) {
        stillPending = true;
        const agentHasNotSeenIt =
          result && (result.status === "not_found" || result.status === "waiting_for_event");
        if (agentHasNotSeenIt && !renotifiedRequests.has(entry.requestId)) {
          renotifiedRequests.add(entry.requestId);
          notifyAgent(entry.requestId, entry.transactionHash, accountId);
        }
        if (canPaintRequest(accountId, entry.requestId)) {
          showResultProgress({
            accountId,
            requestId: entry.requestId,
            transactionHash: entry.transactionHash,
            stage: stage || "verificando",
            message:
              (result && result.message) ||
              "Pago confirmado en NEAR testnet. El agente procesará la consulta; el historial se actualizará solo.",
            startedAt: Date.parse(entry.date) || Date.now(),
            updatedAt: Date.now(),
          });
          showStatus(
            stage === "en_cola"
              ? "Consulta en cola del agente…"
              : stage === "procesando"
                ? "Procesando consulta…"
                : stage === "registrando"
                  ? "Registrando recibo en la cadena…"
                  : "Pago confirmado · esperando agente",
            "pending",
          );
        }
        continue;
      }
      if (now - Date.parse(entry.date) < PENDING_UNSIGNED_STALE_MS) {
        stillPending = true;
        continue;
      }
      const chainStatus = await fetchChainRequestStatus(entry.requestId);
      if (chainStatus === null) {
        updateHistoryEntry(accountId, entry.requestId, {
          status: "failed",
          resultMessage: "La transacción no llegó a la cadena; esta consulta no se cobró.",
        });
      } else {
        stillPending = true;
      }
    }
  } finally {
    historyResumeRunning = false;
  }
  if (stillPending && getActiveAccountId() === accountId) scheduleHistoryResume();
}

function collectTransactionHashes(source) {
  const hashes = [];
  const push = (value) => {
    if (typeof value === "string") {
      for (const part of value.split(/[,\s]+/u)) {
        const hash = part.trim();
        if (hash && !hashes.includes(hash)) hashes.push(hash);
      }
      return;
    }
    if (Array.isArray(value)) value.forEach(push);
  };
  if (typeof source === "string" || Array.isArray(source)) {
    push(source);
    return hashes;
  }
  if (!source || typeof source !== "object") return hashes;
  push(source.transaction?.hash);
  push(source.transaction_outcome?.id);
  push(source.transactionOutcome?.id);
  push(source.transaction_hash);
  push(source.transactionHash);
  push(source.transactionHashes);
  push(source.transaction_hashes);
  return hashes;
}

function extractRequestServiceArgs(tx) {
  const call = tx?.transaction?.actions
    ?.map((action) => action?.FunctionCall)
    .find((functionCall) => functionCall?.method_name === "request_service");
  if (!call || tx.transaction.receiver_id !== CONTRACT_ID) return null;
  try {
    const args = JSON.parse(new TextDecoder().decode(base64ToBytes(call.args)));
    return typeof args.request_id === "string" ? args : null;
  } catch {
    return null;
  }
}

async function resolveTransactionHashForRequest(candidates, requestId, accountId) {
  for (const hash of candidates) {
    try {
      const tx = await fetchTransaction(hash, accountId);
      const args = extractRequestServiceArgs(tx);
      if (args?.request_id === requestId && !tx.status?.Failure) {
        return { hash, tx, args };
      }
    } catch (error) {
      console.warn("No se pudo verificar un hash de transacción devuelto por la wallet:", error);
    }
  }
  return null;
}

async function pickTransactionHashForRequest(candidates, requestId, accountId) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { hash: "", verified: false };
  }
  if (candidates.length === 1) {
    try {
      const tx = await fetchTransaction(candidates[0], accountId);
      const args = extractRequestServiceArgs(tx);
      if (args?.request_id === requestId && !tx.status?.Failure) {
        return { hash: candidates[0], verified: true, tx, args };
      }
      return { hash: "", verified: false, mismatch: true };
    } catch {
      return { hash: candidates[0], verified: false };
    }
  }
  const matched = await resolveTransactionHashForRequest(candidates, requestId, accountId);
  return matched
    ? { hash: matched.hash, verified: true, tx: matched.tx, args: matched.args }
    : { hash: "", verified: false };
}

async function fetchTransaction(transactionHash, accountId) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "orbithire",
      method: "tx",
      params: {
        tx_hash: transactionHash,
        sender_account_id: accountId,
        wait_until: "EXECUTED_OPTIMISTIC",
      },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`RPC respondió HTTP ${response.status}`);
  const body = await response.json();
  if (body.error || !body.result) throw new Error(body.error?.message || "transacción no encontrada");
  return body.result;
}

// Handles wallets that complete signAndSendTransaction with a full-page
// redirect back to this site (?transactionHashes=… or ?errorCode=…).
async function handleWalletRedirect() {
  const url = new URL(window.location.href);
  const hashes = url.searchParams.get("transactionHashes");
  const errorCode = url.searchParams.get("errorCode");
  if (!hashes && !errorCode) return;
  for (const key of ["transactionHashes", "errorCode", "errorMessage"]) {
    url.searchParams.delete(key);
  }
  window.history.replaceState(window.history.state, "", url.toString());

  const accountId = getActiveAccountId();
  if (!accountId) return;
  if (errorCode) {
    const now = Date.now();
    const latestUnsigned = getRequestHistory(accountId).find(
      (entry) =>
        entry.status === "pending" &&
        !entry.transactionHash &&
        now - Date.parse(entry.date) < PENDING_UNSIGNED_STALE_MS * 2,
    );
    if (latestUnsigned) {
      updateHistoryEntry(accountId, latestUnsigned.requestId, { status: "failed" });
    }
    showStatus("Pago cancelado o fallido", "warning");
    showMessage("La wallet no confirmó el pago. Si no aprobaste la transacción, no se envió ninguna consulta.");
    return;
  }

  for (const transactionHash of collectTransactionHashes(hashes)) {
    try {
      const tx = await fetchTransaction(transactionHash, accountId);
      const args = extractRequestServiceArgs(tx);
      if (!args) continue;
      const succeeded = !tx.status?.Failure;
      const existing = getRequestHistory(accountId).find((entry) => entry.requestId === args.request_id);
      const alreadyFinal = existing && FINAL_RESULT_STATUSES.has(existing.status);
      const stage = succeeded ? "pago_enviado" : "failed";
      const stageUpdatedAt = new Date().toISOString();
      if (existing) {
        updateHistoryEntry(accountId, args.request_id, {
          transactionHash,
          status: succeeded ? existing.status : "failed",
          ...(alreadyFinal ? {} : { stage, stageUpdatedAt }),
        });
      } else {
        addHistoryEntry({
          requestId: args.request_id,
          wallet: accountId,
          query: typeof args.query === "string" ? args.query : "",
          status: succeeded ? "pending" : "failed",
          transactionHash,
          date: new Date().toISOString(),
          stage,
          stageUpdatedAt,
        });
      }
      if (succeeded && !alreadyFinal) {
        recordRequestCooldown(accountId);
        notifyAgent(args.request_id, transactionHash, accountId);
        renotifiedRequests.add(args.request_id);
        showStatus("Pago confirmado · esperando agente", "pending");
        showResultProgress({
          accountId,
          requestId: args.request_id,
          transactionHash,
          stage: "pago_enviado",
          message:
            "Pago confirmado en NEAR testnet. El agente observa la cadena y procesará la consulta automáticamente.",
          startedAt: Date.now(),
        });
        void watchRequestResult(args.request_id, accountId, transactionHash);
      }
    } catch (error) {
      console.warn("No se pudo procesar la transacción devuelta por la wallet:", error);
    }
  }
  updateWalletUi();
  scheduleHistoryResume(3000);
}

function updateWalletUi() {
  const signedIn = Boolean(walletSelector?.isSignedIn());
  const accountId = signedIn
    ? walletSelector.store.getState().accounts[0]?.accountId
    : "";
  if (accountId !== uiAccountId) {
    const previousAccountId = uiAccountId;
    uiAccountId = accountId;
    // Never leave another wallet's result or history on screen.
    if (previousAccountId !== null) {
      resetResultPanel();
      if (!isSubmitting) {
        showStatus(accountId ? "Meteor Wallet conectada · testnet" : "Conecta Meteor Wallet · testnet");
      }
    }
    if (accountId) scheduleHistoryResume(500);
  }
  renderHistory(accountId);
  if (accountId && !chainCooldowns.has(accountId) && !chainCooldownRequests.has(accountId)) {
    chainCooldownRequests.add(accountId);
    void refreshChainCooldown(accountId).finally(() => chainCooldownRequests.delete(accountId));
  }
  const cooldownUntil = getRequestCooldownUntil(accountId);
  const cooldownRemaining = Math.max(0, cooldownUntil - Date.now());
  walletButton.disabled = !walletReady;
  submitButton.disabled =
    !signedIn ||
    !agentApiConfigured ||
    !agentHealthReady ||
    cooldownRemaining > 0 ||
    isPreparingPayment ||
    isSubmitting;
  if (signedIn) {
    const connectedAccountId = accountId || "Wallet conectada";
    walletButton.textContent = `${connectedAccountId.slice(0, 11)}… · Salir`;
  } else {
    walletButton.textContent = "Conectar Meteor Wallet";
  }
  syncCooldownTimer(accountId, cooldownUntil);
  if (cooldownRemaining > 0) {
    agentApiNote.textContent = cooldownNoteText(cooldownUntil);
  } else if (agentApiStatusText) {
    agentApiNote.textContent = agentApiStatusText;
  }
}

function setAgentApiStatusText(text) {
  agentApiStatusText = text;
  agentApiNote.textContent = text;
}

function scheduleAgentHealthRetry() {
  if (agentHealthRetryTimer) return;
  agentHealthRetryTimer = window.setTimeout(() => {
    agentHealthRetryTimer = undefined;
    void checkAgentHealth();
  }, AGENT_HEALTH_RETRY_MS);
}

// Resolves to true only when this check actually reached a healthy agent.
// Background re-checks never disable the pay button while they are in flight,
// and a single transient failure after a good check keeps the last good state
// (with a quick retry) instead of blocking payments for 30 seconds.
function checkAgentHealth() {
  if (!agentApiConfigured) {
    agentHealthReady = false;
    setAgentApiStatusText(
      "La URL HTTPS del agente es un placeholder. Configúrala antes de habilitar pagos.",
    );
    showStatus("API del agente pendiente de despliegue", "warning");
    updateWalletUi();
    return Promise.resolve(false);
  }
  if (agentHealthCheckPromise) return agentHealthCheckPromise;

  agentHealthCheckInProgress = true;
  agentHealthCheckPromise = (async () => {
    const wasReady = agentHealthReady;
    try {
      const response = await fetch(`${AGENT_API_URL}/health`, {
        mode: "cors",
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw new Error(`El servicio respondió HTTP ${response.status}`);
      }
      const health = await response.json();
      if (health.ok !== true || health.network !== NETWORK_ID) {
        throw new Error("El servicio no confirmó que está disponible en NEAR testnet");
      }
      agentHealthReady = true;
      agentHealthConsecutiveFailures = 0;
      setAgentApiStatusText("API HTTPS del agente disponible · NEAR testnet.");
      // Only replace the status label when recovering; otherwise a routine
      // re-check would overwrite "Respuesta recibida" or similar every 30 s.
      if (!wasReady && walletReady && !isSubmitting) {
        showStatus(
          walletSelector.isSignedIn()
            ? "Meteor Wallet conectada · testnet"
            : "Conecta Meteor Wallet · testnet",
        );
      }
      return true;
    } catch (error) {
      agentHealthConsecutiveFailures += 1;
      if (wasReady && agentHealthConsecutiveFailures < AGENT_HEALTH_FAILURES_BEFORE_BLOCK) {
        console.warn("Fallo transitorio de /health; se reintenta en unos segundos:", error);
        scheduleAgentHealthRetry();
        return false;
      }
      agentHealthReady = false;
      setAgentApiStatusText(
        `API HTTPS del agente no disponible: ${error.message}. El pago permanece deshabilitado; se reintenta automáticamente.`,
      );
      if (!isSubmitting) showStatus("API del agente no disponible", "warning");
      // Retry quickly a few times, then fall back to the 30 s interval.
      if (agentHealthConsecutiveFailures < 4) scheduleAgentHealthRetry();
      return false;
    } finally {
      agentHealthCheckInProgress = false;
      agentHealthCheckPromise = undefined;
      updateWalletUi();
    }
  })();
  return agentHealthCheckPromise;
}

async function ensureAgentHealthyBeforePayment() {
  if (await checkAgentHealth()) return true;
  await pause(1500);
  return checkAgentHealth();
}

async function initializeWallet() {
  const [core, meteor] = await Promise.all([
    import("https://cdn.jsdelivr.net/npm/@near-wallet-selector/core@10.1.4/+esm"),
    import("https://cdn.jsdelivr.net/npm/@near-wallet-selector/meteor-wallet@10.1.4/+esm"),
  ]);
  actionCreators = core.actionCreators;
  setupWalletSelector = core.setupWalletSelector;
  setupMeteorWallet = meteor.setupMeteorWallet;
  if (
    typeof setupWalletSelector !== "function" ||
    typeof setupMeteorWallet !== "function" ||
    !actionCreators?.functionCall
  ) {
    throw new Error("El CDN cargó módulos incompatibles: faltan exports de Wallet Selector 10.1.4.");
  }
  walletSelector = await setupWalletSelector({
    network: {
      networkId: NETWORK_ID,
      nodeUrl: RPC_URL,
      helperUrl: "https://helper.testnet.near.org",
      explorerUrl: "https://explorer.testnet.near.org",
      indexerUrl: "https://test.api.fastnear.com/v0",
    },
    modules: [setupMeteorWallet()],
  });
  const meteorModule = walletSelector.store
    .getState()
    .modules.find((module) => module.id === "meteor-wallet");
  if (!meteorModule) {
    throw new Error("Wallet Selector inició, pero no registró el módulo Meteor Wallet.");
  }
  if (!meteorModule.metadata.available) {
    throw new Error("El módulo Meteor Wallet está registrado, pero no está disponible en este navegador.");
  }
  meteorWallet = await meteorModule.wallet();
  if (!meteorWallet) {
    throw new Error("Wallet Selector no pudo crear la instancia de Meteor Wallet.");
  }
  walletReady = true;
  walletSelector.on("signedIn", updateWalletUi);
  walletSelector.on("signedOut", updateWalletUi);
  walletSelector.on("accountsChanged", updateWalletUi);
  updateWalletUi();
}

function startMeteorWalletAction(action) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return action();
  } finally {
    console.log = originalLog;
  }
}

function handleWalletError(error) {
  showStatus("No se pudo conectar Meteor Wallet", "warning");
  showMessage(`No se pudo conectar Meteor Wallet: ${error.message}`);
}

function connectWallet() {
  if (!walletReady || !walletSelector || !meteorWallet) {
    showStatus("Meteor Wallet no está lista", "warning");
    showMessage(
      "No se puede abrir Meteor Wallet porque su inicialización no terminó. Revisa el error mostrado y recarga la página después de verificar conexión y extensiones.",
    );
    return;
  }
  if (walletSelector.isSignedIn()) {
    showStatus("Desconectando Meteor Wallet", "pending");
    meteorWallet.signOut()
      .then(() => {
        updateWalletUi();
        showStatus("Meteor Wallet desconectada · testnet");
      })
      .catch(handleWalletError);
    return;
  }
  showStatus("Abriendo Meteor Wallet · testnet", "pending");
  startMeteorWalletAction(() =>
    meteorWallet.signIn({
      contractId: CONTRACT_ID,
      methodNames: ["request_service"],
    }),
  )
    .then(() => {
      updateWalletUi();
      showStatus("Meteor Wallet conectada · testnet", "success");
    })
    .catch(handleWalletError);
}

function getTransactionHash(outcome) {
  return collectTransactionHashes(outcome)[0] || "";
}

function statusLabelForStage(stage, fallbackStatus) {
  if (stage === "en_cola") return "Consulta en cola del agente…";
  if (stage === "procesando") return "Procesando consulta…";
  if (stage === "registrando") return "Registrando recibo en la cadena…";
  if (stage === "verificando") return "Verificando el pago en la cadena…";
  if (stage === "pago_enviado") return "Pago confirmado · esperando agente";
  if (stage === "completado") return "Respuesta recibida";
  if (stage === "under_review") return "En revisión humana";
  if (stage === "failed") return "Revisar agente";
  if (fallbackStatus === "queued") return "Consulta en cola del agente…";
  if (fallbackStatus === "pending") return "Agente procesando";
  return "Procesando consulta…";
}

function pause(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function pollAgentResult(requestId, accountId, transactionHash = "", startedAt = Date.now()) {
  let consecutiveErrors = 0;
  for (let attempt = 0; attempt < RESULT_POLL_ATTEMPTS; attempt += 1) {
    await pause(RESULT_POLL_INTERVAL_MS);
    const result = await fetchAgentRequestStatus(requestId);
    if (!result) {
      // Tolerate short network or agent hiccups instead of giving up at once.
      consecutiveErrors += 1;
      if (consecutiveErrors >= 3) {
        return {
          status: "unreachable",
          message:
            "No se pudo consultar la API HTTPS del agente. El pago permanece en testnet; el historial seguirá revisando esta consulta. Conserva el request ID y no vuelvas a pagar.",
        };
      }
      continue;
    }
    consecutiveErrors = 0;
    const stage = progressStageFromAgent(result, { hasTransactionHash: Boolean(transactionHash) });
    const finalMessage =
      result.status === "failed" ? failedResultMessage(result) : agentResultMessage(result);
    if (stage) {
      updateHistoryEntry(accountId, requestId, {
        stage,
        stageUpdatedAt: new Date().toISOString(),
        ...(FINAL_RESULT_STATUSES.has(result.status)
          ? {}
          : result.message
            ? { resultMessage: truncateResult(result.message) }
            : {}),
      });
    }
    if (canPaintRequest(accountId, requestId) || resultProgressRequestId === requestId) {
      if (result.status !== "not_found" || transactionHash) {
        showResultProgress({
          accountId,
          requestId,
          transactionHash,
          stage: stage || "verificando",
          message:
            FINAL_RESULT_STATUSES.has(result.status)
              ? finalMessage
              : result.message ||
                "Pago confirmado en NEAR testnet. El agente observa la cadena y procesará la consulta automáticamente.",
          startedAt,
          updatedAt: Date.now(),
        });
      }
      if (FINAL_RESULT_STATUSES.has(result.status)) {
        showStatus(
          statusLabelForStage(stage, result.status),
          result.status === "completed" ? "success" : "warning",
        );
      } else if (result.status !== "not_found" || transactionHash) {
        showStatus(statusLabelForStage(stage, result.status), "pending");
      }
    }
    if (FINAL_RESULT_STATUSES.has(result.status)) {
      return { status: result.status, message: finalMessage, stage };
    }
  }
  return {
    status: "pending",
    stage: resultProgressRequestId === requestId ? resultProgressStage : "verificando",
    message:
      "El agente todavía procesa la solicitud. El historial seguirá revisándola automáticamente; conserva el request ID y el hash y no vuelvas a pagar esta consulta.",
  };
}

async function watchRequestResult(requestId, accountId, transactionHash, startedAt = Date.now()) {
  if (!requestId || activeResultPolls.has(requestId)) return;
  activeResultPolls.add(requestId);
  try {
    const result = await pollAgentResult(requestId, accountId, transactionHash, startedAt);
    const historyStatus = FINAL_RESULT_STATUSES.has(result.status) ? result.status : "pending";
    const stage =
      result.stage ||
      progressStageFromAgent(result, { hasTransactionHash: Boolean(transactionHash) });
    updateHistoryEntry(accountId, requestId, {
      status: historyStatus,
      transactionHash,
      stage: stage || undefined,
      stageUpdatedAt: new Date().toISOString(),
      ...(historyStatus === "pending" ? {} : { resultMessage: truncateResult(result.message) }),
    });
    if (historyStatus === "pending") scheduleHistoryResume();
    if (canPaintRequest(accountId, requestId) || resultProgressRequestId === requestId) {
      showStatus(
        result.status === "unreachable"
          ? "Revisar agente"
          : statusLabelForStage(stage, result.status),
        result.status === "completed" ? "success" : result.status === "pending" ? "pending" : "warning",
      );
      showResultProgress({
        accountId,
        requestId,
        transactionHash,
        stage: historyStatus === "pending" ? stage || "verificando" : historyStatus === "failed" ? "failed" : stage || historyStatus,
        message: result.message,
        startedAt,
        updatedAt: Date.now(),
      });
      if (result.message) {
        // Keep request/tx metadata in the panel even after the poll ends.
        showMessage(result.message, requestId, transactionHash);
        if (stage || historyStatus === "pending") {
          showResultProgress({
            accountId,
            requestId,
            transactionHash,
            stage: historyStatus === "pending" ? stage || "verificando" : historyStatus === "failed" ? "failed" : stage || historyStatus,
            message: result.message,
            startedAt,
            updatedAt: Date.now(),
          });
        }
      }
    }
  } finally {
    activeResultPolls.delete(requestId);
  }
}

async function submitQuery() {
  if (isSubmitting || isPreparingPayment) return;
  if (!agentApiConfigured) {
    showStatus("API del agente no configurada", "warning");
    showMessage(
      "El endpoint HTTPS del agente aún no está configurado. No se puede iniciar un pago hasta desplegar y configurar el agente.",
    );
    return;
  }
  if (!walletSelector?.isSignedIn()) {
    showMessage("Conecta primero Meteor Wallet en NEAR testnet.");
    return;
  }
  const accountId = walletSelector.store.getState().accounts[0]?.accountId;
  if (!accountId) {
    showStatus("No se pudo identificar la cuenta conectada", "warning");
    showMessage("Desconecta y vuelve a conectar Meteor Wallet antes de enviar una solicitud.");
    return;
  }
  isPreparingPayment = true;
  updateWalletUi();
  try {
    await refreshChainCooldown(accountId);
  } finally {
    isPreparingPayment = false;
  }
  const cooldownUntil = getRequestCooldownUntil(accountId);
  if (cooldownUntil > Date.now()) {
    showStatus("Límite de solicitudes activo", "warning");
    showMessage(
      `El contrato permite una solicitud por cuenta cada hora. ${cooldownNoteText(cooldownUntil)}`,
    );
    updateWalletUi();
    return;
  }
  const query = queryInput.value.trim();
  if (!query || [...query].length > 500) {
    showMessage("Escribe una consulta de entre 1 y 500 caracteres.");
    queryInput.focus();
    return;
  }
  isPreparingPayment = true;
  updateWalletUi();
  let agentHealthy = false;
  try {
    agentHealthy = await ensureAgentHealthyBeforePayment();
  } finally {
    isPreparingPayment = false;
    updateWalletUi();
  }
  if (!agentHealthy) {
    showMessage(
      "La API HTTPS del agente no respondió correctamente en /health. No se envió ningún pago; inténtalo de nuevo cuando el agente esté disponible.",
    );
    return;
  }

  const requestId = window.crypto.randomUUID().toLowerCase();
  addHistoryEntry({
    requestId,
    wallet: accountId,
    query,
    status: "pending",
    transactionHash: "",
    date: new Date().toISOString(),
    stage: "pago_enviado",
    stageUpdatedAt: new Date().toISOString(),
  });
  isSubmitting = true;
  updateWalletUi();
  submitButton.querySelector("span").textContent = "Esperando aprobación…";
  showStatus("Confirma el pago en tu wallet", "pending");
  showMessage("La wallet abrirá una transacción de 0.1 NEAR exactos en NEAR testnet.", requestId);

  let transactionHash = "";
  let paymentConfirmed = false;
  // The user may switch or sign out of the wallet while the agent works; only
  // paint results for the account that made the request.
  const statusForAccount = (...args) => {
    if (getActiveAccountId() === accountId) showStatus(...args);
  };
  const messageForAccount = (...args) => {
    if (getActiveAccountId() === accountId) showMessage(...args);
  };
  activeResultPolls.add(requestId);
  try {
    const outcome = await meteorWallet.signAndSendTransaction({
      receiverId: CONTRACT_ID,
      actions: [
        actionCreators.functionCall(
          "request_service",
          { request_id: requestId, query },
          BigInt(REQUEST_GAS),
          BigInt(FEE_YOCTO),
        ),
      ],
    });
    const chainFailure = outcome?.status?.Failure;
    if (chainFailure) {
      transactionHash = getTransactionHash(outcome);
      const failureError = new Error(
        `La transacción falló en la cadena: ${JSON.stringify(chainFailure)}`,
      );
      failureError.chainFailure = true;
      throw failureError;
    }
    const picked = await pickTransactionHashForRequest(
      collectTransactionHashes(outcome),
      requestId,
      accountId,
    );
    transactionHash = picked.hash;
    if (picked.mismatch) {
      console.warn(
        "Ningún hash devuelto por la wallet coincide con el request_id de esta consulta; no se envía la notificación.",
      );
    }
    recordRequestCooldown(accountId);
    updateHistoryEntry(accountId, requestId, {
      transactionHash,
      stage: "pago_enviado",
      stageUpdatedAt: new Date().toISOString(),
    });
    paymentConfirmed = true;
    if (transactionHash) {
      notifyAgent(requestId, transactionHash, accountId);
      renotifiedRequests.add(requestId);
    }
    updateWalletUi();
    statusForAccount("Pago confirmado · esperando agente", "pending");
    messageForAccount(
      "Pago confirmado en NEAR testnet. El agente observa la cadena y procesará la consulta automáticamente.",
      requestId,
      transactionHash,
    );
    showResultProgress({
      accountId,
      requestId,
      transactionHash,
      stage: "pago_enviado",
      message:
        "Pago confirmado en NEAR testnet. El agente observa la cadena y procesará la consulta automáticamente.",
      startedAt: Date.now(),
    });

    const paidAt = Date.now();
    const result = await pollAgentResult(requestId, accountId, transactionHash, paidAt);
    const historyStatus = FINAL_RESULT_STATUSES.has(result.status) ? result.status : "pending";
    const stage =
      result.stage ||
      progressStageFromAgent(result, { hasTransactionHash: Boolean(transactionHash) });
    updateHistoryEntry(accountId, requestId, {
      status: historyStatus,
      transactionHash,
      stage: stage || undefined,
      stageUpdatedAt: new Date().toISOString(),
      ...(historyStatus === "pending" ? {} : { resultMessage: truncateResult(result.message) }),
    });
    if (historyStatus === "pending") scheduleHistoryResume();
    statusForAccount(
      result.status === "unreachable"
        ? "Revisar agente"
        : statusLabelForStage(stage, result.status),
      result.status === "completed" ? "success" : result.status === "pending" ? "pending" : "warning",
    );
    messageForAccount(result.message, requestId, transactionHash);
    if (getActiveAccountId() === accountId) {
      showResultProgress({
        accountId,
        requestId,
        transactionHash,
        stage:
          historyStatus === "pending"
            ? stage || "verificando"
            : historyStatus === "failed"
              ? "failed"
              : stage || historyStatus,
        message: result.message,
        startedAt: paidAt,
        updatedAt: Date.now(),
      });
    }
  } catch (error) {
    const errorMessage = error.message || String(error);
    const rateLimited = /rate limit exceeded/i.test(errorMessage);
    if (rateLimited) void refreshChainCooldown(accountId);
    if (error.chainFailure) {
      updateHistoryEntry(accountId, requestId, { status: "failed", transactionHash });
      statusForAccount("El contrato rechazó la solicitud", "warning");
      messageForAccount(
        rateLimited
          ? "El contrato rechazó la llamada: esta cuenta ya tiene una solicitud en la última hora. El depósito se devuelve automáticamente; espera a que venza el límite."
          : `El contrato rechazó la llamada; el depósito se devuelve automáticamente. ${errorMessage}`,
        requestId,
        transactionHash,
      );
    } else if (transactionHash || paymentConfirmed) {
      updateHistoryEntry(accountId, requestId, {
        status: "pending",
        transactionHash,
      });
      scheduleHistoryResume();
      statusForAccount("Transacción enviada · resultado incierto", "warning");
      messageForAccount(
        `No se pudo confirmar la respuesta desde el navegador (${error.message}). Comprueba la transacción en el explorador antes de repetir; no vuelvas a pagar a ciegas.`,
        requestId,
        transactionHash,
      );
    } else {
      updateHistoryEntry(accountId, requestId, { status: "failed" });
      statusForAccount("Pago cancelado o fallido", "warning");
      const contractTrap =
        rateLimited || /WebAssembly trap|unreachable opcode|Smart contract panicked/i.test(errorMessage);
      messageForAccount(
        contractTrap
          ? `El contrato rechazó la llamada. Cada intento usa un request_id nuevo, pero OrbitHire acepta una solicitud por cuenta cada hora. Si esta cuenta ya tuvo una solicitud exitosa en la última hora, espera a que venza ese límite. ${errorMessage}`
          : `La wallet no confirmó el pago. Si no aprobaste la transacción, no se envió ninguna consulta. ${errorMessage}`,
        requestId,
      );
    }
  } finally {
    activeResultPolls.delete(requestId);
    isSubmitting = false;
    submitButton.querySelector("span").textContent = "Pagar y consultar";
    updateWalletUi();
  }
}

queryInput.addEventListener("input", () => {
  charCount.textContent = `${[...queryInput.value].length} / 500`;
});
walletButton.addEventListener("click", connectWallet);
submitButton.addEventListener("click", () => {
  submitQuery().catch((error) => {
    showStatus("Error", "warning");
    showMessage(`No se pudo completar la solicitud: ${error.message}`);
  });
});
window.addEventListener("storage", (event) => {
  if (event.key?.startsWith(REQUEST_COOLDOWN_STORAGE_PREFIX)) {
    updateWalletUi();
  }
  if (event.key?.startsWith(REQUEST_HISTORY_STORAGE_PREFIX)) {
    const accountId = getActiveAccountId();
    if (accountId && event.key === `${REQUEST_HISTORY_STORAGE_PREFIX}${accountId}`) {
      requestHistoryCache.delete(accountId);
      renderHistory(accountId);
    }
  }
});

showStatus("Conectando con NEAR testnet", "pending");
initializeWallet()
  .then(async () => {
    await handleWalletRedirect();
    if (agentHealthReady) {
      showStatus(
        walletSelector.isSignedIn()
          ? "Meteor Wallet conectada · testnet"
          : "Conecta Meteor Wallet · testnet",
      );
    }
  })
  .catch((error) => {
    walletReady = false;
    walletButton.disabled = true;
    showStatus("No se pudo inicializar Meteor Wallet", "warning");
    showMessage(
      `No se pudo inicializar Meteor Wallet en NEAR ${NETWORK_ID}: ${error.message}. Comprueba que jsDelivr sea accesible y que la extensión esté habilitada; luego recarga la página.`,
    );
  });

void checkAgentHealth();
window.setInterval(() => {
  void checkAgentHealth();
}, AGENT_HEALTH_POLL_INTERVAL_MS);
