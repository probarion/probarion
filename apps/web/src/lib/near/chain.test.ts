import { RpcMalformedError } from "@probarion/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { httpStatus, rpcErr, rpcOk, scriptedRpc } from "../../../test/fixtures/rpc";

const logged = vi.hoisted(() => [] as { msg: string; fields: Record<string, unknown> }[]);
vi.mock("@/lib/log", async (orig) => ({
  ...(await orig<typeof import("@/lib/log")>()),
  log: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (msg: string, fields: Record<string, unknown>) => logged.push({ msg, fields }),
  },
}));

import { ensureChain, forgetVerifiedChains, WrongChainError } from "./chain";

// W-NET-R4 (fix round 1): the two paths that create lasting state, sign-in and Register, first check once that the RPC of the
// network answers for that network's chain. A setting that points testnet's RPC at mainnet (or the other way round) is
// caught here whatever the URL looks like.
const status = (chain_id: unknown) =>
  rpcOk({ chain_id, protocol_version: 73, latest_protocol_version: 73 });
const URLS = ["https://secret-key@rpc.example/abc123"];

beforeEach(() => {
  forgetVerifiedChains();
  logged.length = 0;
});

describe("ensureChain", () => {
  it.each(["mainnet", "testnet"] as const)(
    "passes when the %s RPC answers for its own chain",
    async (network) => {
      const { rpc, calls } = scriptedRpc([status(network)], URLS);
      await expect(ensureChain(network, rpc)).resolves.toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.body).toMatchObject({ method: "status", params: [] });
    },
  );

  it.each([
    ["mainnet", "testnet"],
    ["testnet", "mainnet"],
  ] as const)("throws WrongChainError when the %s RPC answers for %s", async (network, answers) => {
    const { rpc } = scriptedRpc([status(answers)], URLS);
    const error = await ensureChain(network, rpc).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WrongChainError);
    expect((error as WrongChainError).network).toBe(network);
  });

  it("logs the network and nothing of the RPC: no URL, no key, not even the other chain's name", async () => {
    const { rpc } = scriptedRpc([status("testnet")], URLS);
    await ensureChain("mainnet", rpc).catch(() => {});
    expect(logged).toEqual([{ msg: "chain.wrong", fields: { network: "mainnet" } }]);
    expect(JSON.stringify(logged)).not.toMatch(/secret-key|abc123|rpc\.example/);
  });

  it("does not remember a mismatch: the next call asks again, so a fixed setting is picked up", async () => {
    const { rpc, calls } = scriptedRpc([status("testnet"), status("mainnet")], URLS);
    await expect(ensureChain("mainnet", rpc)).rejects.toBeInstanceOf(WrongChainError);
    await expect(ensureChain("mainnet", rpc)).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("asks once per network for the life of the process: a pass is remembered, for that network only", async () => {
    const main = scriptedRpc([status("mainnet")], URLS);
    await ensureChain("mainnet", main.rpc);
    await ensureChain("mainnet", main.rpc);
    await ensureChain("mainnet", main.rpc);
    expect(main.calls).toHaveLength(1);
    // The other network was not checked by that pass.
    const test = scriptedRpc([status("testnet")], URLS);
    await ensureChain("testnet", test.rpc);
    expect(test.calls).toHaveLength(1);
    // A remembered pass does not even touch the client it is given.
    const dead = scriptedRpc([], URLS);
    await ensureChain("mainnet", dead.rpc);
    expect(dead.calls).toHaveLength(0);
  });

  it("lets a transient failure through as the RPC's own error, and does not remember it", async () => {
    const down = scriptedRpc([httpStatus(503), httpStatus(503)], URLS, { maxRounds: 1 });
    const error = await ensureChain("mainnet", down.rpc).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(WrongChainError);
    expect(error).toBeInstanceOf(Error);
    // The node comes back: the next call checks, and passes.
    const up = scriptedRpc([status("mainnet")], URLS);
    await ensureChain("mainnet", up.rpc);
    expect(up.calls).toHaveLength(1);
    expect(logged).toEqual([]);
  });

  it("treats an answer it cannot read as a failure of the RPC, never as a pass and never as a wrong chain", async () => {
    for (const bad of [
      rpcOk(null),
      rpcOk({}),
      rpcOk({ chain_id: 1 }),
      rpcOk({ chain_id: "" }),
      rpcOk("mainnet"),
    ]) {
      const { rpc } = scriptedRpc([bad], URLS);
      const error = await ensureChain("mainnet", rpc).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RpcMalformedError);
      expect(error).not.toBeInstanceOf(WrongChainError);
    }
    // Nothing was remembered by any of them.
    const ok = scriptedRpc([status("mainnet")], URLS);
    await ensureChain("mainnet", ok.rpc);
    expect(ok.calls).toHaveLength(1);
  });

  it("does not take a node's error answer for a chain", async () => {
    const { rpc } = scriptedRpc([rpcErr("UNKNOWN_BLOCK")], URLS);
    const error = await ensureChain("testnet", rpc).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(WrongChainError);
  });

  it("compares the chain id exactly: Mainnet, a trailing space or a longer name is another chain", async () => {
    for (const id of ["Mainnet", "mainnet ", "mainnet-2", "testnet"]) {
      const { rpc } = scriptedRpc([status(id)], URLS);
      await expect(ensureChain("mainnet", rpc), id).rejects.toBeInstanceOf(WrongChainError);
    }
  });
});
