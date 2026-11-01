use super::*;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{json, Value};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::testing_env;
use near_sdk::{PromiseResult, RuntimeFeesConfig};

pub(crate) const T0: u64 = 1_800_000_000_000_000_000;
pub(crate) const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
pub(crate) const WASM: &[u8] = b"\0asm fake vault code for unit tests";

pub(crate) fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
pub(crate) fn factory_id() -> AccountId {
    acc("vaults.near")
}
pub(crate) fn owner() -> AccountId {
    acc("owner.near")
}
pub(crate) fn user() -> AccountId {
    acc("alice.near")
}

/// Context with `deposit` yoctoNEAR attached.
pub(crate) fn builder(predecessor: AccountId, deposit: u128) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(factory_id())
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor)
        .attached_deposit(near_sdk::NearToken::from_yoctonear(deposit))
        .block_timestamp(T0)
        .account_balance(near_sdk::NearToken::from_near(100));
    b
}
pub(crate) fn ctx(predecessor: AccountId, deposit: u128) {
    testing_env!(builder(predecessor, deposit).build());
}
/// A new factory. Afterwards the context is the factory owner's full-access key, with 1 yoctoNEAR
/// attached as the one-yocto rule requires.
pub(crate) fn new_factory() -> Factory {
    ctx(owner(), 0);
    let f = Factory::new(
        owner(),
        acc("usdc.near"),
        acc("intents.near"),
        vec![acc("base-usdc.near")],
        U128(ONE_NEAR),
    );
    ctx(owner(), 1);
    f
}
/// A factory with one version of `WASM` in `mode`; returns it and the base58 hash.
pub(crate) fn with_version(mode: &str) -> (Factory, String) {
    let mut f = new_factory();
    let hash = f.internal_store_code(WASM);
    f.add_version(hash.clone(), mode.to_string(), "test".to_string());
    (f, hash)
}
pub(crate) fn last_event() -> Value {
    let line = get_logs()
        .into_iter()
        .rev()
        .find(|l| l.starts_with("EVENT_JSON:"))
        .expect("an event");
    near_sdk::serde_json::from_str(line.trim_start_matches("EVENT_JSON:")).unwrap()
}

#[test]
fn new_reports_its_config_with_no_version() {
    let f = new_factory();
    assert_eq!(
        f.get_config(),
        FactoryConfig {
            owner: owner(),
            usdc: acc("usdc.near"),
            intents: acc("intents.near"),
            allowed_assets: vec![acc("base-usdc.near")],
            min_deposit: U128(ONE_NEAR),
            current_version: None,
        }
    );
    assert!(f.versions().is_empty());
}

#[test]
fn store_code_keeps_the_wasm_under_its_sha256_and_returns_base58() {
    let mut f = new_factory();
    let hash = f.internal_store_code(WASM);
    let digest = env::sha256_array(WASM);
    assert_eq!(hash, Base58CryptoHash::from(digest).to_string());
    assert_eq!(env::storage_read(&code_key(&digest)), Some(WASM.to_vec()));
}

#[test]
#[should_panic(expected = "PROBARION:NotOwner")]
fn only_the_factory_owner_stores_code() {
    let mut f = new_factory();
    ctx(user(), 0);
    f.store_code();
}

#[test]
#[should_panic(expected = "PROBARION:InvalidInput")]
fn empty_code_is_refused() {
    let mut f = new_factory();
    f.internal_store_code(&[]);
}

#[test]
fn add_version_registers_an_embedded_version_and_emits() {
    let (f, hash) = with_version("embedded");
    assert_eq!(
        f.versions(),
        vec![VersionView {
            index: 1,
            code_hash: hash.clone(),
            mode: "embedded".to_string(),
            notes: "test".to_string(),
            at_ns: U64(T0)
        }]
    );
    assert_eq!(f.get_config().current_version, Some(1));
    assert_eq!(
        last_event(),
        json!({"standard": "probarion_factory", "version": "1.0.0", "event": "version_added",
               "data": {"index": 1, "code_hash": hash, "mode": "embedded"}})
    );
}

