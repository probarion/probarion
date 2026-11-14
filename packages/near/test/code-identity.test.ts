import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import type { KeyPolicy } from "../src/access-keys.js";
import {
  type AccountLockReport,
  accountLockReport,
  codeIdentityOf,
  matchRecordedBuild,
  normalizeCodeHash,
  type RecordedBuild,
  wasmCodeHash,
} from "../src/code-identity.js";
import { readFixture } from "./helpers/fixtures.js";

type Json = Record<string, unknown>;

interface KeysFixture {
  account_id: string;
  view_account: Json;
  view_access_key_list: { keys: Json[]; block_height: number; block_hash: string };
}

const V0 = "v0.probarion.near";
const mainnet = readFixture<KeysFixture>("keys/mainnet-v0.json");
const testnet = readFixture<KeysFixture>("keys/testnet-factory-vault.json");
/** The repository's build record file, read as a builder would pass it. */
const codeHashes = JSON.parse(
  readFileSync(new URL("../../../contracts/code-hashes.json", import.meta.url), "utf8"),
) as { entries: RecordedBuild[] };

/** The vault build both recorded accounts run (contracts/code-hashes.json, commit 64ac3c03). */
const VAULT_BUILD = "3cQXYDvfGLRMveCVAHmh1exiuZKDXWqD8cUhqdEs9MF1";
/** NEAR's code_hash of an account without code: 32 zero bytes in base58. */
const ZERO = "11111111111111111111111111111111";
const LEDGER_PK = "ed25519:RY7kjsaRStq4gt27RpNgErr9AjuKuZdzCXd6atSrzKK";
const AGENT_PK = "ed25519:GADeVCXtgcxS3E5JrcVpEWTuZiNMJ4gu17iyuEgyCycd";
/** A real public key in no recorded vault's list (the mainnet owner's, from the drill README). */
const OTHER_PK = "ed25519:4jHJSmeUGvpJzXDTUvBkKzGUgXMb3jMXmyKT44htnUxc";

const vaultPolicy = (vault: string, ledger?: string): KeyPolicy => ({
  rules: [
    { receiverId: vault, methods: ["spend"] },
    {
      receiverId: vault,
      methods: ["anchor"],
      ...(ledger === undefined ? {} : { publicKeys: [ledger] }),
    },
  ],
});

/** A view_account answer in nearcore's shape (fields as in the recorded fixture). */
function account(fields: Json): Json {
  return {
    amount: "1",
    block_hash: mainnet.view_account.block_hash,
    block_height: 1,
    locked: "0",
    storage_paid_at: 0,
    storage_usage: 100,
    ...fields,
  };
}

describe("codeIdentityOf", () => {
  it("reads the recorded mainnet and testnet vaults as their own code, the recorded vault build", () => {
    expect(codeIdentityOf(mainnet.view_account)).toEqual({ kind: "local", codeHash: VAULT_BUILD });
    expect(codeIdentityOf(testnet.view_account)).toEqual({ kind: "local", codeHash: VAULT_BUILD });
  });

  it("reads the NEP-591 shapes: none, global by hash, global by account", () => {
    // nearcore puts the all-zero code_hash next to a global contract; the field shapes follow the sdk's
    // ViewAccountResult doc and near-api-js 7.4.0 AccountView (global_contract_hash, global_contract_account_id).
    expect(codeIdentityOf(account({ code_hash: ZERO }))).toEqual({ kind: "none" });
    expect(codeIdentityOf(account({ code_hash: ZERO, global_contract_hash: null }))).toEqual({
      kind: "none",
    });
    expect(codeIdentityOf(account({ code_hash: ZERO, global_contract_hash: VAULT_BUILD }))).toEqual(
      {
        kind: "global_by_hash",
        codeHash: VAULT_BUILD,
      },
    );
    expect(
      codeIdentityOf(
        account({ code_hash: ZERO, global_contract_account_id: "vaults.probarion.near" }),
      ),
    ).toEqual({ kind: "global_by_account", publisher: "vaults.probarion.near" });
  });

  it("reads every other combination as malformed, without throwing", () => {
    const cases: [string, unknown][] = [
      ["null", null],
      ["a list", []],
      ["an error answer", { error: "account x does not exist while viewing" }],
      ["no code_hash", account({ code_hash: undefined })],
      ["a hex code_hash", account({ code_hash: "ab".repeat(32) })],
      ["a code_hash with an extra leading 1", account({ code_hash: `1${VAULT_BUILD}` })],
      ["a 31-byte code_hash", account({ code_hash: bs58.encode(new Uint8Array(31).fill(7)) })],
      [
        "both global fields",
        account({
          code_hash: ZERO,
          global_contract_hash: VAULT_BUILD,
          global_contract_account_id: "a.near",
        }),
      ],
      [
        "own code and a global hash",
        account({ code_hash: VAULT_BUILD, global_contract_hash: VAULT_BUILD }),
      ],
      [
        "own code and a global account",
        account({ code_hash: VAULT_BUILD, global_contract_account_id: "a.near" }),
      ],
      ["an all-zero global hash", account({ code_hash: ZERO, global_contract_hash: ZERO })],
      ["a global hash that is not a hash", account({ code_hash: ZERO, global_contract_hash: "x" })],
      [
        "a global account that is not an account id",
        account({ code_hash: ZERO, global_contract_account_id: "A B" }),
      ],
      [
        "a global account that is a number",
        account({ code_hash: ZERO, global_contract_account_id: 7 }),
      ],
    ];
    for (const [label, view] of cases) {
      const identity = codeIdentityOf(view);
      expect(identity.kind, label).toBe("malformed");
    }
  });
});

