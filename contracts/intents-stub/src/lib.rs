//! intents-stub: a sandbox and testnet stand-in for `intents.near`. NEVER deploy it on mainnet.
//!
//! `intents.near` has no testnet, so the near-workspaces sandbox tests and the testnet demo need
//! something to receive the vault's Intents payout. This crate models only what the Probarion
//! vault touches: NEP-141 deposits, `ft_withdraw` with predecessor auth and exactly 1 yoctoNEAR,
//! the two burn logs that the verifier's check (h) reads, `public_keys_of` / `add_public_key`,
//! `is_auth_by_predecessor_id_enabled` and `mt_balance_of`. `README.md` lists every difference;
//! the ones that matter when you read a test result are:
//!
//! - **No signed intents and no bridge.** There is no `execute_intents`, no NEP-413 or ERC-191
//!   signature, no solver, no `token_diff` and no fee. Nothing leaves NEAR: a POA "burn" only logs
//!   and records the event, and the tokens stay in this account on the token contract.
//! - **Both burn logs come from this one account, in one receipt.** On mainnet `mt_burn` (NEP-245)
//!   comes from `intents.near` and the POA `ft_burn` (NEP-300, `owner_id` = `intents.near`, memo
//!   `WITHDRAW_TO:<address>`) comes from the POA token contract, in a later receipt of the same
//!   transaction. Here `owner_id` of the `ft_burn` is this stub account, and the `mt_burn`
//!   `owner_id` is the calling vault, as on mainnet. The verifier must accept the stub as the
//!   emitter of both when it runs against the stub.
//! - **Only what the vault needs.** NEP-141 deposits only (no NEP-245 or NEP-171 transfers), no
//!   `msg` on `ft_withdraw`, no DAO roles, no `remove_public_key`, no storage accounting.
//! - **Different gas.** The vault's gas budget for `ft_withdraw` is proven on mainnet (spike S1),
//!   not against this stub.
//! - **`add_public_key` exists only so tests can prove the vault never calls it** (I8).
use near_contract_standards::fungible_token::events::FtBurn;
use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, LookupSet, Vector};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    PromiseError, PromiseOrValue, PublicKey,
};

pub const WITHDRAW_MEMO_PREFIX: &str = "WITHDRAW_TO:";
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    Balances,
    Keys,
    AuthDisabled,
    Burns,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct BurnRecord {
    pub owner_id: AccountId,
    pub token: AccountId,
    pub amount: U128,
    pub memo: String,
}

#[ext_contract(ext_ft)]
pub trait FtContract {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct IntentsStub {
    /// (owner, token) -> balance in the token's smallest unit.
    balances: LookupMap<(AccountId, AccountId), u128>,
    keys: LookupMap<AccountId, Vec<String>>,
    auth_disabled: LookupSet<AccountId>,
    burns: Vector<BurnRecord>,
}

#[near]
impl IntentsStub {
    #[init]
    pub fn new() -> Self {
        Self {
            balances: LookupMap::new(StorageKey::Balances),
            keys: LookupMap::new(StorageKey::Keys),
            auth_disabled: LookupSet::new(StorageKey::AuthDisabled),
            burns: Vector::new(StorageKey::Burns),
        }
    }

