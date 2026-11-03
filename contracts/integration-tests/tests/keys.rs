//! Sandbox tests of the access keys the vault adds to itself: a key action that fails in its own
//! receipt must never leave the vault unable to replace that key.
//! Build the wasm first: `bash scripts/build-contracts.sh`.
use anyhow::Result;
use integration_tests::*;
use near_workspaces::types::{
    AccessKey, AccessKeyPermission, KeyType, NearToken, PublicKey, SecretKey,
};
use near_workspaces::{Account, AccountDetailsPatch};
use serde_json::{json, Value};

/// NEAR's storage price: 10^19 yoctoNEAR per byte (1 NEAR per 100 kB).
const YOCTO_PER_BYTE: u128 = 10_000_000_000_000_000_000;

fn ledger_key_args(pk: &PublicKey, allowance: NearToken) -> Value {
    json!({"public_key": pk.to_string(), "allowance": allowance.as_yoctonear().to_string()})
}

async fn ledger_key(env: &Env) -> Result<Value> {
    Ok(view(&env.vault, "get_config", json!({})).await?["ledger_key"].clone())
}

/// Deletes the vault's access key `pk` behind the contract's back, leaving the registry as it was.
/// A sandbox state patch gives the locked vault a temporary full-access key, which deletes `pk` and
/// then itself, so the vault is locked again afterwards.
async fn delete_vault_access_key(env: &Env, pk: &PublicKey) -> Result<()> {
    let temp = SecretKey::from_random(KeyType::ED25519);
    let temp_pk = temp.public_key();
    env.worker
        .patch(env.vault.id())
        .access_key(temp_pk.clone(), AccessKey::full_access())
        .transact()
        .await?;
    let vault = Account::from_secret_key(env.vault.id().clone(), temp, &env.worker);
    vault
        .batch(env.vault.id())
        .delete_key(pk.clone())
        .delete_key(temp_pk)
        .transact()
        .await?
        .into_result()?;
    assert!(
        env.vault.view_access_key(pk).await.is_err(),
        "the key is still on the vault"
    );
    Ok(())
}

/// `pk` is an access key of the vault that may call only `anchor` on it, with `allowance` left.
async fn assert_anchor_key(env: &Env, pk: &PublicKey, allowance: NearToken) -> Result<()> {
    let key = env.vault.view_access_key(pk).await?;
    match key.permission {
        AccessKeyPermission::FunctionCall(p) => {
            assert_eq!(p.receiver_id, env.vault.id().to_string());
            assert_eq!(p.method_names, vec!["anchor".to_string()]);
            assert_eq!(p.allowance, Some(allowance));
        }
        AccessKeyPermission::FullAccess => panic!("the ledger key must not be a full-access key"),
    }
    Ok(())
}

/// `set_ledger_key(pk)` succeeded and its only failed receipt is the DeleteKey of a previous
/// ledger key that no longer exists; then `pk` is the ledger key, holds its access key and anchors.
async fn assert_replaced(env: &Env, sk: SecretKey, allowance: NearToken) -> Result<()> {
    let pk = sk.public_key();
    let outcome = ok(
        &env.owner,
        env.vault.id(),
        "set_ledger_key",
        ledger_key_args(&pk, allowance),
        ONE_YOCTO,
    )
    .await?;
    let failures = outcome.failures();
    let text = format!("{failures:?}");
    assert_eq!(failures.len(), 1, "{text}");
    assert!(text.contains("DeleteKeyDoesNotExist"), "{text}");

    assert_anchor_key(env, &pk, allowance).await?;
    assert_eq!(ledger_key(env).await?, json!(pk.to_string()));
    let ledger = Account::from_secret_key(env.vault.id().clone(), sk, &env.worker);
    let anchored = call(
        &ledger,
        env.vault.id(),
        "anchor",
        json!({"seq": 1, "root": hex(1), "count": 1}),
        NO_DEPOSIT,
    )
    .await?;
    assert!(anchored.is_success(), "{anchored:?}");

    // Locked as before: the agent key and the new ledger key, no full-access key.
    let keys = env.vault.view_access_keys().await?;
    assert_eq!(keys.len(), 2, "{keys:?}");
    for k in &keys {
        assert!(
            matches!(
                k.access_key.permission,
                AccessKeyPermission::FunctionCall(_)
            ),
            "{keys:?}"
        );
    }
    Ok(())
}

