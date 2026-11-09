import type { PGlite } from "@electric-sql/pglite";
import type { SpendView } from "@probarion/core";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/session";
import { deriveSubkey, parseMasterKey } from "@/lib/crypto/sodium";
import type { Db } from "@/lib/db/port";
import type { VaultReader } from "@/lib/near/reader";
import { freshDb, seedTenant } from "../../../test/db/harness";
import { pgliteDb } from "../../../test/db/pglite-db";
import { fakeReader, vaultConfig } from "../../../test/fixtures/reader";
import { transportError } from "../../../test/fixtures/rpc";

// The retention loop on the vault overview (site audit P1-18): a spend held for approval puts its card first, where the
// alert's #held link lands, and the card offers an alert for next time to whoever may set one and has none for it.

const h = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  db: null as unknown as Db,
  reader: null as unknown as VaultReader,
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
  TxButton: (p: { label: string }) => createElement("button", { type: "button" }, p.label),
}));

import VaultPage from "@/app/console/[vault]/page";

const MASTER = parseMasterKey(Buffer.alloc(32, 9).toString("base64"));
/** No alerts at all. */
const VAULT = "acme.vaults.probarion.near";
/** A confirmed alert with the default kinds, which hold spend_held. */
const ALERTED = "alerted.vaults.probarion.near";
/** A confirmed alert for paid spends only. */
const PAID_ONLY = "paidonly.vaults.probarion.near";
/** An alert with the default kinds whose address was never confirmed: it sends nothing. */
const UNCONFIRMED = "unconfirmed.vaults.probarion.near";
const AGENT = `ed25519:${"3".repeat(44)}`;
const OFFER = "Get a message next time";
const HELD = "Held for approval";

let pg: PGlite;
let db: Db;
/** The database functions the page called, by name. */
const called: string[] = [];

const createAlert = (tenant: string, kinds?: string[]) =>
  db.rpc<{ link_code: string }>("alert_subscription_create", {
    tenant_id: tenant,
    channel: "email",
    target: "owner@example.com",
    created_by: "acme.near",
    ...(kinds ? { kinds } : {}),
  });
async function confirmedAlert(tenant: string, kinds?: string[]) {
  const c = await createAlert(tenant, kinds);
  await db.rpc("alert_subscription_verify", { channel: "email", link_code: c.link_code });
}

beforeAll(async () => {
  pg = await freshDb();
  db = pgliteDb(pg);
  const plain = await seedTenant(pg, {
    vault: VAULT,
    owner: "acme.near",
    approvers: ["cfo.near"],
  });
  await pg.query(
    "insert into public.tenant_members (tenant_id, account_id, role) values ($1, 'view.near', 'viewer')",
    [plain],
  );
  await confirmedAlert(await seedTenant(pg, { vault: ALERTED, owner: "acme.near" }));
  await confirmedAlert(await seedTenant(pg, { vault: PAID_ONLY, owner: "acme.near" }), [
    "spend_paid",
  ]);
  await createAlert(await seedTenant(pg, { vault: UNCONFIRMED, owner: "acme.near" }));
});
afterAll(async () => {
  await pg.close();
});

const inAnHour = String(BigInt(Date.now() + 3_600_000) * 1_000_000n);
const anHourAgo = String(BigInt(Date.now() - 3_600_000) * 1_000_000n);
const spend = (status: SpendView["status"], heldUntilNs = inAnHour): SpendView => ({
  id: 7,
  mandate_id: 2,
  amount: "2000000",
  invoice_hash: "f".repeat(64),
  ref: "inv-7",
  decision_hash: "d".repeat(64),
  agent_pk: AGENT,
  destination: { type: "near", account_id: "acme.near" },
  status,
  created_at_ns: "1",
  held_until_ns: status === "held" ? heldUntilNs : null,
  memo: null,
});

function chain(spends: SpendView[] | "throw" = []) {
  h.reader = fakeReader({
    getConfig: async () => vaultConfig(),
    listSpends: async () => {
      if (spends === "throw") throw transportError();
      return spends;
    },
    ftBalance: async () => "0",
  });
}

/** The page's database, recording each call, and failing the ones named. */
function watchDb(fail: string[] = []): Db {
  return {
    ...db,
    rpc: async <T>(fn: string, p?: Record<string, unknown>) => {
      called.push(fn);
      if (fail.includes(fn)) throw new Error(`${fn} is down`);
      return db.rpc<T>(fn, p);
    },
  } as Db;
}

beforeEach(() => {
  h.jar.clear();
  called.length = 0;
  h.db = watchDb();
  chain();
});

async function signInAs(account: string) {
  h.jar.set(
    SESSION_COOKIE,
    await createSessionToken(await deriveSubkey(MASTER, "session"), account, "mainnet"),
  );
}
const html = async (vault = VAULT) =>
  renderToStaticMarkup((await VaultPage({ params: Promise.resolve({ vault }) })) as ReactElement);