describe("normalizeCodeHash and wasmCodeHash", () => {
  it("normalizes base58 and hex (either case) to the same lowercase hex", () => {
    const hex = Buffer.from(bs58.decode(VAULT_BUILD)).toString("hex");
    expect(normalizeCodeHash(VAULT_BUILD)).toBe(hex);
    expect(normalizeCodeHash(hex.toUpperCase())).toBe(hex);
    expect(normalizeCodeHash(hex)).toBe(hex);
  });

  it("refuses what is not a 32-byte hash, and never throws", () => {
    for (const bad of [
      "",
      `0x${"ab".repeat(32)}`,
      "ab".repeat(31),
      `1${VAULT_BUILD}`,
      "not base58 0OIl",
    ]) {
      expect(normalizeCodeHash(bad), bad).toBeNull();
    }
    expect(normalizeCodeHash(7 as unknown as string)).toBeNull();
  });

  it("computes NEAR's code_hash of a wasm file: base58 of its sha256 (node:crypto as the oracle)", () => {
    const wasm = new TextEncoder().encode(
      "\0asm\u0001\0\0\0 a fixed byte string standing in for a contract",
    );
    const oracle = bs58.encode(createHash("sha256").update(wasm).digest());
    expect(wasmCodeHash(wasm)).toBe(oracle);
    // sha256 of no bytes, e3b0c442...b855, as a NEAR code hash.
    expect(normalizeCodeHash(wasmCodeHash(new Uint8Array()))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(() => wasmCodeHash("wasm" as unknown as Uint8Array)).toThrow(TypeError);
  });
});

describe("matchRecordedBuild", () => {
  it("matches the recorded vault code to its entry in contracts/code-hashes.json", () => {
    const match = matchRecordedBuild(codeIdentityOf(mainnet.view_account), codeHashes);
    expect(match.ok).toBe(true);
    if (match.ok) {
      expect(match.build).toMatchObject({
        crate: "probarion-vault",
        code_hash: VAULT_BUILD,
        commit: "64ac3c03547d59a1f563b5ddf5767c38ae781413",
      });
    }
    // A plain list works the same, and a hex spelling in the record matches the base58 one on chain.
    const hex = Buffer.from(bs58.decode(VAULT_BUILD)).toString("hex");
    expect(
      matchRecordedBuild({ kind: "global_by_hash", codeHash: VAULT_BUILD }, [{ code_hash: hex }])
        .ok,
    ).toBe(true);
  });

  it("does not match no code, code that follows a publisher, unrecorded code or a malformed identity", () => {
    const factoryOnly = codeHashes.entries.filter((e) => e.crate === "probarion-factory");
    const cases: [Parameters<typeof matchRecordedBuild>[0], string][] = [
      [{ kind: "none" }, "no_code"],
      [{ kind: "global_by_account", publisher: "vaults.probarion.near" }, "mutable_code"],
      [{ kind: "local", codeHash: VAULT_BUILD }, "not_recorded"],
      [{ kind: "malformed", problem: "x" }, "malformed"],
    ];
    for (const [identity, code] of cases) {
      const match = matchRecordedBuild(identity, factoryOnly);
      expect(match.ok ? "ok" : match.code, identity.kind).toBe(code);
    }
  });

  it("refuses a builds list or entry that does not read, and the all-zero hash", () => {
    const identity = codeIdentityOf(mainnet.view_account);
    const builds: unknown[] = [
      null,
      { entries: {} },
      [{ code_hash: "x" }],
      [{ crate: "probarion-vault" }],
      [{ code_hash: ZERO }],
      ["3cQX"],
    ];
    for (const bad of builds) {
      expect(
        () => matchRecordedBuild(identity, bad as RecordedBuild[]),
        JSON.stringify(bad),
      ).toThrow(TypeError);
    }
  });
});

/** The copy rules for printed text: no em or en dash, and none of these words. */
const BANNED = /[–—]|\b(first|only|never|unhackable|unbreakable|guaranteed)\b/i;

/** Control, format and separator code points: U+2028, U+2029 and U+0085 split a line, U+202A to U+202E reorder it. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function expectPrintable(report: AccountLockReport): void {
  for (const line of report.lines) {
    expect(line, line).not.toMatch(BANNED);
    expect(line, line).not.toMatch(UNPRINTABLE);
  }
  for (const finding of report.keys.findings) expect(finding.text).not.toMatch(BANNED);
  if (report.build !== null && !report.build.ok) expect(report.build.text).not.toMatch(BANNED);
}

describe("accountLockReport", () => {
  it("reports the recorded mainnet vault locked and ok: keys fit the vault policy, code is a recorded build", () => {
    const report = accountLockReport(V0, mainnet.view_account, mainnet.view_access_key_list, {
      policy: vaultPolicy(V0, LEDGER_PK),
      builds: codeHashes,
    });
    expect(report).toMatchObject({ accountId: V0, locked: true, ok: true });
    expect(report.keys.policyOk).toBe(true);
    expect(report.code).toEqual({ kind: "local", codeHash: VAULT_BUILD });
    expect(report.build).toMatchObject({ ok: true });
    expect(report.lines).toEqual([
      `Account ${V0} at block 224468063 (CyAZitvXhDBXcsxeog9xxrBMVfDWMuzMofgazV6CX94e): 2 access keys, none with full access.`,
      `Key ${LEDGER_PK}: function call on ${V0}, methods ["anchor"], an allowance of 0.2491886787336027 NEAR for gas.`,
      `Key ed25519:GADeVCXtgcxS3E5JrcVpEWTuZiNMJ4gu17iyuEgyCycd: function call on ${V0}, methods ["spend"], an allowance of 0.2458808163015667 NEAR for gas.`,
      `info: ${LEDGER_PK} calls the account's own contract, so what it can do is what that code lets the account itself do.`,
      "info: ed25519:GADeVCXtgcxS3E5JrcVpEWTuZiNMJ4gu17iyuEgyCycd calls the account's own contract, so what it can do is what that code lets the account itself do.",
      `Code: the account's own code, hash ${VAULT_BUILD}. A DeployContract action replaces it; that takes a full-access key or the contract itself.`,
      "Build: the code hash matches a recorded build: probarion-vault, 0.1.0, commit 64ac3c03547d59a1f563b5ddf5767c38ae781413, built with cargo-near 0.22.0 reproducible-wasm, sourcescan/cargo-near:0.22.0-rust-1.99.1.",
      "Function-call keys cannot attach a deposit, so they cannot call methods that need 1 yoctoNEAR, such as ft_transfer.",
      "With no full-access key, the keys change through the account's own code, so the code identity matters.",
      "This audit holds at block 224468063; a later block can differ.",
      "Verdict: ok, the account is locked.",
    ]);
    expectPrintable(report);
  });

  it("reports the recorded testnet factory vault, which has no access keys, locked and ok", () => {
    const vault = testnet.account_id;
    const report = accountLockReport(vault, testnet.view_account, testnet.view_access_key_list, {
      policy: vaultPolicy(vault),
      builds: codeHashes,
    });
    expect(report).toMatchObject({ locked: true, ok: true, build: { ok: true } });
    expect(report.lines[0]).toBe(
      `Account ${vault} at block 277612267 (ryto41RAby9twvAcukfVgGBYTvtUE7ssGDXmZPCAoqT): no access keys.`,
    );
    expect(report.lines).not.toContain(
      "Function-call keys cannot attach a deposit, so they cannot call methods that need 1 yoctoNEAR, such as ft_transfer.",
    );
    expectPrintable(report);
  });

  it("is not locked when the code follows a publisher account, even with every key in policy", () => {
    const view = account({ code_hash: ZERO, global_contract_account_id: "vaults.probarion.near" });
    const report = accountLockReport(V0, view, mainnet.view_access_key_list, {
      policy: vaultPolicy(V0, LEDGER_PK),
      builds: codeHashes,
    });
    expect(report).toMatchObject({
      locked: false,
      ok: false,
      build: { ok: false, code: "mutable_code" },
    });
    expect(report.lines.at(-1)).toBe(
      "Verdict: not ok, since the code follows vaults.probarion.near; the code is not a recorded build.",
    );
    expectPrintable(report);
  });

  it("separates locked from ok: unrecorded code, a key out of policy, a warning", () => {
    const unrecorded = accountLockReport(V0, mainnet.view_account, mainnet.view_access_key_list, {
      builds: codeHashes.entries.filter((e) => e.crate === "probarion-factory"),
    });
    expect(unrecorded).toMatchObject({ locked: true, ok: false, build: { code: "not_recorded" } });

    const list = structuredClone(mainnet.view_access_key_list);
    list.keys.push({
      access_key: {
        nonce: 1,
        permission: {
          FunctionCall: { allowance: null, method_names: [], receiver_id: "intents.near" },
        },
      },
      public_key: "ed25519:4jHJSmeUGvpJzXDTUvBkKzGUgXMb3jMXmyKT44htnUxc",
    });
    const warned = accountLockReport(V0, mainnet.view_account, list);
    expect(warned).toMatchObject({ locked: true, ok: true, build: null });
    expect(warned.lines.at(-1)).toBe("Verdict: ok, the account is locked, with 2 warnings.");
    const refused = accountLockReport(V0, mainnet.view_account, list, {
      policy: vaultPolicy(V0, LEDGER_PK),
    });
    expect(refused).toMatchObject({ locked: true, ok: false });
    expect(refused.lines.at(-1)).toBe("Verdict: not ok, since a key does not fit the policy.");
    for (const report of [unrecorded, warned, refused]) expectPrintable(report);
  });

  it("is not locked for a full-access key, an unreadable list or unreadable code, and says why", () => {
    const withFull = structuredClone(mainnet.view_access_key_list);
    withFull.keys.push({
      access_key: { nonce: 1, permission: "FullAccess" },
      public_key: "ed25519:4jHJSmeUGvpJzXDTUvBkKzGUgXMb3jMXmyKT44htnUxc",
    });
    const cases: [string, AccountLockReport, string][] = [
      [
        "full access",
        accountLockReport(V0, mainnet.view_account, withFull, { builds: codeHashes }),
        "Verdict: not ok, since 1 key acts as full access.",
      ],
      [
        "an unreadable list",
        accountLockReport(V0, mainnet.view_account, { keys: null }),
        "Verdict: not ok, since the key list could not be read.",
      ],
      [
        "unreadable code",
        accountLockReport(V0, { code_hash: "x" }, mainnet.view_access_key_list),
        "Verdict: not ok, since the code identity could not be read.",
      ],
      [
        "gas full access, unknown, no code",
        accountLockReport(
          V0,
          account({ code_hash: ZERO }),
          {
            keys: [
              {
                access_key: {
                  nonce: 1,
                  permission: {
                    GasKeyFullAccess: { balance: "1000000000000000000000000", num_nonces: 3 },
                  },
                },
                public_key: LEDGER_PK,
              },
              {
                access_key: { nonce: 1, permission: { Foo: {} } },
                public_key: "ed25519:4jHJSmeUGvpJzXDTUvBkKzGUgXMb3jMXmyKT44htnUxc",
              },
            ],
          },
          { builds: codeHashes },
        ),
        "Verdict: not ok, since 2 keys act as full access; the code is not a recorded build.",
      ],
    ];
    for (const [label, report, verdict] of cases) {
      expect(report.locked, label).toBe(false);
      expect(report.ok, label).toBe(false);
      expect(report.lines.at(-1), label).toBe(verdict);
      expectPrintable(report);
    }
  });

  it("names a key for every method of the account's own code in the verdict, unless the account has no code", () => {
    const list = structuredClone(mainnet.view_access_key_list);
    list.keys.push({
      access_key: {
        nonce: 1,
        permission: { FunctionCall: { allowance: "1000", method_names: [], receiver_id: V0 } },
      },
      public_key: OTHER_PK,
    });
    const report = accountLockReport(V0, mainnet.view_account, list, { builds: codeHashes });
    expect(report).toMatchObject({ locked: true, ok: true, build: { ok: true } });
    expect(report.lines.at(-1)).toBe(
      `Verdict: ok, the account is locked, with 2 warnings; the lock rests on the account's code, since key ${OTHER_PK} can call every method of it, #[private] methods included.`,
    );
    const globalByHash = accountLockReport(
      V0,
      account({ code_hash: ZERO, global_contract_hash: VAULT_BUILD }),
      list,
    );
    expect(globalByHash.lines.at(-1)).toBe(report.lines.at(-1));
    // With no code, a call to the account itself has nothing to run.
    const noCode = accountLockReport(V0, account({ code_hash: ZERO }), list);
    expect(noCode.lines.at(-1)).toBe("Verdict: ok, the account is locked, with 2 warnings.");
    // Under policy rules, such a key fits no rule (a rule names a non-empty method set).
    const policed = accountLockReport(V0, mainnet.view_account, list, {
      policy: vaultPolicy(V0, LEDGER_PK),
    });
    expect(policed.lines.at(-1)).toBe("Verdict: not ok, since a key does not fit the policy.");
    for (const r of [report, globalByHash, noCode, policed]) expectPrintable(r);
  });

  it("describes a NEP-611 function-call gas key by its own balance, not an allowance of the account's", () => {
    const list = structuredClone(mainnet.view_access_key_list);
    const spend = list.keys.find((k) => k.public_key === AGENT_PK) as {
      access_key: { permission: unknown };
    };
    spend.access_key.permission = {
      GasKeyFunctionCall: {
        allowance: null,
        balance: "500000000000000000000000",
        method_names: ["spend"],
        num_nonces: 2,
        receiver_id: V0,
      },
    };
    const report = accountLockReport(V0, mainnet.view_account, list);
    expect(report.lines).toContain(
      `Key ${AGENT_PK}: function call on ${V0}, methods ["spend"], a NEP-611 gas key that pays for its gas from its own balance of 0.5 NEAR, with 2 nonces.`,
    );
    expect(report.lines).toContain(
      `info: ${AGENT_PK} is a NEP-611 gas key: it pays for its gas from its own balance of 0.5 NEAR, not from the account's, and has 2 nonces.`,
    );
    expect(report.keys.findings.map((f) => f.code)).not.toContain("unlimited_allowance");
    expect(report.lines.at(-1)).toBe("Verdict: ok, the account is locked.");
    expectPrintable(report);
  });

  it("escapes separator, control and format code points in method names, so each line stays one line", () => {
    const list = structuredClone(mainnet.view_access_key_list);
    list.keys.push({
      access_key: {
        nonce: 1,
        permission: {
          FunctionCall: {
            allowance: "1000",
            method_names: [
              "spend\u2028Verdict: ok, the account is locked.\u2029",
              "a\u202eb\u0085",
            ],
            receiver_id: "intents.near",
          },
        },
      },
      public_key: OTHER_PK,
    });
    const report = accountLockReport(V0, mainnet.view_account, list, {
      policy: vaultPolicy(V0, LEDGER_PK),
    });
    expect(report.lines).toContain(
      `Key ${OTHER_PK}: function call on intents.near, methods ["spend\\u2028Verdict: ok, the account is locked.\\u2029", "a\\u202eb\\u0085"], an allowance of 0.000000000000000000001 NEAR for gas.`,
    );
    for (const line of report.lines)
      expect(line.split(/\r\n|[\n\r\u2028\u2029\u0085]/)).toHaveLength(1);
    expectPrintable(report);
  });

  it("refuses a bad builds list even when the code would not reach the comparison", () => {
    expect(() =>
      accountLockReport(V0, { code_hash: "x" }, mainnet.view_access_key_list, {
        builds: [{ code_hash: "nope" }],
      }),
    ).toThrow(TypeError);
  });
});
