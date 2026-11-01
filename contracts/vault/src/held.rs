//! Held spends: no transfer until an approver approves (I5). Expiry releases the reservation.
use near_sdk::PromiseOrValue;

use crate::*;

#[near]
impl Vault {
    #[payable]
    pub fn approve(&mut self, spend_id: u64) -> PromiseOrValue<SpendResult> {
        self.assert_approver();
        require_one_yocto();
        if self.frozen {
            fail(ErrorCode::Frozen)
        }
        let spend = self.held_spend(spend_id);
        if env::block_timestamp() > spend.held_until_ns.unwrap_or(0) {
            fail(ErrorCode::HoldExpired)
        }
        if self.mandate(spend.mandate_id).is_none_or(|m| m.revoked) {
            fail(ErrorCode::MandateInactive)
        }
        VaultEvent::SpendApproved {
            spend_id,
            by: env::predecessor_account_id(),
        }
        .emit();
        PromiseOrValue::Promise(self.execute_payout(spend_id))
    }

    #[payable]
    pub fn reject(&mut self, spend_id: u64) {
        self.assert_approver();
        require_one_yocto();
        self.held_spend(spend_id);
        self.release(spend_id, SpendStatus::Rejected);
        VaultEvent::SpendRejected {
            spend_id,
            by: env::predecessor_account_id(),
        }
        .emit();
    }

    pub fn expire_held(&mut self, spend_id: u64) {
        let spend = self.held_spend(spend_id);
        if env::block_timestamp() <= spend.held_until_ns.unwrap_or(u64::MAX) {
            fail(ErrorCode::HoldNotExpired)
        }
        self.release(spend_id, SpendStatus::Expired);
        VaultEvent::SpendExpired { spend_id }.emit();
    }
}

impl Vault {
    /// Emits `spend_held` for a spend `reserve` stored as Held.
    pub(crate) fn hold(&mut self, spend_id: u64) -> SpendResult {
        let spend = self.held_spend(spend_id);
        VaultEvent::SpendHeld {
            spend_id,
            mandate_id: spend.mandate_id,
            amount: U128(spend.amount),
            invoice_hash: spend.invoice_hash,
            decision_hash: spend.decision_hash,
            held_until_ns: U64(spend.held_until_ns.unwrap_or_default()),
        }
        .emit();
        SpendResult {
            spend_id,
            status: SpendStatus::Held,
        }
    }

    fn assert_approver(&self) {
        if !self.approvers.contains(&env::predecessor_account_id()) {
            fail(ErrorCode::NotApprover)
        }
    }

