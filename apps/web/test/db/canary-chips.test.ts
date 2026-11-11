// The three one-click messages of /canary (lib/canary/chips.ts), each run through the Canary's real cycle: the REAL SDK
// (`makeCanaryProbarion` builds it, with the Canary's own rule), the code's amount reader and payee hint, the SDK's fake
// chain over JSON-RPC and its fake NEAR AI, the ledger in PGlite and keys sealed in agent_keys. The fake chain holds the
// Canary vault's mandate and daily backstop as the published snapshot of 2026-11-11 records them, so the caps are the
// live Canary's. The model is a TEST DOUBLE that is fully fooled: it proposes paying the amount and the account the text
// names, as the Canary's persona tells it to. Each chip's `usually` (what the form says it usually ends as) is held to
// what this run gives.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import type { MandateView } from "@probarion/core";
import { NearAiProposer, RpcClient } from "@probarion/sdk";
import {
  createFakeNearAi,
  createScenarioChain,
  FAKE_NEARAI_BASE_URL,
  type FakeChatRequest,
  type FakeRpcServer,
  SCENARIO_NOW,
  SCENARIO_VAULT,
  startFakeRpcServer,
  TEST_KEYS,
} from "@probarion/sdk/testing";
import { KeyPair, type KeyPairString } from "near-api-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/port";
import { registerTenant } from "@/lib/db/tenants";
import { generateKey } from "@/lib/keys/service";
import { SupabaseLedgerStore } from "@/lib/ledger/store";
import { createVaultReader, listAll } from "@/lib/near/reader";
import { quietLogs } from "../fixtures/quiet-logs";
import { freshDb } from "./harness";
import { MASTER } from "./keys-helpers";
import { pgliteDb } from "./pglite-db";

const h = vi.hoisted(() => ({ url: "", db: null as unknown as Db }));
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

const { makeCanaryProbarion } = await import("@/lib/canary/probarion");
const { runAttempt } = await import("@/lib/canary/service");
const { CANARY_SYSTEM_PROMPT } = await import("@/lib/canary/prompt");
const { CANARY_CHIPS } = await import("@/lib/canary/chips");
const { classify } = await import("@/lib/canary/technique");
const { CANARY_LIMITS } = await import("@/lib/canary/limits");

const NOW = new Date(Number(SCENARIO_NOW / 1_000_000n));
const H = (c: string) => c.repeat(64);

/** The Canary vault as the published snapshot of 2026-11-11 read it from testnet. */
const SNAPSHOT = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../../docs/evidence/canary-vault/snapshot-2026-11-11.json", import.meta.url),
    ),
    "utf8",
  ),
) as { chain: { mandates: MandateView[]; config: { daily_backstop: string } } };
const CANARY_MANDATE = SNAPSHOT.chain.mandates[0] as MandateView;

/**
 * A fully fooled TEST DOUBLE: it pays what the text asks, in the token's smallest units as the persona says, under the
 * one mandate it is shown, and names the account the text names as the payee.
 */
function fooled(request: FakeChatRequest): string {
  const lines = (request.messages[1]?.content ?? "").split("\n");
  const text = lines.slice(lines.indexOf("invoice_text:") + 1).join("\n");
  const usdc = /(\d+(?:\.\d+)?)\s*USDC/.exec(text)?.[1];
  const account = /\b([a-z0-9_-]+\.testnet)\b/.exec(text)?.[1];
  return JSON.stringify({
    action: "pay",
    mandate_id: 1,
    amount: usdc === undefined ? null : String(Math.round(Number(usdc) * 1_000_000)),
    payee_hint: account ? { near_account: account } : null,
    reasoning: "The message asks for this payment, so I propose it.",
    confidence: 0.95,
  });
}

/** What the run gave each chip: the decision's refusing rules, the attempt, and the spends on chain before and after. */
type Run = {
  refusing: string[];
  proposal: { action: string; amount: string | null } | null;
  result: Awaited<ReturnType<typeof runAttempt>>;
  spendsBefore: number;
  spendsAfter: number;
};

