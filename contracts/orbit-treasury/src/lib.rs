use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::{
    env, ext_contract, json_types::U128, near, require, store::LookupMap, AccountId,
    BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
};
use orbit_common::{is_valid_uuid_v4, DEFAULT_REFUND_WINDOW_NS};

const CALLBACK_GAS: Gas = Gas::from_tgas(10);

#[derive(BorshSerialize, BorshStorageKey)]
enum StorageKey {
    Escrows,
}

#[derive(BorshDeserialize, BorshSerialize, Clone, Copy, PartialEq, Eq)]
enum EscrowStatus {
    Held,
    Releasing,
    Refunding,
    Released,
    Refunded,
}

#[derive(BorshDeserialize, BorshSerialize)]
struct Escrow {
    requester_id: AccountId,
    beneficiary_id: AccountId,
    amount: u128,
    refund_after_ns: u64,
    status: EscrowStatus,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct OrbitTreasury {
    owner_id: AccountId,
    orbit_hire_id: AccountId,
    fee_yocto: u128,
    paused: bool,
    total_escrowed_yocto: u128,
    escrows: LookupMap<String, Escrow>,
}

#[ext_contract(ext_self)]
#[allow(dead_code)]
trait ExtSelf {
    fn on_release_complete(&mut self, request_id: String) -> bool;
    fn on_refund_complete(&mut self, request_id: String) -> bool;
    fn on_rescue_refund_complete(&mut self, request_id: String) -> String;
}

#[near]
impl OrbitTreasury {
    #[init]
    pub fn new(owner_id: AccountId, orbit_hire_id: AccountId, fee_yocto: U128) -> Self {
        require!(fee_yocto.0 > 0, "fee must be greater than zero");
        require!(owner_id != orbit_hire_id, "owner and OrbitHire must differ");
        Self {
            owner_id,
            orbit_hire_id,
            fee_yocto: fee_yocto.0,
            paused: false,
            total_escrowed_yocto: 0,
            escrows: LookupMap::new(StorageKey::Escrows),
        }
    }

    #[payable]
    pub fn lock_funds(
        &mut self,
        request_id: String,
        requester_id: AccountId,
        beneficiary_id: AccountId,
        refund_after_ns: u64,
    ) -> bool {
        self.assert_orbit_hire();
        require!(!self.paused, "new escrows are paused");
        require!(is_valid_uuid_v4(&request_id), "invalid request_id");
        require!(
            env::attached_deposit().as_yoctonear() == self.fee_yocto,
            "incorrect escrow amount"
        );
        require!(
            refund_after_ns > env::block_timestamp()
                && refund_after_ns
                    <= env::block_timestamp().saturating_add(DEFAULT_REFUND_WINDOW_NS),
            "invalid refund deadline"
        );
        require!(!self.escrows.contains_key(&request_id), "duplicate escrow");

        self.total_escrowed_yocto = self
            .total_escrowed_yocto
            .checked_add(self.fee_yocto)
            .unwrap_or_else(|| env::panic_str("escrow liability overflow"));
        self.escrows.insert(
            request_id,
            Escrow {
                requester_id,
                beneficiary_id,
                amount: self.fee_yocto,
                refund_after_ns,
                status: EscrowStatus::Held,
            },
        );
        self.assert_solvent();
        true
    }

    pub fn release(&mut self, request_id: String) -> Promise {
        require!(is_valid_uuid_v4(&request_id), "invalid request_id");
        self.assert_orbit_hire();
        let escrow = self
            .escrows
            .get_mut(&request_id)
            .unwrap_or_else(|| env::panic_str("escrow not found"));
        require!(
            escrow.status == EscrowStatus::Held,
            "escrow is not releasable"
        );
        escrow.status = EscrowStatus::Releasing;
        let beneficiary_id = escrow.beneficiary_id.clone();
        let amount = escrow.amount;

        Promise::new(beneficiary_id)
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_release_complete(request_id),
            )
    }

    pub fn refund(&mut self, request_id: String, recipient_id: AccountId) -> Promise {
        require!(is_valid_uuid_v4(&request_id), "invalid request_id");
        self.assert_orbit_hire();
        let escrow = self
            .escrows
            .get_mut(&request_id)
            .unwrap_or_else(|| env::panic_str("escrow not found"));
        require!(
            escrow.status == EscrowStatus::Held,
            "escrow is not refundable"
        );
        require!(
            env::block_timestamp() >= escrow.refund_after_ns,
            "refund window has not expired"
        );
        self.start_refund(request_id, recipient_id)
    }

