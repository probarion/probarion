import type { PGlite } from "@electric-sql/pglite";
import { type MandateView, NETWORKS, type Payee, type SpendView } from "@probarion/core";
import { NextRequest } from "next/server";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/session";
import { deriveSubkey, parseMasterKey } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import type { VaultReader } from "@/lib/near/reader";
import type { WalletTx } from "@/lib/near/tx";
import { insertInvoice, setInvoiceOutcome } from "@/lib/payables/store";
import { proxy } from "@/proxy";
import { freshDb, seedTenant } from "../../../test/db/harness";
import { pgliteDb } from "../../../test/db/pglite-db";
import { fakeReader, vaultConfig } from "../../../test/fixtures/reader";
import { transportError } from "../../../test/fixtures/rpc";

// The approval page an alert links to (roadmap G2): /console/<vault>/approve/<spend>. It shows the held spend as the chain
// reads it, and offers the vault's approve and reject, signed in the approver's own wallet, only to an account the chain
// lists as an approver and only while the chain reads the spend as held. The server signs nothing.

const h = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  db: null as unknown as Db,
  reader: null as unknown as VaultReader,
  /** Every wallet button the page rendered, with what it would ask the wallet to sign. */
  buttons: [] as {
    label: string;
    expectedSigner?: string;
    tx?: WalletTx;
    wide?: boolean;
    hidePreview?: boolean;
  }[],
  /** Every chain view the page asked for. */
  views: [] as string[],
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name) } : undefined),
  }),
  headers: async () => ({ get: () => null }),
}));
vi.mock("@/lib/crypto/server", async () => {
  const sodium = await import("@/lib/crypto/sodium");
  const master = sodium.parseMasterKey(Buffer.alloc(32, 9).toString("base64"));
  return {
    masterKey: () => master,
    subkey: (purpose: Parameters<typeof sodium.deriveSubkey>[1]) =>
      sodium.deriveSubkey(master, purpose),
  };
});
vi.mock("@/lib/db/clients", () => ({ serviceDb: () => h.db }));
vi.mock("@/lib/env", async () => {
  const { networkPart } = await import("../../../test/fixtures/networks");
  return { getEnv: () => networkPart({ defaultNetwork: "mainnet" }) };
});
vi.mock("@/lib/near/server", async () => {
  const { NETWORKS: N } = await import("@probarion/core");
  return {
    getReader: () => h.reader,
    getRpc: () => ({}),
    chainConsts: () => N.mainnet,
  };
});
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => null,
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("@/components/wallet/TxButton", () => ({
  TxButton: (p: {
    label: string;
    expectedSigner?: string;
    tx?: WalletTx;
    wide?: boolean;
    hidePreview?: boolean;
  }) => {
    h.buttons.push({
      label: p.label,
      expectedSigner: p.expectedSigner,
      tx: p.tx,
      wide: p.wide,
      hidePreview: p.hidePreview,
    });
    return createElement("button", { type: "button" }, p.label);
  },
}));

import ApprovePage from "@/app/console/[vault]/approve/[spend]/page";

const MASTER = parseMasterKey(Buffer.alloc(32, 9).toString("base64"));
const VAULT = "acme.vaults.probarion.near";
const OTHER = "other.vaults.probarion.near";
const AGENT = `ed25519:${"3".repeat(44)}`;
const H = (c: string) => c.repeat(64);

let pg: PGlite;
let db: Db;
let tenant: string;

beforeAll(async () => {
  pg = await freshDb();
  db = pgliteDb(pg);
  // cfo.near is an approver on chain; ex.near is one in the console's list whom the chain no longer lists.
  tenant = await seedTenant(pg, {
    vault: VAULT,
    owner: "acme.near",
    approvers: ["cfo.near", "ex.near"],
  });
  await pg.query(
    "insert into public.tenant_members (tenant_id, account_id, role) values ($1, 'view.near', 'viewer')",
    [tenant],
  );
  await seedTenant(pg, { vault: OTHER, owner: "other.near", approvers: ["cfo.near"] });
});
afterAll(async () => {
  await pg.close();
});