/** Where the held card's anchor sits, and where its title is. */
const anchor = (page: string) => page.indexOf('<div id="held"');

describe("the held card on the vault overview", () => {
  it("comes first, right under the tabs, when a spend waits for approval: above the first-payment card and the vault", async () => {
    await signInAs("acme.near");
    chain([spend("held")]);
    const page = await html();
    const title = page.indexOf(`${HELD} (1)`);
    expect(title).toBeGreaterThan(page.indexOf(">Alerts</a>"));
    expect(title).toBeLessThan(page.indexOf("Your first agent payment"));
    expect(title).toBeLessThan(page.indexOf(">Vault</h2>"));
    expect(anchor(page)).toBeGreaterThan(-1);
    expect(anchor(page)).toBeLessThan(title);
    expect(page.match(/id="held"/g)).toHaveLength(1);
  });

  it("stays in its place, after the balances, when nothing waits; the #held link still lands on it", async () => {
    await signInAs("acme.near");
    const page = await html();
    const title = page.indexOf(`${HELD} (0)`);
    expect(title).toBeGreaterThan(page.indexOf(">Balances</h2>"));
    expect(anchor(page)).toBeGreaterThan(page.indexOf(">Balances</h2>"));
    expect(anchor(page)).toBeLessThan(title);
  });

  it("stays in its place when every hold has run out: the vault refuses approve, so nothing waits", async () => {
    await signInAs("acme.near");
    chain([spend("held", anHourAgo)]);
    const page = await html();
    expect(page.indexOf(`${HELD} (1)`)).toBeGreaterThan(page.indexOf(">Balances</h2>"));
    expect(page).toContain("The hold has run out");
    expect(page).not.toContain(OFFER);
    expect(called).not.toContain("alert_subscriptions_list");
  });

  it("comes first while one hold is still open, beside one that ran out", async () => {
    await signInAs("acme.near");
    chain([{ ...spend("held", anHourAgo), id: 6 }, spend("held")]);
    const page = await html();
    expect(page.indexOf(`${HELD} (2)`)).toBeLessThan(page.indexOf(">Vault</h2>"));
  });

  it("stays in its place, with its warning, when the spends cannot be read", async () => {
    await signInAs("acme.near");
    chain("throw");
    const page = await html();
    expect(page.indexOf(HELD)).toBeGreaterThan(page.indexOf(">Balances</h2>"));
    expect(page).toContain("Payments may be waiting for approval");
    expect(page).toContain('id="held"');
  });
});

describe("the held card's offer of an alert", () => {
  const offerLink = (page: string) =>
    page.match(new RegExp(`<a\\b[^>]*>${OFFER} <span aria-hidden="true">→</span></a>`))?.[0] ??
    null;

  it("links the owner to the Alerts tab when no confirmed alert covers a held spend", async () => {
    await signInAs("acme.near");
    chain([spend("held")]);
    const link = offerLink(await html());
    expect(link).toContain(`href="/console/${VAULT}/alerts"`);
  });

  it("is offered to an approver too", async () => {
    await signInAs("cfo.near");
    chain([spend("held")]);
    expect(offerLink(await html())).not.toBeNull();
  });

  it("is not offered to a viewer, who cannot set an alert", async () => {
    await signInAs("view.near");
    chain([spend("held")]);
    const page = await html();
    expect(page).toContain(`${HELD} (1)`);
    expect(page).not.toContain(OFFER);
  });

  it("is not offered when a confirmed alert already sends held spends", async () => {
    await signInAs("acme.near");
    chain([spend("held")]);
    const page = await html(ALERTED);
    expect(page).toContain(`${HELD} (1)`);
    expect(page).not.toContain(OFFER);
  });

  it("is offered when the confirmed alerts send other kinds only", async () => {
    await signInAs("acme.near");
    chain([spend("held")]);
    expect(offerLink(await html(PAID_ONLY))).not.toBeNull();
  });

  it("is offered when the only alert was never confirmed: it sends nothing", async () => {
    await signInAs("acme.near");
    chain([spend("held")]);
    expect(offerLink(await html(UNCONFIRMED))).not.toBeNull();
  });

  it("is offered when the alerts cannot be read: better one link too many than a missed approval", async () => {
    await signInAs("acme.near");
    h.db = watchDb(["alert_subscriptions_list"]);
    chain([spend("held")]);
    const page = await html(ALERTED);
    expect(offerLink(page)).not.toBeNull();
    expect(page).toContain(`${HELD} (1)`);
  });

  it("is not offered, and the alerts are not read, when nothing waits", async () => {
    await signInAs("acme.near");
    const page = await html();
    expect(page).not.toContain(OFFER);
    expect(called).not.toContain("alert_subscriptions_list");
  });
});
