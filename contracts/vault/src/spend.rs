//! The spend path: one shared check, reservation before any transfer, then a payout whose
//! callback settles or releases. Destinations and memos come only from mandate storage (I7).
use near_sdk::{Promise, PromiseError, PromiseOrValue};

use crate::checks::Approved;
use crate::ext::{ext_ft, ext_intents};
use crate::*;

#[near]
impl Vault {
    /// Agent key only: the vault itself signs (predecessor == vault) with a registered agent key.
    pub fn spend(&mut self, request: SpendRequest) -> PromiseOrValue<SpendResult> {
        if env::predecessor_account_id() != env::current_account_id() {
            fail(ErrorCode::NotAgent)
        }
        let signer_pk = env::signer_account_pk();
        let now = env::block_timestamp();
        let approved = match self.evaluate(&request, &signer_pk, now) {
            Ok(approved) => approved,
            Err(code) => fail(code),
        };
        let spend_id = self.reserve(request, signer_pk, now, &approved);
        PromiseOrValue::Promise(self.execute_payout(spend_id))
    }

    #[private]
    pub fn on_transfer(&mut self, spend_id: u64) -> SpendResult {
        if matches!(
            env::promise_result_checked(0, 64),
            Err(PromiseError::Failed)
        ) {
            self.fail_spend(spend_id, "ft_transfer_failed")
        } else {
            self.settle(spend_id, SpendStatus::Paid)
        }
    }

    /// `ft_withdraw` resolves to the amount withdrawn. Only an error or `"0"` releases the
    /// reservation. Any other result may mean value left the vault, so it counts as Burned.
    #[private]
    pub fn on_withdraw(&mut self, spend_id: u64) -> SpendResult {
        match env::promise_result_checked(0, 128) {
            Err(PromiseError::Failed) => self.fail_spend(spend_id, "ft_withdraw_failed"),
            Ok(bytes)
                if near_sdk::serde_json::from_slice::<U128>(&bytes).is_ok_and(|v| v.0 == 0) =>
            {
                self.fail_spend(spend_id, "ft_withdraw_refunded")
            }
            _ => self.settle(spend_id, SpendStatus::Burned),
        }
    }

    pub fn get_spend(&self, spend_id: u64) -> Option<SpendView> {
        let spend = self.spend_record(spend_id)?;
        let destination = self.mandate(spend.mandate_id)?.payee.clone();
        Some(spend.view(spend_id, destination))
    }

    pub fn list_spends(&self, from_index: u64, limit: u64) -> Vec<SpendView> {
        let end = from_index
            .saturating_add(limit.min(MAX_PAGE))
            .min(u64::from(self.spends.len()));
        (from_index..end)
            .filter_map(|i| self.get_spend(i + 1))
            .collect()
    }
}

impl Vault {
    /// Reserves before anything is sent (I2): use, amount, today's backstop share, invoice, ref.
    fn reserve(
        &mut self,
        request: SpendRequest,
        agent_pk: PublicKey,
        now: u64,
        approved: &Approved,
    ) -> u64 {
        let amount = request.amount.0;
        let spend_id = u64::from(self.spends.len()) + 1;
        let mandate = self
            .mandates
            .get_mut(approved.mandate_idx)
            .unwrap_or_else(|| fail(ErrorCode::NoMandate));
        mandate.reserved += amount;
        mandate.uses += 1;
        if self.day_bucket != approved.day {
            self.day_bucket = approved.day;
            self.day_total = 0;
        }
        self.day_total += amount;
        self.invoices.insert(request.invoice_hash.clone(), spend_id);
        self.refs.insert(request.r#ref.clone());
        self.spends.push(Spend {
            mandate_id: request.mandate_id,
            amount,
            invoice_hash: request.invoice_hash,
            r#ref: request.r#ref,
            decision_hash: request.decision_hash,
            agent_pk,
            status: SpendStatus::Pending,
            created_at_ns: now,
            held_until_ns: None,
            day: approved.day,
        });
        spend_id
    }

    /// Sends the payout for a reserved spend. The destination is read from the mandate only.
    pub(crate) fn execute_payout(&mut self, spend_id: u64) -> Promise {
        let spend = self
            .spend_record(spend_id)
            .cloned()
            .unwrap_or_else(|| fail(ErrorCode::InvalidInput));
        let payee = self
            .mandate(spend.mandate_id)
            .map(|m| m.payee.clone())
            .unwrap_or_else(|| fail(ErrorCode::NoMandate));
        if let Payee::Intents { asset, .. } = &payee {
            if !self.allowed_assets.contains(asset) {
                fail(ErrorCode::AssetNotAllowed)
            }
        }
        self.set_status(spend_id, SpendStatus::Pending);
        VaultEvent::SpendSubmitted {
            spend_id,
            mandate_id: spend.mandate_id,
            amount: U128(spend.amount),
            invoice_hash: spend.invoice_hash,
            decision_hash: spend.decision_hash,
            destination: payee.clone(),
        }
        .emit();
        let memo = payee.withdraw_memo();
        let callback = Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK);
        match payee {
            Payee::Near { account_id } => ext_ft::ext(self.usdc.clone())
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(GAS_FT_TRANSFER)
                .ft_transfer(
                    account_id,
                    U128(spend.amount),
                    Some(format!("{NEAR_MEMO_PREFIX}{spend_id}")),
                )
                .then(callback.on_transfer(spend_id)),
            Payee::Intents { asset, .. } => ext_intents::ext(self.intents.clone())
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(GAS_FT_WITHDRAW)
                .ft_withdraw(asset.clone(), asset, U128(spend.amount), memo, None)
                .then(callback.on_withdraw(spend_id)),
        }
    }

