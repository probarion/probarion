import type { PGlite } from "@electric-sql/pglite";
import { KNOWN_VAULT_CODE_HASHES, type SpendView, type VersionView } from "@probarion/core";
import { RpcMalformedError, type ViewAccountResult } from "@probarion/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memberRole } from "@/lib/db/tenants";
import { WrongChainError } from "@/lib/near/chain";
import type { VaultReader } from "@/lib/near/reader";
import { freshDb } from "../../../test/db/harness";
import { pgliteDb } from "../../../test/db/pglite-db";
import { fakeReader, vaultConfig, viewAccount } from "../../../test/fixtures/reader";
import { contractError, nodeError, transportError } from "../../../test/fixtures/rpc";
import {
  type ChainReads,
  codeIdentity,
  loadFactoryForCreate,
  loadOverview,
  prepareCreateVault,
  registerVault,
} from "./vaults";

const NEAR = 10n ** 24n;
const FACTORY = "vaults.probarion.near";
const ctx = {
  factory: FACTORY,
  minDeposit: (3n * NEAR).toString(),
  mode: "global" as const,
  owner: "acme.near",
};
const good = {
  name: "acme",
  approvers: "cfo.near, coo.near",
  dailyBackstopUsdc: "500",
  heldTtlHours: "72",
  depositNear: "3",
};

