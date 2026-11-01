//! On-chain anchors of the off-chain ledger: (seq, root = link of entry count-1, count).
//! Only the ledger FC key may anchor, and seq goes up by exactly one (I6).
use crate::validate::is_hex64;
use crate::*;

#[near]
impl Vault {
    pub fn anchor(&mut self, seq: u64, root: String, count: u64) {
        let signer_pk = env::signer_account_pk();
        let by_ledger_key = env::predecessor_account_id() == env::current_account_id()
            && self.ledger_key.as_ref() == Some(&signer_pk);
        if !by_ledger_key {
            fail(ErrorCode::NotLedgerKey)
        }
        if seq != u64::from(self.anchors.len()) + 1 {
            fail(ErrorCode::BadSeq)
        }
        let previous_count = self
            .anchors
            .get(self.anchors.len().wrapping_sub(1))
            .map_or(0, |a| a.count);
        if !is_hex64(&root) || count == 0 || count < previous_count {
            fail(ErrorCode::InvalidInput)
        }
        // Store the signing key with the anchor so a later key rotation keeps this range verifiable.
        self.anchors.push(Anchor {
            root: root.clone(),
            count,
            at_ns: env::block_timestamp(),
            ledger_key: signer_pk,
        });
        VaultEvent::LedgerAnchored { seq, root, count }.emit();
    }

