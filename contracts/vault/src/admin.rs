//! Owner controls that work without Probarion's servers: freeze, and withdraw both balances.
use near_sdk::Promise;

use crate::ext::{ext_ft, ext_intents};
use crate::*;

#[near]
impl Vault {
    /// Protective, so it is the one owner method with no deposit: any key on the owner's
    /// account can stop the vault fast. `unfreeze` is the careful direction.
    pub fn freeze(&mut self) {
        self.assert_owner();
        self.frozen = true;
        VaultEvent::Frozen {
            by: env::predecessor_account_id(),
        }
        .emit();
    }

    #[payable]
    pub fn unfreeze(&mut self) {
        self.assert_owner();
        require_one_yocto();
        self.frozen = false;
        VaultEvent::Unfrozen {
            by: env::predecessor_account_id(),
        }
        .emit();
    }

    /// NEP-141 USDC back to the owner. The transfer promise is returned, so a failed
    /// transfer fails the transaction.
    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        require_one_yocto();
        if amount.0 == 0 {
            fail(ErrorCode::InvalidInput)
        }
        VaultEvent::Withdrawn {
            to: self.owner.clone(),
            token: self.usdc.clone(),
            amount,
        }
        .emit();
        ext_ft::ext(self.usdc.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(
                self.owner.clone(),
                amount,
                Some("probarion:withdraw".to_string()),
            )
    }

    /// The vault's balance of `token` inside intents back to the owner's NEAR account.
    #[payable]
    pub fn withdraw_intents(&mut self, token: AccountId, amount: U128) -> Promise {
        self.assert_owner();
        require_one_yocto();
        if amount.0 == 0 {
            fail(ErrorCode::InvalidInput)
        }
        VaultEvent::Withdrawn {
            to: self.owner.clone(),
            token: token.clone(),
            amount,
        }
        .emit();
        ext_intents::ext(self.intents.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FT_WITHDRAW)
            .ft_withdraw(token, self.owner.clone(), amount, None, None)
    }
}

#[cfg(test)]
mod tests {
    use crate::test_utils::*;
    use crate::*;
    use near_sdk::serde_json::json;

    #[test]
    fn freeze_and_unfreeze_flip_the_flag_and_emit() {
        let mut v = setup();
        as_owner(yocto(0));
        v.freeze();
        assert!(v.get_config().frozen);
        assert_eq!(
            last_event(),
            json!({"standard": "probarion", "version": "1.0.0", "event": "frozen", "data": {"by": "owner.near"}})
        );
        as_owner(ONE_YOCTO);
        v.unfreeze();
        assert!(!v.get_config().frozen);
        assert_eq!(last_event()["event"], "unfrozen");
    }

    #[test]
    fn a_frozen_vault_refuses_spends_until_unfrozen() {
        let mut v = setup_with_agent();
        let id = create(&mut v, near_input());
        as_owner(yocto(0));
        v.freeze();
        as_agent(agent_pk(), T0 + 1);
        assert_eq!(
            v.check_spend(req(id, USDC, 1), agent_pk()).code.as_deref(),
            Some("Frozen")
        );
        as_owner(ONE_YOCTO);
        v.unfreeze();
        as_agent(agent_pk(), T0 + 1);
        assert!(v.check_spend(req(id, USDC, 1), agent_pk()).ok);
    }

    #[test]
    #[should_panic(expected = "PROBARION:NotOwner")]
    fn only_the_owner_freezes() {
        let mut v = setup();
        as_account(approver(), T0);
        v.freeze();
    }

    #[test]
    #[should_panic(expected = "PROBARION:NotOwner")]
    fn only_the_owner_unfreezes() {
        let mut v = setup();
        as_account(approver(), T0);
        v.unfreeze();
    }

    #[test]
    fn withdraw_sends_usdc_to_the_owner_with_one_yocto() {
        let mut v = setup();
        as_owner(ONE_YOCTO);
        let _ = v.withdraw(U128(7 * USDC));
        let t = call_to("ft_transfer");
        assert_eq!(t.receiver, usdc());
        assert_eq!(
            t.args,
            json!({"receiver_id": "owner.near", "amount": "7000000", "memo": "probarion:withdraw"})
        );
        assert_eq!(t.deposit, ONE_YOCTO);
        assert_eq!(
            last_event()["data"],
            json!({"to": "owner.near", "token": "usdc.near", "amount": "7000000"})
        );
    }

