//! Replays the attack of "I-HITL: Inalienable Human-in-the-Loop" (arXiv:2610.35835) against a
//! vault on a real node. In the paper an agent's transfer failed with "error 400: spend limit
//! exceeded". The agent called wallet.raise_limit, read the OTP that was emailed to the owner,
//! sent it with submit_otp, and the policy went up so it could pay. Here the agent holds what a
//! Probarion agent holds, the agent Function-Call key on the vault, and each step maps to:
//!   (a) the failed transfer: a spend over max_per_payment fails with PROBARION:OverPerPayment;
//!   (b) a payment that needs a human: a spend within max_per_payment but above approval_above is
//!       held, and nothing moves;
//!   (c) raise_limit and submit_otp: the agent key tries to raise its own limits, approve its own
//!       spend, and every other way around them; the node refuses each transaction before any
//!       contract code runs, and says why;
//!   (d) "policy now 1 / 5 / 20 / 50": after all the attempts the mandate, the config, the agents
//!       and the held spend are byte for byte what they were, and the vault's keys keep their
//!       nonces and scopes;
//!   (e) the payment goes out only when the approver's own account approves it.
//! There is no OTP to read: an approval is a call signed by an approver account's full-access key.
//! Build the wasm first: `bash scripts/build-contracts.sh`.
use anyhow::{anyhow, Result};
use integration_tests::*;
use near_workspaces::operations::Function;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{
    AccessKey, AccessKeyInfo, AccessKeyPermission, Gas, KeyType, NearToken, SecretKey,
};
use near_workspaces::{Account, AccountId};
use serde_json::{json, Value};

