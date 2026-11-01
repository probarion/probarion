#![allow(dead_code)]
//! Shared unit-test helpers for the vault crate. Later tasks append helpers here.
use crate::*;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::Value;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, CurveType, MockedBlockchain, PromiseResult, RuntimeFeesConfig};
use std::collections::HashMap;

pub const T0: u64 = 1_800_000_000_000_000_000; // 2027-01-15, any fixed instant works
pub const HOUR_NS: u64 = 3_600_000_000_000;
pub const USDC: u128 = 1_000_000;
pub const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
pub const EVM_ADDR: &str = "0x1111111111111111111111111111111111111111";
pub const EVM_MIXED: &str = "0xAbCdEf0123456789abcdef0123456789ABCDEF01";
pub const SOL_ADDR: &str = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";

pub fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
pub fn vault_id() -> AccountId {
    acc("vault.near")
}
pub fn owner() -> AccountId {
    acc("owner.near")
}
pub fn approver() -> AccountId {
    acc("approver.near")
}
pub fn usdc() -> AccountId {
    acc("usdc.near")
}
pub fn intents() -> AccountId {
    acc("intents.near")
}
pub fn payee() -> AccountId {
    acc("payee.near")
}
pub fn base_asset() -> AccountId {
    acc("base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near")
}
pub fn sol_asset() -> AccountId {
    acc("sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near")
}
pub fn pk(n: u8) -> PublicKey {
    PublicKey::from_parts(CurveType::ED25519, vec![n; 32]).unwrap()
}
pub fn agent_pk() -> PublicKey {
    pk(1)
}
pub fn ledger_pk() -> PublicKey {
    pk(9)
}
pub fn hex(n: u8) -> String {
    format!("{n:02x}").repeat(32)
}
pub fn yocto(n: u128) -> NearToken {
    NearToken::from_yoctonear(n)
}

fn builder(
    predecessor: AccountId,
    signer_pk: PublicKey,
    deposit: NearToken,
    now: u64,
) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(vault_id())
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor)
        .signer_account_pk(signer_pk)
        .attached_deposit(deposit)
        .block_timestamp(now)
        .account_balance(NearToken::from_near(100));
    b
}

/// New mocked context; contract storage carries over from the previous one.
pub fn set_ctx(predecessor: AccountId, signer_pk: PublicKey, deposit: NearToken, now: u64) {
    testing_env!(builder(predecessor, signer_pk, deposit, now).build());
}

/// Context for a callback: predecessor is the vault and promise result 0 is `result`.
pub fn set_ctx_with_result(now: u64, result: PromiseResult) {
    testing_env!(
        builder(vault_id(), pk(200), yocto(0), now).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

/// Empty storage. Use before building a second vault inside one test.
pub fn fresh_env() {
    let ctx = builder(owner(), pk(200), yocto(0), T0).build();
    near_sdk::env::set_blockchain_interface(MockedBlockchain::new(
        ctx,
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        vec![],
        HashMap::new(),
        HashMap::new(),
        None,
    ));
}

pub fn as_owner(deposit: NearToken) {
    set_ctx(owner(), pk(200), deposit, T0);
}
/// A call from `who`'s full-access key: 1 yoctoNEAR attached, as the one-yocto rule requires.
pub fn as_account(who: AccountId, now: u64) {
    set_ctx(who, pk(200), ONE_YOCTO, now);
}
/// A call from an unrelated account with no deposit (for `expire_held`, which anyone may call).
pub fn as_anyone(now: u64) {
    set_ctx(acc("anyone.near"), pk(200), yocto(0), now);
}
/// A transaction the vault signs with `signer_pk` (predecessor == current account).
pub fn as_agent(signer_pk: PublicKey, now: u64) {
    set_ctx(vault_id(), signer_pk, yocto(0), now);
}

pub fn setup() -> Vault {
    fresh_env();
    Vault::new(
        owner(),
        vec![approver()],
        usdc(),
        intents(),
        vec![base_asset(), sol_asset()],
        U128(500 * USDC),
        U64(72 * HOUR_NS),
    )
}

pub fn events() -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| near_sdk::serde_json::from_str(j).unwrap())
        .collect()
}
pub fn last_event() -> Value {
    events().pop().expect("an event was emitted")
}

pub struct Call {
    pub receiver: AccountId,
    pub method: String,
    pub args: Value,
    pub deposit: NearToken,
    pub gas: Gas,
}

/// Every FunctionCall the contract scheduled since the last context switch.
pub fn calls() -> Vec<Call> {
    let mut out = Vec::new();
    for r in get_created_receipts() {
        for a in r.actions {
            if let MockAction::FunctionCallWeight {
                method_name,
                args,
                attached_deposit,
                prepaid_gas,
                ..
            } = a
            {
                out.push(Call {
                    receiver: r.receiver_id.clone(),
                    method: String::from_utf8(method_name).unwrap(),
                    args: near_sdk::serde_json::from_slice(&args).unwrap_or(Value::Null),
                    deposit: attached_deposit,
                    gas: prepaid_gas,
                });
            }
        }
    }
    out
}
pub fn call_to(method: &str) -> Call {
    calls()
        .into_iter()
        .find(|c| c.method == method)
        .unwrap_or_else(|| panic!("no {method} call was scheduled"))
}
/// The one-yocto rule: `call`, made by `who` at `now` on a vault built by `make`, must panic with
/// `PROBARION:RequiresOneYocto` both with 0 and with 2 yoctoNEAR attached.
pub fn assert_requires_one_yocto(
    who: AccountId,
    now: u64,
    make: impl Fn() -> Vault,
    call: impl Fn(&mut Vault),
) {
    for deposit in [0, 2] {
        let mut v = make();
        set_ctx(who.clone(), pk(200), yocto(deposit), now);
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| call(&mut v)));
        let payload = outcome.expect_err("a deposit other than 1 yoctoNEAR must be refused");
        let text = payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default();
        assert!(
            text.contains("PROBARION:RequiresOneYocto"),
            "{deposit} yocto: got {text:?}"
        );
    }
}

/// Every action of every scheduled receipt, with its receiver.
pub fn actions() -> Vec<(AccountId, MockAction)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let to = r.receiver_id.clone();
            r.actions.into_iter().map(move |a| (to.clone(), a))
        })
        .collect()
}

pub fn near_input() -> MandateInput {
    MandateInput {
        payee: Payee::Near {
            account_id: payee(),
        },
        purpose_hash: hex(0xaa),
        max_per_payment: U128(100 * USDC),
        max_total: U128(1_000 * USDC),
        max_uses: 10,
        expires_at_ns: U64(T0 + 30 * DAY_NS),
        approval_above: U128(100 * USDC),
        agent_pk: agent_pk(),
        label: "acme hosting".to_string(),
    }
}
pub fn base_input() -> MandateInput {
    MandateInput {
        payee: Payee::Intents {
            chain: Chain::Base,
            address: EVM_ADDR.to_string(),
            asset: base_asset(),
        },
        label: "base contractor".to_string(),
        ..near_input()
    }
}
pub fn sol_input() -> MandateInput {
    MandateInput {
        payee: Payee::Intents {
            chain: Chain::Solana,
            address: SOL_ADDR.to_string(),
            asset: sol_asset(),
        },
        label: "solana contractor".to_string(),
        ..near_input()
    }
}
/// Owner creates `input` with 1 NEAR attached; returns the mandate id.
pub fn create(v: &mut Vault, input: MandateInput) -> u64 {
    as_owner(NearToken::from_near(1));
    v.create_mandate(input)
}