describe("prepareCreateVault", () => {
  it("builds the factory tx with converted units", () => {
    const r = prepareCreateVault(good, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.vaultId).toBe("acme.vaults.probarion.near");
    expect(r.tx.receiverId).toBe(FACTORY);
    expect(r.tx.actions[0]?.params.methodName).toBe("create_vault");
    expect(r.tx.actions[0]?.params.args).toEqual({
      name: "acme",
      approvers: ["cfo.near", "coo.near"],
      daily_backstop: "500000000",
      held_ttl_ns: "259200000000000",
    });
    expect(r.tx.actions[0]?.params.deposit).toBe("3000000000000000000000000");
    expect(r.tx.actions[0]?.params.gas).toBe("300000000000000");
    expect(r.warnings).toEqual([]);
  });

  it("reports each bad field", () => {
    const r = prepareCreateVault(
      {
        name: "Acme!",
        approvers: "CFO.near",
        dailyBackstopUsdc: "0",
        heldTtlHours: "0",
        depositNear: "1",
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual([
      "approvers",
      "dailyBackstopUsdc",
      "depositNear",
      "heldTtlHours",
      "name",
    ]);
  });

  it("refuses a name whose account id would be invalid, and more than 10 approvers", () => {
    const r = prepareCreateVault(
      {
        ...good,
        name: "acme-",
        approvers: Array.from({ length: 11 }, (_, i) => `a${i}.near`).join(","),
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(["approvers", "name"]);
  });

  it("an amount above u128 is a field error, never a thrown RangeError", () => {
    const huge = `1${"0".repeat(40)}`;
    const r = prepareCreateVault({ ...good, dailyBackstopUsdc: huge, depositNear: huge }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(["dailyBackstopUsdc", "depositNear"]);
  });

  it("takes whole hours from 1 to 720 only", () => {
    for (const h of ["1e1", "1.5", "721", " "]) {
      const r = prepareCreateVault({ ...good, heldTtlHours: h }, ctx);
      expect(r.ok, h).toBe(false);
    }
    expect(prepareCreateVault({ ...good, heldTtlHours: "720" }, ctx).ok).toBe(true);
  });

  it("warns, without blocking, when the owner is the only approver", () => {
    const r = prepareCreateVault({ ...good, approvers: "acme.near" }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toHaveLength(1);
  });

  describe("R14: the deposit must cover the factory's mode", () => {
    const half = { ...ctx, minDeposit: (NEAR / 2n).toString() };

    it("embedded mode without a sufficient deposit blocks Create", () => {
      // min_deposit alone is enough in global mode, but not for an embedded vault (+2.73352 NEAR of
      // code: the 248,501-byte wasm plus a 10% margin)
      expect(prepareCreateVault({ ...good, depositNear: "0.5" }, half).ok).toBe(true);
      const r = prepareCreateVault(
        { ...good, depositNear: "3.2335" },
        { ...half, mode: "embedded" },
      );
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(Object.keys(r.errors)).toEqual(["depositNear"]);
      expect(r.errors.depositNear).toMatch(/embedded/);
      expect(r.errors.depositNear).toMatch(/3\.23352/);
    });

    it("embedded mode with min_deposit plus the code storage passes", () => {
      const r = prepareCreateVault(
        { ...good, depositNear: "3.23352" },
        { ...half, mode: "embedded" },
      );
      expect(r.ok).toBe(true);
    });

    it("shows a required minimum rounded up, so typing it back always passes", () => {
      const odd = { ...half, minDeposit: (NEAR / 2n + 1n).toString() }; // 0.5 NEAR and 1 yocto
      const r = prepareCreateVault({ ...good, depositNear: "0.5" }, odd);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.errors.depositNear).toMatch(/0\.500001 NEAR/);
      expect(prepareCreateVault({ ...good, depositNear: "0.500001" }, odd).ok).toBe(true);
    });

    it("refuses a deposit the factory could not refund from its float (above 5 NEAR)", () => {
      const r = prepareCreateVault({ ...good, depositNear: "5.000001" }, half);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.errors.depositNear).toMatch(/5 NEAR/);
      expect(prepareCreateVault({ ...good, depositNear: "5" }, half).ok).toBe(true);
    });
  });
});

describe("loadFactoryForCreate", () => {
  const versions = (mode: string): VersionView[] => [
    {
      index: 1,
      code_hash: KNOWN_VAULT_CODE_HASHES[0] ?? "",
      mode: "embedded",
      notes: "",
      at_ns: "1",
    },
    { index: 2, code_hash: KNOWN_VAULT_CODE_HASHES[1] ?? "", mode, notes: "", at_ns: "2" },
  ];
  const config = (current: number | null) => ({
    owner: "probarion.near",
    usdc: "usdc.near",
    intents: "intents.near",
    allowed_assets: [],
    min_deposit: "500000000000000000000000",
    current_version: current,
  });

  it("reads min_deposit and the current version's mode", async () => {
    const r = await loadFactoryForCreate({
      getConfig: async () => config(2),
      versions: async () => versions("global"),
    });
    expect(r).toEqual({
      ok: true,
      minDeposit: "500000000000000000000000",
      mode: "global",
      version: 2,
    });
  });

  it("fails closed on no version, a missing current version, an unknown mode or an outage", async () => {
    const at = (c: number | null, mode = "global") =>
      loadFactoryForCreate({
        getConfig: async () => config(c),
        versions: async () => versions(mode),
      });
    expect(await at(null)).toEqual({ ok: false, reason: "no_version" });
    expect(await at(3)).toEqual({ ok: false, reason: "bad_answer" });
    expect(await at(2, "wasm")).toEqual({ ok: false, reason: "bad_answer" });
    expect(
      await loadFactoryForCreate({
        getConfig: async () => ({ ...config(2), min_deposit: "1e24" }),
        versions: async () => versions("global"),
      }),
    ).toEqual({ ok: false, reason: "bad_answer" });
    expect(
      await loadFactoryForCreate({
        getConfig: async () => {
          throw transportError();
        },
        versions: async () => versions("global"),
      }),
    ).toEqual({ ok: false, reason: "unreachable" });
    expect(
      await loadFactoryForCreate({
        getConfig: async () => {
          throw contractError("UNKNOWN_ACCOUNT");
        },
        versions: async () => versions("global"),
      }),
    ).toEqual({ ok: false, reason: "not_deployed" });
  });
});

describe("codeIdentity", () => {
  it("is the global contract hash when the account uses one, else its own code hash", () => {
    expect(codeIdentity(viewAccount({ code_hash: "own", global_contract_hash: null }))).toBe("own");
    expect(codeIdentity(viewAccount({ code_hash: "zero", global_contract_hash: "global" }))).toBe(
      "global",
    );
  });
});

describe("registerVault (R11)", () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
  });
  afterAll(async () => {
    await pg.close();
  });

  const KNOWN = KNOWN_VAULT_CODE_HASHES[0] ?? "";
  const FACTORY_VERSION = "FactoryVersionHash1111111111111111111111111";
  const chain = (account: Partial<ViewAccountResult>, versionHashes = [FACTORY_VERSION]) => {
    const calls = { versions: 0 };
    const reads: ChainReads = {
      viewAccount: async () => viewAccount(account),
      factoryVersions: async (factory) => {
        calls.versions += 1;
        expect(factory).toBe(FACTORY);
        return versionHashes.map((h, i) => ({
          index: i + 1,
          code_hash: h,
          mode: "global",
          notes: "",
          at_ns: "1",
        }));
      },
    };
    return { reads, calls };
  };
  const deps = (
    reader: VaultReader,
    reads: ChainReads = chain({ global_contract_hash: FACTORY_VERSION }).reads,
    over: { teamVaultIds?: string[]; canaryVaultId?: string | null } = {},
  ) => ({
    db: pgliteDb(pg),
    connect: async () => ({ reader, chain: reads }),
    network: "mainnet" as const,
    factoryId: FACTORY,
    canaryVaultId: over.canaryVaultId ?? "canary.vaults.probarion.near",
    teamVaultIds: over.teamVaultIds ?? [],
  });
  const kindOf = async (vault: string) =>
    (
      await pg.query<{ kind: string }>("select kind from public.tenants where vault_id = $1", [
        vault,
      ])
    ).rows[0]?.kind;

  it("registers a factory vault when the signed-in account is the on-chain owner, with approvers as members", async () => {
    const reader = fakeReader({ getConfig: async () => vaultConfig() });
    const r = await registerVault(deps(reader), {
      vaultId: "acme.vaults.probarion.near",
      account: "acme.near",
    });
    expect(r.ok).toBe(true);
    expect((await memberRole(pgliteDb(pg), "acme.vaults.probarion.near", "cfo.near"))?.role).toBe(
      "approver",
    );
    expect(await kindOf("acme.vaults.probarion.near")).toBe("external");
  });

  it("registers a vault running a known reproducible build, whatever deployed it", async () => {
    const reader = fakeReader({
      getConfig: async () => vaultConfig({ owner: "solo.near", factory: null }),
    });
    const { reads, calls } = chain({ code_hash: KNOWN });
    const r = await registerVault(deps(reader, reads), {
      vaultId: "solo.near",
      account: "solo.near",
    });
    expect(r.ok).toBe(true);
    expect(calls.versions).toBe(0); // a known build needs no factory read
  });

  it("refuses a vault from a foreign factory whose code is not a known build", async () => {
    const reader = fakeReader({
      getConfig: async () => vaultConfig({ factory: "vaults.evil.near" }),
    });
    const { reads } = chain({ code_hash: "SomeOtherBuild1111111111111111111111111111" });
    expect(
      await registerVault(deps(reader, reads), {
        vaultId: "x.vaults.evil.near",
        account: "acme.near",
      }),
    ).toEqual({ ok: false, error: "foreign_factory" });
  });

  it("refuses unknown code that claims to come from our factory", async () => {
    // get_config is whatever the contract says; only the code identity is evidence.
    const reader = fakeReader({ getConfig: async () => vaultConfig() });
    const { reads, calls } = chain({ code_hash: "FakeVault1111111111111111111111111111111111" });
    expect(
      await registerVault(deps(reader, reads), { vaultId: "fake.near", account: "acme.near" }),
    ).toEqual({ ok: false, error: "unknown_code" });
    expect(calls.versions).toBe(1);
  });

  it("trusts nothing when the factory's version list cannot be read, and says so", async () => {
    const reader = fakeReader({ getConfig: async () => vaultConfig() });
    const reads: ChainReads = {
      viewAccount: async () => viewAccount({ global_contract_hash: FACTORY_VERSION }),
      factoryVersions: async () => {
        throw transportError();
      },
    };
    expect(
      await registerVault(deps(reader, reads), {
        vaultId: "acme.vaults.probarion.near",
        account: "acme.near",
      }),
    ).toEqual({ ok: false, error: "unavailable" });
    const buggy: ChainReads = {
      ...reads,
      factoryVersions: async () => {
        throw new TypeError("bug");
      },
    };
    await expect(
      registerVault(deps(reader, buggy), {
        vaultId: "acme.vaults.probarion.near",
        account: "acme.near",
      }),
    ).rejects.toThrow(TypeError);
  });

  it("refuses unknown code with no factory at all", async () => {
    const reader = fakeReader({ getConfig: async () => vaultConfig({ factory: null }) });
    const { reads } = chain({ code_hash: "FakeVault1111111111111111111111111111111111" });
    expect(
      await registerVault(deps(reader, reads), { vaultId: "fake2.near", account: "acme.near" }),
    ).toEqual({ ok: false, error: "unknown_code" });
  });

  it("refuses an account that is not the on-chain owner", async () => {
    const reader = fakeReader({ getConfig: async () => vaultConfig({ owner: "someone.near" }) });
    expect(
      await registerVault(deps(reader), {
        vaultId: "x.vaults.probarion.near",
        account: "acme.near",
      }),
    ).toEqual({ ok: false, error: "not_owner" });
    expect(await kindOf("x.vaults.probarion.near")).toBeUndefined();
  });

  it("reports a vault that does not exist, and an outage as unavailable (never as not found)", async () => {
    const missing = fakeReader({
      getConfig: async () => {
        throw contractError("UNKNOWN_ACCOUNT");
      },
    });
    expect(
      await registerVault(deps(missing), {
        vaultId: "nope.vaults.probarion.near",
        account: "acme.near",
      }),
    ).toEqual({ ok: false, error: "not_found" });
    for (const e of [transportError(), nodeError()]) {
      const down = fakeReader({
        getConfig: async () => {
          throw e;
        },
      });
      expect(
        await registerVault(deps(down), {
          vaultId: "nope.vaults.probarion.near",
          account: "acme.near",
        }),
      ).toEqual({ ok: false, error: "unavailable" });
    }
    const accountDown: ChainReads = {
      viewAccount: async () => {
        throw transportError();
      },
      factoryVersions: async () => [],
    };
    expect(
      await registerVault(deps(fakeReader({ getConfig: async () => vaultConfig() }), accountDown), {
        vaultId: "acme.vaults.probarion.near",
        account: "acme.near",
      }),
    ).toEqual({ ok: false, error: "unavailable" });
  });

  it("refuses an id that is not a NEAR account without reading the chain", async () => {
    const reader = fakeReader();
    expect(
      await registerVault(deps(reader), { vaultId: "Not An Id", account: "acme.near" }),
    ).toEqual({
      ok: false,
      error: "invalid_vault",
    });
  });

  it("marks the configured Canary vault as kind canary with a private proof", async () => {
    const reader = fakeReader({
      getConfig: async () => vaultConfig({ owner: "probarion.near", approvers: [] }),
    });
    await registerVault(deps(reader), {
      vaultId: "canary.vaults.probarion.near",
      account: "probarion.near",
    });
    const m = await memberRole(pgliteDb(pg), "canary.vaults.probarion.near", "probarion.near");
    expect(m).toMatchObject({ kind: "canary", proof_public: false });
  });

  it("a vault in TEAM_VAULT_IDS registers as team, and re-registration turns external into team", async () => {
    const reader = fakeReader({ getConfig: async () => vaultConfig({ owner: "team.near" }) });
    const vaultId = "team.vaults.probarion.near";
    await registerVault(deps(reader), { vaultId, account: "team.near" });
    expect(await kindOf(vaultId)).toBe("external");
    await registerVault(deps(reader, undefined, { teamVaultIds: [vaultId] }), {
      vaultId,
      account: "team.near",
      displayName: "Team vault",
    });
    expect(await kindOf(vaultId)).toBe("team");
    expect((await memberRole(pgliteDb(pg), vaultId, "team.near"))?.display_name).toBe("Team vault");
    // A later registration from the form (no display name) keeps it, and never downgrades the kind.
    await registerVault(deps(reader), { vaultId, account: "team.near" });
    expect(await kindOf(vaultId)).toBe("team");
    expect((await memberRole(pgliteDb(pg), vaultId, "team.near"))?.display_name).toBe("Team vault");
  });

  it("a first registration with no display name takes the vault name", async () => {
    const reader = fakeReader({ getConfig: async () => vaultConfig({ owner: "named.near" }) });
    await registerVault(deps(reader), {
      vaultId: "named.vaults.probarion.near",
      account: "named.near",
    });
    expect(
      (await memberRole(pgliteDb(pg), "named.vaults.probarion.near", "named.near"))?.display_name,
    ).toBe("named");
  });

  it("maps the database's owner_mismatch (a row under an older owner) to owner_mismatch", async () => {
    await pg.query(
      "insert into public.tenants (vault_id, network, kind, owner_account) values ($1, 'mainnet', 'external', 'old.near')",
      ["moved.vaults.probarion.near"],
    );
    const reader = fakeReader({ getConfig: async () => vaultConfig({ owner: "new.near" }) });
    expect(
      await registerVault(deps(reader), {
        vaultId: "moved.vaults.probarion.near",
        account: "new.near",
      }),
    ).toEqual({ ok: false, error: "owner_mismatch" });
  });
});

describe("registerVault: the network's RPC must serve its chain (W-NET-R4)", () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
  });
  afterAll(async () => {
    await pg.close();
  });

  const reads: string[] = [];
  const reader = fakeReader({
    getConfig: async () => {
      reads.push("getConfig");
      return vaultConfig({ owner: "chain.near" });
    },
  });
  const chain: ChainReads = {
    viewAccount: async () => {
      reads.push("viewAccount");
      return viewAccount({ code_hash: KNOWN_VAULT_CODE_HASHES[0] ?? "" });
    },
    factoryVersions: async () => [],
  };
  /** `beforeReads` is the chain check that `connect` runs: it throws, or the clients come back. */
  const deps = (beforeReads: () => Promise<void>) => ({
    db: pgliteDb(pg),
    connect: async () => {
      await beforeReads();
      return { reader, chain };
    },
    network: "mainnet" as const,
    factoryId: FACTORY,
    canaryVaultId: null,
    teamVaultIds: [],
  });
  const input = { vaultId: "chain.vaults.probarion.near", account: "chain.near" };
  const count = async () =>
    Number(
      (await pg.query<{ n: string }>("select count(*) as n from public.tenants")).rows[0]?.n ?? 0,
    );

  it("connects first, and reads only through what it gave: registers when the chain is the network's", async () => {
    reads.length = 0;
    const order: string[] = [];
    const r = await registerVault(
      deps(async () => {
        order.push(`connect (reads so far: ${reads.length})`);
      }),
      input,
    );
    expect(r.ok).toBe(true);
    expect(order).toEqual(["connect (reads so far: 0)"]);
    expect(reads).toContain("getConfig");
  });

  it("answers wrong_chain, reads nothing and writes nothing, when the RPC serves the other chain", async () => {
    reads.length = 0;
    const before = await count();
    const r = await registerVault(
      deps(async () => {
        throw new WrongChainError("mainnet");
      }),
      { ...input, vaultId: "another.vaults.probarion.near" },
    );
    expect(r).toEqual({ ok: false, error: "wrong_chain" });
    expect(reads).toEqual([]);
    expect(await count()).toBe(before);
  });

  it("answers unavailable for a node that cannot be reached, and writes nothing", async () => {
    reads.length = 0;
    const before = await count();
    for (const failure of [transportError(), new RpcMalformedError("status: no chain_id")]) {
      const r = await registerVault(
        deps(async () => {
          throw failure;
        }),
        { ...input, vaultId: "another.vaults.probarion.near" },
      );
      expect(r).toEqual({ ok: false, error: "unavailable" });
    }
    expect(reads).toEqual([]);
    expect(await count()).toBe(before);
  });

  it("does not hide a bug: an error that is not the RPC's is thrown", async () => {
    await expect(
      registerVault(
        deps(async () => {
          throw new TypeError("a bug");
        }),
        input,
      ),
    ).rejects.toThrow("a bug");
  });
});

