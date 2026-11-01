//! Probarion vault: an AI agent spends USDC only inside mandates the owner signed.
//! ABI, error codes and events: docs/specs/2026-10-21-probarion-interfaces.md §4.
#![allow(clippy::too_many_arguments)] // `new` has 7 ABI args; the near macro adds `self` to its generated ext wrapper
use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::{U128, U64};
use near_sdk::store::{LookupMap, LookupSet, Vector};
use near_sdk::{env, near, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, PublicKey};

pub mod errors;
pub mod events;
pub mod ext;
#[cfg(test)]
mod test_utils;
pub mod types;

pub use errors::{fail, require_one_yocto, ErrorCode};
pub use events::VaultEvent;
pub use types::*;

pub const WITHDRAW_MEMO_PREFIX: &str = "WITHDRAW_TO:";
pub const NEAR_MEMO_PREFIX: &str = "probarion:";
pub const DAY_NS: u64 = 86_400_000_000_000;
pub const MAX_HELD_TTL_NS: u64 = 30 * DAY_NS;
pub const MAX_APPROVERS: usize = 10;
pub const MAX_ASSETS: usize = 10;
pub const MAX_AGENTS: usize = 16;
pub const MAX_PAGE: u64 = 100;
pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// USDC `storage_balance_bounds().min` on mainnet (0.00125 NEAR).
pub const USDC_STORAGE_DEPOSIT: NearToken =
    NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
pub const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
pub const GAS_FT_WITHDRAW: Gas = Gas::from_tgas(100);
pub const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
pub const GAS_CALLBACK: Gas = Gas::from_tgas(15);

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    Mandates,
    Spends,
    Invoices,
    Refs,
    Anchors,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Vault {
    owner: AccountId,
    approvers: Vec<AccountId>,
    usdc: AccountId,
    intents: AccountId,
    allowed_assets: Vec<AccountId>,
    daily_backstop: u128,
    held_ttl_ns: u64,
    frozen: bool,
    factory: Option<AccountId>,
    ledger_key: Option<PublicKey>,
    agents: Vec<Agent>,
    /// Mandate id = position + 1.
    mandates: Vector<Mandate>,
    /// Spend id = position + 1.
    spends: Vector<Spend>,
    /// invoice_hash -> spend id, while that spend is Held, Pending, Paid or Burned (I3).
    invoices: LookupMap<String, u64>,
    /// Every ref ever accepted. Refs are idempotency keys and are never released.
    refs: LookupSet<String>,
    /// Anchor seq = position + 1.
    anchors: Vector<Anchor>,
    day_bucket: u64,
    day_total: u128,
}

#[near]
impl Vault {
    #[init]
    pub fn new(
        owner: AccountId,
        approvers: Vec<AccountId>,
        usdc: AccountId,
        intents: AccountId,
        allowed_assets: Vec<AccountId>,
        daily_backstop: U128,
        held_ttl_ns: U64,
    ) -> Self {
        let valid = !approvers.is_empty()
            && approvers.len() <= MAX_APPROVERS
            && allowed_assets.len() <= MAX_ASSETS
            && daily_backstop.0 > 0
            && held_ttl_ns.0 > 0
            && held_ttl_ns.0 <= MAX_HELD_TTL_NS;
        if !valid {
            fail(ErrorCode::InvalidInput)
        }
        let predecessor = env::predecessor_account_id();
        let factory = (predecessor != env::current_account_id()).then_some(predecessor);
        Self {
            owner,
            approvers,
            usdc,
            intents,
            allowed_assets,
            daily_backstop: daily_backstop.0,
            held_ttl_ns: held_ttl_ns.0,
            frozen: false,
            factory,
            ledger_key: None,
            agents: Vec::new(),
            mandates: Vector::new(StorageKey::Mandates),
            spends: Vector::new(StorageKey::Spends),
            invoices: LookupMap::new(StorageKey::Invoices),
            refs: LookupSet::new(StorageKey::Refs),
            anchors: Vector::new(StorageKey::Anchors),
            day_bucket: 0,
            day_total: 0,
        }
    }

    pub fn get_config(&self) -> VaultConfig {
        VaultConfig {
            owner: self.owner.clone(),
            approvers: self.approvers.clone(),
            usdc: self.usdc.clone(),
            intents: self.intents.clone(),
            allowed_assets: self.allowed_assets.clone(),
            daily_backstop: U128(self.daily_backstop),
            held_ttl_ns: U64(self.held_ttl_ns),
            frozen: self.frozen,
            factory: self.factory.clone(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            ledger_key: self.ledger_key.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::test_utils::*;
    use crate::*;

    fn deploy_as(predecessor: AccountId) -> Vault {
        fresh_env();
        as_account(predecessor, T0);
        Vault::new(
            owner(),
            vec![approver()],
            usdc(),
            intents(),
            vec![base_asset()],
            U128(500 * USDC),
            U64(HOUR_NS),
        )
    }

    #[test]
    fn plain_deploy_stores_config_without_a_factory() {
        let v = deploy_as(vault_id());
        assert_eq!(
            v.get_config(),
            VaultConfig {
                owner: owner(),
                approvers: vec![approver()],
                usdc: usdc(),
                intents: intents(),
                allowed_assets: vec![base_asset()],
                daily_backstop: U128(500 * USDC),
                held_ttl_ns: U64(HOUR_NS),
                frozen: false,
                factory: None,
                version: "0.1.0".to_string(),
                ledger_key: None,
            }
        );
    }

    #[test]
    fn deploy_by_another_account_records_it_as_the_factory() {
        let v = deploy_as(acc("vaults.probarion.near"));
        assert_eq!(v.get_config().factory, Some(acc("vaults.probarion.near")));
    }

    #[test]
    #[should_panic(expected = "PROBARION:InvalidInput")]
    fn new_rejects_empty_approvers() {
        fresh_env();
        Vault::new(owner(), vec![], usdc(), intents(), vec![], U128(1), U64(1));
    }

    #[test]
    #[should_panic(expected = "PROBARION:InvalidInput")]
    fn new_rejects_more_than_ten_approvers() {
        fresh_env();
        let many: Vec<AccountId> = (0..11).map(|i| acc(&format!("a{i}.near"))).collect();
        Vault::new(owner(), many, usdc(), intents(), vec![], U128(1), U64(1));
    }

    #[test]
    #[should_panic(expected = "PROBARION:InvalidInput")]
    fn new_rejects_a_zero_daily_backstop() {
        fresh_env();
        Vault::new(
            owner(),
            vec![approver()],
            usdc(),
            intents(),
            vec![],
            U128(0),
            U64(1),
        );
    }

    #[test]
    #[should_panic(expected = "PROBARION:InvalidInput")]
    fn new_rejects_a_hold_ttl_over_thirty_days() {
        fresh_env();
        Vault::new(
            owner(),
            vec![approver()],
            usdc(),
            intents(),
            vec![],
            U128(1),
            U64(MAX_HELD_TTL_NS + 1),
        );
    }
}
