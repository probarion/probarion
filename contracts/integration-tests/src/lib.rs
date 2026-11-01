//! Sandbox harness. It deploys test-ft (USDC and a Base POA-like token), intents-stub and a vault,
//! then locks the vault exactly as on mainnet. Build the wasm first: `bash scripts/build-contracts.sh`.
use anyhow::{anyhow, Result};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};
use std::path::PathBuf;

pub const USDC: u128 = 1_000_000;
pub const EVM_ADDR: &str = "0x2222222222222222222222222222222222222222";
pub const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);
pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

pub fn hex(n: u8) -> String {
    format!("{n:02x}").repeat(32)
}

/// Finds `<lib>.wasm` in either cargo-near output layout.
pub fn wasm(lib: &str) -> Result<Vec<u8>> {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/near");
    for path in [
        base.join(lib).join(format!("{lib}.wasm")),
        base.join(format!("{lib}.wasm")),
    ] {
        if path.exists() {
            return Ok(std::fs::read(path)?);
        }
    }
    Err(anyhow!(
        "{lib}.wasm not found under {}; run bash scripts/build-contracts.sh",
        base.display()
    ))
}

pub async fn subaccount(parent: &Account, name: &str, near: u128) -> Result<Account> {
    Ok(parent
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(near))
        .transact()
        .await?
        .into_result()?)
}

pub async fn deploy(parent: &Account, name: &str, lib: &str, near: u128) -> Result<Contract> {
    let account = subaccount(parent, name, near).await?;
    Ok(account.deploy(&wasm(lib)?).await?.into_result()?)
}

/// A function call signed by `signer`. `Err` means the transaction was rejected before execution
/// (for example an FC key used outside its scope); `Ok` with `is_failure()` means it panicked.
pub async fn call(
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
        .gas(Gas::from_tgas(300))
        .transact()
        .await?)
}

pub async fn ok(
    signer: &Account,
    contract: &AccountId,
    method: &str,
    args: Value,
    deposit: NearToken,
) -> Result<ExecutionFinalResult> {
    let outcome = call(signer, contract, method, args, deposit).await?;
    if outcome.is_failure() {
        return Err(anyhow!("{method} failed: {outcome:?}"));
    }
    Ok(outcome)
}

/// `Some(text)` when the call was rejected or failed, `None` when it succeeded.
pub fn rejection(outcome: &Result<ExecutionFinalResult>) -> Option<String> {
    match outcome {
        Err(e) => Some(format!("{e:?}")),
        Ok(o) if o.is_failure() => Some(format!("{o:?}")),
        Ok(_) => None,
    }
}

pub async fn view(contract: &Contract, method: &str, args: Value) -> Result<Value> {
    Ok(contract.view(method).args_json(args).await?.json()?)
}

pub async fn ft_balance(token: &Contract, account: &AccountId) -> Result<u128> {
    let value: String = token
        .view("ft_balance_of")
        .args_json(json!({"account_id": account}))
        .await?
        .json()?;
    Ok(value.parse()?)
}

pub fn spend_request(mandate_id: u64, amount: u128, n: u8) -> Value {
    json!({
        "mandate_id": mandate_id,
        "amount": amount.to_string(),
        "invoice_hash": hex(n),
        "ref": format!("INV-{n}"),
        "decision_hash": hex(n.wrapping_add(100)),
    })
}

/// 100 USDC per payment, 1 000 USDC total, 10 uses, expires in 2096.
pub fn mandate_input(payee: Value, approval_above: u128, agent_pk: &str) -> Value {
    json!({
        "payee": payee,
        "purpose_hash": hex(0xaa),
        "max_per_payment": (100 * USDC).to_string(),
        "max_total": (1_000 * USDC).to_string(),
        "max_uses": 10,
        "expires_at_ns": "4000000000000000000",
        "approval_above": approval_above.to_string(),
        "agent_pk": agent_pk,
        "label": "sandbox",
    })
}

pub struct Env {
    pub worker: Worker<Sandbox>,
    pub owner: Account,
    pub approver: Account,
    pub payee: Account,
    pub usdc: Contract,
    pub base: Contract,
    pub intents: Contract,
    pub vault: Contract,
    /// Signs as the vault account with the agent Function-Call key.
    pub agent: Account,
}

impl Env {
    pub fn agent_pk(&self) -> String {
        self.agent.secret_key().public_key().to_string()
    }

    pub fn near_payee(&self) -> Value {
        json!({"type": "near", "account_id": self.payee.id()})
    }

    pub fn base_payee(&self) -> Value {
        json!({"type": "intents", "chain": "base", "address": EVM_ADDR, "asset": self.base.id()})
    }

