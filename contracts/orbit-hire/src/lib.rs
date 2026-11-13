use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::{
    env, ext_contract, json_types::U128, near, require, store::LookupMap, AccountId,
    BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
};
use orbit_common::{
    is_valid_query, is_valid_sha256_hex, is_valid_uuid_v4, to_lower_hex, DEFAULT_RATE_LIMIT_NS,
    DEFAULT_REFUND_WINDOW_NS,
};

const TREASURY_GAS: Gas = Gas::from_tgas(15);
const CALLBACK_GAS: Gas = Gas::from_tgas(10);

#[derive(BorshSerialize, BorshStorageKey)]
enum StorageKey {
    Requests,
    LastRequestAt,
}

#[derive(BorshDeserialize, BorshSerialize, Clone, Copy, Debug, PartialEq, Eq)]
enum RequestStatus {
    Open,
    ReportSubmitted,
    Locking,
    RescuingLock,
    Escrowed,
    UnderReview,
    ReviewRejected,
    Releasing,
    RefundingLocal,
    RefundingTreasury,
    Released,
    Refunded,
}

#[derive(BorshDeserialize, BorshSerialize)]
struct Request {
    requester_id: AccountId,
    amount: u128,
    created_at_ns: u64,
    refund_after_ns: u64,
    query_commitment: String,
    report_hash: Option<String>,
    malicious_query_detected: bool,
    requires_review: bool,
    client_disputed: bool,
    status: RequestStatus,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct OrbitHire {
    owner_id: AccountId,
    treasury_id: AccountId,
    agent_id: AccountId,
    fee_yocto: u128,
    rate_limit_window_ns: u64,
    refund_window_ns: u64,
    paused: bool,
    held_liability_yocto: u128,
    requests: LookupMap<String, Request>,
    last_request_at: LookupMap<AccountId, u64>,
}

#[ext_contract(ext_treasury)]
#[allow(dead_code)]
trait ExtTreasury {
    fn lock_funds(
        &mut self,
        request_id: String,
        requester_id: AccountId,
        beneficiary_id: AccountId,
        refund_after_ns: u64,
    ) -> bool;
    fn release(&mut self, request_id: String) -> Promise;
    fn refund(&mut self, request_id: String, recipient_id: AccountId) -> Promise;
    fn refund_review_rejected(&mut self, request_id: String, recipient_id: AccountId) -> Promise;
    fn rescue_expired(&mut self, request_id: String, recipient_id: AccountId) -> Promise;
}

#[ext_contract(ext_self)]
#[allow(dead_code)]
trait ExtSelf {
    fn on_lock_complete(&mut self, request_id: String) -> bool;
    fn on_release_complete(&mut self, request_id: String) -> bool;
    fn on_refund_complete(&mut self, request_id: String, via_treasury: bool) -> bool;
    fn on_rescue_complete(&mut self, request_id: String) -> PromiseOrValue<bool>;
}

#[near]
impl OrbitHire {
    #[init]
    pub fn new(
        owner_id: AccountId,
        treasury_id: AccountId,
        agent_id: AccountId,
        fee_yocto: U128,
    ) -> Self {
        require!(fee_yocto.0 > 0, "fee must be greater than zero");
        require!(owner_id != treasury_id, "owner and treasury must differ");
        require!(owner_id != agent_id, "owner and agent must differ");
        require!(treasury_id != agent_id, "treasury and agent must differ");
        Self {
            owner_id,
            treasury_id,
            agent_id,
            fee_yocto: fee_yocto.0,
            rate_limit_window_ns: DEFAULT_RATE_LIMIT_NS,
            refund_window_ns: DEFAULT_REFUND_WINDOW_NS,
            paused: false,
            held_liability_yocto: 0,
            requests: LookupMap::new(StorageKey::Requests),
            last_request_at: LookupMap::new(StorageKey::LastRequestAt),
        }
    }

    #[payable]
    pub fn fund_storage_reserve(&mut self) {
        self.assert_owner();
        require!(
            env::attached_deposit().as_yoctonear() > 0,
            "deposit must be positive"
        );
    }