describe("registerVault: a tenant's network is fixed (W-NET-R4)", () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
    await pg.query(
      "insert into public.tenants (vault_id, network, kind, owner_account) values ($1, 'testnet', 'external', 'acme.near')",
      ["fixed.vaults.probarion.testnet"],
    );
  });
  afterAll(async () => {
    await pg.close();
  });

  const reader = fakeReader({ getConfig: async () => vaultConfig({ owner: "acme.near" }) });
  const reads: ChainReads = {
    viewAccount: async () => viewAccount({ code_hash: KNOWN_VAULT_CODE_HASHES[0] ?? "" }),
    factoryVersions: async () => [],
  };
  const deps = () => ({
    db: pgliteDb(pg),
    connect: async () => ({ reader, chain: reads }),
    network: "mainnet" as const,
    factoryId: FACTORY,
    canaryVaultId: null,
    teamVaultIds: [],
  });
  const row = async () =>
    (
      await pg.query<{ network: string }>(
        "select network from public.tenants where vault_id = 'fixed.vaults.probarion.testnet'",
      )
    ).rows[0]?.network;

  it("maps the database's refusal of a tenant registered on the other network to network_mismatch, and changes nothing", async () => {
    const r = await registerVault(deps(), {
      vaultId: "fixed.vaults.probarion.testnet",
      account: "acme.near",
    });
    expect(r).toEqual({ ok: false, error: "network_mismatch" });
    expect(await row()).toBe("testnet");
    const members = await pg.query(
      "select account_id, role from public.tenant_members m join public.tenants t on t.id = m.tenant_id where t.vault_id = 'fixed.vaults.probarion.testnet'",
    );
    expect(members.rows).toEqual([]);
  });
});