const inAnHour = String(BigInt(Date.now() + 3_600_000) * 1_000_000n);
const spend = (over: Partial<SpendView> = {}): SpendView => ({
  id: 7,
  mandate_id: 2,
  amount: "4000000",
  invoice_hash: H("f"),
  ref: "inv-7",
  decision_hash: H("d"),
  agent_pk: AGENT,
  destination: { type: "near", account_id: "payee.near" },
  status: "held",
  created_at_ns: "1",
  held_until_ns: inAnHour,
  memo: null,
  ...over,
});
const mandate = (over: Partial<MandateView> = {}): MandateView => ({
  id: 2,
  payee: { type: "near", account_id: "payee.near" },
  purpose_hash: H("a"),
  max_per_payment: "5000000",
  max_total: "20000000",
  spent: "0",
  reserved: "4000000",
  max_uses: 5,
  uses: 1,
  expires_at_ns: inAnHour,
  approval_above: "3000000",
  agent_pk: AGENT,
  label: "Sample PO-1001",
  status: "active",
  created_at_ns: "1",
  ...over,
});

/** A console invoice for the tenant, with the hash and the ref the chain records for it. */
async function invoice(o: {
  hash: string;
  ref: string;
  number: string;
  amount: string;
  fingerprint: string;
}): Promise<string> {
  const { id } = await insertInvoice(db, tenant, {
    invoiceHash: o.hash,
    ref: o.ref,
    filename: `invoice-${o.number}.txt`,
    mediaType: "text/plain",
    documentSha256: H("e"),
    sealed: { ciphertext: "Y2lwaGVy", nonce: "bm9uY2U=" },
    facts: {
      invoice_hash: o.hash,
      amount: o.amount,
      po_ref: null,
      purpose_hash: null,
      payee_hint: null,
      invoice_number: o.number,
    },
    amountIssue: null,
    fingerprint: o.fingerprint,
    invoiceNumberKey: null,
    requestId: `r-${o.number}`,
    createdBy: "acme.near",
  });
  return id;
}
/** The console's cycle sent spend `spendId` from the invoice, and the vault held it. */
const sentAs = (id: string, spendId: number) =>
  setInvoiceOutcome(db, tenant, id, {
    status: "decided",
    outcome: {
      status: "held",
      spendId,
      code: null,
      txHash: "tx",
      ledgerSeq: 1,
      decisionHash: H("d"),
      anchorTxHash: null,
    },
    anchorTxHash: null,
    promptTokens: null,
    completionTokens: null,
  });

function chain(
  s: SpendView | null | "throw" = spend(),
  over: { approvers?: string[]; frozen?: boolean; mandate?: MandateView | null } = {},
) {
  const seen = (name: string) => h.views.push(name);
  h.reader = fakeReader({
    getConfig: async () => {
      seen("get_config");
      return vaultConfig({
        approvers: over.approvers ?? ["cfo.near"],
        frozen: over.frozen ?? false,
      });
    },
    getSpend: async (_vault, id) => {
      seen(`get_spend ${id}`);
      if (s === "throw") throw transportError();
      return s;
    },
    getMandate: async (_vault, id) => {
      seen(`get_mandate ${id}`);
      return "mandate" in over ? (over.mandate ?? null) : mandate();
    },
    listSpends: async () => {
      seen("list_spends");
      return [];
    },
  });
}

beforeEach(() => {
  h.jar.clear();
  h.buttons.length = 0;
  h.views.length = 0;
  h.db = db;
  chain();
});

async function signInAs(account: string) {
  h.jar.set(
    SESSION_COOKIE,
    await createSessionToken(await deriveSubkey(MASTER, "session"), account, "mainnet"),
  );
}
const page = (vault = VAULT, id = "7") =>
  ApprovePage({ params: Promise.resolve({ vault, spend: id }) });
const html = async (vault = VAULT, id = "7") =>
  renderToStaticMarkup((await page(vault, id)) as ReactElement).replaceAll("&#x27;", "'");
