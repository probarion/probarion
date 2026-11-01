//! Sandbox security tests: what each key and caller can and cannot do on a real node.
//! Build the wasm first: `bash scripts/build-contracts.sh`.
use anyhow::Result;
use integration_tests::*;
use near_workspaces::types::{AccessKey, AccessKeyPermission, KeyType, NearToken, SecretKey};
use near_workspaces::Account;
use serde_json::{json, Value};

// probarion-claim: I4
#[tokio::test]
async fn the_agent_key_can_call_only_spend_and_cannot_attach_a_deposit() -> Result<()> {
    let env = setup().await?;
    let id = env.create_mandate(env.near_payee(), 100 * USDC).await?;
    let mandate = mandate_input(env.near_payee(), 100 * USDC, &env.agent_pk());
    let attempts = [
        (
            "ft_transfer on the token",
            call(
                &env.agent,
                env.usdc.id(),
                "ft_transfer",
                json!({"receiver_id": env.payee.id(), "amount": "1"}),
                ONE_YOCTO,
            )
            .await,
        ),
        (
            "approve",
            call(
                &env.agent,
                env.vault.id(),
                "approve",
                json!({"spend_id": 1}),
                NO_DEPOSIT,
            )
            .await,
        ),
        (
            "withdraw",
            call(
                &env.agent,
                env.vault.id(),
                "withdraw",
                json!({"amount": "1"}),
                NO_DEPOSIT,
            )
            .await,
        ),
        (
            "create_mandate",
            call(
                &env.agent,
                env.vault.id(),
                "create_mandate",
                json!({"input": mandate}),
                NearToken::from_millinear(100),
            )
            .await,
        ),
        (
            "spend with a deposit",
            call(
                &env.agent,
                env.vault.id(),
                "spend",
                json!({"request": spend_request(id, USDC, 9)}),
                ONE_YOCTO,
            )
            .await,
        ),
    ];
    // The key's own scope stops each of these before any contract code runs, so the node refuses
    // the transaction (`Err`). A vault panic (`Ok` with a failure) would not prove the key scope.
    for (what, outcome) in &attempts {
        assert!(
            outcome.is_err(),
            "the node let the agent key reach {what}: {outcome:?}"
        );
    }
    assert_eq!(ft_balance(&env.usdc, env.vault.id()).await?, 100 * USDC);
    assert_eq!(ft_balance(&env.usdc, env.payee.id()).await?, 0);
    // Control: the same key does work for a plain spend.
    let control = env.spend(id, USDC, 10).await?;
    assert!(control.is_success(), "{control:?}");
    assert_eq!(ft_balance(&env.usdc, env.payee.id()).await?, USDC);

    let keys = env.vault.view_access_keys().await?;
    assert_eq!(keys.len(), 1, "the vault holds only the agent key");
    match &keys[0].access_key.permission {
        AccessKeyPermission::FunctionCall(p) => {
            assert_eq!(p.receiver_id, env.vault.id().to_string());
            assert_eq!(p.method_names, vec!["spend".to_string()]);
        }
        AccessKeyPermission::FullAccess => panic!("the vault must have no full-access key"),
    }
    Ok(())
}

// probarion-claim: I5
#[tokio::test]
async fn a_held_spend_pays_only_after_an_approver_approves() -> Result<()> {
    let env = setup().await?;
    let id = env.create_mandate(env.near_payee(), 5 * USDC).await?;
    let outcome = env.spend(id, 20 * USDC, 3).await?;
    assert_eq!(
        outcome.json::<Value>()?,
        json!({"spend_id": 1, "status": "held"})
    );
    assert_eq!(ft_balance(&env.usdc, env.payee.id()).await?, 0);

    let by_owner = call(
        &env.owner,
        env.vault.id(),
        "approve",
        json!({"spend_id": 1}),
        ONE_YOCTO,
    )
    .await;
    assert!(rejection(&by_owner)
        .expect("the owner is not an approver")
        .contains("PROBARION:NotApprover"));
    let by_agent = call(
        &env.agent,
        env.vault.id(),
        "approve",
        json!({"spend_id": 1}),
        NO_DEPOSIT,
    )
    .await;
    assert!(
        by_agent.is_err(),
        "the agent key must not reach approve: {by_agent:?}"
    );
    // Both refusals left the spend held and unpaid.
    let held = view(&env.vault, "get_spend", json!({"spend_id": 1})).await?;
    assert_eq!(held["status"], json!("held"));
    assert_eq!(ft_balance(&env.usdc, env.payee.id()).await?, 0);

    let approved = ok(
        &env.approver,
        env.vault.id(),
        "approve",
        json!({"spend_id": 1}),
        ONE_YOCTO,
    )
    .await?;
    assert_eq!(
        approved.json::<Value>()?,
        json!({"spend_id": 1, "status": "paid"})
    );
    assert_eq!(ft_balance(&env.usdc, env.payee.id()).await?, 20 * USDC);
    Ok(())
}

