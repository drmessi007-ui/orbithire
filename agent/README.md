# OrbitHire hosted off-chain agent

The Node.js agent is a persistent NEAR testnet service. The frontend can notify it after payment; the agent independently verifies the transaction, request event, signer, fee, and query commitment before processing. A throttled finalized-block scan remains as a recovery path. The agent applies Jev before and after the external lookup, then submits the receipt using the configured agent account.

## Requirements and configuration

- Node.js 22 or newer and npm. The Docker image uses Node 22 Alpine.
- A deployed OrbitHire contract on **NEAR testnet**.
- An agent account whose key is authorized by the contract and whose ID matches the contract's configured `agent_id`.
- A TypeSafe API key for real Jev checks; obtain one at <https://console.typesafe.ai/keys>.
- For production: a Linux server with Docker Engine and the Docker Compose plugin, or Node.js plus PM2; use a stable domain for automatic HTTPS with Caddy.

Copy `.env.example` to `.env` on the server and set the real values there (or inject them using a protected secret manager). Required secret values are `AGENT_ACCOUNT_ID`, `AGENT_PRIVATE_KEY`, and `ORBIT_HIRE_CONTRACT_ID`. Set `JEV_API_KEY` for real Jev checks; the default model is pinned to `jev-1.14.0`. Never place private keys or API keys in the frontend or repository. Do not use the owner's key for the agent.

`FRONTEND_ORIGIN` must be the exact HTTPS origin serving the static frontend, without a path. `SERVICE_HOST` and `SERVICE_PORT` configure the listener. `POST /api/notify` accepts only a request ID, transaction hash, and sender account ID; it never trusts browser-supplied query data. The agent verifies every notification directly against NEAR, limits request rate/concurrency, and restricts browser CORS to `FRONTEND_ORIGIN`. Do not put a shared token in a static frontend: any token shipped in JavaScript is public. `GET /api/requests/{request_id}` remains a public, read-only status endpoint.

The service also attempts to load `secrets/.env` for development when started directly from the repository. Docker Compose reads `agent/.env` and injects it into the container; PM2 reads `agent/.env` through its ecosystem configuration. Keep either real `.env` file private and set its permissions to restrict access.

## Run locally without Docker

From the repository root:

```powershell
Set-Location .\agent
npm ci
npm run check
npm test
npm start
```

By default the service listens on `127.0.0.1:8787`. It writes the scan cursor, discovered transaction/query records, result history, and human-review queue to `agent/data/`. These JSONL files are prototype persistence for one process, not a highly available database.

## Run locally with Docker Compose

From `agent/`, create a private environment file, fill in the required account/contract values, and start the service:

```powershell
Copy-Item .env.example .env
# Edit .env and set the required values; never commit or upload this file publicly.
docker compose up --build -d
docker compose ps
Invoke-RestMethod http://localhost:8787/health
```

The default host port is `8787`, bound to `127.0.0.1`; change `HOST_PORT` in `.env` to select another local port. The container listens on `0.0.0.0:8787` internally. Its named `agent-data` volume persists the files mounted at `/app/agent/data` across container restarts and image updates.

Transient RPC, NOAA/CelesTrak, and Jev connection/timeout failures are retried up to three total attempts with a 5-second then 10-second backoff. The attempt count and next retry time are persisted so a restart does not reset the retry limit. Invalid input, unsupported questions, authorization/configuration failures, and other terminal errors are not retried.

## HTTPS with Caddy

Point a domain's DNS A/AAAA records to the server, allow inbound TCP ports 80 and 443 (and UDP 443 for HTTP/3), and set `DOMAIN` in the server's private `.env` to that domain. Then enable the optional Compose profile:

```powershell
docker compose --profile https up --build -d
```

Caddy obtains and renews the TLS certificate automatically. The agent's host port remains bound to loopback; Caddy proxies to it over the Compose network. Do not enable the profile with the example placeholder domain.

## Run with PM2 instead of Docker

On the server, install production dependencies, create `agent/.env` from `.env.example`, and set the actual values. Then:

```sh
npm ci --omit=dev
npm install --global pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
pm2 status
pm2 logs orbithire-agent
```

Run the command printed by `pm2 startup` with the server administrator's approval to enable boot-time startup. PM2 restarts the single agent process on failure and writes logs under `agent/logs/`; this directory is ignored by Git. Configure a separate HTTPS reverse proxy and firewall so the service is not exposed directly without TLS.

## Deploy an image from Windows with SCP

The included `deploy.ps1` builds the Linux image locally, uploads the image and deployment configuration, and restarts Compose remotely. It does **not** upload `.env`; create the server's `.env` privately before running the script. It also does not install Docker on the server or alter firewall/DNS settings.

From PowerShell in `agent/`:

```powershell
.\deploy.ps1 -Server deployuser@example.com
```

