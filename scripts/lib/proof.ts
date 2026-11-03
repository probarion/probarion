import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

export const TX_KINDS = [
  "deploy",
  "lock",
  "global_code",
  "factory_init",
  "vault_created",
  "mandate_created",
  "agent_added",
  "ledger_key_set",
  "near_payment",
  "base_payout",
  "held",
  "approved",
  "rejected",
  "refused_on_chain",
  "anchor",
  "freeze",
  "unfreeze",
  "withdraw",
  "intents_topup",
  "mcp_spend",
  "canary_attempt",
  "pilot_payment",
  "other",
] as const;
export type TxKind = (typeof TX_KINDS)[number];

export const SIGNED_BY = [
  "owner",
  "approver",
  "agent_key",
  "ledger_key",
  "deployer",
  "pilot",
  "canary_visitor",
] as const;
export type SignedBy = (typeof SIGNED_BY)[number];

export const SECTIONS = [
  "accounts",
  "code_hashes",
  "versions",
  "verify",
  "clean_clone",
  "metrics",
  "links",
  "facts",
] as const;
export type Section = (typeof SECTIONS)[number];

export type Scalar = string | number | boolean;

export interface TxEntry {
  hash: string;
  network: "mainnet" | "testnet";
  signer_id: string;
  receiver_id: string;
  kind: TxKind;
  what: string;
  signed_by: SignedBy;
  expect: "success" | "failure";
  error_code: string | null; // e.g. "NoMandate" for an expected PROBARION:NoMandate panic
  spend_id: number | null;
  amount_usdc: string | null; // human USDC, e.g. "2.00"
  base_tx: string | null; // Base settlement tx for a base_payout
  recorded_at: string;
}

export interface ProofFile {
  v: 1;
  updated_at: string;
  accounts: Record<string, string>;
  code_hashes: Record<string, string>;
  versions: Record<string, string>;
  verify: Record<string, Scalar>;
  clean_clone: Record<string, Scalar>;
  metrics: Record<string, Scalar>;
  links: Record<string, string>;
  facts: Record<string, Scalar>; // e.g. factory_mode, chains_wired
  txs: Record<string, TxEntry>;
  sources: Record<string, string>; // "<section>.<key>" -> command or URL that produced the value
}

export const ID_RE = /^[a-z][a-z0-9_]{1,62}$/;
// A base58 32-byte hash is 42-44 characters; 41 leaves a margin. Also used for code_hashes.
export const NEAR_TX_HASH_RE = /^[1-9A-HJ-NP-Za-km-z]{41,44}$/;
export const BASE_TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
export const NEAR_ACCOUNT_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const ERROR_CODE_RE = /^[A-Z][A-Za-z]+$/;
const USDC_HUMAN_RE = /^(0|[1-9]\d{0,11})(\.\d{1,6})?$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

export function emptyProof(now: Date): ProofFile {
  return {
    v: 1,
    updated_at: now.toISOString(),
    accounts: {},
    code_hashes: {},
    versions: {},
    verify: {},
    clean_clone: {},
    metrics: {},
    links: {},
    facts: {},
    txs: {},
    sources: {},
  };
}

function validateSectionValue(section: Section, key: string, value: unknown): string | null {
  const where = `${section}.${key}`;
  switch (section) {
    case "accounts":
      return typeof value === "string" && NEAR_ACCOUNT_RE.test(value)
        ? null
        : `${where} must be a NEAR account id`;
    case "code_hashes":
      return typeof value === "string" && NEAR_TX_HASH_RE.test(value)
        ? null
        : `${where} must be a base58 code hash`;
    case "versions":
      return typeof value === "string" && SEMVER_RE.test(value)
        ? null
        : `${where} must be a semver string`;
    case "links":
      return typeof value === "string" && /^https:\/\/\S+$/.test(value)
        ? null
        : `${where} must be an https URL`;
    default:
      return (typeof value === "string" && value.length > 0) ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
        ? null
        : `${where} must be a non-empty string, a finite number or a boolean`;
  }
}

export function validateTx(id: string, t: unknown): string[] {
  const w = `txs.${id}`;
  const e: string[] = [];
  if (!ID_RE.test(id)) e.push(`${w}: id must match ${ID_RE}`);
  if (!isObject(t)) return [...e, `${w} must be an object`];
  if (typeof t.hash !== "string" || !NEAR_TX_HASH_RE.test(t.hash))
    e.push(`${w}.hash must be a base58 NEAR tx hash`);
  if (t.network !== "mainnet" && t.network !== "testnet")
    e.push(`${w}.network must be mainnet or testnet`);
  for (const f of ["signer_id", "receiver_id"] as const) {
    if (typeof t[f] !== "string" || !NEAR_ACCOUNT_RE.test(t[f] as string))
      e.push(`${w}.${f} must be a NEAR account id`);
  }
  if (!TX_KINDS.includes(t.kind as TxKind))
    e.push(`${w}.kind must be one of ${TX_KINDS.join(", ")}`);
  if (typeof t.what !== "string" || t.what.trim().length < 5)
    e.push(`${w}.what must describe the transaction`);
  if (!SIGNED_BY.includes(t.signed_by as SignedBy))
    e.push(`${w}.signed_by must be one of ${SIGNED_BY.join(", ")}`);
  if (t.expect !== "success" && t.expect !== "failure")
    e.push(`${w}.expect must be success or failure`);
  if (
    t.expect === "failure" &&
    !(typeof t.error_code === "string" && ERROR_CODE_RE.test(t.error_code))
  ) {
    e.push(`${w}.error_code is required for an expected failure (e.g. NoMandate)`);
  }
  if (t.expect === "success" && t.error_code !== null)
    e.push(`${w}.error_code must be null for an expected success`);
  if (t.spend_id !== null && !(Number.isInteger(t.spend_id) && (t.spend_id as number) >= 0)) {
    e.push(`${w}.spend_id must be null or a non-negative integer`);
  }
  if (
    t.amount_usdc !== null &&
    !(typeof t.amount_usdc === "string" && USDC_HUMAN_RE.test(t.amount_usdc))
  ) {
    e.push(`${w}.amount_usdc must be null or a decimal USDC string`);
  }
  if (t.base_tx !== null && !(typeof t.base_tx === "string" && BASE_TX_HASH_RE.test(t.base_tx))) {
    e.push(`${w}.base_tx must be null or a 0x-prefixed 32-byte hash`);
  }
  if (typeof t.recorded_at !== "string" || Number.isNaN(Date.parse(t.recorded_at)))
    e.push(`${w}.recorded_at must be ISO-8601`);
  return e;
}

