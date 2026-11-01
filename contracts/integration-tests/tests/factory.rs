//! Sandbox proof for the factory (I9): a vault it creates has no access keys, runs the code the
//! factory holds and got the factory config. Embedded mode runs the wasm stored in the factory.
//! Global mode (the primary one) uses the code the factory publishes itself with `publish_global`,
//! because near-workspaces 0.23 has no client-side `DeployGlobalContract` action.
//! Build the wasm first: `bash scripts/build-contracts.sh`.
use anyhow::Result;
use integration_tests::*;
use near_workspaces::network::Sandbox;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract, ContractState, CryptoHash, Worker};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

/// A factory with one embedded version of the vault wasm. The worker stays in the struct: dropping
/// it stops the sandbox.
struct FactoryEnv {
    worker: Worker<Sandbox>,
    factory_owner: Account,
    user: Account,
    factory: Contract,
    /// The vault wasm the factory stored.
    code: Vec<u8>,
    /// Its base58 sha256, as `store_code` returned it.
    hash: String,
}

async fn factory_with_embedded_version() -> Result<FactoryEnv> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let factory_owner = subaccount(&root, "factory-owner", 20).await?;
    let user = subaccount(&root, "alice", 30).await?;
    // The factory also pays the global publish (about 24.9 NEAR for the 248,501-byte vault wasm).
    let factory = deploy(&root, "vaults", "probarion_factory", 100).await?;
    let init = json!({
        "owner": factory_owner.id(),
        "usdc": "usdc.test.near",
        "intents": "intents.test.near",
        "allowed_assets": ["base-usdc.test.near"],
        "min_deposit": NearToken::from_near(1).as_yoctonear().to_string(),
    });
    let _ = ok(factory.as_account(), factory.id(), "new", init, NO_DEPOSIT).await?;
    let code = wasm("probarion_vault")?;
    let stored = factory_owner
        .call(factory.id(), "store_code")
        .args(code.clone())
        .deposit(ONE_YOCTO)
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    assert!(stored.is_success(), "{stored:?}");
    let hash: String = stored.json()?;
    let version = json!({"code_hash": hash, "mode": "embedded", "notes": "sandbox"});
    let _ = ok(
        &factory_owner,
        factory.id(),
        "add_version",
        version,
        ONE_YOCTO,
    )
    .await?;
    Ok(FactoryEnv {
        worker,
        factory_owner,
        user,
        factory,
        code,
        hash,
    })
}

fn create_args(name: &str, approver: &AccountId) -> Value {
    json!({"name": name, "approvers": [approver], "daily_backstop": (500 * USDC).to_string(), "held_ttl_ns": "3600000000000"})
}

// probarion-claim: I9
#[tokio::test]
async fn a_factory_vault_has_no_keys_runs_the_stored_code_and_got_the_factory_config() -> Result<()>
{
    let env = factory_with_embedded_version().await?;
    let created = call(
        &env.user,
        env.factory.id(),
        "create_vault",
        create_args("acme", env.factory_owner.id()),
        NearToken::from_near(6),
    )
    .await?;
    assert!(created.is_success(), "{created:?}");
    let vault_id: AccountId = format!("acme.{}", env.factory.id()).parse()?;
    assert_eq!(
        created.json::<Option<String>>()?,
        Some(vault_id.to_string())
    );

    // I9: zero access keys at creation.
    assert!(
        env.worker.view_access_keys(&vault_id).await?.is_empty(),
        "a factory vault must have no access keys"
    );
    // It runs exactly the code the factory stored.
    let deployed = env.worker.view_code(&vault_id).await?;
    assert!(
        deployed == env.code,
        "the vault does not run the stored code"
    );
    // new() received the factory config, with the caller as owner and the factory recorded.
    let config: Value = env
        .worker
        .view(&vault_id, "get_config")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(config["owner"], json!(env.user.id()));
    assert_eq!(config["factory"], json!(env.factory.id()));
    assert_eq!(config["usdc"], json!("usdc.test.near"));
    assert_eq!(config["intents"], json!("intents.test.near"));
    assert_eq!(config["allowed_assets"], json!(["base-usdc.test.near"]));
    assert_eq!(config["approvers"], json!([env.factory_owner.id()]));
    assert_eq!(config["daily_backstop"], json!((500 * USDC).to_string()));

    // The registry knows the vault and its version.
    assert_eq!(
        view(
            &env.factory,
            "vault_version",
            json!({"account_id": vault_id})
        )
        .await?,
        json!(1)
    );
    let vaults = view(
        &env.factory,
        "list_vaults",
        json!({"from_index": 0, "limit": 10}),
    )
    .await?;
    assert_eq!(vaults[0]["owner"], json!(env.user.id()));
    assert_eq!(vaults[0]["version"], json!(1));
    Ok(())
}