    /// NEP-141 receiver. Credits `msg` (an account id) or, if `msg` is empty, `sender_id`.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        let owner: AccountId = if msg.is_empty() {
            sender_id
        } else {
            msg.parse().unwrap_or_else(|_| {
                env::panic_str("intents-stub: msg must be empty or an account id")
            })
        };
        self.credit(&owner, &token, amount.0);
        PromiseOrValue::Value(U128(0))
    }

    /// Withdraw the predecessor's balance (predecessor auth, exactly 1 yoctoNEAR). The POA
    /// burn branch (`receiver_id == token` and a `WITHDRAW_TO:` memo) logs `ft_burn` and resolves
    /// to `amount` at once; any other withdrawal is a real `ft_transfer` on `token`.
    #[payable]
    pub fn ft_withdraw(
        &mut self,
        token: AccountId,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: Option<String>,
    ) -> PromiseOrValue<U128> {
        require!(
            env::attached_deposit() == ONE_YOCTO,
            "intents-stub: requires attached deposit of exactly 1 yoctoNEAR"
        );
        require!(msg.is_none(), "intents-stub: msg is not supported");
        require!(amount.0 > 0, "intents-stub: zero amount");
        let owner = env::predecessor_account_id();
        require!(
            !self.auth_disabled.contains(&owner),
            "intents-stub: auth by predecessor is disabled"
        );
        self.debit(&owner, &token, amount.0);
        // intents.near burns the owner's internal multi-token balance (NEP-245, owner = the vault).
        emit_mt_burn(&owner, &token, amount);
        match memo {
            Some(memo) if receiver_id == token && memo.starts_with(WITHDRAW_MEMO_PREFIX) => {
                // The POA token burns its own supply, held by intents.near, and logs the memo (NEP-300).
                FtBurn {
                    owner_id: &env::current_account_id(),
                    amount,
                    memo: Some(memo.as_str()),
                }
                .emit();
                self.burns.push(BurnRecord {
                    owner_id: owner,
                    token,
                    amount,
                    memo,
                });
                PromiseOrValue::Value(amount)
            }
            memo => PromiseOrValue::Promise(
                ext_ft::ext(token.clone())
                    .with_attached_deposit(ONE_YOCTO)
                    .with_static_gas(Gas::from_tgas(15))
                    .ft_transfer(receiver_id, amount, memo)
                    .then(
                        Self::ext(env::current_account_id())
                            .with_static_gas(Gas::from_tgas(10))
                            .on_ft_withdraw(owner, token, amount),
                    ),
            ),
        }
    }

    #[private]
    pub fn on_ft_withdraw(&mut self, owner: AccountId, token: AccountId, amount: U128) -> U128 {
        if matches!(
            env::promise_result_checked(0, 64),
            Err(PromiseError::Failed)
        ) {
            self.credit(&owner, &token, amount.0);
            U128(0)
        } else {
            amount
        }
    }

    /// Exists only so tests can prove the vault never calls it (I8).
    #[payable]
    pub fn add_public_key(&mut self, public_key: PublicKey) {
        require!(
            env::attached_deposit() == ONE_YOCTO,
            "intents-stub: requires attached deposit of exactly 1 yoctoNEAR"
        );
        let owner = env::predecessor_account_id();
        let mut keys = self.keys.get(&owner).cloned().unwrap_or_default();
        let key = public_key.to_string();
        if !keys.contains(&key) {
            keys.push(key);
        }
        self.keys.insert(owner, keys);
    }

    pub fn public_keys_of(&self, account_id: AccountId) -> Vec<String> {
        self.keys.get(&account_id).cloned().unwrap_or_default()
    }

    #[payable]
    pub fn disable_auth_by_predecessor_id(&mut self) {
        require!(
            env::attached_deposit() == ONE_YOCTO,
            "intents-stub: requires attached deposit of exactly 1 yoctoNEAR"
        );
        self.auth_disabled.insert(env::predecessor_account_id());
    }

    pub fn is_auth_by_predecessor_id_enabled(&self, account_id: AccountId) -> bool {
        !self.auth_disabled.contains(&account_id)
    }

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        let token: AccountId = token_id
            .strip_prefix("nep141:")
            .and_then(|t| t.parse().ok())
            .unwrap_or_else(|| env::panic_str("intents-stub: token_id must be nep141:<account>"));
        U128(self.balance(&account_id, &token))
    }

    pub fn burns(&self, from_index: u32, limit: u32) -> Vec<BurnRecord> {
        let end = from_index
            .saturating_add(limit.min(100))
            .min(self.burns.len());
        (from_index..end)
            .filter_map(|i| self.burns.get(i).cloned())
            .collect()
    }
}

/// NEP-245 `mt_burn` in the shape `intents.near` logs on a withdrawal (memo "withdraw").
fn emit_mt_burn(owner: &AccountId, token: &AccountId, amount: U128) {
    env::log_str(&format!(
        r#"EVENT_JSON:{{"standard":"nep245","version":"1.0.0","event":"mt_burn","data":[{{"owner_id":"{owner}","token_ids":["nep141:{token}"],"amounts":["{}"],"memo":"withdraw"}}]}}"#,
        amount.0
    ));
}

impl IntentsStub {
    fn balance(&self, owner: &AccountId, token: &AccountId) -> u128 {
        self.balances
            .get(&(owner.clone(), token.clone()))
            .copied()
            .unwrap_or(0)
    }

