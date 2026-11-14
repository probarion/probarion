// Agreement between core's check f (`checkVaultLocked`) and @probarion/near's account lock audit, on the verifier
// snapshots recorded in docs/evidence. Check f reads the keys as the SDK folds them (`toAccessKeyInfo`); the audit
// reads the raw `view_access_key_list` shape. Each case starts from one raw list, folds it with the SDK for check f,
// and passes it unfolded to the audit, so both judge the same keys.
//
// Known gap, pinned below: the SDK folds a scoped NEP-611 gas key into a plain function-call key, so check f accepts
// a gas key with the right scope; the audit keeps the variant and refuses it unless a rule sets allowGasKey.
//
// Needs the built packages: pnpm --filter @probarion/core build, --filter @probarion/sdk build and
// --filter @probarion/near build.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkVaultLocked, KNOWN_VAULT_CODE_HASHES, type Snapshot } from "@probarion/core";
import { accountLockReport, type KeyPolicy } from "@probarion/near";
import { toAccessKeyInfo } from "@probarion/sdk";
import { describe, expect, it } from "vitest";

type RawKey = { public_key: string; access_key: { nonce: number; permission: unknown } };

const EVIDENCE = fileURLToPath(new URL("../../../docs/evidence/", import.meta.url));
/** A real public key that is in no recorded vault's key list (the mainnet owner's, from the drill README). */
const OTHER_PK = "ed25519:4jHJSmeUGvpJzXDTUvBkKzGUgXMb3jMXmyKT44htnUxc";
/** A recorded factory build (contracts/code-hashes.json): a real code hash that check f does not trust for a vault. */
const FACTORY_BUILD = "FK6mMqUdieWmYyB9hqyJL23Aew9wWGSPustb6tUDtaQ6";

function snapshotFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const path = join(dir, item.name);
    if (item.isDirectory()) return snapshotFiles(path);
    return /^snapshot-.*\.json$/.test(item.name) ? [path] : [];
  });
}

const snapshots = snapshotFiles(EVIDENCE)
  .sort()
  .map((path) => ({
    name: path.slice(EVIDENCE.length).replaceAll("\\", "/"),
    snapshot: JSON.parse(readFileSync(path, "utf8")) as Snapshot,
  }));

/** The SDK-folded key back in the RPC shape (FullAccess, or the FunctionCall wrapper around its fields). */
function rawKey(key: Snapshot["chain"]["access_keys"][number]): RawKey {
  const permission =
    key.permission === "FullAccess"
      ? "FullAccess"
      : {
          FunctionCall: {
            allowance: key.permission.allowance,
            method_names: [...key.permission.method_names],
            receiver_id: key.permission.receiver_id,
          },
        };
  return { public_key: key.public_key, access_key: { nonce: 0, permission } };
}

const functionCall = (
  receiverId: string,
  methods: string[],
  allowance: string | null = "1000",
) => ({
  FunctionCall: { allowance, method_names: methods, receiver_id: receiverId },
});

/** The vault's key shapes as an audit policy: spend for agents, anchor for the current ledger key alone. */
function vaultPolicy(s: Snapshot, allowGasKey = false): KeyPolicy {
  const ledger = s.chain.config.ledger_key;
  return {
    rules: [
      { receiverId: s.vault, methods: ["spend"], allowUnlimitedAllowance: true, allowGasKey },
      ...(typeof ledger === "string"
        ? [
            {
              receiverId: s.vault,
              methods: ["anchor"],
              publicKeys: [ledger],
              allowUnlimitedAllowance: true,
              allowGasKey,
            },
          ]
        : []),
    ],
  };
}

/** Check f's verdict and the audit's on one raw key list (and, optionally, another code hash). */
function verdicts(
  s: Snapshot,
  raw: RawKey[],
  opts: { codeHash?: string; allowGasKey?: boolean } = {},
): { checkF: boolean; audit: boolean } {
  const codeHash = opts.codeHash ?? s.chain.code_hash;
  const folded: Snapshot = {
    ...s,
    chain: { ...s.chain, access_keys: raw.map((key) => toAccessKeyInfo(key)), code_hash: codeHash },
  };
  const report = accountLockReport(
    s.vault,
    { amount: "0", locked: "0", code_hash: codeHash, storage_usage: 0 },
    { keys: raw },
    {
      policy: vaultPolicy(s, opts.allowGasKey),
      builds: KNOWN_VAULT_CODE_HASHES.map((hash) => ({ code_hash: hash })),
    },
  );
  return { checkF: checkVaultLocked(folded).status === "pass", audit: report.ok };
}

const keyWith = (raw: RawKey[], method: string): RawKey | undefined =>
  raw.find((k) => {
    const p = k.access_key.permission as { FunctionCall?: { method_names: string[] } };
    return p.FunctionCall?.method_names.length === 1 && p.FunctionCall.method_names[0] === method;
  });

