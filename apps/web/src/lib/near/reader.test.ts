import { ConfigError, RpcError, ViewError } from "@probarion/sdk";
import { describe, expect, it } from "vitest";
import {
  accountResult,
  contractError,
  httpStatus,
  rpcErr,
  rpcOk,
  scriptedRpc,
  transportError,
  viewBytes,
} from "../../../test/fixtures/rpc";
import { chainErrorKind, createVaultReader, isContractError, listAll } from "./reader";

const VAULT = "v.near";

function readerWith(...args: Parameters<typeof scriptedRpc>) {
  const s = scriptedRpc(...args);
  return { reader: createVaultReader(s.rpc), ...s };
}

/** The decoded view arguments of recorded call `n`. */
function viewArgs(call: { body: { params: Record<string, unknown> } } | undefined) {
  return JSON.parse(Buffer.from(String(call?.body.params.args_base64), "base64").toString());
}

async function kindOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return chainErrorKind(error);
  }
  throw new Error("expected the read to fail");
}

describe("provider failover (SDK RpcClient behind the reader)", () => {
  it("fails over to the next provider on HTTP 429, with backoff", async () => {
    const { reader, calls, sleeps } = readerWith([httpStatus(429), rpcOk(viewBytes({ ok: 1 }))]);
    expect(await reader.getConfig(VAULT)).toEqual({ ok: 1 });
    expect(calls.map((c) => c.url)).toEqual(["https://a.example", "https://b.example"]);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(0);
  });

  it("does not fail over on a deterministic contract error", async () => {
    const { reader, calls } = readerWith([rpcErr("UNKNOWN_ACCOUNT")]);
    const error = await reader.getConfig("nope.near").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ViewError);
    expect(chainErrorKind(error)).toBe("contract");
    expect(calls).toHaveLength(1);
  });

  it("treats the legacy result.error string as a contract error", async () => {
    const { reader } = readerWith([
      rpcOk({ error: "wasm execution failed with error: MethodNotFound", logs: [] }),
    ]);
    expect(await kindOf(reader.getConfig(VAULT))).toBe("contract");
  });

  it("gives up after every round over every provider, as a transport error", async () => {
    const { reader, calls } = readerWith(
      [httpStatus(503), httpStatus(503), httpStatus(503), httpStatus(503)],
      undefined,
      { maxRounds: 2 },
    );
    const error = await reader.getConfig(VAULT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect(chainErrorKind(error)).toBe("transport");
    expect(calls).toHaveLength(4);
  });

  it("keeps an API key in the provider URL out of the error", async () => {
    const { reader } = readerWith(
      [httpStatus(503), httpStatus(503)],
      ["https://rpc.example/v1/SECRET-API-KEY?token=SECRET-TOKEN"],
      { maxRounds: 2 },
    );
    const error = await reader.getConfig(VAULT).catch((e: unknown) => e);
    expect(String(error)).not.toMatch(/SECRET/);
    expect(JSON.stringify((error as RpcError).attempts)).not.toMatch(/SECRET/);
  });

  it("encodes view args as base64 JSON with final finality", async () => {
    const { reader, calls } = readerWith([rpcOk(viewBytes([]))]);
    await reader.listSpends(VAULT, 0, 50);
    expect(calls[0]?.body.method).toBe("query");
    expect(calls[0]?.body.params).toMatchObject({
      request_type: "call_function",
      finality: "final",
      account_id: VAULT,
      method_name: "list_spends",
    });
    expect(viewArgs(calls[0])).toEqual({ from_index: 0, limit: 50 });
  });

  it("caps a page at 100 rows and refuses a bad index before any request", async () => {
    const { reader, calls } = readerWith([rpcOk(viewBytes([]))]);
    await reader.listMandates(VAULT, 100, 500);
    expect(viewArgs(calls[0])).toEqual({ from_index: 100, limit: 100 });
    await expect(reader.listAnchors(VAULT, -1, 10)).rejects.toBeInstanceOf(ConfigError);
    await expect(reader.listSpends(VAULT, 0.5, 10)).rejects.toBeInstanceOf(ConfigError);
    expect(calls).toHaveLength(1);
  });
});

