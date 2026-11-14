import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { auditVault } from "../examples/audit-account.js";
import { readAccountLock } from "../src/account-rpc.js";
import { accountLockReport, type RecordedBuild } from "../src/code-identity.js";
import { NearFormatError } from "../src/errors.js";
import { NearRpcError } from "../src/rpc.js";
import { fakeRpc } from "./helpers/fake-rpc.js";
import { readFixture } from "./helpers/fixtures.js";

type Json = Record<string, unknown>;

interface KeysFixture {
  account_id: string;
  view_account: Json;
  view_access_key_list: Json;
}

const fixture = readFixture<KeysFixture>("keys/mainnet-v0.json");
const V0 = fixture.account_id;
const BLOCK = String(fixture.view_account.block_hash);
const codeHashes = JSON.parse(
  readFileSync(new URL("../../../contracts/code-hashes.json", import.meta.url), "utf8"),
) as { entries: RecordedBuild[] };

/** Serves the recorded views: view_account at final, the key list at the block it was recorded at. */
function recordedRpc(overrides: { account?: unknown; list?: unknown } = {}) {
  return fakeRpc((method, params) => {
    const p = params as Json;
    if (method !== "query") throw new Error(`unexpected method ${method}`);
    if (p.request_type === "view_account") return overrides.account ?? fixture.view_account;
    if (p.request_type === "view_access_key_list")
      return overrides.list ?? fixture.view_access_key_list;
    throw new Error(`unexpected request ${String(p.request_type)}`);
  });
}

describe("readAccountLock", () => {
  it("reads view_account at final, then the key list at that answer's block hash", async () => {
    const rpc = recordedRpc();
    const report = await readAccountLock(rpc, V0, { builds: codeHashes });
    expect(rpc.calls).toEqual([
      {
        method: "query",
        params: { request_type: "view_account", finality: "final", account_id: V0 },
      },
      {
        method: "query",
        params: { request_type: "view_access_key_list", block_id: BLOCK, account_id: V0 },
      },
    ]);
    expect(report).toEqual(
      accountLockReport(V0, fixture.view_account, fixture.view_access_key_list, {
        builds: codeHashes,
      }),
    );
    expect(report.ok).toBe(true);
  });

  it("refuses a key list answered for another block", async () => {
    const list = {
      ...fixture.view_access_key_list,
      block_hash: "6im8sBfcWJg4JMvBStLbr1HXy2gtzjHCEoqV5TBkEeMe",
    };
    const error = await readAccountLock(recordedRpc({ list }), V0).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NearFormatError);
    expect((error as NearFormatError).what).toBe("view_access_key_list.block_hash");
  });

  it("refuses a view_account answer without a block hash, before reading the keys", async () => {
    const { block_hash: _, ...account } = fixture.view_account;
    const rpc = recordedRpc({ account });
    const error = await readAccountLock(rpc, V0).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NearFormatError);
    expect((error as NearFormatError).what).toBe("view_account.block_hash");
    expect(rpc.calls).toHaveLength(1);
  });

  it("refuses a bad account id, policy or builds list before any read", async () => {
    const rpc = recordedRpc();
    await expect(readAccountLock(rpc, "Not An Account")).rejects.toThrow(TypeError);
    await expect(
      readAccountLock(rpc, V0, { policy: { rules: [{ receiverId: V0, methods: [] }] } }),
    ).rejects.toThrow(TypeError);
    await expect(readAccountLock(rpc, V0, { builds: [{ code_hash: "x" }] })).rejects.toThrow(
      TypeError,
    );
    expect(rpc.calls).toHaveLength(0);
  });

  it("passes a failed read through as the RPC's error", async () => {
    const missing = new NearRpcError("query", { name: "HANDLER_ERROR" }, "query: UNKNOWN_ACCOUNT");
    const rpc = fakeRpc(() => {
      throw missing;
    });
    await expect(readAccountLock(rpc, V0)).rejects.toBe(missing);
  });
});

describe("examples/audit-account.ts", () => {
  it("returns the report lines of the recorded vault under the vault's key shapes", async () => {
    const lines = await auditVault(recordedRpc(), V0, codeHashes);
    expect(lines[0]).toBe(
      `Account ${V0} at block 224468063 (${BLOCK}): 2 access keys, none with full access.`,
    );
    expect(lines.at(-1)).toBe("Verdict: ok, the account is locked.");
  });
});