    pub fn list_anchors(&self, from_index: u64, limit: u64) -> Vec<AnchorView> {
        let end = from_index
            .saturating_add(limit.min(MAX_PAGE))
            .min(u64::from(self.anchors.len()));
        (from_index..end)
            .filter_map(|i| {
                let a = self.anchors.get(u32::try_from(i).ok()?)?;
                Some(AnchorView {
                    seq: i + 1,
                    root: a.root.clone(),
                    count: a.count,
                    at_ns: U64(a.at_ns),
                    ledger_key: a.ledger_key.clone(),
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use crate::test_utils::*;
    use crate::*;
    use near_sdk::serde_json::json;

    fn with_ledger_key() -> Vault {
        let mut v = setup_with_agent();
        as_owner(ONE_YOCTO);
        v.set_ledger_key(ledger_pk(), U128(ONE_NEAR));
        v
    }
    fn as_ledger(now: u64) {
        set_ctx(vault_id(), ledger_pk(), yocto(0), now);
    }

    #[test]
    fn anchors_start_at_one_and_increase_by_one() {
        let mut v = with_ledger_key();
        as_ledger(T0 + 1);
        v.anchor(1, hex(1), 3);
        v.anchor(2, hex(2), 5);
        assert_eq!(
            v.list_anchors(0, 10),
            vec![
                AnchorView {
                    seq: 1,
                    root: hex(1),
                    count: 3,
                    at_ns: U64(T0 + 1),
                    ledger_key: ledger_pk()
                },
                AnchorView {
                    seq: 2,
                    root: hex(2),
                    count: 5,
                    at_ns: U64(T0 + 1),
                    ledger_key: ledger_pk()
                },
            ]
        );
        assert_eq!(last_event()["event"], "ledger_anchored");
        assert_eq!(
            last_event()["data"],
            json!({"seq": 2, "root": hex(2), "count": 5})
        );
        assert_eq!(v.list_anchors(1, 10).len(), 1);
    }

    #[test]
    fn after_rotation_new_anchors_use_the_new_key_and_old_anchors_keep_the_old_one() {
        let mut v = with_ledger_key();
        as_ledger(T0 + 1);
        v.anchor(1, hex(1), 3);
        as_owner(ONE_YOCTO);
        v.set_ledger_key(pk(10), U128(ONE_NEAR));
        set_ctx(vault_id(), pk(10), yocto(0), T0 + 2);
        v.anchor(2, hex(2), 5);
        let anchors = v.list_anchors(0, 10);
        assert_eq!(anchors[0].ledger_key, ledger_pk());
        assert_eq!(anchors[1].ledger_key, pk(10));
    }

    #[test]
    #[should_panic(expected = "PROBARION:NotLedgerKey")]
    fn a_rotated_out_ledger_key_can_no_longer_anchor() {
        let mut v = with_ledger_key();
        as_ledger(T0 + 1);
        v.anchor(1, hex(1), 3);
        as_owner(ONE_YOCTO);
        v.set_ledger_key(pk(10), U128(ONE_NEAR));
        as_ledger(T0 + 2);
        v.anchor(2, hex(2), 5);
    }

    #[test]
    fn an_anchor_may_repeat_the_previous_count() {
        let mut v = with_ledger_key();
        as_ledger(T0 + 1);
        v.anchor(1, hex(1), 3);
        v.anchor(2, hex(1), 3);
        assert_eq!(v.list_anchors(0, 10).len(), 2);
    }

    #[test]
    #[should_panic(expected = "PROBARION:BadSeq")]
    fn the_first_anchor_must_be_seq_one() {
        let mut v = with_ledger_key();
        as_ledger(T0 + 1);
        v.anchor(2, hex(1), 1);
    }

    #[test]
    #[should_panic(expected = "PROBARION:BadSeq")]
    fn a_repeated_seq_is_refused() {
        let mut v = with_ledger_key();
        as_ledger(T0 + 1);
        v.anchor(1, hex(1), 1);
        v.anchor(1, hex(2), 2);
    }

    #[test]
    #[should_panic(expected = "PROBARION:NotLedgerKey")]
    fn the_agent_key_cannot_anchor() {
        let mut v = with_ledger_key();
        as_agent(agent_pk(), T0 + 1);
        v.anchor(1, hex(1), 1);
    }

    #[test]
    #[should_panic(expected = "PROBARION:NotLedgerKey")]
    fn another_account_cannot_anchor_even_with_the_ledger_public_key() {
        let mut v = with_ledger_key();
        set_ctx(owner(), ledger_pk(), yocto(0), T0 + 1);
        v.anchor(1, hex(1), 1);
    }

    #[test]
    #[should_panic(expected = "PROBARION:NotLedgerKey")]
    fn nothing_anchors_before_a_ledger_key_is_set() {
        let mut v = setup_with_agent();
        as_ledger(T0 + 1);
        v.anchor(1, hex(1), 1);
    }

    #[test]
    #[should_panic(expected = "PROBARION:InvalidInput")]
    fn the_root_must_be_lowercase_hex() {
        let mut v = with_ledger_key();
        as_ledger(T0 + 1);
        v.anchor(1, hex(0xab).to_uppercase(), 1);
    }

    #[test]
    #[should_panic(expected = "PROBARION:InvalidInput")]
    fn the_count_cannot_go_backwards() {
        let mut v = with_ledger_key();
        as_ledger(T0 + 1);
        v.anchor(1, hex(1), 5);
        v.anchor(2, hex(2), 4);
    }

    #[test]
    #[should_panic(expected = "PROBARION:InvalidInput")]
    fn the_count_must_be_positive() {
        let mut v = with_ledger_key();
        as_ledger(T0 + 1);
        v.anchor(1, hex(1), 0);
    }

    #[test]
    fn list_anchors_caps_a_page_at_100_and_survives_extreme_arguments() {
        let mut v = with_ledger_key();
        for seq in 1..=101u64 {
            // A fresh context per call: the mocked VM caps the total log length of one context.
            as_ledger(T0 + 1);
            v.anchor(seq, hex(1), seq);
        }
        assert_eq!(v.list_anchors(0, u64::MAX).len(), 100);
        let tail = v.list_anchors(100, u64::MAX);
        assert_eq!(tail.len(), 1);
        assert_eq!(tail[0].seq, 101);
        assert!(v.list_anchors(101, 10).is_empty());
        assert!(v.list_anchors(u64::MAX, 10).is_empty());
        assert!(v.list_anchors(u64::from(u32::MAX) + 1, 10).is_empty());
    }
}
