// N3 (account lock audit): what each access key of an account can do if it leaks, and whether the keys fit a policy.
// The permission rules are lifted from @probarion/sdk rpc.ts (`parsePermission`, `scopedPermission`, `gasKeyProblem`)
// and apps/web keys/rules.ts (`scopeProblem`), with one change: the NEP-611 gas-key variants are kept, not folded
// into their plain counterparts, so a gas key's balance and nonces reach the audit. Pure: no network, no clock.
import {
  isAccountId,
  isBase58Hash,
  isRecord,
  parseSafeCount,
  parseU64,
  parseU128,
  U128_MAX,
} from "./encoding.js";
import { NearFormatError } from "./errors.js";

export type AccessKeyKind =
  | "full_access"
  | "function_call"
  | "gas_key_full_access"
  | "gas_key_function_call"
  | "unknown";

/** One access key as the chain reports it, with the permission variant kept. */
export interface AccessKeyView {
  publicKey: string;
  /** The key's nonce, or null when the answer gives none that reads exactly (it plays no part in the audit). */
  nonce: bigint | null;
  kind: AccessKeyKind;
  /** full_access, gas_key_full_access and unknown: an unreadable permission fails closed. */
  actsAsFullAccess: boolean;
  receiverId: string | null;
  /** null for the full-access kinds; "any" when `method_names` is [] (NEAR reads an empty list as every method). */
  methods: "any" | readonly string[] | null;
  /** Gas the key may spend from the account, in yoctoNEAR; "unlimited" when `allowance` is null; null for full access. */
  allowance: bigint | "unlimited" | null;
  /** NEP-611: the key's own gas balance (yoctoNEAR) and its number of nonces. */
  gasKey: { balance: bigint; numNonces: number } | null;
  /** The permission as received, when kind is unknown. */
  raw?: unknown;
}

/** A NEAR public key as RPC prints it: `<curve>:<base58>`, for example `ed25519:GADe...`. */
const PUBLIC_KEY_RE = /^[a-z0-9]{1,16}:[1-9A-HJ-NP-Za-km-z]{32,100}$/;

function isPublicKey(value: unknown): value is string {
  return typeof value === "string" && PUBLIC_KEY_RE.test(value);
}

interface Scope {
  receiverId: string;
  methods: "any" | readonly string[];
  allowance: bigint | "unlimited";
}

interface GasKey {
  balance: bigint;
  numNonces: number;
}

type Classified =
  | {
      ok: true;
      kind: Exclude<AccessKeyKind, "unknown">;
      receiverId: string | null;
      methods: "any" | readonly string[] | null;
      allowance: bigint | "unlimited" | null;
      gasKey: GasKey | null;
    }
  | { ok: false; problem: string };

const bad = (problem: string): Classified => ({ ok: false, problem });

/** A variant name from the chain, quoted and cut short, so a problem text stays one short line. */
const quoted = (name: string): string =>
  JSON.stringify(name.length > 60 ? `${name.slice(0, 60)}...` : name);

/** `{ receiver_id, method_names, allowance? }` of a FunctionCall or GasKeyFunctionCall permission, or its problem. */
function scoped(variant: string, body: Record<string, unknown>): Scope | string {
  const { receiver_id: receiverId, method_names: methodNames, allowance } = body;
  if (!isAccountId(receiverId)) return `${variant}.receiver_id is not an account id`;
  // An empty list means "every method" on NEAR, so a missing or garbled list must never read as [].
  if (!Array.isArray(methodNames) || !methodNames.every((m) => typeof m === "string")) {
    return `${variant}.method_names is not a list of method names`;
  }
  let limit: bigint | "unlimited";
  if (allowance === undefined || allowance === null) {
    limit = "unlimited";
  } else {
    const parsed = parseU128(allowance);
    if (parsed === null) {
      return `${variant}.allowance is not a canonical yoctoNEAR decimal string or null`;
    }
    limit = parsed;
  }
  const methods: "any" | readonly string[] =
    methodNames.length === 0 ? "any" : Object.freeze([...(methodNames as string[])]);
  return { receiverId, methods, allowance: limit };
}