    fn settle(&mut self, spend_id: u64, status: SpendStatus) -> SpendResult {
        let spend = self
            .spend_record(spend_id)
            .cloned()
            .unwrap_or_else(|| fail(ErrorCode::InvalidInput));
        if spend.status != SpendStatus::Pending {
            return SpendResult {
                spend_id,
                status: spend.status,
            };
        }
        let mandate = self.mandate_mut(spend.mandate_id);
        mandate.reserved -= spend.amount;
        mandate.spent += spend.amount;
        let payee = mandate.payee.clone();
        self.set_status(spend_id, status);
        let amount = U128(spend.amount);
        let memo = payee.withdraw_memo();
        match (status, payee, memo) {
            (
                SpendStatus::Burned,
                Payee::Intents {
                    chain,
                    address,
                    asset,
                },
                Some(memo),
            ) => VaultEvent::SpendBurned {
                spend_id,
                mandate_id: spend.mandate_id,
                amount,
                chain,
                address,
                asset,
                memo,
            }
            .emit(),
            (_, destination, _) => VaultEvent::SpendPaid {
                spend_id,
                mandate_id: spend.mandate_id,
                amount,
                destination,
            }
            .emit(),
        }
        SpendResult { spend_id, status }
    }

    fn fail_spend(&mut self, spend_id: u64, reason: &str) -> SpendResult {
        let status = self
            .spend_record(spend_id)
            .map(|s| s.status)
            .unwrap_or_else(|| fail(ErrorCode::InvalidInput));
        if status != SpendStatus::Pending {
            return SpendResult { spend_id, status };
        }
        let spend = self.release(spend_id, SpendStatus::Failed);
        VaultEvent::SpendFailed {
            spend_id,
            mandate_id: spend.mandate_id,
            amount: U128(spend.amount),
            reason: reason.to_string(),
        }
        .emit();
        SpendResult {
            spend_id,
            status: SpendStatus::Failed,
        }
    }

    /// Gives back the reservation, the use and the invoice_hash, so a corrected retry is possible.
    /// It also gives back the backstop share, but only when the release happens in the UTC day the
    /// reservation was counted in. The ref stays consumed forever: it is an idempotency key.
    /// Only a Held or Pending spend holds a reservation, so only those can be released.
    pub(crate) fn release(&mut self, spend_id: u64, status: SpendStatus) -> Spend {
        let spend = self
            .spend_record(spend_id)
            .cloned()
            .unwrap_or_else(|| fail(ErrorCode::InvalidInput));
        if !matches!(spend.status, SpendStatus::Held | SpendStatus::Pending) {
            fail(ErrorCode::InvalidInput)
        }
        let mandate = self.mandate_mut(spend.mandate_id);
        mandate.reserved -= spend.amount;
        mandate.uses -= 1;
        let today = env::block_timestamp() / DAY_NS;
        if spend.day == today && spend.day == self.day_bucket {
            self.day_total = self.day_total.saturating_sub(spend.amount);
        }
        self.invoices.remove(&spend.invoice_hash);
        self.set_status(spend_id, status);
        spend
    }

    pub(crate) fn spend_record(&self, spend_id: u64) -> Option<&Spend> {
        Self::position(spend_id).and_then(|i| self.spends.get(i))
    }

    fn set_status(&mut self, spend_id: u64, status: SpendStatus) {
        if let Some(spend) = Self::position(spend_id).and_then(|i| self.spends.get_mut(i)) {
            spend.status = status;
        }
    }

    fn mandate_mut(&mut self, mandate_id: u64) -> &mut Mandate {
        Self::position(mandate_id)
            .and_then(|i| self.mandates.get_mut(i))
            .unwrap_or_else(|| fail(ErrorCode::NoMandate))
    }
}

