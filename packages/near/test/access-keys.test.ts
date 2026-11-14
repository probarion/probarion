import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type AccessKeyAudit,
  auditAccessKeys,
  type KeyPolicy,
  parseAccessKey,
  parseAccessKeyList,
} from "../src/access-keys.js";
import { NearFormatError } from "../src/errors.js";
import { readFixture } from "./helpers/fixtures.js";
import { mulberry32 } from "./helpers/prng.js";

type Json = Record<string, unknown>;

interface KeysFixture {
  _source: string;
  account_id: string;
  view_account: Json;
  view_access_key_list: { block_height: number; block_hash: string; keys: Json[] };
  view_access_key: { public_key: string; result: Json }[];
}

interface DrillFixture {
  _source: string;
  account_id: string;
  public_key: string;
  answers: Json[];
}

const V0 = "v0.probarion.near";
const recorded = readFixture<KeysFixture>("keys/mainnet-v0.json");
const drill = readFixture<DrillFixture>("keys/drill-view-access-key.json");

/** The vault's ledger (anchor) access key and agent (spend) access key, as the recorded list names them. */
const LEDGER_PK = "ed25519:RY7kjsaRStq4gt27RpNgErr9AjuKuZdzCXd6atSrzKK";
const AGENT_PK = "ed25519:GADeVCXtgcxS3E5JrcVpEWTuZiNMJ4gu17iyuEgyCycd";
/** Two more real public keys for mutations: the owner's (docs/evidence/mainnet-v0/drill-2026-11-14/README.md) and the
 *  402 vault's agent (docs/evidence/402-vault/snapshot-2026-11-11.json). */
const OTHER_PK = "ed25519:4jHJSmeUGvpJzXDTUvBkKzGUgXMb3jMXmyKT44htnUxc";
const THIRD_PK = "ed25519:4sYFZAht1g5D3gN91Fu6Hq8sXq6Qunh9HpSeLeCeAS7N";

/** The vault policy: what contracts/vault keys.rs grants (spend for agents, anchor for the one ledger key). */
const VAULT_POLICY: KeyPolicy = {
  rules: [
    { receiverId: V0, methods: ["spend"] },
    { receiverId: V0, methods: ["anchor"], publicKeys: [LEDGER_PK] },
  ],
};

/** A deep copy of the recorded list, for mutations. */
function recordedList(): { block_height: number; block_hash: string; keys: Json[] } {
  return structuredClone(recorded.view_access_key_list);
}

/** One raw list entry, in the RPC's shape. */
function entry(publicKey: string, permission: unknown, nonce: unknown = 1): Json {
  return { access_key: { nonce, permission }, public_key: publicKey };
}

function functionCall(receiverId: string, methods: unknown, allowance: unknown = "1000"): Json {
  return { FunctionCall: { allowance, method_names: methods, receiver_id: receiverId } };
}

const codes = (audit: AccessKeyAudit) => audit.findings.map((f) => `${f.severity}:${f.code}`);

