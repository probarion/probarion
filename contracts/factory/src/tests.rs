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

/// `create_vault` on a global-mode factory ("acme", 2 NEAR attached) with the given vault init
/// bounds.
fn create_bounded(
    f: &mut Factory,
    approvers: Vec<AccountId>,
    daily_backstop: u128,
    held_ttl_ns: u64,
) {
    ctx(user(), 2 * ONE_NEAR);
    let _ = f.create_vault(
        "acme".to_string(),
        approvers,
        U128(daily_backstop),
        U64(held_ttl_ns),
    );
}

fn approvers(n: usize) -> Vec<AccountId> {
    (0..n).map(|i| acc(&format!("approver{i}.near"))).collect()
}

/// The vault's `MAX_HELD_TTL_NS` spelled out, so that the factory's mirror of it is pinned.
const THIRTY_DAYS_NS: u64 = 30 * 86_400 * 1_000_000_000;

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

/// Access keys and gas keys are both keys: a vault must start with none of either.
fn assert_no_keys(actions: &[MockAction]) {
    assert!(
        actions.iter().all(|a| !matches!(
            a,
            MockAction::AddKeyWithFunctionCall { .. }
                | MockAction::AddKeyWithFullAccess { .. }
                | MockAction::AddGasKeyWithFunctionCall { .. }
                | MockAction::AddGasKeyWithFullAccess { .. }
        )),
        "I9: the factory must never add a key to a vault"
    );
}

/// The args of the one `on_vault_created` call the factory schedules on itself.
fn callback_args() -> Value {
    let mut calls = actions_to("vaults.near")
        .into_iter()
        .filter_map(|a| match a {
            MockAction::FunctionCallWeight {
                method_name, args, ..
            } if method_name == b"on_vault_created" => Some(args),
            _ => None,
        });
    let args = calls.next().expect("on_vault_created is scheduled");
    assert!(calls.next().is_none(), "on_vault_created is scheduled once");
    near_sdk::serde_json::from_slice(&args).unwrap()
}

fn assert_callback_scheduled(deposit: u128) {
    assert_eq!(
        callback_args(),
        json!({"name": "acme", "owner": "alice.near", "deposit": deposit.to_string(), "version": 1})
    );
}

fn assert_uses_global_code(action: &MockAction, base58_hash: &str) {
    match action {
        MockAction::UseGlobalContract { contract_id, .. } => assert_eq!(
            near_sdk::serde_json::to_value(contract_id).unwrap(),
            json!({ "hash": base58_hash })
        ),
        other => panic!("expected UseGlobalContract, got {other:?}"),
    }
}

fn assert_transfer(action: &MockAction, yocto: u128) {
    match action {
        MockAction::Transfer { deposit, .. } => assert_eq!(deposit.as_yoctonear(), yocto),
        other => panic!("expected Transfer, got {other:?}"),
    }
}

/// The least deposit an embedded `create_vault` accepts: `min_deposit` plus the code's storage.
fn embedded_deposit() -> u128 {
    ONE_NEAR + WASM.len() as u128 * env::storage_byte_cost().as_yoctonear()
}

#[test]
fn global_mode_creates_funds_uses_the_global_code_and_inits_with_no_keys() {
    let (mut f, hash) = with_version("global");
    create(&mut f, "acme", ONE_NEAR);
    let actions = actions_to("acme.vaults.near");
    assert_eq!(actions.len(), 4);
    assert!(matches!(actions[0], MockAction::CreateAccount { .. }));
    assert_transfer(&actions[1], ONE_NEAR);
    assert_uses_global_code(&actions[2], &hash);
    assert_init_call(&actions[3]);
    assert_no_keys(&actions);
    assert_callback_scheduled(ONE_NEAR);
}