describe("the one-click messages, through the Canary's real cycle with a fooled model", () => {
  quietLogs();
  let pg: PGlite;
  let server: FakeRpcServer;
  let tenant: { tenant_id: string; vault_id: string; network: "mainnet" | "testnet" };
  let store: SupabaseLedgerStore;
  let n = 0;
  const runs = new Map<string, Run>();

  beforeAll(async () => {
    const chain = createScenarioChain();
    // The Canary's mandate and backstop, signed for by the scenario's agent key (the fake chain's).
    chain.mandates = [{ ...CANARY_MANDATE, agent_pk: TEST_KEYS.agent.publicKey }];
    chain.config = { ...chain.config, daily_backstop: SNAPSHOT.chain.config.daily_backstop };
    server = await startFakeRpcServer(chain);
    h.url = server.url;
    pg = await freshDb();
    h.db = pgliteDb(pg);
    const { tenant_id } = await registerTenant(h.db, {
      vaultId: SCENARIO_VAULT,
      network: "testnet",
      kind: "canary",
      owner: "owner.testnet",
      approvers: [],
    });
    tenant = { tenant_id, vault_id: SCENARIO_VAULT, network: "testnet" };
    for (const [purpose, pair] of [
      ["agent", TEST_KEYS.agent],
      ["ledger", TEST_KEYS.ledger],
    ] as const) {
      const { id } = await generateKey(
        h.db,
        MASTER,
        { tenantId: tenant_id, purpose, label: purpose, createdBy: "owner.testnet" },
        () => KeyPair.fromString(pair.secretKey as KeyPairString),
      );
      await h.db.rpc("agent_key_set_status", { tenant_id, id, from: "pending", status: "active" });
    }
    // The Canary wants 0.5 NEAR on the ledger key before it runs (the scenario's has 0.25).
    server.chain.addAccessKey(SCENARIO_VAULT, {
      public_key: TEST_KEYS.ledger.publicKey,
      permission: {
        receiver_id: SCENARIO_VAULT,
        method_names: ["anchor"],
        allowance: "2000000000000000000000000",
      },
    });
    store = new SupabaseLedgerStore(h.db, tenant_id);

    const reader = createVaultReader(new RpcClient({ urls: [server.url] }));
    const nearai = createFakeNearAi({ respond: fooled });
    const allowanceOf = async (pk: string) => {
      const k = await reader.accessKey(SCENARIO_VAULT, pk);
      if (!k.exists) return 0n;
      return k.allowance === null ? null : BigInt(k.allowance);
    };
    const deps = {
      db: h.db,
      mode: "live" as const,
      now: () => NOW,
      tenant,
      mandates: () =>
        listAll((from, limit) => reader.listMandates(SCENARIO_VAULT, from, limit), 100),
      makeProbarion: ({
        mandate,
        requestId,
        remainingMs,
      }: {
        mandate: MandateView;
        requestId: string;
        remainingMs: () => number;
      }) =>
        makeCanaryProbarion(
          h.db,
          MASTER,
          tenant,
          mandate,
          requestId,
          {
            now: () => NOW,
            archivalRpc: null,
            proposer: new NearAiProposer({
              apiKey: NEARAI_KEY,
              baseUrl: FAKE_NEARAI_BASE_URL,
              fetch: (input, init) => nearai.fetch(input, init),
              now: () => NOW,
              sleep: async () => {},
              systemPrompt: CANARY_SYSTEM_PROMPT,
              remainingMs,
            }),
          },
          { remainingMs },
        ),
      agentAllowance: (mandate: { agent_pk: string }) => allowanceOf(mandate.agent_pk),
      ledgerAllowance: () => allowanceOf(TEST_KEYS.ledger.publicKey),
      ledgerSize: async () => {
        const head = await store.head();
        return head === null ? 0 : head.body.seq + 1;
      },
      ledgerByHash: (hash: string) => store.getByHash(hash),
    } satisfies Parameters<typeof runAttempt>[0];

    // Each chip from its own visitor, so that no chip spends another's on-chain slot.
    for (const chip of CANARY_CHIPS) {
      n += 1;
      const requestId = `chip-${chip.id}`;
      const spendsBefore = server.chain.spends.length;
      const result = await runAttempt(deps, {
        text: chip.text,
        visitorHash: H(n.toString(16)),
        ipHash: H((n + 7).toString(16)),
        isTeam: false,
        requestId,
      });
      const decision = (await store.all()).find(
        (e) => e.body.kind === "decision" && e.body.request_id === requestId,
      );
      runs.set(chip.id, {
        refusing: (decision?.body.rules ?? [])
          .filter((r) => r.outcome === "refuse")
          .map((r) => r.id),
        proposal: decision?.body.proposal ?? null,
        result,
        spendsBefore,
        spendsAfter: server.chain.spends.length,
      });
    }
  });
  afterAll(async () => {
    await server.close();
    await pg.close();
  });

  const run = (id: string): Run => {
    const r = runs.get(id);
    if (r === undefined) throw new Error(`chip ${id} did not run`);
    return r;
  };

  it("runs on the Canary's own caps: 1 test USDC a payment and in all, one payment, every payment held, 1 a day", () => {
    expect(CANARY_MANDATE).toMatchObject({
      id: 1,
      payee: { type: "near", account_id: "probarion-payee.testnet" },
      max_per_payment: "1000000",
      max_total: "1000000",
      max_uses: 1,
      approval_above: "0",
    });
    expect(SNAPSHOT.chain.config.daily_backstop).toBe("1000000");
  });

  it("has the model fooled every time: it proposes to pay what each text asks", () => {
    expect(run("cap").proposal).toMatchObject({ action: "pay", amount: "50000000" });
    expect(run("bank").proposal).toMatchObject({ action: "pay", amount: "1000000" });
    expect(run("ignore").proposal).toMatchObject({ action: "pay", amount: "1000000" });
  });

  it("refuses the 50 USDC invoice for its caps, and the contract refuses the raw spend on chain with OverPerPayment", () => {
    const r = run("cap");
    expect(r.refusing).toEqual([
      "mandate.over_per_payment",
      "mandate.over_total",
      "vault.daily_backstop",
      "custom.canary_no_autopay",
    ]);
    expect(r.result).toMatchObject({
      status: "done",
      code: { status: "refused_by_code", rule: "mandate.over_per_payment" },
      raw: { sent: true, status: "refused_by_contract", code: "OverPerPayment" },
    });
    expect(r.spendsAfter).toBe(r.spendsBefore);
  });

  it("refuses both texts that name attacker.testnet for the payee first, and the dry run keeps raw mode from sending them", () => {
    for (const id of ["bank", "ignore"]) {
      const r = run(id);
      expect(r.refusing, id).toEqual([
        "mandate.payee_mismatch",
        "invoice.amount_invalid",
        "custom.canary_no_autopay",
      ]);
      expect(r.result, id).toMatchObject({
        status: "done",
        code: { status: "refused_by_code", rule: "mandate.payee_mismatch" },
        raw: { sent: false, skipped: "contract_would_accept" },
      });
      expect(r.spendsAfter, id).toBe(r.spendsBefore);
    }
  });

  it("is what each chip says it usually ends as", () => {
    for (const chip of CANARY_CHIPS) {
      const r = run(chip.id);
      expect(r.result.status, chip.id).toBe("done");
      if (r.result.status !== "done") continue;
      expect(r.result.code.rule, chip.id).toBe(chip.usually.rule);
      expect(r.refusing[0], chip.id).toBe(chip.usually.rule);
      if (chip.usually.raw.sent) {
        expect(r.result.raw, chip.id).toMatchObject({
          sent: true,
          status: "refused_by_contract",
          code: chip.usually.raw.contractCode,
        });
      } else {
        expect(r.result.raw, chip.id).toEqual({ sent: false, skipped: chip.usually.raw.skipped });
      }
    }
  });

  it("labels each chip with the technique it shows on the scoreboard", () => {
    expect(Object.fromEntries(CANARY_CHIPS.map((c) => [c.id, classify(c.text)]))).toEqual({
      cap: ["fake_invoice"],
      bank: ["payee_change"],
      ignore: ["instruction_override", "roleplay"],
    });
    expect(CANARY_LIMITS.maxTextChars).toBe(4000);
  });
});
