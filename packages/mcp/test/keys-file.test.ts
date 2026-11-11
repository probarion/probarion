// The keys file: written once, owner-only, and checked field by field on the way in, with no value of it in any
// message.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publicKeyFromSecret } from "@probarion/core";
import { describe, expect, it } from "vitest";
import {
  defaultKeysPath,
  foldersToSync,
  KEYS_FILE_FORMAT,
  KeysFileWriteError,
  parseKeysFile,
  readKeysFileFromDisk,
  writeNewKeysFile,
} from "../src/keys-file.js";
import { AGENT, expectNoSecret, keysFileText, LEDGER, OTHER, tempDir } from "./keys-helpers.js";

const VAULT = "acme.vaults.probarion.testnet";
const NOW = new Date("2026-11-11T08:00:00.000Z");
const EXPECTED = { vault: VAULT, network: "testnet" } as const;
const SECRETS = [AGENT.secretKey, LEDGER.secretKey, OTHER.secretKey];

/** The problems of a text that must not pass, each checked for a secret. */
function problemsOf(text: string): string[] {
  const r = parseKeysFile(text, "/keys/k.json", EXPECTED);
  expect(r.ok, text.slice(0, 80)).toBe(false);
  const problems = r.ok ? [] : r.problems;
  expect(problems.length).toBeGreaterThan(0);
  for (const p of problems) {
    expect(p).toContain("keys file /keys/k.json");
    expectNoSecret(p, SECRETS, p);
  }
  return problems;
}

