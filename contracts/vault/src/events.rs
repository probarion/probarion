//! NEP-297 events (interfaces §4.4): `EVENT_JSON:{"standard":"probarion","version":"1.0.0",...}`.
use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId, PublicKey};

use crate::types::{Chain, Payee};

#[near(event_json(standard = "probarion"))]
pub enum VaultEvent {
    #[event_version("1.0.0")]
    MandateCreated {
        mandate_id: u64,
        payee: Payee,
        max_total: U128,
        max_per_payment: U128,
        expires_at_ns: U64,
        purpose_hash: String,
        agent_pk: PublicKey,
    },
    #[event_version("1.0.0")]
    MandateRevoked { mandate_id: u64 },
    #[event_version("1.0.0")]
    AgentAdded {
        public_key: PublicKey,
        label: Option<String>,
    },
    #[event_version("1.0.0")]
    AgentRemoved {
        public_key: PublicKey,
        label: Option<String>,
    },
    #[event_version("1.0.0")]
    LedgerKeySet { public_key: PublicKey },
    #[event_version("1.0.0")]
    SpendHeld {
        spend_id: u64,
        mandate_id: u64,
        amount: U128,
        invoice_hash: String,
        decision_hash: String,
        held_until_ns: U64,
    },
    #[event_version("1.0.0")]
    SpendSubmitted {
        spend_id: u64,
        mandate_id: u64,
        amount: U128,
        invoice_hash: String,
        decision_hash: String,
        destination: Payee,
    },
    #[event_version("1.0.0")]
    SpendApproved { spend_id: u64, by: AccountId },
    #[event_version("1.0.0")]
    SpendRejected { spend_id: u64, by: AccountId },
    #[event_version("1.0.0")]
    SpendExpired { spend_id: u64 },
    #[event_version("1.0.0")]
    SpendPaid {
        spend_id: u64,
        mandate_id: u64,
        amount: U128,
        destination: Payee,
    },
    #[event_version("1.0.0")]
    SpendBurned {
        spend_id: u64,
        mandate_id: u64,
        amount: U128,
        chain: Chain,
        address: String,
        asset: AccountId,
        memo: String,
    },
    #[event_version("1.0.0")]
    SpendFailed {
        spend_id: u64,
        mandate_id: u64,
        amount: U128,
        reason: String,
    },
    #[event_version("1.0.0")]
    Frozen { by: AccountId },
    #[event_version("1.0.0")]
    Unfrozen { by: AccountId },
    #[event_version("1.0.0")]
    LedgerAnchored { seq: u64, root: String, count: u64 },
    #[event_version("1.0.0")]
    Withdrawn {
        to: AccountId,
        token: AccountId,
        amount: U128,
    },
}

#[cfg(test)]
mod tests {
    use crate::test_utils::*;
    use crate::*;
    use near_sdk::serde_json::json;

    // probarion-claim: EVENTS
    #[test]
    fn events_are_nep297_lines_with_the_probarion_standard() {
        as_account(vault_id(), T0);
        VaultEvent::MandateRevoked { mandate_id: 7 }.emit();
        assert_eq!(
            last_event(),
            json!({"standard": "probarion", "version": "1.0.0", "event": "mandate_revoked", "data": {"mandate_id": 7}})
        );
    }

    #[test]
    fn an_absent_optional_label_serialises_as_null() {
        as_account(vault_id(), T0);
        VaultEvent::AgentRemoved {
            public_key: pk(3),
            label: None,
        }
        .emit();
        assert_eq!(
            last_event()["data"],
            json!({"public_key": pk(3), "label": null})
        );
    }
}
