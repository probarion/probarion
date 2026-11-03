//! Keys the vault adds to itself on the owner's instruction (I9: there are no other keys).
//! Agent keys may call only `spend`; the ledger key only `anchor`. FC keys attach no deposit (I4).
use near_sdk::{Allowance, Promise};

use crate::*;

#[near]
impl Vault {
    #[payable]
    pub fn add_agent(&mut self, public_key: PublicKey, allowance: U128, label: String) {
        self.assert_owner();
        require_one_yocto();
        let allowance = Self::allowance(allowance);
        if label.len() > 64 || self.agents.len() >= MAX_AGENTS || self.is_known_key(&public_key) {
            fail(ErrorCode::InvalidInput)
        }
        self.agents.push(Agent {
            public_key: public_key.clone(),
            label: label.clone(),
            added_at_ns: env::block_timestamp(),
        });
        Promise::new(env::current_account_id())
            .add_access_key_allowance(
                public_key.clone(),
                allowance,
                env::current_account_id(),
                "spend",
            )
            .detach();
        VaultEvent::AgentAdded {
            public_key,
            label: Some(label),
        }
        .emit();
    }

    #[payable]
    pub fn remove_agent(&mut self, public_key: PublicKey) {
        self.assert_owner();
        require_one_yocto();
        let index = self
            .agents
            .iter()
            .position(|a| a.public_key == public_key)
            .unwrap_or_else(|| fail(ErrorCode::InvalidInput));
        let removed = self.agents.remove(index);
        Promise::new(env::current_account_id())
            .delete_key(public_key.clone())
            .detach();
        VaultEvent::AgentRemoved {
            public_key,
            label: Some(removed.label),
        }
        .emit();
    }

    /// Sets the anchor-only ledger key, replacing (and deleting) the previous one.
    ///
    /// The AddKey of the new key and the DeleteKey of the previous key are two independent
    /// receipts, never one batch. The state change commits with this call, but a key action can
    /// still fail later in its own receipt: an AddKey fails with LackBalanceForState once agent gas
    /// has used up the vault's free NEAR, which leaves `ledger_key` naming a key that does not
    /// exist. A later DeleteKey of that key fails with DeleteKeyDoesNotExist, and a failed action
    /// rolls back every action of its receipt. In one batch it would undo the new key's AddKey on
    /// every retry, and the vault could never anchor again. Apart, a failed delete only fails itself.
    #[payable]
    pub fn set_ledger_key(&mut self, public_key: PublicKey, allowance: U128) {
        self.assert_owner();
        require_one_yocto();
        let allowance = Self::allowance(allowance);
        if self.is_known_key(&public_key) {
            fail(ErrorCode::InvalidInput)
        }
        let previous = self.ledger_key.replace(public_key.clone());
        Promise::new(env::current_account_id())
            .add_access_key_allowance(
                public_key.clone(),
                allowance,
                env::current_account_id(),
                "anchor",
            )
            .detach();
        if let Some(previous) = previous {
            Promise::new(env::current_account_id())
                .delete_key(previous)
                .detach();
        }
        VaultEvent::LedgerKeySet { public_key }.emit();
    }

    pub fn list_agents(&self) -> Vec<AgentView> {
        self.agents
            .iter()
            .map(|a| AgentView {
                public_key: a.public_key.clone(),
                label: a.label.clone(),
                added_at_ns: U64(a.added_at_ns),
            })
            .collect()
    }
}

impl Vault {
    pub(crate) fn is_agent(&self, pk: &PublicKey) -> bool {
        self.agents.iter().any(|a| a.public_key == *pk)
    }

    fn is_known_key(&self, pk: &PublicKey) -> bool {
        self.is_agent(pk) || self.ledger_key.as_ref() == Some(pk)
    }

    /// FC key allowance in yoctoNEAR; zero (unlimited) is refused.
    fn allowance(amount: U128) -> Allowance {
        Allowance::limited(NearToken::from_yoctonear(amount.0))
            .unwrap_or_else(|| fail(ErrorCode::InvalidInput))
    }
}

#[cfg(test)]
mod tests {
    use crate::test_utils::*;
    use crate::*;
    use near_sdk::mock::MockAction;
    use near_sdk::serde_json::json;
    use near_sdk::test_utils::get_created_receipts;

    type AddedKey = (
        AccountId,
        PublicKey,
        Option<NearToken>,
        AccountId,
        Vec<String>,
    );