/** The fields a gas key adds: `balance` (yoctoNEAR, a decimal string) and `num_nonces` (a count), or the problem. */
function gasKeyOf(variant: string, body: Record<string, unknown>): GasKey | string {
  const balance = parseU128(body.balance);
  if (balance === null) return `${variant}.balance is not a canonical yoctoNEAR decimal string`;
  const numNonces = parseSafeCount(body.num_nonces);
  if (numNonces === null) return `${variant}.num_nonces is not a count`;
  return { balance, numNonces };
}

/**
 * `AccessKeyPermissionView` has four variants (near-api-js 7.4.0), matched by exact name: `"FullAccess"`,
 * `{ FunctionCall }`, `{ GasKeyFunctionCall }` and `{ GasKeyFullAccess }`. Anything else, an object with more than
 * one variant key, or a variant whose fields are not what the type says, is a problem: the caller reads it as an
 * unknown permission that acts as full access.
 */
function classify(permission: unknown): Classified {
  if (permission === "FullAccess") {
    return {
      ok: true,
      kind: "full_access",
      receiverId: null,
      methods: null,
      allowance: null,
      gasKey: null,
    };
  }
  if (!isRecord(permission)) return bad('the permission is neither "FullAccess" nor an object');
  const variants = Object.keys(permission);
  const variant = variants[0];
  if (variants.length !== 1 || variant === undefined) {
    return bad(`the permission has ${variants.length} variant keys, not one`);
  }
  const body = permission[variant];
  if (!isRecord(body)) return bad(`${quoted(variant)} is not an object`);
  switch (variant) {
    case "FunctionCall": {
      const scope = scoped(variant, body);
      if (typeof scope === "string") return bad(scope);
      return { ok: true, kind: "function_call", ...scope, gasKey: null };
    }
    case "GasKeyFunctionCall": {
      const gas = gasKeyOf(variant, body);
      if (typeof gas === "string") return bad(gas);
      const scope = scoped(variant, body);
      if (typeof scope === "string") return bad(scope);
      return { ok: true, kind: "gas_key_function_call", ...scope, gasKey: gas };
    }
    case "GasKeyFullAccess": {
      const gas = gasKeyOf(variant, body);
      if (typeof gas === "string") return bad(gas);
      return {
        ok: true,
        kind: "gas_key_full_access",
        receiverId: null,
        methods: null,
        allowance: null,
        gasKey: gas,
      };
    }
    default:
      return bad(`${quoted(variant)} is not a permission variant this audit knows`);
  }
}

/** JSON carries the nonce as a number (a string from some clients); anything that does not read exactly is null. */
function nonceOf(value: unknown): bigint | null {
  if (typeof value === "number") {
    const count = parseSafeCount(value);
    return count === null ? null : BigInt(count);
  }
  return parseU64(value);
}

function viewOf(publicKey: string, nonce: unknown, permission: unknown): AccessKeyView {
  const parsed = classify(permission);
  if (!parsed.ok) {
    return {
      publicKey,
      nonce: nonceOf(nonce),
      kind: "unknown",
      actsAsFullAccess: true,
      receiverId: null,
      methods: null,
      allowance: null,
      gasKey: null,
      raw: permission,
    };
  }
  return {
    publicKey,
    nonce: nonceOf(nonce),
    kind: parsed.kind,
    actsAsFullAccess: parsed.kind === "full_access" || parsed.kind === "gas_key_full_access",
    receiverId: parsed.receiverId,
    methods: parsed.methods,
    allowance: parsed.allowance,
    gasKey: parsed.gasKey,
  };
}

/** `block_height` and `block_hash` of a query answer: absent reads as null, present must be well formed. */
function blockOf(
  what: string,
  result: Record<string, unknown>,
): { blockHeight: number | null; blockHash: string | null } {
  const { block_height: height, block_hash: hash } = result;
  let blockHeight: number | null = null;
  if (height !== undefined && height !== null) {
    blockHeight = parseSafeCount(height);
    if (blockHeight === null) {
      throw new NearFormatError(`${what}.block_height`, `${what}: block_height is not a height`);
    }
  }
  let blockHash: string | null = null;
  if (hash !== undefined && hash !== null) {
    if (!isBase58Hash(hash)) {
      throw new NearFormatError(
        `${what}.block_hash`,
        `${what}: block_hash is not a 32-byte base58 hash`,
      );
    }
    blockHash = hash;
  }
  return { blockHeight, blockHash };
}

