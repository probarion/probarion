//! Cross-contract interfaces the vault calls. The vault attaches the 1 yoctoNEAR itself;
//! a Function-Call key cannot (I4).
use near_sdk::json_types::U128;
use near_sdk::{ext_contract, AccountId};

#[ext_contract(ext_ft)]
pub trait FtContract {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
}

/// `intents.near` (or `intents-stub` on testnet). Authenticates by predecessor; no keys needed.
#[ext_contract(ext_intents)]
pub trait IntentsContract {
    fn ft_withdraw(
        &mut self,
        token: AccountId,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: Option<String>,
    ) -> U128;
}