#[test]
fn a_global_version_needs_no_stored_code_and_becomes_current() {
    let (mut f, _) = with_version("embedded");
    let global = Base58CryptoHash::from([7u8; 32]).to_string();
    assert_eq!(
        f.add_version(
            global.clone(),
            "global".to_string(),
            "frozen Day 10".to_string()
        ),
        2
    );
    assert_eq!(f.get_config().current_version, Some(2));
    assert_eq!(f.versions()[1].mode, "global");
    assert_eq!(f.versions()[1].code_hash, global);
}

#[test]
#[should_panic(expected = "PROBARION:InvalidInput")]
fn an_embedded_version_needs_stored_code() {
    let mut f = new_factory();
    f.add_version(
        Base58CryptoHash::from([7u8; 32]).to_string(),
        "embedded".to_string(),
        String::new(),
    );
}

#[test]
#[should_panic(expected = "PROBARION:InvalidInput")]
fn an_unknown_mode_is_refused() {
    let mut f = new_factory();
    let hash = f.internal_store_code(WASM);
    f.add_version(hash, "wasm".to_string(), String::new());
}

#[test]
#[should_panic(expected = "PROBARION:InvalidInput")]
fn a_malformed_code_hash_is_refused() {
    let mut f = new_factory();
    f.add_version(
        "not-base58-0OIl".to_string(),
        "global".to_string(),
        String::new(),
    );
}

#[test]
#[should_panic(expected = "PROBARION:InvalidInput")]
fn notes_over_256_bytes_are_refused() {
    let mut f = new_factory();
    f.add_version(
        Base58CryptoHash::from([7u8; 32]).to_string(),
        "global".to_string(),
        "x".repeat(257),
    );
}

#[test]
#[should_panic(expected = "PROBARION:NotOwner")]
fn only_the_factory_owner_adds_versions() {
    let mut f = new_factory();
    ctx(user(), 0);
    f.add_version(
        Base58CryptoHash::from([7u8; 32]).to_string(),
        "global".to_string(),
        String::new(),
    );
}

#[test]
#[should_panic(expected = "PROBARION:RequiresOneYocto")]
fn add_version_without_a_deposit_is_refused() {
    let mut f = new_factory();
    ctx(owner(), 0);
    f.add_version(
        Base58CryptoHash::from([7u8; 32]).to_string(),
        "global".to_string(),
        String::new(),
    );
}

#[test]
#[should_panic(expected = "PROBARION:RequiresOneYocto")]
fn add_version_with_two_yocto_is_refused() {
    let mut f = new_factory();
    ctx(owner(), 2);
    f.add_version(
        Base58CryptoHash::from([7u8; 32]).to_string(),
        "global".to_string(),
        String::new(),
    );
}

#[test]
#[should_panic(expected = "PROBARION:RequiresOneYocto")]
fn store_code_without_a_deposit_is_refused() {
    let mut f = new_factory();
    ctx(owner(), 0);
    f.store_code();
}

#[test]
#[should_panic(expected = "PROBARION:RequiresOneYocto")]
fn store_code_with_two_yocto_is_refused() {
    let mut f = new_factory();
    ctx(owner(), 2);
    f.store_code();
}

#[test]
fn store_code_keeps_the_call_input_under_its_sha256_and_returns_base58() {
    let mut f = new_factory();
    let mut b = builder(owner(), 1);
    b.context.input = WASM.into();
    testing_env!(b.build());
    let digest = env::sha256_array(WASM);
    assert_eq!(f.store_code(), Base58CryptoHash::from(digest).to_string());
    assert_eq!(env::storage_read(&code_key(&digest)), Some(WASM.to_vec()));
}

#[test]
#[should_panic(expected = "PROBARION:InvalidInput")]
fn store_code_with_no_input_is_refused() {
    let mut f = new_factory();
    ctx(owner(), 1);
    f.store_code();
}

