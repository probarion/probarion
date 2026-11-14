// N3 (account lock audit): what code an account runs (NEP-591 global contracts included), whether it is a recorded
// build, and the account lock report that joins the key audit with the code. Lifted from @probarion/core verify.ts
// (`normalizeCodeHash`, the all-zero rule of check f) and @probarion/sdk (`codeIdentity`, payee-signals `codeOf`),
// with the NEP-591 kinds kept apart instead of folded into one hash. Pure: no network, no clock.
import {
  type AccessKeyAudit,
  type AccessKeyView,
  auditAccessKeys,
  type KeyPolicy,
} from "./access-keys.js";
import {
  bytesToHex,
  decodeBase58Hash,
  encodeBase58,
  isAccountId,
  isRecord,
  sha256,
} from "./encoding.js";

/** What code an account runs, as its `view_account` answer states it. */
export type CodeIdentity =
  /** All-zero code_hash and no global contract. */
  | { kind: "none" }
  /** The account's own deployed code; a DeployContract action replaces it. */
  | { kind: "local"; codeHash: string }
  /** NEP-591 global contract used by hash: fixed code. */
  | { kind: "global_by_hash"; codeHash: string }
  /** NEP-591 global contract used by account id: it follows the publisher's latest deploy. */
  | { kind: "global_by_account"; publisher: string }
  | { kind: "malformed"; problem: string };

function isZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

/** An optional `view_account` field: absent and null read as null; present, it must pass `check`. */
function optionalField(
  view: Record<string, unknown>,
  field: string,
  check: (value: unknown) => boolean,
): { ok: true; value: string | null } | { ok: false } {
  const value = view[field];
  if (value === undefined || value === null) return { ok: true, value: null };
  return typeof value === "string" && check(value) ? { ok: true, value } : { ok: false };
}

/**
 * The code identity of a `view_account` answer. nearcore reports an account that uses a global contract with an
 * all-zero `code_hash` and `global_contract_hash` (by hash) or `global_contract_account_id` (by account), and omits
 * both fields otherwise. Every other combination is `malformed`: a hash that is not 32 canonical base58 bytes, both
 * global fields at once, a global field next to own code, an all-zero global hash. Total: never throws.
 */
export function codeIdentityOf(viewAccount: unknown): CodeIdentity {
  const malformed = (problem: string): CodeIdentity => ({ kind: "malformed", problem });
  if (!isRecord(viewAccount)) return malformed("the view_account answer is not an object");
  if (typeof viewAccount.error === "string") {
    return malformed("the view_account answer is an error, not a view");
  }
  const own = decodeBase58Hash(viewAccount.code_hash);
  if (own === null) return malformed("code_hash is not a 32-byte base58 hash");
  const byHash = optionalField(
    viewAccount,
    "global_contract_hash",
    (v) => decodeBase58Hash(v) !== null,
  );
  if (!byHash.ok) return malformed("global_contract_hash is not a 32-byte base58 hash");
  const byAccount = optionalField(viewAccount, "global_contract_account_id", isAccountId);
  if (!byAccount.ok) return malformed("global_contract_account_id is not an account id");
  if (byHash.value !== null && byAccount.value !== null) {
    return malformed("the answer names a global contract both by hash and by account");
  }
  const global = byHash.value ?? byAccount.value;
  if (global !== null && !isZero(own)) {
    return malformed("the answer names a global contract next to the account's own code");
  }
  if (byHash.value !== null) {
    if (isZero(decodeBase58Hash(byHash.value) as Uint8Array)) {
      return malformed("global_contract_hash is the all-zero hash");
    }
    return { kind: "global_by_hash", codeHash: byHash.value };
  }
  if (byAccount.value !== null) return { kind: "global_by_account", publisher: byAccount.value };
  if (isZero(own)) return { kind: "none" };
  return { kind: "local", codeHash: viewAccount.code_hash as string };
}

const HEX64_RE = /^[0-9a-fA-F]{64}$/;

/**
 * A code hash as lowercase hex, from base58 (as NEAR RPC prints it) or 64 hex digits in either case (as some build
 * tools print it), so the two spellings compare equal. Null for anything else; never throws.
 */