    #[test]
    fn withdraw_intents_returns_the_balance_to_the_owner_without_a_memo() {
        let mut v = setup();
        as_owner(ONE_YOCTO);
        let _ = v.withdraw_intents(base_asset(), U128(3 * USDC));
        let w = call_to("ft_withdraw");
        assert_eq!(w.receiver, intents());
        assert_eq!(
            w.args,
            json!({"token": base_asset(), "receiver_id": "owner.near", "amount": "3000000", "memo": null, "msg": null})
        );
        assert_eq!(w.deposit, ONE_YOCTO);
        assert_eq!(last_event()["data"]["token"], json!(base_asset()));
    }

    #[test]
    #[should_panic(expected = "PROBARION:NotOwner")]
    fn only_the_owner_withdraws() {
        let mut v = setup();
        as_account(approver(), T0);
        let _ = v.withdraw(U128(1));
    }

    #[test]
    #[should_panic(expected = "PROBARION:NotOwner")]
    fn only_the_owner_withdraws_from_intents() {
        let mut v = setup();
        as_account(approver(), T0);
        let _ = v.withdraw_intents(base_asset(), U128(1));
    }

    #[test]
    #[should_panic(expected = "PROBARION:InvalidInput")]
    fn a_zero_withdrawal_is_refused() {
        let mut v = setup();
        as_owner(ONE_YOCTO);
        let _ = v.withdraw(U128(0));
    }

    #[test]
    fn unfreeze_and_withdrawals_require_exactly_one_yocto() {
        assert_requires_one_yocto(owner(), T0, setup, |v| v.unfreeze());
        assert_requires_one_yocto(owner(), T0, setup, |v| {
            let _ = v.withdraw(U128(USDC));
        });
        assert_requires_one_yocto(owner(), T0, setup, |v| {
            let _ = v.withdraw_intents(base_asset(), U128(USDC));
        });
    }

    #[test]
    fn freeze_is_the_exception_and_needs_no_deposit() {
        let mut v = setup();
        as_owner(yocto(0));
        v.freeze();
        assert!(v.get_config().frozen);
    }

    // Interfaces v2 §4.2: the owner check runs before the one-yocto check, so a stranger who
    // attaches nothing is told `NotOwner`, not `RequiresOneYocto`.
    #[test]
    fn the_owner_check_runs_before_the_one_yocto_check() {
        let mut v = setup();
        set_ctx(approver(), pk(200), yocto(0), T0);
        assert!(refusal(|| v.unfreeze()).contains("PROBARION:NotOwner"));
        assert!(refusal(|| {
            let _ = v.withdraw(U128(USDC));
        })
        .contains("PROBARION:NotOwner"));
        assert!(refusal(|| {
            let _ = v.withdraw_intents(base_asset(), U128(USDC));
        })
        .contains("PROBARION:NotOwner"));
    }

    #[test]
    fn the_one_yocto_check_runs_before_the_amount_check() {
        let mut v = setup();
        set_ctx(owner(), pk(200), yocto(0), T0);
        assert!(refusal(|| {
            let _ = v.withdraw(U128(0));
        })
        .contains("PROBARION:RequiresOneYocto"));
        assert!(refusal(|| {
            let _ = v.withdraw_intents(base_asset(), U128(0));
        })
        .contains("PROBARION:RequiresOneYocto"));
    }

    #[test]
    #[should_panic(expected = "PROBARION:InvalidInput")]
    fn a_zero_intents_withdrawal_is_refused() {
        let mut v = setup();
        as_owner(ONE_YOCTO);
        let _ = v.withdraw_intents(base_asset(), U128(0));
    }

    // Any key on the owner's account may freeze, e.g. a dapp-login Function-Call key: the
    // contract sees only the predecessor, and a protective call needs no deposit.
    #[test]
    fn freeze_works_from_any_owner_key_with_no_deposit() {
        let mut v = setup();
        set_ctx(owner(), pk(201), yocto(0), T0);
        v.freeze();
        assert!(v.get_config().frozen);
    }

    // Both withdrawals hand back the transfer promise itself, with nothing chained to swallow a
    // failure: one outgoing call each, and no callback.
    #[test]
    fn each_withdrawal_schedules_only_the_transfer() {
        let mut v = setup();
        as_owner(ONE_YOCTO);
        let _ = v.withdraw(U128(USDC));
        let sent = calls();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].method, "ft_transfer");

        as_owner(ONE_YOCTO);
        let _ = v.withdraw_intents(base_asset(), U128(USDC));
        let sent = calls();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].method, "ft_withdraw");
    }
}