export function validateProof(input: unknown): string[] {
  if (!isObject(input)) return ["proof file must be a JSON object"];
  const errors: string[] = [];
  if (input.v !== 1) errors.push("v must be 1");
  if (typeof input.updated_at !== "string" || Number.isNaN(Date.parse(input.updated_at)))
    errors.push("updated_at must be ISO-8601");
  for (const section of SECTIONS) {
    const s = input[section];
    if (!isObject(s)) {
      errors.push(`${section} must be an object`);
      continue;
    }
    for (const [k, v] of Object.entries(s)) {
      if (!ID_RE.test(k)) errors.push(`${section}.${k}: key must match ${ID_RE}`);
      const err = validateSectionValue(section, k, v);
      if (err) errors.push(err);
    }
  }
  if (!isObject(input.sources)) errors.push("sources must be an object");
  else {
    for (const [k, v] of Object.entries(input.sources)) {
      if (!/^[a-z_]+\.[a-z0-9_]+$/.test(k))
        errors.push(`sources.${k}: key must be <section>.<key>`);
      if (typeof v !== "string" || v.trim().length === 0)
        errors.push(`sources.${k} must say where the value came from`);
    }
  }
  if (!isObject(input.txs)) errors.push("txs must be an object");
  else {
    const seen = new Map<string, string>();
    for (const [id, t] of Object.entries(input.txs)) {
      errors.push(...validateTx(id, t));
      const hash = isObject(t) && typeof t.hash === "string" ? t.hash : null;
      if (hash) {
        const prev = seen.get(hash);
        if (prev) errors.push(`txs.${id}.hash duplicates txs.${prev}.hash`);
        else seen.set(hash, id);
      }
    }
  }
  return errors;
}

export function addTx(
  p: ProofFile,
  id: string,
  entry: Omit<TxEntry, "recorded_at">,
  now: Date,
): ProofFile {
  if (p.txs[id])
    throw new Error(`txs.${id} already exists; pick a new id (entries are never overwritten)`);
  const full: TxEntry = { ...entry, recorded_at: now.toISOString() };
  const errors = validateTx(id, full);
  if (errors.length) throw new Error(errors.join("\n"));
  const dup = Object.entries(p.txs).find(([, t]) => t.hash === full.hash);
  if (dup) throw new Error(`hash already recorded as txs.${dup[0]}`);
  return { ...p, updated_at: now.toISOString(), txs: { ...p.txs, [id]: full } };
}

export function setValue(
  p: ProofFile,
  path: string,
  value: Scalar,
  source: string,
  now: Date,
): ProofFile {
  if (source.trim().length === 0)
    throw new Error("source is required: say which command or URL produced the value");
  const [section, key, ...rest] = path.split(".");
  if (rest.length > 0 || !key) throw new Error(`path must be <section>.<key>, got ${path}`);
  if (!SECTIONS.includes(section as Section))
    throw new Error(`section must be one of ${SECTIONS.join(", ")}`);
  if (!ID_RE.test(key)) throw new Error(`key must match ${ID_RE}`);
  const err = validateSectionValue(section as Section, key, value);
  if (err) throw new Error(err);
  const s = section as Section;
  const updated = { ...(p[s] as Record<string, Scalar>), [key]: value };
  return {
    ...p,
    updated_at: now.toISOString(),
    [s]: updated,
    sources: { ...p.sources, [path]: source.trim() },
  } as ProofFile;
}

/** The current value at `<section>.<key>`, or undefined when none is recorded. */
export function getValue(p: ProofFile, path: string): Scalar | undefined {
  const [section, key, ...rest] = path.split(".");
  if (rest.length > 0 || !key || !SECTIONS.includes(section as Section)) return undefined;
  return (p[section as Section] as Record<string, Scalar>)[key];
}

function sortKeys(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (isObject(x))
    return Object.fromEntries(
      Object.keys(x)
        .sort()
        .map((k) => [k, sortKeys(x[k])]),
    );
  return x;
}

export function serializeProof(p: ProofFile): string {
  return `${JSON.stringify(sortKeys(p), null, 2)}\n`;
}

export function readProof(path: string): ProofFile {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const errors = validateProof(parsed);
  if (errors.length) throw new Error(`${path} is invalid:\n- ${errors.join("\n- ")}`);
  return parsed as ProofFile;
}

export function writeProof(path: string, p: ProofFile): void {
  const errors = validateProof(p);
  if (errors.length)
    throw new Error(`refusing to write an invalid proof file:\n- ${errors.join("\n- ")}`);
  // Write a sibling temp file, then rename it over the target. A crash or a failed write leaves the
  // previous file intact; a leftover *.tmp is never read (readProof only opens `path`).
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, serializeProof(p));
    renameSync(tmp, path);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best effort: the caller must see the original error, not a cleanup error
    }
    throw e;
  }
}