    #[payable]
    pub fn request_service(&mut self, request_id: String, query: String) {
        require!(!self.paused, "new requests are paused");
        require!(
            env::attached_deposit().as_yoctonear() == self.fee_yocto,
            "incorrect fee"
        );
        require!(
            is_valid_uuid_v4(&request_id),
            "request_id must be a canonical UUID v4"
        );
        require!(
            is_valid_query(&query),
            "query is empty or contains disallowed input"
        );
        require!(
            !self.requests.contains_key(&request_id),
            "duplicate request_id"
        );

        let now = env::block_timestamp();
        if let Some(last) = self.last_request_at.get(&env::predecessor_account_id()) {
            require!(
                now >= *last && now - *last >= self.rate_limit_window_ns,
                "rate limit exceeded"
            );
        }
        let refund_after_ns = now
            .checked_add(self.refund_window_ns)
            .unwrap_or_else(|| env::panic_str("refund deadline overflow"));
        let requester_id = env::predecessor_account_id();
        let query_hash = to_lower_hex(&env::sha256(query.as_bytes()));

        self.held_liability_yocto = self
            .held_liability_yocto
            .checked_add(self.fee_yocto)
            .unwrap_or_else(|| env::panic_str("liability overflow"));
        self.requests.insert(
            request_id.clone(),
            Request {
                requester_id: requester_id.clone(),
                amount: self.fee_yocto,
                created_at_ns: now,
                refund_after_ns,
                query_commitment: query_hash.clone(),
                report_hash: None,
                malicious_query_detected: false,
                requires_review: false,
                client_disputed: false,
                status: RequestStatus::Open,
            },
        );
        self.last_request_at.insert(requester_id.clone(), now);
        self.assert_solvent();

        emit_event(
            "request_created",
            serde_json::json!({
                "request_id": request_id,
                "query_hash": query_hash,
            }),
        );
    }

    pub fn submit_report(
        &mut self,
        request_id: String,
        report_hash: String,
        malicious_query_detected: bool,
        output_under_review: bool,
    ) -> Promise {
        require!(is_valid_uuid_v4(&request_id), "invalid request_id");
        require!(
            env::predecessor_account_id() == self.agent_id,
            "only the configured agent can submit a report"
        );
        let report_hash = if malicious_query_detected {
            to_lower_hex(&env::sha256(b"MALICIOUS_QUERY_DETECTED"))
        } else {
            require!(is_valid_sha256_hex(&report_hash), "invalid report hash");
            report_hash
        };
        let request = self
            .requests
            .get_mut(&request_id)
            .unwrap_or_else(|| env::panic_str("request not found"));
        require!(request.status == RequestStatus::Open, "request is not open");
        require!(
            env::block_timestamp() < request.refund_after_ns,
            "refund window has expired"
        );
        request.report_hash = Some(report_hash.clone());
        request.malicious_query_detected = malicious_query_detected;
        request.requires_review = output_under_review;
        request.status = RequestStatus::Locking;
        let requester_id = request.requester_id.clone();
        let refund_after_ns = request.refund_after_ns;
        let amount = request.amount;

        emit_event(
            "report_submitted",
            serde_json::json!({
                "request_id": request_id,
                "report_hash": report_hash,
                "guard_result": if malicious_query_detected { "malicious" } else { "clean" },
                "output_under_review": output_under_review,
                "error_code": if malicious_query_detected {
                    Some("MALICIOUS_QUERY_DETECTED")
                } else {
                    None
                },
            }),
        );

        ext_treasury::ext(self.treasury_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(amount))
            .with_static_gas(TREASURY_GAS)
            .lock_funds(
                request_id.clone(),
                requester_id,
                self.agent_id.clone(),
                refund_after_ns,
            )
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_lock_complete(request_id),
            )
    }