describe("error classification", () => {
  it("separates transport, rpc and contract failures", async () => {
    const internal = readerWith([rpcErr("INTERNAL_ERROR", "INTERNAL_ERROR")]);
    expect(await kindOf(internal.reader.getConfig(VAULT))).toBe("rpc");

    const garbage = readerWith([rpcOk({ result: "not bytes", logs: [] })]);
    expect(await kindOf(garbage.reader.getConfig(VAULT))).toBe("rpc");

    const noCode = readerWith([rpcErr("NO_CONTRACT_CODE")]);
    expect(await kindOf(noCode.reader.getConfig("owner.near"))).toBe("contract");

    const noMethod = readerWith([rpcErr("CONTRACT_EXECUTION_ERROR")]);
    expect(await kindOf(noMethod.reader.getConfig(VAULT))).toBe("contract");

    const down = readerWith([httpStatus(502), httpStatus(502)], ["https://a.example"], {
      maxRounds: 2,
    });
    expect(await kindOf(down.reader.getConfig(VAULT))).toBe("transport");
  });

  it("is null for errors that did not come from the chain", () => {
    expect(chainErrorKind(new Error("boom"))).toBeNull();
    expect(chainErrorKind(new ConfigError("bad"))).toBeNull();
    expect(chainErrorKind("UNKNOWN_ACCOUNT")).toBeNull();
    expect(isContractError(new Error("UNKNOWN_ACCOUNT"))).toBe(false);
  });

  it("the fixture builders classify like real failures", async () => {
    expect(chainErrorKind(contractError())).toBe("contract");
    expect(chainErrorKind(contractError("INTERNAL_ERROR"))).toBe("rpc");
    expect(chainErrorKind(transportError())).toBe("transport");
    const real = readerWith([rpcErr("UNKNOWN_ACCOUNT")]);
    expect(await kindOf(real.reader.getConfig(VAULT))).toBe(chainErrorKind(contractError()));
  });
});

describe("access keys", () => {
  it("parses a function-call key with its allowance", async () => {
    const { reader, calls } = readerWith([
      rpcOk({
        nonce: 1,
        permission: {
          FunctionCall: {
            allowance: "190000000000000000000000",
            receiver_id: VAULT,
            method_names: ["spend"],
          },
        },
      }),
    ]);
    expect(await reader.accessKey(VAULT, "ed25519:pk")).toEqual({
      exists: true,
      fullAccess: false,
      allowance: "190000000000000000000000",
      receiverId: VAULT,
      methodNames: ["spend"],
    });
    expect(calls[0]?.body.params).toEqual({
      request_type: "view_access_key",
      finality: "final",
      account_id: VAULT,
      public_key: "ed25519:pk",
    });
  });

  it("reports a missing key, an unknown account and a full-access key", async () => {
    const { reader } = readerWith([
      rpcErr("UNKNOWN_ACCESS_KEY"),
      rpcErr("UNKNOWN_ACCOUNT"),
      rpcOk({ nonce: 1, permission: "FullAccess" }),
    ]);
    expect((await reader.accessKey(VAULT, "ed25519:gone")).exists).toBe(false);
    expect((await reader.accessKey("nobody.near", "ed25519:gone")).exists).toBe(false);
    expect(await reader.accessKey(VAULT, "ed25519:fa")).toEqual({
      exists: true,
      fullAccess: true,
      allowance: null,
      receiverId: null,
      methodNames: [],
    });
  });

  it("keeps a null allowance as unlimited, not as full access", async () => {
    const { reader } = readerWith([
      rpcOk({
        nonce: 1,
        permission: { FunctionCall: { allowance: null, receiver_id: VAULT, method_names: [] } },
      }),
    ]);
    expect(await reader.accessKey(VAULT, "ed25519:pk")).toMatchObject({
      exists: true,
      fullAccess: false,
      allowance: null,
      methodNames: [],
    });
  });

  it("never understates a permission it does not know", async () => {
    const { reader } = readerWith([
      rpcOk({
        nonce: 1,
        permission: {
          GasKeyFunctionCall: { allowance: "1", receiver_id: VAULT, method_names: [] },
        },
      }),
    ]);
    expect((await reader.accessKey(VAULT, "ed25519:gk")).fullAccess).toBe(true);
  });

  it("refuses an answer without a permission instead of calling it full access", async () => {
    const { reader } = readerWith([rpcOk({ nonce: 1 })]);
    const error = await reader.accessKey(VAULT, "ed25519:pk").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect(String(error)).toMatch(/malformed/);
  });

  it("does not turn a provider outage into a missing key", async () => {
    const { reader } = readerWith([httpStatus(503), httpStatus(503)], ["https://a.example"], {
      maxRounds: 2,
    });
    expect(await kindOf(reader.accessKey(VAULT, "ed25519:pk"))).toBe("transport");
  });
});

