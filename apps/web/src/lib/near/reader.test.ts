import { ConfigError, RpcError, ViewError } from "@probarion/sdk";
import { describe, expect, it } from "vitest";
import {
  accountResult,
  contractError,
  httpStatus,
  legacyErr,
  nodeError,
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

/** A reader whose every request is answered 503: the providers are down. */
function downReader() {
  return readerWith([httpStatus(503), httpStatus(503)], ["https://a.example"], { maxRounds: 2 });
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

    expect(await kindOf(downReader().reader.getConfig(VAULT))).toBe("transport");
  });

  it.each([
    "account x.near does not exist while viewing",
    "contract code of account x.near has not been deployed",
    'wasm execution failed with error: FunctionCallError(CompilationError(CodeDoesNotExist { account_id: "x.near" }))',
    "wasm execution failed with error: MethodResolveError(MethodNotFound)",
    "Smart contract panicked: PROBARION:Frozen",
  ])("reads the legacy result.error %j as a contract error", async (text) => {
    const { reader } = readerWith([legacyErr(text)]);
    expect(await kindOf(reader.getConfig(VAULT))).toBe("contract");
  });

  it("does not read an unrecognised legacy result.error from a view as a contract error", async () => {
    const { reader } = readerWith([legacyErr("something unexpected")]);
    expect(await kindOf(reader.getConfig(VAULT))).toBe("rpc");
  });

  it("is null for errors that did not come from the chain", () => {
    expect(chainErrorKind(new Error("boom"))).toBeNull();
    expect(chainErrorKind(new ConfigError("bad"))).toBeNull();
    expect(chainErrorKind("UNKNOWN_ACCOUNT")).toBeNull();
    expect(isContractError(new Error("UNKNOWN_ACCOUNT"))).toBe(false);
  });

  it("the fixture builders classify like real failures", async () => {
    expect(chainErrorKind(contractError())).toBe("contract");
    expect(chainErrorKind(contractError("NO_CONTRACT_CODE"))).toBe("contract");
    expect(chainErrorKind(nodeError())).toBe("rpc");
    expect(chainErrorKind(transportError())).toBe("transport");

    const real = readerWith([rpcErr("UNKNOWN_ACCOUNT")]);
    expect(await kindOf(real.reader.getConfig(VAULT))).toBe(chainErrorKind(contractError()));
    const busy = readerWith([rpcErr("INTERNAL_ERROR", "INTERNAL_ERROR")]);
    expect(await kindOf(busy.reader.getConfig(VAULT))).toBe(chainErrorKind(nodeError()));
    expect(await kindOf(downReader().reader.getConfig(VAULT))).toBe(
      chainErrorKind(transportError()),
    );
  });
});