async function digest(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as { digest?: unknown }).digest ?? e);
  }
  return "no throw";
}
const labels = () => h.buttons.map((b) => b.label);

describe("the approval page, for an approver the chain lists", () => {
  it("shows the held spend as the chain reads it: amount, payee, mandate, hold reason and hold end", async () => {
    await signInAs("cfo.near");
    const out = await html();
    expect(out).toContain("Spend #7");
    expect(out).toContain("4 USDC");
    expect(out).toContain("payee.near");
    expect(out).toContain("Mandate #2");
    expect(out).toContain("Sample PO-1001");
    expect(out).toContain("4 USDC is above the mandate's approval threshold of 3 USDC.");
    expect(out).toContain("Hold ends");
    expect(out).toContain("inv-7");
    expect(out).toContain(H("f"));
    expect(h.views).toEqual(expect.arrayContaining(["get_config", "get_spend 7", "get_mandate 2"]));
  });

  it("offers the vault's approve and reject of this spend, each signed by the approver's own wallet", async () => {
    await signInAs("cfo.near");
    await html();
    expect(labels()).toEqual(["Approve 4 USDC", "Reject"]);
    const [approve, reject] = h.buttons;
    for (const [b, method, gas] of [
      [approve, "approve", "150000000000000"],
      [reject, "reject", "30000000000000"],
    ] as const) {
      expect(b?.expectedSigner).toBe("cfo.near");
      expect(b?.tx?.receiverId).toBe(VAULT);
      expect(b?.tx?.actions).toEqual([
        {
          type: "FunctionCall",
          params: { methodName: method, args: { spend_id: 7 }, gas, deposit: "1" },
        },
      ]);
    }
  });

  it("names the invoice the console sent this spend from: the chain's hash and ref, and its outcome is spend #7", async () => {
    const id = await invoice({
      hash: H("f"),
      ref: "inv-7",
      number: "INV-2003",
      amount: "4000000",
      fingerprint: H("c"),
    });
    await sentAs(id, 7);
    await signInAs("cfo.near");
    const out = await html();
    expect(out).toContain("INV-2003");
    expect(out).toContain(`href="/console/${VAULT}/payables/${id}"`);
    expect(out).toContain("The invoice reads 4 USDC.");
    expect(out).not.toContain("did not send this spend");
    // Another spend's invoice is not this one's.
    chain(spend({ invoice_hash: H("b"), ref: "inv-8" }));
    const other = await html();
    expect(other).not.toContain("INV-2003");
    expect(other).toContain("None of the console's 200 most recent invoices matches this spend");
  });

  it("does not vouch for an invoice whose hash and ref an agent reused for a larger spend", async () => {
    // An invoice the console has not sent (it waits for the owner); an agent reuses its hash and ref with the SDK.
    await invoice({
      hash: H("9"),
      ref: "inv-9",
      number: "INV-2009",
      amount: "4000000",
      fingerprint: H("8"),
    });
    chain(spend({ invoice_hash: H("9"), ref: "inv-9", amount: "4500000" }));
    await signInAs("cfo.near");
    const out = await html();
    expect(out).toContain("the console did not send this spend from it");
    expect(out).toContain("The invoice reads 4 USDC, not the spend's 4.5 USDC.");
    expect(labels()).toEqual(["Approve 4.5 USDC", "Reject"]);
  });

  it("puts the decision right under the amount and the payee, before the mandate and the invoice", async () => {
    await signInAs("cfo.near");
    const out = await html();
    const amount = out.indexOf("4 USDC");
    const button = out.indexOf("<button");
    expect(amount).toBeGreaterThan(-1);
    expect(button).toBeGreaterThan(amount);
    expect(button).toBeLessThan(out.indexOf("Mandate #2"));
    expect(button).toBeLessThan(out.indexOf("inv-7"));
  });

  it("reads a spend to an Intents payee in the payee's asset, not the vault's token", async () => {
    const odd: Payee = {
      type: "intents",
      chain: "base",
      address: `0x${"a".repeat(40)}`,
      asset: "wbtc.omft.near",
    };
    await signInAs("cfo.near");
    chain(spend({ destination: odd }), { mandate: mandate({ payee: odd }) });
    const out = await html();
    const units = (n: string) => `${n} base units of wbtc.omft.near (decimals unknown)`;
    expect(labels()).toEqual([`Approve ${units("4000000")}`, "Reject"]);
    expect(out).toContain(
      `${units("4000000")} is above the mandate's approval threshold of ${units("3000000")}.`,
    );
    // The chain's USDC asset on Base is USDC, with its 6 decimals.
    const usdc: Payee = { ...odd, asset: NETWORKS.mainnet.allowedAssets.base };
    h.buttons.length = 0;
    chain(spend({ destination: usdc }), { mandate: mandate({ payee: usdc }) });
    await html();
    expect(labels()).toEqual(["Approve 4 USDC", "Reject"]);
  });

  it("wraps a long account id at phone width: a 64-character implicit payee and the signer line", async () => {
    const implicit = "a".repeat(64);
    await signInAs("cfo.near");
    chain(spend({ destination: { type: "near", account_id: implicit } }));
    const out = await html();
    expect(out).toMatch(
      new RegExp(
        `<span class="[^"]*\\b(break-all|wrap-anywhere)\\b[^"]*"><a [^>]*>${implicit}</a></span>`,
      ),
    );
    expect(out).toMatch(/<p class="[^"]*\bwrap-anywhere\b[^"]*">Your wallet signs as/);
  });

  it("offers reject only, and says why, when the vault is frozen", async () => {
    await signInAs("cfo.near");
    chain(spend(), { frozen: true });
    const out = await html();
    expect(labels()).toEqual(["Reject"]);
    expect(out).toContain("The vault is frozen");
  });

  it("offers reject only when the mandate was revoked", async () => {
    await signInAs("cfo.near");
    chain(spend(), { mandate: mandate({ status: "revoked" }) });
    const out = await html();
    expect(labels()).toEqual(["Reject"]);
    expect(out).toContain("MandateInactive");
  });
});

