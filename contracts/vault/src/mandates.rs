//! Mandates: created and revoked only by the owner. The payee never changes.
use near_sdk::Promise;

use crate::ext::ext_ft;
use crate::validate::{asset_matches_chain, is_evm_address, is_hex64, is_solana_address};
use crate::*;

#[near]
impl Vault {
    /// Stores a mandate. The deposit pays its storage plus, for a NEAR payee, the payee's
    /// USDC storage registration. The excess goes back to the owner.
    #[payable]
    pub fn create_mandate(&mut self, input: MandateInput) -> u64 {
        self.assert_owner();
        self.validate_mandate(&input);
        let now = env::block_timestamp();
        let near_payee = match &input.payee {
            Payee::Near { account_id } => Some(account_id.clone()),
            Payee::Intents { .. } => None,
        };
        let id = u64::from(self.mandates.len()) + 1;
        let before = env::storage_usage();
        self.mandates.push(Mandate {
            payee: input.payee.clone(),
            purpose_hash: input.purpose_hash.clone(),
            max_per_payment: input.max_per_payment.0,
            max_total: input.max_total.0,
            spent: 0,
            reserved: 0,
            max_uses: input.max_uses,
            uses: 0,
            expires_at_ns: input.expires_at_ns.0,
            approval_above: input.approval_above.0,
            agent_pk: input.agent_pk.clone(),
            label: input.label,
            revoked: false,
            created_at_ns: now,
        });
        self.mandates.flush();
        let stored = u128::from(env::storage_usage().saturating_sub(before));
        let mut required = env::storage_byte_cost().as_yoctonear() * stored;
        if near_payee.is_some() {
            required += USDC_STORAGE_DEPOSIT.as_yoctonear();
        }
        let attached = env::attached_deposit().as_yoctonear();
        if attached < required {
            fail(ErrorCode::InsufficientDeposit)
        }
        if let Some(account_id) = near_payee {
            ext_ft::ext(self.usdc.clone())
                .with_attached_deposit(USDC_STORAGE_DEPOSIT)
                .with_static_gas(GAS_STORAGE_DEPOSIT)
                .storage_deposit(Some(account_id), Some(true))
                .detach();
        }
        if attached > required {
            Promise::new(env::predecessor_account_id())
                .transfer(NearToken::from_yoctonear(attached - required))
                .detach();
        }
        VaultEvent::MandateCreated {
            mandate_id: id,
            payee: input.payee,
            max_total: input.max_total,
            max_per_payment: input.max_per_payment,
            expires_at_ns: input.expires_at_ns,
            purpose_hash: input.purpose_hash,
            agent_pk: input.agent_pk,
        }
        .emit();
        id
    }

    /// Revoked mandates refuse new spends and approvals. Pending payouts keep their reservation
    /// until their callback resolves.
    #[payable]
    pub fn revoke_mandate(&mut self, mandate_id: u64) {
        self.assert_owner();
        require_one_yocto();
        let m = Self::position(mandate_id)
            .and_then(|i| self.mandates.get_mut(i))
            .unwrap_or_else(|| fail(ErrorCode::NoMandate));
        if m.revoked {
            fail(ErrorCode::MandateInactive)
        }
        m.revoked = true;
        VaultEvent::MandateRevoked { mandate_id }.emit();
    }

    pub fn get_mandate(&self, mandate_id: u64) -> Option<MandateView> {
        self.mandate(mandate_id).map(|m| m.view(mandate_id))
    }

    pub fn list_mandates(&self, from_index: u64, limit: u64) -> Vec<MandateView> {
        let end = from_index
            .saturating_add(limit.min(MAX_PAGE))
            .min(u64::from(self.mandates.len()));
        (from_index..end)
            .filter_map(|i| self.get_mandate(i + 1))
            .collect()
    }
}

impl Vault {
    pub(crate) fn assert_owner(&self) {
        if env::predecessor_account_id() != self.owner {
            fail(ErrorCode::NotOwner)
        }
    }

    /// Ids start at 1 and map to vector position `id - 1`.
    pub(crate) fn position(id: u64) -> Option<u32> {
        id.checked_sub(1).and_then(|i| u32::try_from(i).ok())
    }

    pub(crate) fn mandate(&self, id: u64) -> Option<&Mandate> {
        Self::position(id).and_then(|i| self.mandates.get(i))
    }

