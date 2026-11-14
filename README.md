# OrbitHire

**Hire an autonomous space-data agent and pay it on NEAR, with an on-chain escrow and a verifiable receipt.**

OrbitHire is a NEAR **testnet** prototype for the NEAR HACKATHON **Agent Economy** track (`agents`).
A user connects Meteor Wallet, asks a space question and pays a fixed fee of 0.1 testnet NEAR. The fee stays in contract escrow. An off-chain agent verifies the payment on-chain, fetches real public data (NOAA SWPC or CelesTrak), produces a short report and records the report hash on-chain. Only then is the fee released to the agent. If the agent never delivers, the user can reclaim the fee after 24 hours.

- **Live demo:** https://drmessi007-ui.github.io/orbithire-frontend/ (NEAR testnet, Meteor Wallet)
- **Agent API:** https://agent.deosorno.cl (`GET /health`, `GET /api/requests/{request_id}`)
- **Contracts (testnet):** `orbit-hire.shortemail369.testnet` (public facade) and `orbit-treasury.shortemail369.testnet` (escrow)
- **Track:** Agent Economy (`agents`)

> Experimental testnet prototype, not audited. Do not use mainnet funds.

## What problem it solves

AI agents that sell a service need a way to get paid that does not require the buyer to trust them up front, and the buyer needs proof of what was delivered. OrbitHire shows a minimal pattern:

- the buyer pays into **escrow**, not to the agent;
- the agent is paid only after it commits a **report hash** on-chain (a receipt tied to the request);
- if the agent fails, the buyer can **refund** after a timeout;
- the agent **verifies the payment on-chain** itself instead of trusting the browser.

## Architecture

```
 Browser (frontend/)            NEAR testnet                         Agent (agent/, Node.js)
 ───────────────────            ────────────                         ───────────────────────
 Meteor Wallet signs  ───────►  orbit-hire.request_service           
 request_service(0.1 NEAR)      • checks fee, UUID v4, query         
                                • 1 request / account / hour         
                                • stores sha256(query), holds fee    
                                • emits `request_created` event ───► notified by POST /api/notify
                                                                     and by scanning blocks / contract state
                                                                     • re-reads the tx on-chain: success, target
                                                                       contract, exact fee, query hash
                                                                     • NEAR AI Cloud LLM: intent (allow-list) ─┐
                                                                     • NOAA SWPC Kp index  or  ISS pass over  │
                                                                       a Chilean city (CelesTrak + satellite.js)
                                                                     • NEAR AI Cloud LLM: prose from facts ───┘
                                                                       + deterministic "Verified data" footer
                                orbit-hire.submit_report  ◄───────── • signs with the agent account
                                • moves fee to orbit-treasury escrow
                                orbit-hire.confirm_report_received ◄ • confirms the same report hash
                                • treasury releases fee to agent
 polls GET /api/requests/{id} ◄─────────────────────────────────────  status + report
 shows stages, report, receipt
```

1. **Frontend** (`frontend/`): static HTML/CSS/JS on GitHub Pages. It uses NEAR Wallet Selector 10.1.4 with the Meteor Wallet module. It builds a `request_service` call with a fresh UUID v4 `request_id`, 0.1 NEAR deposit and the question. It holds no keys.
2. **OrbitHire contract** (`contracts/orbit-hire`): validates the exact fee, the canonical UUID v4, the query (non-empty, max 500 chars, allowlisted characters) and the per-account rate limit. It stores the SHA-256 of the query and holds the fee as a liability. It emits a NEP-297-style `request_created` event.
3. **Agent** (`agent/`): learns about requests from `POST /api/notify` (sent by the frontend after payment), from a finalized-block scanner, and from a periodic sweep of contract state. It never trusts the notification: it fetches the transaction and checks success, receiver contract, attached deposit against `get_fee`, request ID, and that `sha256(query)` matches the on-chain commitment. Then it builds the report:
   - questions about geomagnetic storms or space weather: latest planetary **Kp index** from `services.swpc.noaa.gov`;
   - questions about the ISS: next ISS pass above 10° over the Chilean city named in the question (Osorno if none is named) in the next 24 h, computed from **CelesTrak** orbital elements with `satellite.js`. Supported cities: Arica, Iquique, Antofagasta, Calama, Copiapó, La Serena, Coquimbo, Valparaíso, Viña del Mar, Santiago, Rancagua, Talca, Chillán, Concepción, Temuco, Valdivia, Osorno, Puerto Montt, Coyhaique and Punta Arenas (accent- and case-insensitive). If the question names another place (e.g. "sobre Puerto Varas"), the agent fails the request with a clear "unsupported city" message listing the supported cities instead of silently answering for Osorno.
