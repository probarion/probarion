import type { PGlite } from "@electric-sql/pglite";
import { verifyEntrySignature } from "@probarion/core";
import { hashInvoice, RpcClient } from "@probarion/sdk";
import {
  createScenarioChain,
  type FakeRpcServer,
  SCENARIO_APPROVER,
  SCENARIO_NEAR_PAYEE,
  SCENARIO_NOW,
  SCENARIO_VAULT,
  startFakeRpcServer,
  TEST_KEYS,
} from "@probarion/sdk/testing";
import { KeyPair, type KeyPairString } from "near-api-js";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/session";
import { fullAccessKeyVerifier, rpcLoginProvider } from "@/lib/auth/verify";
import { deriveSubkey, sha256Hex } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import { type MemberTenant, memberRole } from "@/lib/db/tenants";
import { mintToken, revokeToken } from "@/lib/ext/store";
import { newToken } from "@/lib/ext/token";
import { generateKey } from "@/lib/keys/service";
import { SupabaseLedgerStore } from "@/lib/ledger/store";
import { createVaultReader } from "@/lib/near/reader";
import { CONFIRM_RECIPIENT } from "@/lib/payables/confirm-message";
import { MAX_INVOICE_BYTES } from "@/lib/payables/extract";
import { extractFacts, fingerprintText, refFor } from "@/lib/payables/facts";
import { invoiceNumberKey } from "@/lib/payables/number-key";
import { OWNER_CONFIRMED_RULE } from "@/lib/payables/owner-confirmed";
import { CHECK_SPEND_RULE, EXTENSION_MANDATE_RULE, PAYEE_RULE } from "@/lib/payables/queue-rules";
import { getInvoice, type InvoiceRow, insertInvoice, listInvoices } from "@/lib/payables/store";
import { signNep413 } from "../fixtures/nep413";
import { quietLogs } from "../fixtures/quiet-logs";
import { asRole, freshDb, seedTenant } from "./harness";
import { MASTER } from "./keys-helpers";
import { pgliteDb } from "./pglite-db";

// The extension's queue end to end and offline: the real route, the real SDK on the SDK's fake chain over JSON-RPC,
// the invoices and the ledger in Postgres (PGlite). A queued invoice sends nothing and writes no ledger entry; the
// owner's Confirm (the existing flow, unchanged) is what pays it.

const h = vi.hoisted(() => ({
  url: "",
  db: null as unknown as Db,
  jar: new Map<string, string>(),
}));
vi.mock("@/lib/env", async () => {
  const { networkPart } = await import("../fixtures/networks");
  return {
    getEnv: () => ({
      ...networkPart({ defaultNetwork: "testnet", testnet: { rpcUrls: [h.url] } }),
      NEARAI_API_KEY: null,
      NEARAI_MODEL: null,
    }),
  };
});
vi.mock("@/lib/db/clients", () => ({ serviceDb: () => h.db }));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: () => null }),
  // The extension's route never reads a cookie: with no session in the jar, a read throws and the route answers 503.
  // Only the console page, rendered after a sign-in, reads one.
  cookies: async () => {
    if (h.jar.size === 0) throw new Error("the extension's routes never read cookies");
    return {
      get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name) } : undefined),
    };
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("@/lib/crypto/server", async () => {
  const sodium = await import("@/lib/crypto/sodium");
  const { MASTER: master } = await import("./keys-helpers");
  return {
    masterKey: () => master,
    subkey: (purpose: Parameters<typeof sodium.deriveSubkey>[1]) =>
      sodium.deriveSubkey(master, purpose),
  };
});
vi.mock("@/lib/near/server", async () => {
  const { RpcClient: Rpc } = await import("@probarion/sdk");
  const { createVaultReader: reader } = await import("@/lib/near/reader");
  const { NETWORKS: N } = await import("@probarion/core");
  return {
    getRpc: () => new Rpc({ urls: [h.url] }),
    getReader: () => reader(new Rpc({ urls: [h.url] })),
    chainConsts: () => N.testnet,
  };
});
vi.mock("@/components/console/ConfirmInvoicePanel", async () => {
  const { createElement } = await import("react");
  return {
    ConfirmInvoicePanel: () => createElement("div", { "data-panel": "confirm" }, "confirm panel"),
  };
});

const { POST } = await import("@/app/api/ext/invoices/route");
const { makeTenantProbarion } = await import("@/lib/sdk/factory");
const { confirmInvoice, prepareConfirmation, rejectWaitingInvoice } = await import(
  "@/lib/payables/confirm"
);
type ConfirmDeps = import("@/lib/payables/confirm").ConfirmDeps;
const { loadWaitingView } = await import("@/lib/payables/waiting");
const { default: InvoicePage } = await import("@/app/console/[vault]/payables/[id]/page");

const NOW = new Date(Number(SCENARIO_NOW / 1_000_000n));
const OWNER = "owner.testnet";
const URL_ = "https://testnet.probarion.test/api/ext/invoices";
/** 2100-01-01: the route checks a mandate against the wall clock, which passes the scenario's 2027 expiry one day. */
const FAR = "4102444800000000000";
/** The 401's detail (lib/ext/auth.ts RECONNECT, delta §7). */
const RECONNECT = "Connect the extension again: open Probarion, then Browser extension.";

