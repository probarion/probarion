import type { PGlite } from "@electric-sql/pglite";
import { RpcClient } from "@probarion/sdk";
import {
  createFakeNearAi,
  createScenarioChain,
  FAKE_NEARAI_BASE_URL,
  type FakeChatRequest,
  type FakeRpcServer,
  SCENARIO_NEAR_PAYEE,
  SCENARIO_NOW,
  SCENARIO_VAULT,
  startFakeRpcServer,
  TEST_KEYS,
} from "@probarion/sdk/testing";
import { KeyPair, type KeyPairString } from "near-api-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/port";
import { type MemberTenant, memberRole } from "@/lib/db/tenants";
import { generateKey } from "@/lib/keys/service";
import { SupabaseLedgerStore } from "@/lib/ledger/store";
import { createVaultReader, listAll } from "@/lib/near/reader";
import {
  PAYABLES_NEARAI_TIMEOUTS_MS,
  PAYABLES_TIME,
  type PayablesBudget,
  payablesBudget,
} from "@/lib/payables/budget";
import { OWNER_CONFIRMS_RULE } from "@/lib/payables/owner-confirms";
import { type PipelineDeps, PROCESS_LEASE_SECONDS, processInvoice } from "@/lib/payables/pipeline";
import { getInvoice } from "@/lib/payables/store";
import { quietLogs } from "../fixtures/quiet-logs";
import { freshDb, seedTenant } from "./harness";
import { MASTER } from "./keys-helpers";
import { pgliteDb } from "./pglite-db";

// A console upload's time, with the real SDK `Probarion` built as the route builds it (makePayablesProbarion), against
// the SDK's fake chain over JSON-RPC and its fake NEAR AI, the ledger and the invoice rows in Postgres (PGlite). The
// cycle's clock is a fake one, moved only by the fakes, so a model that "takes 70 s" takes no real time and every
// number below is exact. TEST DOUBLE keys only: derived from public strings, they never hold funds.

const h = vi.hoisted(() => ({ url: "", db: null as unknown as Db }));
/** Built at run time, so no secret-shaped literal sits in the source (gitleaks). */
const NEARAI_KEY = ["test", "double", "nearai", "key"].join("-");
vi.mock("@/lib/env", async () => {
  const { networkPart } = await import("../fixtures/networks");
  return {
    getEnv: () => ({
      ...networkPart({ defaultNetwork: "testnet", testnet: { rpcUrls: [h.url] } }),
      NEARAI_API_KEY: NEARAI_KEY,
      NEARAI_MODEL: null,
    }),
  };
});
vi.mock("@/lib/db/clients", () => ({ serviceDb: () => h.db }));

const { makePayablesProbarion } = await import("@/lib/payables/probarion");

const NOW = new Date(Number(SCENARIO_NOW / 1_000_000n));
/** The purpose document of the scenario's NEAR mandate (#1): its sha256 is the mandate's purpose_hash. */
const PO_1001 = new TextEncoder().encode("TEST DOUBLE PO-1001");
/** What every model call but the chat takes on the fake clock. */
const CALL_MS = 200;

type Phase = keyof typeof PAYABLES_NEARAI_TIMEOUTS_MS;

/** The model reads the total from the invoice text ("Total 25.00 USDC") and proposes the mandate it was shown. */
function testModel(request: FakeChatRequest): string {
  const lines = (request.messages[1]?.content ?? "").split("\n");
  const mandates = JSON.parse((lines[3] ?? "").slice("mandates: ".length)) as {
    id: number;
    payee: { account_id?: string };
  }[];
  const text = lines.slice(lines.indexOf("invoice_text:") + 1).join("\n");
  const m = /^Total[ \t]+(\d+)\.(\d{2})[ \t]+USDC$/m.exec(text);
  const amount = m
    ? (BigInt(m[1] ?? "0") * 1_000_000n + BigInt(m[2] ?? "0") * 10_000n).toString()
    : null;
  return JSON.stringify({
    action: "pay",
    mandate_id: mandates[0]?.id ?? null,
    amount,
    payee_hint: { near_account: mandates[0]?.payee.account_id ?? "" },
    reasoning: "The invoice matches the PO.",
    confidence: 0.95,
  });
}

