import { NETWORKS } from "@probarion/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fundVaultUsdcTx } from "@/lib/near/tx";
import { quietLogs } from "../../../../../test/fixtures/quiet-logs";
import { OWNER, VAULT, vaultConfig } from "../../../../../test/fixtures/topup";

const h = vi.hoisted(() => ({
  network: "testnet" as "mainnet" | "testnet",
  role: "owner" as "owner" | "approver" | "viewer" | null,
  roles: [] as unknown[],
  account: "acme.near",
  config: null as unknown,
  configError: null as null | Error,
}));

vi.mock("@/lib/auth/guard", () => ({
  getSession: async () => (h.role === null ? null : { accountId: h.account }),
  memberForApi: async (vault: string, roles: unknown) => {
    h.roles.push(roles);
    if (h.role === null)
      return new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 });
    if (!(roles as string[]).includes(h.role)) {
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    }
    return {
      session: { accountId: h.account },
      member: { vault_id: vault, role: h.role, network: h.network },
    };
  },
}));
vi.mock("@/lib/near/server", async () => {
  const { NETWORKS: networks } = await import("@probarion/core");
  return {
    chainConsts: () => networks[h.network],
    getReader: () => ({
      getConfig: async () => {
        if (h.configError) throw h.configError;
        return h.config;
      },
    }),
  };
});

const { prepareFundAction } = await import("./actions");
const logs = quietLogs();

beforeEach(() => {
  h.network = "testnet";
  h.role = "owner";
  h.roles = [];
  h.account = OWNER;
  h.config = vaultConfig("testnet");
  h.configError = null;
});

describe("prepareFundAction", () => {
  it("builds the transfer of the network's USDC to the vault, for the owner to sign", async () => {
    expect(await prepareFundAction(VAULT, "25")).toEqual(
      fundVaultUsdcTx(NETWORKS.testnet.usdc, VAULT, "25000000"),
    );
    h.network = "mainnet";
    h.config = vaultConfig("mainnet");
    const tx = await prepareFundAction(VAULT, "0.5");
    expect(tx).toEqual(fundVaultUsdcTx(NETWORKS.mainnet.usdc, VAULT, "500000"));
    expect(tx).toMatchObject({ receiverId: NETWORKS.mainnet.usdc });
    expect(h.roles).toEqual([["owner"], ["owner"]]);
  });

  it("is for the owner only, and says 403 or 401 as data (a server action has no status)", async () => {
    for (const role of ["approver", "viewer"] as const) {
      h.role = role;
      expect(await prepareFundAction(VAULT, "25")).toEqual({
        error: "You cannot change this vault.",
        status: 403,
      });
    }
    h.role = null;
    expect(await prepareFundAction(VAULT, "25")).toEqual({
      error: "Your session ended. Sign in again.",
      status: 401,
    });
  });

  it("answers an amount that cannot be sent in words the form can show", async () => {
    expect(await prepareFundAction(VAULT, "0")).toEqual({ error: "Must be above 0" });
    expect(await prepareFundAction(VAULT, "abc")).toEqual({
      error: "Use a plain decimal number such as 12.50",
    });
    expect(await prepareFundAction(VAULT, "1.0000001")).toEqual({
      error: "At most 6 decimal places",
    });
    expect(await prepareFundAction(VAULT, 25 as unknown as string)).toEqual({
      error: "Invalid amount",
    });
  });

  it("builds nothing when the account the chain names as owner is not the signed-in one", async () => {
    h.config = { ...vaultConfig("testnet"), owner: "someone-else.near" };
    const r = await prepareFundAction(VAULT, "25");
    expect(r).toHaveProperty("error");
    expect(r).not.toHaveProperty("receiverId");
  });

  it("builds nothing for a vault that holds another token than the network's USDC", async () => {
    h.config = { ...vaultConfig("testnet"), usdc: "other-token.testnet" };
    const r = await prepareFundAction(VAULT, "25");
    expect(r).toEqual({
      error: `This vault's token is other-token.testnet, not this network's USDC (${NETWORKS.testnet.usdc}), so nothing was prepared.`,
    });
  });

  it("builds nothing when the vault's config cannot be read or is not a config", async () => {
    const unread = {
      error: "The vault could not be read from NEAR, so nothing was prepared. Try again.",
    };
    h.configError = new Error("all RPC endpoints failed");
    expect(await prepareFundAction(VAULT, "25")).toEqual(unread);
    h.configError = null;
    h.config = { owner: OWNER };
    expect(await prepareFundAction(VAULT, "25")).toEqual(unread);
    expect(logs.lines.some((l) => l.includes("topup.config_unreadable"))).toBe(true);
  });
});