#[cfg(test)]
mod tests {
    use crate::test_utils::*;
    use crate::*;
    use near_sdk::serde_json::json;
    use near_sdk::{PromiseOrValue, PromiseResult};

    macro_rules! spend_refused {
        ($($name:ident: $code:ident => $msg:literal,)*) => {$(
            #[test]
            #[should_panic(expected = $msg)]
            fn $name() {
                run_spend(case(ErrorCode::$code));
            }
        )*};
    }

    spend_refused! {
        refuses_an_unknown_signer_key: NotAgent => "PROBARION:NotAgent",
        refuses_a_malformed_request: InvalidInput => "PROBARION:InvalidInput",
        refuses_while_frozen: Frozen => "PROBARION:Frozen",
        refuses_a_missing_mandate: NoMandate => "PROBARION:NoMandate",
        refuses_a_revoked_mandate: MandateInactive => "PROBARION:MandateInactive",
        refuses_an_expired_mandate: MandateExpired => "PROBARION:MandateExpired",
        refuses_another_agents_mandate: NotMandateAgent => "PROBARION:NotMandateAgent",
        refuses_a_zero_amount: ZeroAmount => "PROBARION:ZeroAmount",
        refuses_over_the_per_payment_cap: OverPerPayment => "PROBARION:OverPerPayment",
        refuses_when_uses_are_exhausted: UsesExhausted => "PROBARION:UsesExhausted",
        refuses_over_the_mandate_total: OverMandateTotal => "PROBARION:OverMandateTotal",
        refuses_a_duplicate_invoice: DuplicateInvoice => "PROBARION:DuplicateInvoice",
        refuses_a_duplicate_ref: DuplicateRef => "PROBARION:DuplicateRef",
        refuses_over_the_daily_backstop: OverDailyBackstop => "PROBARION:OverDailyBackstop",
    }

    #[test]
    #[should_panic(expected = "PROBARION:NotAgent")]
    fn refuses_calls_not_signed_by_the_vault_itself() {
        let Case {
            mut v, req, now, ..
        } = ok_case();
        set_ctx(owner(), agent_pk(), yocto(0), now);
        let _ = v.spend(req);
    }

