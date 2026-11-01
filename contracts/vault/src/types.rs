//! ABI types (interfaces §4.1) and the storage-only records behind them.
use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId, PublicKey};

use crate::WITHDRAW_MEMO_PREFIX;

#[near(serializers = [json, borsh])]
#[serde(tag = "type", rename_all = "snake_case")]
#[derive(Clone, Debug, PartialEq)]
pub enum Payee {
    Near {
        account_id: AccountId,
    },
    Intents {
        chain: Chain,
        address: String,
        asset: AccountId,
    },
}

impl Payee {
    /// `WITHDRAW_TO:<address>` for an Intents payee, built only from mandate storage (I7).
    pub fn withdraw_memo(&self) -> Option<String> {
        match self {
            Payee::Intents { address, .. } => Some(format!("{WITHDRAW_MEMO_PREFIX}{address}")),
            Payee::Near { .. } => None,
        }
    }
}

#[near(serializers = [json, borsh])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Chain {
    Base,
    Solana,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct MandateInput {
    pub payee: Payee,
    pub purpose_hash: String,
    pub max_per_payment: U128,
    pub max_total: U128,
    pub max_uses: u32,
    pub expires_at_ns: U64,
    pub approval_above: U128,
    pub agent_pk: PublicKey,
    pub label: String,
}

#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum MandateStatus {
    Active,
    Revoked,
    Exhausted,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct MandateView {
    pub id: u64,
    pub payee: Payee,
    pub purpose_hash: String,
    pub max_per_payment: U128,
    pub max_total: U128,
    pub spent: U128,
    pub reserved: U128,
    pub max_uses: u32,
    pub uses: u32,
    pub expires_at_ns: U64,
    pub approval_above: U128,
    pub agent_pk: PublicKey,
    pub label: String,
    pub status: MandateStatus,
    pub created_at_ns: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SpendRequest {
    pub mandate_id: u64,
    pub amount: U128,
    pub invoice_hash: String,
    pub r#ref: String,
    pub decision_hash: String,
}

#[near(serializers = [json, borsh])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SpendStatus {
    Held,
    Pending,
    Paid,
    Burned,
    Failed,
    Rejected,
    Expired,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SpendView {
    pub id: u64,
    pub mandate_id: u64,
    pub amount: U128,
    pub invoice_hash: String,
    pub r#ref: String,
    pub decision_hash: String,
    pub agent_pk: PublicKey,
    pub destination: Payee,
    pub status: SpendStatus,
    pub created_at_ns: U64,
    pub held_until_ns: Option<U64>,
    pub memo: Option<String>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SpendResult {
    pub spend_id: u64,
    pub status: SpendStatus,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Verdict {
    pub ok: bool,
    pub code: Option<String>,
    pub would_hold: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AnchorView {
    pub seq: u64,
    pub root: String,
    pub count: u64,
    pub at_ns: U64,
    /// The ledger key that signed this anchor. Entries up to `count` verify against it, so
    /// `set_ledger_key` rotation keeps old entries verifiable.
    pub ledger_key: PublicKey,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentView {
    pub public_key: PublicKey,
    pub label: String,
    pub added_at_ns: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct VaultConfig {
    pub owner: AccountId,
    pub approvers: Vec<AccountId>,
    pub usdc: AccountId,
    pub intents: AccountId,
    pub allowed_assets: Vec<AccountId>,
    pub daily_backstop: U128,
    pub held_ttl_ns: U64,
    pub frozen: bool,
    pub factory: Option<AccountId>,
    pub version: String,
    pub ledger_key: Option<PublicKey>,
}

/// Storage record behind `MandateView`. The payee never changes after creation.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Mandate {
    pub payee: Payee,
    pub purpose_hash: String,
    pub max_per_payment: u128,
    pub max_total: u128,
    pub spent: u128,
    pub reserved: u128,
    pub max_uses: u32,
    /// Spends that are Held, Pending, Paid or Burned. Released spends give their use back.
    pub uses: u32,
    pub expires_at_ns: u64,
    pub approval_above: u128,
    pub agent_pk: PublicKey,
    pub label: String,
    pub revoked: bool,
    pub created_at_ns: u64,
}

impl Mandate {
    pub fn status(&self) -> MandateStatus {
        if self.revoked {
            MandateStatus::Revoked
        } else if self.uses >= self.max_uses || self.spent >= self.max_total {
            MandateStatus::Exhausted
        } else {
            MandateStatus::Active
        }
    }

    pub fn view(&self, id: u64) -> MandateView {
        MandateView {
            id,
            payee: self.payee.clone(),
            purpose_hash: self.purpose_hash.clone(),
            max_per_payment: U128(self.max_per_payment),
            max_total: U128(self.max_total),
            spent: U128(self.spent),
            reserved: U128(self.reserved),
            max_uses: self.max_uses,
            uses: self.uses,
            expires_at_ns: U64(self.expires_at_ns),
            approval_above: U128(self.approval_above),
            agent_pk: self.agent_pk.clone(),
            label: self.label.clone(),
            status: self.status(),
            created_at_ns: U64(self.created_at_ns),
        }
    }
}

/// Storage record behind `SpendView`. The destination and memo come from the mandate.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Spend {
    pub mandate_id: u64,
    pub amount: u128,
    pub invoice_hash: String,
    pub r#ref: String,
    pub decision_hash: String,
    pub agent_pk: PublicKey,
    pub status: SpendStatus,
    pub created_at_ns: u64,
    pub held_until_ns: Option<u64>,
    /// UTC day bucket (`created_at_ns / DAY_NS`) the amount was counted in.
    pub day: u64,
}

impl Spend {
    pub fn view(&self, id: u64, destination: Payee) -> SpendView {
        SpendView {
            id,
            mandate_id: self.mandate_id,
            amount: U128(self.amount),
            invoice_hash: self.invoice_hash.clone(),
            r#ref: self.r#ref.clone(),
            decision_hash: self.decision_hash.clone(),
            agent_pk: self.agent_pk.clone(),
            memo: destination.withdraw_memo(),
            destination,
            status: self.status,
            created_at_ns: U64(self.created_at_ns),
            held_until_ns: self.held_until_ns.map(U64),
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Agent {
    pub public_key: PublicKey,
    pub label: String,
    pub added_at_ns: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Anchor {
    pub root: String,
    pub count: u64,
    pub at_ns: u64,
    pub ledger_key: PublicKey,
}
