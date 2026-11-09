import {
  type CheckSpendVerdict,
  type MandateView,
  type SpendRequest,
  ZERO_HEX32,
} from "@probarion/core";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import type { MemberTenant } from "@/lib/db/tenants";
import { loadInbox } from "@/lib/ext/inbox";
import { fingerprintText } from "./facts";
import { invoiceNumberKey } from "./number-key";
import { mandateProblem, type QueueDeps, queueInvoice } from "./queue";
import { CHECK_SPEND_RULE, EXTENSION_MANDATE_RULE, PAYEE_RULE } from "./queue-rules";

const NOW = new Date("2026-11-08T12:00:00Z");
const ns = (iso: string) => (BigInt(Date.parse(iso)) * 1_000_000n).toString();
// Labels the test compares; nothing parses them as keys.
const AGENT = "ed25519:test-double-agent";
const LEDGER = "ed25519:test-double-ledger";
const QUEUED = "11111111-1111-4111-8111-111111111111";
/** The harness's master key: a test value, made here. */
const MASTER = new Uint8Array(32).fill(7);
const TENANT: MemberTenant = {
  tenant_id: "00000000-0000-4000-8000-0000000000aa",
  vault_id: "acme.vaults.probarion.testnet",
  network: "testnet",
  kind: "external",
  display_name: "acme",
  role: "owner",
  owner_account: "owner.testnet",
  zero_retention: false,
  proof_public: false,
};

function mandate(over: Partial<MandateView> = {}): MandateView {
  return {
    id: 1,
    payee: { type: "near", account_id: "vendor.testnet" },
    purpose_hash: "a".repeat(64),
    max_per_payment: "100000000",
    max_total: "1000000000",
    spent: "0",
    reserved: "0",
    max_uses: 10,
    uses: 0,
    expires_at_ns: ns("2030-01-01T00:00:00Z"),
    approval_above: "50000000",
    agent_pk: AGENT,
    label: "Hosting",
    status: "active",
    created_at_ns: ns("2026-11-01T00:00:00Z"),
    ...over,
  };
}

const AGENT_KEY = { purpose: "agent", status: "active", public_key: AGENT };
const LEDGER_KEY = { purpose: "ledger", status: "active", public_key: LEDGER };

interface Opts {
  keys?: unknown[];
  mandates?: MandateView[] | Error;
  verdict?: CheckSpendVerdict | Error;
  queue?: unknown;
  tenant?: Partial<MemberTenant>;
}

