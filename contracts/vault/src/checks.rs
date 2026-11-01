//! The one spend check shared by `spend` and the `check_spend` view (interfaces §4.2).
use crate::validate::{is_hex64, is_ref};
use crate::*;

/// What a passing check hands to `spend`.
pub struct Approved {
    pub mandate_idx: u32,
    pub hold: bool,
    pub day: u64,
}

impl Vault {
    /// Preconditions: the signer is an agent (`NotAgent`) and the request is well formed
    /// (`InvalidInput`). Then, in order: frozen, mandate exists, active, not expired, agent
    /// matches, amount > 0, <= per-payment, uses left, spent + reserved + amount <= total,
    /// invoice unused, ref unused, daily backstop.
    pub fn evaluate(
        &self,
        req: &SpendRequest,
        signer_pk: &PublicKey,
        now: u64,
    ) -> Result<Approved, ErrorCode> {
        if !self.is_agent(signer_pk) {
            return Err(ErrorCode::NotAgent);
        }
        if !is_hex64(&req.invoice_hash) || !is_hex64(&req.decision_hash) || !is_ref(&req.r#ref) {
            return Err(ErrorCode::InvalidInput);
        }
        if self.frozen {
            return Err(ErrorCode::Frozen);
        }
        let mandate_idx = Self::position(req.mandate_id).ok_or(ErrorCode::NoMandate)?;
        let m = self.mandates.get(mandate_idx).ok_or(ErrorCode::NoMandate)?;
        if m.revoked {
            return Err(ErrorCode::MandateInactive);
        }
        if now >= m.expires_at_ns {
            return Err(ErrorCode::MandateExpired);
        }
        if m.agent_pk != *signer_pk {
            return Err(ErrorCode::NotMandateAgent);
        }
        let amount = req.amount.0;
        if amount == 0 {
            return Err(ErrorCode::ZeroAmount);
        }
        if amount > m.max_per_payment {
            return Err(ErrorCode::OverPerPayment);
        }
        if m.uses >= m.max_uses {
            return Err(ErrorCode::UsesExhausted);
        }
        if m.spent.saturating_add(m.reserved).saturating_add(amount) > m.max_total {
            return Err(ErrorCode::OverMandateTotal);
        }
        if self.invoices.contains_key(&req.invoice_hash) {
            return Err(ErrorCode::DuplicateInvoice);
        }
        if self.refs.contains(&req.r#ref) {
            return Err(ErrorCode::DuplicateRef);
        }
        let day = now / DAY_NS;
        if self.day_total_on(day).saturating_add(amount) > self.daily_backstop {
            return Err(ErrorCode::OverDailyBackstop);
        }
        Ok(Approved {
            mandate_idx,
            hold: amount > m.approval_above,
            day,
        })
    }

    /// Amount reserved or paid in UTC day `day` (`block_timestamp / DAY_NS`).
    pub fn day_total_on(&self, day: u64) -> u128 {
        if self.day_bucket == day {
            self.day_total
        } else {
            0
        }
    }
}