export function normalizeCodeHash(hash: string): string | null {
  if (typeof hash !== "string") return null;
  if (HEX64_RE.test(hash)) return hash.toLowerCase();
  const bytes = decodeBase58Hash(hash);
  return bytes === null ? null : bytesToHex(bytes);
}

/** NEAR's `code_hash` of a wasm file: base58 of its sha256. Compare it with `view_account` and a build record. */
export function wasmCodeHash(wasm: Uint8Array): string {
  if (!(wasm instanceof Uint8Array)) throw new TypeError("wasmCodeHash: wasm is not a Uint8Array");
  return encodeBase58(sha256(wasm));
}

/** One build record, as an entry of contracts/code-hashes.json (extra fields are kept and ignored). */
export interface RecordedBuild {
  code_hash: string;
  crate?: string;
  version?: string;
  commit?: string;
  built_with?: string;
}

export type BuildMatch =
  | { ok: true; build: RecordedBuild }
  | { ok: false; code: "no_code" | "mutable_code" | "not_recorded" | "malformed"; text: string };

type Builds = readonly RecordedBuild[] | { entries: readonly RecordedBuild[] };

/** The entries of `builds`, each with its normalized hash; TypeError for a list or entry that does not read. */
function buildEntries(builds: unknown, where: string): { build: RecordedBuild; hex: string }[] {
  const entries = Array.isArray(builds) ? builds : isRecord(builds) ? builds.entries : undefined;
  if (!Array.isArray(entries)) {
    throw new TypeError(
      `${where}: builds is neither a list nor a record file with an entries list`,
    );
  }
  const zero = "0".repeat(64);
  return entries.map((build: unknown, i: number) => {
    const hex =
      isRecord(build) && typeof build.code_hash === "string"
        ? normalizeCodeHash(build.code_hash)
        : null;
    if (hex === null || hex === zero) {
      throw new TypeError(`${where}: builds[${i}].code_hash is not a sha256 hash in base58 or hex`);
    }
    return { build: build as unknown as RecordedBuild, hex };
  });
}

/**
 * Whether the account's code is one of `builds`: a list, or a code-hashes record file (`{ entries }`, the shape of
 * contracts/code-hashes.json). Base58 and hex spellings compare equal. No code, code that follows a publisher account
 * (`mutable_code`: the publisher can replace it, so a match today says nothing about tomorrow) and a malformed
 * identity do not match. Throws TypeError for a builds list or entry that does not read (and the all-zero hash,
 * which is no build).
 */
export function matchRecordedBuild(identity: CodeIdentity, builds: Builds): BuildMatch {
  const entries = buildEntries(builds, "matchRecordedBuild");
  switch (identity.kind) {
    case "none":
      return { ok: false, code: "no_code", text: "The account has no contract code to match." };
    case "global_by_account":
      return {
        ok: false,
        code: "mutable_code",
        text: `The account runs the global contract that ${identity.publisher} publishes, which ${identity.publisher} can replace, so no recorded build can vouch for it.`,
      };
    case "malformed":
      return {
        ok: false,
        code: "malformed",
        text: `The code identity could not be read (${identity.problem}).`,
      };
    default: {
      const hex = normalizeCodeHash(identity.codeHash);
      const found = entries.find((entry) => entry.hex === hex);
      if (found !== undefined) return { ok: true, build: found.build };
      return {
        ok: false,
        code: "not_recorded",
        text: `Code hash ${identity.codeHash} is not among the ${entries.length} recorded builds.`,
      };
    }
  }
}

// ---------- the report ----------

export interface AccountLockReport {
  accountId: string;
  keys: AccessKeyAudit;
  code: CodeIdentity;
  build: BuildMatch | null;
  /** keys.locked, and the code is neither global_by_account nor malformed. */
  locked: boolean;
  /** locked, policyOk !== false, and build null or ok. */
  ok: boolean;
  /** Plain sentences for CLI output, one per line. */
  lines: readonly string[];
}

const YOCTO_PER_NEAR = 10n ** 24n;

