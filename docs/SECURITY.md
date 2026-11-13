# Security notes

Scope: OrbitHire testnet prototype, as deployed on 2026-11-13. Not audited.

## Implemented and active

**Contracts**
- Exact-fee check on `request_service`; canonical UUID v4 request IDs; duplicate IDs rejected.
- Query validation in `orbit-common`: non-empty, max 500 characters, character allowlist (letters, digits, whitespace, limited punctuation).
- Per-account rate limit: one request per window (default 1 hour, owner-configurable with `set_rate_limit_window_ns`). The window starts at payment time.
- Escrow: the fee is held by `orbit-hire`. It moves to `orbit-treasury` only when the agent submits a report hash, and is released to the agent only after `confirm_report_received` with the same hash.
- Role checks: only the configured agent can submit or confirm; only the requester can claim a refund or dispute; only the owner can pause, change the rate limit or resolve reviews. The treasury accepts lock, release and refund only from `orbit-hire`.
- Refunds: `claim_refund` after the 24-hour window, or immediately after a rejected human review. Expired requests stuck while locking have a rescue path.
- State changes before every cross-contract promise, private callbacks, a per-request state machine that blocks double release or refund, and a solvency check (liabilities plus storage reserve).
- Owner, treasury and agent must be different accounts (checked in `new`).
- NEP-297-style events (`request_created`, `report_submitted`, `review_disputed`, `review_resolved`, …).

**Agent**
- Testnet-only guard at startup; reads the fee from the contract (`get_fee`).
- Independent on-chain verification of every request: transaction success, receiver contract, exact deposit, request ID, and `sha256(query)` equal to the event and the contract commitment.
- `POST /api/notify`: exact-origin check, JSON content type, 4 KB body limit, 20 notifications per minute and 4 concurrent at most. It is only a hint; unverified notifications are rejected.
- Read-only public status API (`GET /api/requests/{uuid}` with a strict regex), CORS limited to `FRONTEND_ORIGIN`, `Cache-Control: no-store`.
- Retry policy with at most 3 attempts and exponential backoff; transient data-source failures are reported as failed or pending, never as fabricated reports.
- RPC rate limiting and backoff for the block scanner, plus a periodic contract-state sweep so requests are not missed.
- Secrets only in the server environment (systemd `EnvironmentFile` installed root-owned with mode 0600). The agent key is the agent account's own key, not the owner key.
- Hardened systemd unit (`deploy/orbithire-agent.service`): dedicated unprivileged user, `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `UMask=0077`, write access only to the data directory. The deploy examples bind the API to loopback behind nginx or Caddy for HTTPS.

**Frontend**
- No keys or tokens in the browser; Meteor Wallet signs the transaction.
- Reads the on-chain rate-limit state (`view_state`) to show the real cooldown.
- History stored per wallet and isolated between accounts.
- Notifies the agent only with the transaction hash that belongs to the request.

## Designed but not active on the live demo

- **Jev / TypeSafe prompt-injection guard:** the code classifies the query before calling data sources and the report before submitting it (`malicious_query_detected` and `output_under_review` flags). The live agent currently logs `Jev is in simulation mode`, so these checks are **not** active security controls.
- **Human review queue:** contract support exists (`UNDER_REVIEW`, `dispute_under_review`, `resolve_under_review`). The operator workflow is manual and there is no review console.
- **Multisig/DAO owner:** recommended, not implemented. The owner is a single account.
- **Commit-reveal privacy:** not implemented. The plaintext query is visible in the public transaction arguments; only its hash is stored in state.

## Known limitations

- Failed requests still consume the hourly rate limit, and the UI has no refund button yet (`claim_refund` must be called from the requester's wallet or CLI).
- Agent state is a single-process JSONL store.
- Status reports are public to anyone who knows the request ID (request IDs are visible on-chain).
- No sandbox integration tests across both contracts, no external fuzzing, no audit. Do not use with mainnet funds.
