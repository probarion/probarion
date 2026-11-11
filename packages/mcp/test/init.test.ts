// `probarion-mcp init`: the keys go into the file and nowhere else; only the two public keys are printed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/cli.js";
import { INIT_HELP, runInit } from "../src/init.js";
import { parseKeysFile } from "../src/keys-file.js";
import { capture, expectNoSecret, keysFileText, tempDir } from "./keys-helpers.js";

const VAULT = "acme.vaults.probarion.testnet";
const MAINNET_VAULT = "acme.vaults.probarion.near";

interface Run {
  code: number;
  out: string;
  err: string;
}

async function init(
  args: string[],
  opts: {
    home?: string;
    cwd?: string;
    platform?: NodeJS.Platform;
    env?: Record<string, string>;
  } = {},
): Promise<Run> {
  const out = capture();
  const err = capture();
  const code = await runInit(args, {
    env: opts.env ?? {},
    home: opts.home ?? tempDir("probarion-init-home-"),
    cwd: opts.cwd ?? tempDir("probarion-init-cwd-"),
    out: out.stream,
    err: err.stream,
    platform: opts.platform ?? "linux",
    now: () => new Date("2026-11-11T08:00:00.000Z"),
  });
  return { code, out: out.text(), err: err.text() };
}

/** The two secret keys and public keys of the file at `path`. */
function keysOf(path: string, vault = VAULT, network: "mainnet" | "testnet" = "testnet") {
  const parsed = parseKeysFile(readFileSync(path, "utf8"), path, { vault, network });
  if (!parsed.ok) throw new Error(parsed.problems.join("; "));
  return parsed.keys;
}

