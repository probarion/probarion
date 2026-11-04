import { InMemoryLedgerStore, Probarion, RpcClient } from "@probarion/sdk";
import { describe, expect, it, vi } from "vitest";
import { txHash } from "../../../test/fixtures/proof";
import { makeProofReader, proofReaderDeps } from "./reader";

const rpc = new RpcClient({ urls: ["https://rpc.example"] });
const none = { preLedgerDecisionHashes: [], burnTxHints: new Map() };

describe("the read-only Probarion behind /proof (R5)", () => {
  it("passes every verifier dependency explicitly, so the SDK reads no file and no environment", () => {
    const deps = proofReaderDeps({ rpc, archivalRpcUrls: [], evidence: none });
    expect(deps.rpc).toBe(rpc);
    expect(deps.archivalRpc).toBeNull();
    expect(deps.preLedgerDecisionHashes).toEqual([]);
    expect(deps.burnTxHints).toEqual(new Map());
    expect(deps.onlineVerifier).toBeNull();
    expect(deps.txIndex).toBeNull();
    expect(deps.env).toEqual({});
    // The explicit hashes replace it; it is never passed.
    expect("evidenceDir" in deps).toBe(false);
  });

  it("uses NEAR_ARCHIVAL_RPC_URLS for burn lookups when it lists any", () => {
    const deps = proofReaderDeps({
      rpc,
      archivalRpcUrls: ["https://archival.example", "https://archival2.example"],
      evidence: none,
    });
    expect(deps.archivalRpc).toBeInstanceOf(RpcClient);
    expect(deps.archivalRpc?.currentUrl).toBe("https://archival.example");
  });

  it("hands the vault's own evidence to the SDK, unchanged", () => {
    const evidence = {
      preLedgerDecisionHashes: ["1".repeat(64)],
      burnTxHints: new Map([[2, [{ hash: txHash(1), signer: "cfo.near" }]]]),
    };
    const deps = proofReaderDeps({ rpc, archivalRpcUrls: [], evidence });
    expect(deps.preLedgerDecisionHashes).toEqual(["1".repeat(64)]);
    expect(deps.burnTxHints).toBe(evidence.burnTxHints);
  });

  it("is a Probarion with no keys and no model, for the vault and network asked for", () => {
    const reader = makeProofReader({
      network: "testnet",
      vault: "v0.probarion.testnet",
      store: new InMemoryLedgerStore(),
      rpc,
      archivalRpcUrls: [],
      evidence: none,
    });
    expect(reader).toBeInstanceOf(Probarion);
    const pb = reader as Probarion;
    expect(pb.vaultId).toBe("v0.probarion.testnet");
    expect(pb.network).toBe("testnet");
    // Read-only: it refuses to spend.
    return expect(
      pb.requestSpend({ mandateId: 1, amount: "1", invoiceHash: "a".repeat(64), ref: "r" }),
    ).rejects.toThrow(/read-only/);
  });
});

describe("the SDK's warnings", () => {
  it("go to the web's structured log, named, with what the SDK said", () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      const deps = proofReaderDeps({ rpc, archivalRpcUrls: [], evidence: none });
      deps.logger?.warn("burn lookup failed", { vault: "v0.probarion.testnet" });
    } finally {
      spy.mockRestore();
    }
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      level: "warn",
      msg: "proof.sdk_warning",
      message: "burn lookup failed",
      vault: "v0.probarion.testnet",
    });
  });
});