    fn added_keys() -> Vec<AddedKey> {
        actions()
            .into_iter()
            .filter_map(|(to, a)| match a {
                MockAction::AddKeyWithFunctionCall {
                    public_key,
                    allowance,
                    receiver_id,
                    method_names,
                    ..
                } => Some((to, public_key.into(), allowance, receiver_id, method_names)),
                _ => None,
            })
            .collect()
    }

    fn deleted_keys() -> Vec<(AccountId, PublicKey)> {
        actions()
            .into_iter()
            .filter_map(|(to, a)| match a {
                MockAction::DeleteKey { public_key, .. } => Some((to, public_key.into())),
                _ => None,
            })
            .collect()
    }

    /// A key action as these tests compare it; any other action keeps its debug text.
    #[derive(Debug, PartialEq)]
    enum KeyAction {
        Add {
            public_key: PublicKey,
            allowance: Option<NearToken>,
            receiver_id: AccountId,
            method_names: Vec<String>,
        },
        Delete(PublicKey),
        Other(String),
    }

    /// Each receipt the call scheduled, in creation order: its receiver, the receipts it waits on
    /// (none for an independent receipt) and its actions. A receipt's actions succeed or fail together.
    fn receipts() -> Vec<(AccountId, Vec<u64>, Vec<KeyAction>)> {
        get_created_receipts()
            .into_iter()
            .map(|r| {
                let actions = r
                    .actions
                    .into_iter()
                    .map(|a| match a {
                        MockAction::AddKeyWithFunctionCall {
                            public_key,
                            allowance,
                            receiver_id,
                            method_names,
                            ..
                        } => KeyAction::Add {
                            public_key: public_key.into(),
                            allowance,
                            receiver_id,
                            method_names,
                        },
                        MockAction::DeleteKey { public_key, .. } => {
                            KeyAction::Delete(public_key.into())
                        }
                        other => KeyAction::Other(format!("{other:?}")),
                    })
                    .collect();
                (r.receiver_id, r.receipt_indices, actions)
            })
            .collect()
    }

    /// The AddKey of an FC key on the vault that may call only `method`.
    fn fc_key(public_key: PublicKey, allowance: u128, method: &str) -> KeyAction {
        KeyAction::Add {
            public_key,
            allowance: Some(yocto(allowance)),
            receiver_id: vault_id(),
            method_names: vec![method.to_string()],
        }
    }

    #[test]
    fn add_agent_adds_a_spend_only_key_on_the_vault_itself() {
        let mut v = setup();
        as_owner(ONE_YOCTO);
        v.add_agent(agent_pk(), U128(ONE_NEAR), "ops agent".to_string());
        assert_eq!(
            added_keys(),
            vec![(
                vault_id(),
                agent_pk(),
                Some(yocto(ONE_NEAR)),
                vault_id(),
                vec!["spend".to_string()]
            )]
        );
        assert_eq!(
            v.list_agents(),
            vec![AgentView {
                public_key: agent_pk(),
                label: "ops agent".to_string(),
                added_at_ns: U64(T0)
            }]
        );
        assert_eq!(
            last_event(),
            json!({"standard": "probarion", "version": "1.0.0", "event": "agent_added",
                   "data": {"public_key": agent_pk(), "label": "ops agent"}})
        );
    }

    #[test]
    #[should_panic(expected = "PROBARION:NotOwner")]
    fn only_the_owner_adds_agents() {
        let mut v = setup();
        as_account(approver(), T0);
        v.add_agent(agent_pk(), U128(ONE_NEAR), "x".to_string());
    }

    #[test]
    #[should_panic(expected = "PROBARION:NotOwner")]
    fn the_owner_check_comes_before_the_one_yocto_check() {
        // Non-owner with no deposit: the caller check fires first (interfaces v2 §4.2).
        let mut v = setup();
        set_ctx(approver(), pk(200), yocto(0), T0);
        v.add_agent(agent_pk(), U128(ONE_NEAR), "x".to_string());
    }

    #[test]
    #[should_panic(expected = "PROBARION:NotOwner")]
    fn only_the_owner_removes_agents() {
        let mut v = setup_with_agent();
        as_account(approver(), T0);
        v.remove_agent(agent_pk());
    }

    #[test]
    #[should_panic(expected = "PROBARION:NotOwner")]
    fn remove_agent_checks_the_owner_before_the_one_yocto_check() {
        let mut v = setup_with_agent();
        set_ctx(approver(), pk(200), yocto(0), T0);
        v.remove_agent(agent_pk());
    }

