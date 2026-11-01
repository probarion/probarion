import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createScenarioChain,
  type FakeRpcServer,
  startFakeRpcServer,
} from "@probarion/sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/program.js";
import { tempDir, testIo } from "./helpers.js";

// R10: `vault create` checks the bounds the factory enforces before it prints anything, and reads
// the factory's current version (global or embedded) to size the deposit.

const servers: FakeRpcServer[] = [];

async function start(opts: Parameters<typeof createScenarioChain>[0] = {}): Promise<FakeRpcServer> {
  const server = await startFakeRpcServer(createScenarioChain(opts));
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const BASE = ["--name", "acme", "--approvers", "cfo.testnet", "--sign-as", "owner.testnet"];

async function create(
  server: FakeRpcServer,
  extra: readonly string[],
  env: Record<string, string | undefined> = {},
) {
  const dir = await tempDir();
  const { io, state } = testIo(dir, env);
  const code = await runCli(["--rpc", server.url, "vault", "create", ...extra], io);
  return { code, out: state.out, err: state.err, dir };
}

function flagged(base: readonly string[], flag: string, value: string): string[] {
  const out = [...base];
  const at = out.indexOf(flag);
  if (at === -1) out.push(flag, value);
  else out[at + 1] = value;
  return out;
}

describe("vault create: client-side bounds (the factory's own checks)", () => {
  const approvers = (n: number) => Array.from({ length: n }, (_, i) => `a${i}.testnet`).join(",");

  it.each([
    ["no approver", ["--approvers", ""], "--approvers"],
    ["a blank approver list", ["--approvers", " , "], "--approvers"],
    ["eleven approvers", ["--approvers", approvers(11)], "10"],
    ["an invalid approver id", ["--approvers", "cfo.testnet,Not An Account"], "Not An Account"],
    ["a zero daily backstop", ["--daily-backstop", "0"], "--daily-backstop"],
    ["a daily backstop with 7 decimals", ["--daily-backstop", "1.0000001"], "--daily-backstop"],
    ["a zero held TTL", ["--held-ttl-hours", "0"], "--held-ttl-hours"],
    ["a held TTL of 721 hours", ["--held-ttl-hours", "721"], "720"],
    ["a held TTL of a million hours", ["--held-ttl-hours", "1000000"], "--held-ttl-hours"],
    ["a one-character name", ["--name", "a"], "--name"],
    ["a 32-character name", ["--name", "a".repeat(32)], "--name"],
    ["a name that is not an account label", ["--name", "acme-"], "--name"],
    ["an uppercase name", ["--name", "Acme"], "--name"],
    ["a shell metacharacter in --sign-as", ["--sign-as", "x;echo"], "--sign-as"],
    ["a deposit in yocto spelling", ["--deposit", "1 NEAR"], "--deposit"],
  ])("refuses %s before it reads the factory", async (_name, override, mention) => {
    const server = await start();
    let argv = [...BASE];
    for (let i = 0; i < override.length; i += 2) {
      argv = flagged(argv, override[i] as string, override[i + 1] as string);
    }
    const result = await create(server, argv);
    expect(result.code).toBe(1);
    expect(result.err).toContain(mention);
    expect(result.out).toBe("");
    expect(server.methods).toEqual([]);
  });

  it.each([
    ["ten approvers", ["--approvers", approvers(10)]],
    ["a held TTL of exactly 30 days", ["--held-ttl-hours", "720"]],
    ["a held TTL of one hour", ["--held-ttl-hours", "1"]],
    ["the smallest daily backstop", ["--daily-backstop", "0.000001"]],
    ["a 31-character name", ["--name", `a${"b".repeat(30)}`]],
    ["a two-character name", ["--name", "ab"]],
    ["underscores and hyphens in the name", ["--name", "my_vault-2"]],
  ])("accepts %s", async (_name, override) => {
    const server = await start();
    let argv = [...BASE];
    for (let i = 0; i < override.length; i += 2) {
      argv = flagged(argv, override[i] as string, override[i + 1] as string);
    }
    const result = await create(server, argv);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
  });

  it("prints the bound values exactly at the limits", async () => {
    const server = await start();
    const argv = flagged(
      flagged(flagged(BASE, "--held-ttl-hours", "720"), "--daily-backstop", "0.000001"),
      "--approvers",
      Array.from({ length: 10 }, (_, i) => `a${i}.testnet`).join(","),
    );
    const result = await create(server, argv);
    expect(result.code).toBe(0);
    const printed = JSON.parse(await readFile(join(result.dir, "create_vault.args.json"), "utf8"));
    expect(printed.held_ttl_ns).toBe("2592000000000000");
    expect(printed.daily_backstop).toBe("1");
    expect(printed.approvers).toHaveLength(10);
  });
});

describe("vault create: the factory's current version decides the deposit", () => {
  it("global version: the default deposit is exactly min_deposit", async () => {
    const server = await start();
    const result = await create(server, BASE);
    expect(result.code).toBe(0);
    expect(result.out).toContain("attached-deposit '5 NEAR'");
    expect(result.out).toContain("global");
    expect(server.methods.every((m) => m === "query")).toBe(true);
    expect(server.chain.txs.size).toBe(0);
  });

  it("global version: an explicit deposit is printed in canonical form", async () => {
    const server = await start();
    const result = await create(server, [...BASE, "--deposit", "5.50"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("attached-deposit '5.5 NEAR'");
  });

  it("accepts a deposit of exactly min_deposit, and refuses one yocto less", async () => {
    const server = await start();
    const exact = await create(server, [...BASE, "--deposit", "5"]);
    expect(exact.code).toBe(0);
    expect(exact.out).toContain("attached-deposit '5 NEAR'");
    const oneYoctoShort = await create(server, [
      ...BASE,
      "--deposit",
      "4.999999999999999999999999",
    ]);
    expect(oneYoctoShort.code).toBe(1);
    expect(oneYoctoShort.err).toContain("min_deposit");
  });

  it("refuses a deposit below the factory's min_deposit", async () => {
    const server = await start();
    const result = await create(server, [...BASE, "--deposit", "4.99"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("min_deposit");
    expect(result.err).toContain("5 NEAR");
    expect(result.out).toBe("");
  });

  it("embedded version without --deposit stops and says how to size it", async () => {
    const server = await start({ codeMode: "local" });
    const result = await create(server, BASE);
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      "pass --deposit (min_deposit + about 1 NEAR per 100 KB of vault wasm, 2.49 NEAR at 248,501 bytes)",
    );
    expect(result.err).toContain("embedded");
    expect(result.out).toBe("");
  });

  it("embedded version with --deposit prints it and warns about the storage part", async () => {
    const server = await start({ codeMode: "local" });
    const result = await create(server, [...BASE, "--deposit", "8"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("attached-deposit '8 NEAR'");
    expect(result.out).toContain("embedded");
    expect(result.out).toContain("InsufficientDeposit");
  });

  it("embedded version still refuses a deposit below min_deposit", async () => {
    const server = await start({ codeMode: "local" });
    const result = await create(server, [...BASE, "--deposit", "1"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("min_deposit");
  });

  it("a factory with no registered version cannot create a vault", async () => {
    const server = await start();
    if (server.chain.factory === null) throw new Error("scenario has a factory");
    server.chain.factory.config.current_version = null;
    server.chain.factory.versions = [];
    const result = await create(server, [...BASE, "--deposit", "5"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("no vault version");
    expect(result.out).toBe("");
  });

  it("a current_version that is not in versions() is an error, not a guess", async () => {
    const server = await start();
    if (server.chain.factory === null) throw new Error("scenario has a factory");
    server.chain.factory.config.current_version = 7;
    const result = await create(server, BASE);
    expect(result.code).toBe(1);
    expect(result.err).toContain("version 7");
  });

  it("an unknown version mode is an error", async () => {
    const server = await start();
    const first = server.chain.factory?.versions[0];
    if (first === undefined) throw new Error("scenario has a version");
    first.mode = "mystery";
    const result = await create(server, BASE);
    expect(result.code).toBe(1);
    expect(result.err).toContain("mystery");
  });

  it("an unreachable factory fails closed instead of guessing a deposit", async () => {
    const server = await start({ factory: false });
    const result = await create(server, [...BASE, "--deposit", "5"]);
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
  });

  it("PROBARION_FACTORY_ID overrides the network's factory; an empty value does not (R12)", async () => {
    const server = await start();
    if (server.chain.factory === null) throw new Error("scenario has a factory");
    const empty = await create(server, BASE, { PROBARION_FACTORY_ID: "" });
    expect(empty.code).toBe(0);
    expect(empty.out).toContain(" vaults.probarion.testnet create_vault ");
    expect(empty.out).toContain("acme.vaults.probarion.testnet");

    server.chain.factory.id = "factory2.testnet";
    const custom = await create(server, BASE, { PROBARION_FACTORY_ID: "factory2.testnet" });
    expect(custom.code).toBe(0);
    expect(custom.out).toContain(" factory2.testnet create_vault ");
    expect(custom.out).toContain("acme.factory2.testnet");

    const bad = await create(server, BASE, { PROBARION_FACTORY_ID: "not a factory" });
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("PROBARION_FACTORY_ID");
  });

  it("refuses a name whose account would be longer than 64 characters", async () => {
    const server = await start();
    if (server.chain.factory === null) throw new Error("scenario has a factory");
    const long = `${"f".repeat(40)}.testnet`;
    server.chain.factory.id = long;
    const result = await create(server, [...BASE, "--name", "b".repeat(25)], {
      PROBARION_FACTORY_ID: long,
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain("--name");
  });
});