#[test]
fn embedded_mode_deploys_the_stored_wasm_and_inits_with_no_keys() {
    let (mut f, _) = with_version("embedded");
    create(&mut f, "acme", 2 * ONE_NEAR);
    let actions = actions_to("acme.vaults.near");
    assert_eq!(actions.len(), 4);
    assert!(matches!(actions[0], MockAction::CreateAccount { .. }));
    assert_transfer(&actions[1], 2 * ONE_NEAR);
    assert!(
        matches!(&actions[2], MockAction::DeployContract { code, .. } if code.as_slice() == WASM)
    );
    assert_init_call(&actions[3]);
    assert_no_keys(&actions);
    assert_callback_scheduled(2 * ONE_NEAR);
}

#[test]
fn embedded_mode_accepts_exactly_min_deposit_plus_the_code_storage() {
    let (mut f, _) = with_version("embedded");
    let exact = embedded_deposit();
    create(&mut f, "acme", exact);
    let actions = actions_to("acme.vaults.near");
    assert_eq!(actions.len(), 4);
    assert_transfer(&actions[1], exact);
    assert_callback_scheduled(exact);
}

#[test]
#[should_panic(expected = "PROBARION:InsufficientDeposit")]
fn embedded_mode_refuses_one_yocto_below_min_deposit_plus_the_code_storage() {
    let (mut f, _) = with_version("embedded");
    create(&mut f, "acme", embedded_deposit() - 1);
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

// The vault's `new` refuses these inits, which would roll the batch back and leave the refund to
// the factory's own balance: `create_vault` has to refuse them first, before it creates anything.
macro_rules! bad_init {
    ($($test:ident: $approvers:expr, $backstop:expr, $ttl:expr,)*) => {$(
        #[test]
        #[should_panic(expected = "PROBARION:InvalidInput")]
        fn $test() {
            let (mut f, _) = with_version("global");
            create_bounded(&mut f, $approvers, $backstop, $ttl);
        }
    )*};
}

bad_init! {
    refuses_no_approvers: Vec::new(), 500_000_000, 3_600_000_000_000,
    refuses_11_approvers: approvers(11), 500_000_000, 3_600_000_000_000,
    refuses_a_zero_daily_backstop: approvers(1), 0, 3_600_000_000_000,
    refuses_a_zero_held_ttl: approvers(1), 500_000_000, 0,
    refuses_a_held_ttl_of_30_days_and_1_ns: approvers(1), 500_000_000, THIRTY_DAYS_NS + 1,
    refuses_a_huge_held_ttl: approvers(1), 500_000_000, u64::MAX,
}

#[test]
fn accepts_10_approvers_and_a_held_ttl_of_exactly_30_days() {
    let (mut f, _) = with_version("global");
    create_bounded(&mut f, approvers(10), 500_000_000, THIRTY_DAYS_NS);
    let actions = actions_to("acme.vaults.near");
    assert_eq!(actions.len(), 4, "the vault is created in full");
    assert_no_keys(&actions);
}

#[test]
fn accepts_the_smallest_valid_bounds() {
    let (mut f, _) = with_version("global");
    create_bounded(&mut f, approvers(1), 1, 1);
    assert_eq!(actions_to("acme.vaults.near").len(), 4);
}

#[test]
fn a_refused_init_creates_nothing() {
    let (mut f, _) = with_version("global");
    let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        create_bounded(&mut f, Vec::new(), 500_000_000, 3_600_000_000_000);
    }));
    assert!(refused.is_err(), "no approvers is refused");
    assert!(
        get_created_receipts().is_empty(),
        "no receipt, so no refund to owe"
    );
}

#[test]
fn a_successful_creation_is_recorded_and_emitted() {
    let (mut f, _) = with_version("global");
    callback_ctx(PromiseResult::Successful(vec![]));
    let created = f.on_vault_created("acme".to_string(), user(), U128(ONE_NEAR), 1);
    assert_eq!(created, Some(acc("acme.vaults.near")));
    assert!(get_created_receipts().is_empty(), "a success never refunds");
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
    assert_eq!(
        get_created_receipts().len(),
        1,
        "exactly one refund receipt"
    );
    let refund = actions_to("alice.near");
    assert!(
        matches!(&refund[..], [MockAction::Transfer { deposit, .. }] if deposit.as_yoctonear() == ONE_NEAR)
    );
    assert!(f.list_vaults(0, 10).is_empty());
    assert_eq!(f.vault_version(acc("acme.vaults.near")), None);
}

