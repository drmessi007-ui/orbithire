# OrbitHire static frontend

Static HTML, CSS, and JavaScript for GitHub Pages. No bundler or build step is required. The page loads NEAR Wallet Selector 10.1.4 and its Meteor Wallet module from the pinned jsDelivr ESM CDN and connects to **NEAR testnet only**. Install Meteor Wallet from [wallet.meteorwallet.app](https://wallet.meteorwallet.app/).

## Architecture and configuration

1. The user connects Meteor Wallet and approves a `request_service` call paying exactly 0.1 NEAR to `orbit-hire.shortemail369.testnet`.
2. The OrbitHire contract records the request ID and query hash. The query itself is public in the NEAR transaction arguments; do not enter sensitive information.
3. A persistent off-chain agent scans finalized testnet blocks, retrieves and validates the transaction query, runs Jev and the relevant NOAA/CelesTrak lookup, then submits the report receipt.
4. Right after payment the frontend sends a fire-and-forget `POST /api/notify` (`request_id`, `tx_hash`, `sender_account_id`); the agent verifies the transaction on-chain, and its block scan remains the fallback.
5. The frontend polls the agent's public read-only HTTPS API at `/api/requests/{request_id}` and shows the live stage in the result panel (Pago enviado → Verificando en la cadena → En cola → Procesando → Registrando recibo → Completado).

### Rate limit and history

- The contract accepts one successful `request_service` per account per window (`rate_limit_window_ns`, currently 1 hour). It has no view method for this, so the page reads the contract's public storage with `view_state` (key `0x01` + borsh account ID = last request timestamp; `STATE` = window) and treats it as the source of truth. A local `orbithire:request-cooldown:<account>` key is only a fallback when the RPC is unreachable, and it is written only after a successful transaction. The pay button shows a countdown and re-enables itself when the window ends.
- Periodic `/health` checks never disable the button while in flight; payments are blocked only after two consecutive failed checks, and a fresh check runs right before every payment.
- History is stored per wallet in `orbithire:request-history:<account>` (max 100 entries) and only the connected account's entries are shown. Pending entries younger than 24 hours are re-checked against the agent after reloads, and the result panel is cleared when the wallet changes or signs out.

The public API does not accept submitted queries and does not use a shared browser token. The request ID is visible on-chain and is not authentication; completed reports are public to anyone who knows the ID. Private keys and API keys belong only in the agent host's secret manager/environment, never in the frontend.

GitHub Pages is static and cannot inject runtime environment variables, so the agent base URL is the `AGENT_API_URL` constant near the top of `app.js`. In the live deployment it is `https://agent.deosorno.cl`. If you self-host the agent, change it to your own HTTPS origin before publishing. If the agent's `/health` check fails twice in a row, the payment button is disabled so nobody pays while no result endpoint is available. Wallet Selector initialization errors are displayed in the response area.

## Publish on GitHub Pages

1. Push the repository without the ignored `secrets/` directory, `.env` files, agent keys, or `agent/data/`.
2. Configure Pages to serve the `frontend/` directory (or publish its contents through a workflow).
3. Configure the agent's `FRONTEND_ORIGIN` to the exact HTTPS GitHub Pages origin, without a path. See [the agent setup](../agent/README.md).
4. Set `AGENT_API_URL` to the deployed agent HTTPS origin and publish the frontend.
5. Connect Meteor Wallet on testnet, enter a supported query, approve the payment in the wallet, and use the transaction link and request ID to track the result.

## Testnet contracts and fee

- OrbitHire: `orbit-hire.shortemail369.testnet`
- OrbitTreasury: `orbit-treasury.shortemail369.testnet`
- Network: NEAR testnet (`https://rpc.testnet.near.org`), not mainnet
- Fee: `0.1 NEAR` (`100000000000000000000000` yoctoNEAR)

This is a beta testnet prototype, not an audited production service. The browser does not contain signing keys, Jev API keys, or shared agent tokens. Meteor Wallet signs the payment transaction.
