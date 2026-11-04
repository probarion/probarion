import { InMemoryLedgerStore } from "@probarion/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/port";
import { ProofEvidenceError } from "./evidence";
import type { ProofReaderInput } from "./reader";

// proofDeps is wiring: what it reads from the environment, the session and the content file, and what it hands
// the reader. Everything it calls is replaced here; the reader records its input instead of reading the chain.
const h = vi.hoisted(() => ({
  env: { NEAR_NETWORK: "testnet", NEAR_ARCHIVAL_RPC_URLS: [] as string[] },
  session: null as { accountId: string } | null,
  evidence: {} as unknown,
  readerInputs: [] as unknown[],
  rpc: { tag: "rpc" },
  publicDb: { tag: "anon" } as unknown as Db,
  serviceDb: { tag: "service" } as unknown as Db,
}));

vi.mock("@/lib/env", () => ({ getEnv: () => h.env }));
vi.mock("@/lib/auth/guard", () => ({ getSession: async () => h.session }));
vi.mock("@/lib/db/clients", () => ({ publicDb: () => h.publicDb, serviceDb: () => h.serviceDb }));
vi.mock("@/lib/near/server", () => ({ getRpc: () => h.rpc }));
vi.mock("../../../content/proof-evidence.json", () => ({
  get default() {
    return h.evidence;
  },
}));
vi.mock("./reader", () => ({
  makeProofReader: (o: unknown) => {
    h.readerInputs.push(o);
    return { snapshot: async () => ({}) };
  },
}));

import { proofDeps } from "./deps";

describe("proofDeps", () => {
  beforeEach(() => {
    h.env = { NEAR_NETWORK: "testnet", NEAR_ARCHIVAL_RPC_URLS: [] };
    h.session = null;
    h.evidence = {};
    h.readerInputs = [];
  });

  it("reads the deployment's network, both database clients and the signed-in account", async () => {
    const d = await proofDeps();
    expect(d.network).toBe("testnet");
    expect(d.publicDb).toBe(h.publicDb);
    expect(d.serviceDb).toBe(h.serviceDb);
    expect(d.sessionAccount).toBeNull();
    h.session = { accountId: "owner.testnet" };
    expect((await proofDeps()).sessionAccount).toBe("owner.testnet");
  });

  it("gives the reader the vault, its store, the shared RPC, the archival URLs and the vault's evidence", async () => {
    h.env = { NEAR_NETWORK: "mainnet", NEAR_ARCHIVAL_RPC_URLS: ["https://archival.example"] };
    h.evidence = { "mainnet:v0.probarion.near": { preLedgerDecisionHashes: ["1".repeat(64)] } };
    const store = new InMemoryLedgerStore();
    const d = await proofDeps();
    d.makeReader("v0.probarion.near", store);
    d.makeReader("acme.vaults.probarion.near", store);
    const [v0, other] = h.readerInputs as ProofReaderInput[];
    expect(v0).toEqual({
      network: "mainnet",
      vault: "v0.probarion.near",
      store,
      rpc: h.rpc,
      archivalRpcUrls: ["https://archival.example"],
      evidence: { preLedgerDecisionHashes: ["1".repeat(64)], burnTxHints: new Map() },
    });
    expect(other?.evidence).toEqual({ preLedgerDecisionHashes: [], burnTxHints: new Map() });
  });

  it("fails closed: a malformed evidence file makes the reader throw, so the page shows an error", async () => {
    h.evidence = { "mainnet:v0.probarion.near": { preLedgerDecisionHashes: "not a list" } };
    const d = await proofDeps();
    expect(() => d.makeReader("v0.probarion.near", new InMemoryLedgerStore())).toThrow(
      ProofEvidenceError,
    );
    expect(h.readerInputs).toEqual([]);
  });
});