4. **Receipt and payment:** the agent calls `submit_report(request_id, report_hash, …)`. The contract moves the fee into **OrbitTreasury** escrow (`lock_funds`). The agent then calls `confirm_report_received` with the same hash and the treasury transfers the fee to the agent account. Only the configured agent account can submit or confirm.
5. **Refunds:** if the request is not settled, the requester can call `claim_refund` after the 24-hour refund window. A request rejected after human review can be refunded immediately.
6. **Status API:** the frontend polls `GET /api/requests/{request_id}` and shows the stages: Pago enviado → Verificando en la cadena → En cola → Procesando → Registrando recibo → Completado. The UI is in Spanish.

### Supported questions

The agent understands the question with an LLM (NEAR AI Cloud, then OpenAI; any language), falling back to simple keyword rules (Spanish or English). It is not a general chatbot: it only answers the request types below, always from real public data. Every request type uses the same 0.1 NEAR escrow, on-chain verification and receipt flow; only the data step differs.

| Ask something like | Data source | Result |
| --- | --- | --- |
| "¿Hay tormenta geomagnética hoy?" / "space weather now?" | NOAA SWPC `planetary_k_index_1m.json` | Latest Kp and whether it is storm level (Kp ≥ 5) |
| "¿A qué hora pasa la ISS sobre Santiago?" / "ISS over Punta Arenas" / "ISS pass" | CelesTrak GP elements for NORAD 25544 + city table in `agent/src/iss-location.js` | Next pass window over that city in Chile time (America/Santiago) and UTC, max elevation (Osorno when no city is named) |
| "ISS sobre Puerto Varas" (city not in the list) | — | Fails with `No reconozco la ciudad "puerto varas"…` and the list of supported cities; refundable after 24 h |
| "¿Cuándo pasa el Hubble sobre Osorno?" / "Pasos visibles de la ISS" / "NORAD 33591 sobre Santiago" / "Tiangong sobre -40.574, -73.133" | CelesTrak GP elements by NORAD id (`CATNR`), SGP4 with `satellite.js` | Next passes in 72 h (rise/set in Chile time + UTC, max elevation, directions) and the next **naked-eye visible** passes (satellite sunlit while the Sun is below −6° at the observer; up to 7 days ahead). Geostationary objects are reported as always above the horizon. Named objects: ISS, Hubble, Tiangong |
| "¿Qué satélites brillantes puedo ver esta noche?" / "satélites GPS sobre Valdivia" / "satélites meteorológicos" | CelesTrak groups `visual`, `gps-ops`, `weather`, `stations` | Visible passes of the group in the next 24 h (high-orbit groups such as GPS are flagged as too faint for the naked eye) |
| "¿Cuántos Starlink hay sobre mí?" / "¿Cuántos satélites activos hay sobre Osorno ahora?" | CelesTrak groups `starlink`, `active` (10,000+ objects) | Snapshot: how many are above the horizon right now, how many sunlit, and the five highest |
| "Pronóstico de auroras en Punta Arenas, alerta Kp 6" | NOAA SWPC OVATION (`ovation_aurora_latest.json`) + 3-day Kp forecast | Aurora probability overhead, edge of the oval at your longitude, whether it may be seen low on the horizon, and a **Kp alert** for forecast periods at or above the threshold (default 5) |
| "¿Qué satélites van a reingresar?" / "basura espacial que va a caer" | CelesTrak `SPECIAL=DECAYING` | Lowest-perigee decaying objects with a crude linear decay estimate (clearly labelled as not official) |
| "¿Hay asteroides cerca de la Tierra?" | NASA/JPL SBDB Close-Approach Data API (no key) | Close approaches within 0.05 au in the next 30 days: time, distance in lunar distances and km, speed, size range from H |
| "Próximos lanzamientos de cohetes" | Launch Library 2 (The Space Devs, `lldev` endpoint) | Next 5 launches: rocket, provider, pad, time in Chile + UTC, status, webcast link |
| "¿Cuándo veo el tren de Starlink?" | CelesTrak `last-30-days` | The three newest Starlink launches, their altitude and the next visible passes of the train |
| "¿Hay riesgo de choque entre satélites?" | CelesTrak SOCRATES Plus (top rows of the CSV via an HTTP range request) | Closest conjunctions of the next 7 days and the highest worst-case probabilities |

