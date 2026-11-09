import type { MandateView, SpendView } from "@probarion/core";
import { describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/port";
import type { TenantListItem } from "@/lib/db/tenants";
import { quietLogs } from "../../../test/fixtures/quiet-logs";
import { type InboxChain, loadInbox } from "./inbox";

const NOW = new Date("2026-11-08T12:00:00Z");
const ns = (iso: string) => (BigInt(Date.parse(iso)) * 1_000_000n).toString();
const ORIGIN = "https://testnet.probarion.test";

function tenant(over: Partial<TenantListItem>): TenantListItem {
  return {
    tenant_id: "00000000-0000-4000-8000-000000000001",
    vault_id: "acme.vaults.probarion.testnet",
    network: "testnet",
    kind: "external",
    display_name: "acme",
    role: "owner",
    ...over,
  };
}

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
    agent_pk: "ed25519:agent",
    label: "Hosting",
    status: "active",
    created_at_ns: ns("2026-11-01T00:00:00Z"),
    ...over,
  };
}

function spend(over: Partial<SpendView> = {}): SpendView {
  return {
    id: 7,
    mandate_id: 1,
    amount: "60000000",
    invoice_hash: "b".repeat(64),
    ref: "inv-1",
    decision_hash: "c".repeat(64),
    agent_pk: "ed25519:agent",
    destination: { type: "near", account_id: "vendor.testnet" },
    status: "held",
    created_at_ns: ns("2026-11-07T00:00:00Z"),
    held_until_ns: ns("2026-11-09T00:00:00Z"),
    memo: null,
    ...over,
  };
}

function fakeDb(tenants: TenantListItem[], rows: Record<string, unknown[]> = {}): Db {
  return {
    async rpc<T>(fn: string, p: Record<string, unknown> = {}): Promise<T> {
      if (fn === "member_tenants") return tenants as T;
      if (fn === "invoice_list") return (rows[String(p.tenant_id)] ?? []) as T;
      throw new Error(`unexpected rpc ${fn}`);
    },
  };
}

const chainOf = (mandates: MandateView[], spends: SpendView[]): InboxChain => ({
  mandates: async () => mandates,
  spends: async () => spends,
});

const awaiting = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  ref: `inv-${id}`,
  status: "awaiting_owner",
  suggested_amount: "20000000",
  mandate_id: 1,
  created_at: "2026-11-08T10:00:00Z",
  source: "console",
  ...over,
});