/** nearcore's legacy failure answer (HTTP 200, `{ error: "...", block_height, block_hash }`) is not a view. */
function refuseLegacyError(what: string, result: Record<string, unknown>): void {
  if (typeof result.error === "string") {
    throw new NearFormatError(
      what,
      `${what}: the answer is an error, not a view: ${JSON.stringify(result.error.slice(0, 200))}`,
    );
  }
}

/**
 * A `view_access_key_list` result `{ keys: [{ public_key, access_key: { nonce, permission } }], block_height,
 * block_hash }`. Throws NearFormatError on a garbled envelope: not an object, a legacy error answer, `keys` not a
 * list, an entry without a `<curve>:<base58>` public key or an `access_key` object, one public key listed twice, or
 * a block height or hash that does not read. A garbled single permission becomes kind unknown (it acts as full
 * access), not a throw. Absent `block_height` / `block_hash` read as null.
 */
export function parseAccessKeyList(result: unknown): {
  blockHeight: number | null;
  blockHash: string | null;
  keys: AccessKeyView[];
} {
  const what = "view_access_key_list";
  if (!isRecord(result)) throw new NearFormatError(what, `${what}: the answer is not an object`);
  refuseLegacyError(what, result);
  if (!Array.isArray(result.keys)) {
    throw new NearFormatError(`${what}.keys`, `${what}: keys is not a list`);
  }
  const block = blockOf(what, result);
  const seen = new Set<string>();
  const keys = result.keys.map((entry: unknown, i: number) => {
    const at = `${what}.keys[${i}]`;
    if (!isRecord(entry) || !isPublicKey(entry.public_key)) {
      throw new NearFormatError(at, `${at} has no public key of the form <curve>:<base58>`);
    }
    if (!isRecord(entry.access_key)) {
      throw new NearFormatError(at, `${at} has no access_key object`);
    }
    if (seen.has(entry.public_key)) {
      throw new NearFormatError(at, `${at}: ${entry.public_key} is listed twice`);
    }
    seen.add(entry.public_key);
    return viewOf(entry.public_key, entry.access_key.nonce, entry.access_key.permission);
  });
  return { ...block, keys };
}

/**
 * A `view_access_key` result `{ nonce, permission, block_height, block_hash }` for `publicKey`. Throws
 * NearFormatError on a garbled envelope (or a legacy error answer, such as a key that does not exist); a garbled
 * permission becomes kind unknown, as in the list. Throws TypeError when `publicKey` is not `<curve>:<base58>`.
 */
export function parseAccessKey(result: unknown, publicKey: string): AccessKeyView {
  const what = "view_access_key";
  if (!isPublicKey(publicKey)) {
    throw new TypeError("parseAccessKey: publicKey is not of the form <curve>:<base58>");
  }
  if (!isRecord(result)) throw new NearFormatError(what, `${what}: the answer is not an object`);
  refuseLegacyError(what, result);
  if (!("permission" in result)) {
    throw new NearFormatError(`${what}.permission`, `${what}: the answer has no permission`);
  }
  blockOf(what, result);
  return viewOf(publicKey, result.nonce, result.permission);
}

// ---------- audit ----------

export type FindingSeverity = "block" | "warn" | "info";
export type KeyFindingCode =
  | "malformed_list"
  | "full_access"
  | "unknown_permission"
  | "any_method"
  | "self_receiver"
  | "unlimited_allowance"
  | "gas_key"
  | "not_in_policy"
  | "allowance_above_limit";

/** One thing the audit found. `text` is a plain sentence, safe to print on one line. */
export interface KeyFinding {
  code: KeyFindingCode;
  severity: FindingSeverity;
  /** null for a finding about the whole list (malformed_list). */
  publicKey: string | null;
  text: string;
}

/** What a function-call key may be. A key fits the rule when every given part matches. */
export interface KeyRule {
  receiverId: string;
  /** A non-empty exact set, order-insensitive. [] is a TypeError: on NEAR an empty list means every method. */
  methods: readonly string[];
  /** When given, the key's public key must be one of these. */
  publicKeys?: readonly string[];
  /** When given, the key's allowance (yoctoNEAR) must be at most this. */
  maxAllowance?: bigint;
  /** Default false: a key with no allowance limit does not fit. */
  allowUnlimitedAllowance?: boolean;
  /** Default false: a NEP-611 gas key does not fit, even with the right receiver and methods. */
  allowGasKey?: boolean;
}