/** Each mutation: what it does to the raw list, and whether both verdicts pass after it. */
const MUTATIONS: { label: string; mutate: (raw: RawKey[], s: Snapshot) => void; pass: boolean }[] =
  [
    { label: "as recorded", mutate: () => {}, pass: true },
    {
      label: "a FullAccess key added",
      mutate: (raw) =>
        raw.push({ public_key: OTHER_PK, access_key: { nonce: 0, permission: "FullAccess" } }),
      pass: false,
    },
    {
      label: "the spend key can also anchor (wrong methods)",
      mutate: (raw, s) => {
        const key = keyWith(raw, "spend") as RawKey;
        key.access_key.permission = functionCall(s.vault, ["spend", "anchor"]);
      },
      pass: false,
    },
    {
      label: "the spend key can call any method ([])",
      mutate: (raw, s) => {
        const key = keyWith(raw, "spend") as RawKey;
        key.access_key.permission = functionCall(s.vault, []);
      },
      pass: false,
    },
    {
      label: "the spend key on another receiver",
      mutate: (raw) => {
        const key = keyWith(raw, "spend") as RawKey;
        key.access_key.permission = functionCall("usdc.probarion.near", ["spend"]);
      },
      pass: false,
    },
    {
      label: "an anchor key that is not the ledger key",
      mutate: (raw, s) => {
        const anchor = keyWith(raw, "anchor");
        if (anchor !== undefined) anchor.public_key = OTHER_PK;
        else
          raw.push({
            public_key: OTHER_PK,
            access_key: { nonce: 0, permission: functionCall(s.vault, ["anchor"]) },
          });
      },
      pass: false,
    },
    {
      label: "a GasKeyFullAccess key added (shape from near-api-js 7.4.0 types)",
      mutate: (raw) =>
        raw.push({
          public_key: OTHER_PK,
          access_key: {
            nonce: 0,
            permission: { GasKeyFullAccess: { balance: "1", num_nonces: 1 } },
          },
        }),
      pass: false,
    },
    {
      label: "the spend key with no allowance limit",
      mutate: (raw, s) => {
        const key = keyWith(raw, "spend") as RawKey;
        key.access_key.permission = functionCall(s.vault, ["spend"], null);
      },
      pass: true,
    },
    {
      label: "a second agent key added",
      mutate: (raw, s) =>
        raw.push({
          public_key: OTHER_PK,
          access_key: { nonce: 0, permission: functionCall(s.vault, ["spend"]) },
        }),
      pass: true,
    },
    { label: "every key removed", mutate: (raw) => raw.splice(0), pass: true },
  ];

describe("near lock audit agrees with check f on the recorded snapshots", () => {
  it("finds the recorded vault snapshots, each passing check f as recorded", () => {
    expect(snapshots.length).toBeGreaterThanOrEqual(13);
    for (const { name, snapshot } of snapshots) {
      expect(checkVaultLocked(snapshot).status, name).toBe("pass");
    }
  });

  it("rebuilds each snapshot's keys into the RPC shape exactly (the SDK folds them back to the recorded keys)", () => {
    for (const { name, snapshot } of snapshots) {
      const raw = snapshot.chain.access_keys.map(rawKey);
      expect(
        raw.map((key) => toAccessKeyInfo(key)),
        name,
      ).toEqual(snapshot.chain.access_keys);
    }
  });

  for (const { label, mutate, pass } of MUTATIONS) {
    it(`agrees on every snapshot: ${label}`, () => {
      for (const { name, snapshot } of snapshots) {
        const raw = snapshot.chain.access_keys.map(rawKey);
        mutate(raw, snapshot);
        expect(verdicts(snapshot, raw), `${name}: ${label}`).toEqual({ checkF: pass, audit: pass });
      }
    });
  }

  it("agrees on code that is a recorded build but not a vault build (a factory build)", () => {
    for (const { name, snapshot } of snapshots) {
      const raw = snapshot.chain.access_keys.map(rawKey);
      expect(verdicts(snapshot, raw, { codeHash: FACTORY_BUILD }), name).toEqual({
        checkF: false,
        audit: false,
      });
    }
  });

  it("agrees that an unknown permission variant fails closed: the SDK refuses to read it, the audit counts it as full access", () => {
    for (const { name, snapshot } of snapshots) {
      const raw = snapshot.chain.access_keys.map(rawKey);
      raw.push({ public_key: OTHER_PK, access_key: { nonce: 0, permission: { Foo: {} } } });
      expect(() => toAccessKeyInfo(raw.at(-1)), name).toThrow();
      const report = accountLockReport(
        snapshot.vault,
        { code_hash: snapshot.chain.code_hash },
        { keys: raw },
        {
          policy: vaultPolicy(snapshot),
        },
      );
      expect(report.locked, name).toBe(false);
      expect(report.ok, name).toBe(false);
    }
  });

  it("documents the gas-key gap: check f accepts a scoped gas key (the SDK folds it), the audit refuses it by default", () => {
    // Shape from near-api-js 7.4.0 types (GasKeyFunctionCall); no gas key is on chain in the recorded evidence.
    for (const { name, snapshot } of snapshots) {
      const raw = snapshot.chain.access_keys.map(rawKey);
      const spend = keyWith(raw, "spend");
      if (spend === undefined) continue;
      spend.access_key.permission = {
        GasKeyFunctionCall: {
          allowance: "1000",
          balance: "1000000000000000000000000",
          method_names: ["spend"],
          num_nonces: 2,
          receiver_id: snapshot.vault,
        },
      };
      expect(verdicts(snapshot, raw), name).toEqual({ checkF: true, audit: false });
      expect(verdicts(snapshot, raw, { allowGasKey: true }), name).toEqual({
        checkF: true,
        audit: true,
      });
    }
  });
});