    fn held_spend(&self, spend_id: u64) -> Spend {
        match self.spend_record(spend_id) {
            Some(spend) if spend.status == SpendStatus::Held => spend.clone(),
            _ => fail(ErrorCode::NotHeld),
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::test_utils::*;
    use crate::*;
    use near_sdk::PromiseOrValue;

    const HELD_UNTIL: u64 = T0 + 1 + 72 * HOUR_NS;

    /// Mandate 1 holds spends above 50 USDC; spend 1 is a held 60 USDC spend made at T0 + 1.
    fn held() -> Vault {
        let mut v = setup_with_agent();
        let id = create(&mut v, held_input());
        spend_ok(&mut v, id, 60 * USDC, 1, T0 + 1);
        v
    }

    #[test]
    fn a_spend_above_the_threshold_is_held_with_no_payout() {
        let mut v = setup_with_agent();
        let id = create(&mut v, held_input());
        as_agent(agent_pk(), T0 + 1);
        match v.spend(req(id, 60 * USDC, 1)) {
            PromiseOrValue::Value(r) => assert_eq!(
                r,
                SpendResult {
                    spend_id: 1,
                    status: SpendStatus::Held
                }
            ),
            PromiseOrValue::Promise(_) => panic!("a held spend must not pay"),
        }
        assert!(calls().is_empty());
        let s = v.get_spend(1).unwrap();
        assert_eq!(
            (s.status, s.held_until_ns),
            (SpendStatus::Held, Some(U64(HELD_UNTIL)))
        );
        assert_eq!(v.get_mandate(id).unwrap().reserved, U128(60 * USDC));
        let e = last_event();
        assert_eq!(e["event"], "spend_held");
        assert_eq!(e["data"]["held_until_ns"], HELD_UNTIL.to_string());
    }

    #[test]
    fn an_approver_approval_pays_out_and_then_settles() {
        let mut v = held();
        as_account(approver(), T0 + 2);
        assert!(matches!(v.approve(1), PromiseOrValue::Promise(_)));
        assert_eq!(call_to("ft_transfer").args["amount"], "60000000");
        let names: Vec<String> = events()
            .iter()
            .map(|e| e["event"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, vec!["spend_approved", "spend_submitted"]);
        assert_eq!(v.get_spend(1).unwrap().status, SpendStatus::Pending);
        assert_eq!(resolve_transfer(&mut v, 1, true).status, SpendStatus::Paid);
    }

    #[test]
    fn approval_at_the_exact_expiry_instant_is_allowed() {
        let mut v = held();
        as_account(approver(), HELD_UNTIL);
        assert!(matches!(v.approve(1), PromiseOrValue::Promise(_)));
    }

    #[test]
    #[should_panic(expected = "PROBARION:HoldExpired")]
    fn approval_after_expiry_is_refused() {
        let mut v = held();
        as_account(approver(), HELD_UNTIL + 1);
        let _ = v.approve(1);
    }

    #[test]
    #[should_panic(expected = "PROBARION:NotApprover")]
    fn the_owner_is_not_an_approver() {
        let mut v = held();
        as_account(owner(), T0 + 2);
        let _ = v.approve(1);
    }

    #[test]
    #[should_panic(expected = "PROBARION:NotApprover")]
    fn the_vault_itself_cannot_approve() {
        let mut v = held();
        as_agent(agent_pk(), T0 + 2);
        let _ = v.approve(1);
    }

    #[test]
    #[should_panic(expected = "PROBARION:NotHeld")]
    fn a_pending_spend_cannot_be_approved() {
        let mut v = setup_with_agent();
        let id = create(&mut v, near_input());
        spend_ok(&mut v, id, USDC, 1, T0 + 1);
        as_account(approver(), T0 + 2);
        let _ = v.approve(1);
    }

    #[test]
    #[should_panic(expected = "PROBARION:NotHeld")]
    fn a_missing_spend_cannot_be_approved() {
        let mut v = held();
        as_account(approver(), T0 + 2);
        let _ = v.approve(2);
    }

    #[test]
    #[should_panic(expected = "PROBARION:Frozen")]
    fn approval_while_frozen_is_refused() {
        let mut v = held();
        v.frozen = true;
        as_account(approver(), T0 + 2);
        let _ = v.approve(1);
    }

    #[test]
    #[should_panic(expected = "PROBARION:MandateInactive")]
    fn approval_after_revocation_is_refused() {
        let mut v = held();
        as_owner(ONE_YOCTO);
        v.revoke_mandate(1);
        as_account(approver(), T0 + 2);
        let _ = v.approve(1);
    }

    #[test]
    fn reject_releases_the_reservation_even_after_revocation() {
        let mut v = held();
        as_owner(ONE_YOCTO);
        v.revoke_mandate(1);
        as_account(approver(), T0 + 2);
        v.reject(1);
        let m = v.get_mandate(1).unwrap();
        assert_eq!((m.reserved, m.uses), (U128(0), 0));
        assert_eq!(v.get_spend(1).unwrap().status, SpendStatus::Rejected);
        assert_eq!(last_event()["event"], "spend_rejected");
        assert_eq!(last_event()["data"]["by"], "approver.near");
    }

    #[test]
    #[should_panic(expected = "PROBARION:NotApprover")]
    fn only_an_approver_rejects() {
        let mut v = held();
        as_account(owner(), T0 + 2);
        v.reject(1);
    }

    // probarion-claim: ONE-YOCTO
    #[test]
    fn approve_and_reject_require_exactly_one_yocto() {
        assert_requires_one_yocto(approver(), T0 + 2, held, |v| {
            let _ = v.approve(1);
        });
        assert_requires_one_yocto(approver(), T0 + 2, held, |v| v.reject(1));
    }

    #[test]
    #[should_panic(expected = "PROBARION:HoldNotExpired")]
    fn expiry_at_the_exact_instant_is_refused() {
        let mut v = held();
        as_anyone(HELD_UNTIL);
        v.expire_held(1);
    }

    #[test]
    fn anyone_expires_a_hold_after_its_ttl() {
        let mut v = held();
        as_anyone(HELD_UNTIL + 1);
        v.expire_held(1);
        assert_eq!(v.get_spend(1).unwrap().status, SpendStatus::Expired);
        assert_eq!(v.get_mandate(1).unwrap().reserved, U128(0));
        assert_eq!(last_event()["event"], "spend_expired");
    }

    #[test]
    fn an_expired_spend_releases_its_invoice_but_keeps_its_ref_consumed() {
        let mut v = held();
        as_anyone(HELD_UNTIL + 1);
        v.expire_held(1);
        as_agent(agent_pk(), HELD_UNTIL + 2);
        assert_eq!(
            v.check_spend(req(1, 60 * USDC, 1), agent_pk())
                .code
                .as_deref(),
            Some("DuplicateRef")
        );
        let mut retry = req(1, 60 * USDC, 1);
        retry.r#ref = "INV-1-after-expiry".to_string();
        assert!(v.check_spend(retry, agent_pk()).ok);
    }

    #[test]
    #[should_panic(expected = "PROBARION:NotHeld")]
    fn a_rejected_spend_cannot_be_expired() {
        let mut v = held();
        as_account(approver(), T0 + 2);
        v.reject(1);
        as_anyone(HELD_UNTIL + 1);
        v.expire_held(1);
    }

    #[test]
    fn a_rejected_invoice_can_be_resubmitted_with_a_new_ref_but_not_the_old_one() {
        let mut v = held();
        as_account(approver(), T0 + 2);
        v.reject(1);
        as_agent(agent_pk(), T0 + 3);
        assert_eq!(
            v.check_spend(req(1, 60 * USDC, 1), agent_pk())
                .code
                .as_deref(),
            Some("DuplicateRef")
        );
        let mut again = req(1, 60 * USDC, 1);
        again.r#ref = "INV-1-b".to_string();
        assert_eq!(
            v.check_spend(again, agent_pk()),
            Verdict {
                ok: true,
                code: None,
                would_hold: true
            }
        );
    }

    // The tests below go beyond the brief: they pin gaps the brief's tests leave open.

    #[test]
    fn the_approver_check_runs_before_the_one_yocto_check() {
        // A non-approver with no deposit is told NotApprover, not RequiresOneYocto.
        for who in [owner(), vault_id(), acc("anyone.near")] {
            let mut v = held();
            set_ctx(who.clone(), pk(200), yocto(0), T0 + 2);
            let text = refusal(|| {
                let _ = v.approve(1);
            });
            assert!(
                text.contains("PROBARION:NotApprover"),
                "approve by {who}: got {text:?}"
            );
            set_ctx(who.clone(), pk(200), yocto(0), T0 + 2);
            let text = refusal(|| v.reject(1));
            assert!(
                text.contains("PROBARION:NotApprover"),
                "reject by {who}: got {text:?}"
            );
            assert_eq!(v.get_spend(1).unwrap().status, SpendStatus::Held);
        }
    }

    #[test]
    fn a_refused_approval_changes_nothing() {
        let mut v = held();
        v.frozen = true;
        as_account(approver(), T0 + 2);
        let text = refusal(|| {
            let _ = v.approve(1);
        });
        assert!(text.contains("PROBARION:Frozen"), "got {text:?}");
        assert!(calls().is_empty(), "nothing may be scheduled");
        assert_eq!(v.get_spend(1).unwrap().status, SpendStatus::Held);
        assert_eq!(v.get_mandate(1).unwrap().reserved, U128(60 * USDC));
    }

    #[test]
    fn a_held_spend_consumes_its_invoice_and_ref_and_counts_toward_the_day() {
        let v = held();
        let m = v.get_mandate(1).unwrap();
        assert_eq!((m.reserved, m.spent, m.uses), (U128(60 * USDC), U128(0), 1));
        assert_eq!(v.day_total_on(T0 / DAY_NS), 60 * USDC);
        as_agent(agent_pk(), T0 + 2);
        let mut same_invoice = req(1, USDC, 1);
        same_invoice.r#ref = "INV-other".to_string();
        assert_eq!(
            v.check_spend(same_invoice, agent_pk()).code.as_deref(),
            Some("DuplicateInvoice")
        );
        let mut same_ref = req(1, USDC, 2);
        same_ref.r#ref = "INV-1".to_string();
        assert_eq!(
            v.check_spend(same_ref, agent_pk()).code.as_deref(),
            Some("DuplicateRef")
        );
    }

    #[test]
    fn an_amount_equal_to_the_threshold_is_not_held() {
        let mut v = setup_with_agent();
        let id = create(&mut v, held_input());
        as_agent(agent_pk(), T0 + 1);
        assert!(matches!(
            v.spend(req(id, 50 * USDC, 1)),
            PromiseOrValue::Promise(_)
        ));
        assert_eq!(v.get_spend(1).unwrap().status, SpendStatus::Pending);
        assert_eq!(v.get_spend(1).unwrap().held_until_ns, None);
    }

    #[test]
    fn approval_keeps_the_reservation_until_the_callback_settles_it() {
        let mut v = held();
        as_account(approver(), T0 + 2);
        let _ = v.approve(1);
        let m = v.get_mandate(1).unwrap();
        assert_eq!((m.reserved, m.spent, m.uses), (U128(60 * USDC), U128(0), 1));
        resolve_transfer(&mut v, 1, true);
        let m = v.get_mandate(1).unwrap();
        assert_eq!((m.reserved, m.spent, m.uses), (U128(0), U128(60 * USDC), 1));
    }

    #[test]
    fn a_failed_payout_after_approval_releases_the_reservation() {
        let mut v = held();
        as_account(approver(), T0 + 2);
        let _ = v.approve(1);
        assert_eq!(
            resolve_transfer(&mut v, 1, false).status,
            SpendStatus::Failed
        );
        let m = v.get_mandate(1).unwrap();
        assert_eq!((m.reserved, m.spent, m.uses), (U128(0), U128(0), 0));
    }

    #[test]
    fn approval_events_carry_the_approver_and_the_held_data() {
        let mut v = held();
        as_account(approver(), T0 + 2);
        let _ = v.approve(1);
        let approved = events().into_iter().next().unwrap();
        assert_eq!(approved["event"], "spend_approved");
        assert_eq!(
            approved["data"],
            near_sdk::serde_json::json!({"spend_id": 1, "by": "approver.near"})
        );
        let held_event = {
            let mut v = setup_with_agent();
            let id = create(&mut v, held_input());
            spend_ok(&mut v, id, 60 * USDC, 1, T0 + 1);
            last_event()
        };
        assert_eq!(
            held_event["data"],
            near_sdk::serde_json::json!({
                "spend_id": 1, "mandate_id": 1, "amount": "60000000",
                "invoice_hash": hex(1), "decision_hash": hex(101),
                "held_until_ns": HELD_UNTIL.to_string()
            })
        );
    }

    #[test]
    fn a_second_approval_is_refused_once_the_payout_is_pending_or_settled() {
        let mut v = held();
        as_account(approver(), T0 + 2);
        let _ = v.approve(1);
        for settled in [false, true] {
            if settled {
                resolve_transfer(&mut v, 1, true);
            }
            as_account(approver(), T0 + 3);
            let text = refusal(|| {
                let _ = v.approve(1);
            });
            assert!(text.contains("PROBARION:NotHeld"), "got {text:?}");
            assert!(calls().is_empty(), "no second payout may be scheduled");
        }
        assert_eq!(v.get_spend(1).unwrap().status, SpendStatus::Paid);
    }

    #[test]
    fn a_rejected_or_expired_spend_cannot_be_paid_out_or_approved() {
        for expire in [false, true] {
            let mut v = held();
            if expire {
                as_anyone(HELD_UNTIL + 1);
                v.expire_held(1);
            } else {
                as_account(approver(), T0 + 2);
                v.reject(1);
            }
            let status = v.get_spend(1).unwrap().status;
            as_account(approver(), T0 + 3);
            let text = refusal(|| {
                let _ = v.approve(1);
            });
            assert!(
                text.contains("PROBARION:NotHeld"),
                "{status:?}: got {text:?}"
            );
            let text = refusal(|| {
                let _ = v.execute_payout(1);
            });
            assert!(
                text.contains("PROBARION:InvalidInput"),
                "{status:?}: got {text:?}"
            );
            assert!(calls().is_empty(), "{status:?}: nothing may be scheduled");
        }
    }

    #[test]
    fn a_rejected_hold_gives_back_its_use_and_its_day_share_on_the_same_day() {
        let mut v = held();
        assert_eq!(v.day_total_on(T0 / DAY_NS), 60 * USDC);
        as_account(approver(), T0 + 2);
        v.reject(1);
        assert_eq!(v.day_total_on(T0 / DAY_NS), 0);
        let m = v.get_mandate(1).unwrap();
        assert_eq!((m.reserved, m.uses), (U128(0), 0));
    }

    #[test]
    fn an_expiry_on_a_later_day_leaves_that_days_total_alone() {
        let mut v = held();
        let counted_in = T0 / DAY_NS;
        assert!(
            (HELD_UNTIL + 1) / DAY_NS > counted_in,
            "expiry must fall on a later day"
        );
        as_anyone(HELD_UNTIL + 1);
        v.expire_held(1);
        // The day the hold was counted in keeps its share; the later day starts from zero.
        assert_eq!(v.day_total_on(counted_in), 60 * USDC);
        assert_eq!(v.day_total_on((HELD_UNTIL + 1) / DAY_NS), 0);
        let m = v.get_mandate(1).unwrap();
        assert_eq!((m.reserved, m.uses), (U128(0), 0));
    }

    #[test]
    fn rejecting_and_expiring_still_work_while_frozen() {
        for expire in [false, true] {
            let mut v = held();
            v.frozen = true;
            if expire {
                as_anyone(HELD_UNTIL + 1);
                v.expire_held(1);
            } else {
                as_account(approver(), T0 + 2);
                v.reject(1);
            }
            assert_eq!(v.get_mandate(1).unwrap().reserved, U128(0));
        }
    }

    #[test]
    fn a_pending_or_missing_spend_cannot_be_rejected_or_expired() {
        let mut v = setup_with_agent();
        let id = create(&mut v, near_input());
        spend_ok(&mut v, id, USDC, 1, T0 + 1);
        for spend_id in [1, 2] {
            as_account(approver(), HELD_UNTIL + 1);
            let text = refusal(|| v.reject(spend_id));
            assert!(
                text.contains("PROBARION:NotHeld"),
                "reject {spend_id}: got {text:?}"
            );
            as_anyone(HELD_UNTIL + 1);
            let text = refusal(|| v.expire_held(spend_id));
            assert!(
                text.contains("PROBARION:NotHeld"),
                "expire {spend_id}: got {text:?}"
            );
        }
        assert_eq!(v.get_spend(1).unwrap().status, SpendStatus::Pending);
        assert_eq!(v.get_mandate(id).unwrap().reserved, U128(USDC));
    }
}