#[tokio::test]
async fn a_dapp_login_key_on_the_owner_account_cannot_withdraw_but_can_freeze() -> Result<()> {
    let env = setup().await?;
    // What a wallet creates at dapp login: an FC key on the owner's own account, scoped to the vault.
    let login_sk = SecretKey::from_random(KeyType::ED25519);
    let scope = AccessKey::function_call_access(env.vault.id(), &[], Some(NearToken::from_near(1)));
    env.owner
        .batch(env.owner.id())
        .add_key(login_sk.public_key(), scope)
        .transact()
        .await?
        .into_result()?;
    let login = Account::from_secret_key(env.owner.id().clone(), login_sk, &env.worker);
    let args = json!({"amount": (10 * USDC).to_string()});
    // With 1 yocto the protocol rejects the transaction: FC keys cannot attach a deposit.
    let with_yocto = call(&login, env.vault.id(), "withdraw", args.clone(), ONE_YOCTO).await;
    assert!(
        with_yocto.is_err(),
        "the node must refuse a deposit from an FC key: {with_yocto:?}"
    );
    // Without a deposit the vault refuses it (the one-yocto rule).
    let without = call(&login, env.vault.id(), "withdraw", args, NO_DEPOSIT).await;
    assert!(rejection(&without)
        .expect("must be refused")
        .contains("PROBARION:RequiresOneYocto"));
    assert_eq!(ft_balance(&env.usdc, env.vault.id()).await?, 100 * USDC);
    // freeze is the protective exception: any owner key may stop the vault.
    let frozen = call(&login, env.vault.id(), "freeze", json!({}), NO_DEPOSIT).await?;
    assert!(frozen.is_success(), "{frozen:?}");
    let config = view(&env.vault, "get_config", json!({})).await?;
    assert_eq!(config["frozen"], json!(true));
    Ok(())
}

#[tokio::test]
async fn a_failed_near_payout_releases_the_reservation() -> Result<()> {
    let env = setup().await?;
    let id = env.create_mandate(env.near_payee(), 100 * USDC).await?;
    let drained = ok(
        &env.owner,
        env.vault.id(),
        "withdraw",
        json!({"amount": (95 * USDC).to_string()}),
        ONE_YOCTO,
    )
    .await?;
    assert!(drained.is_success(), "{drained:?}");
    let outcome = env.spend(id, 10 * USDC, 4).await?;
    let logs = outcome.logs().join("\n");
    assert!(logs.contains("\"event\":\"spend_failed\""), "{logs}");
    assert!(logs.contains("\"reason\":\"ft_transfer_failed\""), "{logs}");
    assert_eq!(
        outcome.json::<Value>()?,
        json!({"spend_id": 1, "status": "failed"})
    );
    let m = view(&env.vault, "get_mandate", json!({"mandate_id": id})).await?;
    assert_eq!(m["reserved"], json!("0"));
    assert_eq!(m["spent"], json!("0"));
    assert_eq!(m["uses"], json!(0));
    assert_eq!(ft_balance(&env.usdc, env.vault.id()).await?, 5 * USDC);

    // The invoice is free again; its ref is not.
    let mut retry = spend_request(id, 5 * USDC, 4);
    let same_ref = view(
        &env.vault,
        "check_spend",
        json!({"request": retry.clone(), "signer_pk": env.agent_pk()}),
    )
    .await?;
    assert_eq!(same_ref["code"], json!("DuplicateRef"));
    retry["ref"] = json!("INV-4-retry");
    let fresh = view(
        &env.vault,
        "check_spend",
        json!({"request": retry, "signer_pk": env.agent_pk()}),
    )
    .await?;
    assert_eq!(fresh["ok"], json!(true));
    Ok(())
}

