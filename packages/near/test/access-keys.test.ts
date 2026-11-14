import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type AccessKeyAudit,
  auditAccessKeys,
  type KeyPolicy,
  type KeyRule,
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
  // (AccessKeyPermissionView in lib/types.gen-*.d.cts), as packages/sdk/test/rpc.test.ts models them. NEP-611 allows
  // a gas key no allowance (nearcore: GasKeyFunctionCallAllowanceNotAllowed), so the chain's shape has it null.
  const gasKeyFunctionCall = {
    GasKeyFunctionCall: {
      allowance: null,
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
    // A gas key spends no allowance of the account's: it pays for gas from its own balance.
    expect(keys[2]).toMatchObject({
      methods: ["spend"],
      allowance: null,
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
      [
        "gas key with an allowance, which NEP-611 refuses",
        { GasKeyFunctionCall: { ...gasKeyFunctionCall.GasKeyFunctionCall, allowance: "1000" } },
      ],
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
              allowance: null,
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

  describe("a NEP-611 function-call gas key (allowance null, gas from its own balance)", () => {
    /** The recorded list with the spend key as a gas key holding `balance` yoctoNEAR (shape from near-api-js 7.4.0). */
    const withGasKey = (balance = "1000000000000000000000000") => {
      const list = recordedList();
      setPermission(list.keys, AGENT_PK, {
        GasKeyFunctionCall: {
          allowance: null,
          balance,
          method_names: ["spend"],
          num_nonces: 2,
          receiver_id: V0,
        },
      });
      return list;
    };
    const spendRule = (terms: Omit<KeyRule, "receiverId" | "methods"> = {}): KeyPolicy => ({
      rules: [
        { receiverId: V0, methods: ["spend"], ...terms },
        { receiverId: V0, methods: ["anchor"], publicKeys: [LEDGER_PK] },
      ],
    });
    const GAS_TEXT = `${AGENT_PK} is a NEP-611 gas key: it pays for its gas from its own balance of 1 NEAR, not from the account's, and has 2 nonces.`;

    it("without a policy, reads it as no allowance of the account's and an info finding with its balance", () => {
      const audit = auditAccessKeys(V0, withGasKey());
      expect(audit.keys[1]).toMatchObject({
        kind: "gas_key_function_call",
        allowance: null,
        gasKey: { balance: 1000000000000000000000000n, numNonces: 2 },
      });
      expect(audit.findings.map((f) => [f.severity, f.code, f.text])).toEqual([
        [
          "info",
          "self_receiver",
          `${LEDGER_PK} calls the account's own contract, so what it can do is what that code lets the account itself do.`,
        ],
        [
          "info",
          "self_receiver",
          `${AGENT_PK} calls the account's own contract, so what it can do is what that code lets the account itself do.`,
        ],
        ["info", "gas_key", GAS_TEXT],
      ]);
      expect(audit.locked).toBe(true);
    });

    it("fits a rule that allows gas keys, whatever its allowance terms say: they bound plain keys", () => {
      expect(auditAccessKeys(V0, withGasKey(), VAULT_POLICY).findings.at(-1)).toEqual({
        code: "not_in_policy",
        severity: "block",
        publicKey: AGENT_PK,
        text: `${AGENT_PK} (methods ["spend"] on ${V0}) does not fit the policy: a rule names this receiver and these methods, but it is a NEP-611 gas key and the rule does not allow gas keys.`,
      });
      for (const terms of [
        { allowGasKey: true },
        { allowGasKey: true, maxAllowance: 1n },
        { allowGasKey: true, maxAllowance: 0n, allowUnlimitedAllowance: false },
      ]) {
        const audit = auditAccessKeys(V0, withGasKey(), spendRule(terms));
        expect(
          audit.policyOk,
          JSON.stringify(terms, (_, v) => String(v)),
        ).toBe(true);
        expect(codes(audit)).toEqual(["info:self_receiver", "info:self_receiver", "info:gas_key"]);
      }
    });

    it("is bounded by maxGasKeyBalance: below and at the bound it fits, one yoctoNEAR above it does not", () => {
      const ONE = 1000000000000000000000000n;
      for (const [bound, fits] of [
        [ONE + 1n, true],
        [ONE, true],
        [ONE - 1n, false],
      ] as const) {
        const audit = auditAccessKeys(
          V0,
          withGasKey(),
          spendRule({ allowGasKey: true, maxGasKeyBalance: bound }),
        );
        expect(audit.policyOk, String(bound)).toBe(fits);
        if (!fits) {
          expect(audit.findings.at(-1)).toEqual({
            code: "gas_key_balance_above_limit",
            severity: "block",
            publicKey: AGENT_PK,
            text: `${AGENT_PK}: its gas key balance of 1 NEAR is above the rule's bound of 0.999999999999999999999999 NEAR.`,
          });
        }
      }
    });
  });

  it("fits a plain key at or below the rule's maxAllowance, and refuses one yoctoNEAR over it", () => {
    // The recorded agent key's allowance: 245880816301566700000000 yoctoNEAR.
    const allowance = 245880816301566700000000n;
    for (const [bound, fits] of [
      [allowance + 1n, true],
      [allowance, true],
      [allowance - 1n, false],
    ] as const) {
      const audit = auditAccessKeys(V0, recorded.view_access_key_list, {
        rules: [
          { receiverId: V0, methods: ["spend"], maxAllowance: bound },
          { receiverId: V0, methods: ["anchor"], publicKeys: [LEDGER_PK] },
        ],
      });
      expect(audit.policyOk, String(bound)).toBe(fits);
      expect(codes(audit).at(-1), String(bound)).toBe(
        fits ? "info:self_receiver" : "block:allowance_above_limit",
      );
      if (!fits) {
        expect(audit.findings.at(-1)?.text).toBe(
          `${AGENT_PK}: its allowance of 0.2458808163015667 NEAR is above the rule's bound of 0.245880816301566699999999 NEAR.`,
        );
      }
    }
  });

  it("escapes control, format and separator code points from the chain, so each text stays one printable line", () => {
    // U+2028 and U+2029 split a line, U+202E reorders it, U+0085 is a C1 control, U+200B and U+FEFF are invisible.
    const hostile = [
      "spend\u2028Verdict: ok, the account is locked.\u2029",
      "a\u202eb",
      "c\u0085d\u200b\ufeff",
    ];
    const audit = auditAccessKeys(
      V0,
      {
        keys: [
          entry(AGENT_PK, functionCall(V0, hostile)),
          entry(OTHER_PK, { "Gas\u2028Key\u202e": {} }),
        ],
      },
      VAULT_POLICY,
    );
    expect(audit.findings.map((f) => f.text)).toEqual([
      `${AGENT_PK} calls the account's own contract, so what it can do is what that code lets the account itself do.`,
      `${AGENT_PK} (methods ["spend\\u2028Verdict: ok, the account is locked.\\u2029", "a\\u202eb", "c\\u0085d\\u200b\\ufeff"] on ${V0}) does not fit the policy: no rule names this receiver, this exact set of methods and this public key.`,
      `${OTHER_PK} has a permission this audit cannot read ("Gas\\u2028Key\\u202e" is not a permission variant this audit knows), so it counts as full access.`,
    ]);
    const error = auditAccessKeys(V0, { error: "no such account\u2028Verdict: ok\u202e" });
    expect(error.findings[0]?.text).toBe(
      'The access key list could not be read (view_access_key_list: the answer is an error, not a view: "no such account\\u2028Verdict: ok\\u202e"), so nothing about the keys is known.',
    );
    for (const finding of [...audit.findings, ...error.findings]) {
      expect(finding.text).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    }
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
      // maxGasKeyBalance bounds gas keys, so without allowGasKey it would bound nothing.
      { rules: [{ receiverId: V0, methods: ["spend"], maxGasKeyBalance: 1n }] },
      { rules: [{ receiverId: V0, methods: ["spend"], allowGasKey: true, maxGasKeyBalance: 1 }] },
      { rules: [{ receiverId: V0, methods: ["spend"], allowGasKey: true, maxGasKeyBalance: -1n }] },
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