    fn credit(&mut self, owner: &AccountId, token: &AccountId, amount: u128) {
        let next = self.balance(owner, token) + amount;
        self.balances.insert((owner.clone(), token.clone()), next);
    }

    fn debit(&mut self, owner: &AccountId, token: &AccountId, amount: u128) {
        let current = self.balance(owner, token);
        require!(current >= amount, "intents-stub: insufficient balance");
        self.balances
            .insert((owner.clone(), token.clone()), current - amount);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::mock::MockAction;
    use near_sdk::serde_json::{json, Value};
    use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
    use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    fn stub_id() -> AccountId {
        acc("intents-stub.near")
    }
    fn token() -> AccountId {
        acc("base-usdc.near")
    }
    fn vault() -> AccountId {
        acc("vault.near")
    }
    fn ctx(predecessor: AccountId, deposit: u128) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(stub_id())
            .predecessor_account_id(predecessor)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .build());
    }
    /// The vault holds 50 units of `token()` inside the stub.
    fn funded() -> IntentsStub {
        ctx(stub_id(), 0);
        let mut s = IntentsStub::new();
        ctx(token(), 0);
        let _ = s.ft_on_transfer(acc("owner.near"), U128(50), vault().to_string());
        s
    }
    fn balance(s: &IntentsStub, who: AccountId) -> U128 {
        s.mt_balance_of(who, format!("nep141:{}", token()))
    }

    #[test]
    fn a_deposit_credits_the_account_named_in_msg() {
        let s = funded();
        assert_eq!(balance(&s, vault()), U128(50));
        assert_eq!(balance(&s, acc("owner.near")), U128(0));
    }

    #[test]
    fn a_deposit_with_empty_msg_credits_the_sender() {
        let mut s = funded();
        ctx(token(), 0);
        let _ = s.ft_on_transfer(acc("owner.near"), U128(5), String::new());
        assert_eq!(balance(&s, acc("owner.near")), U128(5));
    }

    #[test]
    #[should_panic(expected = "intents-stub: msg must be empty or an account id")]
    fn a_deposit_with_a_bad_msg_is_refused() {
        let mut s = funded();
        ctx(token(), 0);
        let _ = s.ft_on_transfer(acc("owner.near"), U128(5), "Not An Account!".to_string());
    }

    #[test]
    fn withdraw_to_the_token_with_a_withdraw_to_memo_burns_and_returns_the_amount() {
        let mut s = funded();
        ctx(vault(), 1);
        match s.ft_withdraw(
            token(),
            token(),
            U128(20),
            Some("WITHDRAW_TO:0xabc".to_string()),
            None,
        ) {
            PromiseOrValue::Value(v) => assert_eq!(v, U128(20)),
            PromiseOrValue::Promise(_) => panic!("a burn must resolve to a value"),
        }
        assert_eq!(balance(&s, vault()), U128(30));
        assert_eq!(
            s.burns(0, 10),
            vec![BurnRecord {
                owner_id: vault(),
                token: token(),
                amount: U128(20),
                memo: "WITHDRAW_TO:0xabc".to_string()
            }]
        );
        let logs = get_logs();
        let mt_burn = logs
            .iter()
            .find(|l| l.contains("\"event\":\"mt_burn\""))
            .expect("an mt_burn log");
        assert_eq!(
            mt_burn.as_str(),
            r#"EVENT_JSON:{"standard":"nep245","version":"1.0.0","event":"mt_burn","data":[{"owner_id":"vault.near","token_ids":["nep141:base-usdc.near"],"amounts":["20"],"memo":"withdraw"}]}"#
        );
        let ft_burn = logs
            .iter()
            .find(|l| l.contains("\"event\":\"ft_burn\""))
            .expect("an ft_burn log");
        assert!(
            ft_burn.contains("\"owner_id\":\"intents-stub.near\""),
            "{ft_burn}"
        );
        assert!(
            ft_burn.contains("\"memo\":\"WITHDRAW_TO:0xabc\""),
            "{ft_burn}"
        );
        assert!(get_created_receipts().is_empty());
    }

    #[test]
    fn every_withdrawal_logs_an_mt_burn_for_the_owner() {
        let mut s = funded();
        ctx(vault(), 1);
        let _ = s.ft_withdraw(token(), acc("bob.near"), U128(5), None, None);
        let logs = get_logs();
        assert!(logs
            .iter()
            .any(|l| l.contains("\"event\":\"mt_burn\"")
                && l.contains("\"owner_id\":\"vault.near\"")));
        assert!(
            !logs.iter().any(|l| l.contains("\"event\":\"ft_burn\"")),
            "no POA burn without a WITHDRAW_TO memo"
        );
    }

    #[test]
    fn withdraw_to_another_receiver_calls_ft_transfer_with_one_yocto() {
        let mut s = funded();
        ctx(vault(), 1);
        let _ = s.ft_withdraw(token(), acc("bob.near"), U128(20), None, None);
        assert_eq!(balance(&s, vault()), U128(30));
        let call = get_created_receipts()
            .into_iter()
            .flat_map(|r| {
                let to = r.receiver_id.clone();
                r.actions.into_iter().map(move |a| (to.clone(), a))
            })
            .find_map(|(to, a)| match a {
                MockAction::FunctionCallWeight {
                    method_name,
                    args,
                    attached_deposit,
                    ..
                } if method_name == b"ft_transfer" => Some((to, args, attached_deposit)),
                _ => None,
            })
            .expect("an ft_transfer call");
        assert_eq!(call.0, token());
        assert_eq!(call.2, NearToken::from_yoctonear(1));
        let args: Value = near_sdk::serde_json::from_slice(&call.1).unwrap();
        assert_eq!(
            args,
            json!({"receiver_id": "bob.near", "amount": "20", "memo": null})
        );
    }

    #[test]
    fn a_failed_transfer_refunds_the_balance_and_resolves_to_zero() {
        let mut s = funded();
        ctx(vault(), 1);
        let _ = s.ft_withdraw(token(), acc("bob.near"), U128(20), None, None);
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(stub_id())
                .predecessor_account_id(stub_id())
                .build(),
            near_sdk::test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Failed]
        );
        assert_eq!(s.on_ft_withdraw(vault(), token(), U128(20)), U128(0));
        assert_eq!(balance(&s, vault()), U128(50));
    }

    #[test]
    #[should_panic(expected = "intents-stub: requires attached deposit of exactly 1 yoctoNEAR")]
    fn withdraw_needs_one_yocto() {
        let mut s = funded();
        ctx(vault(), 0);
        let _ = s.ft_withdraw(
            token(),
            token(),
            U128(1),
            Some("WITHDRAW_TO:0xabc".to_string()),
            None,
        );
    }

    #[test]
    #[should_panic(expected = "intents-stub: insufficient balance")]
    fn withdraw_over_the_balance_is_refused() {
        let mut s = funded();
        ctx(vault(), 1);
        let _ = s.ft_withdraw(
            token(),
            token(),
            U128(51),
            Some("WITHDRAW_TO:0xabc".to_string()),
            None,
        );
    }

    #[test]
    #[should_panic(expected = "intents-stub: auth by predecessor is disabled")]
    fn disabled_predecessor_auth_blocks_withdraw() {
        let mut s = funded();
        ctx(vault(), 1);
        s.disable_auth_by_predecessor_id();
        assert!(!s.is_auth_by_predecessor_id_enabled(vault()));
        let _ = s.ft_withdraw(
            token(),
            token(),
            U128(1),
            Some("WITHDRAW_TO:0xabc".to_string()),
            None,
        );
    }

    #[test]
    fn public_keys_are_empty_until_added_and_auth_is_on_by_default() {
        let mut s = funded();
        assert!(s.public_keys_of(vault()).is_empty());
        assert!(s.is_auth_by_predecessor_id_enabled(vault()));
        ctx(acc("someone.near"), 1);
        let key = PublicKey::from_parts(near_sdk::CurveType::ED25519, vec![7; 32]).unwrap();
        s.add_public_key(key.clone());
        assert_eq!(s.public_keys_of(acc("someone.near")), vec![key.to_string()]);
        assert!(s.public_keys_of(vault()).is_empty());
    }

    #[test]
    #[should_panic(expected = "intents-stub: token_id must be nep141:<account>")]
    fn mt_balance_of_needs_the_nep141_prefix() {
        let s = funded();
        s.mt_balance_of(vault(), token().to_string());
    }
}