export interface KeyPolicy {
  /** Default "forbid": a full-access key is a block finding. "allow" makes it a warning (the account is still not locked). */
  fullAccess?: "forbid" | "allow";
  /** When given, every key that does not act as full access must fit one rule ([] fits none). */
  rules?: readonly KeyRule[];
}

export interface AccessKeyAudit {
  accountId: string;
  blockHeight: number | null;
  blockHash: string | null;
  keys: readonly AccessKeyView[];
  findings: readonly KeyFinding[];
  /** The list parsed and no key acts as full access. */
  locked: boolean;
  /** No block finding under the policy; null without a policy. */
  policyOk: boolean | null;
}

interface CheckedRule {
  receiverId: string;
  methods: ReadonlySet<string>;
  publicKeys: ReadonlySet<string> | null;
  maxAllowance: bigint | null;
  allowUnlimitedAllowance: boolean;
  allowGasKey: boolean;
}

interface CheckedPolicy {
  fullAccess: "forbid" | "allow";
  rules: readonly CheckedRule[] | null;
}

const POLICY_FIELDS = new Set(["fullAccess", "rules"]);
const RULE_FIELDS = new Set([
  "receiverId",
  "methods",
  "publicKeys",
  "maxAllowance",
  "allowUnlimitedAllowance",
  "allowGasKey",
]);

function optionalFlag(value: unknown, where: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new TypeError(`${where} must be a boolean`);
  return value;
}

/** One rule as typed, refused with a TypeError when a part would not mean what it says. */
function checkRule(rule: unknown, at: string): CheckedRule {
  if (!isRecord(rule)) throw new TypeError(`${at} is not an object`);
  for (const field of Object.keys(rule)) {
    if (!RULE_FIELDS.has(field)) throw new TypeError(`${at}.${field} is not a rule field`);
  }
  if (!isAccountId(rule.receiverId)) throw new TypeError(`${at}.receiverId is not an account id`);
  const { methods } = rule;
  if (!Array.isArray(methods) || methods.length === 0) {
    throw new TypeError(`${at}.methods must be a non-empty list: [] means every method on NEAR`);
  }
  if (!methods.every((m) => typeof m === "string" && m.length > 0)) {
    throw new TypeError(`${at}.methods must hold method names`);
  }
  const methodSet = new Set<string>(methods as string[]);
  if (methodSet.size !== methods.length) throw new TypeError(`${at}.methods lists a method twice`);
  let publicKeys: Set<string> | null = null;
  if (rule.publicKeys !== undefined) {
    const keys = rule.publicKeys;
    if (!Array.isArray(keys) || keys.length === 0 || !keys.every(isPublicKey)) {
      throw new TypeError(
        `${at}.publicKeys must be a non-empty list of <curve>:<base58> keys (leave it out for any key)`,
      );
    }
    publicKeys = new Set<string>(keys as string[]);
  }
  let maxAllowance: bigint | null = null;
  if (rule.maxAllowance !== undefined) {
    const max = rule.maxAllowance;
    if (typeof max !== "bigint" || max < 0n || max > U128_MAX) {
      throw new TypeError(`${at}.maxAllowance must be a bigint from 0 to 2^128 - 1`);
    }
    maxAllowance = max;
  }
  return {
    receiverId: rule.receiverId,
    methods: methodSet,
    publicKeys,
    maxAllowance,
    allowUnlimitedAllowance: optionalFlag(
      rule.allowUnlimitedAllowance,
      `${at}.allowUnlimitedAllowance`,
    ),
    allowGasKey: optionalFlag(rule.allowGasKey, `${at}.allowGasKey`),
  };
}

