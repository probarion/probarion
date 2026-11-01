import { existsSync, readFileSync } from "node:fs";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { renderCodeHashes, VAULT_CRATE, vaultHashesFrom } from "../scripts/sync-code-hashes.js";
import { KNOWN_VAULT_CODE_HASHES } from "../src/code-hashes.js";

const SOURCE = new URL("../../../contracts/code-hashes.json", import.meta.url);
const GENERATED = new URL("../src/code-hashes.ts", import.meta.url);
const TESTNET_DEPLOYMENT = new URL("../../../contracts/deployments/testnet.json", import.meta.url);

/** The two probarion-vault reproducible builds contracts/code-hashes.json records today (plan 02). */
const VAULT_HASHES = [
  "6tbERLAXWjaVKbSNzaivRDh7H9kCcjtmV1qGrgz7entR",
  "54Ne1r9g2Smf2Qtrt9VznmPpEAAHzvK4hbQSJ9voQmuD",
];
/** The two probarion-factory builds it records. A factory is not a vault: its hash must never be trusted as one. */
const FACTORY_HASHES = [
  "91MDwdWx56fYh6rN3VWvnuk5fEv2bc58cv9inGEfnevd",
  "FK6mMqUdieWmYyB9hqyJL23Aew9wWGSPustb6tUDtaQ6",
];

describe("KNOWN_VAULT_CODE_HASHES (generated from contracts/code-hashes.json)", () => {
  it("holds only base58 sha256 hashes", () => {
    for (const hash of KNOWN_VAULT_CODE_HASHES) expect(bs58.decode(hash)).toHaveLength(32);
  });

  it("extracts the vault hashes from plan 02's record format, once each, in record order", () => {
    const record = {
      entries: [
        { crate: "probarion-vault", code_hash: "A" },
        { crate: "probarion-factory", code_hash: "B" },
        { crate: "probarion-vault", code_hash: "A" },
        { crate: "probarion-vault", code_hash: "C" },
      ],
    };
    expect(vaultHashesFrom(record)).toEqual(["A", "C"]);
    expect(vaultHashesFrom({})).toEqual([]);
    expect(renderCodeHashes(["A"])).toContain(
      'export const KNOWN_VAULT_CODE_HASHES: readonly string[] = ["A"];',
    );
  });

  it("takes only crate === probarion-vault, and ignores every other crate and every unknown field", () => {
    expect(VAULT_CRATE).toBe("probarion-vault");
    const full = (crate: unknown, code_hash: unknown) => ({
      crate,
      version: "0.1.0",
      tree: "t",
      workspace: "w",
      lock: "l",
      commit: "c0ffee",
      code_hash,
      built_with: "cargo-near",
      recorded_at: "2026-11-01",
      something_new: { nested: true },
    });
    const record = {
      entries: [
        full("probarion-vault", "V1"),
        full("probarion-factory", "F1"),
        full("probarion-vault-extra", "X1"),
        full("Probarion-Vault", "X2"),
        full("probarion-vault ", "X3"),
        full(undefined, "X4"),
        full("probarion-vault", 7),
        full("probarion-vault", undefined),
        null,
        "probarion-vault",
        7,
        [],
        full("probarion-vault", "V2"),
      ],
    };
    expect(vaultHashesFrom(record)).toEqual(["V1", "V2"]);
    expect(vaultHashesFrom({ entries: "probarion-vault" })).toEqual([]);
    expect(vaultHashesFrom(null)).toEqual([]);
    expect(vaultHashesFrom(undefined)).toEqual([]);
    expect(vaultHashesFrom([])).toEqual([]);
  });

  it("renders deterministic output: one line when it fits in 100 columns, one hash per line when it does not", () => {
    const one = renderCodeHashes([]);
    expect(one).toContain("export const KNOWN_VAULT_CODE_HASHES: readonly string[] = [];");
    expect(renderCodeHashes(VAULT_HASHES)).toBe(renderCodeHashes(VAULT_HASHES));
    const rendered = renderCodeHashes(VAULT_HASHES);
    expect(rendered).toContain(
      `export const KNOWN_VAULT_CODE_HASHES: readonly string[] = [\n  "${VAULT_HASHES[0]}",\n  "${VAULT_HASHES[1]}",\n];\n`,
    );
    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered.includes("\r")).toBe(false);
  });

  it.skipIf(!existsSync(SOURCE))(
    "is in sync with contracts/code-hashes.json (run sync-code-hashes after every vault build)",
    () => {
      expect([...KNOWN_VAULT_CODE_HASHES]).toEqual(
        vaultHashesFrom(JSON.parse(readFileSync(SOURCE, "utf8"))),
      );
    },
  );

  it.skipIf(!existsSync(SOURCE))(
    "the committed src/code-hashes.ts is byte for byte what the script generates",
    () => {
      const expected = renderCodeHashes(vaultHashesFrom(JSON.parse(readFileSync(SOURCE, "utf8"))));
      expect(readFileSync(GENERATED, "utf8")).toBe(expected);
    },
  );

  it.skipIf(!existsSync(SOURCE))(
    "holds exactly the recorded probarion-vault builds and none of the probarion-factory builds",
    () => {
      // Pinned on purpose: adding a trusted vault build must be a deliberate edit of this list.
      expect([...KNOWN_VAULT_CODE_HASHES]).toEqual(VAULT_HASHES);
      for (const factory of FACTORY_HASHES) expect(KNOWN_VAULT_CODE_HASHES).not.toContain(factory);
      // and the same holds for whatever factory builds the record gains later
      const record = JSON.parse(readFileSync(SOURCE, "utf8")) as {
        entries: { crate: string; code_hash: string }[];
      };
      const factories = record.entries
        .filter((e) => e.crate === "probarion-factory")
        .map((e) => e.code_hash);
      expect(factories.length).toBeGreaterThan(0);
      for (const factory of factories) expect(KNOWN_VAULT_CODE_HASHES).not.toContain(factory);
      expect(factories).toEqual(expect.arrayContaining(FACTORY_HASHES));
    },
  );

  it.skipIf(!existsSync(TESTNET_DEPLOYMENT))(
    "contains the code hash recorded for the deployed testnet vault v0",
    () => {
      const deployment = JSON.parse(readFileSync(TESTNET_DEPLOYMENT, "utf8")) as {
        vault_v0: { code_hash: string };
      };
      expect(KNOWN_VAULT_CODE_HASHES).toContain(deployment.vault_v0.code_hash);
    },
  );
});