    #[test]
    #[should_panic(expected = "PROBARION:NotOwner")]
    fn set_ledger_key_checks_the_owner_before_the_one_yocto_check() {
        let mut v = setup();
        set_ctx(approver(), pk(200), yocto(0), T0);
        v.set_ledger_key(ledger_pk(), U128(ONE_NEAR));
    }

    #[test]
    #[should_panic(expected = "PROBARION:InvalidInput")]
    fn the_ledger_key_cannot_become_an_agent_key() {
        let mut v = setup();
        as_owner(ONE_YOCTO);
        v.set_ledger_key(ledger_pk(), U128(ONE_NEAR));
        as_owner(ONE_YOCTO);
        v.add_agent(ledger_pk(), U128(ONE_NEAR), "x".to_string());
    }

    #[test]
    #[should_panic(expected = "PROBARION:InvalidInput")]
    fn a_zero_allowance_is_refused() {
        let mut v = setup();
        as_owner(ONE_YOCTO);
        v.add_agent(agent_pk(), U128(0), "x".to_string());
    }

    #[test]
    #[should_panic(expected = "PROBARION:InvalidInput")]
    fn the_same_agent_key_cannot_be_added_twice() {
        let mut v = setup_with_agent();
        as_owner(ONE_YOCTO);
        v.add_agent(agent_pk(), U128(ONE_NEAR), "again".to_string());
    }

    #[test]
    #[should_panic(expected = "PROBARION:InvalidInput")]
    fn an_agent_label_over_64_bytes_is_refused() {
        let mut v = setup();
        as_owner(ONE_YOCTO);
        v.add_agent(agent_pk(), U128(ONE_NEAR), "x".repeat(65));
    }

    #[test]
    #[should_panic(expected = "PROBARION:InvalidInput")]
    fn at_most_sixteen_agents() {
        let mut v = setup();
        as_owner(ONE_YOCTO);
        for n in 0..=16u8 {
            v.add_agent(pk(100 + n), U128(ONE_NEAR), "a".to_string());
        }
    }

    #[test]
    fn remove_agent_deletes_the_key() {
        let mut v = setup_with_agent();
        as_owner(ONE_YOCTO);
        v.remove_agent(agent_pk());
        assert_eq!(deleted_keys(), vec![(vault_id(), agent_pk())]);
        assert!(v.list_agents().is_empty());
        assert_eq!(last_event()["event"], "agent_removed");
        assert_eq!(last_event()["data"]["label"], "agent");
    }

    #[test]
    #[should_panic(expected = "PROBARION:InvalidInput")]
    fn removing_an_unknown_key_is_refused() {
        let mut v = setup();
        as_owner(ONE_YOCTO);
        v.remove_agent(agent_pk());
    }

    #[test]
    fn ledger_key_is_anchor_only_and_replacing_it_deletes_the_old_one() {
        let mut v = setup();
        as_owner(ONE_YOCTO);
        v.set_ledger_key(ledger_pk(), U128(ONE_NEAR));
        assert_eq!(
            added_keys(),
            vec![(
                vault_id(),
                ledger_pk(),
                Some(yocto(ONE_NEAR)),
                vault_id(),
                vec!["anchor".to_string()]
            )]
        );
        assert_eq!(v.get_config().ledger_key, Some(ledger_pk()));
        assert_eq!(last_event()["event"], "ledger_key_set");
        as_owner(ONE_YOCTO);
        v.set_ledger_key(pk(10), U128(ONE_NEAR));
        assert_eq!(deleted_keys(), vec![(vault_id(), ledger_pk())]);
        assert_eq!(added_keys()[0].1, pk(10));
        assert_eq!(v.get_config().ledger_key, Some(pk(10)));
    }

    #[test]
    fn a_first_ledger_key_is_one_add_key_receipt_and_nothing_is_deleted() {
        let mut v = setup();
        as_owner(ONE_YOCTO);
        v.set_ledger_key(ledger_pk(), U128(ONE_NEAR));
        assert_eq!(
            receipts(),
            vec![(
                vault_id(),
                vec![],
                vec![fc_key(ledger_pk(), ONE_NEAR, "anchor")]
            )]
        );
        assert_eq!(v.get_config().ledger_key, Some(ledger_pk()));
    }