describe("loadOverview: a balance that could not be read is unavailable, never 0", () => {
  const spend = (id: number, status: SpendView["status"]): SpendView => ({
    id,
    mandate_id: 1,
    amount: "1000000",
    invoice_hash: "aa",
    ref: `r${id}`,
    decision_hash: "bb",
    agent_pk: "ed25519:x",
    destination: { type: "near", account_id: "payee.near" },
    status,
    created_at_ns: "1",
    held_until_ns: status === "held" ? "9" : null,
    memo: null,
  });
  const chainOk: ChainReads = {
    viewAccount: async () =>
      viewAccount({ amount: (3n * NEAR).toString(), storage_usage: 250_733 }),
    factoryVersions: async () => [],
  };
  const consts = { usdc: "usdc.near", intents: "intents.near", base: "base.omft.near" };
  const cfg = vaultConfig({
    usdc: "usdc.near",
    intents: "intents.near",
    allowed_assets: ["base.omft.near"],
  });

  it("reads the balances of the tokens the vault is configured with", async () => {
    const seen: string[] = [];
    const reader = fakeReader({
      getConfig: async () => cfg,
      ftBalance: async (token, account) => {
        seen.push(`ft:${token}:${account}`);
        return "25000000";
      },
      intentsBalance: async (intents, account, token) => {
        seen.push(`mt:${intents}:${account}:${token}`);
        return "0";
      },
      listSpends: async () => [spend(1, "paid"), spend(2, "held"), spend(3, "failed")],
    });
    const o = await loadOverview(reader, chainOk, "v.near", consts);
    expect(o.config).toEqual({ ok: true, value: cfg });
    expect(o.usdc).toEqual({ ok: true, value: "25000000" });
    expect(o.intentsBase).toEqual({ ok: true, value: "0" }); // the contract's own "0" is a zero
    expect(seen.sort()).toEqual(["ft:usdc.near:v.near", "mt:intents.near:v.near:base.omft.near"]);
    expect(o.near).toMatchObject({ ok: true, value: { spends: 92, low: false } });
    if (!o.spends.ok) throw new Error("spends");
    expect(o.spends.value.held.map((s) => s.id)).toEqual([2]);
    expect(o.spends.value.recent.map((s) => s.id)).toEqual([3, 2, 1]);
    expect(o.spends.value.counts).toEqual({ paid: 1, held: 1, failed: 1 });
  });

  it.each([
    ["a contract error (wrong token id)", () => contractError("CONTRACT_EXECUTION_ERROR")],
    ["an outage", () => transportError()],
    ["a node error", () => nodeError()],
    ["a bug", () => new TypeError("boom")],
  ])("%s on ftBalance / intentsBalance / view_account is unavailable", async (_label, err) => {
    const reader = fakeReader({
      getConfig: async () => cfg,
      ftBalance: async () => {
        throw err();
      },
      intentsBalance: async () => {
        throw err();
      },
    });
    const accountDown: ChainReads = {
      viewAccount: async () => {
        throw err();
      },
      factoryVersions: async () => [],
    };
    const o = await loadOverview(reader, accountDown, "v.near", consts);
    expect(o.usdc.ok).toBe(false);
    expect(o.intentsBase.ok).toBe(false);
    expect(o.near.ok).toBe(false);
    expect(JSON.stringify(o)).not.toMatch(/"value":"0"/);
  });

  it("a failed spend list is unavailable, not an empty queue", async () => {
    const reader = fakeReader({
      getConfig: async () => cfg,
      listSpends: async () => {
        throw transportError();
      },
      listMandates: async () => {
        throw transportError();
      },
    });
    const o = await loadOverview(reader, chainOk, "v.near", consts);
    expect(o.spends.ok).toBe(false);
    expect(o.mandates.ok).toBe(false);
    expect(o.usdc.ok).toBe(true);
  });

  it("without a readable config nothing else is read, and every part is unavailable", async () => {
    let reads = 0;
    const reader = fakeReader({
      getConfig: async () => {
        throw transportError();
      },
      ftBalance: async () => {
        reads += 1;
        return "1";
      },
    });
    const o = await loadOverview(reader, chainOk, "v.near", consts);
    expect(o.config).toEqual({ ok: false, kind: "transport" });
    expect([o.usdc.ok, o.intentsBase.ok, o.spends.ok, o.mandates.ok]).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(reads).toBe(0);
  });

  it("does not read a Base balance for a vault that does not allow the network's Base asset", async () => {
    const reader = fakeReader({
      getConfig: async () => ({ ...cfg, allowed_assets: [] }),
      intentsBalance: async () => {
        throw new Error("must not be called");
      },
    });
    const o = await loadOverview(reader, chainOk, "v.near", consts);
    expect(o.intentsBase).toEqual({ ok: false, kind: "not_allowed" });
  });
});

describe("loadOverview: a config of another shape", () => {
  it.each([
    ["no owner", { owner: undefined }],
    ["approvers not a list", { approvers: "cfo.near" }],
    ["a backstop in exponent form", { daily_backstop: "5e8" }],
    ["frozen as a string", { frozen: "false" }],
    ["a numeric ledger key", { ledger_key: 7 }],
  ])("%s is unreadable (rpc), and nothing else is read", async (_label, patch) => {
    let balanceReads = 0;
    const reader = fakeReader({
      getConfig: async () => ({ ...vaultConfig(), ...patch }) as never,
      ftBalance: async () => {
        balanceReads += 1;
        return "1";
      },
    });
    const chain: ChainReads = {
      viewAccount: async () => viewAccount(),
      factoryVersions: async () => [],
    };
    const o = await loadOverview(reader, chain, "v.near", { base: "b.near" });
    expect(o.config).toEqual({ ok: false, kind: "rpc" });
    expect(o.usdc.ok).toBe(false);
    expect(balanceReads).toBe(0);
  });
});