describe("parseAccessKeyList on the recorded mainnet vault", () => {
  it("reads both function-call keys with their receiver, methods, allowance and nonce", () => {
    expect(recorded._source).toMatch(/nothing was signed/);
    const parsed = parseAccessKeyList(recorded.view_access_key_list);
    expect(parsed.blockHeight).toBe(224468063);
    expect(parsed.blockHash).toBe(recorded.view_account.block_hash);
    expect(parsed.keys).toEqual([
      {
        publicKey: LEDGER_PK,
        nonce: 224330664000004n,
        kind: "function_call",
        actsAsFullAccess: false,
        receiverId: V0,
        methods: ["anchor"],
        allowance: 249188678733602700000000n,
        gasKey: null,
      },
      {
        publicKey: AGENT_PK,
        nonce: 224068463000006n,
        kind: "function_call",
        actsAsFullAccess: false,
        receiverId: V0,
        methods: ["spend"],
        allowance: 245880816301566700000000n,
        gasKey: null,
      },
    ]);
  });

  it("reads each recorded view_access_key answer as the same key the list shows", () => {
    const list = parseAccessKeyList(recorded.view_access_key_list).keys;
    expect(recorded.view_access_key).toHaveLength(2);
    for (const single of recorded.view_access_key) {
      const fromList = list.find((k) => k.publicKey === single.public_key);
      expect(parseAccessKey(single.result, single.public_key)).toEqual(fromList);
    }
  });

  it("reads the drill's four archival answers: the agent key's allowance goes down with each refused spend", () => {
    const views = drill.answers.map((answer) => parseAccessKey(answer, drill.public_key));
    expect(views.map((v) => [v.nonce, v.allowance])).toEqual([
      [224068463000004n, 246219350238132600000000n],
      [224068463000005n, 246045777095666700000000n],
      [224068463000006n, 245880816301566700000000n],
      [224068463000006n, 245880816301566700000000n],
    ]);
    for (const view of views) {
      expect(view).toMatchObject({ kind: "function_call", receiverId: V0, methods: ["spend"] });
    }
    // The key read on the recorded block (after the drill) has the allowance of the last drill read: no spend since.
    const now = parseAccessKeyList(recorded.view_access_key_list).keys.find(
      (k) => k.publicKey === AGENT_PK,
    );
    expect(now?.allowance).toBe(views[3]?.allowance);
    expect(now?.nonce).toBe(views[3]?.nonce);
  });

  it("refuses a garbled envelope with NearFormatError naming the value", () => {
    const cases: [unknown, string][] = [
      [null, "view_access_key_list"],
      [[], "view_access_key_list"],
      [{ keys: {} }, "view_access_key_list.keys"],
      [
        { error: "account x does not exist while viewing", block_height: 1 },
        "view_access_key_list",
      ],
      [{ keys: [], block_height: -1 }, "view_access_key_list.block_height"],
      [{ keys: [], block_height: "7" }, "view_access_key_list.block_height"],
      [{ keys: [], block_hash: "not-a-hash" }, "view_access_key_list.block_hash"],
      [{ keys: [{ public_key: "ed25519", access_key: {} }] }, "view_access_key_list.keys[0]"],
      [{ keys: [{ public_key: AGENT_PK }] }, "view_access_key_list.keys[0]"],
      [
        { keys: [entry(AGENT_PK, "FullAccess"), entry(AGENT_PK, "FullAccess")] },
        "view_access_key_list.keys[1]",
      ],
    ];
    for (const [input, what] of cases) {
      let caught: unknown;
      try {
        parseAccessKeyList(input);
      } catch (error) {
        caught = error;
      }
      expect(caught, JSON.stringify(input)).toBeInstanceOf(NearFormatError);
      expect((caught as NearFormatError).what).toBe(what);
    }
  });

  it("reads an absent block height and hash as null, and a nonce that does not read exactly as null", () => {
    const parsed = parseAccessKeyList({
      keys: [entry(AGENT_PK, "FullAccess", 2 ** 60), entry(OTHER_PK, "FullAccess", "17")],
    });
    expect(parsed.blockHeight).toBeNull();
    expect(parsed.blockHash).toBeNull();
    expect(parsed.keys.map((k) => k.nonce)).toEqual([null, 17n]);
  });

  it("parseAccessKey refuses an error answer, an answer without a permission and a bad public key", () => {
    expect(() =>
      parseAccessKey({ error: "access key x does not exist while viewing" }, AGENT_PK),
    ).toThrow(NearFormatError);
    expect(() => parseAccessKey({ nonce: 1 }, AGENT_PK)).toThrow(NearFormatError);
    expect(() => parseAccessKey("FullAccess", AGENT_PK)).toThrow(NearFormatError);
    expect(() => parseAccessKey({ nonce: 1, permission: "FullAccess" }, "GADe")).toThrow(TypeError);
  });
});