describe("an invoice queued from the browser extension", () => {
  const logs = quietLogs();
  let pg: PGlite;
  let server: FakeRpcServer;
  let member: MemberTenant;
  let deps: ConfirmDeps;
  let store: SupabaseLedgerStore;
  let token: string;
  let n = 0;
  const ownerKey = KeyPair.fromRandom("ed25519");
  let mandates: Record<string, unknown>[] = [];

  beforeAll(async () => {
    server = await startFakeRpcServer(createScenarioChain());
    h.url = server.url;
    for (const m of server.chain.mandates) m.expires_at_ns = FAR;
    server.chain.addAccessKey(OWNER, {
      public_key: ownerKey.getPublicKey().toString(),
      permission: "FullAccess",
    });
    pg = await freshDb();
    h.db = pgliteDb(pg);
    const tenantId = await seedTenant(pg, {
      vault: SCENARIO_VAULT,
      owner: OWNER,
      network: "testnet",
    });
    for (const [purpose, pair] of [
      ["agent", TEST_KEYS.agent],
      ["ledger", TEST_KEYS.ledger],
    ] as const) {
      const { id } = await generateKey(
        h.db,
        MASTER,
        { tenantId, purpose, label: purpose, createdBy: OWNER },
        () => KeyPair.fromString(pair.secretKey as KeyPairString),
      );
      await h.db.rpc("agent_key_set_status", {
        tenant_id: tenantId,
        id,
        from: "pending",
        status: "active",
      });
    }
    member = (await memberRole(h.db, SCENARIO_VAULT, OWNER)) as MemberTenant;
    store = new SupabaseLedgerStore(h.db, tenantId);
    const rpc = new RpcClient({ urls: [server.url] });
    deps = {
      db: h.db,
      master: MASTER,
      reader: createVaultReader(rpc),
      keyVerifier: fullAccessKeyVerifier(rpcLoginProvider(rpc)),
      network: "testnet",
      makeProbarion: (o) =>
        makeTenantProbarion("testnet", o, { now: () => NOW, archivalRpc: null }),
    };
    const t = newToken();
    await mintToken(h.db, {
      account: OWNER,
      network: "testnet",
      sha256: t.sha256,
      hint: t.hint,
      label: "test",
    });
    token = t.token;
  });
  afterAll(async () => {
    await server.close();
    await pg.close();
  });
  // A paid invoice uses one of the scenario mandate's ten uses, and a test may revoke it: each test gives it back.
  beforeEach(async () => {
    mandates = server.chain.mandates.map((m) => ({ ...m }));
    await pg.exec("delete from public.rate_limits;");
  });
  afterEach(() => {
    server.chain.mandates.forEach((m, i) => {
      Object.assign(m, mandates[i]);
    });
    h.jar.clear();
  });

  const text = (total = "20.00", payTo = SCENARIO_NEAR_PAYEE) => {
    n += 1;
    return `Invoice EXT-${2000 + n}\nPay to ${payTo}\nTotal ${total} USDC`;
  };

  /** The extension's form. A field given as null is left out. */
  function form(
    o: { vault?: string | null; mandate?: string | null; file?: File | null; body?: string } = {},
  ): FormData {
    const f = new FormData();
    if (o.vault !== null) f.set("vault", o.vault ?? SCENARIO_VAULT);
    if (o.mandate !== null) f.set("mandate", o.mandate ?? "1");
    if (o.file !== null) {
      f.set(
        "file",
        o.file ?? new File([o.body ?? text()], "selection.txt", { type: "text/plain" }),
      );
    }
    return f;
  }

  /**
   * The route's answer to a form (or a string body, sent as JSON), with the test's token unless `bearer` says
   * otherwise (null: no Authorization header), and its Content-Length unless `length` is false.
   */
  async function post(
    body: FormData | string,
    o: { bearer?: string | null; headers?: Record<string, string>; length?: boolean } = {},
  ): Promise<Response> {
    const encoded = new Request(URL_, { method: "POST", body });
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    const type =
      typeof body === "string" ? "application/json" : (encoded.headers.get("content-type") ?? "");
    const bearer = o.bearer === undefined ? token : o.bearer;
    return POST(
      new Request(URL_, {
        method: "POST",
        headers: {
          ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
          "content-type": type,
          ...(o.length === false ? {} : { "content-length": String(bytes.length) }),
          ...o.headers,
        },
        body: bytes,
      }),
    );
  }

  const send = (o: { body?: string; vault?: string; mandate?: string; bearer?: string } = {}) =>
    post(form({ vault: o.vault, mandate: o.mandate, body: o.body }), { bearer: o.bearer });

  async function confirmAsOwner(invoiceId: string, using: ConfirmDeps = deps) {
    const p = await prepareConfirmation(using, { member, account: OWNER, invoiceId });
    if (!p.ok) return p;
    const s = signNep413({
      message: p.message,
      nonce: Buffer.from(p.nonce, "base64"),
      recipient: CONFIRM_RECIPIENT,
      keyPair: ownerKey,
    });
    return confirmInvoice(using, {
      member,
      account: OWNER,
      invoiceId,
      nonce: p.nonce,
      signed: { accountId: OWNER, publicKey: s.publicKey, signature: s.signature },
    });
  }

  const rows = () => listInvoices(h.db, member.tenant_id, 500);
  const idOf = async (r: Response) => ((await r.json()) as { invoice_id: string }).invoice_id;
  const scenarioMandate = () => {
    const m = server.chain.mandates.find((x) => x.id === 1);
    if (m === undefined) throw new Error("no scenario mandate 1");
    return m;
  };

  it("waits for the owner, sends nothing, and pays only when the owner confirms", async () => {
    const spends = server.chain.spends.length;
    const entries = (await store.all()).length;
    const r = await send();
    expect(r.status).toBe(201);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = (await r.json()) as { invoice_id: string; status: string; url: string };
    expect(body.status).toBe("awaiting_owner");
    expect(body.url).toBe(
      `https://testnet.probarion.test/console/${SCENARIO_VAULT}/payables/${body.invoice_id}`,
    );
    const row = (await getInvoice(h.db, member.tenant_id, body.invoice_id)) as InvoiceRow;
    expect(row).toMatchObject({
      status: "awaiting_owner",
      source: "extension",
      outcome: null,
      suggested_amount: "20000000",
      mandate_id: 1,
      created_by: OWNER,
    });
    expect(row.queue_checks).toEqual([
      {
        id: EXTENSION_MANDATE_RULE,
        outcome: "hold",
        detail: `${OWNER} chose mandate 1 in the browser extension. No purpose document was matched, so only the owner's signed Confirm can pay it.`,
      },
      {
        id: PAYEE_RULE,
        outcome: "pass",
        detail: `The invoice's payee, if it names one, does not contradict the mandate's (near:${SCENARIO_NEAR_PAYEE}).`,
      },
      { id: CHECK_SPEND_RULE, outcome: "pass", detail: "The vault would accept this payment now." },
    ]);
    // Queueing sent nothing and wrote nothing to the signed ledger.
    expect(server.chain.spends).toHaveLength(spends);
    expect(await store.all()).toHaveLength(entries);

    const c = await confirmAsOwner(row.id);
    if (!c.ok) throw new Error(`not confirmed: ${JSON.stringify(c)}`);
    expect(c.outcome).toMatchObject({ status: "paid" });
    expect(server.chain.spends).toHaveLength(spends + 1);
    expect(server.chain.spends.at(-1)).toMatchObject({
      mandate_id: 1,
      amount: "20000000",
      invoice_hash: row.invoice_hash,
      ref: row.ref,
    });
    const all = await store.all();
    expect(all.every(verifyEntrySignature)).toBe(true);
    const decision = all.filter((e) => e.body.kind === "decision").at(-1);
    const rule = (id: string) => decision?.body.rules.find((x) => x.id === id)?.outcome;
    // R18: Confirm pays under the chosen mandate, so the signed ledger's purpose rule passes. The row and the page
    // say where the invoice came from.
    expect(rule("invoice.po_mismatch")).toBe("pass");
    expect(rule(OWNER_CONFIRMED_RULE)).toBe("pass");
  });

  it("answers the same invoice twice as a duplicate, with one row", async () => {
    const body = text();
    const first = await send({ body });
    expect(first.status).toBe(201);
    const id = await idOf(first);
    const again = await send({ body });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({
      invoice_id: id,
      status: "awaiting_owner",
      duplicate: true,
    });
    const row = (await getInvoice(h.db, member.tenant_id, id)) as InvoiceRow;
    expect((await rows()).filter((x) => x.invoice_hash === row.invoice_hash)).toHaveLength(1);
  });

  it("refuses what the code or the vault refuses, and stores nothing", async () => {
    const before = (await rows()).length;
    const otherPayee = await send({ body: text("20.00", "other.testnet") });
    expect(otherPayee.status).toBe(422);
    expect(otherPayee.headers.get("cache-control")).toBe("no-store");
    const refused = (await otherPayee.json()) as Record<string, unknown>;
    // R6: the one error with a third key. R42: E2 reads `rule` and `detail` exactly.
    expect(Object.keys(refused).sort()).toEqual(["detail", "error", "rule"]);
    expect(refused).toEqual({
      error: "refused_by_code",
      rule: PAYEE_RULE,
      detail: `invoice names NEAR account other.testnet; the mandate pays ${SCENARIO_NEAR_PAYEE}`,
    });
    const overPerPayment = await send({ body: text("500.00") });
    expect(overPerPayment.status).toBe(422);
    const over = (await overPerPayment.json()) as Record<string, unknown>;
    expect(Object.keys(over).sort()).toEqual(["detail", "error", "rule"]);
    expect(over).toEqual({
      error: "refused_by_code",
      rule: CHECK_SPEND_RULE,
      detail: "the vault would refuse this payment now (OverPerPayment)",
    });
    const noTotal = await send({ body: "Invoice EXT-1\nPay to vendor.testnet\nThanks" });
    expect(noTotal.status).toBe(422);
    expect(await noTotal.json()).toEqual({
      error: "amount_unclear",
      detail: "Couldn't read one clear amount. Upload it in the console instead.",
    });
    const unknownMandate = await send({ mandate: "99" });
    expect(unknownMandate.status).toBe(404);
    expect(await unknownMandate.json()).toEqual({
      error: "mandate_not_found",
      detail: "This mandate is not on the vault.",
    });
    expect((await rows()).length).toBe(before);
  });

  it("answers each refusal of the request's shape with its code, and stores nothing", async () => {
    const before = (await rows()).length;
    /** The answer's status and its whole body: E2 shows `detail` as it is (R42). */
    const answer = async (r: Response) => [r.status, await r.json()];
    const invalid = (detail: string) => [400, { error: "invalid_input", detail }];
    expect(await answer(await post(form({ vault: null })))).toEqual(invalid("Name the vault."));
    expect(await answer(await post(form({ mandate: "abc" })))).toEqual(
      invalid("Choose a mandate."),
    );
    expect(await answer(await post(form({ file: null })))).toEqual(
      invalid("Attach a PDF or a text file."),
    );
    expect(await answer(await post('{"vault":"x"}'))).toEqual(
      invalid("Send the invoice as multipart/form-data"),
    );
    expect(await answer(await post(form(), { length: false }))).toEqual([
      411,
      { error: "length_required", detail: "Send the request with a Content-Length header" },
    ]);
    const tooLong = await post(form(), {
      headers: { "content-length": String(MAX_INVOICE_BYTES + 16 * 1024 + 1) },
    });
    expect(tooLong.status).toBe(413);
    expect(await tooLong.json()).toEqual({
      error: "too_large",
      detail: "The request must be 4,210,688 bytes at most.",
    });
    const big = await post(
      form({
        file: new File([new Uint8Array(MAX_INVOICE_BYTES + 1)], "big.txt", { type: "text/plain" }),
      }),
    );
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({
      error: "too_large",
      detail: "The invoice is larger than 4 MiB (4,194,304 bytes).",
    });
    const docx = new File(["x"], "a.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    expect(await answer(await post(form({ file: docx })))).toEqual([
      415,
      { error: "unsupported", detail: "Send the invoice as a PDF or a plain text (.txt) file" },
    ]);
    expect(await answer(await send({ body: "   \n " }))).toEqual([
      422,
      { error: "empty", detail: "No text in this file. Upload it in the console instead." },
    ]);
    const notUtf8 = new File([new Uint8Array([0xff, 0xfe, 0xfd])], "a.txt", { type: "text/plain" });
    const unreadable = await post(form({ file: notUtf8 }));
    expect(unreadable.status).toBe(422);
    expect(await unreadable.json()).toEqual({
      error: "unreadable",
      detail: "The text file is not UTF-8 text",
    });
    expect((await rows()).length).toBe(before);
  }, 30_000);

  it("answers a mandate that cannot take invoices, missing keys and a full bucket with their codes", async () => {
    const before = (await rows()).length;
    const m = scenarioMandate();
    m.status = "revoked";
    const inactive = await send();
    expect(inactive.status).toBe(422);
    expect(await inactive.json()).toEqual({
      error: "mandate_inactive",
      detail: "This mandate can't take invoices now: mandate 1 is revoked.",
    });
    m.status = "active";
    await pg.query(
      "update public.agent_keys set status = 'revoked', revoked_at = now() where tenant_id = $1 and purpose = 'ledger'",
      [member.tenant_id],
    );
    try {
      const noKeys = await send();
      expect(noKeys.status).toBe(409);
      expect(await noKeys.json()).toEqual({
        error: "no_keys",
        detail: "The vault's keys aren't active. Open the console's Keys tab.",
      });
    } finally {
      await pg.query(
        "update public.agent_keys set status = 'active' where tenant_id = $1 and purpose = 'ledger'",
        [member.tenant_id],
      );
    }
    await pg.query(
      `insert into public.rate_limits (bucket, window_start, count) values ($1, now(), 20)
       on conflict (bucket) do update set window_start = excluded.window_start, count = excluded.count`,
      [`ext:invoice:testnet:${OWNER}`],
    );
    const limited = await send();
    expect(limited.status).toBe(429);
    const retry = limited.headers.get("retry-after");
    expect(retry).toMatch(/^[0-9]+$/);
    expect(await limited.json()).toEqual({
      error: "rate_limited",
      detail: `Try again in ${retry} s`,
    });
    expect((await rows()).length).toBe(before);
  });

  /**
   * The route's answer when one read of the chain fails, and what it leaves behind: no row, no spend, and a warning
   * (not the error Sentry alerts on). The node answers that read with HTTP 400, which the RPC client does not retry,
   * so exactly one request fails. It returns the contract views the fake chain served.
   */
  async function whenNearFails(failAfter: "nothing" | "list_mandates") {
    const before = await rows();
    const spends = server.chain.spends.length;
    const reads: string[] = [];
    const view = server.chain.view.bind(server.chain);
    const spy = vi.spyOn(server.chain, "view").mockImplementation((contract, method, args) => {
      reads.push(method);
      // The request after this one is the one that fails.
      if (method === failAfter) server.failNext([400]);
      return view(contract, method, args);
    });
    try {
      if (failAfter === "nothing") server.failNext([400]);
      const r = await send();
      expect(r.status).toBe(503);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(await r.json()).toEqual({
        error: "chain_unavailable",
        detail: "NEAR could not be read. Nothing was queued. Try again.",
      });
    } finally {
      spy.mockRestore();
    }
    expect(await rows()).toEqual(before);
    expect(server.chain.spends).toHaveLength(spends);
    const said = logs.lines.flatMap((l) => {
      try {
        return [JSON.parse(l) as { level?: unknown; msg?: unknown }];
      } catch {
        return [];
      }
    });
    expect(said.filter((l) => l.msg === "payables.queue_chain_unavailable")).toEqual([
      expect.objectContaining({ level: "warn" }),
    ]);
    expect(said.some((l) => l.msg === "ext.invoice_failed")).toBe(false);
    return reads;
  }

  it("answers 503 chain_unavailable when the vault's mandates cannot be read, and stores nothing", async () => {
    // The route's first read of the chain is list_mandates: it fails, so the fake chain serves no view.
    expect(await whenNearFails("nothing")).toEqual([]);
  });

  it("answers 503 chain_unavailable when the contract's check_spend view cannot be read, and stores nothing", async () => {
    // The mandates are read, the keys and the payee pass, then the free check_spend view fails.
    expect(await whenNearFails("list_mandates")).toEqual(["list_mandates"]);
  });

  it("keeps no file, name or facts in zero-retention mode", async () => {
    await pg.query("update public.tenants set zero_retention = true where id = $1", [
      member.tenant_id,
    ]);
    try {
      const r = await send();
      expect(r.status).toBe(201);
      expect(await getInvoice(h.db, member.tenant_id, await idOf(r))).toMatchObject({
        retained: false,
        filename: null,
        facts: null,
        source: "extension",
      });
    } finally {
      await pg.query("update public.tenants set zero_retention = false where id = $1", [
        member.tenant_id,
      ]);
    }
  });

  it("is never paid once its mandate is revoked, though it was queued before", async () => {
    const id = await idOf(await send());
    scenarioMandate().status = "revoked";
    const spends = server.chain.spends.length;
    const c = await confirmAsOwner(id);
    if (c.ok) expect(c.outcome.status).not.toBe("paid");
    expect(server.chain.spends).toHaveLength(spends);
  });

  it("is never paid once its mandate has expired, though it was queued before", async () => {
    const id = await idOf(await send());
    scenarioMandate().expires_at_ns = (SCENARIO_NOW - 1n).toString();
    const spends = server.chain.spends.length;
    const c = await confirmAsOwner(id);
    if (c.ok) expect(c.outcome.status).not.toBe("paid");
    expect(server.chain.spends).toHaveLength(spends);
  });

  it("refuses an invoice sent again after it was paid: the vault would refuse it as a duplicate", async () => {
    const body = text();
    const id = await idOf(await send({ body }));
    const c = await confirmAsOwner(id);
    if (!c.ok) throw new Error(`not confirmed: ${JSON.stringify(c)}`);
    expect(c.outcome).toMatchObject({ status: "paid" });
    const before = (await rows()).length;
    const again = await send({ body });
    expect(again.status).toBe(422);
    expect(await again.json()).toEqual({
      error: "refused_by_code",
      rule: CHECK_SPEND_RULE,
      detail: "the vault would refuse this payment now (DuplicateInvoice)",
    });
    expect((await rows()).length).toBe(before);
  });

  it("checks the network, the membership and the token, and stores nothing for any of them", async () => {
    const otherVault = "other.vaults.probarion.near";
    const otherTenant = await seedTenant(pg, {
      vault: otherVault,
      owner: OWNER,
      network: "mainnet",
    });
    const before = (await rows()).length;
    const wrong = await send({ vault: otherVault });
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toEqual({
      error: "wrong_network",
      detail: "This vault is on NEAR mainnet, which this site does not serve yet.",
    });
    const stranger = await send({ vault: "nobody.vaults.probarion.testnet" });
    expect(stranger.status).toBe(403);
    expect(await stranger.json()).toEqual({
      error: "not_member",
      detail: "You are not a member of this vault, or your role cannot do this.",
    });
    const noToken = await send({ bearer: "pbx_nope" });
    expect(noToken.status).toBe(401);
    expect(await noToken.json()).toEqual({ error: "bad_token", detail: RECONNECT });
    expect((await rows()).length).toBe(before);
    expect(await listInvoices(h.db, otherTenant, 500)).toEqual([]);
  });

  it("refuses a revoked token, a token of the other network and a cookie with no token", async () => {
    const revoked = newToken();
    const { id } = await mintToken(h.db, {
      account: OWNER,
      network: "testnet",
      sha256: revoked.sha256,
      hint: revoked.hint,
      label: "revoked",
    });
    expect(await revokeToken(h.db, OWNER, "testnet", id)).toMatchObject({ revoked: true });
    const onMainnet = newToken();
    await mintToken(h.db, {
      account: OWNER,
      network: "mainnet",
      sha256: onMainnet.sha256,
      hint: onMainnet.hint,
      label: "mainnet",
    });
    const before = (await rows()).length;
    for (const r of [
      await send({ bearer: revoked.token }),
      await send({ bearer: onMainnet.token }),
      await post(form(), { bearer: null, headers: { cookie: `${SESSION_COOKIE}=x` } }),
    ]) {
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: "bad_token", detail: RECONNECT });
    }
    expect((await rows()).length).toBe(before);
  });

  it("refuses a viewer and a Canary vault, by the role and kind it reads on this request, and stores nothing", async () => {
    const before = (await rows()).length;
    await pg.query(
      "update public.tenant_members set role = 'viewer' where tenant_id = $1 and account_id = $2",
      [member.tenant_id, OWNER],
    );
    try {
      const r = await send();
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({
        error: "not_member",
        detail: "You are not a member of this vault, or your role cannot do this.",
      });
    } finally {
      await pg.query(
        "update public.tenant_members set role = 'owner' where tenant_id = $1 and account_id = $2",
        [member.tenant_id, OWNER],
      );
    }
    expect((await rows()).length).toBe(before);
    const canary = "canary.vaults.probarion.testnet";
    const canaryTenant = await seedTenant(pg, {
      vault: canary,
      owner: OWNER,
      kind: "canary",
      network: "testnet",
    });
    const r = await send({ vault: canary });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({
      error: "not_member",
      detail: "This vault takes no invoices from the extension.",
    });
    // The Canary tenant's own rows: none was stored there, nor in the scenario vault.
    expect(await listInvoices(h.db, canaryTenant, 500)).toEqual([]);
    expect((await rows()).length).toBe(before);
  });

  it("lets an approver of the vault queue with its own token, and the invoice still waits for the owner", async () => {
    await pg.query(
      "insert into public.tenant_members (tenant_id, account_id, role) values ($1, $2, 'approver')",
      [member.tenant_id, SCENARIO_APPROVER],
    );
    try {
      const t = newToken();
      await mintToken(h.db, {
        account: SCENARIO_APPROVER,
        network: "testnet",
        sha256: t.sha256,
        hint: t.hint,
        label: "approver",
      });
      const spends = server.chain.spends.length;
      const r = await send({ bearer: t.token });
      expect(r.status).toBe(201);
      const id = await idOf(r);
      const row = (await getInvoice(h.db, member.tenant_id, id)) as InvoiceRow;
      expect(row).toMatchObject({
        status: "awaiting_owner",
        source: "extension",
        outcome: null,
        created_by: SCENARIO_APPROVER,
      });
      expect(row.queue_checks?.[0]?.detail).toBe(
        `${SCENARIO_APPROVER} chose mandate 1 in the browser extension. No purpose document was matched, so only the owner's signed Confirm can pay it.`,
      );
      // Only the owner confirms or rejects it: the approver is offered neither, and its prepare is refused.
      const approver = (await memberRole(h.db, SCENARIO_VAULT, SCENARIO_APPROVER)) as MemberTenant;
      expect(approver.role).toBe("approver");
      const w = await loadWaitingView(
        { db: h.db, master: MASTER, reader: createVaultReader(new RpcClient({ urls: [h.url] })) },
        {
          member: approver,
          account: SCENARIO_APPROVER,
          row,
          entries: await store.all(),
          now: new Date(),
        },
      );
      expect(w).toMatchObject({
        canConfirm: false,
        canReject: false,
        whyNot: "Only the owner can confirm or reject this invoice.",
      });
      expect(
        await prepareConfirmation(deps, {
          member: approver,
          account: SCENARIO_APPROVER,
          invoiceId: id,
        }),
      ).toMatchObject({ ok: false, reason: "not_owner" });
      expect(server.chain.spends).toHaveLength(spends);
      expect(await getInvoice(h.db, member.tenant_id, id)).toMatchObject({
        status: "awaiting_owner",
      });
    } finally {
      await pg.query("delete from public.tenant_members where tenant_id = $1 and account_id = $2", [
        member.tenant_id,
        SCENARIO_APPROVER,
      ]);
    }
  });

  it("answers an invoice whose number the payee's invoice from the other intake has as a duplicate", async () => {
    // The console upload keys an invoice as pipeline.ts does: the fingerprint of its text, and the HMAC of the vault,
    // the mandate's payee and the invoice number. Another layout of the same invoice has another text and hash.
    const payee = { type: "near" as const, account_id: SCENARIO_NEAR_PAYEE };
    const consoleRow = (body: string) => {
      const hash = hashInvoice(body);
      const { invoiceNumber } = extractFacts(body, hash, null);
      if (invoiceNumber === null) throw new Error("the test's invoice has no number");
      return insertInvoice(h.db, member.tenant_id, {
        invoiceHash: hash,
        ref: refFor(hash),
        filename: null,
        mediaType: "text/plain",
        documentSha256: sha256Hex(body),
        sealed: null,
        facts: null,
        amountIssue: null,
        fingerprint: sha256Hex(fingerprintText(body)),
        invoiceNumberKey: invoiceNumberKey(MASTER, SCENARIO_VAULT, payee, invoiceNumber),
        requestId: `req-console-${hash.slice(0, 8)}`,
        createdBy: OWNER,
      });
    };
    // The extension first, then the console upload of another layout of it.
    const queued = await send({ body: "Invoice NUM-501\nPay to vendor.testnet\nTotal 20.00 USDC" });
    expect(queued.status).toBe(201);
    const queuedId = await idOf(queued);
    expect(
      await consoleRow("INVOICE NUM-501\nBill to Acme\nPay to vendor.testnet\nTotal 20.00 USDC"),
    ).toEqual({ id: queuedId, duplicate: true, status: "awaiting_owner" });
    // The console upload first (its cycle still running), then the extension's copy in another layout.
    const uploaded = await consoleRow("Invoice NUM-502\nPay to vendor.testnet\nTotal 21.00 USDC");
    expect(uploaded).toMatchObject({ duplicate: false });
    const before = (await rows()).length;
    const again = await send({
      body: "INVOICE NUM-502\nBill to Acme\nPay to vendor.testnet\nTotal 21.00 USDC",
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({
      invoice_id: uploaded.id,
      status: "processing",
      duplicate: true,
      url: `https://testnet.probarion.test/console/${SCENARIO_VAULT}/payables/${uploaded.id}`,
    });
    expect((await rows()).length).toBe(before);
  });

  it("lets members read source and queue_checks", async () => {
    const id = await idOf(await send());
    const read = await asRole(pg, "authenticated", OWNER, (tx) =>
      tx.query<{ source: string; queue_checks: unknown[] }>(
        "select source, queue_checks from public.invoices where id = $1",
        [id],
      ),
    );
    expect(read.rows[0]?.source).toBe("extension");
    expect(read.rows[0]?.queue_checks).toHaveLength(3);
  });

  it("shows the queued invoice to the owner with its checks, and offers Confirm", async () => {
    const id = await idOf(await send());
    const row = (await getInvoice(h.db, member.tenant_id, id)) as InvoiceRow;
    const w = await loadWaitingView(
      { db: h.db, master: MASTER, reader: createVaultReader(new RpcClient({ urls: [h.url] })) },
      { member, account: OWNER, row, entries: await store.all(), now: new Date() },
    );
    expect(w).toMatchObject({
      source: "extension",
      queued: true,
      canConfirm: true,
      whyNot: null,
      uploadedBy: OWNER,
    });
    expect(w.reasons.owner).toBeNull();
    expect(w.reasons.before.map((r) => [r.id, r.outcome])).toEqual([
      [EXTENSION_MANDATE_RULE, "hold"],
      [PAYEE_RULE, "pass"],
      [CHECK_SPEND_RULE, "pass"],
    ]);
  });

  it("offers Reject to the owner alone, and a rejected invoice is never paid", async () => {
    // A stolen token's answer: the owner rejects what it queued (SPEC6:315, RUNBOOK:283 after R29).
    const spends = server.chain.spends.length;
    const id = await idOf(await send());
    const row = (await getInvoice(h.db, member.tenant_id, id)) as InvoiceRow;
    const reader = createVaultReader(new RpcClient({ urls: [h.url] }));
    const entries = await store.all();
    const asOwner = await loadWaitingView(
      { db: h.db, master: MASTER, reader },
      { member, account: OWNER, row, entries, now: new Date() },
    );
    expect(asOwner.canReject).toBe(true);
    const asApprover = await loadWaitingView(
      { db: h.db, master: MASTER, reader },
      {
        member: { ...member, role: "approver" },
        account: "approver.testnet",
        row,
        entries,
        now: new Date(),
      },
    );
    expect(asApprover.canReject).toBe(false);
    if (asOwner.snapshot === null) throw new Error("a waiting row has no snapshot");
    const r = await rejectWaitingInvoice(
      { db: h.db },
      { member, account: OWNER, invoiceId: id, seen: asOwner.snapshot },
    );
    expect(r.ok).toBe(true);
    expect(await getInvoice(h.db, member.tenant_id, id)).toMatchObject({
      status: "rejected",
      rejected_by: OWNER,
      source: "extension",
    });
    const c = await confirmAsOwner(id);
    expect(c.ok).toBe(false);
    expect(server.chain.spends).toHaveLength(spends);
  });

  it("shows where the invoice came from on its page, before and after the owner confirms it", async () => {
    const id = await idOf(await send());
    h.jar.set(
      SESSION_COOKIE,
      await createSessionToken(await deriveSubkey(MASTER, "session"), OWNER, "testnet"),
    );
    const html = async () =>
      renderToStaticMarkup(
        (await InvoicePage({
          params: Promise.resolve({ vault: SCENARIO_VAULT, id }),
        })) as ReactElement,
      );
    const waiting = await html();
    expect(waiting).toContain("Waiting for you: sent from the browser extension");
    expect(waiting).toContain("so no cycle ran and nothing was sent.");
    expect(waiting).toContain("· sent from the browser extension");
    expect(waiting).toContain(EXTENSION_MANDATE_RULE);
    expect(waiting).not.toContain("No attested model confirmed");
    expect(waiting).not.toContain("Checks when it was queued");
    const c = await confirmAsOwner(id);
    if (!c.ok) throw new Error(`not confirmed: ${JSON.stringify(c)}`);
    const paid = await html();
    expect(paid).toContain("Checks when it was queued");
    expect(paid).toContain("No purpose document was matched.");
    expect(paid).toContain(EXTENSION_MANDATE_RULE);
    expect(paid).toContain("· sent from the browser extension");
  });

  it("says a Confirm that the code held again ran a cycle, and that nothing was sent", async () => {
    const id = await idOf(await send());
    // A rule of the code holds the confirmed cycle. Below the approval limit the contract would pay at once, so the
    // SDK holds it off chain and sends nothing, and the row waits for the owner again, now with that outcome.
    const HOLD = "custom.test_hold" as const;
    const holding: ConfirmDeps = {
      ...deps,
      makeProbarion: (o) => {
        const pb = deps.makeProbarion(o);
        pb.rules.add({
          id: HOLD,
          check: () => ({ id: HOLD, outcome: "hold", detail: "Held by the test's own rule." }),
        });
        return pb;
      },
    };
    const spends = server.chain.spends.length;
    const c = await confirmAsOwner(id, holding);
    if (!c.ok) throw new Error(`not confirmed: ${JSON.stringify(c)}`);
    expect(c.outcome).toMatchObject({ status: "held", spendId: null, txHash: null });
    expect(server.chain.spends).toHaveLength(spends);
    const row = (await getInvoice(h.db, member.tenant_id, id)) as InvoiceRow;
    expect(row).toMatchObject({
      status: "awaiting_owner",
      source: "extension",
      confirmed_by: OWNER,
    });
    expect(row.outcome).toMatchObject({ status: "held", code: HOLD });
    const w = await loadWaitingView(
      { db: h.db, master: MASTER, reader: createVaultReader(new RpcClient({ urls: [h.url] })) },
      { member, account: OWNER, row, entries: await store.all(), now: new Date() },
    );
    expect(w).toMatchObject({
      source: "extension",
      queued: false,
      lastConfirmation: { by: OWNER },
    });
    expect(w.reasons.before.map((r) => [r.id, r.outcome])).toContainEqual([HOLD, "hold"]);
    h.jar.set(
      SESSION_COOKIE,
      await createSessionToken(await deriveSubkey(MASTER, "session"), OWNER, "testnet"),
    );
    const page = renderToStaticMarkup(
      (await InvoicePage({
        params: Promise.resolve({ vault: SCENARIO_VAULT, id }),
      })) as ReactElement,
    );
    expect(page).toContain("Waiting for you: sent from the browser extension");
    expect(page).toContain("Confirm ran a cycle, which the rule below held, and nothing was sent.");
    expect(page).not.toContain("no cycle ran");
    expect(page).toContain(HOLD);
  });

  it("lets only the service role call invoice_queue, as a definer with a fixed search path", async () => {
    const grants = await pg.query<{ grantee: string }>(
      `select distinct a.grantee::regrole::text as grantee
         from pg_proc p, aclexplode(p.proacl) a
        where p.oid = 'public.invoice_queue(jsonb)'::regprocedure and a.privilege_type = 'EXECUTE'
          and a.grantee <> p.proowner`,
    );
    expect(grants.rows.map((x) => x.grantee)).toEqual(["service_role"]);
    const fn = await pg.query<{ prosecdef: boolean; proconfig: string[] | null }>(
      "select prosecdef, proconfig from pg_proc where oid = 'public.invoice_queue(jsonb)'::regprocedure",
    );
    expect(fn.rows[0]?.prosecdef).toBe(true);
    expect(fn.rows[0]?.proconfig).toEqual([
      expect.stringMatching(/^search_path=public, ?pg_temp$/),
    ]);
    for (const role of ["anon", "authenticated"] as const) {
      await expect(pgliteDb(pg, role, OWNER).rpc("invoice_queue", {})).rejects.toMatchObject({
        code: "permission_denied",
      });
    }
  });

  it("stores no refusal and nothing malformed through invoice_queue itself", async () => {
    const hold = { id: EXTENSION_MANDATE_RULE, outcome: "hold", detail: "x" };
    const base = {
      tenant_id: member.tenant_id,
      invoice_hash: "e".repeat(64),
      ref: "inv-eeeeeeeeeeeeeeeeeeeeeeee",
      filename: null,
      media_type: "text/plain",
      document_sha256: "e".repeat(64),
      fingerprint_sha256: "f".repeat(64),
      invoice_number_hmac: null,
      retained: false,
      content_ciphertext: null,
      content_nonce: null,
      facts: null,
      amount_issue: null,
      request_id: "req-bad",
      created_by: OWNER,
      suggested_amount: "20000000",
      mandate_id: 1,
      queue_checks: [hold],
    };
    for (const bad of [
      { ...base, suggested_amount: "0" },
      { ...base, mandate_id: 0 },
      { ...base, queue_checks: [] },
      { ...base, queue_checks: [{ id: "x", outcome: "refuse", detail: "no" }] },
      { ...base, queue_checks: "nope" },
      // R9 (D3): exactly one extension.mandate_chosen check, and it is a hold.
      { ...base, queue_checks: [{ id: CHECK_SPEND_RULE, outcome: "pass", detail: "x" }] },
      { ...base, queue_checks: [{ ...hold, outcome: "pass" }] },
      { ...base, queue_checks: [hold, hold] },
    ]) {
      await expect(h.db.rpc("invoice_queue", bad)).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect((await rows()).some((x) => x.ref === base.ref)).toBe(false);
    // A check keeps only its three fields, in order.
    const ok = await h.db.rpc<{ id: string; duplicate: boolean; status: string }>("invoice_queue", {
      ...base,
      invoice_hash: "d".repeat(64),
      ref: `inv-${"d".repeat(24)}`,
      document_sha256: "d".repeat(64),
      fingerprint_sha256: "c".repeat(64),
      request_id: "req-extra",
      queue_checks: [
        { ...hold, extra: "dropped" },
        { id: PAYEE_RULE, outcome: "pass", detail: "y", n: 1 },
      ],
    });
    expect(ok).toMatchObject({ duplicate: false, status: "awaiting_owner" });
    const stored = await pg.query<{ source: string; queue_checks: unknown }>(
      "select source, queue_checks from public.invoices where id = $1",
      [ok.id],
    );
    expect(stored.rows[0]).toEqual({
      source: "extension",
      queue_checks: [hold, { id: PAYEE_RULE, outcome: "pass", detail: "y" }],
    });
    // R11: an extension row keeps its checks, and a console row has none.
    await expect(
      pg.query("update public.invoices set queue_checks = null where id = $1", [ok.id]),
    ).rejects.toThrow(/invoices_queue_checks_source/);
  });
});
