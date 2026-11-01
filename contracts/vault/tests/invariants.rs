//! Property tests over random sequences of spend, approve, reject, expire and callbacks:
//! I2 (spent + reserved <= max_total) and I3 (each invoice_hash paid at most once), plus
//! "spend refuses exactly when check_spend refuses, with the same code, and changes nothing".
use near_sdk::json_types::{U128, U64};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{
    env, testing_env, AccountId, CurveType, MockedBlockchain, NearToken, PromiseResult, PublicKey,
    RuntimeFeesConfig,
};
use probarion_vault::{
    Chain, MandateInput, MandateView, Payee, SpendRequest, SpendStatus, SpendView, Vault,
};
use proptest::prelude::*;
use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Once;

const T0: u64 = 1_800_000_000_000_000_000;
const HOUR: u64 = 3_600_000_000_000;
const LIVE: [SpendStatus; 4] = [
    SpendStatus::Held,
    SpendStatus::Pending,
    SpendStatus::Paid,
    SpendStatus::Burned,
];
const RESERVED: [SpendStatus; 2] = [SpendStatus::Held, SpendStatus::Pending];
const SETTLED: [SpendStatus; 2] = [SpendStatus::Paid, SpendStatus::Burned];

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn agent() -> PublicKey {
    PublicKey::from_parts(CurveType::ED25519, vec![1; 32]).unwrap()
}
fn hex(n: u8) -> String {
    format!("{n:02x}").repeat(32)
}

fn ctx(predecessor: &str, now: u64, deposit: NearToken, results: Vec<PromiseResult>) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(acc("vault.near"))
            .predecessor_account_id(acc(predecessor))
            .signer_account_id(acc(predecessor))
            .signer_account_pk(agent())
            .attached_deposit(deposit)
            .block_timestamp(now)
            .account_balance(NearToken::from_near(100))
            .build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}

/// Empty storage for each proptest case.
fn fresh() {
    let context = VMContextBuilder::new()
        .current_account_id(acc("vault.near"))
        .predecessor_account_id(acc("owner.near"))
        .block_timestamp(T0)
        .account_balance(NearToken::from_near(100))
        .build();
    env::set_blockchain_interface(MockedBlockchain::new(
        context,
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        vec![],
        HashMap::new(),
        HashMap::new(),
        None,
    ));
}

/// Hides the panic messages of expected contract refusals; every other panic stays visible.
fn quiet_contract_panics() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let default = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let payload = info.payload();
            let text = payload
                .downcast_ref::<String>()
                .map(String::as_str)
                .or_else(|| payload.downcast_ref::<&str>().copied())
                .unwrap_or("");
            // The mocked blockchain wraps the code: `... GuestPanic { panic_msg: "PROBARION:<Code>" }`.
            if !text.contains("PROBARION:") {
                default(info)
            }
        }));
    });
}

fn input(payee: Payee) -> MandateInput {
    MandateInput {
        payee,
        purpose_hash: hex(0xaa),
        max_per_payment: U128(30),
        max_total: U128(100),
        max_uses: 6,
        expires_at_ns: U64(T0 + 1_000 * HOUR),
        approval_above: U128(20),
        agent_pk: agent(),
        label: "prop".to_string(),
    }
}

/// Mandate 1 pays a NEAR account, mandate 2 a Base address; mandate 3 does not exist.
/// The daily backstop (150) is below the two totals (200), so it bites too.
fn setup() -> Vault {
    fresh();
    let mut v = Vault::new(
        acc("owner.near"),
        vec![acc("approver.near")],
        acc("usdc.near"),
        acc("intents.near"),
        vec![acc("base-usdc.near")],
        U128(150),
        U64(HOUR),
    );
    ctx("owner.near", T0, NearToken::from_yoctonear(1), vec![]);
    v.add_agent(agent(), U128(10u128.pow(24)), "agent".to_string());
    ctx("owner.near", T0, NearToken::from_near(1), vec![]);
    v.create_mandate(input(Payee::Near {
        account_id: acc("payee.near"),
    }));
    v.create_mandate(input(Payee::Intents {
        chain: Chain::Base,
        address: format!("0x{}", "ab".repeat(20)),
        asset: acc("base-usdc.near"),
    }));
    v
}

