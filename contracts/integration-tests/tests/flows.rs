use anyhow::Result;
use integration_tests::*;
use serde_json::{json, Value};

#[tokio::test]
async fn a_near_payee_is_paid_through_ft_transfer() -> Result<()> {
    let env = setup().await?;
    let id = env.create_mandate(env.near_payee(), 100 * USDC).await?;
    // The real node accepted the measured-storage deposit and forwarded the payee's USDC
    // registration (a detached receipt that the spend's own success would not prove).
    let registered = view(
        &env.usdc,
        "storage_balance_of",
        json!({"account_id": env.payee.id()}),
    )
    .await?;
    assert!(
        !registered.is_null(),
        "the payee is not registered on USDC after create_mandate"
    );
    let outcome = env.spend(id, 10 * USDC, 1).await?;
    assert!(outcome.is_success(), "{outcome:?}");
    let logs = outcome.logs().join("\n");
    assert!(logs.contains("\"event\":\"spend_submitted\""), "{logs}");
    assert!(logs.contains("\"event\":\"spend_paid\""), "{logs}");
    assert_eq!(
        outcome.json::<Value>()?,
        json!({"spend_id": 1, "status": "paid"})
    );
    assert_eq!(ft_balance(&env.usdc, env.payee.id()).await?, 10 * USDC);
    assert_eq!(ft_balance(&env.usdc, env.vault.id()).await?, 90 * USDC);
    let m = view(&env.vault, "get_mandate", json!({"mandate_id": id})).await?;
    assert_eq!(
        (m["spent"].clone(), m["reserved"].clone()),
        (json!((10 * USDC).to_string()), json!("0"))
    );
    Ok(())
}

// probarion-claim: I7
#[tokio::test]
async fn a_base_payee_is_paid_by_ft_withdraw_with_the_mandate_memo() -> Result<()> {
    let env = setup().await?;
    let id = env.create_mandate(env.base_payee(), 100 * USDC).await?;
    let outcome = env.spend(id, 7 * USDC, 2).await?;
    assert!(outcome.is_success(), "{outcome:?}");
    let lines: Vec<String> = outcome.logs().iter().map(|l| l.to_string()).collect();
    let logs = lines.join("\n");
    assert_eq!(
        outcome.json::<Value>()?,
        json!({"spend_id": 1, "status": "paid"})
    );

    // Both burn shapes in the same transaction (verifier check h): the intents mt_burn for the
    // vault's balance, and the POA ft_burn carrying the memo.
    let mt_burn = lines
        .iter()
        .find(|l| l.contains("\"event\":\"mt_burn\""))
        .expect("an mt_burn log");
    assert!(
        mt_burn.contains(&format!("\"owner_id\":\"{}\"", env.vault.id())),
        "{mt_burn}"
    );
    assert!(
        mt_burn.contains(&format!("\"amounts\":[\"{}\"]", 7 * USDC)),
        "{mt_burn}"
    );
    let ft_burn = lines
        .iter()
        .find(|l| l.contains("\"event\":\"ft_burn\""))
        .expect("an ft_burn log");
    assert!(
        ft_burn.contains(&format!("\"owner_id\":\"{}\"", env.intents.id())),
        "{ft_burn}"
    );

    // I7: the burn carries exactly WITHDRAW_TO: + the mandate address, on the allow-listed asset.
    let memo = format!("WITHDRAW_TO:{EVM_ADDR}");
    let burns = view(&env.intents, "burns", json!({"from_index": 0, "limit": 10})).await?;
    assert_eq!(
        burns,
        json!([{"owner_id": env.vault.id(), "token": env.base.id(), "amount": (7 * USDC).to_string(), "memo": memo}])
    );
    assert!(logs.contains("\"event\":\"ft_burn\""), "{logs}");
    assert!(logs.contains("\"event\":\"spend_burned\""), "{logs}");
    let spend = view(&env.vault, "get_spend", json!({"spend_id": 1})).await?;
    assert_eq!(spend["memo"], json!(memo));
    assert_eq!(env.intents_balance().await?, 43 * USDC);

    // I8: the vault registered no key in intents, and predecessor auth is on.
    let keys = view(
        &env.intents,
        "public_keys_of",
        json!({"account_id": env.vault.id()}),
    )
    .await?;
    assert_eq!(keys, json!([]));
    let auth = view(
        &env.intents,
        "is_auth_by_predecessor_id_enabled",
        json!({"account_id": env.vault.id()}),
    )
    .await?;
    assert_eq!(auth, json!(true));
    Ok(())
}
