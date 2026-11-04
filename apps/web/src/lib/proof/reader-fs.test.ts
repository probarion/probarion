import { InMemoryLedgerStore, Probarion } from "@probarion/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedRpc } from "../../../test/fixtures/rpc";
import { makeProofReader } from "./reader";

// R5: on Vercel there is no docs/evidence and no docs/mainnet-proof.json at runtime, so /proof must never make the SDK
// look for them. Every file read the SDK makes goes through these spies. The SDK reads evidence before its first RPC
// call, so a reader whose RPC refuses every call still shows whether it reached for a file.
const fsCalls = vi.hoisted(() => [] as string[]);
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const spy =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      fsCalls.push(`${name} ${String(args[0])}`);
      return fn(...args);
    };
  const wrapped = {
    ...real,
    readFile: spy("readFile", real.readFile),
    readdir: spy("readdir", real.readdir),
    stat: spy("stat", real.stat),
    open: spy("open", real.open),
  };
  return { ...wrapped, default: wrapped };
});

const V0 = "v0.probarion.near"; // the one vault the SDK reads docs/evidence for (mainnet only)

/** An RPC that refuses every call: snapshot() fails at its first chain read. */
const refusingRpc = () => scriptedRpc([], ["https://rpc.example"]).rpc;

describe("the /proof reader and the file system", () => {
  beforeEach(() => {
    fsCalls.length = 0;
  });

  it("control: a Probarion left to its defaults reaches for docs/evidence and docs/mainnet-proof.json", async () => {
    const pb = new Probarion(
      { network: "mainnet", vault: V0, model: null, ledger: new InMemoryLedgerStore() },
      { rpc: refusingRpc(), archivalRpc: null, onlineVerifier: null, txIndex: null, env: {} },
    );
    await expect(pb.snapshot()).rejects.toThrow();
    expect(fsCalls.some((c) => c.includes("evidence"))).toBe(true);
    expect(fsCalls.some((c) => c.includes("mainnet-proof.json"))).toBe(true);
  });

  it("reads no file, even for mainnet v0, because every evidence dependency is passed", async () => {
    for (const [network, vault] of [
      ["mainnet", V0],
      ["mainnet", "acme.vaults.probarion.near"],
      ["testnet", "v0.probarion.testnet"],
    ] as const) {
      const reader = makeProofReader({
        network,
        vault,
        store: new InMemoryLedgerStore(),
        rpc: refusingRpc(),
        archivalRpcUrls: [],
        evidence: { preLedgerDecisionHashes: [], burnTxHints: new Map() },
      });
      await expect(reader.snapshot(), vault).rejects.toThrow();
    }
    expect(fsCalls).toEqual([]);
  });
});