#[derive(Clone, Debug)]
enum Op {
    Spend {
        mandate: u64,
        amount: u128,
        invoice: u8,
        rf: u8,
    },
    Approve(u64),
    Reject(u64),
    Settle {
        spend: u64,
        ok: bool,
    },
    Expire(u64),
    Advance(u64),
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        4 => (1..=3u64, 0..=35u128, 0..5u8, 0..10u8)
            .prop_map(|(mandate, amount, invoice, rf)| Op::Spend { mandate, amount, invoice, rf }),
        2 => (1..=12u64).prop_map(Op::Approve),
        1 => (1..=12u64).prop_map(Op::Reject),
        3 => (1..=12u64, any::<bool>()).prop_map(|(spend, ok)| Op::Settle { spend, ok }),
        1 => (1..=12u64).prop_map(Op::Expire),
        1 => (0..=2 * HOUR).prop_map(Op::Advance),
    ]
}

fn panic_text(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default()
}

fn state(v: &Vault) -> (Vec<MandateView>, Vec<SpendView>) {
    (v.list_mandates(0, 10), v.list_spends(0, 100))
}

struct Sim {
    v: Vault,
    now: u64,
}

impl Sim {
    /// (status, mandate id, held_until_ns or 0)
    fn status(&self, spend_id: u64) -> Option<(SpendStatus, u64, u64)> {
        self.v
            .get_spend(spend_id)
            .map(|s| (s.status, s.mandate_id, s.held_until_ns.map_or(0, |t| t.0)))
    }