describe("access keys", () => {
  const fc = (extra: Record<string, unknown> = {}) => ({
    receiver_id: VAULT,
    method_names: ["spend"],
    ...extra,
  });
  const keyResult = (permission: unknown) => rpcOk({ nonce: 1, permission });

  it("sends a view_access_key query for the account and key", async () => {
    const { reader, calls } = readerWith([keyResult("FullAccess")]);
    await reader.accessKey(VAULT, "ed25519:pk");
    expect(calls[0]?.body.method).toBe("query");
    expect(calls[0]?.body.params).toEqual({
      request_type: "view_access_key",
      finality: "final",
      account_id: VAULT,
      public_key: "ed25519:pk",
    });
  });

  describe("reads each of the four permission variants", () => {
    it("FunctionCall: scoped, with its allowance", async () => {
      const { reader } = readerWith([
        keyResult({ FunctionCall: fc({ allowance: "190000000000000000000000" }) }),
      ]);
      expect(await reader.accessKey(VAULT, "ed25519:pk")).toEqual({
        exists: true,
        kind: "FunctionCall",
        fullAccess: false,
        allowance: "190000000000000000000000",
        receiverId: VAULT,
        methodNames: ["spend"],
      });
    });

    it("FunctionCall with a null or absent allowance is unlimited, not full access", async () => {
      const { reader } = readerWith([
        keyResult({ FunctionCall: fc({ allowance: null, method_names: [] }) }),
        keyResult({ FunctionCall: fc() }),
      ]);
      const expected = { exists: true, kind: "FunctionCall", fullAccess: false, allowance: null };
      expect(await reader.accessKey(VAULT, "ed25519:a")).toMatchObject({
        ...expected,
        methodNames: [],
      });
      expect(await reader.accessKey(VAULT, "ed25519:b")).toMatchObject(expected);
    });

    it("FullAccess", async () => {
      const { reader } = readerWith([keyResult("FullAccess")]);
      expect(await reader.accessKey(VAULT, "ed25519:fa")).toEqual({
        exists: true,
        kind: "FullAccess",
        fullAccess: true,
        allowance: null,
        receiverId: null,
        methodNames: [],
      });
    });

    it("GasKeyFullAccess: full access", async () => {
      const { reader } = readerWith([
        keyResult({ GasKeyFullAccess: { balance: "1000", num_nonces: 2 } }),
      ]);
      expect(await reader.accessKey(VAULT, "ed25519:gk")).toEqual({
        exists: true,
        kind: "GasKeyFullAccess",
        fullAccess: true,
        allowance: null,
        receiverId: null,
        methodNames: [],
      });
    });

    it("GasKeyFunctionCall: scoped, not full access", async () => {
      const { reader } = readerWith([
        keyResult({
          GasKeyFunctionCall: fc({ allowance: "5", balance: "1000", num_nonces: 2 }),
        }),
      ]);
      expect(await reader.accessKey(VAULT, "ed25519:gk")).toEqual({
        exists: true,
        kind: "GasKeyFunctionCall",
        fullAccess: false,
        allowance: "5",
        receiverId: VAULT,
        methodNames: ["spend"],
      });
    });
  });

  describe("fails closed on a permission it cannot read", () => {
    it.each([
      ["a missing permission", undefined],
      ["an unknown string", "ReadOnly"],
      ["an unknown variant", { ReadOnly: { receiver_id: VAULT } }],
      ["FullAccess spelled as an object", { FullAccess: {} }],
      ["two variants at once", { FullAccess: {}, FunctionCall: fc() }],
      ["an empty object", {}],
      ["null", null],
      ["an array", ["FullAccess"]],
      ["a FunctionCall that is not an object", { FunctionCall: "x" }],
      ["a FunctionCall without receiver_id", { FunctionCall: { method_names: [] } }],
      ["a FunctionCall with an empty receiver_id", { FunctionCall: fc({ receiver_id: "" }) }],
      ["a FunctionCall without method_names", { FunctionCall: { receiver_id: VAULT } }],
      ["method_names that is not a list", { FunctionCall: fc({ method_names: "spend" }) }],
      ["method_names with a non-string", { FunctionCall: fc({ method_names: ["spend", 1] }) }],
      ["a numeric allowance", { FunctionCall: fc({ allowance: 5 }) }],
      ["a non-decimal allowance", { FunctionCall: fc({ allowance: "1e24" }) }],
      ["a negative allowance", { FunctionCall: fc({ allowance: "-1" }) }],
      ["a GasKeyFunctionCall without method_names", { GasKeyFunctionCall: { receiver_id: VAULT } }],
      ["a GasKeyFullAccess that is not an object", { GasKeyFullAccess: "x" }],
      ["a GasKeyFullAccess without balance", { GasKeyFullAccess: { num_nonces: 1 } }],
      ["a GasKeyFullAccess without num_nonces", { GasKeyFullAccess: { balance: "1" } }],
      [
        "a GasKeyFullAccess with a numeric balance",
        { GasKeyFullAccess: { balance: 1000, num_nonces: 1 } },
      ],
      [
        "a GasKeyFullAccess with a non-decimal balance",
        { GasKeyFullAccess: { balance: "1.5", num_nonces: 1 } },
      ],
      [
        "a GasKeyFullAccess with a fractional num_nonces",
        { GasKeyFullAccess: { balance: "1", num_nonces: 1.5 } },
      ],
      [
        "a GasKeyFullAccess with a negative num_nonces",
        { GasKeyFullAccess: { balance: "1", num_nonces: -1 } },
      ],
      ["a GasKeyFunctionCall without balance", { GasKeyFunctionCall: fc({ num_nonces: 1 }) }],
      ["a GasKeyFunctionCall without num_nonces", { GasKeyFunctionCall: fc({ balance: "1" }) }],
      ["a lower-case fullaccess", "fullaccess"],
      ["an upper-case FULLACCESS", "FULLACCESS"],
      ["a lower-case functionCall", { functionCall: fc() }],
      ["a lower-case gaskeyfullaccess", { gaskeyfullaccess: { balance: "1", num_nonces: 1 } }],
    ])("rejects %s, as an rpc error and never as full access", async (_label, permission) => {
      const { reader } = readerWith([keyResult(permission)]);
      const error = await reader.accessKey(VAULT, "ed25519:pk").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RpcError);
      expect(chainErrorKind(error)).toBe("rpc");
    });

    it("rejects an answer that is not an object", async () => {
      const { reader } = readerWith([rpcOk("FullAccess")]);
      expect(await kindOf(reader.accessKey(VAULT, "ed25519:pk"))).toBe("rpc");
    });
  });

  describe("a missing key", () => {
    it("is reported for the structured UNKNOWN_ACCESS_KEY and UNKNOWN_ACCOUNT errors", async () => {
      const { reader } = readerWith([rpcErr("UNKNOWN_ACCESS_KEY"), rpcErr("UNKNOWN_ACCOUNT")]);
      expect(await reader.accessKey(VAULT, "ed25519:gone")).toEqual({
        exists: false,
        kind: null,
        fullAccess: false,
        allowance: null,
        receiverId: null,
        methodNames: [],
      });
      expect((await reader.accessKey("nobody.near", "ed25519:gone")).exists).toBe(false);
    });

    it("is reported for the answer real nodes send: HTTP 200 with result.error", async () => {
      const { reader } = readerWith([
        legacyErr("access key ed25519:x does not exist while viewing"),
        legacyErr("account nobody.near does not exist while viewing"),
      ]);
      expect(await reader.accessKey(VAULT, "ed25519:x")).toMatchObject({
        exists: false,
        kind: null,
        fullAccess: false,
      });
      expect((await reader.accessKey("nobody.near", "ed25519:x")).exists).toBe(false);
    });

    it.each([
      "xx access key ed25519:x does not exist while viewing yy",
      "xx access key ed25519:x does not exist while viewing",
      "access key ed25519:x does not exist while viewing yy",
      "Access key ed25519:x does not exist while viewing",
      "access key ed25519:x DOES NOT EXIST while viewing",
      "xx account nobody.near does not exist while viewing yy",
      "Account nobody.near does not exist while viewing",
    ])("is only reported for the exact phrase, not for %j", async (text) => {
      const { reader } = readerWith([legacyErr(text)]);
      const error = await reader.accessKey(VAULT, "ed25519:x").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ViewError);
    });

    it.each([
      ["a gateway's refusal", "Unauthorized: invalid API key"],
      ["a policy text", "access key lookup refused for policy reasons"],
      ["a node problem", "internal error: shard is not synced"],
      ["an empty text", ""],
    ])("does not read %s as an answer about the key: rpc", async (_label, text) => {
      const { reader } = readerWith([legacyErr(text)]);
      const error = await reader.accessKey(VAULT, "ed25519:x").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ViewError);
      expect(chainErrorKind(error)).toBe("rpc");
    });

    it("reads another recognised target phrase from view_access_key as a contract error", async () => {
      const { reader } = readerWith([
        legacyErr("contract code of account v.near has not been deployed"),
      ]);
      expect(await kindOf(reader.accessKey(VAULT, "ed25519:x"))).toBe("contract");
    });

    it("does not turn a provider outage into a missing key", async () => {
      expect(await kindOf(downReader().reader.accessKey(VAULT, "ed25519:pk"))).toBe("transport");
    });

    it("does not turn another node error into a missing key", async () => {
      const { reader } = readerWith([rpcErr("INTERNAL_ERROR", "INTERNAL_ERROR")]);
      expect(await kindOf(reader.accessKey(VAULT, "ed25519:pk"))).toBe("rpc");
    });
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

  it("never reads an Intents balance as zero by default: null and non-decimals reject", async () => {
    const { reader } = readerWith([
      rpcOk(viewBytes(null)),
      rpcOk(viewBytes("12.5")),
      rpcOk(viewBytes(5)),
      rpcOk(viewBytes("0")),
    ]);
    for (let i = 0; i < 3; i++) {
      const error = await reader
        .intentsBalance("intents.near", VAULT, "t.near")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ViewError);
      expect(chainErrorKind(error)).toBe("rpc");
    }
    // A real zero is the contract's own "0".
    expect(await reader.intentsBalance("intents.near", VAULT, "t.near")).toBe("0");
  });

  it("does not hide a failed Intents balance read as zero", async () => {
    const { reader } = downReader();
    expect(await kindOf(reader.intentsBalance("intents.near", VAULT, "t.near"))).toBe("transport");
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

  it("is false for the answer real nodes may send: HTTP 200 with result.error", async () => {
    const text = "account free.vaults.probarion.near does not exist while viewing";
    const { reader, calls } = readerWith([legacyErr(text), legacyErr(text)]);
    expect(await reader.accountExists("free.vaults.probarion.near")).toBe(false);
    // The SDK cannot read that answer, so the adapter looked once more at the raw result.
    expect(calls.map((c) => c.body.params.request_type)).toEqual(["view_account", "view_account"]);
  });

  it("does not answer false for any other unreadable account answer", async () => {
    expect(await kindOf(downReader().reader.accountExists(VAULT))).toBe("transport");

    const garbled = readerWith([rpcOk({ nothing: true }), rpcOk({ nothing: true })]);
    const error = await garbled.reader.accountExists(VAULT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect(chainErrorKind(error)).toBe("rpc");

    const refused = readerWith([legacyErr("something else"), legacyErr("something else")]);
    expect(await kindOf(refused.reader.accountExists(VAULT))).toBe("rpc");

    const busy = readerWith([rpcErr("INTERNAL_ERROR", "INTERNAL_ERROR")]);
    expect(await kindOf(busy.reader.accountExists(VAULT))).toBe("rpc");
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