/** yoctoNEAR as NEAR, exact (no rounding). */
function formatNear(yocto: bigint): string {
  const whole = yocto / YOCTO_PER_NEAR;
  const fraction = (yocto % YOCTO_PER_NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}

/** Text from a build record file, printed when it is short plain ASCII (the file is the caller's, not the chain's). */
function printable(value: unknown): string | null {
  return typeof value === "string" && /^[\x20-\x7e]{1,160}$/.test(value) ? value : null;
}

/** Control, format and separator code points (Unicode Cc, Cf, Zl, Zp), as in access-keys.ts. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** A method name from the chain, JSON-quoted, with each control, format or separator code point as \uXXXX. */
function quoteText(text: string): string {
  return JSON.stringify(text).replace(UNPRINTABLE, (ch) =>
    Array.from(
      { length: ch.length },
      (_, i) => `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`,
    ).join(""),
  );
}

function describeKey(key: AccessKeyView): string {
  switch (key.kind) {
    case "unknown":
      return "a permission this audit cannot read, counted as full access";
    case "full_access":
    case "gas_key_full_access":
      return key.gasKey === null
        ? "full access"
        : `full access, a NEP-611 gas key with ${formatNear(key.gasKey.balance)} NEAR for gas and ${key.gasKey.numNonces} nonces`;
    default: {
      const methods =
        key.methods === "any"
          ? "any method"
          : `methods [${(key.methods ?? []).map(quoteText).join(", ")}]`;
      // NEP-611: a gas key takes no allowance; it pays for its gas from its own balance, not the account's.
      if (key.gasKey !== null) {
        return `function call on ${key.receiverId}, ${methods}, a NEP-611 gas key that pays for its gas from its own balance of ${formatNear(key.gasKey.balance)} NEAR, with ${key.gasKey.numNonces} nonces`;
      }
      const allowance =
        key.allowance === "unlimited" || key.allowance === null
          ? "no allowance limit"
          : `an allowance of ${formatNear(key.allowance)} NEAR for gas`;
      return `function call on ${key.receiverId}, ${methods}, ${allowance}`;
    }
  }
}

function describeCode(code: CodeIdentity): string {
  switch (code.kind) {
    case "none":
      return "Code: none (the all-zero code hash, no global contract).";
    case "local":
      return `Code: the account's own code, hash ${code.codeHash}. A DeployContract action replaces it; that takes a full-access key or the contract itself.`;
    case "global_by_hash":
      return `Code: the NEP-591 global contract with hash ${code.codeHash}, used by hash, so the code stays fixed while the account uses it. Switching takes a full-access key or the contract itself.`;
    case "global_by_account":
      return `Code: the NEP-591 global contract that ${code.publisher} publishes, used by account: when ${code.publisher} deploys new code under its account id, this account runs the new code.`;
    case "malformed":
      return `Code: the view_account answer could not be read (${code.problem}).`;
  }
}

function describeBuild(build: BuildMatch): string {
  if (!build.ok) return `Build: ${build.text}`;
  const parts = [
    printable(build.build.crate),
    printable(build.build.version),
    printable(build.build.commit) === null ? null : `commit ${printable(build.build.commit)}`,
    printable(build.build.built_with) === null
      ? null
      : `built with ${printable(build.build.built_with)}`,
  ].filter((part): part is string => part !== null);
  const what = parts.length === 0 ? "" : `: ${parts.join(", ")}`;
  return `Build: the code hash matches a recorded build${what}.`;
}

function verdict(report: Omit<AccountLockReport, "lines">): string {
  const reasons: string[] = [];
  const { keys, code, build } = report;
  if (keys.findings.some((f) => f.code === "malformed_list")) {
    reasons.push("the key list could not be read");
  } else {
    const full = keys.keys.filter((k) => k.actsAsFullAccess).length;
    if (full > 0) reasons.push(`${full} ${full === 1 ? "key acts" : "keys act"} as full access`);
  }
  if (code.kind === "global_by_account") reasons.push(`the code follows ${code.publisher}`);
  if (code.kind === "malformed") reasons.push("the code identity could not be read");
  if (keys.policyOk === false) reasons.push("a key does not fit the policy");
  if (build !== null && !build.ok) reasons.push("the code is not a recorded build");
  if (reasons.length > 0) return `Verdict: not ok, since ${reasons.join("; ")}.`;
  const warnings = keys.findings.filter((f) => f.severity === "warn").length;
  const head =
    warnings === 0
      ? "Verdict: ok, the account is locked"
      : `Verdict: ok, the account is locked, with ${warnings} ${warnings === 1 ? "warning" : "warnings"}`;
  // A key for every method of the account's own code reaches its #[private] methods too: if that code can deploy,
  // migrate or add a key, the key holder can. Policy rules name a non-empty method set, so under rules such a key is
  // a block finding already; without rules the verdict names it, so it does not read like an account of scoped keys.
  const selfAny =
    code.kind === "local" || code.kind === "global_by_hash"
      ? keys.keys.filter(
          (k) => !k.actsAsFullAccess && k.methods === "any" && k.receiverId === report.accountId,
        )
      : [];
  if (selfAny.length === 0) return `${head}.`;
  const who =
    selfAny.length === 1
      ? `key ${selfAny[0]?.publicKey} can`
      : `keys ${selfAny.map((k) => k.publicKey).join(", ")} can`;
  return `${head}; the lock rests on the account's code, since ${who} call every method of it, #[private] methods included.`;
}

/**
 * The account lock report: the key audit (`auditAccessKeys` with `opts.policy`), the code identity, and, when
 * `opts.builds` is given, whether the code is a recorded build. Pure; throws TypeError for an invalid account id,
 * policy or builds list, as `auditAccessKeys` and `matchRecordedBuild` do, and nothing for a garbled view (it shows
 * in the report). Pass both views from one block (`readAccountLock` does).
 */
export function accountLockReport(
  accountId: string,
  viewAccount: unknown,
  viewAccessKeyList: unknown,
  opts: { policy?: KeyPolicy; builds?: Builds } = {},
): AccountLockReport {
  const keys = auditAccessKeys(accountId, viewAccessKeyList, opts.policy);
  // Checked even when the code would not reach the comparison, so a bad builds file is refused every time.
  if (opts.builds !== undefined) buildEntries(opts.builds, "accountLockReport");
  const code = codeIdentityOf(viewAccount);
  const build = opts.builds === undefined ? null : matchRecordedBuild(code, opts.builds);
  const locked = keys.locked && code.kind !== "global_by_account" && code.kind !== "malformed";
  const ok = locked && keys.policyOk !== false && (build === null || build.ok);
  const base = { accountId, keys, code, build, locked, ok };

  const lines: string[] = [];
  const at =
    keys.blockHeight === null
      ? "at the block of the views given"
      : `at block ${keys.blockHeight}${keys.blockHash === null ? "" : ` (${keys.blockHash})`}`;
  const n = keys.keys.length;
  const full = keys.keys.filter((k) => k.actsAsFullAccess).length;
  const listed = keys.findings.some((f) => f.code === "malformed_list")
    ? "an access key list that could not be read"
    : n === 0
      ? "no access keys"
      : `${n} access ${n === 1 ? "key" : "keys"}, ${full === 0 ? "none" : full} with full access`;
  lines.push(`Account ${accountId} ${at}: ${listed}.`);
  for (const key of keys.keys) lines.push(`Key ${key.publicKey}: ${describeKey(key)}.`);
  for (const finding of keys.findings) lines.push(`${finding.severity}: ${finding.text}`);
  lines.push(describeCode(code));
  if (build !== null) lines.push(describeBuild(build));
  if (keys.keys.some((k) => !k.actsAsFullAccess)) {
    lines.push(
      "Function-call keys cannot attach a deposit, so they cannot call methods that need 1 yoctoNEAR, such as ft_transfer.",
    );
  }
  if (keys.locked) {
    lines.push(
      "With no full-access key, the keys change through the account's own code, so the code identity matters.",
    );
  }
  lines.push(
    keys.blockHeight === null
      ? "This audit holds for the views given; a later block can differ."
      : `This audit holds at block ${keys.blockHeight}; a later block can differ.`,
  );
  lines.push(verdict(base));
  return { ...base, lines };
}
