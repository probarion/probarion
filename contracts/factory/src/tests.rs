use super::*;
use near_sdk::serde_json::{json, Value};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;

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