    pub fn refund_review_rejected(
        &mut self,
        request_id: String,
        recipient_id: AccountId,
    ) -> Promise {
        require!(is_valid_uuid_v4(&request_id), "invalid request_id");
        self.assert_orbit_hire();
        self.start_refund(request_id, recipient_id)
    }

    fn start_refund(&mut self, request_id: String, recipient_id: AccountId) -> Promise {
        require!(
            self.escrows
                .get(&request_id)
                .map(|escrow| escrow.requester_id == recipient_id)
                .unwrap_or(false),
            "refund recipient must be the requester"
        );
        let escrow = self
            .escrows
            .get_mut(&request_id)
            .unwrap_or_else(|| env::panic_str("escrow not found"));
        require!(
            escrow.status == EscrowStatus::Held,
            "escrow is not refundable"
        );
        escrow.status = EscrowStatus::Refunding;
        let amount = escrow.amount;

        Promise::new(recipient_id)
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_refund_complete(request_id),
            )
    }

    pub fn rescue_expired(
        &mut self,
        request_id: String,
        recipient_id: AccountId,
    ) -> PromiseOrValue<String> {
        require!(is_valid_uuid_v4(&request_id), "invalid request_id");
        self.assert_orbit_hire();
        let Some(escrow) = self.escrows.get_mut(&request_id) else {
            return PromiseOrValue::Value("not_found".to_string());
        };
        require!(escrow.status == EscrowStatus::Held, "escrow is not held");
        require!(
            env::block_timestamp() >= escrow.refund_after_ns,
            "refund window has not expired"
        );
        require!(
            recipient_id == escrow.requester_id,
            "refund recipient must be the requester"
        );
        escrow.status = EscrowStatus::Refunding;
        let amount = escrow.amount;

        PromiseOrValue::Promise(
            Promise::new(recipient_id)
                .transfer(NearToken::from_yoctonear(amount))
                .then(
                    ext_self::ext(env::current_account_id())
                        .with_static_gas(CALLBACK_GAS)
                        .on_rescue_refund_complete(request_id),
                ),
        )
    }

    #[private]
    pub fn on_rescue_refund_complete(&mut self, request_id: String) -> String {
        let succeeded = promise_succeeded();
        let escrow = self
            .escrows
            .get_mut(&request_id)
            .unwrap_or_else(|| env::panic_str("escrow not found"));
        require!(
            escrow.status == EscrowStatus::Refunding,
            "invalid rescue callback state"
        );
        if succeeded {
            escrow.status = EscrowStatus::Refunded;
            self.total_escrowed_yocto = self
                .total_escrowed_yocto
                .checked_sub(escrow.amount)
                .unwrap_or_else(|| env::panic_str("escrow liability underflow"));
            "refunded".to_string()
        } else {
            escrow.status = EscrowStatus::Held;
            "transfer_failed".to_string()
        }
    }

    #[private]
    pub fn on_release_complete(&mut self, request_id: String) -> bool {
        let succeeded = promise_succeeded();
        let escrow = self
            .escrows
            .get_mut(&request_id)
            .unwrap_or_else(|| env::panic_str("escrow not found"));
        require!(
            escrow.status == EscrowStatus::Releasing,
            "invalid release callback state"
        );
        if succeeded {
            escrow.status = EscrowStatus::Released;
            self.total_escrowed_yocto = self
                .total_escrowed_yocto
                .checked_sub(escrow.amount)
                .unwrap_or_else(|| env::panic_str("escrow liability underflow"));
        } else {
            escrow.status = EscrowStatus::Held;
        }
        succeeded
    }

    #[private]
    pub fn on_refund_complete(&mut self, request_id: String) -> bool {
        let succeeded = promise_succeeded();
        let escrow = self
            .escrows
            .get_mut(&request_id)
            .unwrap_or_else(|| env::panic_str("escrow not found"));
        require!(
            escrow.status == EscrowStatus::Refunding,
            "invalid refund callback state"
        );
        if succeeded {
            escrow.status = EscrowStatus::Refunded;
            self.total_escrowed_yocto = self
                .total_escrowed_yocto
                .checked_sub(escrow.amount)
                .unwrap_or_else(|| env::panic_str("escrow liability underflow"));
        } else {
            escrow.status = EscrowStatus::Held;
        }
        succeeded
    }

    #[payable]
    pub fn fund_storage_reserve(&mut self) {
        self.assert_owner();
        require!(
            env::attached_deposit().as_yoctonear() > 0,
            "deposit must be positive"
        );
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
    }

    pub fn get_escrow_status(&self, request_id: String) -> Option<String> {
        if !is_valid_uuid_v4(&request_id) {
            return None;
        }
        self.escrows.get(&request_id).map(|escrow| {
            match escrow.status {
                EscrowStatus::Held => "held",
                EscrowStatus::Releasing => "releasing",
                EscrowStatus::Refunding => "refunding",
                EscrowStatus::Released => "released",
                EscrowStatus::Refunded => "refunded",
            }
            .to_string()
        })
    }

    pub fn get_total_escrowed(&self) -> U128 {
        U128(self.total_escrowed_yocto)
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
    }

    fn assert_orbit_hire(&self) {
        require!(
            env::predecessor_account_id() == self.orbit_hire_id,
            "OrbitHire only"
        );
    }

    fn assert_solvent(&self) {
        let reserve = (env::storage_usage() as u128)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .unwrap_or_else(|| env::panic_str("storage reserve overflow"));
        let required = reserve
            .checked_add(self.total_escrowed_yocto)
            .unwrap_or_else(|| env::panic_str("required balance overflow"));
        require!(
            env::account_balance().as_yoctonear() >= required,
            "insufficient treasury storage reserve"
        );
    }
}