describe("the approval page's look, on a phone and for WCAG AAA", () => {
  /** Text colours that read below 7:1 on the card or the page, and the 12px text whose line height is below 1.5. */
  const BELOW_AAA = /\b(text-mute|text-wait|text-ok|text-plan|text-xs)\b/;

  it("gives each decision the whole row, and one line that says what the wallet signs, not one per button", async () => {
    await signInAs("cfo.near");
    const out = await html();
    expect(h.buttons.map((b) => [b.wide, b.hidePreview])).toEqual([
      [true, true],
      [true, true],
    ]);
    expect(out).toContain(
      `Your wallet signs as cfo.near: the vault's approve or reject of spend #7 on ${VAULT}, with 1 yoctoNEAR attached.`,
    );
  });

  it("says the spend's status under the title, and how long the hold has left", async () => {
    await signInAs("cfo.near");
    const out = await html();
    expect(out).toMatch(
      /<h1[^>]*>Spend #7<\/h1><p[^>]*><span[^>]*><span aria-hidden="true"[^>]*><\/span>Held for approval<\/span><\/p>/,
    );
    expect(out).toMatch(/>(59 min|1 h 0 min) left</);
  });

  for (const [name, setUp, account] of [
    ["an approver's page", () => chain(), "cfo.near"],
    ["the owner's page", () => chain(), "acme.near"],
    ["a frozen vault", () => chain(spend(), { frozen: true }), "cfo.near"],
    ["a paid spend", () => chain(spend({ status: "paid", held_until_ns: null })), "cfo.near"],
    ["a missing spend", () => chain(null), "cfo.near"],
    ["an unreadable spend", () => chain("throw"), "cfo.near"],
  ] as const) {
    it(`uses no text colour below 7:1 and no 12px text on ${name}`, async () => {
      setUp();
      await signInAs(account);
      expect(await html()).not.toMatch(BELOW_AAA);
    });
  }
});

