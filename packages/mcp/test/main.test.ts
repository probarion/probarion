// The binary's main(): MCP over newline-delimited JSON-RPC on stdin/stdout, everything else on stderr.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  createScenarioChain,
  type FakeRpcServer,
  SCENARIO_VAULT,
  startFakeRpcServer,
} from "@probarion/sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/main.js";
import { TOOL_NAMES } from "../src/server.js";

let rpc: FakeRpcServer;
beforeEach(async () => {
  rpc = await startFakeRpcServer(createScenarioChain());
});
afterEach(async () => {
  await rpc.close();
});

function streams() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (c: Buffer) => {
    out += c.toString("utf8");
  });
  stderr.on("data", (c: Buffer) => {
    err += c.toString("utf8");
  });
  return { stdin, stdout, stderr, out: () => out, err: () => err };
}

/** Sends one JSON-RPC request and waits for the line that answers it. */
async function request(
  s: ReturnType<typeof streams>,
  id: number,
  method: string,
  params: unknown,
): Promise<Record<string, unknown>> {
  s.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  for (let i = 0; i < 200; i++) {
    const line = s
      .out()
      .split("\n")
      .find((l) => l.includes(`"id":${id}`));
    if (line !== undefined) return JSON.parse(line) as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no answer to ${method}`);
}

describe("probarion-mcp main", () => {
  it("speaks MCP over stdio in read-only mode, with only JSON-RPC on stdout", async () => {
    const s = streams();
    const home = mkdtempSync(join(tmpdir(), "probarion-mcp-home-"));
    const server = await main({
      env: { NEAR_NETWORK: "testnet", PROBARION_VAULT_ID: SCENARIO_VAULT, NEAR_RPC_URLS: rpc.url },
      home,
      ...s,
    });
    expect(server).not.toBe(2);
    const init = await request(s, 1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(init.result).toMatchObject({ serverInfo: { name: "probarion" } });
    s.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const list = await request(s, 2, "tools/list", {});
    const names = (list.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names.sort()).toEqual([...TOOL_NAMES].sort());
    const call = await request(s, 3, "tools/call", { name: "list_mandates", arguments: {} });
    const text = (call.result as { content: { text: string }[] }).content[0]?.text ?? "";
    expect(JSON.parse(text)).toMatchObject({ vault: SCENARIO_VAULT, read_only: true });
    for (const line of s.out().split("\n").filter(Boolean)) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
    }
    expect(s.err()).toContain(`vault ${SCENARIO_VAULT} on testnet (read-only: no keys set)`);
    if (server !== 2) await server.close();
  });

  it("returns 2 with every problem on stderr and nothing on stdout when the config is wrong", async () => {
    const s = streams();
    const r = await main({
      env: { NEAR_NETWORK: "testnet", PROBARION_AGENT_KEY: "ed25519:only-one-key" },
      home: tmpdir(),
      ...s,
    });
    expect(r).toBe(2);
    expect(s.err()).toContain("PROBARION_VAULT_ID");
    expect(s.err()).toContain("set both PROBARION_AGENT_KEY and PROBARION_LEDGER_KEY");
    expect(s.err()).not.toContain("only-one-key");
    expect(s.out()).toBe("");
  });
});