#[test]
fn a_failed_creation_refunds_even_if_the_name_would_not_parse() {
    let (mut f, _) = with_version("global");
    callback_ctx(PromiseResult::Failed);
    assert_eq!(
        f.on_vault_created("Not A Name".to_string(), user(), U128(ONE_NEAR), 1),
        None
    );
    assert_eq!(
        get_created_receipts().len(),
        1,
        "exactly one refund receipt"
    );
    let refund = actions_to("alice.near");
    assert!(
        matches!(&refund[..], [MockAction::Transfer { deposit, .. }] if deposit.as_yoctonear() == ONE_NEAR)
    );
}

fn assets(n: usize) -> Vec<AccountId> {
    (0..n).map(|i| acc(&format!("asset{i}.near"))).collect()
}

#[test]
fn new_accepts_ten_allowed_assets_like_the_vault() {
    ctx(owner(), 0);
    let f = Factory::new(
        owner(),
        acc("usdc.near"),
        acc("intents.near"),
        assets(10),
        U128(ONE_NEAR),
    );
    assert_eq!(f.get_config().allowed_assets.len(), 10);
}

#[test]
#[should_panic(expected = "PROBARION:InvalidInput")]
fn new_refuses_more_allowed_assets_than_the_vault_accepts() {
    ctx(owner(), 0);
    Factory::new(
        owner(),
        acc("usdc.near"),
        acc("intents.near"),
        assets(11),
        U128(ONE_NEAR),
    );
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

#[test]
fn publish_global_deploys_the_current_embedded_code_as_a_global_contract() {
    let (mut f, _) = with_version("embedded");
    let _ = f.publish_global();
    let actions = actions_to("vaults.near");
    match &actions[..] {
        [MockAction::DeployGlobalContract { code, mode, .. }] => {
            assert_eq!(code.as_slice(), WASM);
            // By code hash (NEP-591): immutable, and identified by the hash rather than by the
            // factory's account id (which would let the factory replace the code later).
            assert_eq!(
                near_sdk::serde_json::to_value(mode).unwrap(),
                json!("CodeHash")
            );
        }
        other => panic!("expected exactly one DeployGlobalContract, got {other:?}"),
    }
    assert_eq!(get_created_receipts().len(), 1, "no other receipt");
}

#[test]
#[should_panic(expected = "PROBARION:InvalidInput")]
fn publish_global_needs_an_embedded_current_version() {
    // The current version is the last one: an earlier embedded version does not count. The same
    // hash is registered as global, so its wasm is still stored and only the mode refuses.
    let (mut f, hash) = with_version("embedded");
    f.add_version(hash, "global".to_string(), String::new());
    let _ = f.publish_global();
}

#[test]
#[should_panic(expected = "PROBARION:InvalidInput")]
fn publish_global_needs_a_version() {
    let mut f = new_factory();
    let _ = f.publish_global();
}

#[test]
#[should_panic(expected = "PROBARION:NotOwner")]
fn only_the_factory_owner_publishes_global_code() {
    let (mut f, _) = with_version("embedded");
    // 0 yocto, like the other owner-only tests: the caller check must run before the yocto check.
    ctx(user(), 0);
    let _ = f.publish_global();
}

#[test]
#[should_panic(expected = "PROBARION:RequiresOneYocto")]
fn publish_global_requires_one_yocto() {
    let (mut f, _) = with_version("embedded");
    ctx(owner(), 0);
    let _ = f.publish_global();
}

#[test]
#[should_panic(expected = "PROBARION:RequiresOneYocto")]
fn publish_global_with_two_yocto_is_refused() {
    let (mut f, _) = with_version("embedded");
    ctx(owner(), 2);
    let _ = f.publish_global();
}
