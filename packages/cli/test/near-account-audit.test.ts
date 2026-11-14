// `probarion account audit` over a scripted JSON-RPC fetch (TEST DOUBLES only, R20) that serves the views N3 recorded
// from public chain state (packages/near/test/fixtures/keys): the printed report, the JSON, the exit codes (0 ok,
// 2 warnings, 1 not locked, a blocking finding or a failed read, 64 usage) and the exact views it asks for. Key
// mutations are made in the test from the recorded list and are labelled. Nothing here talks to a network.
//
// Needs the built packages: pnpm --filter @probarion/core build, --filter @probarion/sdk build and
// --filter @probarion/near build.
import { readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkVaultLocked, type Snapshot } from "@probarion/core";
import { toAccessKeyInfo } from "@probarion/sdk";
import { describe, expect, it } from "vitest";
import type { CliIo } from "../src/io.js";
import { runCli } from "../src/program.js";
import { tempDir, testIo } from "./helpers.js";

const RPC = "https://rpc.audit.test/";
const KEYS = fileURLToPath(new URL("../../near/test/fixtures/keys/", import.meta.url));
const CODE_HASHES = fileURLToPath(new URL("../../../contracts/code-hashes.json", import.meta.url));
const EVIDENCE = fileURLToPath(new URL("../../../docs/evidence/", import.meta.url));
/** A recorded factory build (contracts/code-hashes.json): a real code hash that is not a vault build. */
const FACTORY_BUILD = "FK6mMqUdieWmYyB9hqyJL23Aew9wWGSPustb6tUDtaQ6";

type RawKey = { public_key: string; access_key: { nonce: number; permission: unknown } };
interface KeysFixture {
  network: "mainnet" | "testnet";
  account_id: string;
  view_account: Record<string, unknown> & { block_hash: string; code_hash: string };
  view_access_key_list: { block_hash: string; block_height: number; keys: RawKey[] };
}
type Params = Record<string, unknown>;
type Call = { method: string; params: Params };

function fixture(name: string): KeysFixture {
  return JSON.parse(readFileSync(join(KEYS, name), "utf8")) as KeysFixture;
}

/** v0.probarion.near on mainnet at block 224468063: an anchor key and a spend key, both on the vault itself. */
const V0 = fixture("mainnet-v0.json");
/** A testnet factory vault with no access keys at all. */
const FACTORY_VAULT = fixture("testnet-factory-vault.json");
/** A real public key that is in neither recorded key list (the mainnet owner's, from the drill README). */
const OTHER_PK = "ed25519:4jHJSmeUGvpJzXDTUvBkKzGUgXMb3jMXmyKT44htnUxc";

/** The recorded views with the key list replaced (a mutation made in this test, not a recorded state). */
function withKeys(fx: KeysFixture, keys: RawKey[]): KeysFixture {
  return { ...fx, view_access_key_list: { ...fx.view_access_key_list, keys } };
}

const functionCall = (
  receiverId: string,
  methods: string[],
  allowance: string | null,
): unknown => ({
  FunctionCall: { allowance, method_names: methods, receiver_id: receiverId },
});

/**
 * Serves `view_account` of the fixture's account at finality final, and its key list at that answer's block hash.
 * Another account is UNKNOWN_ACCOUNT; anything else is an error answer, so a wrong request shows as a failed read. Every request lands in `calls`.
 */
function chain(fx: KeysFixture, calls: Call[] = []): typeof fetch {
  const answer = (method: string, params: Params): { result: unknown } | { error: unknown } => {
    if (method === "query" && params.account_id !== fx.account_id) {
      const id = String(params.account_id);
      return {
        error: {
          name: "HANDLER_ERROR",
          cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: id } },
          message: "Server error",
        },
      };
    }
    if (method === "query") {
      if (params.request_type === "view_account" && params.finality === "final") {
        return { result: fx.view_account };
      }
      if (
        params.request_type === "view_access_key_list" &&
        params.block_id === fx.view_account.block_hash
      ) {
        return { result: fx.view_access_key_list };
      }
    }
    return { error: { name: "REQUEST_VALIDATION_ERROR", message: "unexpected request" } };
  };
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: string; method: string; params: Params };
    calls.push({ method: body.method, params: body.params });
    const out = answer(body.method, body.params);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...out }), { status: 200 });
  }) as typeof fetch;
}