describe("the keys file", () => {
  it("round-trips: init's file reads back as the same two keys, each its own public half", () => {
    const path = join(tempDir("probarion-keys-"), "nested", VAULT, "keys.json");
    const written = writeNewKeysFile(path, { vault: VAULT, network: "testnet", now: NOW });
    expect(written.status).toBe("created");
    if (written.status !== "created") return;
    const text = readKeysFileFromDisk(path);
    expect(text).not.toBeNull();
    const parsed = parseKeysFile(text ?? "", path, EXPECTED);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.keys.agentPublicKey).toBe(written.agentPublicKey);
    expect(parsed.keys.ledgerPublicKey).toBe(written.ledgerPublicKey);
    expect(publicKeyFromSecret(parsed.keys.agentKey)).toBe(written.agentPublicKey);
    expect(publicKeyFromSecret(parsed.keys.ledgerKey)).toBe(written.ledgerPublicKey);
    expect(written.agentPublicKey).not.toBe(written.ledgerPublicKey);
    const json = JSON.parse(text ?? "") as Record<string, unknown>;
    expect(json).toMatchObject({
      format: KEYS_FILE_FORMAT,
      vault: VAULT,
      network: "testnet",
      created_at: NOW.toISOString(),
    });
    // What comes back from the write holds no secret.
    expectNoSecret(JSON.stringify(written), [parsed.keys.agentKey, parsed.keys.ledgerKey]);
  });

  it("is written with 'wx': a second write leaves the first file as it is", () => {
    const path = join(tempDir("probarion-keys-"), "keys.json");
    expect(writeNewKeysFile(path, { vault: VAULT, network: "testnet", now: NOW }).status).toBe(
      "created",
    );
    const before = readFileSync(path, "utf8");
    expect(writeNewKeysFile(path, { vault: VAULT, network: "testnet", now: NOW })).toEqual({
      status: "exists",
    });
    expect(readFileSync(path, "utf8")).toBe(before);
    // A hand-made file at the path is not replaced either.
    const other = join(tempDir("probarion-keys-"), "keys.json");
    writeFileSync(other, "not mine to replace");
    expect(writeNewKeysFile(other, { vault: VAULT, network: "testnet", now: NOW }).status).toBe(
      "exists",
    );
    expect(readFileSync(other, "utf8")).toBe("not mine to replace");
  });

  // Windows does not enforce POSIX mode bits: a file there gets its folder's permissions, which init warns about.
  it.skipIf(process.platform === "win32")(
    "is mode 0600 in a folder it makes 0700 (POSIX only: Windows does not enforce mode bits)",
    () => {
      const dir = join(tempDir("probarion-keys-"), "made-by-init");
      const path = join(dir, "keys.json");
      writeNewKeysFile(path, { vault: VAULT, network: "testnet", now: NOW });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    },
  );

  it("syncs the folder of a new file, and each folder made for it, outside Windows", () => {
    const base = tempDir("probarion-keys-");
    const path = join(base, ".probarion", VAULT, "keys.json");
    const synced: string[] = [];
    const opts = { vault: VAULT, network: "testnet" as const, now: NOW };
    writeNewKeysFile(path, { ...opts, platform: "linux", syncFolder: (f) => synced.push(f) });
    // Both folders were made for it: the vault's, .probarion, and the folder that now holds .probarion.
    expect(synced).toEqual([join(base, ".probarion", VAULT), join(base, ".probarion"), base]);
    // A second file in a folder that exists: only that folder.
    const second = join(base, ".probarion", VAULT, "other.json");
    synced.length = 0;
    writeNewKeysFile(second, { ...opts, platform: "linux", syncFolder: (f) => synced.push(f) });
    expect(synced).toEqual([join(base, ".probarion", VAULT)]);
    // Windows: none, as Node cannot sync a folder there. A file already there: none, nothing was written.
    synced.length = 0;
    writeNewKeysFile(join(base, "win.json"), {
      ...opts,
      platform: "win32",
      syncFolder: (f) => synced.push(f),
    });
    writeNewKeysFile(second, { ...opts, platform: "linux", syncFolder: (f) => synced.push(f) });
    expect(synced).toEqual([]);
    // The real folder sync runs on this machine without failing the write, whatever its file system allows.
    expect(writeNewKeysFile(join(base, "a", "b", "keys.json"), opts).status).toBe("created");
  });

  it("lists the folders a new file adds an entry to", () => {
    expect(foldersToSync(join("/h", "v", "k.json"), undefined)).toEqual([join("/h", "v")]);
    expect(foldersToSync(join("/h", "p", "v", "k.json"), join("/h", "p"))).toEqual([
      join("/h", "p", "v"),
      join("/h", "p"),
      join("/h"),
    ]);
  });

  it("names the path when it cannot be written, and nothing else", () => {
    const dir = tempDir("probarion-keys-");
    const blocker = join(dir, "a-file");
    writeFileSync(blocker, "");
    let message = "";
    try {
      writeNewKeysFile(join(blocker, "keys.json"), { vault: VAULT, network: "testnet", now: NOW });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(KeysFileWriteError);
      message = (e as Error).message;
    }
    expect(message).toContain("could not create the keys file");
    expect(message).toContain(join(blocker, "keys.json"));
    expectNoSecret(message, SECRETS);
  });

  it("reads a missing file as null and throws for a folder", () => {
    const dir = tempDir("probarion-keys-");
    expect(readKeysFileFromDisk(join(dir, "none.json"))).toBeNull();
    expect(readKeysFileFromDisk(join(dir, "none", "keys.json"))).toBeNull();
    mkdirSync(join(dir, "folder.json"));
    expect(() => readKeysFileFromDisk(join(dir, "folder.json"))).toThrow();
  });

  it("puts the default file in the vault's folder under ~/.probarion", () => {
    expect(defaultKeysPath("/home/pilot", VAULT)).toBe(
      join("/home/pilot", ".probarion", VAULT, "keys.json"),
    );
  });

  it("accepts a file an editor saved with a byte order mark", () => {
    const bom = String.fromCharCode(0xfeff);
    expect(parseKeysFile(`${bom}${keysFileText(VAULT, "testnet")}`, "/k", EXPECTED).ok).toBe(true);
  });

  it("refuses text that is not JSON, without the parser's message (it quotes the text)", () => {
    // Cut off inside the agent's secret key: the parser's own message would quote the text around it.
    const text = keysFileText(VAULT, "testnet");
    const cut = text.slice(0, text.indexOf(AGENT.secretKey) + 40);
    expect(problemsOf(cut)).toEqual(["keys file /keys/k.json is not valid JSON"]);
    expect(problemsOf(`${AGENT.secretKey}`)).toEqual(["keys file /keys/k.json is not valid JSON"]);
    expect(problemsOf("")).toEqual(["keys file /keys/k.json is not valid JSON"]);
  });

  it("refuses a file far larger than a keys file", () => {
    expect(problemsOf(" ".repeat(70_000))[0]).toContain("is too large to be a keys file");
  });

  it("refuses another format, or none", () => {
    for (const text of [
      keysFileText(VAULT, "testnet", { format: "probarion-mcp-keys/2" }),
      keysFileText(VAULT, "testnet", { format: undefined }),
      keysFileText(VAULT, "testnet", { format: AGENT.secretKey }),
      "[]",
      "null",
      JSON.stringify(AGENT.secretKey),
    ]) {
      expect(problemsOf(text)[0]).toContain(`format must be "${KEYS_FILE_FORMAT}"`);
    }
  });

  it("refuses a file for another vault or another network, naming the field", () => {
    expect(problemsOf(keysFileText("other.vaults.probarion.testnet", "testnet"))).toEqual([
      `keys file /keys/k.json: vault is not ${VAULT}, the vault this server is set up for`,
    ]);
    expect(problemsOf(keysFileText(VAULT, "mainnet"))).toEqual([
      "keys file /keys/k.json: network is not testnet, the vault's network",
    ]);
    // A secret pasted into the wrong field is not echoed.
    const p = problemsOf(
      keysFileText(VAULT, "testnet", { vault: AGENT.secretKey, network: LEDGER.secretKey }),
    );
    expect(p.join("\n")).toContain("vault is not");
    expect(p.join("\n")).toContain("network is not");
  });

  it("refuses a missing or malformed key pair, naming the role and the field", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ agent: undefined }, "agent must be an object with public_key and secret_key"],
      [{ ledger: "ed25519:x" }, "ledger must be an object with public_key and secret_key"],
      [{ agent: { public_key: AGENT.publicKey } }, "agent.secret_key must be a string"],
      [{ agent: { secret_key: AGENT.secretKey } }, "agent.public_key must be a string"],
      [
        { ledger: { public_key: LEDGER.publicKey, secret_key: 42 } },
        "ledger.secret_key must be a string",
      ],
      [
        { agent: { public_key: AGENT.publicKey, secret_key: "ed25519:not-base58-0OIl" } },
        "agent.secret_key is not an ed25519 secret key",
      ],
      [
        // A public key pasted as the secret: 32 bytes read as a seed, whose public key is another one.
        { agent: { public_key: AGENT.publicKey, secret_key: AGENT.publicKey } },
        "agent.public_key is not the public half of agent.secret_key",
      ],
      [
        { agent: { public_key: AGENT.publicKey, secret_key: `ed25519:${"1".repeat(40)}` } },
        "agent.secret_key is not an ed25519 secret key",
      ],
      [
        // A real secret key whose stated public key is another key's.
        { agent: { public_key: OTHER.publicKey, secret_key: AGENT.secretKey } },
        "agent.public_key is not the public half of agent.secret_key",
      ],
      [
        // A secret key whose 64 bytes do not match: its seed's public key is not its second half.
        {
          ledger: {
            public_key: LEDGER.publicKey,
            secret_key: `${LEDGER.secretKey.slice(0, -4)}${OTHER.secretKey.slice(-4)}`,
          },
        },
        "ledger.secret_key is not an ed25519 secret key",
      ],
    ];
    for (const [over, want] of cases) {
      const problems = problemsOf(keysFileText(VAULT, "testnet", over));
      expect(problems.join("\n"), want).toContain(want);
    }
  });

  it("refuses one key in both roles", () => {
    const text = keysFileText(VAULT, "testnet", {}, AGENT, AGENT);
    expect(problemsOf(text)).toEqual([
      "keys file /keys/k.json: agent and ledger hold the same key; the vault takes a key as one of the two, not both",
    ]);
  });

  it("names every problem of a file at once", () => {
    const problems = problemsOf(
      keysFileText("other.testnet", "mainnet", {
        agent: { public_key: OTHER.publicKey, secret_key: AGENT.secretKey },
        ledger: null,
      }),
    );
    expect(problems).toHaveLength(4);
  });
});