#[tokio::test]
async fn a_ledger_key_left_without_its_access_key_can_be_replaced() -> Result<()> {
    let env = setup().await?;
    let a = SecretKey::from_random(KeyType::ED25519);
    let _ = ok(
        &env.owner,
        env.vault.id(),
        "set_ledger_key",
        ledger_key_args(&a.public_key(), NearToken::from_near(1)),
        ONE_YOCTO,
    )
    .await?;
    assert_anchor_key(&env, &a.public_key(), NearToken::from_near(1)).await?;
    // The stuck state: ledger_key = A, but the vault has no access key A.
    delete_vault_access_key(&env, &a.public_key()).await?;
    assert_eq!(ledger_key(&env).await?, json!(a.public_key().to_string()));

    // DeleteKey(A) fails in its own receipt and cannot undo AddKey(B).
    let b = SecretKey::from_random(KeyType::ED25519);
    assert_replaced(&env, b, NearToken::from_near(2)).await
}

#[tokio::test]
async fn a_ledger_key_whose_add_key_ran_out_of_balance_is_replaced_after_a_top_up() -> Result<()> {
    let env = setup().await?;
    // Leave the vault 77 bytes of free balance, as when agent gas has used up its free NEAR. That
    // covers set_ledger_key's own state (Some(ledger_key) grows the contract state by 37 bytes) but
    // not the anchor key (33 bytes of key, about 60 of AccessKey and 40 of record overhead).
    let before = env.vault.view_account().await?;
    let tight = NearToken::from_yoctonear(u128::from(before.storage_usage + 77) * YOCTO_PER_BYTE);
    env.worker
        .patch(env.vault.id())
        .account_from_current(move |current| AccountDetailsPatch::from(current).balance(tight))
        .transact()
        .await?;
    assert_eq!(env.vault.view_account().await?.balance, tight);

    let a = SecretKey::from_random(KeyType::ED25519);
    let first = ok(
        &env.owner,
        env.vault.id(),
        "set_ledger_key",
        ledger_key_args(&a.public_key(), NearToken::from_near(1)),
        ONE_YOCTO,
    )
    .await?;
    let text = format!("{:?}", first.failures());
    assert!(
        text.contains("LackBalanceForState"),
        "AddKey(A) was expected to fail for lack of balance (storage_usage {} before, balance {tight}): {text}",
        before.storage_usage
    );
    // The stuck state, reached the real way: the call committed ledger_key = A, its AddKey failed.
    assert_eq!(ledger_key(&env).await?, json!(a.public_key().to_string()));
    assert!(env.vault.view_access_key(&a.public_key()).await.is_err());

    env.owner
        .transfer_near(env.vault.id(), NearToken::from_near(1))
        .await?
        .into_result()?;
    let b = SecretKey::from_random(KeyType::ED25519);
    assert_replaced(&env, b, NearToken::from_near(1)).await
}

#[tokio::test]
async fn an_agent_whose_access_key_is_missing_can_be_removed_and_added_again() -> Result<()> {
    let env = setup().await?;
    delete_vault_access_key(&env, &env.agent.secret_key().public_key()).await?;
    let agents = view(&env.vault, "list_agents", json!({})).await?;
    assert_eq!(agents.as_array().map(Vec::len), Some(1));

    // The registry change commits with the call; only the detached DeleteKey fails.
    let removed = ok(
        &env.owner,
        env.vault.id(),
        "remove_agent",
        json!({"public_key": env.agent_pk()}),
        ONE_YOCTO,
    )
    .await?;
    let text = format!("{:?}", removed.failures());
    assert_eq!(removed.failures().len(), 1, "{text}");
    assert!(text.contains("DeleteKeyDoesNotExist"), "{text}");
    assert_eq!(view(&env.vault, "list_agents", json!({})).await?, json!([]));

    let add = json!({
        "public_key": env.agent_pk(),
        "allowance": NearToken::from_near(1).as_yoctonear().to_string(),
        "label": "re-added",
    });
    let added = ok(&env.owner, env.vault.id(), "add_agent", add, ONE_YOCTO).await?;
    assert!(added.failures().is_empty(), "{:?}", added.failures());
    let id = env.create_mandate(env.near_payee(), 100 * USDC).await?;
    let paid = env.spend(id, USDC, 1).await?;
    assert!(paid.is_success(), "{paid:?}");
    assert_eq!(ft_balance(&env.usdc, env.payee.id()).await?, USDC);
    Ok(())
}