/** Audits `account` (default: the fixture's own) on a chain that serves the fixture. */
async function run(args: string[], fx: KeysFixture = V0, account = fx.account_id) {
  const { io, state } = testIo(process.cwd());
  const calls: Call[] = [];
  const withFetch: CliIo = { ...io, nearDeps: { fetch: chain(fx, calls) } };
  const code = await runCli(
    ["--network", fx.network, "--rpc", RPC, "account", "audit", account, ...args],
    withFetch,
  );
  return { code, out: state.out, err: state.err, calls };
}

describe("probarion account audit", () => {
  it("passes v0.probarion.near under the vault policy and prints the report (snapshot)", async () => {
    const { code, out, err } = await run(["--vault-policy"]);
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toMatchInlineSnapshot(`
      "Account v0.probarion.near at block 224468063 (CyAZitvXhDBXcsxeog9xxrBMVfDWMuzMofgazV6CX94e): 2 access keys, none with full access.
      Key ed25519:RY7kjsaRStq4gt27RpNgErr9AjuKuZdzCXd6atSrzKK: function call on v0.probarion.near, methods ["anchor"], an allowance of 0.2491886787336027 NEAR for gas.
      Key ed25519:GADeVCXtgcxS3E5JrcVpEWTuZiNMJ4gu17iyuEgyCycd: function call on v0.probarion.near, methods ["spend"], an allowance of 0.2458808163015667 NEAR for gas.
      info: ed25519:RY7kjsaRStq4gt27RpNgErr9AjuKuZdzCXd6atSrzKK calls the account's own contract, so what it can do is what that code lets the account itself do.
      info: ed25519:GADeVCXtgcxS3E5JrcVpEWTuZiNMJ4gu17iyuEgyCycd calls the account's own contract, so what it can do is what that code lets the account itself do.
      Code: the account's own code, hash 3cQXYDvfGLRMveCVAHmh1exiuZKDXWqD8cUhqdEs9MF1. A DeployContract action replaces it; that takes a full-access key or the contract itself.
      Build: the code hash matches a recorded build: probarion-vault.
      Function-call keys cannot attach a deposit, so they cannot call methods that need 1 yoctoNEAR, such as ft_transfer.
      With no full-access key, the keys change through the account's own code, so the code identity matters.
      This audit holds at block 224468063; a later block can differ.
      Verdict: ok, the account is locked.
      Views read on NEAR mainnet at block 224468063 (CyAZitvXhDBXcsxeog9xxrBMVfDWMuzMofgazV6CX94e): view_account and view_access_key_list. Nothing was signed or sent.
      The vault policy does not pin the anchor key to the vault's current ledger key: probarion verify (check f) does.
      "
    `);
  });

  it("reads view_account at finality final, then the key list at that block, and nothing else", async () => {
    const { calls } = await run(["--vault-policy"]);
    expect(calls).toEqual([
      {
        method: "query",
        params: { request_type: "view_account", finality: "final", account_id: V0.account_id },
      },
      {
        method: "query",
        params: {
          request_type: "view_access_key_list",
          block_id: V0.view_account.block_hash,
          account_id: V0.account_id,
        },
      },
    ]);
  });

  it("passes the testnet factory vault, which has no access keys, and its code is a recorded vault build", async () => {
    const { code, out } = await run(["--vault-policy"], FACTORY_VAULT);
    expect(code).toBe(0);
    expect(out).toContain(`Account ${FACTORY_VAULT.account_id} at block 277612267`);
    expect(out).toContain("no access keys");
    expect(out).toContain("Build: the code hash matches a recorded build: probarion-vault.");
  });

  it("exits 1 when a key acts as full access (mutation: a FullAccess key added)", async () => {
    const keys = [
      ...V0.view_access_key_list.keys,
      { public_key: OTHER_PK, access_key: { nonce: 1, permission: "FullAccess" } },
    ];
    const plain = await run([], withKeys(V0, keys));
    expect(plain.code).toBe(1);
    expect(plain.out).toContain("1 with full access");
    expect(plain.out).toContain("Verdict: not ok, since 1 key acts as full access.");
    const json = JSON.parse((await run(["--json"], withKeys(V0, keys))).out) as Record<
      string,
      unknown
    >;
    expect(json.locked).toBe(false);
    expect(json.ok).toBe(false);
  });

  it("exits 1 for a permission it cannot read, counted as full access (mutation: two variants in one)", async () => {
    const both = {
      FunctionCall: { allowance: "1", method_names: ["spend"], receiver_id: V0.account_id },
      FullAccess: {},
    };
    const keys = [{ public_key: OTHER_PK, access_key: { nonce: 1, permission: both } }];
    const { code, out } = await run([], withKeys(V0, keys));
    expect(code).toBe(1);
    expect(out).toContain("a permission this audit cannot read, counted as full access");
  });

  it("warns (exit 2) on a key for any method on the account itself, and the vault policy blocks it (exit 1)", async () => {
    // Mutation: a function-call key with method_names [] (any method) on the vault itself.
    const keys = [
      ...V0.view_access_key_list.keys,
      {
        public_key: OTHER_PK,
        access_key: { nonce: 1, permission: functionCall(V0.account_id, [], "1000") },
      },
    ];
    const plain = await run([], withKeys(V0, keys));
    expect(plain.code).toBe(2);
    expect(plain.out).toMatch(/^warn: /m);
    expect(plain.out).toContain("Verdict: ok, the account is locked, with");
    const policy = await run(["--vault-policy"], withKeys(V0, keys));
    expect(policy.code).toBe(1);
    expect(policy.out).toContain("a key does not fit the policy");
  });

  it("blocks under the vault policy a key the vault itself cannot add (mutations: unlimited allowance, another method, another receiver)", async () => {
    for (const permission of [
      functionCall(V0.account_id, ["spend"], null),
      functionCall(V0.account_id, ["freeze"], "1000"),
      functionCall("intents.near", ["spend"], "1000"),
    ]) {
      const keys = [{ public_key: OTHER_PK, access_key: { nonce: 1, permission } }];
      const { code, out } = await run(["--vault-policy"], withKeys(V0, keys));
      expect(code, JSON.stringify(permission)).toBe(1);
      expect(out, JSON.stringify(permission)).toContain("a key does not fit the policy");
    }
  });

  it("exits 1 when the code is not a recorded build, and 0 against contracts/code-hashes.json", async () => {
    const dir = await tempDir();
    // contracts/code-hashes.json as it is in this repository: v0's code is one of its vault builds.
    const recorded = await run(["--builds", CODE_HASHES]);
    expect(recorded.code).toBe(0);
    expect(recorded.out).toContain(
      "Build: the code hash matches a recorded build: probarion-vault, 0.1.0",
    );
    // A record file without v0's build (the factory entries of contracts/code-hashes.json).
    const all = JSON.parse(readFileSync(CODE_HASHES, "utf8")) as { entries: { crate: string }[] };
    const factoryOnly = join(dir, "factory-builds.json");
    await writeFile(
      factoryOnly,
      JSON.stringify({ entries: all.entries.filter((e) => e.crate === "probarion-factory") }),
    );
    const other = await run(["--builds", factoryOnly]);
    expect(other.code).toBe(1);
    expect(other.out).toContain(`Build: Code hash ${V0.view_account.code_hash} is not among the`);
    expect(other.out).toContain("the code is not a recorded build");
  });

  it("prints the report as JSON, with amounts and nonces as decimal strings", async () => {
    const { code, out } = await run(["--vault-policy", "--json"]);
    expect(code).toBe(0);
    const json = JSON.parse(out) as {
      accountId: string;
      locked: boolean;
      ok: boolean;
      keys: {
        blockHeight: number;
        policyOk: boolean;
        keys: { allowance: unknown; nonce: unknown }[];
      };
      build: { ok: boolean };
      lines: string[];
    };
    expect(Object.keys(json)).toEqual([
      "accountId",
      "keys",
      "code",
      "build",
      "locked",
      "ok",
      "lines",
    ]);
    expect(json.accountId).toBe("v0.probarion.near");
    expect(json.locked).toBe(true);
    expect(json.ok).toBe(true);
    expect(json.keys.blockHeight).toBe(224468063);
    expect(json.keys.policyOk).toBe(true);
    expect(json.build.ok).toBe(true);
    const spend = V0.view_access_key_list.keys[1];
    const permission = spend?.access_key.permission as { FunctionCall: { allowance: string } };
    expect(json.keys.keys[1]?.allowance).toBe(permission.FunctionCall.allowance);
    expect(json.keys.keys[1]?.nonce).toBe(String(spend?.access_key.nonce));
  });

  it("exits 1 with an error, and no report, when the chain cannot be read or the account is missing", async () => {
    const { io, state } = testIo(process.cwd());
    const down = (async () => new Response("down", { status: 503 })) as typeof fetch;
    const code = await runCli(
      ["--network", "mainnet", "--rpc", RPC, "account", "audit", V0.account_id],
      {
        ...io,
        nearDeps: { fetch: down },
      },
    );
    expect(code).toBe(1);
    expect(state.out).toBe("");
    expect(state.err).toMatch(/^error: account audit could not read v0\.probarion\.near: /);

    const missing = await run([], V0, "nobody-here.near");
    expect(missing.code).toBe(1);
    expect(missing.out).toBe("");
    expect(missing.err).toMatch(/^error: account audit could not read nobody-here\.near: /);
  });

  it("exits 1 on a legacy HTTP 200 result.error answer instead of reading it as a view", async () => {
    const { io, state } = testIo(process.cwd());
    const legacy = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: string };
      const result = {
        error: "account v0.probarion.near does not exist while viewing",
        logs: [],
        block_height: 224468063,
        block_hash: V0.view_account.block_hash,
      };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    }) as typeof fetch;
    const code = await runCli(
      ["--network", "mainnet", "--rpc", RPC, "account", "audit", V0.account_id],
      {
        ...io,
        nearDeps: { fetch: legacy },
      },
    );
    expect(code).toBe(1);
    expect(state.out).toBe("");
    expect(state.err).toBe(
      "error: account audit could not read v0.probarion.near: query: account v0.probarion.near does not exist while viewing\n",
    );
  });

  it("exits 64 on a malformed account, flag or --builds file, before any read", async () => {
    const dir = await tempDir();
    const notJson = join(dir, "not-json.json");
    await writeFile(notJson, "{ entries: [");
    const noHash = join(dir, "no-hash.json");
    await writeFile(noHash, JSON.stringify({ entries: [{ crate: "probarion-vault" }] }));
    const notAList = join(dir, "not-a-list.json");
    await writeFile(notAList, JSON.stringify({ builds: [] }));
    for (const args of [
      ["Not An Account"],
      ["v0.probarion.near", "--builds", join(dir, "missing.json")],
      ["v0.probarion.near", "--builds", notJson],
      ["v0.probarion.near", "--builds", noHash],
      ["v0.probarion.near", "--builds", notAList],
      ["v0.probarion.near", "--policy"],
      ["v0.probarion.near", "--network", "betanet"],
    ]) {
      const { io, state } = testIo(process.cwd());
      let reads = 0;
      const counting = (async () => {
        reads += 1;
        return new Response("{}");
      }) as typeof fetch;
      const code = await runCli(["--rpc", RPC, "account", "audit", ...args], {
        ...io,
        nearDeps: { fetch: counting },
      });
      expect(code, args.join(" ")).toBe(64);
      expect(reads, args.join(" ")).toBe(0);
      expect(state.err, args.join(" ")).toMatch(/^error: /);
    }
  });

  it("lists its exit codes in --help", async () => {
    const { io, state } = testIo(process.cwd());
    expect(await runCli(["account", "audit", "--help"], io)).toBe(0);
    expect(state.out).toContain("Usage: probarion account audit [options] <account>");
    expect(state.out).toContain(
      "  64  usage error: a malformed account or flag, or a --builds file that cannot be read",
    );
  });
});