describe("a console upload's time budget, on the fake chain", () => {
  const logs = quietLogs();
  let pg: PGlite;
  let server: FakeRpcServer;
  let member: MemberTenant;
  let store: SupabaseLedgerStore;
  const nearai = createFakeNearAi({ respond: testModel });

  beforeAll(async () => {
    server = await startFakeRpcServer(createScenarioChain());
    h.url = server.url;
    pg = await freshDb();
    h.db = pgliteDb(pg);
    const tenantId = await seedTenant(pg, {
      vault: SCENARIO_VAULT,
      owner: "owner.testnet",
      network: "testnet",
    });
    for (const [purpose, pair] of [
      ["agent", TEST_KEYS.agent],
      ["ledger", TEST_KEYS.ledger],
    ] as const) {
      const { id } = await generateKey(
        h.db,
        MASTER,
        { tenantId, purpose, label: purpose, createdBy: "owner.testnet" },
        () => KeyPair.fromString(pair.secretKey as KeyPairString),
      );
      await h.db.rpc("agent_key_set_status", {
        tenant_id: tenantId,
        id,
        from: "pending",
        status: "active",
      });
    }
    const m = await memberRole(h.db, SCENARIO_VAULT, "owner.testnet");
    if (!m) throw new Error("no member row");
    member = m;
    store = new SupabaseLedgerStore(h.db, tenantId);
  });
  afterAll(async () => {
    await server.close();
    await pg.close();
  });

  /** Seconds left on the tenant's process lease, as the database sees it now. */
  async function leaseLeft(): Promise<number> {
    const r = await pg.query<{ s: number }>(
      "select extract(epoch from (process_lease_until - now()))::float8 as s from tenants where id = $1",
      [member.tenant_id],
    );
    return Number(r.rows[0]?.s);
  }

  /**
   * One upload whose route started at 0 on the fake clock. The pipeline's own chain read (the mandates) takes `startMs`
   * of it, which stands for everything before the first model call. Every model call takes CALL_MS, the chat `chatMs`;
   * a call that would take longer than the SDK granted it is cut off when that time is up, as the SDK's own timeout cuts
   * a real one (a TimeoutError). What each call was granted is kept, with the lease seen during the chat.
   */
  async function upload(text: string, o: { startMs: number; chatMs: number; requestId: string }) {
    let clock = 0;
    const budget: PayablesBudget = payablesBudget(0, () => clock);
    const granted: { phase: Phase; ms: number }[] = [];
    let leaseDuringChat = Number.NaN;
    const timedFetch: typeof fetch = async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      const phase: Phase = path.endsWith("/chat/completions")
        ? "chat"
        : path.endsWith("/model/list")
          ? "catalog"
          : path.includes("/signature/")
            ? "signature"
            : "report";
      // What the SDK gave this call: its phase's cap, and no more than the model budget had left (the SDK has just
      // read the same budget at the same instant).
      const ms = Math.max(
        1,
        Math.min(PAYABLES_NEARAI_TIMEOUTS_MS[phase], Math.ceil(budget.modelMs())),
      );
      granted.push({ phase, ms });
      if (phase === "chat") leaseDuringChat = await leaseLeft();
      const takes = phase === "chat" ? o.chatMs : CALL_MS;
      if (takes > ms) {
        clock += ms;
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      clock += takes;
      return nearai.fetch(input, init);
    };
    const reader = createVaultReader(new RpcClient({ urls: [server.url] }));
    const deps: PipelineDeps = {
      db: h.db,
      master: MASTER,
      now: () => NOW,
      mandates: async (t) => {
        clock += o.startMs;
        return listAll((from, limit) => reader.listMandates(t.vault_id, from, limit), 100);
      },
      makeProbarion: (p) =>
        makePayablesProbarion("testnet", p, budget, {
          deps: { now: () => NOW, archivalRpc: null },
          nearai: {
            baseUrl: FAKE_NEARAI_BASE_URL,
            fetch: timedFetch,
            now: () => NOW,
            sleep: async () => {},
          },
        }),
    };
    const spends = server.chain.spends.length;
    const anchors = server.chain.anchors.length;
    const r = await processInvoice(deps, {
      tenant: member,
      upload: {
        bytes: new TextEncoder().encode(text),
        mediaType: "text/plain",
        filename: "inv.txt",
      },
      purposeBytes: PO_1001,
      actor: "owner.testnet",
      requestId: o.requestId,
    });
    const decision = (await store.all())
      .filter((e) => e.body.kind === "decision" && e.body.request_id === o.requestId)
      .at(-1)?.body;
    return {
      r,
      elapsed: clock,
      granted,
      leaseDuringChat,
      decision,
      sent: server.chain.spends.length - spends,
      anchored: server.chain.anchors.length - anchors,
    };
  }

  const invoice = (n: number, total: string) =>
    `Invoice INV-T${n}\nPO: PO-1001\nPay to ${SCENARIO_NEAR_PAYEE}\nTotal ${total} USDC`;

  it("pays a clean invoice with an attested decision when the model answers inside its budget", async () => {
    const u = await upload(invoice(1, "25.00"), {
      startMs: PAYABLES_TIME.beforeModelMs,
      chatMs: 30_000, // the slow chat seen in production on 2026-11-10
      requestId: "req-time-pay",
    });
    if (u.r.status !== "decided") throw new Error(`not decided: ${JSON.stringify(u.r)}`);
    expect(u.r.outcome).toMatchObject({ status: "paid", code: null });
    expect(u.decision).toMatchObject({ verdict: "allow", decided_by: "model+rules" });
    expect(u.sent).toBe(1);
    expect(u.anchored).toBe(1);
    // the catalog, the probe, the report, the chat and the signature, each within its cap and the budget
    expect(u.granted.map((g) => g.phase)).toEqual([
      "catalog",
      "report",
      "report",
      "chat",
      "signature",
    ]);
    expect(u.granted.find((g) => g.phase === "chat")?.ms).toBe(
      PAYABLES_TIME.modelBudgetMs - 3 * CALL_MS,
    );
    expect(u.elapsed).toBe(PAYABLES_TIME.beforeModelMs + 30_000 + 4 * CALL_MS);
    expect(u.elapsed).toBeLessThanOrEqual(PAYABLES_TIME.sendByMs);
  });

  it("a model that takes 70 s decides rules-only and the invoice waits for the owner, nothing sent, in the budget", async () => {
    const u = await upload(invoice(2, "20.00"), {
      startMs: PAYABLES_TIME.beforeModelMs,
      chatMs: 70_000,
      requestId: "req-time-slow",
    });
    if (u.r.status !== "decided") throw new Error(`not decided: ${JSON.stringify(u.r)}`);
    // The chat was given what was left of the model's 40 s, and cut off there.
    const chat = PAYABLES_TIME.modelBudgetMs - 3 * CALL_MS;
    expect(u.granted.at(-1)).toEqual({ phase: "chat", ms: chat });
    expect(
      logs.lines.some(
        (l) =>
          l.includes("sdk.warn") &&
          l.includes("model unavailable; deciding rules-only") &&
          l.includes(`POST /chat/completions: timed out after ${chat} ms`),
      ),
    ).toBe(true);
    // Rules-only: the owner-confirms rule holds it, and no spend is sent.
    expect(u.r.invoiceStatus).toBe("awaiting_owner");
    expect(u.r.outcome).toMatchObject({
      status: "held",
      code: OWNER_CONFIRMS_RULE,
      spendId: null,
      txHash: null,
    });
    expect(u.decision).toMatchObject({ verdict: "hold", decided_by: "rules-only" });
    expect(u.sent).toBe(0);
    // The decision is anchored as every cycle's is: the anchor is the cycle's first and only transaction.
    expect(u.anchored).toBe(1);
    expect(u.r.outcome.anchorTxHash).toEqual(expect.any(String));
    // The row is not left in processing: it waits for the owner with the code's amount.
    expect(await getInvoice(h.db, member.tenant_id, u.r.invoiceId)).toMatchObject({
      status: "awaiting_owner",
      suggested_amount: "20000000",
    });
    // The model stopped afterModelMs before sendByMs, and the cycle ended there: the send window, the answer and the
    // watcher kick keep the rest of the route's 90 s.
    expect(u.elapsed).toBe(PAYABLES_TIME.sendByMs - PAYABLES_TIME.afterModelMs);
    expect(PAYABLES_TIME.routeMs - u.elapsed).toBeGreaterThanOrEqual(
      PAYABLES_TIME.afterModelMs + PAYABLES_TIME.sendAndCloseMs + PAYABLES_TIME.afterResponseMs,
    );
    // The SQL holds the tenant's lease for PROCESS_LEASE_SECONDS from the cycle's start: 30 s past the route's end.
    expect(u.leaseDuringChat).toBeGreaterThan(PROCESS_LEASE_SECONDS - 15);
    expect(u.leaseDuringChat).toBeLessThanOrEqual(PROCESS_LEASE_SECONDS);
    expect(PAYABLES_TIME.routeMs / 1000 + 30).toBeLessThanOrEqual(PROCESS_LEASE_SECONDS);
  });

  it("after a slow start, a hanging model gets only what is left, and the decision still keeps its time", async () => {
    const u = await upload(invoice(3, "21.00"), {
      startMs: 30_000,
      chatMs: 70_000,
      requestId: "req-time-late",
    });
    if (u.r.status !== "decided") throw new Error(`not decided: ${JSON.stringify(u.r)}`);
    // 60 - 10 - 30 s, less the three calls before the chat; the SDK timed the chat out there
    const chat = 20_000 - 3 * CALL_MS;
    expect(u.granted.at(-1)).toEqual({ phase: "chat", ms: chat });
    expect(
      logs.lines.some((l) => l.includes(`POST /chat/completions: timed out after ${chat} ms`)),
    ).toBe(true);
    expect(u.r.invoiceStatus).toBe("awaiting_owner");
    expect(u.decision).toMatchObject({ verdict: "hold", decided_by: "rules-only" });
    expect(u.sent).toBe(0);
    expect(u.elapsed).toBe(PAYABLES_TIME.sendByMs - PAYABLES_TIME.afterModelMs);
  });

  it("a start past sendByMs: the SDK's chain reads are refused before anything is written or sent, and the invoice may run again", async () => {
    const text = invoice(4, "22.00");
    const u = await upload(text, {
      startMs: PAYABLES_TIME.sendByMs + 1_000,
      chatMs: 1_000,
      requestId: "req-time-past",
    });
    expect(u.r).toMatchObject({ status: "failed" });
    if (u.r.status !== "failed") throw new Error("not failed");
    expect(u.r.error).toMatch(/the time left for this job ran out/);
    expect(u.granted).toEqual([]);
    expect(u.decision).toBeUndefined();
    expect(u.sent).toBe(0);
    expect(u.anchored).toBe(0);
    // `error`, not `processing`: the one status a new upload of the same invoice runs again
    expect((await getInvoice(h.db, member.tenant_id, u.r.invoiceId))?.status).toBe("error");
    const again = await upload(text, {
      startMs: PAYABLES_TIME.beforeModelMs,
      chatMs: 1_000,
      requestId: "req-time-again",
    });
    expect(again.r).toMatchObject({ status: "decided", invoiceId: u.r.invoiceId });
    if (again.r.status !== "decided") throw new Error("not decided");
    expect(again.r.outcome).toMatchObject({ status: "paid" });
    expect(again.sent).toBe(1);
  });
});