#[tokio::test]
async fn a_taken_name_rolls_back_and_refunds_the_deposit() -> Result<()> {
    let env = factory_with_embedded_version().await?;
    let args = create_args("acme", env.factory_owner.id());
    let first = ok(
        &env.user,
        env.factory.id(),
        "create_vault",
        args.clone(),
        NearToken::from_near(6),
    )
    .await?;
    assert_eq!(
        first.json::<Option<String>>()?,
        Some(format!("acme.{}", env.factory.id())),
        "the first creation must succeed, or the duplicate below proves nothing"
    );
    let user_before = env.user.view_account().await?.balance;
    let factory_before = env.factory.view_account().await?.balance;
    let duplicate = call(
        &env.user,
        env.factory.id(),
        "create_vault",
        args,
        NearToken::from_near(6),
    )
    .await?;
    assert_eq!(duplicate.json::<Option<String>>()?, None);

    // The runtime refunds the failed batch to the factory and the callback forwards it to the
    // caller, so the factory does not spend its own funds. The forward is a detached receipt that
    // can land a block after `call` returns, hence the bounded wait.
    let within = |after: NearToken, before: NearToken, margin: NearToken| {
        after.as_yoctonear() + margin.as_yoctonear() > before.as_yoctonear()
    };
    // 300 Tgas at the sandbox gas price is about 0.03 NEAR, the most the duplicate call can cost.
    let gas_margin = NearToken::from_millinear(50);
    let factory_margin = NearToken::from_millinear(50);
    let deadline = Instant::now() + Duration::from_secs(10);
    let (user_after, factory_after) = loop {
        let user_after = env.user.view_account().await?.balance;
        let factory_after = env.factory.view_account().await?.balance;
        let settled = within(user_after, user_before, gas_margin)
            && within(factory_after, factory_before, factory_margin);
        if settled || Instant::now() >= deadline {
            break (user_after, factory_after);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    assert!(
        within(user_after, user_before, gas_margin),
        "the deposit was not refunded"
    );
    assert!(
        within(factory_after, factory_before, factory_margin),
        "the factory paid the refund from its own funds"
    );
    let vaults = view(
        &env.factory,
        "list_vaults",
        json!({"from_index": 0, "limit": 10}),
    )
    .await?;
    assert_eq!(vaults.as_array().map(Vec::len), Some(1));
    Ok(())
}

#[tokio::test]
async fn a_deposit_below_the_embedded_requirement_is_refused() -> Result<()> {
    let env = factory_with_embedded_version().await?;
    let outcome = call(
        &env.user,
        env.factory.id(),
        "create_vault",
        create_args("acme", env.factory_owner.id()),
        NearToken::from_near(1),
    )
    .await;
    assert!(rejection(&outcome)
        .expect("1 NEAR cannot cover the wasm storage")
        .contains("PROBARION:InsufficientDeposit"));
    Ok(())
}

#[tokio::test]
async fn publish_global_lets_the_factory_create_vaults_from_the_global_code() -> Result<()> {
    let env = factory_with_embedded_version().await?;
    let factory_before = env.factory.view_account().await?.balance;
    let published = env
        .factory_owner
        .call(env.factory.id(), "publish_global")
        .deposit(ONE_YOCTO)
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    assert!(published.is_success(), "{published:?}");
    // The burn is about 10 NEAR per 100 KB (24.9 NEAR for the 248,501-byte vault wasm), paid from the
    // factory's own balance.
    let factory_after = env.factory.view_account().await?.balance;
    let burned = factory_before
        .as_yoctonear()
        .saturating_sub(factory_after.as_yoctonear());
    assert!(
        burned >= NearToken::from_near(20).as_yoctonear(),
        "the factory should have paid the global burn (at least 20 NEAR), it paid {burned} yoctoNEAR"
    );
    let version = json!({"code_hash": env.hash, "mode": "global", "notes": "sandbox global"});
    let _ = ok(
        &env.factory_owner,
        env.factory.id(),
        "add_version",
        version,
        ONE_YOCTO,
    )
    .await?;

    let created = call(
        &env.user,
        env.factory.id(),
        "create_vault",
        create_args("acme-global", env.factory_owner.id()),
        NearToken::from_near(2),
    )
    .await?;
    assert!(created.is_success(), "{created:?}");
    let vault_id: AccountId = format!("acme-global.{}", env.factory.id()).parse()?;
    // A rolled-back batch still ends in a successful call that returns null, so check the id.
    // `json` consumes the result, so this comes after the last use of `created`.
    assert_eq!(
        created.json::<Option<String>>()?,
        Some(vault_id.to_string()),
        "the global creation was rolled back"
    );
    assert!(
        env.worker.view_access_keys(&vault_id).await?.is_empty(),
        "a factory vault must have no access keys"
    );
    // The account uses the global code published by hash, not a copy of the wasm.
    let state = env.worker.view_account(&vault_id).await?.contract_state;
    assert_eq!(
        state,
        ContractState::GlobalHash(env.hash.parse::<CryptoHash>()?),
        "expected a vault that uses the global code"
    );
    // new() ran: the vault has the caller as owner and the factory recorded.
    let config: Value = env
        .worker
        .view(&vault_id, "get_config")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(config["owner"], json!(env.user.id()));
    assert_eq!(config["factory"], json!(env.factory.id()));
    Ok(())
}