describe("balances", () => {
  it("reads the vault's Intents balance with the nep141: token id", async () => {
    const { reader, calls } = readerWith([rpcOk(viewBytes("2500000"))]);
    expect(await reader.intentsBalance("intents.near", VAULT, "base-0xabc.omft.near")).toBe(
      "2500000",
    );
    expect(calls[0]?.body.params).toMatchObject({
      account_id: "intents.near",
      method_name: "mt_balance_of",
    });
    expect(viewArgs(calls[0])).toEqual({
      account_id: VAULT,
      token_id: "nep141:base-0xabc.omft.near",
    });
  });

  it("reads an Intents balance of null as zero and refuses a non-decimal one", async () => {
    const { reader } = readerWith([rpcOk(viewBytes(null)), rpcOk(viewBytes("12.5"))]);
    expect(await reader.intentsBalance("intents.near", VAULT, "t.near")).toBe("0");
    await expect(reader.intentsBalance("intents.near", VAULT, "t.near")).rejects.toBeInstanceOf(
      ViewError,
    );
  });

  it("reads an NEP-141 balance as a decimal string and refuses anything else", async () => {
    const { reader, calls } = readerWith([
      rpcOk(viewBytes("20208197")),
      rpcOk(viewBytes(20208197)),
      rpcOk(viewBytes(null)),
      rpcOk(viewBytes("-5")),
    ]);
    expect(await reader.ftBalance("usdc.near", VAULT)).toBe("20208197");
    expect(calls[0]?.body.params).toMatchObject({
      account_id: "usdc.near",
      method_name: "ft_balance_of",
    });
    expect(viewArgs(calls[0])).toEqual({ account_id: VAULT });
    for (let i = 0; i < 3; i++) {
      await expect(reader.ftBalance("usdc.near", VAULT)).rejects.toBeInstanceOf(ViewError);
    }
  });

  it("does not hide a failed balance read as zero", async () => {
    const { reader } = readerWith([rpcErr("INTERNAL_ERROR", "INTERNAL_ERROR")]);
    await expect(reader.ftBalance("usdc.near", VAULT)).rejects.toBeInstanceOf(RpcError);
  });
});

describe("account existence", () => {
  it("is false for UNKNOWN_ACCOUNT", async () => {
    const { reader } = readerWith([rpcErr("UNKNOWN_ACCOUNT")]);
    expect(await reader.accountExists("acme.vaults.probarion.near")).toBe(false);
  });

  it("is true for an account, whether it runs its own code or a global contract (R6)", async () => {
    const { reader, calls } = readerWith([
      rpcOk(accountResult()),
      rpcOk(accountResult({ code_hash: "1".repeat(32), global_contract_hash: "GlobalHash11111" })),
    ]);
    expect(await reader.accountExists(VAULT)).toBe(true);
    expect(await reader.accountExists(VAULT)).toBe(true);
    expect(calls[0]?.body.params).toMatchObject({
      request_type: "view_account",
      account_id: VAULT,
    });
  });

  it("does not answer false when the node fails or sends a malformed account", async () => {
    const down = readerWith([httpStatus(503), httpStatus(503)], ["https://a.example"], {
      maxRounds: 2,
    });
    expect(await kindOf(down.reader.accountExists(VAULT))).toBe("transport");
    const garbled = readerWith([rpcOk({ nothing: true })]);
    await expect(garbled.reader.accountExists(VAULT)).rejects.toBeInstanceOf(RpcError);
  });
});

describe("listAll (the SDK's pageAll)", () => {
  it("pages through list views until a short page", async () => {
    const pages = [[1, 2], [3]];
    const got = await listAll(async (from, limit) => {
      expect(limit).toBe(2);
      return pages[from / 2] ?? [];
    }, 2);
    expect(got).toEqual([1, 2, 3]);
  });

  it("pages a reader view with the SDK's default page size", async () => {
    const rows = Array.from({ length: 120 }, (_, id) => ({ id }));
    const { reader, calls } = readerWith(
      [
        rpcOk(viewBytes(rows.slice(0, 50))),
        rpcOk(viewBytes(rows.slice(50, 100))),
        rpcOk(viewBytes(rows.slice(100))),
      ],
      ["https://a.example"],
    );
    const got = await listAll((from, limit) => reader.listSpends(VAULT, from, limit));
    expect(got).toHaveLength(120);
    expect(calls.map((c) => viewArgs(c))).toEqual([
      { from_index: 0, limit: 50 },
      { from_index: 50, limit: 50 },
      { from_index: 100, limit: 50 },
    ]);
  });

  it("throws, never truncates, when a node ignores from_index", async () => {
    const same = [{ id: 1 }, { id: 2 }];
    await expect(
      listAll(async () => same, 2, { contractId: VAULT, methodName: "list_spends" }),
    ).rejects.toThrow(/ignores from_index/);
  });

  it("throws on a page longer than asked for", async () => {
    await expect(listAll(async () => [1, 2, 3], 2)).rejects.toBeInstanceOf(ViewError);
  });

  it("throws on a walk that never ends instead of returning a silent prefix", async () => {
    // Each page is new data, so only the page cap stops it (1000 pages).
    const endless = listAll(async (from, limit) =>
      Array.from({ length: limit }, (_, i) => from + i),
    );
    await expect(endless).rejects.toThrow(/more than 1000 pages/);
  });
});