function harness(o: Opts = {}) {
  const calls: { fn: string; p: Record<string, unknown> }[] = [];
  const checked: { request: SpendRequest; signer: string }[] = [];
  const db: Db = {
    async rpc<T>(fn: string, p: Record<string, unknown> = {}): Promise<T> {
      calls.push({ fn, p });
      if (fn === "agent_key_list") return (o.keys ?? [AGENT_KEY, LEDGER_KEY]) as T;
      if (fn === "invoice_queue") {
        return (o.queue ?? { id: QUEUED, duplicate: false, status: "awaiting_owner" }) as T;
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
  };
  const deps: QueueDeps = {
    db,
    master: MASTER,
    now: () => NOW,
    mandates: async () => {
      if (o.mandates instanceof Error) throw o.mandates;
      return o.mandates ?? [mandate()];
    },
    checkSpend: async (_t, request, signer) => {
      checked.push({ request, signer });
      if (o.verdict instanceof Error) throw o.verdict;
      return o.verdict ?? { ok: true, code: null, would_hold: false };
    },
  };
  const run = (text: string, mandateId = 1) =>
    queueInvoice(deps, {
      tenant: { ...TENANT, ...o.tenant },
      upload: {
        bytes: new TextEncoder().encode(text),
        mediaType: "text/plain",
        filename: "selection.txt",
      },
      mandateId,
      actor: "owner.testnet",
      requestId: "req-q-1",
    });
  const stored = () => calls.filter((c) => c.fn === "invoice_queue");
  return { run, checked, stored };
}

const INVOICE = "Invoice INV-1001\nPay to vendor.testnet\nTotal 20.00 USDC";
const checksOf = (p: Record<string, unknown> | undefined) =>
  // biome-ignore lint/correctness/noUnsafeOptionalChaining: when nothing was stored this throws, and the test fails, as it should.
  (p?.queue_checks as { id: string; outcome: string }[]).map((c) => [c.id, c.outcome]);

describe("queueing an invoice from the browser extension", () => {
  it("stores it in awaiting_owner with the code's amount, the chosen mandate and three checks", async () => {
    const h = harness();
    expect(await h.run(INVOICE)).toEqual({ status: "queued", invoiceId: QUEUED });
    const [q] = h.stored();
    expect(q?.p).toMatchObject({
      tenant_id: TENANT.tenant_id,
      suggested_amount: "20000000",
      mandate_id: 1,
      retained: true,
      media_type: "text/plain",
      filename: "selection.txt",
      created_by: "owner.testnet",
      amount_issue: null,
    });
    expect(checksOf(q?.p)).toEqual([
      [EXTENSION_MANDATE_RULE, "hold"],
      [PAYEE_RULE, "pass"],
      [CHECK_SPEND_RULE, "pass"],
    ]);
    // biome-ignore lint/correctness/noUnsafeOptionalChaining: when nothing was stored this throws, and the test fails, as it should.
    expect((q?.p.queue_checks as { detail: string }[]).map((c) => c.detail)).toEqual([
      "owner.testnet chose mandate 1 in the browser extension. No purpose document was matched, so only the owner's signed Confirm can pay it.",
      "The invoice's payee, if it names one, does not contradict the mandate's (near:vendor.testnet).",
      "The vault would accept this payment now.",
    ]);
    expect(h.checked).toEqual([
      {
        request: {
          mandate_id: 1,
          amount: "20000000",
          invoice_hash: q?.p.invoice_hash,
          ref: q?.p.ref,
          decision_hash: ZERO_HEX32,
        },
        signer: AGENT,
      },
    ]);
  });

  it("keys the duplicate guard as the console upload does: the text's fingerprint and the payee's invoice number", async () => {
    const h = harness();
    await h.run(INVOICE);
    const p = h.stored()[0]?.p;
    // pipeline.ts computes both keys with these calls and arguments, so a copy of an invoice sent through one intake
    // is a duplicate of the other's.
    expect(p?.fingerprint_sha256).toBe(sha256Hex(fingerprintText(INVOICE)));
    expect(p?.invoice_number_hmac).toBe(
      invoiceNumberKey(
        MASTER,
        TENANT.vault_id,
        { type: "near", account_id: "vendor.testnet" },
        "INV-1001",
      ),
    );
    expect(p?.invoice_number_hmac).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records the vault's own hold for its approvers", async () => {
    const h = harness({ verdict: { ok: true, code: null, would_hold: true } });
    await h.run(INVOICE);
    expect(checksOf(h.stored()[0]?.p)).toContainEqual([CHECK_SPEND_RULE, "hold"]);
  });

  it("keeps no file, name or facts in zero-retention mode", async () => {
    const h = harness({ tenant: { zero_retention: true } });
    await h.run(INVOICE);
    expect(h.stored()[0]?.p).toMatchObject({
      retained: false,
      content_ciphertext: null,
      content_nonce: null,
      facts: null,
      filename: null,
    });
  });

  it("words the payee check the same whether or not the invoice names a payee", async () => {
    const named = harness();
    await named.run(INVOICE);
    const unnamed = harness();
    await unnamed.run("Invoice INV-1002\nTotal 20.00 USDC");
    const payeeDetail = (p: Record<string, unknown> | undefined) =>
      // biome-ignore lint/correctness/noUnsafeOptionalChaining: when nothing was stored this throws, and the test fails, as it should.
      (p?.queue_checks as { id: string; detail: string }[]).find((c) => c.id === PAYEE_RULE)
        ?.detail;
    expect(payeeDetail(unnamed.stored()[0]?.p)).toBe(payeeDetail(named.stored()[0]?.p));
  });

  it("answers a duplicate with the row that already has it", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const h = harness({ queue: { id: other, duplicate: true, status: "awaiting_owner" } });
    expect(await h.run(INVOICE)).toEqual({
      status: "duplicate",
      invoiceId: other,
      invoiceStatus: "awaiting_owner",
    });
  });

  describe("stores nothing and says why", () => {
    const expired = mandate({ expires_at_ns: ns("2026-11-01T00:00:00Z") });
    const down = new Error("rpc down");
    const cases: [string, Opts, string, number, Record<string, unknown>][] = [
      ["an empty text", {}, "   \n ", 1, { status: "empty" }],
      [
        "a text with no total",
        {},
        "Invoice INV-1\nPay to vendor.testnet\nThanks",
        1,
        { status: "amount_unclear" },
      ],
      [
        "a text with two different totals",
        {},
        "Invoice INV-2\nPay to vendor.testnet\nTotal 20.00 USDC\nTotal 30.00 USDC",
        1,
        { status: "amount_unclear" },
      ],
      ["an unreadable chain", { mandates: down }, INVOICE, 1, { status: "chain_unavailable" }],
      ["a mandate that is not on the vault", {}, INVOICE, 9, { status: "mandate_not_found" }],
      [
        "a revoked mandate",
        { mandates: [mandate({ status: "revoked" })] },
        INVOICE,
        1,
        { status: "mandate_inactive" },
      ],
      ["an expired mandate", { mandates: [expired] }, INVOICE, 1, { status: "mandate_inactive" }],
      [
        "a mandate with no uses left",
        { mandates: [mandate({ uses: 10 })] },
        INVOICE,
        1,
        { status: "mandate_inactive" },
      ],
      [
        "a mandate whose total cannot be read",
        { mandates: [mandate({ max_total: "lots" })] },
        INVOICE,
        1,
        { status: "mandate_inactive", reason: "mandate 1's total cannot be read" },
      ],
      [
        "a mandate whose uses cannot be read",
        { mandates: [mandate({ uses: "1" as unknown as number })] },
        INVOICE,
        1,
        { status: "mandate_inactive", reason: "mandate 1's uses cannot be read" },
      ],
      [
        "a mandate whose payee Confirm cannot sign",
        { mandates: [mandate({ payee: { type: "near", account_id: "Not A NEAR Account" } })] },
        INVOICE,
        1,
        {
          status: "mandate_inactive",
          reason: "mandate 1's payee is not in a form Confirm can sign",
        },
      ],
      [
        "no active agent key",
        { keys: [LEDGER_KEY] },
        INVOICE,
        1,
        { status: "no_keys", missing: ["agent"] },
      ],
      [
        "an active agent key that is not the mandate's",
        { keys: [{ ...AGENT_KEY, public_key: "ed25519:another" }, LEDGER_KEY] },
        INVOICE,
        1,
        { status: "no_keys", missing: ["agent"] },
      ],
      [
        "no active ledger key",
        { keys: [AGENT_KEY] },
        INVOICE,
        1,
        { status: "no_keys", missing: ["ledger"] },
      ],
      [
        "an invoice that names another payee",
        {},
        "Invoice INV-3\nPay to other.testnet\nTotal 20.00 USDC",
        1,
        { status: "refused", rule: PAYEE_RULE },
      ],
      [
        "a payment the vault would refuse",
        { verdict: { ok: false, code: "OverPerPayment", would_hold: false } },
        INVOICE,
        1,
        {
          status: "refused",
          rule: CHECK_SPEND_RULE,
          detail: expect.stringContaining("OverPerPayment"),
        },
      ],
      ["an unreadable check_spend", { verdict: down }, INVOICE, 1, { status: "chain_unavailable" }],
    ];
    for (const [what, opts, text, mandateId, want] of cases) {
      it(what, async () => {
        const h = harness(opts);
        expect(await h.run(text, mandateId)).toMatchObject(want);
        expect(h.stored()).toEqual([]);
      });
    }
  });

  it("takes an invoice under exactly the mandates the extension's inbox offers", async () => {
    // One list for both filters: the eight mandates of src/lib/ext/inbox.test.ts ("lists the holds an approver can
    // still approve, and the mandates an invoice can still go under"), whose inbox offers 1 and 5, and three more the
    // inbox leaves out. The inbox's own loadInbox runs over the same list, so neither filter can drift alone.
    const shapes = [
      mandate({ id: 1 }),
      mandate({ id: 2, status: "revoked" }),
      mandate({ id: 3, status: "exhausted" }),
      mandate({ id: 4, expires_at_ns: ns("2026-11-01T00:00:00Z") }),
      mandate({ id: 5, label: "Ads\u202E" }),
      mandate({ id: 6, uses: 10 }),
      mandate({ id: 7, spent: "600000000", reserved: "400000000" }),
      mandate({ id: 8, max_total: "lots" }),
      mandate({ id: 9, payee: { type: "near", account_id: "Not A NEAR Account" } }),
      mandate({ id: 10, expires_at_ns: "soon" }),
      mandate({ id: 11, status: "paused" as unknown as MandateView["status"] }),
    ];
    const queueTakes = shapes.filter((m) => mandateProblem(m, NOW) === null).map((m) => m.id);
    const db: Db = {
      async rpc<T>(fn: string): Promise<T> {
        if (fn === "member_tenants") return [TENANT] as T;
        if (fn === "invoice_list") return [] as T;
        throw new Error(`unexpected rpc ${fn}`);
      },
    };
    const inbox = await loadInbox(
      {
        db,
        chain: { mandates: async () => shapes, spends: async () => [] },
        origin: "https://testnet.probarion.test",
        now: NOW,
      },
      { account: TENANT.owner_account, network: "testnet" },
    );
    expect(inbox.vaults.map((v) => v.chain)).toEqual(["ok"]);
    expect(inbox.vaults[0]?.mandates.map((m) => m.id)).toEqual(queueTakes);
    expect(queueTakes).toEqual([1, 5]);
    expect(mandateProblem(shapes[10] as MandateView, NOW)).toBe(
      "mandate 11's status or expiry cannot be read",
    );
  });
});