describe("parsing each permission variant", () => {
  // Gas keys (NEP-611) have no on-chain fixture here: these shapes are from near-api-js 7.4.0 types
  // (AccessKeyPermissionView in lib/types.gen-*.d.cts), as packages/sdk/test/rpc.test.ts models them.
  const gasKeyFunctionCall = {
    GasKeyFunctionCall: {
      allowance: "1000",
      balance: "5000000000000000000000000",
      method_names: ["spend"],
      num_nonces: 4,
      receiver_id: V0,
    },
  };
  const gasKeyFullAccess = {
    GasKeyFullAccess: { balance: "2000000000000000000000000", num_nonces: 1 },
  };

  it("keeps the four variants apart", () => {
    const keys = parseAccessKeyList({
      keys: [
        entry(AGENT_PK, "FullAccess"),
        entry(OTHER_PK, functionCall(V0, [], null)),
        entry(LEDGER_PK, gasKeyFunctionCall),
        entry(THIRD_PK, gasKeyFullAccess),
      ],
    }).keys;
    expect(keys.map((k) => [k.kind, k.actsAsFullAccess])).toEqual([
      ["full_access", true],
      ["function_call", false],
      ["gas_key_function_call", false],
      ["gas_key_full_access", true],
    ]);
    expect(keys[1]).toMatchObject({ methods: "any", allowance: "unlimited", receiverId: V0 });
    expect(keys[2]).toMatchObject({
      methods: ["spend"],
      allowance: 1000n,
      gasKey: { balance: 5000000000000000000000000n, numNonces: 4 },
    });
    expect(keys[3]).toMatchObject({
      methods: null,
      allowance: null,
      receiverId: null,
      gasKey: { balance: 2000000000000000000000000n, numNonces: 1 },
    });
  });

  it("reads a missing allowance as unlimited, as near-api-js types it (allowance?: NearToken | null)", () => {
    const [key] = parseAccessKeyList({
      keys: [entry(AGENT_PK, { FunctionCall: { method_names: ["spend"], receiver_id: V0 } })],
    }).keys;
    expect(key?.allowance).toBe("unlimited");
  });

  it("reads every other shape as unknown, acting as full access, and keeps the raw permission", () => {
    const shapes: [string, unknown][] = [
      ["an unknown variant", { Foo: {} }],
      ["two variants", { FunctionCall: functionCall(V0, ["spend"]).FunctionCall, FullAccess: {} }],
      ["no variant", {}],
      ["FullAccess as an object", { FullAccess: {} }],
      ["lowercase fullaccess", "fullaccess"],
      ["null", null],
      ["method_names missing", { FunctionCall: { allowance: "1", receiver_id: V0 } }],
      ["method_names not a list", functionCall(V0, "spend")],
      ["a method name that is not text", functionCall(V0, ["spend", 7])],
      ['allowance "01"', functionCall(V0, ["spend"], "01")],
      ["allowance a number", functionCall(V0, ["spend"], 1000)],
      ["allowance negative", functionCall(V0, ["spend"], "-1")],
      ["allowance over u128", functionCall(V0, ["spend"], (1n << 128n).toString())],
      ["receiver not an account id", functionCall("V0.Probarion.near", ["spend"])],
      ["body not an object", { FunctionCall: "spend" }],
      ["gas key balance a number", { GasKeyFullAccess: { balance: 5, num_nonces: 1 } }],
      ["gas key num_nonces negative", { GasKeyFullAccess: { balance: "5", num_nonces: -1 } }],
      [
        "gas key num_nonces missing",
        { GasKeyFunctionCall: { ...gasKeyFunctionCall.GasKeyFunctionCall, num_nonces: undefined } },
      ],
      ["gas key without its scope", { GasKeyFunctionCall: { balance: "5", num_nonces: 1 } }],
    ];
    for (const [label, permission] of shapes) {
      const [key] = parseAccessKeyList({ keys: [entry(AGENT_PK, permission)] }).keys;
      expect(key?.kind, label).toBe("unknown");
      expect(key?.actsAsFullAccess, label).toBe(true);
      expect(key?.raw, label).toEqual(permission);
      const audit = auditAccessKeys(V0, { keys: [entry(AGENT_PK, permission)] });
      expect(codes(audit), label).toEqual(["block:unknown_permission"]);
      expect(audit.locked, label).toBe(false);
    }
  });
});