Observer: a Chilean city from the table (Osorno by default) or explicit decimal coordinates such as `-40.574, -73.133`. Public data is cached in memory and in `agent/data/cache` so it survives restarts (CelesTrak 2 h as CelesTrak requires, NOAA 5 min, Launch Library 15 min, JPL and SOCRATES 1 h); if a source fails, a copy up to 24 h old is used.

Anything else (for example "size of the moon") fails with a clear message listing the supported kinds of question. The fee then stays in escrow and can be refunded after 24 h. The rate limit (one request per minute on testnet) still applies, because it starts when you pay.

## AI: NEAR AI Cloud (with OpenAI fallback)

The agent uses an LLM for two narrow jobs, through OpenAI-compatible `POST /chat/completions` endpoints. Code: `agent/src/llm.js` and `agent/src/report-pipeline.js`.

**Priority chain (for both jobs):**
1. **[NEAR AI Cloud](https://cloud.near.ai)**: `https://cloud-api.near.ai/v1`, default model `Qwen/Qwen3-VL-30B-A3B-Instruct` (served from NEAR AI's TEE infrastructure).
2. **OpenAI**: `https://api.openai.com/v1`, default model `gpt-4.1-mini`.
3. **Local and deterministic**: the keyword classifier plus the template report. A paid request never fails because of an LLM.

A provider is skipped on HTTP 402/429/5xx, timeout or invalid output. If a provider is unreachable during a request, it is not retried for the writing step. A circuit breaker skips a provider for 5 minutes after 401/402/403 and for 1 minute after 429, so latency stays bounded (per-provider timeouts: 20 s NEAR AI, 15 s OpenAI).

1. **Understand the question.** The model receives the on-chain query as delimited, untrusted data and must return only `{"intent": "iss_pass" | "space_weather" | "unsupported", "city": string|null, "language": "es"|"en"|…}`. The JSON is validated strictly (no extra fields, intent in the allow-list, city letters only). The city is accepted only if it maps to the fixed table in `iss-location.js`; an unknown city gives the "unsupported city" failure. A keyword match is never downgraded to `unsupported` by a model.
2. **Write the briefing.** The agent computes the facts itself (NOAA Kp, or the ISS pass with SGP4) and passes them as JSON. The model writes a short briefing in the user's language using only those facts. A post-check rejects empty or long output, links and markup, and **any number that is not in the facts**. Every report ends with a deterministic `Verified data:` footer containing the raw values (Chile time and UTC, elevation, Kp, source), so the numbers are verifiable whatever the LLM wrote.

The models never see secrets and never influence payment, signer, `request_id`, report hash or chain calls. Logs contain only metadata (provider, model, latency, fallback reason), never prompts or keys.

Config (server environment only): `NEARAI_API_KEY`, `NEARAI_BASE_URL`, `NEARAI_MODEL`, `NEARAI_TIMEOUT_MS`, `NEARAI_MAX_TOKENS`, and the same `OPENAI_*` variables. A provider without a key is disabled.

## Try it (do X → see Y)

### A. Live demo (no install)

1. Install [Meteor Wallet](https://wallet.meteorwallet.app/) and create or fund a **testnet** account (testnet NEAR is free from a faucet).
2. Open https://drmessi007-ui.github.io/orbithire-frontend/ → you see the OrbitHire page with the agent status and a disabled pay button.
3. Click connect, choose Meteor Wallet, approve → your `*.testnet` account appears and the pay button becomes active.
4. Type `¿A qué hora pasa la ISS sobre Osorno?` and click **Pagar y consultar** → Meteor asks you to approve a 0.1 NEAR call to `orbit-hire.shortemail369.testnet`.
5. Approve → the result panel shows the live stages, then the report text (e.g. `ISS pass over Osorno, Chile: approximately 06:45 to 06:51 Chile time, Sat, 14 Nov 2026 (America/Santiago, UTC-3); 2026-11-14 09:45 to 09:51 UTC; maximum elevation about 31 degrees…`), the request ID and a link to the transaction on the testnet explorer. The entry is saved in the per-wallet history.
6. Try paying again right away → the page shows a countdown. The contract allows one request per account per minute (the demo window is 60 s, set on-chain by the owner).
7. Check the chain yourself:
   ```bash
   curl -s https://rpc.testnet.near.org -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"orbit-hire.shortemail369.testnet","method_name":"get_request_status","args_base64":"'$(printf '{"request_id":"<YOUR_REQUEST_ID>"}' | base64 -w0)'"}}'
   ```
   → `result.result` is a byte array; decoded as UTF-8 it is the JSON status string, for example `"released"` (other values: `open`, `escrowed`, `refunded`, …).
8. Check the agent: `curl https://agent.deosorno.cl/health` → `{"ok":true,"network":"testnet"}`. `curl https://agent.deosorno.cl/api/requests/<YOUR_REQUEST_ID>` → `{"status":"completed","report":"…"}`.

### B. Run the tests locally

Requirements: Rust stable (≥ 1.95) with the `wasm32-unknown-unknown` target, and Node.js ≥ 22.

```bash
# Contracts: unit tests and Wasm build
rustup target add wasm32-unknown-unknown
cargo test --workspace --release
cargo build --release --target wasm32-unknown-unknown
# → target/wasm32-unknown-unknown/release/orbit_hire.wasm and orbit_treasury.wasm

# Agent: unit tests (chain-event verification, block scanner, retry policy)
cd agent
npm ci
npm test        # → 53 tests pass, 13 live-API tests skipped (LLM calls are mocked)
ORBITHIRE_LIVE_TESTS=1 node --test test/live-apis.test.js   # → 13 checks against the real public APIs
npm run check   # → syntax check of the agent sources
```

The contract tests cover UUID, query and hash validation (including a 10,000-input fuzz smoke test), exact fee, rate limit, pause and owner authorization, duplicate IDs, the report and receipt flow, timeout refund and expired-lock rescue, treasury authorization, and state-before-promise reentrancy guards.

### C. Run your own full stack on testnet

Only the agent account configured in the contract can submit receipts, so to run the agent yourself you deploy your own copy of the contracts:

1. Create a testnet owner account plus three subaccounts for hire, treasury and agent (for example with `near-cli-rs`).
2. Build the Wasm (section B), then deploy and initialize the **treasury first**, then OrbitHire:
   ```bash
   near contract deploy <treasury>.testnet use-file target/wasm32-unknown-unknown/release/orbit_treasury.wasm \
     with-init-call new json-args '{"owner_id":"<owner>.testnet","orbit_hire_id":"<hire>.testnet","fee_yocto":"100000000000000000000000"}' \
     prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
   near contract deploy <hire>.testnet use-file target/wasm32-unknown-unknown/release/orbit_hire.wasm \
     with-init-call new json-args '{"owner_id":"<owner>.testnet","treasury_id":"<treasury>.testnet","agent_id":"<agent>.testnet","fee_yocto":"100000000000000000000000"}' \
     prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
   ```
   Then fund each contract's storage reserve with the owner account (`fund_storage_reserve`, a payable call).
3. Configure the agent: `mkdir -p secrets && cp .env.example secrets/.env`, then fill in `ORBIT_HIRE_CONTRACT_ID`, `AGENT_ACCOUNT_ID` and `AGENT_PRIVATE_KEY` (use the **agent** account key, never the owner key). The agent loads `secrets/.env` at the repo root, and any variable already set in the environment takes precedence.
4. Start it: `cd agent && npm ci && npm start` → the agent reads `get_fee` from your contract and logs `OrbitHire agent API listening on 127.0.0.1:8787` plus its polling settings. `curl localhost:8787/health` → `{"ok":true,"network":"testnet"}`.
5. Serve the frontend: edit `CONTRACT_ID` and `AGENT_API_URL` at the top of `frontend/app.js`, set the agent's `FRONTEND_ORIGIN` to the exact HTTPS origin that serves the page (CORS and `/api/notify` accept only that origin), and publish `frontend/` (for example on GitHub Pages).

Production-style deployment (systemd unit, nginx/Caddy examples, install script) is in [`deploy/`](deploy/README-deploy.md); Docker/PM2 options are in [`agent/README.md`](agent/README.md).

## Repository layout

```
contracts/orbit-hire/      Rust (near-sdk 5.30.1) – payable facade, rate limit, receipts, refunds
contracts/orbit-treasury/  Rust – per-request escrow, release to agent, refunds
crates/orbit-common/       Rust – shared UUID/query/hash validation and constants
agent/                     Node.js off-chain agent (verification, NOAA/CelesTrak, receipts, status API) + tests
deploy/                    systemd/nginx/Caddy examples and installer used for the hosted agent
frontend/                  Static page (Meteor Wallet via NEAR Wallet Selector), same code as the live demo
docs/                      Contract interface, security notes, submission draft
.env.example               Agent configuration template (no secrets)
```

## Contract interface (orbit-hire)

| Method | Who | What |
| --- | --- | --- |
| `request_service(request_id, query)` | anyone, payable exactly the fee | Opens a request, stores `sha256(query)`, applies the rate limit |
| `submit_report(request_id, report_hash, malicious_query_detected, output_under_review)` | agent only | Records the receipt and locks the fee in the treasury |
| `confirm_report_received(request_id, report_hash)` | agent only | Releases the escrow to the agent |
| `claim_refund(request_id)` | requester only | Refund after 24 h, or immediately after a rejected review |
| `dispute_under_review(request_id)` | requester only | Flags a request that is under human review |
| `resolve_under_review(request_id, approve)` | owner only | Approves or rejects a held report |
| `set_paused(bool)`, `set_rate_limit_window_ns(u64)`, `fund_storage_reserve()` | owner only | Admin |
| `get_fee()`, `get_request_status(id)`, `get_request_commitment(id)`, `is_paused()` | view | Read state |

The deployed testnet Wasm is byte-identical (same SHA-256) to a release build of this source on the author's machine. See [`docs/CONTRACT_VERIFICATION.md`](docs/CONTRACT_VERIFICATION.md).

## Security model and known limitations

- **No keys in the browser.** Meteor Wallet signs the payment. The agent key lives only in the server environment; it is the agent account's own key, never the owner key.
- **The agent verifies everything on-chain** (transaction status, receiver, exact fee, query commitment) before doing work. `/api/notify` is origin-restricted, size-limited and rate-limited, and it is only a hint.
- **Escrow, not trust:** the fee only moves to the agent after a report hash is on-chain. Unsettled requests are refundable after 24 h.
- **Rate limit:** one `request_service` per account per window, currently 60 seconds on testnet (owner-configurable with `set_rate_limit_window_ns`). It also counts failed requests, because it starts at payment time.
- **The query is public.** NEAR transaction arguments are public; only the hash is kept in state. Do not submit sensitive data. This is not a full commit-reveal scheme.
- **LLMs (NEAR AI Cloud, OpenAI fallback) are sandboxed:** the query is untrusted data, the model output is limited to an allow-listed intent and fact-checked prose, and it never touches payments or signing. See `docs/SECURITY.md`.
- **Prompt-injection guard (Jev / TypeSafe)** is implemented as a hook in the agent (`JEV_API_KEY`). **On the live demo it currently runs in simulation mode**, so it is not an active security control. The contract cannot attest that a guard ran.
- **Single owner key:** the owner can pause and change the rate limit. Multisig/DAO ownership is future work.
- **No refund button in the UI yet:** refunds work via `claim_refund` from the requester's wallet or CLI.
- Agent state is a local JSONL store (single process). No external audit, no sandbox integration tests.

More detail: [`docs/SECURITY.md`](docs/SECURITY.md).

## Libraries, templates and AI disclosure

- **Contracts:** `near-sdk` 5.30.1 (features `legacy`, `unit-testing` for tests), `borsh` 1.8.1, `serde_json` 1.
- **Agent:** `near-api-js` 7.2.0, `satellite.js` 7.2.0, `@typesafe-ai/sdk` 0.6.0 (Jev guard), `dotenv` 18.0.10. NEAR AI Cloud and OpenAI via plain `fetch` (no SDK). Node.js built-ins (`node:http`, `node:test`).
- **Frontend:** `@near-wallet-selector/core` and `@near-wallet-selector/meteor-wallet` 10.1.4 (loaded from jsDelivr). No framework, no build step.
- **Data:** NOAA SWPC public JSON (Kp, OVATION aurora, Kp forecast), CelesTrak GP elements and SOCRATES, NASA/JPL Close-Approach Data API, Launch Library 2 by The Space Devs (no API keys).
- **Templates:** none beyond standard `near-sdk` contract structure.
- **AI-written code:** most of the code and docs were written with AI coding assistants: GitHub Copilot in VS Code for the contracts, agent and frontend, and Grok Bot for the block-scanner/state-sweep fixes, live progress stages, the LLM integration and this repository's packaging. At runtime the agent calls an LLM (NEAR AI Cloud, falling back to OpenAI) to classify questions and word reports (see "AI: NEAR AI Cloud (with OpenAI fallback)"). The author reviewed, deployed and operates it.

## License

MIT, see [LICENSE](LICENSE).