    pub async fn create_mandate(&self, payee: Value, approval_above: u128) -> Result<u64> {
        let input = mandate_input(payee, approval_above, &self.agent_pk());
        let outcome = ok(
            &self.owner,
            self.vault.id(),
            "create_mandate",
            json!({"input": input}),
            NearToken::from_millinear(100),
        )
        .await?;
        // The measured-storage deposit was accepted by the real node: no receipt failed. The payee's
        // USDC registration and the refund are detached receipts that `is_failure` does not see.
        if !outcome.failures().is_empty() {
            return Err(anyhow!(
                "create_mandate left failed receipts: {:?}",
                outcome.failures()
            ));
        }
        Ok(outcome.json()?)
    }

    /// `spend` signed by the agent FC key.
    pub async fn spend(
        &self,
        mandate_id: u64,
        amount: u128,
        n: u8,
    ) -> Result<ExecutionFinalResult> {
        let request = spend_request(mandate_id, amount, n);
        call(
            &self.agent,
            self.vault.id(),
            "spend",
            json!({"request": request}),
            NO_DEPOSIT,
        )
        .await
    }

    /// The vault's Base POA-like balance inside the stub.
    pub async fn intents_balance(&self) -> Result<u128> {
        let token_id = format!("nep141:{}", self.base.id());
        let value = view(
            &self.intents,
            "mt_balance_of",
            json!({"account_id": self.vault.id(), "token_id": token_id}),
        )
        .await?;
        Ok(value
            .as_str()
            .ok_or_else(|| anyhow!("not a string: {value}"))?
            .parse()?)
    }
}

pub async fn setup() -> Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let owner = subaccount(&root, "owner", 50).await?;
    let approver = subaccount(&root, "approver", 10).await?;
    let payee = subaccount(&root, "payee", 10).await?;
    let usdc = deploy(&root, "usdc", "test_ft", 10).await?;
    let base = deploy(&root, "base-usdc", "test_ft", 10).await?;
    for (token, name) in [(&usdc, "Test USDC"), (&base, "Test Base USDC (POA-like)")] {
        let args = json!({"owner_id": owner.id(), "name": name, "symbol": "USDC", "decimals": 6});
        let _ = ok(token.as_account(), token.id(), "new", args, NO_DEPOSIT).await?;
    }
    let intents = deploy(&root, "intents", "intents_stub", 10).await?;
    let _ = ok(
        intents.as_account(),
        intents.id(),
        "new",
        json!({}),
        NO_DEPOSIT,
    )
    .await?;

    let vault = deploy(&root, "vault", "probarion_vault", 40).await?;
    let init = json!({
        "owner": owner.id(),
        "approvers": [approver.id()],
        "usdc": usdc.id(),
        "intents": intents.id(),
        "allowed_assets": [base.id()],
        "daily_backstop": (1_000 * USDC).to_string(),
        "held_ttl_ns": "3600000000000",
    });
    let _ = ok(vault.as_account(), vault.id(), "new", init, NO_DEPOSIT).await?;
    // Lock the vault as on mainnet: delete its only full-access key.
    let full_access = vault.as_account().secret_key().public_key();
    vault
        .as_account()
        .batch(vault.id())
        .delete_key(full_access)
        .transact()
        .await?
        .into_result()?;

    // Funding. Minting registers storage; minting 0 only registers.
    let _ = ok(
        &owner,
        usdc.id(),
        "mint",
        json!({"account_id": vault.id(), "amount": (100 * USDC).to_string()}),
        NO_DEPOSIT,
    )
    .await?;
    let _ = ok(
        &owner,
        usdc.id(),
        "mint",
        json!({"account_id": owner.id(), "amount": "0"}),
        NO_DEPOSIT,
    )
    .await?;
    let _ = ok(
        &owner,
        base.id(),
        "mint",
        json!({"account_id": owner.id(), "amount": (50 * USDC).to_string()}),
        NO_DEPOSIT,
    )
    .await?;
    let _ = ok(
        &owner,
        base.id(),
        "mint",
        json!({"account_id": intents.id(), "amount": "0"}),
        NO_DEPOSIT,
    )
    .await?;
    let deposit =
        json!({"receiver_id": intents.id(), "amount": (50 * USDC).to_string(), "msg": vault.id()});
    let _ = ok(&owner, base.id(), "ft_transfer_call", deposit, ONE_YOCTO).await?;

    // The agent key, added by the vault itself on the owner's instruction.
    let agent_sk = SecretKey::from_random(KeyType::ED25519);
    let add = json!({
        "public_key": agent_sk.public_key().to_string(),
        "allowance": NearToken::from_near(1).as_yoctonear().to_string(),
        "label": "sandbox agent",
    });
    let _ = ok(&owner, vault.id(), "add_agent", add, ONE_YOCTO).await?;
    let agent = Account::from_secret_key(vault.id().clone(), agent_sk, &worker);
    Ok(Env {
        worker,
        owner,
        approver,
        payee,
        usdc,
        base,
        intents,
        vault,
        agent,
    })
}