The default remote directory is `/opt/orbithire-agent` and the default image platform is `linux/amd64`. Set another target with `-Platform linux/arm64` when appropriate. For HTTPS via Caddy, first set `DOMAIN` in the server `.env`, then run:

```powershell
.\deploy.ps1 -Server deployuser@example.com -EnableHttps
```

The script requires Docker, SSH, and SCP on the Windows machine, plus SSH access and Docker/Compose on the server. Review and edit the script's defaults before deployment if the server's path, architecture, or account differs.

## Verify the service and request API

Health check:

```powershell
Invoke-RestMethod http://localhost:8787/health
```

Request status, replacing the UUID with a real request ID:

```powershell
$requestId = "00000000-0000-4000-8000-000000000000"
Invoke-RestMethod "http://localhost:8787/api/requests/$requestId"
```

Or, after setting up HTTPS:

```powershell
Invoke-RestMethod "https://agent.example.com/health"
Invoke-RestMethod "https://agent.example.com/api/requests/$requestId"
```

`GET /api/requests/{request_id}` returns public status and, when completed, the report. Status `retrying` means a transient infrastructure/source failure is waiting for its next bounded retry; `failed` means processing stopped and the request remains subject to contract refund rules. An unknown ID is returned as `404`; it does not mean that the service is unhealthy. There are no write endpoints, bearer tokens, API keys, or client-provided queries. CORS is restricted to the exact `FRONTEND_ORIGIN`; CORS is not authentication. Request IDs are visible on-chain and must not be treated as credentials. Reports are public to anyone who knows the request ID.

After the HTTPS service is deployed, set `AGENT_API_URL` in `frontend/app.js` to the service's HTTPS base URL (the live demo uses `https://agent.deosorno.cl`) and publish the static frontend. GitHub Pages cannot inject runtime environment variables into static JavaScript, so configure this constant before publishing; never put secrets there.

## Chain observation and verification

The fallback scanner polls finalized testnet blocks every `POLL_INTERVAL_MS` (default 60000 ms) and processes at most one block per poll to limit RPC usage. On first run it scans the latest 100 blocks unless `START_BLOCK_HEIGHT` is set. Thereafter it persists the next block height and resumes after restarts. Notifications use one `EXPERIMENTAL_tx_status` lookup and only accept a request if:

1. The transaction succeeded and targeted the configured OrbitHire contract.
2. It called `request_service` with a valid request ID and query.
3. The attached deposit equals the contract's `get_fee()` value.
4. The request ID matches the `request_created` event.
5. The query passes input limits and its SHA-256 matches the event and `get_request_commitment()` on-chain.
6. The current on-chain request status is `open`.

The query is public in the original transaction arguments. Do not submit secrets or personal data. This validation confirms consistency, not confidentiality or truth of external data.

## Jev, data sources, and human review

With `JEV_API_KEY`, input and output are sent to TypeSafe System One using `jev-1.14.0`. A suspicious input is not sent to NOAA/CelesTrak; the agent records `MALICIOUS_QUERY_DETECTED` on-chain. If Jev is missing, the agent simulates a clean classification. **Simulation does not filter attacks and is only suitable for development, not real-value funds.**

Supported geomagnetic-storm questions use NOAA's public planetary K-index feed. ISS questions use CelesTrak orbital elements and SGP4 propagation for Osorno. Unsupported questions, Jev failures, and NOAA/CelesTrak failures do not produce fabricated reports; the API records a failure state and the request remains subject to contract timeout/refund rules.

If Jev flags the generated report, the agent submits its hash with `output_under_review=true`, retains the report in `agent/data/review-queue.jsonl`, and does not confirm delivery. This is a private, human-operated owner queue, not on-chain arbitration. The client cannot claim the normal timeout refund while `UNDER_REVIEW` is active. The owner must resolve on-chain with `resolve_under_review(request_id, approve)`. Approval returns the request to escrow and the agent observes it and confirms the stored hash. Rejection lets the client claim a refund.

The agent process checks and settles approved human reviews on subsequent scans. Ensure the owner has a separate secure key workflow and that review data is access-controlled. Human queue operations are a documented manual process/TODO for a future authenticated review console.

## Operational risks and limits

- This remains a testnet prototype and has not been audited. Do not use real-value funds.
- The frontend payment fee is fixed at 0.1 NEAR; the agent verifies against the deployed contract's actual `get_fee()`. Keep the contract fee aligned with the UI.
- Contract logic cannot independently prove Jev ran or validate NOAA/CelesTrak results; it trusts the authorized agent.
- Block scanning, state persistence, and report delivery are single-process. Use durable storage and monitoring; a production deployment should migrate JSONL persistence to a managed database and add operational alerting.
- Because request transactions expose their query and report results are public through the API, the design has no private query/report channel.