/// How nearcore refuses a transaction that a Function-Call key signs outside its scope
/// (`InvalidTxError::InvalidAccessKeyError`). The sandbox near-workspaces 0.23 starts is nearcore
/// 2.13.4. Its `verify_and_charge_tx_ephemeral` (runtime/runtime/src/verifier.rs) checks the nonce,
/// the balance, the key's allowance (NotEnoughAllowance) and the storage stake, and then
/// `verify_function_call_permission`, which stops at the first of:
///   1. more than one action, or one action that is not a FunctionCall: RequiresFullAccess;
///   2. a deposit on the call: DepositWithFunctionCall;
///   3. a receiver other than the key's: ReceiverMismatch;
///   4. a method not in the key's method_names: MethodNameMismatch.
///
/// So a call to another method that also attaches a deposit reports the deposit. The RPC node runs
/// these checks before it accepts the transaction, so nothing lands and the key's nonce stays put.
/// The allowance check prices prepaid gas at no less than 10^9 yoctoNEAR per gas
/// (min_gas_purchase_price, protocol 85): the harness's 300 Tgas takes 0.3 NEAR of the allowance
/// until its refund comes back, and `transact` returns before refunds land (broadcast_tx_commit
/// waits for every receipt but the refunds). With the refunds of (a) and (b) still on their way,
/// the agent key's 1 NEAR allowance can be down to about 0.4 NEAR. So each attempt attaches 30 Tgas
/// (`attempt`), at most 0.13 NEAR with its deposit, and the allowance check never answers first.
#[derive(Debug)]
enum Refused {
    RequiresFullAccess,
    DepositWithFunctionCall,
    /// The receiver the transaction named.
    ReceiverMismatch(String),
    /// The method the transaction named.
    MethodNameMismatch(&'static str),
}

/// `call` with 30 Tgas instead of 300, so that no attempt runs into the allowance (see `Refused`).
async fn attempt(
    signer: &Account,
    contract: &AccountId,
    method: &str,
    args: Value,
    deposit: NearToken,
) -> Result<ExecutionFinalResult> {
    Ok(signer
        .call(contract, method)
        .args_json(args)
        .deposit(deposit)
        .gas(Gas::from_tgas(30))
        .transact()
        .await?)
}

/// The node refused the agent key's transaction with `expected`: an RPC error (`Err`), not a
/// receipt that ran and failed, so no contract code ran. `E` is anyhow's error for `attempt` and
/// near-workspaces' own for a batch; the text of either carries the InvalidTxError's Debug form.
fn assert_refused_by_the_node<E: std::fmt::Debug>(
    what: &str,
    outcome: &std::result::Result<ExecutionFinalResult, E>,
    expected: &Refused,
) {
    let text = match outcome {
        Err(e) => format!("{e:?}"),
        Ok(o) => panic!("{what}: the node accepted the transaction: {o:?}"),
    };
    let wanted = match expected {
        Refused::RequiresFullAccess => "InvalidAccessKeyError(RequiresFullAccess)".to_string(),
        Refused::DepositWithFunctionCall => {
            "InvalidAccessKeyError(DepositWithFunctionCall)".to_string()
        }
        Refused::ReceiverMismatch(receiver) => format!(
            "InvalidAccessKeyError(ReceiverMismatch {{ tx_receiver: AccountId(\"{receiver}\"),"
        ),
        Refused::MethodNameMismatch(method) => {
            format!("InvalidAccessKeyError(MethodNameMismatch {{ method_name: \"{method}\" }})")
        }
    };
    assert!(
        text.contains(&wanted),
        "{what}: expected {expected:?}, got {text}"
    );
}

/// An access key as the node returns it, without its allowance: a gas refund raises the allowance
/// and can land after `transact` returns. A transaction the node accepted would raise the nonce.
fn nonce_and_scope(key: &AccessKeyInfo) -> String {
    let nonce = key.access_key.nonce;
    match &key.access_key.permission {
        AccessKeyPermission::FunctionCall(p) => format!(
            "{} nonce {nonce}: {} {:?}",
            key.public_key, p.receiver_id, p.method_names
        ),
        AccessKeyPermission::FullAccess => format!("{} nonce {nonce}: full access", key.public_key),
    }
}

/// What the agent would have to change to pay more than its mandate allows, as the node returns
/// it: the raw bytes of each view, and the vault's access keys with their nonce and scope.
async fn snapshot(env: &Env, mandate_id: u64) -> Result<Vec<(&'static str, Vec<u8>)>> {
    let mut out = Vec::new();
    for (method, args) in [
        ("get_mandate", json!({"mandate_id": mandate_id})),
        ("list_mandates", json!({"from_index": 0, "limit": 100})),
        ("get_spend", json!({"spend_id": 1})),
        ("get_config", json!({})),
        ("list_agents", json!({})),
    ] {
        out.push((method, env.vault.view(method).args_json(args).await?.result));
    }
    let keys = env.vault.view_access_keys().await?;
    let keys: Vec<String> = keys.iter().map(nonce_and_scope).collect();
    out.push(("the vault's keys", keys.join("\n").into_bytes()));
    Ok(out)
}

/// The agent key's allowance in yoctoNEAR.
async fn agent_allowance(env: &Env) -> Result<u128> {
    let key = env
        .vault
        .view_access_key(&env.agent.secret_key().public_key())
        .await?;
    match key.permission {
        AccessKeyPermission::FunctionCall(p) => p
            .allowance
            .map(|a| a.as_yoctonear())
            .ok_or_else(|| anyhow!("the agent key has no allowance limit")),
        AccessKeyPermission::FullAccess => Err(anyhow!("the agent key has full access")),
    }
}

#[tokio::test]
async fn ihitl_replay_the_agent_cannot_raise_its_own_limit_or_approve_itself() -> Result<()> {
    let env = setup().await?;
    // 100 USDC per payment, 1 000 in total, 10 uses; a spend above 10 USDC waits for an approver.
    let id = env.create_mandate(env.near_payee(), 10 * USDC).await?;

    // (a) The paper's "spend limit exceeded". The node accepts the spend and the vault refuses it.
    let over_cap = env.spend(id, 150 * USDC, 1).await;
    assert!(over_cap.is_ok(), "the node refused a spend: {over_cap:?}");
    assert!(rejection(&over_cap)
        .expect("a spend over max_per_payment must fail")
        .contains("PROBARION:OverPerPayment"));

    // (b) Within the cap but above approval_above: held for a human, and nothing is paid.
    let held = env.spend(id, 60 * USDC, 2).await?;
    assert_eq!(
        held.json::<Value>()?,
        json!({"spend_id": 1, "status": "held"})
    );
    assert_eq!(ft_balance(&env.usdc, env.payee.id()).await?, 0);
    let before = snapshot(&env, id).await?;
    let allowance = agent_allowance(&env).await?;

    // (c) The agent key tries to get past the cap and the hold. First every vault method that
    // changes state, except `spend`, with the arguments the agent would want: the paper's
    // raise_limit is create_mandate with higher limits (no method changes a mandate's limits), and
    // its submit_otp is approve.
    let new_key = SecretKey::from_random(KeyType::ED25519).public_key();
    let mut higher = mandate_input(env.near_payee(), 1_000 * USDC, &env.agent_pk());
    higher["max_per_payment"] = json!((1_000 * USDC).to_string());
    higher["max_total"] = json!((50_000 * USDC).to_string());
    higher["max_uses"] = json!(1_000);
    // `new` again, naming the vault itself owner and approver, with a far higher backstop.
    let reinit = json!({
        "owner": env.vault.id(),
        "approvers": [env.vault.id()],
        "usdc": env.usdc.id(),
        "intents": env.intents.id(),
        "allowed_assets": [env.base.id()],
        "daily_backstop": (1_000_000 * USDC).to_string(),
        "held_ttl_ns": "3600000000000",
    });
    let new_allowance = NearToken::from_near(10).as_yoctonear().to_string();
    let add_agent = json!({
        "public_key": new_key.to_string(),
        "allowance": new_allowance,
        "label": "agent-made",
    });
    // (method, arguments, the deposit the method asks for)
    let vault_methods: Vec<(&'static str, Value, Option<NearToken>)> = vec![
        ("approve", json!({"spend_id": 1}), Some(ONE_YOCTO)),
        (
            "create_mandate",
            json!({"input": higher}),
            Some(NearToken::from_millinear(100)),
        ),
        ("add_agent", add_agent, Some(ONE_YOCTO)),
        ("unfreeze", json!({}), Some(ONE_YOCTO)),
        ("revoke_mandate", json!({"mandate_id": id}), Some(ONE_YOCTO)),
        (
            "withdraw",
            json!({"amount": (100 * USDC).to_string()}),
            Some(ONE_YOCTO),
        ),
        ("reject", json!({"spend_id": 1}), Some(ONE_YOCTO)),
        (
            "remove_agent",
            json!({"public_key": env.agent_pk()}),
            Some(ONE_YOCTO),
        ),
        (
            "set_ledger_key",
            json!({"public_key": new_key.to_string(), "allowance": new_allowance}),
            Some(ONE_YOCTO),
        ),
        (
            "withdraw_intents",
            json!({"token": env.base.id(), "amount": (50 * USDC).to_string()}),
            Some(ONE_YOCTO),
        ),
        ("freeze", json!({}), None),
        ("expire_held", json!({"spend_id": 1}), None),
        (
            "anchor",
            json!({"seq": 1, "root": hex(1), "count": 1}),
            None,
        ),
        ("new", reinit.clone(), None),
        // The payout callbacks: `#[private]` would admit the agent, whose predecessor is the vault.
        ("on_transfer", json!({"spend_id": 1}), None),
        ("on_withdraw", json!({"spend_id": 1}), None),
    ];
    for (method, args, deposit) in &vault_methods {
        let bare = attempt(&env.agent, env.vault.id(), method, args.clone(), NO_DEPOSIT).await;
        assert_refused_by_the_node(
            &format!("{method} with no deposit"),
            &bare,
            &Refused::MethodNameMismatch(method),
        );
        if let Some(deposit) = deposit {
            let paid = attempt(&env.agent, env.vault.id(), method, args.clone(), *deposit).await;
            assert_refused_by_the_node(
                &format!("{method} with its deposit"),
                &paid,
                &Refused::DepositWithFunctionCall,
            );
        }
    }

    // Another contract: the USDC token itself. The deposit is checked before the receiver.
    let transfer = json!({"receiver_id": env.payee.id(), "amount": (60 * USDC).to_string()});
    let with_yocto = attempt(
        &env.agent,
        env.usdc.id(),
        "ft_transfer",
        transfer.clone(),
        ONE_YOCTO,
    )
    .await;
    assert_refused_by_the_node(
        "ft_transfer on USDC with 1 yocto",
        &with_yocto,
        &Refused::DepositWithFunctionCall,
    );
    let without = attempt(
        &env.agent,
        env.usdc.id(),
        "ft_transfer",
        transfer,
        NO_DEPOSIT,
    )
    .await;
    assert_refused_by_the_node(
        "ft_transfer on USDC with no deposit",
        &without,
        &Refused::ReceiverMismatch(env.usdc.id().to_string()),
    );

    // Actions other than one function call: NEAR sent straight from the vault, a full-access key
    // for itself, new code, and an allowed spend with a key action riding along in the same
    // transaction.
    let send_near = env
        .agent
        .transfer_near(env.payee.id(), NearToken::from_millinear(10))
        .await;
    assert_refused_by_the_node("Transfer", &send_near, &Refused::RequiresFullAccess);
    let add_key = env
        .agent
        .batch(env.vault.id())
        .add_key(new_key.clone(), AccessKey::full_access())
        .transact()
        .await;
    assert_refused_by_the_node(
        "AddKey with full access",
        &add_key,
        &Refused::RequiresFullAccess,
    );
    let deploy = env
        .agent
        .batch(env.vault.id())
        .deploy(&wasm("test_ft")?)
        .transact()
        .await;
    assert_refused_by_the_node("DeployContract", &deploy, &Refused::RequiresFullAccess);
    let batch = env
        .agent
        .batch(env.vault.id())
        .call(Function::new("spend").args_json(json!({"request": spend_request(id, USDC, 3)})))
        .add_key(new_key, AccessKey::full_access())
        .transact()
        .await;
    assert_refused_by_the_node(
        "spend + AddKey in one transaction",
        &batch,
        &Refused::RequiresFullAccess,
    );

    // The only code that writes the config or the approvers is `new`. Past the key scope, a second
    // `new` fails even from the owner's full-access key: near-sdk's #[init] refuses it once state
    // exists. (A unit test calls `Vault::new` directly, past the #[init] wrapper, so it cannot show
    // this.)
    let again = call(&env.owner, env.vault.id(), "new", reinit, NO_DEPOSIT).await;
    let text = rejection(&again).expect("a second new must fail");
    assert!(
        text.contains("The contract has already been initialized"),
        "{text}"
    );

    // (d) Nothing moved. Each view is unchanged, and so is each vault key's nonce and scope: no
    // attempt landed. A refund of (a) or (b) may have raised the agent key's allowance since;
    // nothing lowered it.
    let after = snapshot(&env, id).await?;
    assert_eq!(before.len(), after.len());
    for ((what, was), (_, now)) in before.iter().zip(&after) {
        assert_eq!(
            was,
            now,
            "{what} changed:\nbefore: {}\nafter:  {}",
            String::from_utf8_lossy(was),
            String::from_utf8_lossy(now)
        );
    }
    let allowance_now = agent_allowance(&env).await?;
    assert!(
        allowance_now >= allowance,
        "the agent key's allowance fell from {allowance} to {allowance_now}"
    );
    let m = view(&env.vault, "get_mandate", json!({"mandate_id": id})).await?;
    assert_eq!(
        (
            m["max_per_payment"].clone(),
            m["max_total"].clone(),
            m["max_uses"].clone(),
            m["approval_above"].clone(),
            m["reserved"].clone(),
        ),
        (
            json!((100 * USDC).to_string()),
            json!((1_000 * USDC).to_string()),
            json!(10),
            json!((10 * USDC).to_string()),
            json!((60 * USDC).to_string()),
        )
    );
    let keys = env.vault.view_access_keys().await?;
    assert_eq!(
        keys.len(),
        1,
        "the vault holds only the agent key: {keys:?}"
    );
    assert_eq!(keys[0].public_key, env.agent.secret_key().public_key());
    match &keys[0].access_key.permission {
        AccessKeyPermission::FunctionCall(p) => {
            assert_eq!(p.receiver_id, env.vault.id().to_string());
            assert_eq!(p.method_names, vec!["spend".to_string()]);
        }
        AccessKeyPermission::FullAccess => panic!("the vault must have no full-access key"),
    }
    assert_eq!(ft_balance(&env.usdc, env.vault.id()).await?, 100 * USDC);
    assert_eq!(ft_balance(&env.usdc, env.payee.id()).await?, 0);

    // (e) Only an approver's own account approves: the owner is refused by the vault, and the
    // approver's call pays the held spend.
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
    let approved = ok(
        &env.approver,
        env.vault.id(),
        "approve",
        json!({"spend_id": 1}),
        ONE_YOCTO,
    )
    .await?;
    let logs = approved.logs().join("\n");
    assert!(
        logs.contains(&format!("\"by\":\"{}\"", env.approver.id())),
        "{logs}"
    );
    assert_eq!(
        approved.json::<Value>()?,
        json!({"spend_id": 1, "status": "paid"})
    );
    assert_eq!(ft_balance(&env.usdc, env.payee.id()).await?, 60 * USDC);
    assert_eq!(ft_balance(&env.usdc, env.vault.id()).await?, 40 * USDC);
    let m = view(&env.vault, "get_mandate", json!({"mandate_id": id})).await?;
    assert_eq!(
        (m["spent"].clone(), m["reserved"].clone()),
        (json!((60 * USDC).to_string()), json!("0"))
    );
    Ok(())
}