// --- --vault-policy against check f -----------------------------------------------------------------------------
// The verifier snapshots in docs/evidence, each served as views: its keys rebuilt in the RPC shape and its code hash.
// The block (V0's) is a stand-in, since a snapshot records keys and code, not the block they were read at. Each case
// runs `account audit <vault> --vault-policy` and core's check f (`checkVaultLocked`, on the keys as the SDK folds
// them) on the same keys, so this pins the CLI's vaultKeyPolicy, the recorded vault builds it holds the code to and
// the exit code. Mutations are made in the test from the recorded keys and are labelled.

const snapshots = (function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const path = join(dir, item.name);
    if (item.isDirectory()) return walk(path);
    return /^snapshot-.*\.json$/.test(item.name) ? [path] : [];
  });
})(EVIDENCE)
  .sort()
  .map((path) => ({
    name: path.slice(EVIDENCE.length).replaceAll("\\", "/"),
    snapshot: JSON.parse(readFileSync(path, "utf8")) as Snapshot,
  }));

/** The SDK-folded key back in the RPC shape (FullAccess, or the FunctionCall wrapper around its fields). */
function rawKey(key: Snapshot["chain"]["access_keys"][number]): RawKey {
  const permission =
    key.permission === "FullAccess"
      ? "FullAccess"
      : functionCall(
          key.permission.receiver_id,
          [...key.permission.method_names],
          key.permission.allowance,
        );
  return { public_key: key.public_key, access_key: { nonce: 0, permission } };
}

