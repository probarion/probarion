import { describe, expect, it } from "vitest";
import {
  ConfigError,
  ContractError,
  extractProbarionCode,
  LedgerError,
  NearAiError,
  normalizeVaultCode,
  ProbarionError,
  RpcError,
  ViewError,
} from "../src/errors.js";

describe("vault error codes", () => {
  it("extracts PROBARION:<Code> from strings, errors and nested objects", () => {
    expect(extractProbarionCode("Smart contract panicked: PROBARION:NoMandate")).toBe("NoMandate");
    expect(extractProbarionCode(new Error("tx failed: PROBARION:OverPerPayment"))).toBe(
      "OverPerPayment",
    );
    expect(
      extractProbarionCode({
        ActionError: { kind: { FunctionCallError: { ExecutionError: "PROBARION:DuplicateRef" } } },
      }),
    ).toBe("DuplicateRef");
    expect(extractProbarionCode({ gas: 10n, msg: "PROBARION:Frozen" })).toBe("Frozen");
    expect(extractProbarionCode("Smart contract panicked: PROBARION:RequiresOneYocto")).toBe(
      "RequiresOneYocto",
    );
  });

  it("ignores unknown codes and plain failures", () => {
    expect(extractProbarionCode("PROBARION:PayeeMismatch")).toBeNull();
    expect(extractProbarionCode("Exceeded the prepaid gas")).toBeNull();
  });

  it("normalises check_spend codes with or without the prefix", () => {
    expect(normalizeVaultCode("PROBARION:NoMandate")).toBe("NoMandate");
    expect(normalizeVaultCode("NoMandate")).toBe("NoMandate");
    expect(normalizeVaultCode(null)).toBeNull();
  });

  it("formats contract errors as the panic message", () => {
    const error = new ContractError("BadSeq", "TxHash1", "anchor");
    expect(error.message).toBe("PROBARION:BadSeq");
    expect(error.code).toBe("BadSeq");
  });
});

describe("error classes", () => {
  it("chains ViewError -> RpcError -> ProbarionError -> Error", () => {
    const error = new ViewError(
      "vault.testnet",
      "check_spend",
      "Smart contract panicked: PROBARION:Frozen",
    );
    expect(error).toBeInstanceOf(RpcError);
    expect(error).toBeInstanceOf(ProbarionError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ViewError");
    expect(error.code).toBe("RpcError");
    expect(error.message).toBe(
      "view vault.testnet.check_spend failed: Smart contract panicked: PROBARION:Frozen",
    );
    expect(error.probarionCode).toBe("Frozen");
    expect(new ViewError("v", "m", "boom").probarionCode).toBeNull();
  });

  it("keeps the attempt log and raw rpc error on RpcError", () => {
    const attempts = [{ url: "https://a.test", error: "HTTP 503" }];
    const error = new RpcError("all endpoints failed", attempts, { name: "X" });
    expect(error.attempts).toEqual(attempts);
    expect(error.rpcError).toEqual({ name: "X" });
    const bare = new RpcError("malformed");
    expect(bare.attempts).toEqual([]);
    expect(bare.rpcError).toBeNull();
  });

  it("describes a contract failure without a vault code as a plain transaction failure", () => {
    const error = new ContractError(null, null, "Exceeded the prepaid gas");
    expect(error.message).toBe("transaction failed: Exceeded the prepaid gas");
    expect(error.code).toBe("TxFailed");
    expect(error.vaultCode).toBeNull();
    expect(error.txHash).toBeNull();
  });

  it("gives the simple error classes a stable name and code", () => {
    expect(new ConfigError("c")).toMatchObject({ name: "ConfigError", code: "ConfigError" });
    expect(new NearAiError("n")).toMatchObject({ name: "NearAiError", code: "NearAiError" });
    expect(new LedgerError("l")).toMatchObject({ name: "LedgerError", code: "LedgerError" });
    expect(new ConfigError("c")).toBeInstanceOf(ProbarionError);
  });
});
