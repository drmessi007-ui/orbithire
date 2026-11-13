# Contract verification

Checked on 2026-11-13 against NEAR testnet (`view_code`, finality `final`).

| Account | Deployed code SHA-256 | Matches |
| --- | --- | --- |
| `orbit-hire.shortemail369.testnet` | `f2dae86ea10db3cc8a00ce101327f6161914e6d06f4e05728cf93d06a35c2cc1` (387,186 bytes, NEAR code hash `HM1GSKk2WXRrLytjNtfT2XEXbLohqwJ6EsRq9xzgn5Qc`) | Byte-identical to `orbit_hire.wasm` from the author's release build of this source |
| `orbit-treasury.shortemail369.testnet` | `e18e420990ad58c2726324e3cda2e570d190a9856bed32c7404d19f18446a34a` (273,910 bytes) | Byte-identical to `orbit_treasury.wasm` from the same build |

The author's build (Windows; the Wasm embeds rustc 1.99.1 strings) was compiled from the files in `contracts/` and `crates/` after their last modification.

Rebuilding with a different toolchain or path (for example Rust 1.100 on Linux) produces a slightly different binary (Rust builds are not reproducible across toolchains or paths). It exports exactly the same functions:

- **orbit-hire:** `new`, `request_service`, `submit_report`, `confirm_report_received`, `dispute_under_review`, `resolve_under_review`, `claim_refund`, `fund_storage_reserve`, `set_paused`, `set_rate_limit_window_ns`, `get_fee`, `get_request_status`, `get_request_commitment`, `is_paused`, the callbacks `on_lock_complete`, `on_release_complete`, `on_refund_complete`, `on_rescue_complete`, and `contract_source_metadata`.
- **orbit-treasury:** `new`, `lock_funds`, `release`, `refund`, `refund_review_rejected`, `rescue_expired`, `fund_storage_reserve`, `set_paused`, `get_escrow_status`, `get_total_escrowed`, the callbacks `on_release_complete`, `on_refund_complete`, `on_rescue_refund_complete`, and `contract_source_metadata`.

Reproduce the export check:

```bash
curl -s https://rpc.testnet.near.org -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_code","finality":"final","account_id":"orbit-hire.shortemail369.testnet"}}' \
  | python3 -c 'import sys,json,base64,hashlib; b=base64.b64decode(json.load(sys.stdin)["result"]["code_base64"]); print(hashlib.sha256(b).hexdigest())'
```
