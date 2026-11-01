import type { MandateView, SpendRequest } from "@probarion/core";
import { describe, expect, it } from "vitest";
import {
  createScenarioChain,
  FakeChain,
  FakePanic,
  FakeRawPanic,
  FakeRpcFault,
  FakeVmError,
  GAS_FLOOR_INTENTS_PAYOUT,
  GAS_FLOOR_NEAR_PAYOUT,
  SCENARIO_BASE_ADDRESS,
  SCENARIO_NEAR_PAYEE,
  SCENARIO_NOW,
  SCENARIO_VAULT,
  type ScenarioOptions,
  TEST_KEYS,
} from "../src/testing/index.js";
import { SPEND_GAS } from "../src/vault-client.js";

// TEST DOUBLE tests. Every expectation below is read off the Rust contract, with the file and line
// in a comment where it is not obvious: contracts/vault/src/{checks,spend,held,anchors,keys}.rs.

const DAY = 86_400_000_000_000n;
const U128_MAX = (1n << 128n) - 1n;
const agent = TEST_KEYS.agent.publicKey;
const approver = "approver.testnet";

const req = (over: Partial<SpendRequest> = {}): SpendRequest => ({
  mandate_id: 1,
  amount: "25000000",
  invoice_hash: "ab".repeat(32),
  ref: "INV-1",
  decision_hash: "cd".repeat(32),
  ...over,
});

function scenario(opts: ScenarioOptions = {}) {
  const clock = { now: SCENARIO_NOW };
  const chain = createScenarioChain({ nowNs: () => clock.now, ...opts });
  return { chain, clock };
}

function mandateOf(chain: FakeChain, id: number): MandateView {
  const found = chain.mandates.find((m) => m.id === id);
  if (found === undefined) throw new Error(`scenario mandate ${id} missing`);
  return found;
}

function spend(
  chain: FakeChain,
  request: SpendRequest,
  over: { signerPk?: string; signerId?: string; deposit?: bigint; gas?: bigint } = {},
) {
  return chain.applyFunctionCall({
    signerId: over.signerId ?? chain.vaultId,
    signerPk: over.signerPk ?? agent,
    receiverId: chain.vaultId,
    method: "spend",
    args: { request },
    deposit: over.deposit ?? 0n,
    ...(over.gas === undefined ? {} : { gas: over.gas }),
  });
}

function approverCall(
  chain: FakeChain,
  method: string,
  spendId: number,
  over: { signerId?: string; deposit?: bigint; gas?: bigint } = {},
) {
  return chain.applyFunctionCall({
    signerId: over.signerId ?? approver,
    signerPk: TEST_KEYS.approver.publicKey,
    receiverId: chain.vaultId,
    method,
    args: { spend_id: spendId },
    deposit: over.deposit ?? 1n,
    ...(over.gas === undefined ? {} : { gas: over.gas }),
  });
}

function anchorCall(
  chain: FakeChain,
  args: Record<string, unknown>,
  signerPk = TEST_KEYS.ledger.publicKey,
) {
  return chain.applyFunctionCall({
    signerId: chain.vaultId,
    signerPk,
    receiverId: chain.vaultId,
    method: "anchor",
    args,
    deposit: 0n,
  });
}

interface ParsedEvent {
  standard: string;
  version: string;
  event: string;
  data: Record<string, unknown>;
  keys: string[];
  dataKeys: string[];
}

function eventsOf(logs: readonly string[]): ParsedEvent[] {
  return logs
    .filter((line) => line.startsWith("EVENT_JSON:"))
    .map((line) => {
      const parsed = JSON.parse(line.slice("EVENT_JSON:".length)) as Record<string, unknown>;
      const data = parsed.data as Record<string, unknown>;
      return {
        standard: String(parsed.standard),
        version: String(parsed.version),
        event: String(parsed.event),
        data,
        keys: Object.keys(parsed),
        dataKeys: Object.keys(Array.isArray(data) ? (data[0] as Record<string, unknown>) : data),
      };
    });
}

function everyLog(result: { vaultLogs: string[]; receipts: { logs: string[] }[] }): string[] {
  return [...result.vaultLogs, ...result.receipts.flatMap((r) => r.logs)];
}

function panicCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof FakePanic) return error.message;
    throw error;
  }
  throw new Error("expected the call to panic");
}

describe("FakeChain (TEST DOUBLE of the vault)", () => {
  it("checks spends in the contract's order", () => {
    const chain = createScenarioChain();
    expect(chain.checkSpend(req(), agent)).toEqual({ ok: true, code: null, would_hold: false });
    expect(chain.checkSpend(req(), TEST_KEYS.other.publicKey).code).toBe("NotAgent");
    expect(chain.checkSpend(req({ mandate_id: 9 }), agent).code).toBe("NoMandate");
    expect(chain.checkSpend(req({ invoice_hash: "AB".repeat(32) }), agent).code).toBe(
      "InvalidInput",
    );
    expect(chain.checkSpend(req({ ref: "R".repeat(65) }), agent).code).toBe("InvalidInput");
    expect(chain.checkSpend(req({ amount: "0" }), agent).code).toBe("ZeroAmount");
    expect(chain.checkSpend(req({ amount: "100000001" }), agent).code).toBe("OverPerPayment");
    expect(chain.checkSpend(req({ amount: "75000000" }), agent)).toEqual({
      ok: true,
      code: null,
      would_hold: true,
    });
    chain.config.frozen = true;
    expect(chain.checkSpend(req(), agent).code).toBe("Frozen");
  });

  it("pays NEAR payees, burns for Intents payees and refuses duplicates", () => {
    const chain = createScenarioChain();
    const paid = chain.applyFunctionCall({
      signerId: chain.vaultId,
      signerPk: agent,
      receiverId: chain.vaultId,
      method: "spend",
      args: { request: req() },
      deposit: 0n,
    });
    expect(paid.value).toEqual({ spend_id: 1, status: "paid" });
    expect(() =>
      chain.applyFunctionCall({
        signerId: chain.vaultId,
        signerPk: agent,
        receiverId: chain.vaultId,
        method: "spend",
        args: { request: req({ ref: "INV-2" }) },
        deposit: 0n,
      }),
    ).toThrow(FakePanic);
    const burned = chain.applyFunctionCall({
      signerId: chain.vaultId,
      signerPk: agent,
      receiverId: chain.vaultId,
      method: "spend",
      args: { request: req({ mandate_id: 2, invoice_hash: "ef".repeat(32), ref: "INV-3" }) },
      deposit: 0n,
    });
    expect(burned.value).toEqual({ spend_id: 2, status: "burned" });
    expect(burned.receipts.at(-1)?.logs[0]).toContain("WITHDRAW_TO:");
    expect(chain.spends[1]?.memo).toMatch(/^WITHDRAW_TO:0x/);
  });

  it("counts live spends as uses from the reservation on and derives exhausted", () => {
    const chain = createScenarioChain();
    const mandate = chain.mandates[0];
    if (mandate === undefined) throw new Error("scenario mandate missing");
    mandate.max_uses = 1;
    const held = chain.applyFunctionCall({
      signerId: chain.vaultId,
      signerPk: agent,
      receiverId: chain.vaultId,
      method: "spend",
      args: { request: req({ amount: "75000000" }) },
      deposit: 0n,
    });
    expect(held.value).toEqual({ spend_id: 1, status: "held" });
    expect(mandate).toMatchObject({ uses: 1, status: "exhausted" });
    // R13: an exhausted mandate is refused with UsesExhausted. MandateInactive is for a revoked one only (checks.rs:34).
    expect(chain.checkSpend(req({ invoice_hash: "ef".repeat(32), ref: "INV-2" }), agent).code).toBe(
      "UsesExhausted",
    );
  });

  it("accepts anchors only from the ledger key with seq + 1, and records that key", () => {
    const chain = createScenarioChain();
    const anchor = (seq: number, pk: string) =>
      chain.applyFunctionCall({
        signerId: chain.vaultId,
        signerPk: pk,
        receiverId: chain.vaultId,
        method: "anchor",
        args: { seq, root: "ab".repeat(32), count: 1 },
        deposit: 0n,
      });
    expect(() => anchor(1, agent)).toThrow("PROBARION:NotLedgerKey");
    anchor(1, TEST_KEYS.ledger.publicKey);
    expect(() => anchor(3, TEST_KEYS.ledger.publicKey)).toThrow("PROBARION:BadSeq");
    expect(chain.anchors).toEqual([
      expect.objectContaining({ seq: 1, ledger_key: TEST_KEYS.ledger.publicKey }),
    ]);
  });
});