/** A policy as typed, refused with a TypeError when a part would not mean what it says (a misspelt field too). */
function checkPolicy(policy: unknown): CheckedPolicy {
  const where = "auditAccessKeys: policy";
  if (!isRecord(policy)) throw new TypeError(`${where} is not an object`);
  for (const field of Object.keys(policy)) {
    if (!POLICY_FIELDS.has(field)) throw new TypeError(`${where}.${field} is not a policy field`);
  }
  const { fullAccess = "forbid", rules } = policy;
  if (fullAccess !== "forbid" && fullAccess !== "allow") {
    throw new TypeError(`${where}.fullAccess must be "forbid" or "allow"`);
  }
  if (rules === undefined) return { fullAccess, rules: null };
  if (!Array.isArray(rules)) throw new TypeError(`${where}.rules is not a list`);
  return {
    fullAccess,
    rules: rules.map((rule: unknown, i: number) => checkRule(rule, `${where}.rules[${i}]`)),
  };
}

const YOCTO_PER_NEAR = 10n ** 24n;

/** yoctoNEAR as NEAR, exact (no rounding): 246219350238132600000000 is "0.2462193502381326". */
function formatNear(yocto: bigint): string {
  const whole = yocto / YOCTO_PER_NEAR;
  const fraction = (yocto % YOCTO_PER_NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}

/** Method names come from the chain as any text; JSON quoting keeps them on one printable line. */
function methodList(methods: readonly string[]): string {
  return `[${methods.map((m) => JSON.stringify(m)).join(", ")}]`;
}

function sameSet(rule: ReadonlySet<string>, key: readonly string[]): boolean {
  const keySet = new Set(key);
  return keySet.size === rule.size && [...keySet].every((m) => rule.has(m));
}

interface RuleMiss {
  code: "not_in_policy" | "allowance_above_limit";
  why: string;
}

/** Why a function-call `key` misses `rule` past receiver, methods and public key (all matched), or null. */
function termsMiss(rule: CheckedRule, key: AccessKeyView): RuleMiss | null {
  if (key.gasKey !== null && !rule.allowGasKey) {
    return {
      code: "not_in_policy",
      why: "it is a NEP-611 gas key and the rule does not allow gas keys",
    };
  }
  if (key.allowance === "unlimited") {
    return rule.allowUnlimitedAllowance
      ? null
      : {
          code: "not_in_policy",
          why: "it has no allowance limit and the rule does not allow that",
        };
  }
  if (key.allowance !== null && rule.maxAllowance !== null && key.allowance > rule.maxAllowance) {
    return {
      code: "allowance_above_limit",
      why: `its allowance of ${formatNear(key.allowance)} NEAR is above the rule's bound of ${formatNear(rule.maxAllowance)} NEAR`,
    };
  }
  return null;
}

/** The policy finding for a key of a function-call kind, or null when one rule fits it. */
function policyFinding(rules: readonly CheckedRule[], key: AccessKeyView): KeyFinding | null {
  const methods = Array.isArray(key.methods) ? (key.methods as readonly string[]) : null;
  const candidates = rules.filter(
    (rule) =>
      rule.receiverId === key.receiverId &&
      methods !== null &&
      sameSet(rule.methods, methods) &&
      (rule.publicKeys === null || rule.publicKeys.has(key.publicKey)),
  );
  const misses: RuleMiss[] = [];
  for (const rule of candidates) {
    const miss = termsMiss(rule, key);
    if (miss === null) return null;
    misses.push(miss);
  }
  const pk = key.publicKey;
  const above = misses.find((m) => m.code === "allowance_above_limit");
  if (above !== undefined) {
    return { code: above.code, severity: "block", publicKey: pk, text: `${pk}: ${above.why}.` };
  }
  const scope =
    methods === null
      ? `every method of ${key.receiverId}`
      : `methods ${methodList(methods)} on ${key.receiverId}`;
  const why =
    misses[0] !== undefined
      ? `a rule names this receiver and these methods, but ${misses[0].why}`
      : "no rule names this receiver, this exact set of methods and this public key";
  return {
    code: "not_in_policy",
    severity: "block",
    publicKey: pk,
    text: `${pk} (${scope}) does not fit the policy: ${why}.`,
  };
}

function gasKeyText(publicKey: string, gas: GasKey): string {
  return `${publicKey} is a NEP-611 gas key with its own balance of ${formatNear(gas.balance)} NEAR for gas and ${gas.numNonces} nonces.`;
}

/** The findings of one key, in a fixed order. */
function keyFindings(
  accountId: string,
  key: AccessKeyView,
  policy: CheckedPolicy | null,
): KeyFinding[] {
  const out: KeyFinding[] = [];
  const pk = key.publicKey;
  const add = (code: KeyFindingCode, severity: FindingSeverity, text: string): void => {
    out.push({ code, severity, publicKey: pk, text });
  };
  if (key.kind === "unknown") {
    const parsed = classify(key.raw);
    const problem = parsed.ok ? "unreadable" : parsed.problem;
    add(
      "unknown_permission",
      "block",
      `${pk} has a permission this audit cannot read (${problem}), so it counts as full access.`,
    );
    return out;
  }
  if (key.actsAsFullAccess) {
    const gas =
      key.gasKey === null
        ? ""
        : ` (a NEP-611 gas key with ${formatNear(key.gasKey.balance)} NEAR for gas)`;
    add(
      "full_access",
      policy?.fullAccess === "allow" ? "warn" : "block",
      `${pk} is a full-access key${gas}: whoever holds it can deploy code, add and delete keys, move NEAR and delete the account.`,
    );
    if (key.gasKey !== null) add("gas_key", "info", gasKeyText(pk, key.gasKey));
    return out;
  }
  const anyMethod = key.methods === "any";
  if (anyMethod) {
    add(
      "any_method",
      "warn",
      `${pk} can call every method of ${key.receiverId} (its method_names list is empty).`,
    );
  }
  if (key.receiverId === accountId) {
    add(
      "self_receiver",
      anyMethod ? "warn" : "info",
      anyMethod
        ? `${pk} can call any method of the account's own contract, and near-sdk #[private] methods accept those calls, since they come from the account itself.`
        : `${pk} calls the account's own contract, so what it can do is what that code lets the account itself do.`,
    );
  }
  if (key.allowance === "unlimited") {
    add(
      "unlimited_allowance",
      policy?.rules ? "info" : "warn",
      `${pk} has no allowance limit: whoever holds it can spend the account's NEAR on gas.`,
    );
  }
  if (key.gasKey !== null) add("gas_key", "info", gasKeyText(pk, key.gasKey));
  if (policy?.rules) {
    const finding = policyFinding(policy.rules, key);
    if (finding !== null) out.push(finding);
  }
  return out;
}

/**
 * Audits a `view_access_key_list` answer for `accountId`. Pure and total over the answer: a list that does not
 * parse is one block finding (`malformed_list`) with `locked: false`, so a caller cannot skip the verdict by
 * catching. Throws TypeError for an invalid account id or policy (caller input, refused before the list is read).
 *
 * Findings: `full_access` and `unknown_permission` block (`fullAccess: "allow"` makes the first a warning);
 * `any_method` warns; `self_receiver` is info, a warning together with `any_method` (near-sdk `#[private]` methods
 * accept calls from such a key); `unlimited_allowance` warns without policy rules (info with them: the rules decide);
 * `gas_key` is info. With `rules`, every key that does not act as full access must fit one rule, else
 * `not_in_policy` or, when a rule fits but for its allowance bound, `allowance_above_limit` (both block).
 */
export function auditAccessKeys(
  accountId: string,
  viewAccessKeyList: unknown,
  policy?: KeyPolicy,
): AccessKeyAudit {
  if (!isAccountId(accountId)) {
    throw new TypeError("auditAccessKeys: accountId is not a NEAR account id");
  }
  const checked = policy === undefined ? null : checkPolicy(policy);
  let parsed: ReturnType<typeof parseAccessKeyList>;
  try {
    parsed = parseAccessKeyList(viewAccessKeyList);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      accountId,
      blockHeight: null,
      blockHash: null,
      keys: [],
      findings: [
        {
          code: "malformed_list",
          severity: "block",
          publicKey: null,
          text: `The access key list could not be read (${message}), so nothing about the keys is known.`,
        },
      ],
      locked: false,
      policyOk: checked === null ? null : false,
    };
  }
  const findings = parsed.keys.flatMap((key) => keyFindings(accountId, key, checked));
  return {
    accountId,
    blockHeight: parsed.blockHeight,
    blockHash: parsed.blockHash,
    keys: parsed.keys,
    findings,
    locked: parsed.keys.every((key) => !key.actsAsFullAccess),
    policyOk: checked === null ? null : findings.every((f) => f.severity !== "block"),
  };
}