describe("the extension's inbox", () => {
  quietLogs();

  it("lists the account's vaults on this network where it owns or approves, never a Canary vault", async () => {
    const tenants = [
      tenant({ vault_id: "a.vaults.probarion.testnet" }),
      tenant({ vault_id: "b.vaults.probarion.testnet", role: "approver", tenant_id: "t-b" }),
      tenant({ vault_id: "c.vaults.probarion.testnet", role: "viewer", tenant_id: "t-c" }),
      tenant({ vault_id: "d.vaults.probarion.near", network: "mainnet", tenant_id: "t-d" }),
      tenant({ vault_id: "e.vaults.probarion.testnet", kind: "canary", tenant_id: "t-e" }),
    ];
    const inbox = await loadInbox(
      { db: fakeDb(tenants), chain: chainOf([], []), origin: ORIGIN, now: NOW },
      { account: "owner.testnet", network: "testnet" },
    );
    expect(inbox.vaults.map((v) => [v.vault, v.role])).toEqual([
      ["a.vaults.probarion.testnet", "owner"],
      ["b.vaults.probarion.testnet", "approver"],
    ]);
  });

  it("shows invoices waiting for the owner only to an owner, with the mandate's payee and a console link", async () => {
    const owner = tenant({});
    const approver = tenant({
      vault_id: "b.vaults.probarion.testnet",
      role: "approver",
      tenant_id: "t-b",
    });
    const db = fakeDb([owner, approver], {
      [owner.tenant_id]: [awaiting("i1"), awaiting("i2", { status: "decided" })],
      "t-b": [awaiting("i3")],
    });
    const inbox = await loadInbox(
      { db, chain: chainOf([mandate()], []), origin: ORIGIN, now: NOW },
      { account: "owner.testnet", network: "testnet" },
    );
    const [a, b] = inbox.vaults;
    expect(a?.awaiting).toEqual([
      {
        id: "i1",
        ref: "inv-i1",
        amount: expect.any(String),
        payee: expect.stringContaining("vendor.testnet"),
        created_at: "2026-11-08T10:00:00Z",
        url: `${ORIGIN}/console/acme.vaults.probarion.testnet/payables/i1`,
        source: "console",
      },
    ]);
    expect(b?.awaiting).toEqual([]);
    expect(inbox.counts.awaiting).toBe(1);
  });

  it("lists the holds an approver can still approve, and the mandates an invoice can still go under", async () => {
    const mandates = [
      mandate({ id: 1 }),
      mandate({ id: 2, status: "revoked" }),
      mandate({ id: 3, status: "exhausted" }),
      mandate({ id: 4, expires_at_ns: ns("2026-11-01T00:00:00Z") }),
      mandate({ id: 5, label: "Ads\u202E" }),
      mandate({ id: 6, uses: 10 }),
      mandate({ id: 7, spent: "600000000", reserved: "400000000" }),
      mandate({ id: 8, max_total: "lots" }),
    ];
    const spends = [
      spend({ id: 7 }),
      spend({ id: 8, status: "paid" }),
      spend({ id: 9, held_until_ns: ns("2026-11-08T11:00:00Z") }),
      spend({ id: 10, held_until_ns: null }),
    ];
    const inbox = await loadInbox(
      { db: fakeDb([tenant({})]), chain: chainOf(mandates, spends), origin: ORIGIN, now: NOW },
      { account: "owner.testnet", network: "testnet" },
    );
    const v = inbox.vaults[0];
    // 6 has no use left, 7 no total left, 8 a total that cannot be read.
    expect(v?.mandates.map((m) => m.id)).toEqual([1, 5]);
    expect(v?.mandates[1]?.label).not.toContain("\u202E");
    // 9's hold ran out an hour ago, and 10 has none: the vault refuses approve for both.
    expect(v?.held).toEqual([
      {
        spend_id: 7,
        amount: expect.any(String),
        payee: expect.stringContaining("vendor.testnet"),
        held_until: "2026-11-09T00:00:00.000Z",
        url: `${ORIGIN}/console/acme.vaults.probarion.testnet`,
      },
    ]);
    expect(inbox.counts).toEqual({ awaiting: 0, held: 1 });
  });

  it("still lists the waiting invoices when the chain cannot be read", async () => {
    const t = tenant({});
    const chain: InboxChain = {
      mandates: async () => {
        throw new Error("rpc down");
      },
      spends: async () => {
        throw new Error("rpc down");
      },
    };
    const inbox = await loadInbox(
      { db: fakeDb([t], { [t.tenant_id]: [awaiting("i1")] }), chain, origin: ORIGIN, now: NOW },
      { account: "owner.testnet", network: "testnet" },
    );
    expect(inbox.vaults[0]).toMatchObject({ chain: "unavailable", held: [], mandates: [] });
    expect(inbox.vaults[0]?.awaiting).toHaveLength(1);
    expect(inbox.vaults[0]?.awaiting[0]?.payee).toBeNull();
  });

  it("says where each waiting invoice came from", async () => {
    const owner = tenant({});
    const db = fakeDb([owner], {
      [owner.tenant_id]: [awaiting("i1"), awaiting("i2", { source: "extension" })],
    });
    const inbox = await loadInbox(
      { db, chain: chainOf([mandate()], []), origin: ORIGIN, now: NOW },
      { account: "owner.testnet", network: "testnet" },
    );
    const shown = inbox.vaults[0]?.awaiting ?? [];
    expect(shown).toHaveLength(2);
    expect(shown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "i1", source: "console" }),
        expect.objectContaining({ id: "i2", source: "extension" }),
      ]),
    );
  });
});