#[near]
impl Vault {
    /// Free dry run of `spend` for `signer_pk`. No state change.
    pub fn check_spend(&self, request: SpendRequest, signer_pk: PublicKey) -> Verdict {
        match self.evaluate(&request, &signer_pk, env::block_timestamp()) {
            Ok(approved) => Verdict {
                ok: true,
                code: None,
                would_hold: approved.hold,
            },
            Err(code) => Verdict {
                ok: false,
                code: Some(code.as_str().to_string()),
                would_hold: false,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::test_utils::*;
    use crate::*;

    fn code_of(c: Case) -> String {
        check(c).code.expect("a refusal")
    }

    macro_rules! verdict_is {
        ($($name:ident: $code:ident,)*) => {$(
            #[test]
            fn $name() {
                assert_eq!(
                    check(case(ErrorCode::$code)),
                    Verdict { ok: false, code: Some(stringify!($code).to_string()), would_hold: false }
                );
            }
        )*};
    }

    verdict_is! {
        refuses_an_unknown_signer_key: NotAgent,
        refuses_a_malformed_request: InvalidInput,
        refuses_while_frozen: Frozen,
        refuses_a_missing_mandate: NoMandate,
        refuses_a_revoked_mandate: MandateInactive,
        refuses_an_expired_mandate: MandateExpired,
        refuses_another_agents_mandate: NotMandateAgent,
        refuses_a_zero_amount: ZeroAmount,
        refuses_over_the_per_payment_cap: OverPerPayment,
        refuses_when_uses_are_exhausted: UsesExhausted,
        refuses_over_the_mandate_total: OverMandateTotal,
        refuses_a_duplicate_invoice: DuplicateInvoice,
        refuses_a_duplicate_ref: DuplicateRef,
        refuses_over_the_daily_backstop: OverDailyBackstop,
    }

    #[test]
    fn a_valid_request_passes_without_hold() {
        assert_eq!(
            check(ok_case()),
            Verdict {
                ok: true,
                code: None,
                would_hold: false
            }
        );
    }

    #[test]
    fn an_amount_above_the_threshold_would_hold() {
        let mut c = ok_case();
        as_owner(NearToken::from_near(1));
        let id = c.v.create_mandate(held_input());
        c.req = req(id, 50 * USDC + 1, 1);
        assert_eq!(
            check(c),
            Verdict {
                ok: true,
                code: None,
                would_hold: true
            }
        );
    }

    #[test]
    fn an_amount_equal_to_the_threshold_does_not_hold() {
        let mut c = ok_case();
        as_owner(NearToken::from_near(1));
        let id = c.v.create_mandate(held_input());
        c.req = req(id, 50 * USDC, 1);
        assert_eq!(
            check(c),
            Verdict {
                ok: true,
                code: None,
                would_hold: false
            }
        );
    }

    #[test]
    fn check_spend_changes_no_state() {
        let Case {
            v,
            req,
            signer,
            now,
        } = ok_case();
        as_agent(signer.clone(), now);
        assert!(v.check_spend(req.clone(), signer.clone()).ok);
        assert!(v.check_spend(req, signer).ok);
        assert_eq!(v.get_mandate(1).unwrap().reserved, U128(0));
        assert_eq!(v.spends.len(), 0);
    }

    // Check order: when two checks fail, the earlier one is reported.
    #[test]
    fn the_caller_rule_comes_before_request_shape() {
        let mut c = case(ErrorCode::InvalidInput);
        c.signer = pk(77);
        assert_eq!(code_of(c), "NotAgent");
    }
    #[test]
    fn request_shape_comes_before_frozen() {
        let mut c = case(ErrorCode::Frozen);
        c.req.r#ref = String::new();
        assert_eq!(code_of(c), "InvalidInput");
    }
    #[test]
    fn frozen_comes_before_a_missing_mandate() {
        let mut c = case(ErrorCode::Frozen);
        c.req.mandate_id = 99;
        assert_eq!(code_of(c), "Frozen");
    }
    #[test]
    fn a_missing_mandate_comes_before_everything_mandate_specific() {
        let mut c = case(ErrorCode::NoMandate);
        c.req.amount = U128(0);
        assert_eq!(code_of(c), "NoMandate");
    }
    #[test]
    fn revoked_comes_before_expired() {
        let mut c = case(ErrorCode::MandateInactive);
        c.now = T0 + 30 * DAY_NS;
        assert_eq!(code_of(c), "MandateInactive");
    }
    #[test]
    fn expired_comes_before_agent_mismatch() {
        let mut c = case(ErrorCode::NotMandateAgent);
        c.now = T0 + 30 * DAY_NS;
        assert_eq!(code_of(c), "MandateExpired");
    }
    #[test]
    fn agent_mismatch_comes_before_zero_amount() {
        let mut c = case(ErrorCode::NotMandateAgent);
        c.req.amount = U128(0);
        assert_eq!(code_of(c), "NotMandateAgent");
    }
    #[test]
    fn zero_amount_comes_before_a_duplicate_invoice() {
        let mut c = case(ErrorCode::DuplicateInvoice);
        c.req.amount = U128(0);
        assert_eq!(code_of(c), "ZeroAmount");
    }
    #[test]
    fn per_payment_comes_before_uses() {
        let mut c = case(ErrorCode::UsesExhausted);
        c.req.amount = U128(100 * USDC + 1);
        assert_eq!(code_of(c), "OverPerPayment");
    }
    #[test]
    fn uses_come_before_the_total() {
        let mut c = case(ErrorCode::OverMandateTotal);
        c.v.mandates.get_mut(0).unwrap().uses = 10;
        assert_eq!(code_of(c), "UsesExhausted");
    }
    #[test]
    fn the_total_comes_before_a_duplicate_invoice() {
        let mut c = case(ErrorCode::DuplicateInvoice);
        c.v.mandates.get_mut(0).unwrap().spent = 995 * USDC;
        assert_eq!(code_of(c), "OverMandateTotal");
    }
    #[test]
    fn a_duplicate_invoice_comes_before_a_duplicate_ref() {
        let mut c = case(ErrorCode::DuplicateRef);
        c.v.invoices.insert(hex(1), 9);
        assert_eq!(code_of(c), "DuplicateInvoice");
    }
    #[test]
    fn a_duplicate_ref_comes_before_the_daily_backstop() {
        let mut c = case(ErrorCode::OverDailyBackstop);
        c.v.refs.insert("INV-1".to_string());
        assert_eq!(code_of(c), "DuplicateRef");
    }
    #[test]
    fn the_backstop_counts_only_the_current_utc_day() {
        let mut c = case(ErrorCode::OverDailyBackstop);
        c.v.day_bucket -= 1;
        assert!(check(c).ok);
    }

    // Beyond the brief's list (see the task report).
    // The brief chains Zero < DuplicateInvoice and PerPayment < Uses, which would still pass if
    // the zero-amount check sat after the uses check. Interfaces v2 puts it before.
    #[test]
    fn zero_amount_comes_before_exhausted_uses() {
        let mut c = case(ErrorCode::UsesExhausted);
        c.req.amount = U128(0);
        assert_eq!(code_of(c), "ZeroAmount");
    }
    #[test]
    fn reserved_amounts_count_against_the_total() {
        let mut c = ok_case();
        c.v.mandates.get_mut(0).unwrap().reserved = 995 * USDC;
        assert_eq!(code_of(c), "OverMandateTotal");
    }
    #[test]
    fn amounts_exactly_at_a_limit_pass() {
        let mut c = ok_case();
        c.req.amount = U128(100 * USDC); // the per-payment cap
        assert_eq!(
            check(c),
            Verdict {
                ok: true,
                code: None,
                would_hold: false
            }
        );

        let mut c = ok_case();
        let m = c.v.mandates.get_mut(0).unwrap();
        (m.spent, m.reserved) = (900 * USDC, 90 * USDC); // + 10 USDC == the mandate total
        assert!(check(c).ok);

        let mut c = ok_case();
        c.v.mandates.get_mut(0).unwrap().uses = 9; // the last of 10 uses
        assert!(check(c).ok);

        let mut c = ok_case();
        c.v.day_bucket = (T0 + 1) / DAY_NS;
        c.v.day_total = 490 * USDC; // + 10 USDC == the daily backstop
        assert!(check(c).ok);
    }
    #[test]
    fn a_mandate_is_valid_until_the_instant_it_expires() {
        let mut c = ok_case();
        c.now = T0 + 30 * DAY_NS - 1;
        assert!(check(c).ok);
    }
    #[test]
    fn evaluate_hands_spend_the_mandate_position_the_hold_flag_and_the_utc_day() {
        let mut c = ok_case();
        let second = create(&mut c.v, held_input());
        assert_eq!(second, 2);
        as_agent(c.signer.clone(), c.now);
        let held =
            c.v.evaluate(&req(second, 50 * USDC + 1, 1), &c.signer, c.now)
                .unwrap();
        assert_eq!(
            (held.mandate_idx, held.hold, held.day),
            (1, true, (T0 + 1) / DAY_NS)
        );
        let plain =
            c.v.evaluate(&req(1, 10 * USDC, 1), &c.signer, c.now)
                .unwrap();
        assert_eq!((plain.mandate_idx, plain.hold), (0, false));
    }
    #[test]
    fn check_spend_judges_the_key_it_is_given_not_the_caller() {
        let Case {
            v,
            req,
            signer,
            now,
        } = ok_case();
        as_anyone(now);
        assert!(v.check_spend(req.clone(), signer).ok);
        assert_eq!(v.check_spend(req, pk(77)).code.as_deref(), Some("NotAgent"));
    }
}