#[tokio::test]
async fn a_failed_intents_payout_releases_the_reservation() -> Result<()> {
    let env = setup().await?;
    let id = env.create_mandate(env.base_payee(), 100 * USDC).await?;
    // The stub holds only 50 for the vault, so its ft_withdraw panics (insufficient balance) and the
    // vault's on_withdraw callback sees a failed promise.
    let outcome = env.spend(id, 60 * USDC, 5).await?;
    let logs = outcome.logs().join("\n");
    assert!(logs.contains("\"event\":\"spend_failed\""), "{logs}");
    assert!(logs.contains("\"reason\":\"ft_withdraw_failed\""), "{logs}");
    assert_eq!(
        outcome.json::<Value>()?,
        json!({"spend_id": 1, "status": "failed"})
    );
    assert_eq!(env.intents_balance().await?, 50 * USDC);
    let m = view(&env.vault, "get_mandate", json!({"mandate_id": id})).await?;
    assert_eq!(m["reserved"], json!("0"));
    assert_eq!(m["spent"], json!("0"));
    assert_eq!(m["uses"], json!(0));
    let burns = view(&env.intents, "burns", json!({"from_index": 0, "limit": 10})).await?;
    assert_eq!(burns, json!([]));

    // The invoice is free again; its ref stays consumed.
    let mut retry = spend_request(id, 5 * USDC, 5);
    let same_ref = view(
        &env.vault,
        "check_spend",
        json!({"request": retry.clone(), "signer_pk": env.agent_pk()}),
    )
    .await?;
    assert_eq!(same_ref["code"], json!("DuplicateRef"));
    retry["ref"] = json!("INV-5-retry");
    let fresh = view(
        &env.vault,
        "check_spend",
        json!({"request": retry, "signer_pk": env.agent_pk()}),
    )
    .await?;
    assert_eq!(fresh["ok"], json!(true));
    Ok(())
}

// probarion-claim: I6
#[tokio::test]
async fn the_ledger_key_anchors_in_strict_sequence() -> Result<()> {
    let env = setup().await?;
    let ledger_sk = SecretKey::from_random(KeyType::ED25519);
    let set = json!({
        "public_key": ledger_sk.public_key().to_string(),
        "allowance": NearToken::from_near(1).as_yoctonear().to_string(),
    });
    let _ = ok(&env.owner, env.vault.id(), "set_ledger_key", set, ONE_YOCTO).await?;
    let ledger_pk = ledger_sk.public_key().to_string();
    let ledger = Account::from_secret_key(env.vault.id().clone(), ledger_sk, &env.worker);
    let anchor = |seq: u64, count: u64| {
        let args = json!({"seq": seq, "root": hex(seq as u8), "count": count});
        call(&ledger, env.vault.id(), "anchor", args, NO_DEPOSIT)
    };

    assert!(anchor(1, 3).await?.is_success());
    let skipped = anchor(3, 5).await;
    assert!(rejection(&skipped)
        .expect("seq 3 after 1 must fail")
        .contains("PROBARION:BadSeq"));
    assert!(anchor(2, 5).await?.is_success());

    // Keys cannot be swapped: the agent key cannot anchor, the ledger key cannot spend.
    let by_agent = call(
        &env.agent,
        env.vault.id(),
        "anchor",
        json!({"seq": 3, "root": hex(3), "count": 6}),
        NO_DEPOSIT,
    )
    .await;
    assert!(
        by_agent.is_err(),
        "the agent key must not reach anchor: {by_agent:?}"
    );
    let id = env.create_mandate(env.near_payee(), 100 * USDC).await?;
    let by_ledger = call(
        &ledger,
        env.vault.id(),
        "spend",
        json!({"request": spend_request(id, USDC, 7)}),
        NO_DEPOSIT,
    )
    .await;
    assert!(
        by_ledger.is_err(),
        "the ledger key must not reach spend: {by_ledger:?}"
    );

    let anchors = view(
        &env.vault,
        "list_anchors",
        json!({"from_index": 0, "limit": 10}),
    )
    .await?;
    assert_eq!(anchors.as_array().map(Vec::len), Some(2));
    assert_eq!(
        (anchors[1]["seq"].clone(), anchors[1]["count"].clone()),
        (json!(2), json!(5))
    );
    // Each anchor records the key that signed it (survives ledger-key rotation).
    assert_eq!(anchors[0]["ledger_key"], json!(ledger_pk));
    assert_eq!(anchors[1]["ledger_key"], json!(ledger_pk));
    Ok(())
}

#[tokio::test]
async fn the_payout_callbacks_refuse_every_caller_but_the_vault() -> Result<()> {
    let env = setup().await?;
    // `#[private]` is checked before anything else, so the refusal names the method. A callback
    // that lost its guard would fail differently (there is no promise result to read), which is
    // why the assertion reads the text and not only the failure.
    for method in ["on_transfer", "on_withdraw"] {
        for caller in [&env.owner, &env.approver] {
            let outcome = call(
                caller,
                env.vault.id(),
                method,
                json!({"spend_id": 1}),
                NO_DEPOSIT,
            )
            .await;
            let text = rejection(&outcome).expect("a direct call to a callback must fail");
            assert!(
                text.contains(&format!("Method {method} is private")),
                "{} called {method}: {text}",
                caller.id()
            );
        }
    }
    Ok(())
}