    // probarion-claim: I1
    #[test]
    fn no_transfer_is_scheduled_without_an_active_mandate() {
        for code in [
            ErrorCode::NoMandate,
            ErrorCode::MandateInactive,
            ErrorCode::MandateExpired,
        ] {
            let Case {
                mut v,
                req,
                signer,
                now,
            } = case(code);
            as_agent(signer, now);
            let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _ = v.spend(req);
            }));
            assert!(refused.is_err(), "{code:?}: spend must refuse");
            assert!(calls().is_empty(), "{code:?}: no transfer may be scheduled");
            assert!(
                v.list_spends(0, 10).is_empty(),
                "{code:?}: nothing may be reserved"
            );
        }
    }

    #[test]
    fn a_near_spend_reserves_then_calls_ft_transfer_with_one_yocto() {
        let mut v = setup_with_agent();
        let id = create(&mut v, near_input());
        as_agent(agent_pk(), T0 + 1);
        assert!(matches!(
            v.spend(req(id, 10 * USDC, 1)),
            PromiseOrValue::Promise(_)
        ));
        let t = call_to("ft_transfer");
        assert_eq!(t.receiver, usdc());
        assert_eq!(
            t.args,
            json!({"receiver_id": "payee.near", "amount": "10000000", "memo": "probarion:1"})
        );
        assert_eq!(t.deposit, ONE_YOCTO);
        assert!(t.gas >= GAS_FT_TRANSFER);
        assert_eq!(call_to("on_transfer").receiver, vault_id());
        let m = v.get_mandate(id).unwrap();
        assert_eq!((m.reserved, m.spent, m.uses), (U128(10 * USDC), U128(0), 1));
        let s = v.get_spend(1).unwrap();
        assert_eq!(
            (s.status, s.memo, s.agent_pk),
            (SpendStatus::Pending, None, agent_pk())
        );
        assert_eq!(last_event()["event"], "spend_submitted");
    }

    #[test]
    fn a_base_spend_calls_ft_withdraw_with_only_the_mandate_memo() {
        let mut v = setup_with_agent();
        let id = create(&mut v, base_input());
        as_agent(agent_pk(), T0 + 1);
        let _ = v.spend(req(id, 10 * USDC, 1));
        let w = call_to("ft_withdraw");
        assert_eq!(w.receiver, intents());
        assert_eq!(
            w.args,
            json!({"token": base_asset(), "receiver_id": base_asset(), "amount": "10000000",
                   "memo": format!("WITHDRAW_TO:{EVM_ADDR}"), "msg": null})
        );
        assert_eq!(w.deposit, ONE_YOCTO);
        assert!(w.gas >= GAS_FT_WITHDRAW);
        assert_eq!(call_to("on_withdraw").receiver, vault_id());
        assert_eq!(
            v.get_spend(1).unwrap().memo,
            Some(format!("WITHDRAW_TO:{EVM_ADDR}"))
        );
    }

    #[test]
    fn a_checksummed_evm_address_reaches_the_memo_byte_for_byte() {
        let mut v = setup_with_agent();
        let mut input = base_input();
        input.payee = Payee::Intents {
            chain: Chain::Base,
            address: EVM_MIXED.into(),
            asset: base_asset(),
        };
        let id = create(&mut v, input);
        spend_ok(&mut v, id, USDC, 1, T0 + 1);
        assert_eq!(
            call_to("ft_withdraw").args["memo"],
            format!("WITHDRAW_TO:{EVM_MIXED}")
        );
    }

    #[test]
    fn a_solana_spend_uses_the_solana_asset_and_address() {
        let mut v = setup_with_agent();
        let id = create(&mut v, sol_input());
        spend_ok(&mut v, id, USDC, 1, T0 + 1);
        let w = call_to("ft_withdraw");
        assert_eq!(w.args["token"], json!(sol_asset()));
        assert_eq!(w.args["memo"], format!("WITHDRAW_TO:{SOL_ADDR}"));
    }

    fn pending(input: MandateInput) -> (Vault, u64) {
        let mut v = setup_with_agent();
        let id = create(&mut v, input);
        let spend_id = spend_ok(&mut v, id, 10 * USDC, 1, T0 + 1);
        (v, spend_id)
    }

    #[test]
    fn a_successful_transfer_marks_paid_and_moves_reserved_to_spent() {
        let (mut v, s) = pending(near_input());
        assert_eq!(
            resolve_transfer(&mut v, s, true),
            SpendResult {
                spend_id: s,
                status: SpendStatus::Paid
            }
        );
        let m = v.get_mandate(1).unwrap();
        assert_eq!((m.spent, m.reserved, m.uses), (U128(10 * USDC), U128(0), 1));
        assert_eq!(
            last_event()["data"],
            json!({"spend_id": s, "mandate_id": 1, "amount": "10000000",
                   "destination": {"type": "near", "account_id": "payee.near"}})
        );
    }

    #[test]
    fn a_failed_transfer_releases_and_the_invoice_can_be_retried_with_a_new_ref() {
        let (mut v, s) = pending(near_input());
        assert_eq!(
            resolve_transfer(&mut v, s, false).status,
            SpendStatus::Failed
        );
        let m = v.get_mandate(1).unwrap();
        assert_eq!((m.spent, m.reserved, m.uses), (U128(0), U128(0), 0));
        assert_eq!(last_event()["event"], "spend_failed");
        assert_eq!(last_event()["data"]["reason"], "ft_transfer_failed");
        as_agent(agent_pk(), T0 + 3);
        let same = req(1, 10 * USDC, 1);
        assert_eq!(
            v.check_spend(same.clone(), agent_pk()).code.as_deref(),
            Some("DuplicateRef")
        );
        let mut retry = same;
        retry.r#ref = "INV-1-retry".to_string();
        assert!(v.check_spend(retry, agent_pk()).ok);
    }

    #[test]
    fn a_withdraw_returning_the_amount_marks_burned_with_the_memo_event() {
        let (mut v, s) = pending(base_input());
        let r = resolve_withdraw(
            &mut v,
            s,
            PromiseResult::Successful(b"\"10000000\"".to_vec()),
        );
        assert_eq!(r.status, SpendStatus::Burned);
        assert_eq!(v.get_mandate(1).unwrap().spent, U128(10 * USDC));
        assert_eq!(
            last_event(),
            json!({"standard": "probarion", "version": "1.0.0", "event": "spend_burned", "data": {
                "spend_id": s, "mandate_id": 1, "amount": "10000000", "chain": "base",
                "address": EVM_ADDR, "asset": base_asset(), "memo": format!("WITHDRAW_TO:{EVM_ADDR}")
            }})
        );
    }

    #[test]
    fn a_withdraw_that_fails_or_returns_zero_releases() {
        for (result, reason) in [
            (
                PromiseResult::Successful(b"\"0\"".to_vec()),
                "ft_withdraw_refunded",
            ),
            (PromiseResult::Failed, "ft_withdraw_failed"),
        ] {
            let (mut v, s) = pending(base_input());
            assert_eq!(
                resolve_withdraw(&mut v, s, result).status,
                SpendStatus::Failed
            );
            assert_eq!(v.get_mandate(1).unwrap().reserved, U128(0));
            assert_eq!(last_event()["data"]["reason"], reason);
        }
    }

    #[test]
    fn a_partial_or_unreadable_withdraw_result_never_releases() {
        for result in [
            PromiseResult::Successful(b"\"4000000\"".to_vec()),
            PromiseResult::Successful(b"not json".to_vec()),
        ] {
            let (mut v, s) = pending(base_input());
            assert_eq!(
                resolve_withdraw(&mut v, s, result).status,
                SpendStatus::Burned
            );
            let m = v.get_mandate(1).unwrap();
            assert_eq!((m.spent, m.reserved), (U128(10 * USDC), U128(0)));
        }
    }

    #[test]
    fn a_second_callback_for_a_settled_spend_changes_nothing() {
        let (mut v, s) = pending(near_input());
        resolve_transfer(&mut v, s, true);
        assert_eq!(resolve_transfer(&mut v, s, false).status, SpendStatus::Paid);
        assert_eq!(v.get_mandate(1).unwrap().spent, U128(10 * USDC));
    }

    #[test]
    fn callbacks_still_settle_while_frozen() {
        let (mut v, s) = pending(near_input());
        v.frozen = true;
        assert_eq!(resolve_transfer(&mut v, s, true).status, SpendStatus::Paid);
    }

    #[test]
    fn the_daily_backstop_resets_at_utc_midnight() {
        let mut v = setup_with_agent();
        let mut input = near_input();
        input.max_uses = 100;
        let id = create(&mut v, input);
        let midnight = (T0 / DAY_NS + 1) * DAY_NS;
        for n in 1..=5 {
            spend_ok(&mut v, id, 100 * USDC, n, midnight - 10);
        }
        as_agent(agent_pk(), midnight - 1);
        assert_eq!(
            v.check_spend(req(id, 1, 6), agent_pk()).code.as_deref(),
            Some("OverDailyBackstop")
        );
        as_agent(agent_pk(), midnight);
        assert!(v.check_spend(req(id, 100 * USDC, 6), agent_pk()).ok);
    }

    #[test]
    fn releasing_yesterdays_spend_leaves_todays_total_alone() {
        let mut v = setup_with_agent();
        let id = create(&mut v, near_input());
        let midnight = (T0 / DAY_NS + 1) * DAY_NS;
        let yesterday = spend_ok(&mut v, id, 100 * USDC, 1, midnight - 1);
        spend_ok(&mut v, id, 100 * USDC, 2, midnight + 1);
        resolve_transfer_at(&mut v, yesterday, false, midnight + 2);
        assert_eq!(v.day_total_on(midnight / DAY_NS), 100 * USDC);
    }

    #[test]
    fn a_release_after_midnight_does_not_subtract_from_the_day_it_was_counted_in() {
        let mut v = setup_with_agent();
        let id = create(&mut v, near_input());
        let midnight = (T0 / DAY_NS + 1) * DAY_NS;
        let s = spend_ok(&mut v, id, 100 * USDC, 1, midnight - 1);
        resolve_transfer_at(&mut v, s, false, midnight + 1);
        assert_eq!(v.day_total_on((midnight - 1) / DAY_NS), 100 * USDC);
        assert_eq!(v.day_total_on(midnight / DAY_NS), 0);
    }

    #[test]
    fn a_release_on_the_same_day_frees_its_backstop_share() {
        let mut v = setup_with_agent();
        let mut input = near_input();
        input.max_uses = 100;
        let id = create(&mut v, input);
        for n in 1..=5 {
            spend_ok(&mut v, id, 100 * USDC, n, T0 + 1);
        }
        as_agent(agent_pk(), T0 + 1);
        assert_eq!(
            v.check_spend(req(id, USDC, 9), agent_pk()).code.as_deref(),
            Some("OverDailyBackstop")
        );
        resolve_transfer_at(&mut v, 1, false, T0 + 2);
        as_agent(agent_pk(), T0 + 3);
        assert!(v.check_spend(req(id, 100 * USDC, 9), agent_pk()).ok);
    }

    #[test]
    fn a_paid_invoice_is_never_released_and_its_ref_stays_consumed() {
        let (mut v, s) = pending(near_input());
        resolve_transfer(&mut v, s, true);
        as_agent(agent_pk(), T0 + 3);
        let mut same_invoice = req(1, 10 * USDC, 1);
        same_invoice.r#ref = "INV-1-again".to_string();
        assert_eq!(
            v.check_spend(same_invoice, agent_pk()).code.as_deref(),
            Some("DuplicateInvoice")
        );
        let mut same_ref = req(1, 10 * USDC, 2);
        same_ref.r#ref = "INV-1".to_string();
        assert_eq!(
            v.check_spend(same_ref, agent_pk()).code.as_deref(),
            Some("DuplicateRef")
        );
    }

    #[test]
    fn list_spends_pages_by_position_and_ids_start_at_one() {
        let mut v = setup_with_agent();
        let id = create(&mut v, near_input());
        for n in 1..=3 {
            spend_ok(&mut v, id, USDC, n, T0 + 1);
        }
        let ids: Vec<u64> = v.list_spends(1, 2).iter().map(|s| s.id).collect();
        assert_eq!(ids, vec![2, 3]);
        assert!(v.get_spend(0).is_none());
        assert!(v.get_spend(4).is_none());
    }

    // The tests below go beyond the brief: they pin gaps the brief's tests leave open.

    /// The panic text of `f`, which must refuse.
    fn refusal(f: impl FnOnce()) -> String {
        let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f))
            .expect_err("the call must be refused");
        payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default()
    }

    fn scheduled() -> Vec<(AccountId, String)> {
        calls()
            .into_iter()
            .map(|c| (c.receiver, c.method))
            .collect()
    }

    #[test]
    fn a_foreign_predecessor_is_refused_as_not_agent_before_any_other_check() {
        for code in [
            ErrorCode::InvalidInput,
            ErrorCode::Frozen,
            ErrorCode::NoMandate,
            ErrorCode::OverPerPayment,
        ] {
            let Case {
                mut v,
                req,
                signer,
                now,
            } = case(code);
            set_ctx(owner(), signer, yocto(0), now);
            let text = refusal(|| {
                let _ = v.spend(req);
            });
            assert!(
                text.contains("PROBARION:NotAgent"),
                "{code:?}: got {text:?}"
            );
            assert!(calls().is_empty(), "{code:?}: nothing may be scheduled");
        }
    }

    #[test]
    fn a_near_spend_schedules_exactly_the_transfer_and_its_callback() {
        let mut v = setup_with_agent();
        let id = create(&mut v, near_input());
        as_agent(agent_pk(), T0 + 1);
        let _ = v.spend(req(id, 10 * USDC, 1));
        assert_eq!(
            scheduled(),
            vec![
                (usdc(), "ft_transfer".to_string()),
                (vault_id(), "on_transfer".to_string())
            ]
        );
        assert_eq!(actions().len(), 2, "no other action may be scheduled");
        let t = call_to("ft_transfer");
        assert_eq!((t.deposit, t.gas), (ONE_YOCTO, GAS_FT_TRANSFER));
        let cb = call_to("on_transfer");
        assert_eq!(cb.args, json!({"spend_id": 1}));
        assert_eq!((cb.deposit, cb.gas), (yocto(0), GAS_CALLBACK));
    }

    #[test]
    fn an_intents_spend_schedules_exactly_the_withdraw_and_its_callback() {
        let mut v = setup_with_agent();
        let id = create(&mut v, base_input());
        as_agent(agent_pk(), T0 + 1);
        let _ = v.spend(req(id, 10 * USDC, 1));
        assert_eq!(
            scheduled(),
            vec![
                (intents(), "ft_withdraw".to_string()),
                (vault_id(), "on_withdraw".to_string())
            ]
        );
        // Only the two function calls: in particular no AddKey and no add_public_key on intents (I8).
        assert_eq!(actions().len(), 2, "no other action may be scheduled");
        let w = call_to("ft_withdraw");
        assert_eq!((w.deposit, w.gas), (ONE_YOCTO, GAS_FT_WITHDRAW));
        let cb = call_to("on_withdraw");
        assert_eq!(cb.args, json!({"spend_id": 1}));
        assert_eq!((cb.deposit, cb.gas), (yocto(0), GAS_CALLBACK));
    }

    #[test]
    fn the_payout_asset_must_still_be_in_allowed_assets() {
        let mut v = setup_with_agent();
        let id = create(&mut v, base_input());
        v.allowed_assets.clear();
        as_agent(agent_pk(), T0 + 1);
        let text = refusal(|| {
            let _ = v.spend(req(id, USDC, 1));
        });
        assert!(text.contains("PROBARION:AssetNotAllowed"), "got {text:?}");
        assert!(calls().is_empty(), "no withdraw may be scheduled");
    }

    #[test]
    fn reservations_count_against_the_mandate_total_before_any_callback() {
        let mut v = setup_with_agent();
        let mut input = near_input();
        input.max_per_payment = U128(25 * USDC);
        input.max_total = U128(25 * USDC);
        let id = create(&mut v, input);
        spend_ok(&mut v, id, 10 * USDC, 1, T0 + 1);
        spend_ok(&mut v, id, 10 * USDC, 2, T0 + 1);
        as_agent(agent_pk(), T0 + 2);
        let verdict = v.check_spend(req(id, 10 * USDC, 3), agent_pk());
        assert_eq!(verdict.code.as_deref(), Some("OverMandateTotal"));
        let m = v.get_mandate(id).unwrap();
        assert_eq!((m.spent, m.reserved, m.uses), (U128(0), U128(20 * USDC), 2));
    }

    #[test]
    fn invoice_and_ref_are_consumed_at_reservation_before_any_callback() {
        let (v, _) = pending(near_input());
        as_agent(agent_pk(), T0 + 2);
        let mut same_invoice = req(1, USDC, 1);
        same_invoice.r#ref = "INV-other".to_string();
        let verdict = v.check_spend(same_invoice, agent_pk());
        assert_eq!(verdict.code.as_deref(), Some("DuplicateInvoice"));
        let mut same_ref = req(1, USDC, 2);
        same_ref.r#ref = "INV-1".to_string();
        assert_eq!(
            v.check_spend(same_ref, agent_pk()).code.as_deref(),
            Some("DuplicateRef")
        );
    }

    #[test]
    fn a_released_spend_gives_its_use_back_so_a_one_use_mandate_can_retry() {
        let mut v = setup_with_agent();
        let mut input = near_input();
        input.max_uses = 1;
        let id = create(&mut v, input);
        let s = spend_ok(&mut v, id, 10 * USDC, 1, T0 + 1);
        as_agent(agent_pk(), T0 + 2);
        assert_eq!(
            v.check_spend(req(id, USDC, 2), agent_pk()).code.as_deref(),
            Some("UsesExhausted")
        );
        resolve_transfer(&mut v, s, false);
        as_agent(agent_pk(), T0 + 3);
        assert!(v.check_spend(req(id, USDC, 2), agent_pk()).ok);
        assert_eq!(v.get_mandate(id).unwrap().status, MandateStatus::Active);
    }

    #[test]
    fn spend_submitted_and_spend_failed_carry_their_full_data() {
        let mut v = setup_with_agent();
        let id = create(&mut v, near_input());
        let s = spend_ok(&mut v, id, 10 * USDC, 1, T0 + 1);
        assert_eq!(
            last_event()["data"],
            json!({"spend_id": s, "mandate_id": 1, "amount": "10000000",
                   "invoice_hash": hex(1), "decision_hash": hex(101),
                   "destination": {"type": "near", "account_id": "payee.near"}})
        );
        resolve_transfer(&mut v, s, false);
        assert_eq!(
            last_event()["data"],
            json!({"spend_id": s, "mandate_id": 1, "amount": "10000000",
                   "reason": "ft_transfer_failed"})
        );
    }

    #[test]
    fn a_late_callback_cannot_revive_a_failed_spend() {
        let (mut v, s) = pending(near_input());
        resolve_transfer(&mut v, s, false);
        let again = resolve_transfer(&mut v, s, true);
        assert_eq!(
            again,
            SpendResult {
                spend_id: s,
                status: SpendStatus::Failed
            }
        );
        let m = v.get_mandate(1).unwrap();
        assert_eq!((m.spent, m.reserved, m.uses), (U128(0), U128(0), 0));
    }

    #[test]
    fn a_late_error_cannot_release_a_burned_spend() {
        let (mut v, s) = pending(base_input());
        resolve_withdraw(
            &mut v,
            s,
            PromiseResult::Successful(b"\"10000000\"".to_vec()),
        );
        let again = resolve_withdraw(&mut v, s, PromiseResult::Failed);
        assert_eq!(
            again,
            SpendResult {
                spend_id: s,
                status: SpendStatus::Burned
            }
        );
        let m = v.get_mandate(1).unwrap();
        assert_eq!((m.spent, m.reserved, m.uses), (U128(10 * USDC), U128(0), 1));
    }

    #[test]
    fn an_oversized_withdraw_result_counts_as_burned_and_never_releases() {
        let (mut v, s) = pending(base_input());
        let r = resolve_withdraw(&mut v, s, PromiseResult::Successful(vec![b'7'; 300]));
        assert_eq!(r.status, SpendStatus::Burned);
        let m = v.get_mandate(1).unwrap();
        assert_eq!((m.spent, m.reserved), (U128(10 * USDC), U128(0)));
    }

    #[test]
    fn a_successful_transfer_is_paid_even_if_its_result_is_oversized() {
        let (mut v, s) = pending(near_input());
        set_ctx_with_result(T0 + 2, PromiseResult::Successful(vec![b'7'; 300]));
        assert_eq!(v.on_transfer(s).status, SpendStatus::Paid);
    }

    #[test]
    fn a_burned_invoice_stays_consumed_and_its_ref_too() {
        let (mut v, s) = pending(base_input());
        resolve_withdraw(
            &mut v,
            s,
            PromiseResult::Successful(b"\"4000000\"".to_vec()),
        );
        as_agent(agent_pk(), T0 + 3);
        let mut same_invoice = req(1, USDC, 1);
        same_invoice.r#ref = "INV-1-again".to_string();
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
    fn callbacks_still_release_while_frozen() {
        let (mut v, s) = pending(near_input());
        v.frozen = true;
        assert_eq!(
            resolve_transfer(&mut v, s, false).status,
            SpendStatus::Failed
        );
        assert_eq!(v.get_mandate(1).unwrap().reserved, U128(0));
    }

    #[test]
    fn a_pending_spend_settles_and_releases_even_after_its_mandate_is_revoked() {
        for ok in [true, false] {
            let (mut v, s) = pending(near_input());
            as_owner(ONE_YOCTO);
            v.revoke_mandate(1);
            let r = resolve_transfer(&mut v, s, ok);
            let (status, spent) = if ok {
                (SpendStatus::Paid, 10 * USDC)
            } else {
                (SpendStatus::Failed, 0)
            };
            assert_eq!(r.status, status);
            let m = v.get_mandate(1).unwrap();
            assert_eq!(
                (m.spent, m.reserved, m.status),
                (U128(spent), U128(0), MandateStatus::Revoked)
            );
        }
    }

    #[test]
    fn a_callback_for_an_unknown_spend_is_refused() {
        let (mut v, _) = pending(near_input());
        let text = refusal(|| {
            resolve_transfer(&mut v, 99, true);
        });
        assert!(text.contains("PROBARION:InvalidInput"), "got {text:?}");
    }

    #[test]
    fn a_settled_spend_cannot_be_released() {
        let (mut v, s) = pending(near_input());
        resolve_transfer(&mut v, s, true);
        let text = refusal(|| {
            v.release(s, SpendStatus::Failed);
        });
        assert!(text.contains("PROBARION:InvalidInput"), "got {text:?}");
        let m = v.get_mandate(1).unwrap();
        assert_eq!((m.spent, m.reserved, m.uses), (U128(10 * USDC), U128(0), 1));
    }

    #[test]
    fn the_first_spend_of_a_new_day_starts_that_days_total_from_zero() {
        let mut v = setup_with_agent();
        let mut input = near_input();
        input.max_uses = 100;
        let id = create(&mut v, input);
        let midnight = (T0 / DAY_NS + 1) * DAY_NS;
        for n in 1..=5 {
            spend_ok(&mut v, id, 100 * USDC, n, midnight - 10);
        }
        assert_eq!(v.day_total_on((midnight - 10) / DAY_NS), 500 * USDC);
        spend_ok(&mut v, id, 100 * USDC, 6, midnight);
        assert_eq!(v.day_total_on(midnight / DAY_NS), 100 * USDC);
        assert_eq!(v.day_total_on((midnight - 10) / DAY_NS), 0);
    }

    #[test]
    fn a_spend_stores_the_day_it_was_counted_in() {
        let mut v = setup_with_agent();
        let id = create(&mut v, near_input());
        let midnight = (T0 / DAY_NS + 1) * DAY_NS;
        let s = spend_ok(&mut v, id, USDC, 1, midnight + 5);
        assert_eq!(v.spend_record(s).unwrap().day, midnight / DAY_NS);
    }

    #[test]
    fn get_spend_returns_the_full_view() {
        let (v, s) = pending(near_input());
        assert_eq!(
            v.get_spend(s).unwrap(),
            SpendView {
                id: 1,
                mandate_id: 1,
                amount: U128(10 * USDC),
                invoice_hash: hex(1),
                r#ref: "INV-1".to_string(),
                decision_hash: hex(101),
                agent_pk: agent_pk(),
                destination: Payee::Near {
                    account_id: payee()
                },
                status: SpendStatus::Pending,
                created_at_ns: U64(T0 + 1),
                held_until_ns: None,
                memo: None,
            }
        );
    }

    #[test]
    fn list_spends_caps_a_page_at_one_hundred() {
        let mut v = setup_with_agent();
        let mut input = near_input();
        input.max_uses = 200;
        let id = create(&mut v, input);
        for n in 1..=101 {
            spend_ok(&mut v, id, 1, n, T0 + 1);
        }
        assert_eq!(v.list_spends(0, 1000).len(), 100);
        assert_eq!(v.list_spends(100, 1000).len(), 1);
        assert!(v.list_spends(101, 10).is_empty());
        assert!(v.list_spends(u64::MAX, 10).is_empty());
    }
}