    pub fn confirm_report_received(&mut self, request_id: String, report_hash: String) -> Promise {
        require!(is_valid_uuid_v4(&request_id), "invalid request_id");
        require!(is_valid_sha256_hex(&report_hash), "invalid report hash");
        let request = self
            .requests
            .get_mut(&request_id)
            .unwrap_or_else(|| env::panic_str("request not found"));
        require!(
            env::predecessor_account_id() == self.agent_id,
            "only the configured agent can confirm receipt"
        );
        require!(
            request.status == RequestStatus::Escrowed,
            "report is not escrowed"
        );
        require!(
            env::block_timestamp() < request.refund_after_ns,
            "refund window has expired"
        );
        require!(
            request.report_hash.as_deref() == Some(report_hash.as_str()),
            "report hash does not match"
        );
        request.status = RequestStatus::Releasing;

        ext_treasury::ext(self.treasury_id.clone())
            .with_static_gas(TREASURY_GAS)
            .release(request_id.clone())
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_release_complete(request_id),
            )
    }

    pub fn dispute_under_review(&mut self, request_id: String) {
        require!(is_valid_uuid_v4(&request_id), "invalid request_id");
        let request = self
            .requests
            .get_mut(&request_id)
            .unwrap_or_else(|| env::panic_str("request not found"));
        require!(
            env::predecessor_account_id() == request.requester_id,
            "only the requester can dispute"
        );
        require!(
            request.status == RequestStatus::UnderReview,
            "request is not under review"
        );
        require!(
            env::block_timestamp() < request.refund_after_ns,
            "dispute window has expired"
        );
        request.client_disputed = true;
        emit_event(
            "review_disputed",
            serde_json::json!({ "request_id": request_id }),
        );
    }

    pub fn resolve_under_review(&mut self, request_id: String, approve: bool) {
        require!(is_valid_uuid_v4(&request_id), "invalid request_id");
        self.assert_owner();
        let request = self
            .requests
            .get_mut(&request_id)
            .unwrap_or_else(|| env::panic_str("request not found"));
        require!(
            request.status == RequestStatus::UnderReview,
            "request is not under review"
        );
        request.status = if approve {
            RequestStatus::Escrowed
        } else {
            RequestStatus::ReviewRejected
        };
        emit_event(
            "review_resolved",
            serde_json::json!({
                "request_id": request_id,
                "decision": if approve { "approved" } else { "rejected" },
                "client_disputed": request.client_disputed,
            }),
        );
    }

    pub fn claim_refund(&mut self, request_id: String) -> Promise {
        require!(is_valid_uuid_v4(&request_id), "invalid request_id");
        let request = self
            .requests
            .get_mut(&request_id)
            .unwrap_or_else(|| env::panic_str("request not found"));
        require!(
            env::predecessor_account_id() == request.requester_id,
            "only the requester can claim a refund"
        );
        let recipient_id = request.requester_id.clone();

        match request.status {
            RequestStatus::Open | RequestStatus::ReportSubmitted => {
                require!(
                    env::block_timestamp() >= request.refund_after_ns,
                    "refund window has not expired"
                );
                request.status = RequestStatus::RefundingLocal;
                let amount = request.amount;
                Promise::new(recipient_id)
                    .transfer(NearToken::from_yoctonear(amount))
                    .then(
                        ext_self::ext(env::current_account_id())
                            .with_static_gas(CALLBACK_GAS)
                            .on_refund_complete(request_id, false),
                    )
            }
            RequestStatus::Escrowed => {
                require!(
                    env::block_timestamp() >= request.refund_after_ns,
                    "refund window has not expired"
                );
                request.status = RequestStatus::RefundingTreasury;
                ext_treasury::ext(self.treasury_id.clone())
                    .with_static_gas(TREASURY_GAS)
                    .refund(request_id.clone(), recipient_id)
                    .then(
                        ext_self::ext(env::current_account_id())
                            .with_static_gas(CALLBACK_GAS)
                            .on_refund_complete(request_id, true),
                    )
            }
            RequestStatus::ReviewRejected => {
                request.status = RequestStatus::RefundingTreasury;
                ext_treasury::ext(self.treasury_id.clone())
                    .with_static_gas(TREASURY_GAS)
                    .refund_review_rejected(request_id.clone(), recipient_id)
                    .then(
                        ext_self::ext(env::current_account_id())
                            .with_static_gas(CALLBACK_GAS)
                            .on_refund_complete(request_id, true),
                    )
            }
            RequestStatus::Locking => {
                require!(
                    env::block_timestamp() >= request.refund_after_ns,
                    "refund window has not expired"
                );
                request.status = RequestStatus::RescuingLock;
                ext_treasury::ext(self.treasury_id.clone())
                    .with_static_gas(TREASURY_GAS)
                    .rescue_expired(request_id.clone(), recipient_id)
                    .then(
                        ext_self::ext(env::current_account_id())
                            .with_static_gas(CALLBACK_GAS)
                            .on_rescue_complete(request_id),
                    )
            }
            _ => env::panic_str("request cannot be refunded in its current state"),
        }
    }

    #[private]
    pub fn on_rescue_complete(&mut self, request_id: String) -> PromiseOrValue<bool> {
        let outcome = promise_returned_string();
        let request = self
            .requests
            .get_mut(&request_id)
            .unwrap_or_else(|| env::panic_str("request not found"));
        require!(
            request.status == RequestStatus::RescuingLock,
            "invalid rescue callback state"
        );
        match outcome.as_deref() {
            Some("refunded") => {
                request.status = RequestStatus::Refunded;
                self.held_liability_yocto = self
                    .held_liability_yocto
                    .checked_sub(request.amount)
                    .unwrap_or_else(|| env::panic_str("liability underflow"));
                PromiseOrValue::Value(true)
            }
            Some("not_found") => {
                request.status = RequestStatus::RefundingLocal;
                PromiseOrValue::Promise(
                    Promise::new(request.requester_id.clone())
                        .transfer(NearToken::from_yoctonear(request.amount))
                        .then(
                            ext_self::ext(env::current_account_id())
                                .with_static_gas(CALLBACK_GAS)
                                .on_refund_complete(request_id, false),
                        ),
                )
            }
            _ => {
                request.status = RequestStatus::Locking;
                env::log_str("OrbitHire rescue did not confirm a refund; retry is safe");
                PromiseOrValue::Value(false)
            }
        }
    }

    #[private]
    pub fn on_lock_complete(&mut self, request_id: String) -> bool {
        let succeeded = promise_returned_true();
        let request = self
            .requests
            .get_mut(&request_id)
            .unwrap_or_else(|| env::panic_str("request not found"));
        require!(
            request.status == RequestStatus::Locking,
            "invalid lock callback state"
        );
        if succeeded {
            request.status = if request.requires_review {
                RequestStatus::UnderReview
            } else {
                RequestStatus::Escrowed
            };
            self.held_liability_yocto = self
                .held_liability_yocto
                .checked_sub(request.amount)
                .unwrap_or_else(|| env::panic_str("liability underflow"));
        } else {
            request.status = RequestStatus::ReportSubmitted;
        }
        succeeded
    }

    #[private]
    pub fn on_release_complete(&mut self, request_id: String) -> bool {
        let succeeded = promise_returned_true();
        let request = self
            .requests
            .get_mut(&request_id)
            .unwrap_or_else(|| env::panic_str("request not found"));
        require!(
            request.status == RequestStatus::Releasing,
            "invalid release callback state"
        );
        request.status = if succeeded {
            RequestStatus::Released
        } else {
            RequestStatus::Escrowed
        };
        succeeded
    }

    #[private]
    pub fn on_refund_complete(&mut self, request_id: String, via_treasury: bool) -> bool {
        let succeeded = if via_treasury {
            promise_returned_true()
        } else {
            promise_succeeded()
        };
        let request = self
            .requests
            .get_mut(&request_id)
            .unwrap_or_else(|| env::panic_str("request not found"));
        let expected = if via_treasury {
            RequestStatus::RefundingTreasury
        } else {
            RequestStatus::RefundingLocal
        };
        require!(request.status == expected, "invalid refund callback state");
        if succeeded {
            request.status = RequestStatus::Refunded;
            if !via_treasury {
                self.held_liability_yocto = self
                    .held_liability_yocto
                    .checked_sub(request.amount)
                    .unwrap_or_else(|| env::panic_str("liability underflow"));
            }
        } else {
            request.status = if via_treasury {
                RequestStatus::Escrowed
            } else if request.report_hash.is_some() {
                RequestStatus::ReportSubmitted
            } else {
                RequestStatus::Open
            };
        }
        succeeded
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
    }

    pub fn set_rate_limit_window_ns(&mut self, window_ns: u64) {
        self.assert_owner();
        require!(window_ns > 0, "rate limit window must be positive");
        self.rate_limit_window_ns = window_ns;
    }

    pub fn get_request_status(&self, request_id: String) -> Option<String> {
        if !is_valid_uuid_v4(&request_id) {
            return None;
        }
        self.requests.get(&request_id).map(|request| {
            match request.status {
                RequestStatus::Open => "open",
                RequestStatus::ReportSubmitted => "report_submitted",
                RequestStatus::Locking => "locking",
                RequestStatus::RescuingLock => "rescuing_lock",
                RequestStatus::Escrowed => "escrowed",
                RequestStatus::UnderReview => "under_review",
                RequestStatus::ReviewRejected => "review_rejected",
                RequestStatus::Releasing => "releasing",
                RequestStatus::RefundingLocal => "refunding_local",
                RequestStatus::RefundingTreasury => "refunding_treasury",
                RequestStatus::Released => "released",
                RequestStatus::Refunded => "refunded",
            }
            .to_string()
        })
    }

    pub fn get_request_commitment(&self, request_id: String) -> Option<String> {
        if !is_valid_uuid_v4(&request_id) {
            return None;
        }
        self.requests
            .get(&request_id)
            .map(|request| request.query_commitment.clone())
    }

    pub fn get_fee(&self) -> U128 {
        U128(self.fee_yocto)
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
    }

    fn assert_solvent(&self) {
        let reserve = (env::storage_usage() as u128)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .unwrap_or_else(|| env::panic_str("storage reserve overflow"));
        let required = reserve
            .checked_add(self.held_liability_yocto)
            .unwrap_or_else(|| env::panic_str("required balance overflow"));
        require!(
            env::account_balance().as_yoctonear() >= required,
            "insufficient owner-funded storage reserve"
        );
    }
}