    fn apply(&mut self, op: &Op) {
        match *op {
            Op::Spend {
                mandate,
                amount,
                invoice,
                rf,
            } => {
                let request = SpendRequest {
                    mandate_id: mandate,
                    amount: U128(amount),
                    invoice_hash: hex(invoice),
                    r#ref: format!("R-{rf}"),
                    decision_hash: hex(0xdd),
                };
                // v2 lifecycle: an invoice_hash blocks only while a spend on it is live (Failed,
                // Rejected and Expired released it), but a ref blocks forever, whatever became of
                // the spend that used it. A retry of a released invoice_hash needs a NEW ref.
                let (_, before_spends) = state(&self.v);
                let invoice_live = before_spends
                    .iter()
                    .any(|s| s.invoice_hash == request.invoice_hash && LIVE.contains(&s.status));
                let ref_used = before_spends.iter().any(|s| s.r#ref == request.r#ref);
                ctx("vault.near", self.now, NearToken::from_yoctonear(0), vec![]);
                let verdict = self.v.check_spend(request.clone(), agent());
                if verdict.ok {
                    assert!(
                        !invoice_live,
                        "accepted an invoice_hash that has a live spend"
                    );
                    assert!(
                        !ref_used,
                        "accepted a ref that an earlier spend already used"
                    );
                    let _ = self.v.spend(request);
                    return;
                }
                let code = verdict.code.expect("a refusal carries a code");
                match code.as_str() {
                    "DuplicateInvoice" => assert!(
                        invoice_live,
                        "DuplicateInvoice, but no live spend holds the invoice_hash"
                    ),
                    "DuplicateRef" => {
                        assert!(ref_used, "DuplicateRef, but no earlier spend used that ref")
                    }
                    _ => {}
                }
                let before = state(&self.v);
                let outcome = catch_unwind(AssertUnwindSafe(|| {
                    let _ = self.v.spend(request);
                }));
                let payload = match outcome {
                    Ok(()) => {
                        panic!("spend accepted a request that check_spend refused with {code}")
                    }
                    Err(payload) => payload,
                };
                let text = panic_text(&*payload);
                assert!(
                    text.contains(&format!("PROBARION:{code}")),
                    "spend panicked with {text:?}; check_spend said {code}"
                );
                assert_eq!(state(&self.v), before, "a refused spend changed state");
            }
            Op::Approve(id) => {
                if let Some((SpendStatus::Held, _, until)) = self.status(id) {
                    if self.now <= until {
                        ctx(
                            "approver.near",
                            self.now,
                            NearToken::from_yoctonear(1),
                            vec![],
                        );
                        let _ = self.v.approve(id);
                    }
                }
            }
            Op::Reject(id) => {
                if let Some((SpendStatus::Held, _, _)) = self.status(id) {
                    ctx(
                        "approver.near",
                        self.now,
                        NearToken::from_yoctonear(1),
                        vec![],
                    );
                    self.v.reject(id);
                }
            }
            Op::Expire(id) => {
                if let Some((SpendStatus::Held, _, until)) = self.status(id) {
                    if self.now > until {
                        ctx(
                            "anyone.near",
                            self.now,
                            NearToken::from_yoctonear(0),
                            vec![],
                        );
                        self.v.expire_held(id);
                    }
                }
            }
            Op::Settle { spend, ok } => {
                if let Some((SpendStatus::Pending, mandate, _)) = self.status(spend) {
                    let amount = self
                        .v
                        .get_spend(spend)
                        .map(|s| s.amount.0)
                        .unwrap_or_default();
                    let result = if !ok {
                        PromiseResult::Failed
                    } else if mandate == 1 {
                        PromiseResult::Successful(vec![])
                    } else {
                        PromiseResult::Successful(format!("\"{amount}\"").into_bytes())
                    };
                    ctx(
                        "vault.near",
                        self.now,
                        NearToken::from_yoctonear(0),
                        vec![result],
                    );
                    if mandate == 1 {
                        self.v.on_transfer(spend);
                    } else {
                        self.v.on_withdraw(spend);
                    }
                }
            }
            Op::Advance(dt) => self.now += dt,
        }
    }
}

/// I2 plus the accounting behind it: reserved = Held + Pending, spent = Paid + Burned, uses = live spends.
fn check_i2(v: &Vault) {
    let (mandates, spends) = state(v);
    for m in &mandates {
        assert!(
            m.spent.0 + m.reserved.0 <= m.max_total.0,
            "I2 broken for mandate {}: {m:?}",
            m.id
        );
        let sum = |statuses: &[SpendStatus]| -> u128 {
            spends
                .iter()
                .filter(|s| s.mandate_id == m.id && statuses.contains(&s.status))
                .map(|s| s.amount.0)
                .sum()
        };
        assert_eq!(
            m.reserved.0,
            sum(&RESERVED),
            "reserved != Held + Pending for mandate {}",
            m.id
        );
        assert_eq!(
            m.spent.0,
            sum(&SETTLED),
            "spent != Paid + Burned for mandate {}",
            m.id
        );
        let live = spends
            .iter()
            .filter(|s| s.mandate_id == m.id && LIVE.contains(&s.status))
            .count();
        assert_eq!(
            m.uses as usize, live,
            "uses != live spends for mandate {}",
            m.id
        );
    }
}

/// I3: at most one live spend, and at most one Paid or Burned spend, per invoice_hash.
fn check_i3(v: &Vault) {
    let (_, spends) = state(v);
    let mut live: HashMap<&str, usize> = HashMap::new();
    let mut settled: HashMap<&str, usize> = HashMap::new();
    for s in &spends {
        if LIVE.contains(&s.status) {
            *live.entry(s.invoice_hash.as_str()).or_default() += 1;
        }
        if SETTLED.contains(&s.status) {
            *settled.entry(s.invoice_hash.as_str()).or_default() += 1;
        }
    }
    assert!(
        live.values().all(|&n| n <= 1),
        "I3 broken: an invoice has two live spends: {live:?}"
    );
    assert!(
        settled.values().all(|&n| n <= 1),
        "I3 broken: an invoice was paid twice: {settled:?}"
    );
}

/// Runs `ops` on a fresh vault and calls `check` after every operation.
fn run(ops: &[Op], check: fn(&Vault)) {
    quiet_contract_panics();
    let mut sim = Sim {
        v: setup(),
        now: T0 + 1,
    };
    for op in ops {
        sim.apply(op);
        check(&sim.v);
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    // probarion-claim: I2
    #[test]
    fn i2_spent_plus_reserved_never_exceeds_max_total(ops in proptest::collection::vec(op(), 1..40)) {
        run(&ops, check_i2);
    }

    // probarion-claim: I3
    #[test]
    fn i3_each_invoice_hash_is_paid_at_most_once(ops in proptest::collection::vec(op(), 1..40)) {
        run(&ops, check_i3);
    }
}