#[test]
#[should_panic(expected = "PROBARION:InvalidInput")]
fn a_31_byte_code_hash_is_refused() {
    let mut f = new_factory();
    f.add_version(
        near_sdk::bs58::encode([7u8; 31]).into_string(),
        "global".to_string(),
        String::new(),
    );
}

#[test]
#[should_panic(expected = "PROBARION:InvalidInput")]
fn a_33_byte_code_hash_is_refused() {
    let mut f = new_factory();
    f.add_version(
        near_sdk::bs58::encode([7u8; 33]).into_string(),
        "global".to_string(),
        String::new(),
    );
}

fn actions_to(receiver: &str) -> Vec<MockAction> {
    get_created_receipts()
        .into_iter()
        .filter(|r| r.receiver_id.as_str() == receiver)
        .flat_map(|r| r.actions)
        .collect()
}

fn create(f: &mut Factory, name: &str, deposit: u128) {
    ctx(user(), deposit);
    let _ = f.create_vault(
        name.to_string(),
        vec![acc("bob.near")],
        U128(500_000_000),
        U64(3_600_000_000_000),
    );
}

/// The context of `on_vault_created`: the factory calling itself, with the batch's `result`.
fn callback_ctx(result: PromiseResult) {
    testing_env!(
        builder(factory_id(), 0).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

fn expected_init() -> Value {
    json!({"owner": "alice.near", "approvers": ["bob.near"], "usdc": "usdc.near", "intents": "intents.near",
           "allowed_assets": ["base-usdc.near"], "daily_backstop": "500000000", "held_ttl_ns": "3600000000000"})
}

fn assert_init_call(action: &MockAction) {
    match action {
        MockAction::FunctionCallWeight {
            method_name,
            args,
            attached_deposit,
            ..
        } => {
            assert_eq!(method_name, b"new");
            assert_eq!(
                near_sdk::serde_json::from_slice::<Value>(args).unwrap(),
                expected_init()
            );
            assert_eq!(attached_deposit.as_yoctonear(), 0);
        }
        other => panic!("expected the new() call, got {other:?}"),
    }
}

fn assert_no_keys(actions: &[MockAction]) {
    assert!(
        actions.iter().all(|a| !matches!(
            a,
            MockAction::AddKeyWithFunctionCall { .. } | MockAction::AddKeyWithFullAccess { .. }
        )),
        "I9: the factory must never add a key to a vault"
    );
}

fn assert_callback_scheduled() {
    assert!(actions_to("vaults.near").iter().any(|a| matches!(
        a,
        MockAction::FunctionCallWeight { method_name, .. } if method_name == b"on_vault_created"
    )));
}

#[test]
fn global_mode_creates_funds_uses_the_global_code_and_inits_with_no_keys() {
    let (mut f, _) = with_version("global");
    create(&mut f, "acme", ONE_NEAR);
    let actions = actions_to("acme.vaults.near");
    assert_eq!(actions.len(), 4);
    assert!(matches!(actions[0], MockAction::CreateAccount { .. }));
    assert!(
        matches!(&actions[1], MockAction::Transfer { deposit, .. } if deposit.as_yoctonear() == ONE_NEAR)
    );
    assert!(matches!(actions[2], MockAction::UseGlobalContract { .. }));
    assert_init_call(&actions[3]);
    assert_no_keys(&actions);
    assert_callback_scheduled();
}

#[test]
fn embedded_mode_deploys_the_stored_wasm_and_inits_with_no_keys() {
    let (mut f, _) = with_version("embedded");
    create(&mut f, "acme", 2 * ONE_NEAR);
    let actions = actions_to("acme.vaults.near");
    assert_eq!(actions.len(), 4);
    assert!(matches!(actions[0], MockAction::CreateAccount { .. }));
    assert!(
        matches!(&actions[2], MockAction::DeployContract { code, .. } if code.as_slice() == WASM)
    );
    assert_init_call(&actions[3]);
    assert_no_keys(&actions);
    assert_callback_scheduled();
}

#[test]
#[should_panic(expected = "PROBARION:InsufficientDeposit")]
fn global_mode_needs_the_min_deposit() {
    let (mut f, _) = with_version("global");
    create(&mut f, "acme", ONE_NEAR - 1);
}

#[test]
#[should_panic(expected = "PROBARION:InsufficientDeposit")]
fn embedded_mode_also_needs_storage_for_the_code() {
    let (mut f, _) = with_version("embedded");
    create(&mut f, "acme", ONE_NEAR);
}

#[test]
#[should_panic(expected = "PROBARION:InvalidInput")]
fn no_vault_before_a_version_exists() {
    let mut f = new_factory();
    create(&mut f, "acme", 2 * ONE_NEAR);
}

macro_rules! bad_name {
    ($($test:ident: $name:expr,)*) => {$(
        #[test]
        #[should_panic(expected = "PROBARION:InvalidInput")]
        fn $test() {
            let (mut f, _) = with_version("global");
            create(&mut f, $name, 2 * ONE_NEAR);
        }
    )*};
}

bad_name! {
    rejects_a_one_character_name: "a",
    rejects_a_leading_dash: "-acme",
    rejects_uppercase: "Acme",
    rejects_a_dot: "ac.me",
    rejects_32_characters: &"a".repeat(32),
    rejects_a_trailing_dash_that_is_not_a_valid_account: "acme-",
}

#[test]
fn a_successful_creation_is_recorded_and_emitted() {
    let (mut f, _) = with_version("global");
    callback_ctx(PromiseResult::Successful(vec![]));
    let created = f.on_vault_created("acme".to_string(), user(), U128(ONE_NEAR), 1);
    assert_eq!(created, Some(acc("acme.vaults.near")));
    assert_eq!(f.vault_version(acc("acme.vaults.near")), Some(1));
    assert_eq!(
        f.list_vaults(0, 10),
        vec![VaultRecord {
            account_id: acc("acme.vaults.near"),
            owner: user(),
            version: 1,
            created_at_ns: U64(T0)
        }]
    );
    assert_eq!(
        last_event(),
        json!({"standard": "probarion_factory", "version": "1.0.0", "event": "vault_created",
               "data": {"account_id": "acme.vaults.near", "owner": "alice.near", "version": 1}})
    );
}

#[test]
fn a_failed_creation_refunds_the_deposit_and_records_nothing() {
    let (mut f, _) = with_version("global");
    callback_ctx(PromiseResult::Failed);
    assert_eq!(
        f.on_vault_created("acme".to_string(), user(), U128(ONE_NEAR), 1),
        None
    );
    let refund = actions_to("alice.near");
    assert!(
        matches!(&refund[..], [MockAction::Transfer { deposit, .. }] if deposit.as_yoctonear() == ONE_NEAR)
    );
    assert!(f.list_vaults(0, 10).is_empty());
    assert_eq!(f.vault_version(acc("acme.vaults.near")), None);
}

#[test]
fn list_vaults_pages_through_the_created_vaults() {
    let (mut f, _) = with_version("global");
    for name in ["acme", "beta", "gamma"] {
        callback_ctx(PromiseResult::Successful(vec![]));
        assert!(f
            .on_vault_created(name.to_string(), user(), U128(ONE_NEAR), 1)
            .is_some());
    }
    let ids = |records: Vec<VaultRecord>| -> Vec<AccountId> {
        records.into_iter().map(|r| r.account_id).collect()
    };
    assert_eq!(
        ids(f.list_vaults(0, 2)),
        vec![acc("acme.vaults.near"), acc("beta.vaults.near")]
    );
    assert_eq!(ids(f.list_vaults(2, 10)), vec![acc("gamma.vaults.near")]);
    assert_eq!(f.list_vaults(5, 10).len(), 0);
    // The limit is capped at MAX_PAGE (100); with 3 records the oversized limit returns all 3.
    assert_eq!(f.list_vaults(0, 1000).len(), 3);
}