fn emit_event(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        serde_json::json!({
            "standard": "orbit_hire",
            "version": "1.0.0",
            "event": event,
            "data": [data],
        })
    ));
}

fn promise_returned_true() -> bool {
    env::promise_result_checked(0, 16)
        .ok()
        .and_then(|bytes| near_sdk::serde_json::from_slice::<bool>(&bytes).ok())
        .unwrap_or(false)
}

fn promise_returned_string() -> Option<String> {
    env::promise_result_checked(0, 32)
        .ok()
        .and_then(|bytes| near_sdk::serde_json::from_slice::<String>(&bytes).ok())
}

fn promise_succeeded() -> bool {
    env::promise_result_checked(0, 0).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::{test_utils::VMContextBuilder, testing_env};
    use orbit_treasury::OrbitTreasury;

    const OWNER: &str = "owner.testnet";
    const TREASURY: &str = "treasury.testnet";
    const AGENT: &str = "agent.testnet";
    const CLIENT: &str = "client.testnet";
    const REQUEST_ID: &str = "550e8400-e29b-41d4-a716-446655440000";
    const QUERY: &str = "¿hay tormenta geomagnética hoy?";
    const FEE: u128 = 100_000_000_000_000_000_000_000;

    fn account(value: &str) -> AccountId {
        value.parse().unwrap()
    }

    fn set_context(predecessor: &str, deposit: u128, timestamp: u64) {
        let context = VMContextBuilder::new()
            .current_account_id(account("orbit.testnet"))
            .signer_account_id(account(predecessor))
            .predecessor_account_id(account(predecessor))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .account_balance(NearToken::from_near(1000))
            .block_timestamp(timestamp)
            .build();
        testing_env!(context);
    }

    fn set_treasury_context(predecessor: &str, deposit: u128, timestamp: u64) {
        let context = VMContextBuilder::new()
            .current_account_id(account("treasury.testnet"))
            .signer_account_id(account(predecessor))
            .predecessor_account_id(account(predecessor))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .account_balance(NearToken::from_near(1000))
            .block_timestamp(timestamp)
            .build();
        testing_env!(context);
    }

    fn contract() -> OrbitHire {
        set_context(OWNER, 0, 1);
        OrbitHire::new(account(OWNER), account(TREASURY), account(AGENT), U128(FEE))
    }

    fn open_request(contract: &mut OrbitHire) {
        set_context(CLIENT, FEE, 1);
        contract.request_service(REQUEST_ID.to_string(), QUERY.to_string());
    }

    #[test]
    fn stores_only_query_hash_and_emits_acceptance() {
        let mut contract = contract();
        open_request(&mut contract);
        let request = contract.requests.get(REQUEST_ID).unwrap();
        assert_eq!(
            request.query_commitment,
            to_lower_hex(&env::sha256(QUERY.as_bytes()))
        );
        assert!(request.report_hash.is_none());
        assert!(!request.query_commitment.contains(QUERY));
        assert_eq!(request.status, RequestStatus::Open);
        assert!(!request.malicious_query_detected);
    }

    #[test]
    #[should_panic(expected = "duplicate request_id")]
    fn rejects_duplicate_request_id() {
        let mut contract = contract();
        open_request(&mut contract);
        set_context(CLIENT, FEE, DEFAULT_RATE_LIMIT_NS + 1);
        contract.request_service(REQUEST_ID.to_string(), QUERY.to_string());
    }

    #[test]
    #[should_panic(expected = "rate limit exceeded")]
    fn enforces_account_rate_limit() {
        let mut contract = contract();
        open_request(&mut contract);
        set_context(CLIENT, FEE, 2);
        contract.request_service(
            "550e8400-e29b-41d4-a716-446655440001".to_string(),
            QUERY.to_string(),
        );
    }

    #[test]
    fn owner_can_configure_rate_limit_window() {
        let mut contract = contract();
        set_context(OWNER, 0, 1);
        contract.set_rate_limit_window_ns(5);

        set_context(CLIENT, FEE, 1);
        contract.request_service(REQUEST_ID.to_string(), QUERY.to_string());
        set_context(CLIENT, FEE, 5);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.request_service(
                "550e8400-e29b-41d4-a716-446655440001".to_string(),
                QUERY.to_string(),
            );
        }));
        assert!(result.is_err());
        set_context(CLIENT, FEE, 6);
        contract.request_service(
            "550e8400-e29b-41d4-a716-446655440001".to_string(),
            QUERY.to_string(),
        );
    }

    #[test]
    #[should_panic(expected = "incorrect fee")]
    fn requires_exact_attached_fee() {
        let mut contract = contract();
        set_context(CLIENT, FEE - 1, 1);
        contract.request_service(REQUEST_ID.to_string(), QUERY.to_string());
    }

    #[test]
    #[should_panic(expected = "query is empty or contains disallowed input")]
    fn rejects_invalid_query() {
        let mut contract = contract();
        set_context(CLIENT, FEE, 1);
        contract.request_service(REQUEST_ID.to_string(), "hello\nworld".to_string());
    }

    #[test]
    fn pauses_only_new_requests_and_owner_can_resume() {
        let mut contract = contract();
        set_context(OWNER, 0, 1);
        contract.set_paused(true);
        assert!(contract.is_paused());
        set_context(CLIENT, FEE, 1);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.request_service(REQUEST_ID.to_string(), QUERY.to_string());
        }));
        assert!(result.is_err());
        set_context(OWNER, 0, 2);
        contract.set_paused(false);
        assert!(!contract.is_paused());
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn non_owner_cannot_pause_contract() {
        let mut contract = contract();
        set_context(CLIENT, 0, 1);
        contract.set_paused(true);
    }

    #[test]
    fn report_transition_locks_before_cross_contract_call() {
        let mut contract = contract();
        open_request(&mut contract);
        set_context(AGENT, 0, 2);
        let _promise = contract.submit_report(REQUEST_ID.to_string(), "a".repeat(64), false, false);
        assert_eq!(
            contract.requests.get(REQUEST_ID).unwrap().status,
            RequestStatus::Locking
        );
    }

    #[test]
    #[should_panic(expected = "request is not open")]
    fn duplicate_report_cannot_reenter_while_lock_is_pending() {
        let mut contract = contract();
        open_request(&mut contract);
        set_context(AGENT, 0, 2);
        let _promise = contract.submit_report(REQUEST_ID.to_string(), "a".repeat(64), false, false);
        let _second = contract.submit_report(REQUEST_ID.to_string(), "b".repeat(64), false, false);
    }

    #[test]
    fn agent_confirmation_locks_state_before_treasury_release() {
        let mut contract = contract();
        open_request(&mut contract);
        let request = contract.requests.get_mut(REQUEST_ID).unwrap();
        request.report_hash = Some("a".repeat(64));
        request.status = RequestStatus::Escrowed;

        set_context(AGENT, 0, 2);
        let _promise = contract.confirm_report_received(REQUEST_ID.to_string(), "a".repeat(64));

        assert_eq!(
            contract.requests.get(REQUEST_ID).unwrap().status,
            RequestStatus::Releasing
        );
    }

    #[test]
    #[should_panic(expected = "only the configured agent can confirm receipt")]
    fn requester_cannot_forge_agent_receipt_confirmation() {
        let mut contract = contract();
        open_request(&mut contract);
        let request = contract.requests.get_mut(REQUEST_ID).unwrap();
        request.report_hash = Some("a".repeat(64));
        request.status = RequestStatus::Escrowed;

        set_context(CLIENT, 0, 2);
        let _promise = contract.confirm_report_received(REQUEST_ID.to_string(), "a".repeat(64));
    }

    #[test]
    fn output_guard_routes_request_to_human_review() {
        let mut contract = contract();
        open_request(&mut contract);
        set_context(AGENT, 0, 2);
        let _promise = contract.submit_report(REQUEST_ID.to_string(), "a".repeat(64), false, true);

        let request = contract.requests.get(REQUEST_ID).unwrap();
        assert!(request.requires_review);
        assert_eq!(request.status, RequestStatus::Locking);
    }

    #[test]
    #[should_panic(expected = "request cannot be refunded in its current state")]
    fn refund_is_blocked_while_under_review_even_after_timeout() {
        let mut contract = contract();
        open_request(&mut contract);
        contract.requests.get_mut(REQUEST_ID).unwrap().status = RequestStatus::UnderReview;
        set_context(CLIENT, 0, DEFAULT_REFUND_WINDOW_NS + 1);
        let _promise = contract.claim_refund(REQUEST_ID.to_string());
    }

    #[test]
    fn client_can_dispute_review_and_owner_rejection_allows_early_refund() {
        let mut contract = contract();
        open_request(&mut contract);
        contract.requests.get_mut(REQUEST_ID).unwrap().status = RequestStatus::UnderReview;

        set_context(CLIENT, 0, 2);
        contract.dispute_under_review(REQUEST_ID.to_string());
        assert!(contract.requests.get(REQUEST_ID).unwrap().client_disputed);

        set_context(OWNER, 0, 3);
        contract.resolve_under_review(REQUEST_ID.to_string(), false);
        assert_eq!(
            contract.requests.get(REQUEST_ID).unwrap().status,
            RequestStatus::ReviewRejected
        );

        set_context(CLIENT, 0, 4);
        let _refund = contract.claim_refund(REQUEST_ID.to_string());
        assert_eq!(
            contract.requests.get(REQUEST_ID).unwrap().status,
            RequestStatus::RefundingTreasury
        );
    }

    #[test]
    fn refund_claim_locks_state_before_outgoing_transfer() {
        let mut contract = contract();
        open_request(&mut contract);
        set_context(CLIENT, 0, DEFAULT_REFUND_WINDOW_NS + 1);
        let _promise = contract.claim_refund(REQUEST_ID.to_string());
        assert_eq!(
            contract.requests.get(REQUEST_ID).unwrap().status,
            RequestStatus::RefundingLocal
        );
    }

    #[test]
    fn expired_lock_attempt_uses_treasury_rescue_path() {
        let mut contract = contract();
        open_request(&mut contract);
        set_context(AGENT, 0, 2);
        let _promise = contract.submit_report(REQUEST_ID.to_string(), "a".repeat(64), false, false);

        set_context(CLIENT, 0, DEFAULT_REFUND_WINDOW_NS + 1);
        let _rescue = contract.claim_refund(REQUEST_ID.to_string());
        assert_eq!(
            contract.requests.get(REQUEST_ID).unwrap().status,
            RequestStatus::RescuingLock
        );
    }

    #[test]
    fn both_contracts_lock_state_before_cross_contract_actions() {
        let mut hire = contract();
        open_request(&mut hire);
        set_context(AGENT, 0, 2);
        let _lock_promise =
            hire.submit_report(REQUEST_ID.to_string(), "a".repeat(64), false, false);
        assert_eq!(
            hire.requests.get(REQUEST_ID).unwrap().status,
            RequestStatus::Locking
        );

        set_treasury_context(OWNER, 0, 1);
        let mut treasury = OrbitTreasury::new(account(OWNER), account("orbit.testnet"), U128(FEE));
        set_treasury_context("orbit.testnet", FEE, 2);
        treasury.lock_funds(
            REQUEST_ID.to_string(),
            account(CLIENT),
            account(AGENT),
            DEFAULT_REFUND_WINDOW_NS + 1,
        );
        set_treasury_context("orbit.testnet", 0, 2);
        let _release_promise = treasury.release(REQUEST_ID.to_string());
        assert_eq!(
            treasury.get_escrow_status(REQUEST_ID.to_string()),
            Some("releasing".to_string())
        );

        set_treasury_context("orbit.testnet", 0, 2);
        let reentrant_release = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _promise = treasury.release(REQUEST_ID.to_string());
        }));
        assert!(reentrant_release.is_err());

        set_context(AGENT, 0, 2);
        let duplicate_report = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _promise = hire.submit_report(REQUEST_ID.to_string(), "b".repeat(64), false, false);
        }));
        assert!(duplicate_report.is_err());
    }

    #[test]
    fn malicious_guard_signal_records_a_fixed_error_receipt_without_report_content() {
        let mut contract = contract();
        open_request(&mut contract);
        set_context(AGENT, 0, 2);
        let _promise =
            contract.submit_report(REQUEST_ID.to_string(), "invalid".to_string(), true, false);

        let request = contract.requests.get(REQUEST_ID).unwrap();
        assert!(request.malicious_query_detected);
        assert_eq!(
            request.report_hash.as_deref(),
            Some(to_lower_hex(&env::sha256(b"MALICIOUS_QUERY_DETECTED")).as_str())
        );
    }

    #[test]
    #[should_panic(expected = "request cannot be refunded in its current state")]
    fn refund_cannot_be_reentered_while_transfer_is_pending() {
        let mut contract = contract();
        open_request(&mut contract);
        set_context(CLIENT, 0, DEFAULT_REFUND_WINDOW_NS + 1);
        let _promise = contract.claim_refund(REQUEST_ID.to_string());
        let _second = contract.claim_refund(REQUEST_ID.to_string());
    }

    #[test]
    #[should_panic(expected = "only the configured agent can submit a report")]
    fn untrusted_contract_cannot_submit_report() {
        let mut contract = contract();
        open_request(&mut contract);
        set_context(TREASURY, 0, 2);
        let _promise = contract.submit_report(REQUEST_ID.to_string(), "a".repeat(64), false, false);
    }
}