describe("the approval page refuses to offer approve", () => {
  it("to the owner, whom the chain does not list as an approver", async () => {
    await signInAs("acme.near");
    const out = await html();
    expect(h.buttons).toEqual([]);
    expect(out).toContain("Only the vault's approvers can approve or reject");
    expect(out).toContain("acme.near");
    // The spend itself is still shown, as the chain reads it.
    expect(out).toContain("4 USDC");
  });

  it("to an approver in the console's list whom the chain no longer lists", async () => {
    await signInAs("ex.near");
    const out = await html();
    expect(h.buttons).toEqual([]);
    expect(out).toContain("Only the vault's approvers can approve or reject");
  });

  it("to a viewer of the vault", async () => {
    await signInAs("view.near");
    await html();
    expect(h.buttons).toEqual([]);
  });

  for (const [status, line] of [
    ["pending", "Pending"],
    ["paid", "Paid"],
    ["burned", "Paid out via Intents"],
    ["failed", "Failed, released"],
    ["rejected", "Rejected"],
    ["expired", "Hold expired"],
  ] as const) {
    it(`for a spend the chain reads as ${status}, and says so under the title`, async () => {
      await signInAs("cfo.near");
      chain(spend({ status, held_until_ns: null }));
      const out = await html();
      expect(h.buttons).toEqual([]);
      expect(out).toContain("Nothing to approve");
      expect(out).toMatch(
        new RegExp(
          `</h1><p[^>]*><span[^>]*><span aria-hidden="true"[^>]*></span>${line}</span></p>`,
        ),
      );
    });
  }

  it("for a spend id the vault has no spend for", async () => {
    await signInAs("cfo.near");
    chain(null);
    const out = await html();
    expect(h.buttons).toEqual([]);
    expect(out).toContain("This vault has no spend #7");
  });

  it("when the spend cannot be read", async () => {
    await signInAs("cfo.near");
    chain("throw");
    const out = await html();
    expect(h.buttons).toEqual([]);
    expect(out).toContain("could not be read");
    expect(out).toContain("NEAR could not be reached");
  });

  it("when the spend answer is another spend's", async () => {
    await signInAs("cfo.near");
    chain(spend({ id: 8 }));
    const out = await html();
    expect(h.buttons).toEqual([]);
    expect(out).toContain("could not be read");
  });
});

describe("the approval page's guard", () => {
  it("is a 404 for an account that is no member of the vault, before any chain read", async () => {
    await signInAs("stranger.near");
    expect(await digest(page())).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(h.views).toEqual([]);
  });

  it("is a 404 for a vault that is not registered, the same as for a stranger", async () => {
    await signInAs("cfo.near");
    expect(await digest(page("nope.vaults.probarion.near"))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(h.views).toEqual([]);
  });

  it("is a 404 for a spend id that is not a spend id, before any chain read", async () => {
    await signInAs("cfo.near");
    for (const id of ["0", "07", "-1", "abc", "1.5", "9007199254740992", "%37"]) {
      expect(await digest(page(VAULT, id)), id).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    }
    expect(h.views).toEqual([]);
  });

  it("reads the vault of the path: a member of another vault sees only that vault's spend", async () => {
    await signInAs("cfo.near");
    await html(OTHER);
    expect(h.buttons.map((b) => b.tx?.receiverId)).toEqual([OTHER, OTHER]);
  });

  it("sends a signed-out visitor to sign in", async () => {
    expect(await digest(page())).toMatch(/^NEXT_REDIRECT;[a-z]+;\/login/);
    expect(h.views).toEqual([]);
  });

  it("brings a signed-out visitor from the alert's link back to it after sign-in", () => {
    const path = `/console/${VAULT}/approve/7`;
    const res = proxy(new NextRequest(`https://probarion.xyz${path}`));
    expect(res.status).toBe(307);
    const to = new URL(res.headers.get("location") ?? "");
    expect(to.pathname).toBe("/login");
    expect(to.searchParams.get("next")).toBe(path);
  });
});
