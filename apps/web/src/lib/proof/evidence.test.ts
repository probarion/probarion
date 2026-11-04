import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { txHash } from "../../../test/fixtures/proof";
import { evidenceFor, ProofEvidenceError, parseProofEvidence } from "./evidence";

const H1 = "1".repeat(64);
const H2 = "ab".repeat(32);
const FILE = fileURLToPath(new URL("../../../content/proof-evidence.json", import.meta.url));

describe("content/proof-evidence.json (R5)", () => {
  it("is committed as {} until mainnet v0 exists, and parses", () => {
    const raw: unknown = JSON.parse(readFileSync(FILE, "utf8"));
    expect(raw).toEqual({});
    expect(parseProofEvidence(raw).size).toBe(0);
  });

  it("reads hashes and burn tx hints per <network>:<vault>", () => {
    const parsed = parseProofEvidence({
      "mainnet:v0.probarion.near": {
        preLedgerDecisionHashes: [H1, H2],
        burnTxHints: {
          "3": [txHash(1), { hash: txHash(2), signer: "cfo.near" }, { hash: txHash(3) }],
        },
      },
      "testnet:v0.probarion.testnet": { burnTxHints: {} },
    });
    const v0 = parsed.get("mainnet:v0.probarion.near");
    expect(v0?.preLedgerDecisionHashes).toEqual([H1, H2]);
    expect(v0?.burnTxHints).toEqual(
      new Map([
        [3, [{ hash: txHash(1) }, { hash: txHash(2), signer: "cfo.near" }, { hash: txHash(3) }]],
      ]),
    );
    expect(parsed.get("testnet:v0.probarion.testnet")).toEqual({
      preLedgerDecisionHashes: [],
      burnTxHints: new Map(),
    });
  });

  it("gives a vault only its own entry, matched on network and vault", () => {
    const raw = { "mainnet:v0.probarion.near": { preLedgerDecisionHashes: [H1] } };
    expect(evidenceFor(raw, "mainnet", "v0.probarion.near").preLedgerDecisionHashes).toEqual([H1]);
    for (const [network, vault] of [
      ["testnet", "v0.probarion.near"],
      ["mainnet", "v1.probarion.near"],
      ["mainnet", "probarion.near"],
    ] as const) {
      expect(evidenceFor(raw, network, vault), `${network}:${vault}`).toEqual({
        preLedgerDecisionHashes: [],
        burnTxHints: new Map(),
      });
    }
  });

  it("fails closed on a malformed file: every problem is a ProofEvidenceError", () => {
    const bad: [string, unknown][] = [
      ["not an object", []],
      ["null", null],
      ["a string", "{}"],
      ["a key with no network", { "v0.probarion.near": {} }],
      ["a key with an unknown network", { "betanet:v0.probarion.near": {} }],
      ["a key whose vault is not an account id", { "mainnet:V0 Probarion": {} }],
      ["an entry that is not an object", { "mainnet:v0.probarion.near": [] }],
      ["an unknown field", { "mainnet:v0.probarion.near": { evidenceDir: "docs/evidence" } }],
      [
        "hashes that are not a list",
        { "mainnet:v0.probarion.near": { preLedgerDecisionHashes: H1 } },
      ],
      [
        "an upper-case hash",
        {
          "mainnet:v0.probarion.near": {
            preLedgerDecisionHashes: [H1.toUpperCase().replace(/1/g, "A")],
          },
        },
      ],
      ["a short hash", { "mainnet:v0.probarion.near": { preLedgerDecisionHashes: ["ab"] } }],
      [
        "a hash that is not text",
        { "mainnet:v0.probarion.near": { preLedgerDecisionHashes: [1] } },
      ],
      ["hints that are a list", { "mainnet:v0.probarion.near": { burnTxHints: [txHash(1)] } }],
      [
        "a spend id that is not a number",
        { "mainnet:v0.probarion.near": { burnTxHints: { x: [txHash(1)] } } },
      ],
      [
        "a spend id with a sign",
        { "mainnet:v0.probarion.near": { burnTxHints: { "-1": [txHash(1)] } } },
      ],
      [
        "a spend id with a leading zero",
        { "mainnet:v0.probarion.near": { burnTxHints: { "01": [txHash(1)] } } },
      ],
      [
        "a spend id past 2^53",
        { "mainnet:v0.probarion.near": { burnTxHints: { "9007199254740993": [txHash(1)] } } },
      ],
      [
        "a hint list that is not a list",
        { "mainnet:v0.probarion.near": { burnTxHints: { "1": txHash(1) } } },
      ],
      ["a malformed tx hash", { "mainnet:v0.probarion.near": { burnTxHints: { "1": ["PAYTX"] } } }],
      [
        "a malformed tx hash in an object",
        { "mainnet:v0.probarion.near": { burnTxHints: { "1": [{ hash: "x" }] } } },
      ],
      [
        "a signer that is not an account id",
        {
          "mainnet:v0.probarion.near": {
            burnTxHints: { "1": [{ hash: txHash(1), signer: "Bad Signer" }] },
          },
        },
      ],
      [
        "an unknown hint field",
        { "mainnet:v0.probarion.near": { burnTxHints: { "1": [{ hash: txHash(1), memo: "x" }] } } },
      ],
      ["a hint that is a number", { "mainnet:v0.probarion.near": { burnTxHints: { "1": [7] } } }],
    ];
    for (const [why, raw] of bad) {
      expect(() => parseProofEvidence(raw), why).toThrow(ProofEvidenceError);
      expect(() => evidenceFor(raw, "mainnet", "v0.probarion.near"), why).toThrow(
        ProofEvidenceError,
      );
    }
  });

  it("says which file is wrong, and never echoes a value it refused", () => {
    try {
      parseProofEvidence({
        "mainnet:v0.probarion.near": { preLedgerDecisionHashes: ["SECRET-ish"] },
      });
      expect.unreachable("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ProofEvidenceError);
      expect(String((e as Error).message)).toMatch(/^content\/proof-evidence\.json: /);
      expect(String((e as Error).message)).not.toContain("SECRET-ish");
    }
  });

  it("treats an absent field as none, and null or any other value as malformed", () => {
    expect(
      parseProofEvidence({ "mainnet:v0.probarion.near": {} }).get("mainnet:v0.probarion.near"),
    ).toEqual({
      preLedgerDecisionHashes: [],
      burnTxHints: new Map(),
    });
    for (const value of [null, false, 0, ""]) {
      for (const field of ["preLedgerDecisionHashes", "burnTxHints"]) {
        expect(
          () => parseProofEvidence({ "mainnet:v0.probarion.near": { [field]: value } }),
          `${field}: ${JSON.stringify(value)}`,
        ).toThrow(ProofEvidenceError);
      }
    }
  });

  it("names the place of each problem: the file, the key by position, the field and index", () => {
    const message = (raw: unknown): string => {
      try {
        parseProofEvidence(raw);
      } catch (e) {
        expect(e).toBeInstanceOf(ProofEvidenceError);
        expect((e as Error).name).toBe("ProofEvidenceError");
        return (e as Error).message;
      }
      return expect.unreachable("should throw");
    };
    expect(message([])).toBe("content/proof-evidence.json: the file is not a JSON object");
    expect(message({ "mainnet:v0.probarion.near": {}, "x:y": {} })).toBe(
      'content/proof-evidence.json: key 2 is not "<network>:<vault>" with network mainnet or testnet',
    );
    expect(message({ "mainnet:v0.probarion.near": { preLedgerDecisionHashes: [H1, "no"] } })).toBe(
      'content/proof-evidence.json: "mainnet:v0.probarion.near".preLedgerDecisionHashes[1] is not 64 lowercase hex digits',
    );
    expect(
      message({
        "testnet:v0.probarion.testnet": { burnTxHints: { "5": [txHash(1), { hash: "x" }] } },
      }),
    ).toBe(
      'content/proof-evidence.json: "testnet:v0.probarion.testnet".burnTxHints[5][1].hash is not a NEAR tx hash',
    );
  });
});