    fn validate_mandate(&self, m: &MandateInput) {
        let shape_ok = is_hex64(&m.purpose_hash)
            && m.max_per_payment.0 > 0
            && m.max_per_payment.0 <= m.max_total.0
            && m.max_uses > 0
            && m.expires_at_ns.0 > env::block_timestamp()
            && m.label.len() <= 64;
        if !shape_ok {
            fail(ErrorCode::InvalidInput)
        }
        match &m.payee {
            Payee::Near { account_id } => {
                if *account_id == env::current_account_id() {
                    fail(ErrorCode::InvalidInput)
                }
            }
            Payee::Intents {
                chain,
                address,
                asset,
            } => {
                if !self.allowed_assets.contains(asset) || !asset_matches_chain(*chain, asset) {
                    fail(ErrorCode::AssetNotAllowed)
                }
                let address_ok = match chain {
                    Chain::Base => is_evm_address(address),
                    Chain::Solana => is_solana_address(address),
                };
                if !address_ok {
                    fail(ErrorCode::InvalidInput)
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::test_utils::*;
    use crate::*;
    use near_sdk::mock::MockAction;
    use near_sdk::serde_json::json;

    #[test]
    fn near_mandate_is_stored_registers_payee_storage_and_refunds_the_excess() {
        let mut v = setup();
        as_owner(NearToken::from_near(1));
        assert_eq!(v.create_mandate(near_input()), 1);
        let m = v.get_mandate(1).unwrap();
        assert_eq!(
            m.payee,
            Payee::Near {
                account_id: payee()
            }
        );
        assert_eq!(m.status, MandateStatus::Active);
        assert_eq!((m.spent, m.reserved, m.uses), (U128(0), U128(0), 0));
        assert_eq!(m.created_at_ns, U64(T0));
        let reg = call_to("storage_deposit");
        assert_eq!(reg.receiver, usdc());
        assert_eq!(
            reg.args,
            json!({"account_id": "payee.near", "registration_only": true})
        );
        assert_eq!(reg.deposit, USDC_STORAGE_DEPOSIT);
        let refund = actions()
            .into_iter()
            .find_map(|(to, a)| match a {
                MockAction::Transfer { deposit, .. } => Some((to, deposit)),
                _ => None,
            })
            .expect("a refund transfer");
        assert_eq!(refund.0, owner());
        assert!(refund.1 > NearToken::from_millinear(900) && refund.1 < NearToken::from_near(1));
        assert_eq!(
            last_event(),
            json!({"standard": "probarion", "version": "1.0.0", "event": "mandate_created", "data": {
                "mandate_id": 1,
                "payee": {"type": "near", "account_id": "payee.near"},
                "max_total": "1000000000",
                "max_per_payment": "100000000",
                "expires_at_ns": (T0 + 30 * DAY_NS).to_string(),
                "purpose_hash": hex(0xaa),
                "agent_pk": agent_pk()
            }})
        );
    }

    #[test]
    fn base_mandate_needs_no_payee_registration() {
        let mut v = setup();
        assert_eq!(create(&mut v, base_input()), 1);
        assert!(calls().iter().all(|c| c.method != "storage_deposit"));
        let m = v.get_mandate(1).unwrap();
        assert_eq!(
            m.payee,
            Payee::Intents {
                chain: Chain::Base,
                address: EVM_ADDR.into(),
                asset: base_asset()
            }
        );
    }

    #[test]
    fn checksummed_evm_and_solana_addresses_are_accepted_as_written() {
        let mut v = setup();
        let mut input = base_input();
        input.payee = Payee::Intents {
            chain: Chain::Base,
            address: EVM_MIXED.into(),
            asset: base_asset(),
        };
        create(&mut v, input);
        create(&mut v, sol_input());
        assert_eq!(
            v.get_mandate(1).unwrap().payee.withdraw_memo(),
            Some(format!("WITHDRAW_TO:{EVM_MIXED}"))
        );
        assert_eq!(
            v.get_mandate(2).unwrap().payee.withdraw_memo(),
            Some(format!("WITHDRAW_TO:{SOL_ADDR}"))
        );
    }

    #[test]
    #[should_panic(expected = "PROBARION:NotOwner")]
    fn only_the_owner_creates_mandates() {
        let mut v = setup();
        set_ctx(approver(), pk(200), NearToken::from_near(1), T0);
        v.create_mandate(near_input());
    }

    #[test]
    #[should_panic(expected = "PROBARION:InsufficientDeposit")]
    fn a_mandate_without_deposit_is_refused() {
        let mut v = setup();
        as_owner(yocto(0));
        v.create_mandate(base_input());
    }

    #[test]
    #[should_panic(expected = "PROBARION:InsufficientDeposit")]
    fn payee_registration_alone_does_not_cover_mandate_storage() {
        let mut v = setup();
        as_owner(USDC_STORAGE_DEPOSIT);
        v.create_mandate(near_input());
    }

    /// Independent oracle for the interfaces v2 deposit rule: the byte cost of what the mandate
    /// adds to storage, measured here from the storage meter (not from the contract's refund),
    /// plus `USDC_STORAGE_DEPOSIT` when the payee is a NEAR account.
    fn required_deposit(input: MandateInput) -> NearToken {
        let registers_payee = matches!(input.payee, Payee::Near { .. });
        let mut v = setup();
        as_owner(NearToken::from_near(1));
        let before = env::storage_usage();
        v.create_mandate(input);
        let bytes = u128::from(env::storage_usage() - before);
        let storage = env::storage_byte_cost().checked_mul(bytes).unwrap();
        if registers_payee {
            storage.checked_add(USDC_STORAGE_DEPOSIT).unwrap()
        } else {
            storage
        }
    }
    fn refund_count() -> usize {
        actions()
            .iter()
            .filter(|(_, a)| matches!(a, MockAction::Transfer { .. }))
            .count()
    }

    #[test]
    fn a_near_payee_deposit_is_exactly_storage_plus_the_registration() {
        let required = required_deposit(near_input());
        let mut v = setup();
        as_owner(required);
        assert_eq!(v.create_mandate(near_input()), 1);
        assert_eq!(call_to("storage_deposit").deposit, USDC_STORAGE_DEPOSIT);
        assert_eq!(
            refund_count(),
            0,
            "an exact deposit leaves nothing to refund"
        );
    }

    #[test]
    #[should_panic(expected = "PROBARION:InsufficientDeposit")]
    fn a_near_payee_deposit_one_yocto_short_is_refused() {
        let required = required_deposit(near_input());
        let mut v = setup();
        as_owner(required.checked_sub(ONE_YOCTO).unwrap());
        v.create_mandate(near_input());
    }

    #[test]
    fn an_intents_payee_deposit_is_exactly_storage_with_no_registration() {
        let required = required_deposit(base_input());
        let mut v = setup();
        as_owner(required);
        assert_eq!(v.create_mandate(base_input()), 1);
        assert!(calls().iter().all(|c| c.method != "storage_deposit"));
        assert_eq!(
            refund_count(),
            0,
            "an exact deposit leaves nothing to refund"
        );
    }

    #[test]
    #[should_panic(expected = "PROBARION:InsufficientDeposit")]
    fn an_intents_payee_deposit_one_yocto_short_is_refused() {
        let required = required_deposit(base_input());
        let mut v = setup();
        as_owner(required.checked_sub(ONE_YOCTO).unwrap());
        v.create_mandate(base_input());
    }

    #[test]
    #[should_panic(expected = "PROBARION:AssetNotAllowed")]
    fn an_asset_outside_the_allowlist_is_refused() {
        let mut v = setup();
        let mut input = base_input();
        input.payee = Payee::Intents {
            chain: Chain::Base,
            address: EVM_ADDR.into(),
            asset: acc("base-evil.near"),
        };
        create(&mut v, input);
    }

    #[test]
    #[should_panic(expected = "PROBARION:AssetNotAllowed")]
    fn an_allowlisted_asset_of_the_wrong_chain_is_refused() {
        let mut v = setup();
        let mut input = base_input();
        input.payee = Payee::Intents {
            chain: Chain::Base,
            address: EVM_ADDR.into(),
            asset: sol_asset(),
        };
        create(&mut v, input);
    }

    fn set_base_address(m: &mut MandateInput, address: &str) {
        m.payee = Payee::Intents {
            chain: Chain::Base,
            address: address.into(),
            asset: base_asset(),
        };
    }
    fn set_sol_address(m: &mut MandateInput, address: &str) {
        m.payee = Payee::Intents {
            chain: Chain::Solana,
            address: address.into(),
            asset: sol_asset(),
        };
    }

    macro_rules! invalid_mandate {
        ($($name:ident: $edit:expr,)*) => {$(
            #[test]
            #[should_panic(expected = "PROBARION:InvalidInput")]
            fn $name() {
                let mut v = setup();
                let mut input = base_input();
                let edit: fn(&mut MandateInput) = $edit;
                edit(&mut input);
                create(&mut v, input);
            }
        )*};
    }

    invalid_mandate! {
        rejects_an_uppercase_purpose_hash: |m| m.purpose_hash = hex(0xaa).to_uppercase(),
        rejects_a_short_purpose_hash: |m| m.purpose_hash.truncate(63),
        rejects_a_zero_per_payment_cap: |m| m.max_per_payment = U128(0),
        rejects_a_per_payment_cap_above_the_total: |m| m.max_per_payment = U128(m.max_total.0 + 1),
        rejects_zero_uses: |m| m.max_uses = 0,
        rejects_an_expiry_that_is_not_in_the_future: |m| m.expires_at_ns = U64(T0),
        rejects_a_label_over_64_bytes: |m| m.label = "x".repeat(65),
        rejects_an_uppercase_0x_prefix: |m| set_base_address(m, &format!("0X{}", "1".repeat(40))),
        rejects_39_hex_digits: |m| set_base_address(m, &format!("0x{}", "1".repeat(39))),
        rejects_41_hex_digits: |m| set_base_address(m, &format!("0x{}", "1".repeat(41))),
        rejects_a_trailing_space: |m| set_base_address(m, &format!("0x{} ", "1".repeat(39))),
        rejects_a_non_hex_digit: |m| set_base_address(m, &format!("0x{}g", "1".repeat(39))),
        rejects_a_solana_address_with_zero: |m| set_sol_address(m, &format!("0{}", &SOL_ADDR[1..])),
        rejects_a_short_solana_address: |m| set_sol_address(m, &SOL_ADDR[..31]),
        rejects_the_vault_as_near_payee: |m| m.payee = Payee::Near { account_id: vault_id() },
    }

    #[test]
    fn revoke_marks_the_mandate_revoked_and_emits() {
        let mut v = setup();
        create(&mut v, near_input());
        as_owner(ONE_YOCTO);
        v.revoke_mandate(1);
        assert_eq!(v.get_mandate(1).unwrap().status, MandateStatus::Revoked);
        assert_eq!(last_event()["event"], "mandate_revoked");
    }

    #[test]
    #[should_panic(expected = "PROBARION:NoMandate")]
    fn revoking_a_missing_mandate_is_refused() {
        let mut v = setup();
        as_owner(ONE_YOCTO);
        v.revoke_mandate(1);
    }

    #[test]
    #[should_panic(expected = "PROBARION:MandateInactive")]
    fn revoking_twice_is_refused() {
        let mut v = setup();
        create(&mut v, near_input());
        as_owner(ONE_YOCTO);
        v.revoke_mandate(1);
        v.revoke_mandate(1);
    }

    #[test]
    #[should_panic(expected = "PROBARION:NotOwner")]
    fn only_the_owner_revokes() {
        let mut v = setup();
        create(&mut v, near_input());
        as_account(approver(), T0);
        v.revoke_mandate(1);
    }

    #[test]
    fn revoke_requires_exactly_one_yocto() {
        let make = || {
            let mut v = setup();
            create(&mut v, near_input());
            v
        };
        assert_requires_one_yocto(owner(), T0, make, |v| v.revoke_mandate(1));
    }

    #[test]
    fn status_is_exhausted_when_uses_or_total_run_out() {
        let mut v = setup();
        create(&mut v, near_input());
        create(&mut v, near_input());
        v.mandates.get_mut(0).unwrap().uses = 10;
        v.mandates.get_mut(1).unwrap().spent = 1_000 * USDC;
        assert_eq!(v.get_mandate(1).unwrap().status, MandateStatus::Exhausted);
        assert_eq!(v.get_mandate(2).unwrap().status, MandateStatus::Exhausted);
    }

    #[test]
    fn list_mandates_pages_by_position_and_ids_start_at_one() {
        let mut v = setup();
        for _ in 0..3 {
            create(&mut v, base_input());
        }
        let ids: Vec<u64> = v.list_mandates(1, 10).iter().map(|m| m.id).collect();
        assert_eq!(ids, vec![2, 3]);
        assert!(v.list_mandates(5, 10).is_empty());
        assert!(v.get_mandate(0).is_none());
        assert!(v.get_mandate(4).is_none());
    }

    #[test]
    fn list_mandates_caps_a_page_at_100_and_survives_extreme_arguments() {
        let mut v = setup();
        for _ in 0..101 {
            create(&mut v, base_input());
        }
        assert_eq!(v.list_mandates(0, u64::MAX).len(), 100);
        assert_eq!(v.list_mandates(100, u64::MAX).len(), 1);
        assert!(v.list_mandates(u64::MAX, 10).is_empty());
        assert!(v.get_mandate(u64::MAX).is_none());
    }
}
