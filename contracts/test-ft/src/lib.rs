//! NEP-141 test token for the Probarion sandbox and testnet. Never deployed on mainnet.
//! On testnet it is deployed as `usdc.probarion.testnet` and as the two POA-like tokens
//! `base-usdc.probarion.testnet` and `sol-usdc.probarion.testnet`.
use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::borsh::BorshSerialize;
use near_sdk::collections::LazyOption;
use near_sdk::json_types::U128;
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue,
};

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    Token,
    Metadata,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct TestFt {
    owner_id: AccountId,
    token: FungibleToken,
    metadata: LazyOption<FungibleTokenMetadata>,
}

#[near]
impl TestFt {
    #[init]
    pub fn new(owner_id: AccountId, name: String, symbol: String, decimals: u8) -> Self {
        let metadata = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name,
            symbol,
            icon: None,
            reference: None,
            reference_hash: None,
            decimals,
        };
        metadata.assert_valid();
        Self {
            owner_id,
            token: FungibleToken::new(StorageKey::Token),
            metadata: LazyOption::new(StorageKey::Metadata, Some(&metadata)),
        }
    }

    /// Owner-only mint for tests. Registers `account_id` first when needed.
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "test-ft: only the owner can mint"
        );
        if !self.token.accounts.contains_key(&account_id) {
            self.token.internal_register_account(&account_id);
        }
        self.token.internal_deposit(&account_id, amount.0);
        FtMint {
            owner_id: &account_id,
            amount,
            memo: Some("test-ft mint"),
        }
        .emit();
    }
}

#[near]
impl FungibleTokenCore for TestFt {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for TestFt {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used, burned) =
            self.token
                .internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned > 0 {
            log!("Account @{} burned {}", sender_id, burned);
        }
        used.into()
    }
}

#[near]
impl StorageManagement for TestFt {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for TestFt {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.get().expect("metadata is set at init")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn ctx(predecessor: AccountId, deposit: NearToken) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(predecessor)
            .attached_deposit(deposit)
            .build());
    }

    fn setup() -> TestFt {
        ctx(accounts(0), NearToken::from_yoctonear(0));
        TestFt::new(accounts(0), "Test USDC".to_string(), "USDC".to_string(), 6)
    }

    #[test]
    fn owner_mint_registers_and_credits() {
        let mut t = setup();
        t.mint(accounts(1), U128(5_000_000));
        assert_eq!(t.ft_balance_of(accounts(1)), U128(5_000_000));
        assert_eq!(t.ft_total_supply(), U128(5_000_000));
        assert!(t.storage_balance_of(accounts(1)).is_some());
        assert_eq!(t.ft_metadata().decimals, 6);
    }

    #[test]
    #[should_panic(expected = "test-ft: only the owner can mint")]
    fn non_owner_cannot_mint() {
        let mut t = setup();
        ctx(accounts(1), NearToken::from_yoctonear(0));
        t.mint(accounts(1), U128(1));
    }

    #[test]
    fn storage_deposit_registers_an_account() {
        let mut t = setup();
        let min = t.storage_balance_bounds().min;
        ctx(accounts(2), min);
        t.storage_deposit(Some(accounts(2)), Some(true));
        assert!(t.storage_balance_of(accounts(2)).is_some());
    }

    #[test]
    fn transfer_with_one_yocto_moves_tokens() {
        let mut t = setup();
        t.mint(accounts(1), U128(10));
        t.mint(accounts(2), U128(0));
        ctx(accounts(1), NearToken::from_yoctonear(1));
        t.ft_transfer(accounts(2), U128(4), None);
        assert_eq!(t.ft_balance_of(accounts(2)), U128(4));
        assert_eq!(t.ft_balance_of(accounts(1)), U128(6));
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn transfer_without_one_yocto_fails() {
        let mut t = setup();
        t.mint(accounts(1), U128(10));
        t.mint(accounts(2), U128(0));
        ctx(accounts(1), NearToken::from_yoctonear(0));
        t.ft_transfer(accounts(2), U128(4), None);
    }
}