const keyWith = (raw: RawKey[], method: string): RawKey | undefined =>
  raw.find((k) => {
    const p = k.access_key.permission as { FunctionCall?: { method_names: string[] } };
    return p.FunctionCall?.method_names.length === 1 && p.FunctionCall.method_names[0] === method;
  });

/** Check f's verdict and the CLI's exit code under --vault-policy, on one raw key list and code hash. */
async function policyVerdicts(s: Snapshot, raw: RawKey[], codeHash = s.chain.code_hash) {
  const folded: Snapshot = {
    ...s,
    chain: { ...s.chain, access_keys: raw.map((key) => toAccessKeyInfo(key)), code_hash: codeHash },
  };
  const views: KeysFixture = {
    network: s.network,
    account_id: s.vault,
    view_account: { ...V0.view_account, code_hash: codeHash },
    view_access_key_list: { ...V0.view_access_key_list, keys: raw },
  };
  const { code, out, err } = await run(["--vault-policy"], views);
  return { checkF: checkVaultLocked(folded).status === "pass", cli: code, out, err };
}

/**
 * Each case: what it does to the recorded keys, check f's verdict and the CLI's exit code. They agree (pass and 0,
 * fail and 1) but for the three cases marked as a difference, each one written in vaultKeyPolicy's comment.
 */