    #[test]
    fn replacing_the_ledger_key_adds_and_deletes_in_two_independent_receipts() {
        // The stuck state: ledger_key is set, but its AddKey failed (for example LackBalanceForState)
        // so the access key does not exist. DeleteKey of it then fails, and a failed action rolls back
        // its whole receipt. The AddKey of the new key must therefore not share that receipt, and
        // neither receipt may wait on the other.
        let mut v = setup();
        as_owner(ONE_YOCTO);
        v.set_ledger_key(ledger_pk(), U128(ONE_NEAR));
        as_owner(ONE_YOCTO);
        v.set_ledger_key(pk(10), U128(2 * ONE_NEAR));
        assert_eq!(
            receipts(),
            vec![
                (
                    vault_id(),
                    vec![],
                    vec![fc_key(pk(10), 2 * ONE_NEAR, "anchor")]
                ),
                (vault_id(), vec![], vec![KeyAction::Delete(ledger_pk())]),
            ]
        );
        assert_eq!(v.get_config().ledger_key, Some(pk(10)));
        assert_eq!(
            last_event(),
            json!({"standard": "probarion", "version": "1.0.0", "event": "ledger_key_set",
                   "data": {"public_key": pk(10)}})
        );
        // A third rotation is the same shape: only the key it replaces is deleted.
        as_owner(ONE_YOCTO);
        v.set_ledger_key(pk(11), U128(ONE_NEAR));
        assert_eq!(
            receipts(),
            vec![
                (vault_id(), vec![], vec![fc_key(pk(11), ONE_NEAR, "anchor")]),
                (vault_id(), vec![], vec![KeyAction::Delete(pk(10))]),
            ]
        );
    }

    #[test]
    fn add_agent_and_remove_agent_each_schedule_one_single_action_receipt() {
        // The registry change commits with the call; the key action has a receipt of its own. So a
        // remove_agent whose key is already gone still clears the registry, and add_agent can then
        // add the key again.
        let mut v = setup();
        as_owner(ONE_YOCTO);
        v.add_agent(agent_pk(), U128(ONE_NEAR), "a".to_string());
        assert_eq!(
            receipts(),
            vec![(
                vault_id(),
                vec![],
                vec![fc_key(agent_pk(), ONE_NEAR, "spend")]
            )]
        );
        as_owner(ONE_YOCTO);
        v.remove_agent(agent_pk());
        assert_eq!(
            receipts(),
            vec![(vault_id(), vec![], vec![KeyAction::Delete(agent_pk())])]
        );
        assert!(v.list_agents().is_empty());
        as_owner(ONE_YOCTO);
        v.add_agent(agent_pk(), U128(ONE_NEAR), "again".to_string());
        assert_eq!(
            receipts(),
            vec![(
                vault_id(),
                vec![],
                vec![fc_key(agent_pk(), ONE_NEAR, "spend")]
            )]
        );
    }

    #[test]
    #[should_panic(expected = "PROBARION:InvalidInput")]
    fn an_agent_key_cannot_become_the_ledger_key() {
        let mut v = setup_with_agent();
        as_owner(ONE_YOCTO);
        v.set_ledger_key(agent_pk(), U128(ONE_NEAR));
    }

    #[test]
    #[should_panic(expected = "PROBARION:NotOwner")]
    fn only_the_owner_sets_the_ledger_key() {
        let mut v = setup();
        as_account(approver(), T0);
        v.set_ledger_key(ledger_pk(), U128(ONE_NEAR));
    }

    #[test]
    fn key_changes_require_exactly_one_yocto() {
        assert_requires_one_yocto(owner(), T0, setup, |v| {
            v.add_agent(agent_pk(), U128(ONE_NEAR), "a".to_string())
        });
        assert_requires_one_yocto(owner(), T0, setup_with_agent, |v| {
            v.remove_agent(agent_pk())
        });
        assert_requires_one_yocto(owner(), T0, setup, |v| {
            v.set_ledger_key(ledger_pk(), U128(ONE_NEAR))
        });
    }

    #[test]
    #[should_panic(expected = "PROBARION:RequiresOneYocto")]
    fn a_dapp_login_key_of_the_owner_cannot_add_an_agent() {
        // A Function-Call key cannot attach a deposit, so the call arrives with 0 yoctoNEAR.
        let mut v = setup();
        as_owner(yocto(0));
        v.add_agent(agent_pk(), U128(ONE_NEAR), "x".to_string());
    }
}