describe("spend check order and boundaries (checks.rs Vault::evaluate, lines 23-65)", () => {
  interface Case {
    name: string;
    expected: string;
    setup?: (chain: FakeChain, clock: { now: bigint }) => void;
    request?: Partial<SpendRequest>;
    signer?: string;
  }
  const expiresAt = 1_798_761_600_000_000_000n;
  const withExistingSpend = (chain: FakeChain) => {
    spend(chain, req({ amount: "10000000" }));
  };

  const cases: Case[] = [
    {
      name: "the caller rule comes before the request shape",
      expected: "NotAgent",
      signer: TEST_KEYS.other.publicKey,
      request: { invoice_hash: "zz" },
    },
    {
      name: "the request shape comes before frozen",
      expected: "InvalidInput",
      setup: (c) => {
        c.config.frozen = true;
      },
      request: { ref: "" },
    },
    {
      name: "frozen comes before a missing mandate",
      expected: "Frozen",
      setup: (c) => {
        c.config.frozen = true;
      },
      request: { mandate_id: 99 },
    },
    {
      name: "a missing mandate comes before everything mandate-specific",
      expected: "NoMandate",
      request: { mandate_id: 99, amount: "0" },
    },
    {
      name: "mandate id 0 is no mandate (ids start at 1)",
      expected: "NoMandate",
      request: { mandate_id: 0 },
    },
    {
      name: "revoked comes before expired",
      expected: "MandateInactive",
      setup: (c, clock) => {
        mandateOf(c, 1).status = "revoked";
        clock.now = expiresAt + 1n;
      },
    },
    {
      name: "expired comes before an agent mismatch",
      expected: "MandateExpired",
      setup: (c, clock) => {
        mandateOf(c, 1).agent_pk = TEST_KEYS.other.publicKey;
        clock.now = expiresAt;
      },
    },
    {
      name: "an agent mismatch comes before a zero amount",
      expected: "NotMandateAgent",
      setup: (c) => {
        mandateOf(c, 1).agent_pk = TEST_KEYS.other.publicKey;
      },
      request: { amount: "0" },
    },
    {
      name: "an agent mismatch comes before the per-payment cap",
      expected: "NotMandateAgent",
      setup: (c) => {
        mandateOf(c, 1).agent_pk = TEST_KEYS.other.publicKey;
      },
      request: { amount: "100000001" },
    },
    {
      name: "a zero amount comes before a duplicate invoice",
      expected: "ZeroAmount",
      setup: withExistingSpend,
      request: { amount: "0" },
    },
    {
      name: "a zero amount comes before exhausted uses",
      expected: "ZeroAmount",
      setup: (c) => {
        mandateOf(c, 1).uses = 10;
      },
      request: { amount: "0" },
    },
    {
      name: "the per-payment cap comes before exhausted uses",
      expected: "OverPerPayment",
      setup: (c) => {
        mandateOf(c, 1).uses = 10;
      },
      request: { amount: "100000001" },
    },
    {
      name: "exhausted uses come before the mandate total",
      expected: "UsesExhausted",
      setup: (c) => {
        const m = mandateOf(c, 1);
        m.uses = 10;
        m.spent = m.max_total;
      },
    },
    {
      name: "the mandate total comes before a duplicate invoice",
      expected: "OverMandateTotal",
      setup: (c) => {
        withExistingSpend(c);
        mandateOf(c, 1).spent = "995000000";
      },
    },
    {
      name: "a duplicate invoice comes before a duplicate ref",
      expected: "DuplicateInvoice",
      setup: withExistingSpend,
    },
    {
      name: "a duplicate ref comes before the daily backstop",
      expected: "DuplicateRef",
      setup: (c) => {
        withExistingSpend(c);
        c.config.daily_backstop = "1";
      },
      request: { invoice_hash: "ee".repeat(32) },
    },
    {
      name: "the daily backstop is the last check",
      expected: "OverDailyBackstop",
      setup: (c) => {
        c.config.daily_backstop = "24999999";
      },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const { chain, clock } = scenario();
      c.setup?.(chain, clock);
      expect(chain.checkSpend(req(c.request), c.signer ?? agent).code).toBe(c.expected);
    });
  }

  it("a mandate is valid until the instant before expires_at_ns (now >= expires is expired)", () => {
    const { chain, clock } = scenario();
    clock.now = expiresAt - 1n;
    expect(chain.checkSpend(req(), agent).ok).toBe(true);
    clock.now = expiresAt;
    expect(chain.checkSpend(req(), agent).code).toBe("MandateExpired");
  });

  it("MandateInactive is for a revoked mandate only; an exhausted one is UsesExhausted or OverMandateTotal", () => {
    const { chain } = scenario();
    const m = mandateOf(chain, 1);
    m.uses = m.max_uses;
    expect(chain.checkSpend(req(), agent).code).toBe("UsesExhausted");
    m.uses = 0;
    m.spent = "990000000";
    expect(chain.checkSpend(req(), agent).code).toBe("OverMandateTotal");
    m.status = "revoked";
    expect(chain.checkSpend(req(), agent).code).toBe("MandateInactive");
  });

  it("amounts exactly at a limit pass and one over is refused", () => {
    const { chain } = scenario();
    const m = mandateOf(chain, 1);
    expect(chain.checkSpend(req({ amount: "100000000" }), agent).ok).toBe(true);
    expect(chain.checkSpend(req({ amount: "100000001" }), agent).code).toBe("OverPerPayment");
    m.spent = "900000000";
    m.reserved = "75000000";
    expect(chain.checkSpend(req({ amount: "25000000" }), agent).ok).toBe(true);
    expect(chain.checkSpend(req({ amount: "25000001" }), agent).code).toBe("OverMandateTotal");
    m.spent = "0";
    m.reserved = "0";
    m.uses = 9;
    expect(chain.checkSpend(req(), agent).ok).toBe(true);
    m.uses = 10;
    expect(chain.checkSpend(req(), agent).code).toBe("UsesExhausted");
  });

  it("adds with u128 saturation like the contract (checks.rs:53, :63)", () => {
    const { chain } = scenario();
    const m = mandateOf(chain, 1);
    m.max_total = U128_MAX.toString();
    m.max_per_payment = U128_MAX.toString();
    m.spent = (U128_MAX - 5n).toString();
    // saturating_add gives u128::MAX, which is not > max_total: the check passes. A plain sum would refuse it.
    const verdict = chain.checkSpend(req({ amount: "100" }), agent);
    expect(verdict.code).not.toBe("OverMandateTotal");
    chain.config.daily_backstop = U128_MAX.toString();
    expect(chain.checkSpend(req({ amount: "100" }), agent).ok).toBe(true);
  });

  it("holds exactly above approval_above, not at it", () => {
    const { chain } = scenario();
    expect(chain.checkSpend(req({ amount: "50000000" }), agent).would_hold).toBe(false);
    expect(chain.checkSpend(req({ amount: "50000001" }), agent).would_hold).toBe(true);
  });

  it("counts the daily backstop within the current UTC day only, and a rejected hold gives it back", () => {
    const { chain, clock } = scenario();
    mandateOf(chain, 1).max_uses = 100;
    for (let i = 1; i <= 10; i++) {
      const hash = i.toString(16).padStart(2, "0").repeat(32);
      expect(
        spend(chain, req({ amount: "50000000", invoice_hash: hash, ref: `D-${i}` })).value,
      ).toMatchObject({ status: "paid" });
    }
    // 10 x 50 USDC = exactly the 500 USDC backstop: one more unit is refused (checks.rs:63 is `>`).
    const next = req({ amount: "1", invoice_hash: "ff".repeat(32), ref: "D-X" });
    expect(chain.checkSpend(next, agent).code).toBe("OverDailyBackstop");
    clock.now += DAY;
    expect(chain.checkSpend(next, agent).ok).toBe(true);

    const second = scenario();
    mandateOf(second.chain, 1).max_uses = 100;
    for (let i = 1; i <= 8; i++) {
      const hash = i.toString(16).padStart(2, "0").repeat(32);
      spend(second.chain, req({ amount: "50000000", invoice_hash: hash, ref: `D-${i}` }));
    }
    spend(second.chain, req({ amount: "75000000", invoice_hash: "aa".repeat(32), ref: "HELD" })); // spend 9, held: its reservation counts at once
    const probe = req({ amount: "50000000", invoice_hash: "bb".repeat(32), ref: "N" });
    expect(second.chain.checkSpend(probe, agent).code).toBe("OverDailyBackstop"); // 400 + 75 + 50 > 500
    approverCall(second.chain, "reject", 9);
    expect(second.chain.checkSpend(probe, agent).ok).toBe(true); // 400 + 50 <= 500
  });

  it("measures a ref in BYTES (validate.rs is_ref uses len()): 64 pass, 65 do not, multibyte counts bytes", () => {
    const { chain } = scenario();
    const code = (ref: string) => chain.checkSpend(req({ ref }), agent).code;
    expect(code("R".repeat(64))).toBeNull();
    expect(code("R".repeat(65))).toBe("InvalidInput");
    expect(code("")).toBe("InvalidInput");
    expect(code("\u00e9".repeat(32))).toBeNull(); // 32 characters, 64 bytes
    expect(code("\u00e9".repeat(33))).toBe("InvalidInput"); // 33 characters, 66 bytes
    expect(code("\u20ac".repeat(21))).toBeNull(); // 21 characters, 63 bytes
    expect(code("\u20ac".repeat(22))).toBe("InvalidInput"); // 22 characters, 66 bytes
    expect(code("\u{1F600}".repeat(16))).toBeNull(); // 16 characters (32 UTF-16 units), 64 bytes
    expect(code("\u{1F600}".repeat(17))).toBe("InvalidInput"); // 68 bytes
    // and spend accepts the 64-byte ref and stores it as given
    const ref = "\u00e9".repeat(32);
    expect(spend(chain, req({ ref })).value).toEqual({ spend_id: 1, status: "paid" });
    expect(chain.spends[0]?.ref).toBe(ref);
  });

  it("saturates the day total as well (checks.rs:63): a huge existing total plus an amount is u128::MAX, not an overflow", () => {
    const { chain, clock } = scenario();
    const m = mandateOf(chain, 1);
    chain.spends.push({
      id: 1,
      mandate_id: 1,
      amount: (U128_MAX - 5n).toString(),
      invoice_hash: "98".repeat(32),
      ref: "BIG",
      decision_hash: "00".repeat(32),
      agent_pk: agent,
      destination: m.payee,
      status: "pending",
      created_at_ns: clock.now.toString(),
      held_until_ns: null,
      memo: null,
    });
    const probe = req({ amount: "100", invoice_hash: "97".repeat(32), ref: "SMALL" });
    chain.config.daily_backstop = U128_MAX.toString();
    expect(chain.checkSpend(probe, agent)).toEqual({ ok: true, code: null, would_hold: false });
    chain.config.daily_backstop = (U128_MAX - 1n).toString();
    expect(chain.checkSpend(probe, agent).code).toBe("OverDailyBackstop");
  });

  it("matches an independent transcription of Vault::evaluate over a deterministic grid", () => {
    // The oracle is transcribed from checks.rs:17-71 (order = lines 23-65), as packages/core/test/policy.test.ts does.
    // u128::saturating_add
    const sat = (a: bigint, b: bigint) => {
      const sum = a + b;
      // biome-ignore lint/complexity/useMathMinMax: bigint operands, Math.min takes numbers
      return sum > U128_MAX ? U128_MAX : sum;
    };
    // mulberry32: every bit is well mixed. (An LCG's low bits cycle with a tiny period: the first version of this
    // grid used `seed % n` and never got past the first five checks.)
    let state = 20_261_101;
    const random = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    const pick = <T>(options: readonly T[]): T =>
      options[Math.floor(random() * options.length)] as T;
    const times = <T>(n: number, value: T): T[] => Array.from({ length: n }, () => value);
    const counts = new Map<string, number>();
    const mismatches: string[] = [];
    for (let n = 0; n < 3000; n++) {
      const other = TEST_KEYS.other.publicKey;
      const p = {
        signer: pick([...times(7, agent), other]),
        mandateId: pick([...times(9, 1), 99, 0]),
        frozen: pick([...times(9, false), true]),
        revoked: pick([...times(9, false), true]),
        expiryOffset: pick([-1n, 0n, ...times(8, 1n), ...times(4, 100n)]),
        mandateAgent: pick([...times(9, agent), other]),
        amount: pick([
          "0",
          "1",
          ...times(6, "25000000"),
          ...times(2, "50000000"),
          ...times(2, "50000001"),
          "100000000",
          "100000001",
        ]),
        uses: pick([...times(6, 0), 9, 9, 10, 10]),
        spentPlusReserved: pick([
          ...times(5, 0n),
          900_000_000n,
          975_000_000n,
          975_000_000n,
          999_999_999n,
          1_000_000_000n,
        ]),
        dupInvoice: pick([...times(6, false), true]),
        dupRef: pick([...times(6, false), true]),
        dayTotal: pick([...times(4, 0n), 450_000_000n, 475_000_000n, 500_000_000n]),
        badShape: pick([...times(9, false), true]),
      };
      const { chain, clock } = scenario();
      const m = mandateOf(chain, 1);
      m.status = p.revoked ? "revoked" : "active";
      m.agent_pk = p.mandateAgent;
      m.uses = p.uses;
      m.spent = p.spentPlusReserved.toString();
      chain.config.frozen = p.frozen;
      m.expires_at_ns = (clock.now + p.expiryOffset).toString();
      const request = req({
        mandate_id: p.mandateId,
        amount: p.amount,
        ref: p.badShape ? "" : "REF-NEW",
      });
      // Existing spends are inserted as already-settled rows so they do not touch the mandate counters above.
      if (p.dupInvoice)
        chain.spends.push({
          id: 1,
          mandate_id: 1,
          amount: "1",
          invoice_hash: request.invoice_hash,
          ref: "OLD-1",
          decision_hash: "00".repeat(32),
          agent_pk: agent,
          destination: m.payee,
          status: "paid",
          created_at_ns: (clock.now - 10n * DAY).toString(),
          held_until_ns: null,
          memo: null,
        });
      if (p.dupRef)
        chain.spends.push({
          id: chain.spends.length + 1,
          mandate_id: 1,
          amount: "1",
          invoice_hash: "99".repeat(32),
          ref: "REF-NEW",
          decision_hash: "00".repeat(32),
          agent_pk: agent,
          destination: m.payee,
          status: "paid",
          created_at_ns: (clock.now - 10n * DAY).toString(),
          held_until_ns: null,
          memo: null,
        });
      if (p.dayTotal > 0n)
        chain.spends.push({
          id: chain.spends.length + 1,
          mandate_id: 1,
          amount: p.dayTotal.toString(),
          invoice_hash: "98".repeat(32),
          ref: "TODAY",
          decision_hash: "00".repeat(32),
          agent_pk: agent,
          destination: m.payee,
          status: "pending",
          created_at_ns: clock.now.toString(),
          held_until_ns: null,
          memo: null,
        });

      const amount = BigInt(p.amount);
      let expected: { code: string | null; hold: boolean };
      if (p.signer !== agent) expected = { code: "NotAgent", hold: false };
      else if (p.badShape) expected = { code: "InvalidInput", hold: false };
      else if (p.frozen) expected = { code: "Frozen", hold: false };
      else if (p.mandateId !== 1) expected = { code: "NoMandate", hold: false };
      else if (p.revoked) expected = { code: "MandateInactive", hold: false };
      else if (clock.now >= BigInt(m.expires_at_ns))
        expected = { code: "MandateExpired", hold: false };
      else if (p.mandateAgent !== p.signer) expected = { code: "NotMandateAgent", hold: false };
      else if (amount === 0n) expected = { code: "ZeroAmount", hold: false };
      else if (amount > 100_000_000n) expected = { code: "OverPerPayment", hold: false };
      else if (p.uses >= 10) expected = { code: "UsesExhausted", hold: false };
      else if (sat(p.spentPlusReserved, amount) > 1_000_000_000n)
        expected = { code: "OverMandateTotal", hold: false };
      else if (p.dupInvoice) expected = { code: "DuplicateInvoice", hold: false };
      else if (p.dupRef) expected = { code: "DuplicateRef", hold: false };
      else if (sat(p.dayTotal, amount) > 500_000_000n)
        expected = { code: "OverDailyBackstop", hold: false };
      else expected = { code: null, hold: amount > 50_000_000n };

      const got = chain.checkSpend(request, p.signer);
      counts.set(expected.code ?? "ok", (counts.get(expected.code ?? "ok") ?? 0) + 1);
      if (
        got.code !== expected.code ||
        (expected.code === null && got.would_hold !== expected.hold)
      ) {
        mismatches.push(
          `#${n} ${JSON.stringify({ ...p, signer: p.signer === agent ? "agent" : "other", mandateAgent: p.mandateAgent === agent ? "agent" : "other" }, (_k, v) => (typeof v === "bigint" ? v.toString() : v))} expected ${JSON.stringify(expected)} got ${JSON.stringify(got)}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
    // The grid must actually reach every check, in order, and the success path: otherwise agreement proves nothing.
    const everyOutcome = [
      "NotAgent",
      "InvalidInput",
      "Frozen",
      "NoMandate",
      "MandateInactive",
      "MandateExpired",
      "NotMandateAgent",
      "ZeroAmount",
      "OverPerPayment",
      "UsesExhausted",
      "OverMandateTotal",
      "DuplicateInvoice",
      "DuplicateRef",
      "OverDailyBackstop",
      "ok",
    ];
    expect([...counts.keys()].sort()).toEqual([...everyOutcome].sort());
    for (const outcome of everyOutcome) {
      expect(
        counts.get(outcome) ?? 0,
        `the grid reaches ${outcome} too rarely`,
      ).toBeGreaterThanOrEqual(20);
    }
  });

  it("answers a hooked check_spend code without looking at state", () => {
    const chain = createScenarioChain();
    chain.hooks.checkSpendCode = "Frozen";
    expect(chain.checkSpend(req(), agent)).toEqual({
      ok: false,
      code: "Frozen",
      would_hold: false,
    });
  });

  it("serves check_spend as a view and rejects a request the contract could not deserialize", () => {
    const chain = createScenarioChain();
    expect(chain.view(SCENARIO_VAULT, "check_spend", { request: req(), signer_pk: agent })).toEqual(
      { ok: true, code: null, would_hold: false },
    );
    expect(() =>
      chain.view(SCENARIO_VAULT, "check_spend", {
        request: req({ amount: "abc" }),
        signer_pk: agent,
      }),
    ).toThrow(FakeRawPanic);
    expect(() =>
      chain.view(SCENARIO_VAULT, "check_spend", { request: req(), signer_pk: "ed25519:nope" }),
    ).toThrow(FakeRawPanic);
    expect(() =>
      chain.view(SCENARIO_VAULT, "check_spend", {
        request: { ...req(), mandate_id: "1" },
        signer_pk: agent,
      }),
    ).toThrow(FakeRawPanic);
  });
});

describe("spend (spend.rs: reserve, payout, callbacks)", () => {
  it("is a vault-signed call by a registered agent key", () => {
    const chain = createScenarioChain();
    expect(panicCode(() => spend(chain, req(), { signerId: "someone.testnet" }))).toBe(
      "PROBARION:NotAgent",
    );
    expect(panicCode(() => spend(chain, req(), { signerPk: TEST_KEYS.other.publicKey }))).toBe(
      "PROBARION:NotAgent",
    );
    expect(chain.spends).toHaveLength(0);
  });

  it("refuses an attached deposit as near-sdk does for a non-payable method, and a request it cannot deserialize", () => {
    const chain = createScenarioChain();
    expect(() => spend(chain, req(), { deposit: 1n })).toThrow(/doesn't accept deposit/);
    expect(() => spend(chain, req({ amount: "12.5" }))).toThrow(FakeRawPanic);
    expect(() => spend(chain, { ...req(), mandate_id: "1" } as unknown as SpendRequest)).toThrow(
      FakeRawPanic,
    );
    expect(() => spend(chain, { mandate_id: 1 } as unknown as SpendRequest)).toThrow(
      /missing field/,
    );
    expect(chain.spends).toHaveLength(0);
  });

  it("makes ids start at 1 and reserves then settles a NEAR payout with the contract's events", () => {
    const { chain } = scenario();
    const out = spend(chain, req());
    expect(out.value).toEqual({ spend_id: 1, status: "paid" });
    const m = mandateOf(chain, 1);
    expect(m).toMatchObject({ spent: "25000000", reserved: "0", uses: 1, status: "active" });
    expect(chain.spends[0]).toMatchObject({
      id: 1,
      mandate_id: 1,
      status: "paid",
      memo: null,
      held_until_ns: null,
      created_at_ns: SCENARIO_NOW.toString(),
      agent_pk: agent,
    });
    // spend.rs:136-144: spend_submitted comes from the spend receipt; the callback emits spend_paid (spend.rs:202-208).
    expect(eventsOf(out.vaultLogs).map((e) => e.event)).toEqual(["spend_submitted"]);
    expect(eventsOf(out.vaultLogs)[0]?.data).toEqual({
      spend_id: 1,
      mandate_id: 1,
      amount: "25000000",
      invoice_hash: "ab".repeat(32),
      decision_hash: "cd".repeat(32),
      destination: { type: "near", account_id: SCENARIO_NEAR_PAYEE },
    });
    expect(out.receipts.map((r) => r.executor)).toEqual([chain.config.usdc, chain.vaultId]);
    // spend.rs:148-156: ft_transfer with the memo `probarion:<spend_id>`.
    expect(JSON.parse((out.receipts[0]?.logs[0] ?? "").slice("EVENT_JSON:".length))).toEqual({
      standard: "nep141",
      version: "1.0.0",
      event: "ft_transfer",
      data: [
        {
          old_owner_id: chain.vaultId,
          new_owner_id: SCENARIO_NEAR_PAYEE,
          amount: "25000000",
          memo: "probarion:1",
        },
      ],
    });
    expect(eventsOf(out.receipts[1]?.logs ?? [])[0]).toMatchObject({
      event: "spend_paid",
      data: {
        spend_id: 1,
        mandate_id: 1,
        amount: "25000000",
        destination: { type: "near", account_id: SCENARIO_NEAR_PAYEE },
      },
    });
  });

  it("burns for an Intents payee in the testnet stub shape: mt_burn and ft_burn in ONE receipt of the stub (R5)", () => {
    const { chain } = scenario();
    const out = spend(chain, req({ mandate_id: 2, ref: "B-1" }));
    expect(out.value).toEqual({ spend_id: 1, status: "burned" });
    const asset = chain.config.allowed_assets[0] ?? "";
    expect(out.receipts.map((r) => r.executor)).toEqual([chain.config.intents, chain.vaultId]);
    const burnReceipt = out.receipts[0];
    expect(burnReceipt?.logs).toHaveLength(2);
    // The layout of testnet tx 3u4ffrwpiwLoNV6cU72NHLVBAMq729NwLs6ixDLdcvYe on v0.probarion.testnet.
    expect(JSON.parse((burnReceipt?.logs[0] ?? "").slice("EVENT_JSON:".length))).toEqual({
      standard: "nep245",
      version: "1.0.0",
      event: "mt_burn",
      data: [
        {
          owner_id: chain.vaultId,
          token_ids: [`nep141:${asset}`],
          amounts: ["25000000"],
          memo: "withdraw",
        },
      ],
    });
    expect(JSON.parse((burnReceipt?.logs[1] ?? "").slice("EVENT_JSON:".length))).toEqual({
      standard: "nep141",
      version: "1.0.0",
      event: "ft_burn",
      data: [
        {
          owner_id: chain.config.intents,
          amount: "25000000",
          memo: `WITHDRAW_TO:${SCENARIO_BASE_ADDRESS}`,
        },
      ],
    });
    expect(burnReceipt?.value).toBe("25000000"); // ft_withdraw resolves to the amount (spend.rs:41-42)
    expect(eventsOf(out.receipts[1]?.logs ?? [])[0]).toMatchObject({
      event: "spend_burned",
      data: {
        spend_id: 1,
        mandate_id: 2,
        amount: "25000000",
        chain: "base",
        address: SCENARIO_BASE_ADDRESS,
        asset,
        memo: `WITHDRAW_TO:${SCENARIO_BASE_ADDRESS}`,
      },
    });
    expect(chain.intents.balances[`nep141:${asset}`]).toBe("75000000");
  });

  it("burns in the mainnet shape: mt_burn by intents.near, ft_burn by a SEPARATE receipt of the POA asset (R5)", () => {
    const { chain } = scenario({ burnShape: "mainnet" });
    const out = spend(chain, req({ mandate_id: 2, ref: "B-1" }));
    const asset = chain.config.allowed_assets[0] ?? "";
    expect(out.receipts.map((r) => r.executor)).toEqual([
      chain.config.intents,
      asset,
      chain.vaultId,
    ]);
    expect(out.receipts[0]?.logs).toHaveLength(1);
    expect(out.receipts[0]?.logs[0]).toContain('"event":"mt_burn"');
    expect(out.receipts[1]?.logs).toHaveLength(1);
    expect(JSON.parse((out.receipts[1]?.logs[0] ?? "").slice("EVENT_JSON:".length))).toMatchObject({
      standard: "nep141",
      event: "ft_burn",
      data: [{ owner_id: chain.config.intents, memo: `WITHDRAW_TO:${SCENARIO_BASE_ADDRESS}` }],
    });
    expect(out.value).toEqual({ spend_id: 1, status: "burned" });
  });

  it("defaults the burn shape to the stub on a testnet intents account and to mainnet on intents.near", () => {
    expect(createScenarioChain().burnShape).toBe("stub");
    const chain = createScenarioChain();
    const mainnet = new FakeChain({
      vaultId: "v.near",
      config: { ...chain.config, intents: "intents.near" },
      codeHash: chain.codeHash,
    });
    expect(mainnet.burnShape).toBe("mainnet");
    expect(
      new FakeChain({
        vaultId: "v.near",
        config: { ...chain.config, intents: "intents.near" },
        codeHash: chain.codeHash,
        burnShape: "stub",
      }).burnShape,
    ).toBe("stub");
  });

  it("holds a spend above approval_above: reserved, a use taken, spend_held carries held_until_ns", () => {
    const { chain } = scenario();
    const out = spend(chain, req({ amount: "75000000" }));
    expect(out.value).toEqual({ spend_id: 1, status: "held" });
    expect(out.receipts).toEqual([]);
    const heldUntil = (SCENARIO_NOW + BigInt(chain.config.held_ttl_ns)).toString();
    expect(chain.spends[0]).toMatchObject({ status: "held", held_until_ns: heldUntil });
    expect(mandateOf(chain, 1)).toMatchObject({ reserved: "75000000", spent: "0", uses: 1 });
    expect(eventsOf(out.vaultLogs)).toMatchObject([
      {
        event: "spend_held",
        data: {
          spend_id: 1,
          mandate_id: 1,
          amount: "75000000",
          invoice_hash: "ab".repeat(32),
          decision_hash: "cd".repeat(32),
          held_until_ns: heldUntil,
        },
      },
    ]);
  });

  it("leaves no state behind when a spend panics, and refuses an Intents payee whose asset left the allow-list", () => {
    const { chain } = scenario();
    chain.config.allowed_assets = [];
    expect(panicCode(() => spend(chain, req({ mandate_id: 2 })))).toBe("PROBARION:AssetNotAllowed");
    expect(chain.spends).toHaveLength(0);
    expect(mandateOf(chain, 2)).toMatchObject({ reserved: "0", uses: 0 });
    // A held spend reaches no payout at spend time (spend.rs:23-25): it is held, and approve then refuses (spend.rs:130-134).
    expect(spend(chain, req({ mandate_id: 2, amount: "75000000" })).value).toEqual({
      spend_id: 1,
      status: "held",
    });
    expect(panicCode(() => approverCall(chain, "approve", 1))).toBe("PROBARION:AssetNotAllowed");
    expect(chain.spends[0]?.status).toBe("held");
  });

  it("releases the reservation, the use and the invoice when the payout fails; the ref stays consumed (spend.rs:213-257)", () => {
    const { chain } = scenario();
    chain.hooks.payoutFailure = "ft_transfer_failed";
    const out = spend(chain, req());
    expect(out.value).toEqual({ spend_id: 1, status: "failed" });
    expect(out.receipts[0]?.failure).toBeDefined();
    expect(eventsOf(out.receipts.at(-1)?.logs ?? [])).toMatchObject([
      {
        event: "spend_failed",
        data: { spend_id: 1, mandate_id: 1, amount: "25000000", reason: "ft_transfer_failed" },
      },
    ]);
    expect(mandateOf(chain, 1)).toMatchObject({
      reserved: "0",
      spent: "0",
      uses: 0,
      status: "active",
    });
    expect(chain.spends[0]?.status).toBe("failed");
    chain.hooks.payoutFailure = null;
    expect(chain.checkSpend(req({ ref: "INV-2" }), agent).ok).toBe(true); // the invoice is free again
    expect(chain.checkSpend(req(), agent).code).toBe("DuplicateRef"); // the ref never is
  });

  it("treats a withdrawal that returns 0, or an intents balance that is too low, as a failed payout", () => {
    const refunded = scenario();
    refunded.chain.hooks.payoutFailure = "ft_withdraw_refunded";
    const a = spend(refunded.chain, req({ mandate_id: 2 }));
    expect(a.value).toEqual({ spend_id: 1, status: "failed" });
    expect(a.receipts[0]?.value).toBe("0");
    expect(eventsOf(a.receipts.at(-1)?.logs ?? [])[0]).toMatchObject({
      event: "spend_failed",
      data: { reason: "ft_withdraw_refunded" },
    });

    const poor = scenario({ intentsBalance: "1000" });
    const b = spend(poor.chain, req({ mandate_id: 2 }));
    expect(b.value).toEqual({ spend_id: 1, status: "failed" });
    expect(b.receipts[0]?.failure).toMatch(/insufficient balance/);
    expect(eventsOf(b.receipts.at(-1)?.logs ?? [])[0]).toMatchObject({
      data: { reason: "ft_withdraw_failed" },
    });
    expect(mandateOf(poor.chain, 2)).toMatchObject({ reserved: "0", spent: "0", uses: 0 });
    expect(Object.values(poor.chain.intents.balances)).toEqual(["1000"]);
  });

  it("derives exhausted from spent (not reserved) >= max_total, as Mandate::status does (types.rs:198)", () => {
    const { chain } = scenario();
    const m = mandateOf(chain, 1);
    m.max_total = "100000000";
    m.max_per_payment = "100000000";
    expect(spend(chain, req({ amount: "75000000" })).value).toMatchObject({ status: "held" });
    expect(m.status).toBe("active"); // 75 reserved of 100: still active, and reserved does not count
    expect(chain.view(SCENARIO_VAULT, "get_mandate", { mandate_id: 1 })).toMatchObject({
      status: "active",
    });
    approverCall(chain, "approve", 1);
    expect(m).toMatchObject({ spent: "75000000", reserved: "0", status: "active" });
    m.spent = "100000000";
    expect(chain.view(SCENARIO_VAULT, "get_mandate", { mandate_id: 1 })).toMatchObject({
      status: "exhausted",
    });
  });
});

describe("held spends (held.rs: approve, reject, expire_held)", () => {
  const held = () => {
    const env = scenario();
    spend(env.chain, req({ amount: "75000000" }));
    return env;
  };
  const heldUntil = SCENARIO_NOW + 259_200_000_000_000n;

  it("approve pays out and settles; events are spend_approved then spend_submitted (held.rs:22-27)", () => {
    const { chain } = held();
    const out = approverCall(chain, "approve", 1);
    expect(out.value).toEqual({ spend_id: 1, status: "paid" });
    expect(eventsOf(out.vaultLogs)).toMatchObject([
      { event: "spend_approved", data: { spend_id: 1, by: approver } },
      { event: "spend_submitted", data: { spend_id: 1, amount: "75000000" } },
    ]);
    expect(eventsOf(out.vaultLogs)[0]?.dataKeys).toEqual(["spend_id", "by"]);
    expect(mandateOf(chain, 1)).toMatchObject({ spent: "75000000", reserved: "0", uses: 1 });
    expect(chain.spends[0]?.status).toBe("paid");
  });

  it("approve checks the approver, then one yocto, then frozen, then held, then expiry, then the mandate", () => {
    const a = held();
    expect(
      panicCode(() => approverCall(a.chain, "approve", 1, { signerId: "owner.testnet" })),
    ).toBe("PROBARION:NotApprover");
    expect(
      panicCode(() => approverCall(a.chain, "approve", 1, { signerId: a.chain.vaultId })),
    ).toBe("PROBARION:NotApprover");
    expect(panicCode(() => approverCall(a.chain, "approve", 1, { deposit: 0n }))).toBe(
      "PROBARION:RequiresOneYocto",
    );
    expect(panicCode(() => approverCall(a.chain, "approve", 1, { deposit: 2n }))).toBe(
      "PROBARION:RequiresOneYocto",
    );
    a.chain.config.frozen = true;
    expect(panicCode(() => approverCall(a.chain, "approve", 1))).toBe("PROBARION:Frozen");
    a.chain.config.frozen = false;
    expect(panicCode(() => approverCall(a.chain, "approve", 2))).toBe("PROBARION:NotHeld");
    a.clock.now = heldUntil + 1n;
    expect(panicCode(() => approverCall(a.chain, "approve", 1))).toBe("PROBARION:HoldExpired");
    a.clock.now = heldUntil;
    mandateOf(a.chain, 1).status = "revoked";
    expect(panicCode(() => approverCall(a.chain, "approve", 1))).toBe("PROBARION:MandateInactive");
    mandateOf(a.chain, 1).status = "active";
    expect(approverCall(a.chain, "approve", 1).value).toEqual({ spend_id: 1, status: "paid" }); // exactly at the expiry instant is allowed
    expect(panicCode(() => approverCall(a.chain, "approve", 1))).toBe("PROBARION:NotHeld"); // a paid spend is not held
  });

  it("reject releases the reservation and the use, frees the invoice and keeps the ref", () => {
    const { chain } = held();
    const out = approverCall(chain, "reject", 1);
    expect(out.value).toBeUndefined();
    expect(eventsOf(out.vaultLogs)).toMatchObject([
      { event: "spend_rejected", data: { spend_id: 1, by: approver } },
    ]);
    expect(chain.spends[0]?.status).toBe("rejected");
    expect(mandateOf(chain, 1)).toMatchObject({ reserved: "0", spent: "0", uses: 0 });
    expect(chain.checkSpend(req({ ref: "INV-2" }), agent).ok).toBe(true);
    expect(chain.checkSpend(req(), agent).code).toBe("DuplicateRef");
    expect(panicCode(() => approverCall(chain, "reject", 1))).toBe("PROBARION:NotHeld");
    expect(panicCode(() => approverCall(chain, "reject", 1, { signerId: "owner.testnet" }))).toBe(
      "PROBARION:NotApprover",
    );
  });

  it("reject needs exactly one yocto, and ignores frozen (held.rs:31-41 has no frozen check)", () => {
    const a = held();
    expect(panicCode(() => approverCall(a.chain, "reject", 1, { deposit: 0n }))).toBe(
      "PROBARION:RequiresOneYocto",
    );
    expect(panicCode(() => approverCall(a.chain, "reject", 1, { deposit: 2n }))).toBe(
      "PROBARION:RequiresOneYocto",
    );
    expect(a.chain.spends[0]?.status).toBe("held");
    a.chain.config.frozen = true;
    expect(approverCall(a.chain, "reject", 1).vaultLogs[0]).toContain('"spend_rejected"');
    expect(a.chain.spends[0]?.status).toBe("rejected");
  });

  it("approve pins the ORDER of its checks when two are broken at once (held.rs:9-28)", () => {
    const code = (run: () => unknown) => panicCode(run).replace("PROBARION:", "");
    // NotApprover before RequiresOneYocto
    const a = held();
    expect(
      code(() => approverCall(a.chain, "approve", 1, { signerId: "owner.testnet", deposit: 0n })),
    ).toBe("NotApprover");
    // RequiresOneYocto before Frozen
    a.chain.config.frozen = true;
    expect(code(() => approverCall(a.chain, "approve", 1, { deposit: 0n }))).toBe(
      "RequiresOneYocto",
    );
    // Frozen before NotHeld
    expect(code(() => approverCall(a.chain, "approve", 99))).toBe("Frozen");
    a.chain.config.frozen = false;
    // NotHeld before HoldExpired and MandateInactive: the spend is paid, its mandate is revoked, the clock is past the hold
    expect(approverCall(a.chain, "approve", 1).value).toMatchObject({ status: "paid" });
    mandateOf(a.chain, 1).status = "revoked";
    a.clock.now = heldUntil + 1n;
    expect(code(() => approverCall(a.chain, "approve", 1))).toBe("NotHeld");

    // HoldExpired before MandateInactive
    const b = held();
    mandateOf(b.chain, 1).status = "revoked";
    b.clock.now = heldUntil + 1n;
    expect(code(() => approverCall(b.chain, "approve", 1))).toBe("HoldExpired");

    // MandateInactive before AssetNotAllowed, and AssetNotAllowed before the gas floor
    const c = scenario();
    spend(c.chain, req({ mandate_id: 2, amount: "75000000" }));
    c.chain.config.allowed_assets = [];
    mandateOf(c.chain, 2).status = "revoked";
    expect(code(() => approverCall(c.chain, "approve", 1, { gas: 1n }))).toBe("MandateInactive");
    mandateOf(c.chain, 2).status = "active";
    expect(code(() => approverCall(c.chain, "approve", 1, { gas: 1n }))).toBe("AssetNotAllowed");
    c.chain.config.allowed_assets = ["base-usdc.probarion.testnet"];
    expect(() => approverCall(c.chain, "approve", 1, { gas: 1n })).toThrow(FakeVmError);
    expect(c.chain.spends[0]?.status).toBe("held"); // nothing moved on any refusal
  });

  it("expire_held is open to anyone, but only after held_until_ns (held.rs:45)", () => {
    const { chain, clock } = held();
    const call = () =>
      chain.applyFunctionCall({
        signerId: "anyone.testnet",
        signerPk: TEST_KEYS.other.publicKey,
        receiverId: chain.vaultId,
        method: "expire_held",
        args: { spend_id: 1 },
        deposit: 0n,
      });
    clock.now = heldUntil;
    expect(panicCode(call)).toBe("PROBARION:HoldNotExpired");
    clock.now = heldUntil + 1n;
    const out = call();
    expect(eventsOf(out.vaultLogs)).toMatchObject([
      { event: "spend_expired", data: { spend_id: 1 } },
    ]);
    expect(eventsOf(out.vaultLogs)[0]?.dataKeys).toEqual(["spend_id"]);
    expect(chain.spends[0]?.status).toBe("expired");
    expect(mandateOf(chain, 1)).toMatchObject({ reserved: "0", uses: 0 });
    expect(panicCode(call)).toBe("PROBARION:NotHeld");
  });
});

describe("anchor (anchors.rs)", () => {
  const root = "ab".repeat(32);

  it("checks the ledger key first, then seq, then root and count", () => {
    const { chain } = scenario();
    expect(panicCode(() => anchorCall(chain, { seq: 3, root: "bad", count: 0 }, agent))).toBe(
      "PROBARION:NotLedgerKey",
    );
    expect(panicCode(() => anchorCall(chain, { seq: 3, root: "bad", count: 0 }))).toBe(
      "PROBARION:BadSeq",
    );
    expect(panicCode(() => anchorCall(chain, { seq: 1, root: "bad", count: 1 }))).toBe(
      "PROBARION:InvalidInput",
    );
    expect(panicCode(() => anchorCall(chain, { seq: 1, root: root.toUpperCase(), count: 1 }))).toBe(
      "PROBARION:InvalidInput",
    );
    expect(panicCode(() => anchorCall(chain, { seq: 1, root: `${root}0`, count: 1 }))).toBe(
      "PROBARION:InvalidInput",
    );
    expect(panicCode(() => anchorCall(chain, { seq: 1, root, count: 0 }))).toBe(
      "PROBARION:InvalidInput",
    );
    expect(chain.anchors).toHaveLength(0);
  });

  it("starts at seq 1, keeps count non-decreasing (a repeat is allowed) and emits ledger_anchored", () => {
    const { chain } = scenario();
    const first = anchorCall(chain, { seq: 1, root, count: 3 });
    expect(first.value).toBeUndefined(); // the method returns (): an empty SuccessValue
    expect(eventsOf(first.vaultLogs)).toMatchObject([
      { event: "ledger_anchored", data: { seq: 1, root, count: 3 } },
    ]);
    expect(eventsOf(first.vaultLogs)[0]?.dataKeys).toEqual(["seq", "root", "count"]);
    expect(panicCode(() => anchorCall(chain, { seq: 2, root, count: 2 }))).toBe(
      "PROBARION:InvalidInput",
    ); // count went down
    anchorCall(chain, { seq: 2, root, count: 3 }); // repeating the previous count is fine (anchors.rs test)
    anchorCall(chain, { seq: 3, root: "cd".repeat(32), count: 5 });
    expect(chain.anchors.map((a) => [a.seq, a.count])).toEqual([
      [1, 3],
      [2, 3],
      [3, 5],
    ]);
    expect(chain.anchors[0]).toEqual({
      seq: 1,
      root,
      count: 3,
      at_ns: SCENARIO_NOW.toString(),
      ledger_key: TEST_KEYS.ledger.publicKey,
    });
  });

  it("only the vault-signed call counts, and a rotated-out ledger key can no longer anchor", () => {
    const { chain } = scenario();
    expect(
      panicCode(() =>
        chain.applyFunctionCall({
          signerId: "other.testnet",
          signerPk: TEST_KEYS.ledger.publicKey,
          receiverId: chain.vaultId,
          method: "anchor",
          args: { seq: 1, root, count: 1 },
          deposit: 0n,
        }),
      ),
    ).toBe("PROBARION:NotLedgerKey");
    chain.config.ledger_key = TEST_KEYS.other.publicKey;
    expect(panicCode(() => anchorCall(chain, { seq: 1, root, count: 1 }))).toBe(
      "PROBARION:NotLedgerKey",
    );
    chain.config.ledger_key = null;
    expect(panicCode(() => anchorCall(chain, { seq: 1, root, count: 1 }))).toBe(
      "PROBARION:NotLedgerKey",
    );
  });

  it("refuses arguments it cannot deserialize before running the body", () => {
    const { chain } = scenario();
    expect(() => anchorCall(chain, { seq: "1", root, count: 1 })).toThrow(FakeRawPanic);
    expect(() => anchorCall(chain, { seq: 1, root })).toThrow(/missing field/);
    expect(() => anchorCall(chain, { seq: 1.5, root, count: 1 })).toThrow(FakeRawPanic);
    expect(() =>
      anchorCall(chain, { seq: 1, root, count: 1 }, TEST_KEYS.ledger.publicKey),
    ).not.toThrow();
  });
});

describe("views (spend.rs, mandates.rs, anchors.rs, keys.rs)", () => {
  it("pages by 0-based position, caps limit at 100 and requires both arguments", () => {
    const { chain } = scenario();
    const m = mandateOf(chain, 1);
    for (let i = 1; i <= 150; i++) {
      chain.spends.push({
        id: i,
        mandate_id: 1,
        amount: "1",
        invoice_hash: i.toString(16).padStart(64, "0"),
        ref: `S-${i}`,
        decision_hash: "00".repeat(32),
        agent_pk: agent,
        destination: m.payee,
        status: "paid",
        created_at_ns: "0",
        held_until_ns: null,
        memo: null,
      });
    }
    const page = (from: number, limit: number) =>
      (
        chain.view(SCENARIO_VAULT, "list_spends", { from_index: from, limit }) as { id: number }[]
      ).map((s) => s.id);
    expect(page(0, 1000)).toHaveLength(100);
    expect(page(0, 1000)[0]).toBe(1);
    expect(page(100, 1000)).toHaveLength(50);
    expect(page(100, 1000)[0]).toBe(101);
    expect(page(149, 5)).toEqual([150]);
    expect(page(150, 5)).toEqual([]);
    expect(page(0, 0)).toEqual([]);
    expect(chain.view(SCENARIO_VAULT, "list_mandates", { from_index: 1, limit: 10 })).toHaveLength(
      1,
    );
    expect(chain.view(SCENARIO_VAULT, "list_anchors", { from_index: 0, limit: 10 })).toEqual([]);
    expect(() => chain.view(SCENARIO_VAULT, "list_spends", {})).toThrow(/missing field/);
    expect(() => chain.view(SCENARIO_VAULT, "list_spends", { from_index: -1, limit: 5 })).toThrow(
      FakeRawPanic,
    );
  });

  it("returns null for an unknown id, including 0, and the derived status for a known one", () => {
    const { chain } = scenario();
    expect(chain.view(SCENARIO_VAULT, "get_mandate", { mandate_id: 0 })).toBeNull();
    expect(chain.view(SCENARIO_VAULT, "get_mandate", { mandate_id: 3 })).toBeNull();
    expect(chain.view(SCENARIO_VAULT, "get_mandate", { mandate_id: 1 })).toMatchObject({
      id: 1,
      status: "active",
    });
    expect(chain.view(SCENARIO_VAULT, "get_spend", { spend_id: 1 })).toBeNull();
    spend(chain, req());
    expect(chain.view(SCENARIO_VAULT, "get_spend", { spend_id: 1 })).toMatchObject({
      id: 1,
      status: "paid",
    });
    expect(chain.view(SCENARIO_VAULT, "get_spend", { spend_id: 0 })).toBeNull();
  });

  it("serves the config, the agents, the factory and the intents views", () => {
    const { chain } = scenario();
    expect(chain.view(SCENARIO_VAULT, "get_config", {})).toBe(chain.config);
    expect(chain.view(SCENARIO_VAULT, "list_agents", {})).toEqual([
      { public_key: agent, label: "TEST DOUBLE agent", added_at_ns: "0" },
    ]);
    const factory = chain.factory?.id ?? "";
    // R14: factory version ids are 1-based.
    expect(chain.view(factory, "versions", {})).toMatchObject([{ index: 1, mode: "global" }]);
    expect(chain.view(factory, "vault_version", { account_id: SCENARIO_VAULT })).toBe(1);
    expect(chain.view(factory, "vault_version", { account_id: "nobody.testnet" })).toBeNull();
    expect(chain.view(factory, "get_config", {})).toMatchObject({ current_version: 1 });
    expect(chain.view(factory, "list_vaults", { from_index: 0, limit: 10 })).toMatchObject([
      { account_id: SCENARIO_VAULT, version: 1 },
    ]);
    const intents = chain.config.intents;
    expect(chain.view(intents, "public_keys_of", { account_id: SCENARIO_VAULT })).toEqual([]);
    expect(
      chain.view(intents, "is_auth_by_predecessor_id_enabled", { account_id: SCENARIO_VAULT }),
    ).toBe(true);
    const asset = chain.config.allowed_assets[0] ?? "";
    expect(
      chain.view(intents, "mt_balance_of", {
        account_id: SCENARIO_VAULT,
        token_id: `nep141:${asset}`,
      }),
    ).toBe("100000000");
    expect(() =>
      chain.view(intents, "mt_balance_of", { account_id: SCENARIO_VAULT, token_id: asset }),
    ).toThrow(/token_id must be/);
    expect(() => chain.view("ghost.testnet", "get_config", {})).toThrow(FakeRpcFault);
    expect(() => chain.view(SCENARIO_VAULT, "no_such_method", {})).toThrow(/MethodNotFound/);
  });

  it("has no factory when the scenario is a plain deploy, and a local code hash", () => {
    const chain = createScenarioChain({ factory: false });
    expect(chain.factory).toBeNull();
    expect(chain.config.factory).toBeNull();
    expect(chain.codeMode).toBe("local");
    expect(() => chain.view("vaults.probarion.testnet", "versions", {})).toThrow(FakeRpcFault);
  });
});

describe("access keys (keys.rs, ICR-5 key shapes)", () => {
  it("gives the agent a spend-only FC key and the ledger an anchor-only FC key on the vault, and nothing else", () => {
    const chain = createScenarioChain();
    const keys = chain.accessKeysOf(SCENARIO_VAULT).map((k) => k.info);
    expect(keys).toEqual([
      {
        public_key: agent,
        permission: {
          receiver_id: SCENARIO_VAULT,
          method_names: ["spend"],
          allowance: expect.any(String),
        },
      },
      {
        public_key: TEST_KEYS.ledger.publicKey,
        permission: {
          receiver_id: SCENARIO_VAULT,
          method_names: ["anchor"],
          allowance: expect.any(String),
        },
      },
    ]);
    expect(keys.some((k) => k.permission === "FullAccess")).toBe(false);
  });

  it("applies the node's checks before a call executes: key, nonce, receiver, method, deposit", () => {
    const chain = createScenarioChain();
    const base = chain.accessKey(SCENARIO_VAULT, agent)?.nonce ?? 0;
    const use = (
      nonce: number,
      method = "spend",
      receiver = SCENARIO_VAULT,
      deposit = 0n,
      pk = agent,
    ) => chain.useNonce(SCENARIO_VAULT, pk, nonce, method, receiver, deposit);
    const fault = (run: () => void) => {
      try {
        run();
      } catch (error) {
        if (error instanceof FakeRpcFault) return JSON.stringify(error.data);
        throw error;
      }
      return "no fault";
    };
    expect(
      fault(() => use(base + 1, "spend", SCENARIO_VAULT, 0n, TEST_KEYS.other.publicKey)),
    ).toContain("AccessKeyNotFound");
    expect(fault(() => use(base))).toContain("InvalidNonce");
    expect(fault(() => use(base + 1, "anchor"))).toContain("MethodNameMismatch");
    expect(fault(() => use(base + 1, "spend", "other.testnet"))).toContain("ReceiverMismatch");
    expect(fault(() => use(base + 1, "spend", SCENARIO_VAULT, 1n))).toContain(
      "DepositWithFunctionCall",
    );
    // None of the refusals used the nonce.
    expect(chain.accessKey(SCENARIO_VAULT, agent)?.nonce).toBe(base);
    use(base + 1);
    expect(chain.accessKey(SCENARIO_VAULT, agent)?.nonce).toBe(base + 1);
    expect(fault(() => use(base + 1))).toContain("InvalidNonce");
  });
});

describe("events are NEP-297 `probarion` 1.0.0 with the exact field names of events.rs", () => {
  it("emits every event the fake can produce with the contract's keys, in the contract's order", () => {
    const seen = new Map<string, string[]>();
    const collect = (logs: string[]) => {
      for (const e of eventsOf(logs)) {
        if (e.standard !== "probarion") continue;
        expect(e.version).toBe("1.0.0");
        expect(e.keys).toEqual(["standard", "version", "event", "data"]);
        seen.set(e.event, e.dataKeys);
      }
    };
    const a = scenario();
    collect(everyLog(spend(a.chain, req())));
    collect(
      everyLog(spend(a.chain, req({ mandate_id: 2, invoice_hash: "ef".repeat(32), ref: "B" }))),
    );
    collect(
      everyLog(
        spend(a.chain, req({ amount: "75000000", invoice_hash: "12".repeat(32), ref: "H1" })),
      ),
    );
    collect(everyLog(approverCall(a.chain, "approve", 3)));
    collect(
      everyLog(
        spend(a.chain, req({ amount: "75000000", invoice_hash: "13".repeat(32), ref: "H2" })),
      ),
    );
    collect(everyLog(approverCall(a.chain, "reject", 4)));
    collect(
      everyLog(
        spend(a.chain, req({ amount: "75000000", invoice_hash: "14".repeat(32), ref: "H3" })),
      ),
    );
    a.clock.now += 4n * DAY;
    collect(
      everyLog(
        a.chain.applyFunctionCall({
          signerId: "x.testnet",
          signerPk: agent,
          receiverId: a.chain.vaultId,
          method: "expire_held",
          args: { spend_id: 5 },
          deposit: 0n,
        }),
      ),
    );
    collect(everyLog(anchorCall(a.chain, { seq: 1, root: "ab".repeat(32), count: 1 })));
    a.chain.hooks.payoutFailure = "ft_transfer_failed";
    collect(everyLog(spend(a.chain, req({ invoice_hash: "15".repeat(32), ref: "F" }))));

    expect(Object.fromEntries(seen)).toEqual({
      spend_submitted: [
        "spend_id",
        "mandate_id",
        "amount",
        "invoice_hash",
        "decision_hash",
        "destination",
      ],
      spend_paid: ["spend_id", "mandate_id", "amount", "destination"],
      spend_burned: ["spend_id", "mandate_id", "amount", "chain", "address", "asset", "memo"],
      spend_held: [
        "spend_id",
        "mandate_id",
        "amount",
        "invoice_hash",
        "decision_hash",
        "held_until_ns",
      ],
      spend_approved: ["spend_id", "by"],
      spend_rejected: ["spend_id", "by"],
      spend_expired: ["spend_id"],
      ledger_anchored: ["seq", "root", "count"],
      spend_failed: ["spend_id", "mandate_id", "amount", "reason"],
    });
  });
});

describe("hooks and unsupported calls", () => {
  it("panics a spend with the hooked code before any check", () => {
    const chain = createScenarioChain();
    chain.hooks.spendPanic = "DuplicateRef";
    expect(panicCode(() => spend(chain, req()))).toBe("PROBARION:DuplicateRef");
    expect(chain.spends).toHaveLength(0);
  });

  it("fails loudly for a method it does not model, and for a receiver that is not the vault", () => {
    const chain = createScenarioChain();
    const call = (method: string, receiverId = chain.vaultId) =>
      chain.applyFunctionCall({
        signerId: approver,
        signerPk: TEST_KEYS.approver.publicKey,
        receiverId,
        method,
        args: {},
        deposit: 0n,
      });
    expect(() => call("create_mandate")).toThrow(/FAKE_UNSUPPORTED/);
    expect(() => call("spend", "someone-else.testnet")).toThrow(FakeRpcFault);
  });
});

describe("prepaid gas floor (contracts/vault/src/lib.rs:40-43)", () => {
  const TGAS = 1_000_000_000_000n;

  it("states the floors from the contract: 15+15 Tgas for a NEAR payout, 100+15 for an Intents payout", () => {
    expect(GAS_FLOOR_NEAR_PAYOUT).toBe(30n * TGAS);
    expect(GAS_FLOOR_INTENTS_PAYOUT).toBe(115n * TGAS);
    expect(SPEND_GAS).toBeGreaterThanOrEqual(GAS_FLOOR_INTENTS_PAYOUT);
  });

  it("fails a NEAR payout below 30 Tgas with the node's ExceededPrepaidGas execution error and changes nothing", () => {
    const { chain } = scenario();
    const run = (gas: bigint, ref: string) => () =>
      spend(
        chain,
        req({
          ref,
          invoice_hash: ref
            .padEnd(64, "0")
            .slice(0, 64)
            .replace(/[^0-9a-f]/g, "a"),
        }),
        { gas },
      );
    expect(run(GAS_FLOOR_NEAR_PAYOUT - 1n, "ab1")).toThrow(FakeVmError);
    expect(run(GAS_FLOOR_NEAR_PAYOUT - 1n, "ab1")).toThrow("Exceeded the prepaid gas.");
    // It is not a contract panic: no PROBARION code in the message.
    expect(run(1n, "ab1")).not.toThrow(/PROBARION/);
    expect(chain.spends).toHaveLength(0);
    expect(mandateOf(chain, 1)).toMatchObject({ reserved: "0", spent: "0", uses: 0 });
    expect(run(GAS_FLOOR_NEAR_PAYOUT, "ab1")().value).toEqual({ spend_id: 1, status: "paid" });
  });

  it("needs 115 Tgas for an Intents payout", () => {
    const { chain } = scenario();
    const over = { gas: GAS_FLOOR_INTENTS_PAYOUT - 1n };
    expect(() => spend(chain, req({ mandate_id: 2 }), over)).toThrow("Exceeded the prepaid gas.");
    expect(chain.spends).toHaveLength(0);
    expect(spend(chain, req({ mandate_id: 2 }), { gas: GAS_FLOOR_INTENTS_PAYOUT }).value).toEqual({
      spend_id: 1,
      status: "burned",
    });
  });

  it("checks the contract's own refusals first (they cost no payout gas) and lets a held spend through with little gas", () => {
    const { chain } = scenario();
    expect(panicCode(() => spend(chain, req({ amount: "0" }), { gas: 1n }))).toBe(
      "PROBARION:ZeroAmount",
    );
    // A held spend schedules no promise (spend.rs:23-25): only the payout at approval needs the floor.
    expect(spend(chain, req({ amount: "75000000" }), { gas: 5n * TGAS }).value).toEqual({
      spend_id: 1,
      status: "held",
    });
    expect(() => approverCall(chain, "approve", 1, { gas: GAS_FLOOR_NEAR_PAYOUT - 1n })).toThrow(
      FakeVmError,
    );
    expect(chain.spends[0]?.status).toBe("held");
    expect(approverCall(chain, "approve", 1, { gas: GAS_FLOOR_NEAR_PAYOUT }).value).toMatchObject({
      status: "paid",
    });
  });
});

describe("token views and USDC bookkeeping", () => {
  it("answers ft_metadata and ft_balance_of for the USDC and POA contracts, so view() agrees with accountView()", () => {
    const { chain } = scenario();
    const usdc = chain.config.usdc;
    const asset = chain.config.allowed_assets[0] ?? "";
    for (const token of [usdc, asset]) {
      expect(chain.accountView(token)).toMatchObject({ storage_usage: expect.any(Number) });
      expect(chain.view(token, "ft_metadata", {})).toMatchObject({ spec: "ft-1.0.0", decimals: 6 });
      expect(chain.view(token, "ft_balance_of", { account_id: "nobody.testnet" })).toBe("0");
    }
    expect(() => chain.view(usdc, "no_such_method", {})).toThrow(/MethodNotFound/);
    expect(() => chain.view(usdc, "ft_balance_of", {})).toThrow(/missing field/);
  });

  it("a NEAR payout credits the payee; a tracked vault balance is debited and can run short", () => {
    const { chain } = scenario();
    const usdc = chain.config.usdc;
    spend(chain, req());
    expect(chain.view(usdc, "ft_balance_of", { account_id: SCENARIO_NEAR_PAYEE })).toBe("25000000");
    expect(chain.ftBalances[usdc]?.[chain.vaultId]).toBeUndefined(); // untracked: never enforced

    const tracked = scenario({});
    tracked.chain.ftBalances[usdc] = { [tracked.chain.vaultId]: "30000000" };
    spend(tracked.chain, req());
    expect(tracked.chain.view(usdc, "ft_balance_of", { account_id: tracked.chain.vaultId })).toBe(
      "5000000",
    );
    const short = spend(tracked.chain, req({ ref: "INV-2", invoice_hash: "ef".repeat(32) }));
    expect(short.value).toEqual({ spend_id: 2, status: "failed" });
    expect(short.receipts[0]?.failure).toMatch(/doesn't have enough balance/);
    expect(mandateOf(tracked.chain, 1)).toMatchObject({
      spent: "25000000",
      reserved: "0",
      uses: 1,
    });
  });

  it("an account without a contract has no code to view; an unknown account does not exist", () => {
    const { chain } = scenario();
    expect(chain.accountView("owner.testnet")).toMatchObject({
      code_hash: "11111111111111111111111111111111",
    });
    const fault = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        if (error instanceof FakeRpcFault) return error.causeName;
      }
      return "no fault";
    };
    expect(fault(() => chain.view("owner.testnet", "get_config", {}))).toBe("NO_CONTRACT_CODE");
    expect(fault(() => chain.view("ghost.testnet", "get_config", {}))).toBe("UNKNOWN_ACCOUNT");
  });

  it("never emits a factory version 0: a vault the factory did not create has no record", () => {
    const { chain } = scenario();
    const factoryId = chain.factory?.id ?? "";
    if (chain.factory === null) throw new Error("scenario has a factory");
    chain.factory.vaultVersion = null;
    expect(chain.view(factoryId, "vault_version", { account_id: SCENARIO_VAULT })).toBeNull();
    expect(chain.view(factoryId, "list_vaults", { from_index: 0, limit: 10 })).toEqual([]);
    chain.factory.vaultVersion = 1;
    expect(chain.view(factoryId, "list_vaults", { from_index: 0, limit: 10 })).toMatchObject([
      { version: 1 },
    ]);
  });
});