describe("probarion-mcp init", () => {
  it("writes the keys file and prints only the two public keys, the path and the next steps", async () => {
    const home = tempDir("probarion-init-home-");
    const r = await init(["--vault", VAULT], { home });
    expect(r.code).toBe(0);
    const path = join(home, ".probarion", VAULT, "keys.json");
    const keys = keysOf(path);
    for (const text of [r.out, r.err]) expectNoSecret(text, [keys.agentKey, keys.ledgerKey]);
    expect(r.out).toContain(`agent public key:  ${keys.agentPublicKey}`);
    expect(r.out).toContain(`ledger public key: ${keys.ledgerPublicKey}`);
    expect(r.out).toContain(`Wrote the keys file ${path} (mode 0600)`);
    expect(r.out).toContain(
      `the Agent (MCP) tab of the vault's console: https://probarion.xyz/console/${VAULT}/agent`,
    );
    expect(r.out).toContain(`probarion agent add --vault ${VAULT} --pk '${keys.agentPublicKey}'`);
    expect(r.out).toContain(
      `probarion ledger set-key --vault ${VAULT} --pk '${keys.ledgerPublicKey}'`,
    );
    expect(r.out).toContain("probarion-mcp status");
    expect(r.out).toContain(`Give the MCP client only PROBARION_VAULT_ID=${VAULT}:`);
    expect(r.out).toContain(`Back up the folder ${join(home, ".probarion", VAULT)}`);
    expect(r.out).toContain("ledger.jsonl, the only copy of the agent's signed record");
    expect(r.err).toBe(""); // linux, and the temp home is in no git work tree
  });

  it("leaves an existing keys file as it is and prints the same public keys again", async () => {
    const home = tempDir("probarion-init-home-");
    const first = await init(["--vault", VAULT], { home });
    const path = join(home, ".probarion", VAULT, "keys.json");
    const before = readFileSync(path, "utf8");
    const second = await init([`--vault=${VAULT}`], { home });
    expect(second.code).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);
    const keys = keysOf(path);
    expect(second.out).toContain(`The keys file ${path} is there already and was not changed.`);
    for (const line of [
      `agent public key:  ${keys.agentPublicKey}`,
      `ledger public key: ${keys.ledgerPublicKey}`,
    ]) {
      expect(first.out).toContain(line);
      expect(second.out).toContain(line);
    }
    for (const text of [second.out, second.err])
      expectNoSecret(text, [keys.agentKey, keys.ledgerKey]);
  });

  it("refuses an existing file that is not a valid keys file for this vault, and leaves it", async () => {
    const home = tempDir("probarion-init-home-");
    const dir = join(home, ".probarion", VAULT);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "keys.json");
    const text = keysFileText("other.vaults.probarion.testnet", "testnet");
    writeFileSync(path, text);
    const r = await init(["--vault", VAULT], { home });
    expect(r.code).toBe(2);
    expect(r.err).toContain("vault is not acme.vaults.probarion.testnet");
    expect(r.err).toContain("init does not replace a keys file");
    expect(r.out).toBe("");
    expect(readFileSync(path, "utf8")).toBe(text);
    const secrets = JSON.parse(text) as {
      agent: { secret_key: string };
      ledger: { secret_key: string };
    };
    expectNoSecret(r.err, [secrets.agent.secret_key, secrets.ledger.secret_key]);
  });

  it("on mainnet names the console's Agent (MCP) tab without a URL, and writes a mainnet file", async () => {
    const home = tempDir("probarion-init-home-");
    const r = await init(["--vault", MAINNET_VAULT], { home });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`vault ${MAINNET_VAULT} on mainnet`);
    expect(r.out).toContain(
      "the Agent (MCP) tab of the vault's console, on the Probarion site that serves mainnet",
    );
    expect(r.out).not.toMatch(/https?:\/\//);
    const keys = keysOf(
      join(home, ".probarion", MAINNET_VAULT, "keys.json"),
      MAINNET_VAULT,
      "mainnet",
    );
    expectNoSecret(r.out, [keys.agentKey, keys.ledgerKey]);
  });

  it("writes --keys-file where it says, relative to the working folder, and names it for the client", async () => {
    const home = tempDir("probarion-init-home-");
    const cwd = tempDir("probarion-init-cwd-");
    const r = await init(["--vault", VAULT, "--keys-file", "secrets/acme.json"], { home, cwd });
    expect(r.code).toBe(0);
    const path = join(cwd, "secrets", "acme.json");
    const keys = keysOf(path);
    expect(r.out).toContain(`Wrote the keys file ${path}`);
    expect(r.out).toContain(`PROBARION_VAULT_ID=${VAULT} and PROBARION_KEYS_FILE=${path}`);
    // The ledger stays in its default folder, so both are named for the back-up.
    expect(r.out).toContain(
      `Back up the keys file and the folder ${join(home, ".probarion", VAULT)}`,
    );
    expectNoSecret(r.out, [keys.agentKey, keys.ledgerKey]);
  });

  it("warns on Windows that mode bits do not apply, with forward slashes in the paths it prints", async () => {
    const home = tempDir("probarion-init-home-");
    const r = await init(["--vault", VAULT], { home, platform: "win32" });
    expect(r.code).toBe(0);
    expect(r.err).toContain(
      "warning: on Windows, file permissions are not restricted by mode bits:",
    );
    expect(r.err).toContain("Keep it in a folder only you can read.");
    expect(r.out).not.toContain("(mode 0600)");
    expect(r.out).not.toMatch(/keys file [^\n]*\\/);
  });

  it("warns when the keys file is inside a git work tree", async () => {
    const repo = tempDir("probarion-init-repo-");
    mkdirSync(join(repo, ".git"));
    const r = await init(["--vault", VAULT, "--keys-file", join(repo, "config", "keys.json")]);
    expect(r.code).toBe(0);
    expect(r.err).toContain(
      "warning: this file is inside a git repository: make sure it is ignored and not tracked (git check-ignore -v",
    );
  });

  it("mentions an existing ledger file, which another ledger key signed", async () => {
    const home = tempDir("probarion-init-home-");
    mkdirSync(join(home, ".probarion", VAULT), { recursive: true });
    writeFileSync(join(home, ".probarion", VAULT, "ledger.jsonl"), "");
    const r = await init(["--vault", VAULT], { home });
    expect(r.code).toBe(0);
    expect(r.out).toContain("exists already, signed with another ledger key");
  });

  it("refuses a missing or bad vault id, a path-like one included, and writes nothing", async () => {
    for (const args of [
      [],
      ["--vault"],
      ["--vault", "--keys-file"],
      ["--vault", "../escape.testnet"],
      ["--vault", "a/b.testnet"],
      ["--vault", "a\\b.testnet"],
      ["--vault", "Acme.testnet"],
      ["--vault", "acme..testnet"],
      ["--vault", "acme.vaults.probarion"],
      ["--vault", VAULT, "--keys-file", ""],
      ["--vault", VAULT, "--extra"],
    ]) {
      const home = tempDir("probarion-init-home-");
      const r = await init(args, { home });
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.out, args.join(" ")).toBe("");
      expect(existsSync(join(home, ".probarion")), args.join(" ")).toBe(false);
    }
    const bad = await init(["--vault", "acme.vaults.probarion.testnet"], {
      env: { NEAR_NETWORK: "mainnet" },
    });
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("--vault looks like a testnet account but NEAR_NETWORK is mainnet");
  });

  it("prints its help, and is reached through the binary's arguments", async () => {
    expect((await init(["--help"])).out).toBe(INIT_HELP);
    const out = capture();
    const err = capture();
    const home = tempDir("probarion-init-home-");
    const code = await runCommand(["init", "--vault", VAULT], {
      env: {},
      out: out.stream,
      err: err.stream,
      home,
    });
    expect(code).toBe(0);
    const keys = keysOf(join(home, ".probarion", VAULT, "keys.json"));
    expect(out.text()).toContain(keys.agentPublicKey);
    expectNoSecret(out.text() + err.text(), [keys.agentKey, keys.ledgerKey]);
  });
});
