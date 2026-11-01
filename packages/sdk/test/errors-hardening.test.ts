import { describe, expect, it } from "vitest";
import {
  extractProbarionCode,
  isVaultErrorCode,
  normalizeVaultCode,
  RpcError,
  ViewError,
} from "../src/errors.js";

describe("extractProbarionCode on hostile values (M1)", () => {
  it("survives an error whose cause is itself", () => {
    const error = new Error("tx failed: PROBARION:Frozen");
    error.cause = error;
    expect(extractProbarionCode(error)).toBe("Frozen");
    const plain = new Error("no code here");
    plain.cause = plain;
    expect(extractProbarionCode(plain)).toBeNull();
  });

  it("survives a longer cause cycle and a cyclic plain object", () => {
    const a = new Error("a");
    const b = new Error("b PROBARION:BadSeq");
    a.cause = b;
    b.cause = a;
    expect(extractProbarionCode(a)).toBe("BadSeq");
    const node: Record<string, unknown> = { label: "node" };
    node.self = node;
    node.list = [node, { again: node }];
    expect(extractProbarionCode(node)).toBeNull();
    node.msg = "PROBARION:NotOwner";
    expect(extractProbarionCode(node)).toBe("NotOwner");
  });

  it("caps nesting depth instead of overflowing the stack", () => {
    let deep: Record<string, unknown> = { msg: "PROBARION:Frozen" };
    for (let i = 0; i < 50_000; i++) deep = { inner: deep };
    expect(extractProbarionCode(deep)).toBeNull();
    let chain = new Error("end");
    for (let i = 0; i < 50_000; i++) chain = new Error(`link ${i}`, { cause: chain });
    expect(extractProbarionCode(chain)).toBeNull();
  });

  it("still finds a code at the depth of a real NEAR ActionError", () => {
    const status = {
      Failure: {
        ActionError: {
          index: 0,
          kind: { FunctionCallError: { ExecutionError: "PROBARION:BadSeq" } },
        },
      },
    };
    expect(extractProbarionCode(status)).toBe("BadSeq");
  });

  it("reads codes from AggregateError members and bigint-bearing objects", () => {
    const aggregate = new AggregateError([new Error("PROBARION:HoldExpired")], "many");
    expect(extractProbarionCode(aggregate)).toBe("HoldExpired");
    expect(extractProbarionCode({ gas: 10n, nested: { msg: "PROBARION:NotHeld" } })).toBe(
      "NotHeld",
    );
  });
});

describe("isVaultErrorCode (M2)", () => {
  it("accepts exactly the codes of the contract", () => {
    expect(isVaultErrorCode("NoMandate")).toBe(true);
    expect(isVaultErrorCode("RequiresOneYocto")).toBe(true);
    expect(isVaultErrorCode("PROBARION:NoMandate")).toBe(false);
    expect(isVaultErrorCode("PayeeMismatch")).toBe(false);
    expect(isVaultErrorCode("")).toBe(false);
    expect(isVaultErrorCode(null)).toBe(false);
    expect(isVaultErrorCode(7)).toBe(false);
  });

  it("normalizeVaultCode returns any string, so callers must check the result", () => {
    expect(normalizeVaultCode("PROBARION:PayeeMismatch")).toBe("PayeeMismatch");
    expect(isVaultErrorCode(normalizeVaultCode("PROBARION:PayeeMismatch"))).toBe(false);
    expect(isVaultErrorCode(normalizeVaultCode("PROBARION:Frozen"))).toBe(true);
  });
});

describe("error context", () => {
  it("carries attempts, rpcError and cause through ViewError and RpcError", () => {
    const attempts = [{ url: "https://a.test", error: "HTTP 503" }];
    const rpcError = { name: "HANDLER_ERROR", data: "PROBARION:Frozen" };
    const cause = new Error("inner");
    const view = new ViewError("v.testnet", "check_spend", "PROBARION:Frozen", {
      attempts,
      rpcError,
      cause,
    });
    expect(view.attempts).toEqual(attempts);
    expect(view.rpcError).toEqual(rpcError);
    expect(view.cause).toBe(cause);
    expect(view.probarionCode).toBe("Frozen");
    const rpc = new RpcError("gave up", attempts, null, { cause });
    expect(rpc.cause).toBe(cause);
    expect(new RpcError("no cause").cause).toBeUndefined();
    expect(new ViewError("v", "m", "d").attempts).toEqual([]);
  });
});