describe("auditAccessKeys", () => {
  it("finds the recorded mainnet vault locked: two keys on itself, info findings, and the vault policy passes", () => {
    const plain = auditAccessKeys(V0, recorded.view_access_key_list);
    expect(plain.locked).toBe(true);
    expect(plain.policyOk).toBeNull();
    expect(plain.blockHeight).toBe(224468063);
    expect(codes(plain)).toEqual(["info:self_receiver", "info:self_receiver"]);

    const withPolicy = auditAccessKeys(V0, recorded.view_access_key_list, VAULT_POLICY);
    expect(withPolicy.policyOk).toBe(true);
    expect(codes(withPolicy)).toEqual(["info:self_receiver", "info:self_receiver"]);
  });

  it("reads the 2026-11-13 verifier snapshot's keys, rebuilt into the RPC shape, with their recorded allowances", () => {
    // docs/evidence keeps the keys as the SDK folds them; the raw FunctionCall wrapper is rebuilt here.
    const snapshot = JSON.parse(
      readFileSync(
        new URL(
          "../../../docs/evidence/mainnet-v0/s2-2026-11-13/snapshot-2026-11-13.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { chain: { access_keys: { public_key: string; permission: Json }[]; config: Json } };
    const list = {
      keys: snapshot.chain.access_keys.map((k) =>
        entry(k.public_key, { FunctionCall: k.permission }, 0),
      ),
    };
    const audit = auditAccessKeys(V0, list, {
      rules: [
        { receiverId: V0, methods: ["spend"] },
        {
          receiverId: V0,
          methods: ["anchor"],
          publicKeys: [String(snapshot.chain.config.ledger_key)],
        },
      ],
    });
    expect(audit.locked).toBe(true);
    expect(audit.policyOk).toBe(true);
    expect(audit.keys.map((k) => [k.publicKey, k.methods, k.allowance])).toEqual([
      [LEDGER_PK, ["anchor"], 249188678733602700000000n],
      [AGENT_PK, ["spend"], 246219350238132600000000n],
    ]);
  });

  it("fails each mutation of the recorded vault with its own code", () => {
    // The recorded keys give one info:self_receiver each (ledger key, then agent key) before a case's findings.
    const SELF = "info:self_receiver";
    const cases: {
      label: string;
      mutate: (keys: Json[]) => void;
      policy?: KeyPolicy;
      expected: string[];
      locked: boolean;
    }[] = [
      {
        label: "a FullAccess key added",
        mutate: (keys) => keys.push(entry(OTHER_PK, "FullAccess")),
        expected: [SELF, SELF, "block:full_access"],
        locked: false,
      },
      {
        label: "a [] key on the account itself",
        mutate: (keys) => keys.push(entry(OTHER_PK, functionCall(V0, []))),
        expected: [SELF, SELF, "warn:any_method", "warn:self_receiver", "block:not_in_policy"],
        locked: true,
      },
      {
        label: "a second anchor key that is not the ledger key",
        mutate: (keys) => keys.push(entry(OTHER_PK, functionCall(V0, ["anchor"]))),
        expected: [SELF, SELF, SELF, "block:not_in_policy"],
        locked: true,
      },
      {
        label: "the spend key with an unlimited allowance",
        mutate: (keys) => setPermission(keys, AGENT_PK, functionCall(V0, ["spend"], null)),
        expected: [SELF, SELF, "info:unlimited_allowance", "block:not_in_policy"],
        locked: true,
      },
      {
        label: "the spend key above the rule's allowance bound",
        mutate: () => {},
        policy: {
          rules: [
            { receiverId: V0, methods: ["spend"], maxAllowance: 200000000000000000000000n },
            { receiverId: V0, methods: ["anchor"], publicKeys: [LEDGER_PK] },
          ],
        },
        expected: [SELF, SELF, "block:allowance_above_limit"],
        locked: true,
      },
      {
        label: "the spend key also able to anchor",
        mutate: (keys) => setPermission(keys, AGENT_PK, functionCall(V0, ["spend", "anchor"])),
        expected: [SELF, SELF, "block:not_in_policy"],
        locked: true,
      },
      {
        label: "the spend key on another receiver",
        mutate: (keys) => setPermission(keys, AGENT_PK, functionCall("usdc.near", ["spend"])),
        expected: [SELF, "block:not_in_policy"],
        locked: true,
      },
      {
        label: "the spend key as a gas key (shape from near-api-js 7.4.0 types)",
        mutate: (keys) =>
          setPermission(keys, AGENT_PK, {
            GasKeyFunctionCall: {
              allowance: "1000",
              balance: "1000000000000000000000000",
              method_names: ["spend"],
              num_nonces: 2,
              receiver_id: V0,
            },
          }),
        expected: [SELF, SELF, "info:gas_key", "block:not_in_policy"],
        locked: true,
      },
      {
        label: "a GasKeyFullAccess key added (shape from near-api-js 7.4.0 types)",
        mutate: (keys) =>
          keys.push(entry(OTHER_PK, { GasKeyFullAccess: { balance: "1", num_nonces: 1 } })),
        expected: [SELF, SELF, "block:full_access", "info:gas_key"],
        locked: false,
      },
      {
        label: "an unknown variant added",
        mutate: (keys) => keys.push(entry(OTHER_PK, { Foo: {} })),
        expected: [SELF, SELF, "block:unknown_permission"],
        locked: false,
      },
    ];
    for (const { label, mutate, policy, expected, locked } of cases) {
      const list = recordedList();
      mutate(list.keys);
      const audit = auditAccessKeys(V0, list, policy ?? VAULT_POLICY);
      expect(codes(audit), label).toEqual(expected);
      expect(audit.locked, label).toBe(locked);
      expect(audit.policyOk, label).toBe(false);
    }
  });

  it("accepts the gas-key spend key when its rule allows gas keys, and an unlimited one when allowed", () => {
    const list = recordedList();
    setPermission(list.keys, AGENT_PK, {
      GasKeyFunctionCall: {
        allowance: null,
        balance: "1000000000000000000000000",
        method_names: ["spend"],
        num_nonces: 2,
        receiver_id: V0,
      },
    });
    const refused = auditAccessKeys(V0, list, VAULT_POLICY);
    expect(refused.policyOk).toBe(false);
    const allowed = auditAccessKeys(V0, list, {
      rules: [
        { receiverId: V0, methods: ["spend"], allowGasKey: true, allowUnlimitedAllowance: true },
        { receiverId: V0, methods: ["anchor"], publicKeys: [LEDGER_PK] },
      ],
    });
    expect(allowed.policyOk).toBe(true);
    expect(codes(allowed)).toEqual([
      "info:self_receiver",
      "info:self_receiver",
      "info:unlimited_allowance",
      "info:gas_key",
    ]);
  });

  it("warns on an unlimited allowance and an any-method key when no policy is given", () => {
    const audit = auditAccessKeys("probarion.near", {
      keys: [
        entry(AGENT_PK, functionCall("intents.near", [], null)),
        entry(OTHER_PK, functionCall("probarion.near", ["ping"], null)),
      ],
    });
    expect(codes(audit)).toEqual([
      "warn:any_method",
      "warn:unlimited_allowance",
      "info:self_receiver",
      "warn:unlimited_allowance",
    ]);
    expect(audit.locked).toBe(true);
    expect(audit.policyOk).toBeNull();
  });

  it("matches method sets exactly and in any order; rules: [] fits no key; a policy without rules judges full access", () => {
    const keys = { keys: [entry(AGENT_PK, functionCall(V0, ["b", "a"]))] };
    expect(
      auditAccessKeys(V0, keys, { rules: [{ receiverId: V0, methods: ["a", "b"] }] }).policyOk,
    ).toBe(true);
    expect(
      auditAccessKeys(V0, keys, { rules: [{ receiverId: V0, methods: ["a"] }] }).policyOk,
    ).toBe(false);
    expect(
      auditAccessKeys(V0, keys, { rules: [{ receiverId: V0, methods: ["a", "b", "c"] }] }).policyOk,
    ).toBe(false);
    expect(auditAccessKeys(V0, keys, { rules: [] }).policyOk).toBe(false);
    expect(auditAccessKeys(V0, keys, {}).policyOk).toBe(true);
    const full = { keys: [entry(AGENT_PK, "FullAccess")] };
    expect(auditAccessKeys(V0, full, {}).policyOk).toBe(false);
    const allowed = auditAccessKeys(V0, full, { fullAccess: "allow" });
    expect(allowed.policyOk).toBe(true);
    expect(allowed.locked).toBe(false);
    expect(codes(allowed)).toEqual(["warn:full_access"]);
  });

  it("finds an empty key list locked, with no findings", () => {
    const audit = auditAccessKeys(V0, { keys: [], block_height: 5 }, VAULT_POLICY);
    expect(audit).toMatchObject({ locked: true, policyOk: true, findings: [], blockHeight: 5 });
  });

  it("turns a list that does not parse into one malformed_list block finding, never a throw", () => {
    for (const bad of [
      null,
      "keys",
      { keys: "none" },
      { keys: [entry(AGENT_PK, "FullAccess"), entry(AGENT_PK, "FullAccess")] },
      { error: "account v0.probarion.near does not exist while viewing" },
    ]) {
      const audit = auditAccessKeys(V0, bad, VAULT_POLICY);
      expect(codes(audit)).toEqual(["block:malformed_list"]);
      expect(audit).toMatchObject({ locked: false, policyOk: false, keys: [], blockHeight: null });
      expect(auditAccessKeys(V0, bad).policyOk).toBeNull();
    }
  });

  it("refuses an invalid account id or policy with a TypeError", () => {
    const list = recorded.view_access_key_list;
    const policies: unknown[] = [
      null,
      { fullAccess: "deny" },
      { rules: {} },
      { rules: [{ receiverId: V0, methods: [] }] },
      { rules: [{ receiverId: V0 }] },
      { rules: [{ receiverId: V0, methods: ["spend", "spend"] }] },
      { rules: [{ receiverId: V0, methods: [""] }] },
      { rules: [{ receiverId: "Not An Account", methods: ["spend"] }] },
      { rules: [{ receiverId: V0, methods: ["spend"], publicKeys: [] }] },
      { rules: [{ receiverId: V0, methods: ["spend"], publicKeys: ["GADe"] }] },
      { rules: [{ receiverId: V0, methods: ["spend"], maxAllowance: 1000 }] },
      { rules: [{ receiverId: V0, methods: ["spend"], maxAllowance: -1n }] },
      { rules: [{ receiverId: V0, methods: ["spend"], allowGasKey: "yes" }] },
      { rules: [{ receiverId: V0, methods: ["spend"], maxallowance: 1n }] },
      { rule: [] },
    ];
    for (const policy of policies) {
      expect(
        () => auditAccessKeys(V0, list, policy as KeyPolicy),
        JSON.stringify(policy, (_, v) => (typeof v === "bigint" ? `${v}n` : v)),
      ).toThrow(TypeError);
    }
    expect(() => auditAccessKeys("", list)).toThrow(TypeError);
    expect(() => auditAccessKeys("V0.near", list)).toThrow(TypeError);
  });

  it("is total over random answers: never throws, and an unreadable key is never read as scoped", () => {
    const random = mulberry32(611);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const values: unknown[] = [
      null,
      undefined,
      0,
      -1,
      1.5,
      "",
      "FullAccess",
      "0",
      "1000",
      "01",
      [],
      ["spend"],
      {},
      V0,
      true,
    ];
    const randomValue = (depth: number): unknown => {
      if (depth > 2 || random() < 0.4) return pick(values);
      const obj: Json = {};
      const fields = [
        "FunctionCall",
        "GasKeyFunctionCall",
        "GasKeyFullAccess",
        "receiver_id",
        "method_names",
        "allowance",
        "balance",
        "num_nonces",
        "x",
      ];
      const n = Math.floor(random() * 4);
      for (let i = 0; i < n; i++) obj[pick(fields)] = randomValue(depth + 1);
      return obj;
    };
    for (let run = 0; run < 500; run++) {
      const permission = randomValue(0);
      const list = random() < 0.1 ? randomValue(0) : { keys: [entry(AGENT_PK, permission)] };
      let audit: AccessKeyAudit | undefined;
      expect(() => {
        audit = auditAccessKeys(V0, list, VAULT_POLICY);
      }, `run ${run}`).not.toThrow();
      for (const key of audit?.keys ?? []) {
        if (key.kind === "unknown") expect(key.actsAsFullAccess).toBe(true);
        if (key.kind === "function_call")
          expect(Array.isArray(key.methods) || key.methods === "any").toBe(true);
      }
      if (audit?.keys.some((k) => k.actsAsFullAccess)) expect(audit.locked).toBe(false);
    }
  });
});

/** Replaces the permission of `publicKey` in a raw list. */
function setPermission(keys: Json[], publicKey: string, permission: unknown): void {
  const found = keys.find((k) => k.public_key === publicKey) as
    | { access_key: { permission: unknown } }
    | undefined;
  if (found === undefined) throw new Error(`no ${publicKey} in the list`);
  found.access_key.permission = permission;
}