fn promise_succeeded() -> bool {
    env::promise_result_checked(0, 0).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::{test_utils::VMContextBuilder, testing_env};

    const OWNER: &str = "owner.testnet";
    const ORBIT_HIRE: &str = "orbit.testnet";
    const CLIENT: &str = "client.testnet";
    const AGENT: &str = "agent.testnet";
    const REQUEST_ID: &str = "550e8400-e29b-41d4-a716-446655440000";
    const FEE: u128 = 100_000_000_000_000_000_000_000;
    const DEADLINE: u64 = DEFAULT_REFUND_WINDOW_NS + 1;

    fn account(value: &str) -> AccountId {
        value.parse().unwrap()
    }

    fn set_context(predecessor: &str, deposit: u128, timestamp: u64) {
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

    fn contract() -> OrbitTreasury {
        set_context(OWNER, 0, 1);
        OrbitTreasury::new(account(OWNER), account(ORBIT_HIRE), U128(FEE))
    }

    fn lock(contract: &mut OrbitTreasury) {
        set_context(ORBIT_HIRE, FEE, 1);
        contract.lock_funds(
            REQUEST_ID.to_string(),
            account(CLIENT),
            account(AGENT),
            DEADLINE,
        );
    }

    #[test]
    fn locks_exact_amount_for_authorized_contract_and_records_liability() {
        let mut contract = contract();
        lock(&mut contract);
        assert_eq!(
            contract.get_escrow_status(REQUEST_ID.to_string()),
            Some("held".to_string())
        );
        assert_eq!(contract.get_total_escrowed(), U128(FEE));
    }

    #[test]
    #[should_panic(expected = "OrbitHire only")]
    fn rejects_funds_from_untrusted_predecessor() {
        let mut contract = contract();
        set_context(CLIENT, FEE, 1);
        contract.lock_funds(
            REQUEST_ID.to_string(),
            account(CLIENT),
            account(AGENT),
            DEADLINE,
        );
    }

    #[test]
    #[should_panic(expected = "incorrect escrow amount")]
    fn requires_exact_escrow_amount() {
        let mut contract = contract();
        set_context(ORBIT_HIRE, FEE - 1, 1);
        contract.lock_funds(
            REQUEST_ID.to_string(),
            account(CLIENT),
            account(AGENT),
            DEADLINE,
        );
    }

    #[test]
    #[should_panic(expected = "duplicate escrow")]
    fn rejects_duplicate_escrow_id() {
        let mut contract = contract();
        lock(&mut contract);
        set_context(ORBIT_HIRE, FEE, 2);
        contract.lock_funds(
            REQUEST_ID.to_string(),
            account(CLIENT),
            account(AGENT),
            DEADLINE,
        );
    }

    #[test]
    fn marks_escrow_releasing_before_external_transfer_and_prevents_reentry() {
        let mut contract = contract();
        lock(&mut contract);
        set_context(ORBIT_HIRE, 0, 2);
        let _promise = contract.release(REQUEST_ID.to_string());
        assert_eq!(
            contract.get_escrow_status(REQUEST_ID.to_string()),
            Some("releasing".to_string())
        );
    }

    #[test]
    #[should_panic(expected = "escrow is not releasable")]
    fn rejects_release_reentry_while_transfer_is_pending() {
        let mut contract = contract();
        lock(&mut contract);
        set_context(ORBIT_HIRE, 0, 2);
        let _promise = contract.release(REQUEST_ID.to_string());
        let _second = contract.release(REQUEST_ID.to_string());
    }

    #[test]
    fn marks_refund_pending_before_external_transfer() {
        let mut contract = contract();
        lock(&mut contract);
        set_context(ORBIT_HIRE, 0, DEADLINE);
        let _promise = contract.refund(REQUEST_ID.to_string(), account(CLIENT));
        assert_eq!(
            contract.get_escrow_status(REQUEST_ID.to_string()),
            Some("refunding".to_string())
        );
    }

    #[test]
    #[should_panic(expected = "escrow is not refundable")]
    fn rejects_refund_reentry_while_transfer_is_pending() {
        let mut contract = contract();
        lock(&mut contract);
        set_context(ORBIT_HIRE, 0, DEADLINE);
        let _promise = contract.refund(REQUEST_ID.to_string(), account(CLIENT));
        let _second = contract.refund(REQUEST_ID.to_string(), account(CLIENT));
    }

    #[test]
    fn expired_rescue_only_refunds_an_existing_held_escrow() {
        let mut contract = contract();
        lock(&mut contract);
        set_context(ORBIT_HIRE, 0, DEADLINE);
        let _promise = contract.rescue_expired(REQUEST_ID.to_string(), account(CLIENT));
        assert_eq!(
            contract.get_escrow_status(REQUEST_ID.to_string()),
            Some("refunding".to_string())
        );
    }

    #[test]
    fn expired_rescue_reports_missing_escrow_without_sending_funds() {
        let mut contract = contract();
        set_context(ORBIT_HIRE, 0, DEADLINE);
        let result = contract.rescue_expired(REQUEST_ID.to_string(), account(CLIENT));
        assert!(matches!(
            result,
            PromiseOrValue::Value(ref outcome) if outcome == "not_found"
        ));
    }

    #[test]
    #[should_panic(expected = "refund window has not expired")]
    fn rejects_early_refund_even_from_orbit_hire() {
        let mut contract = contract();
        lock(&mut contract);
        set_context(ORBIT_HIRE, 0, 2);
        let _promise = contract.refund(REQUEST_ID.to_string(), account(CLIENT));
    }

    #[test]
    fn allows_early_refund_for_orbit_hire_review_rejection() {
        let mut contract = contract();
        lock(&mut contract);
        set_context(ORBIT_HIRE, 0, 2);
        let _promise = contract.refund_review_rejected(REQUEST_ID.to_string(), account(CLIENT));
        assert_eq!(
            contract.get_escrow_status(REQUEST_ID.to_string()),
            Some("refunding".to_string())
        );
    }

    #[test]
    #[should_panic(expected = "OrbitHire only")]
    fn rejects_review_refund_from_untrusted_caller() {
        let mut contract = contract();
        lock(&mut contract);
        set_context(CLIENT, 0, 2);
        let _promise = contract.refund_review_rejected(REQUEST_ID.to_string(), account(CLIENT));
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn non_owner_cannot_pause_treasury() {
        let mut contract = contract();
        set_context(CLIENT, 0, 1);
        contract.set_paused(true);
    }

    #[test]
    fn pause_blocks_new_escrows_but_does_not_change_existing_balance() {
        let mut contract = contract();
        lock(&mut contract);
        set_context(OWNER, 0, 2);
        contract.set_paused(true);
        assert!(contract.paused);
        assert_eq!(contract.total_escrowed_yocto, FEE);
        assert_eq!(
            contract.get_escrow_status(REQUEST_ID.to_string()),
            Some("held".to_string())
        );
    }
}