const POLICY_CASES: {
  label: string;
  mutate: (raw: RawKey[], s: Snapshot) => void;
  codeHash?: string;
  checkF: boolean;
  cli: 0 | 1;
}[] = [
  { label: "as recorded", mutate: () => {}, checkF: true, cli: 0 },
  {
    label: "a FullAccess key added",
    mutate: (raw) =>
      raw.push({ public_key: OTHER_PK, access_key: { nonce: 0, permission: "FullAccess" } }),
    checkF: false,
    cli: 1,
  },
  {
    label: "the spend key can also anchor",
    mutate: (raw, s) => {
      const key = keyWith(raw, "spend");
      if (key) key.access_key.permission = functionCall(s.vault, ["spend", "anchor"], "1000");
    },
    checkF: false,
    cli: 1,
  },
  {
    label: "the spend key can call any method ([])",
    mutate: (raw, s) => {
      const key = keyWith(raw, "spend");
      if (key) key.access_key.permission = functionCall(s.vault, [], "1000");
    },
    checkF: false,
    cli: 1,
  },
  {
    label: "the spend key on another receiver",
    mutate: (raw) => {
      const key = keyWith(raw, "spend");
      if (key) key.access_key.permission = functionCall("usdc.probarion.near", ["spend"], "1000");
    },
    checkF: false,
    cli: 1,
  },
  {
    label: "a GasKeyFullAccess key added (shape from near-api-js 7.4.0 types)",
    mutate: (raw) =>
      raw.push({
        public_key: OTHER_PK,
        access_key: {
          nonce: 0,
          permission: { GasKeyFullAccess: { balance: "1", num_nonces: 1 } },
        },
      }),
    checkF: false,
    cli: 1,
  },
  {
    label: "a second agent key added",
    mutate: (raw, s) =>
      raw.push({
        public_key: OTHER_PK,
        access_key: { nonce: 0, permission: functionCall(s.vault, ["spend"], "1000") },
      }),
    checkF: true,
    cli: 0,
  },
  { label: "every key removed", mutate: (raw) => raw.splice(0), checkF: true, cli: 0 },
  {
    label: "code that is a recorded factory build, not a vault build",
    mutate: () => {},
    codeHash: FACTORY_BUILD,
    checkF: false,
    cli: 1,
  },
  {
    // Difference: the CLI does not pin the anchor key to config.ledger_key (check f does, and the CLI says so).
    label: "an anchor key that is not the ledger key",
    mutate: (raw, s) => {
      const anchor = keyWith(raw, "anchor");
      if (anchor !== undefined) anchor.public_key = OTHER_PK;
      else
        raw.push({
          public_key: OTHER_PK,
          access_key: { nonce: 0, permission: functionCall(s.vault, ["anchor"], "1000") },
        });
    },
    checkF: false,
    cli: 0,
  },
  {
    // Difference: the vault refuses a zero (unlimited) allowance (contracts/vault/src/keys.rs), so the CLI does too.
    label: "the spend key with no allowance limit",
    mutate: (raw, s) => {
      const key = keyWith(raw, "spend");
      if (key) key.access_key.permission = functionCall(s.vault, ["spend"], null);
    },
    checkF: true,
    cli: 1,
  },
  {
    // Difference: the SDK folds a scoped NEP-611 gas key into a function-call key; the CLI refuses gas keys. The
    // allowance is null, as NEP-611 requires of a gas key.
    label: "the spend key as a scoped gas key (shape from near-api-js 7.4.0 types)",
    mutate: (raw, s) => {
      const key = keyWith(raw, "spend");
      if (key)
        key.access_key.permission = {
          GasKeyFunctionCall: {
            allowance: null,
            balance: "1000000000000000000000000",
            method_names: ["spend"],
            num_nonces: 2,
            receiver_id: s.vault,
          },
        };
    },
    checkF: true,
    cli: 1,
  },
];

describe("probarion account audit --vault-policy against check f on the recorded snapshots", () => {
  it("finds the recorded vault snapshots, each with a spend key, as the cases below need", () => {
    expect(snapshots.length).toBeGreaterThanOrEqual(13);
    for (const { name, snapshot } of snapshots) {
      expect(keyWith(snapshot.chain.access_keys.map(rawKey), "spend"), name).toBeDefined();
    }
  });

  for (const { label, mutate, codeHash, checkF, cli } of POLICY_CASES) {
    it(`gives check f ${checkF ? "pass" : "fail"} and exit ${cli} on every snapshot: ${label}`, async () => {
      for (const { name, snapshot } of snapshots) {
        const raw = snapshot.chain.access_keys.map(rawKey);
        mutate(raw, snapshot);
        const got = await policyVerdicts(snapshot, raw, codeHash);
        expect({ checkF: got.checkF, cli: got.cli }, `${name}: ${label}`).toEqual({ checkF, cli });
        expect(got.err, `${name}: ${label}`).toBe("");
        expect(got.out, `${name}: ${label}`).toContain(
          "The vault policy does not pin the anchor key to the vault's current ledger key",
        );
      }
    });
  }
});
