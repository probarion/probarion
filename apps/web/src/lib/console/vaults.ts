import {
  type FactoryConfig,
  KNOWN_VAULT_CODE_HASHES,
  type MandateView,
  type SpendView,
  type VaultConfig,
  type VersionView,
} from "@probarion/core";
import { FactoryClient, type RpcClient, type ViewAccountResult } from "@probarion/sdk";
import type { Network } from "@/lib/config";
import { type Db, DbError } from "@/lib/db/port";
import { registerTenant, type TenantKind } from "@/lib/db/tenants";
import { log } from "@/lib/log";
import { type ChainErrorKind, chainErrorKind, listAll, type VaultReader } from "@/lib/near/reader";
import {
  createDepositPlan,
  type FactoryMode,
  MAX_CREATE_DEPOSIT_YOCTO,
  type NearRunway,
  nearRunway,
} from "@/lib/near/runway";
import { createVaultTx, type WalletTx } from "@/lib/near/tx";
import { AmountError, formatNear, hoursToNs, parseNear, parseUsdc } from "@/lib/near/units";
import { isNearAccountId } from "@/lib/near/validate";

/** `^[a-z0-9][a-z0-9_-]{1,30}$` (interfaces §5, contracts/factory `valid_name`). */
export const VAULT_NAME = /^[a-z0-9][a-z0-9_-]{1,30}$/;
/** contracts/factory MAX_APPROVERS, the vault's own limit. */
export const MAX_APPROVERS = 10;
/** contracts/factory MAX_HELD_TTL_NS is 30 days. */
export const MAX_HELD_TTL_HOURS = 720;

/** The chain reads registerVault and loadOverview need besides the vault's own views. */
export interface ChainReads {
  viewAccount(account: string): Promise<ViewAccountResult>;
  factoryVersions(factory: string): Promise<VersionView[]>;
}

/** ChainReads over the SDK RpcClient (`getRpc()` on the server). */
export function rpcChainReads(rpc: RpcClient): ChainReads {
  return {
    viewAccount: (account) => rpc.viewAccount(account),
    factoryVersions: (factory) => new FactoryClient(factory, rpc).versions(),
  };
}

// ---- reads that may fail -------------------------------------------------------------------------

/**
 * One chain read, kept apart from the others so that a failure shows as "unavailable" for that
 * part of the page only, never as a zero or an empty list. `kind` says why; the page shows them alike.
 */
export type Read<T> =
  | { ok: true; value: T }
  | { ok: false; kind: ChainErrorKind | "error" | "skipped" | "not_allowed" };

async function read<T>(what: string, vault: string, run: () => Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    const kind = chainErrorKind(e) ?? "error";
    log.warn("console.read_failed", { what, vault, kind });
    return { ok: false, kind };
  }
}

const SKIPPED = { ok: false, kind: "skipped" } as const;

const DIGITS = /^(0|[1-9][0-9]*)$/;
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

/**
 * The SDK passes get_config through as the contract sent it. The overview renders every field, so an
 * answer of another shape is an unreadable answer ("rpc"), not something to render or to crash on.
 */
export function isVaultConfig(v: unknown): v is VaultConfig {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    isStr(c.owner) &&
    isStrList(c.approvers) &&
    isStr(c.usdc) &&
    isStr(c.intents) &&
    isStrList(c.allowed_assets) &&
    isStr(c.daily_backstop) &&
    DIGITS.test(c.daily_backstop) &&
    isStr(c.held_ttl_ns) &&
    DIGITS.test(c.held_ttl_ns) &&
    typeof c.frozen === "boolean" &&
    (c.factory === null || isStr(c.factory)) &&
    isStr(c.version) &&
    (c.ledger_key === null || isStr(c.ledger_key))
  );
}

// ---- create --------------------------------------------------------------------------------------

export interface CreateVaultForm {
  name: string;
  approvers: string; // comma/space separated
  dailyBackstopUsdc: string;
  heldTtlHours: string;
  depositNear: string;
}

export interface CreateVaultContext {
  factory: string;
  /** The factory's `min_deposit`, yoctoNEAR. */
  minDeposit: string;
  /** The current factory version's mode. */
  mode: FactoryMode;
  /** The signed-in account: it signs, so it becomes the owner. */
  owner: string;
}

export type CreateVaultCheck =
  | { ok: true; tx: WalletTx; vaultId: string; warnings: string[] }
  | { ok: false; errors: Partial<Record<keyof CreateVaultForm, string>> };

export function parseApprovers(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((a) => a.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * Checks the form against the factory's own rules (contracts/factory `valid_name`,
 * `valid_vault_init`, `required_deposit`) before the owner is asked to sign anything, so a deposit
 * is never sent into a call the factory would refuse.
 */
export function prepareCreateVault(
  form: CreateVaultForm,
  ctx: CreateVaultContext,
): CreateVaultCheck {
  const errors: Partial<Record<keyof CreateVaultForm, string>> = {};
  const warnings: string[] = [];
  const name = form.name.trim();
  const vaultId = `${name}.${ctx.factory}`;
  if (!VAULT_NAME.test(name)) {
    errors.name =
      "2–31 characters: lowercase letters, digits, - or _, starting with a letter or digit";
  } else if (!isNearAccountId(vaultId)) {
    errors.name = `${vaultId} is not a valid NEAR account id (no -, _ or . at the end, none twice in a row)`;
  }

  const approvers = parseApprovers(form.approvers);
  if (approvers.length === 0)
    errors.approvers = "Add at least one approver (a second person is best)";
  else if (approvers.length > MAX_APPROVERS)
    errors.approvers = `At most ${MAX_APPROVERS} approvers`;
  else if (approvers.some((a) => !isNearAccountId(a))) {
    errors.approvers = "Every approver must be a NEAR account id (lowercase)";
  } else if (approvers.length === 1 && approvers[0] === ctx.owner) {
    warnings.push(
      "You are the only approver, so a held payment needs nobody else's signature. A second person is safer.",
    );
  }

  let backstop = "";
  try {
    backstop = parseUsdc(form.dailyBackstopUsdc);
    if (BigInt(backstop) <= 0n) errors.dailyBackstopUsdc = "Must be above 0";
  } catch (e) {
    errors.dailyBackstopUsdc = e instanceof AmountError ? e.message : "Invalid amount";
  }

  const hoursText = form.heldTtlHours.trim();
  const hours = /^[0-9]{1,4}$/.test(hoursText) ? Number(hoursText) : Number.NaN;
  if (!(hours >= 1 && hours <= MAX_HELD_TTL_HOURS)) {
    errors.heldTtlHours = `Whole hours from 1 to ${MAX_HELD_TTL_HOURS}`;
  }

  let deposit = "";
  try {
    deposit = parseNear(form.depositNear);
    const plan = createDepositPlan(ctx.minDeposit, ctx.mode, BigInt(deposit));
    if (BigInt(deposit) < plan.requiredYocto) {
      errors.depositNear =
        ctx.mode === "embedded"
          ? `Below what the factory requires in embedded mode: ${formatNear(plan.requiredYocto.toString(), 6)} NEAR (min_deposit plus the storage of the vault's copy of its code)`
          : `Below the factory's minimum deposit: ${formatNear(plan.requiredYocto.toString(), 6)} NEAR`;
    } else if (!plan.covers) {
      errors.depositNear = "Too low to pay for the vault's own storage";
    } else if (BigInt(deposit) > MAX_CREATE_DEPOSIT_YOCTO) {
      errors.depositNear = `At most ${formatNear(MAX_CREATE_DEPOSIT_YOCTO.toString())} NEAR: if the name is taken, the factory refunds the deposit from its own float, which is sized for that`;
    }
  } catch (e) {
    errors.depositNear = e instanceof AmountError ? e.message : "Invalid amount";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    vaultId,
    warnings,
    tx: createVaultTx(ctx.factory, {
      name,
      approvers,
      dailyBackstop: backstop,
      heldTtlNs: hoursToNs(hours),
      deposit,
    }),
  };
}

export type FactoryForCreate =
  | { ok: true; minDeposit: string; mode: FactoryMode; version: number }
  | { ok: false; reason: "unreachable" | "not_deployed" | "no_version" | "bad_answer" };

/**
 * R14: the factory's `min_deposit` and its current version's mode, through the SDK FactoryClient.
 * Anything the console cannot read with certainty is not ok, and the page offers the CLI instead.
 */
export async function loadFactoryForCreate(
  factory: Pick<FactoryClient, "getConfig" | "versions">,
): Promise<FactoryForCreate> {
  let config: FactoryConfig;
  let versions: VersionView[];
  try {
    [config, versions] = await Promise.all([factory.getConfig(), factory.versions()]);
  } catch (e) {
    const kind = chainErrorKind(e);
    log.warn("console.factory_unavailable", { kind: kind ?? "error" });
    return { ok: false, reason: kind === "contract" ? "not_deployed" : "unreachable" };
  }
  if (config.current_version === null) return { ok: false, reason: "no_version" };
  const current = versions.find((v) => v.index === config.current_version);
  if (current === undefined) return { ok: false, reason: "bad_answer" };
  if (current.mode !== "global" && current.mode !== "embedded")
    return { ok: false, reason: "bad_answer" };
  if (typeof config.min_deposit !== "string" || !/^(0|[1-9][0-9]*)$/.test(config.min_deposit)) {
    return { ok: false, reason: "bad_answer" };
  }
  return { ok: true, minDeposit: config.min_deposit, mode: current.mode, version: current.index };
}

// ---- register ------------------------------------------------------------------------------------

/**
 * A vault account's code identity: the global contract it uses (NEP-591; its own `code_hash` is
 * all zeros then), else the hash of the code deployed on it.
 * TODO(plan 03 Task 14): use the SDK's code-identity helper once it lands, and delete this one.
 */
export function codeIdentity(
  account: Pick<ViewAccountResult, "code_hash" | "global_contract_hash">,
): string {
  return account.global_contract_hash ?? account.code_hash;
}

export interface RegisterDeps {
  db: Db;
  reader: VaultReader;
  chain: ChainReads;
  network: Network;
  /** PROBARION_FACTORY_ID: the one factory whose versions the console trusts. */
  factoryId: string;
  canaryVaultId: string | null;
  /** TEAM_VAULT_IDS (R11). */
  teamVaultIds: readonly string[];
}

export type RegisterError =
  | "invalid_vault"
  | "not_found"
  | "unavailable"
  | "foreign_factory"
  | "unknown_code"
  | "not_owner"
  | "owner_mismatch";

export const REGISTER_ERROR_TEXT: Record<RegisterError, string> = {
  invalid_vault: "That is not a NEAR account id.",
  not_found:
    "No vault answers at that account (yet). A vault you just created can take a few seconds.",
  unavailable: "NEAR could not be reached, so nothing was registered. Try again in a moment.",
  foreign_factory:
    "That vault comes from another factory and does not run a known Probarion build, so it cannot be registered.",
  unknown_code:
    "That account does not run a known Probarion vault build (or a version of this console's factory), so it cannot be registered.",
  not_owner: "Only the vault's on-chain owner can register it. Sign in with the owner account.",
  owner_mismatch: "This vault is already registered under another owner.",
};

/**
 * R11. The chain is the source of truth, and only the code is evidence: what `get_config` says is
 * whatever the contract at that account returns, so it is believed only once the account's code is
 * known to be a Probarion vault. The code must be a recorded reproducible build
 * (KNOWN_VAULT_CODE_HASHES), or the vault must name this console's factory AND run one of that
 * factory's versions. Then only the on-chain owner may register it, and the approvers come from
 * `get_config`. Registering again re-syncs the approvers and updates the kind (TEAM_VAULT_IDS,
 * CANARY_VAULT_ID), network and display name.
 */
export async function registerVault(
  deps: RegisterDeps,
  input: { vaultId: string; account: string; displayName?: string },
): Promise<{ ok: true; tenantId: string; kind: TenantKind } | { ok: false; error: RegisterError }> {
  const vaultId = input.vaultId.trim();
  if (!isNearAccountId(vaultId)) return { ok: false, error: "invalid_vault" };
  let config: VaultConfig;
  let identity: string;
  try {
    const [c, account] = await Promise.all([
      deps.reader.getConfig(vaultId),
      deps.chain.viewAccount(vaultId),
    ]);
    config = c;
    identity = codeIdentity(account);
  } catch (e) {
    return { ok: false, error: chainFailure(e, vaultId) };
  }

  if (!KNOWN_VAULT_CODE_HASHES.includes(identity)) {
    if (config.factory !== deps.factoryId) {
      return { ok: false, error: config.factory === null ? "unknown_code" : "foreign_factory" };
    }
    let versions: VersionView[];
    try {
      versions = await deps.chain.factoryVersions(deps.factoryId);
    } catch (e) {
      // The factory's version list is the evidence here: without it nothing is trusted.
      return { ok: false, error: chainErrorKind(e) === null ? rethrow(e) : "unavailable" };
    }
    if (!versions.some((v) => v.code_hash === identity))
      return { ok: false, error: "unknown_code" };
  }

  if (config.owner !== input.account) return { ok: false, error: "not_owner" };

  const kind: TenantKind =
    vaultId === deps.canaryVaultId
      ? "canary"
      : deps.teamVaultIds.includes(vaultId)
        ? "team"
        : "external";
  try {
    const { tenant_id } = await registerTenant(deps.db, {
      vaultId,
      network: deps.network,
      kind,
      displayName: (input.displayName ?? vaultId.split(".")[0] ?? vaultId).slice(0, 80),
      owner: config.owner,
      approvers: config.approvers,
    });
    return { ok: true, tenantId: tenant_id, kind };
  } catch (e) {
    if (e instanceof DbError && e.code === "owner_mismatch")
      return { ok: false, error: "owner_mismatch" };
    throw e;
  }
}

function rethrow(e: unknown): never {
  throw e;
}

/** A failed get_config / view_account: a definite "nothing there" is not_found, anything else is unavailable. */
function chainFailure(e: unknown, vault: string): RegisterError {
  const kind = chainErrorKind(e);
  if (kind === null) throw e; // a bug, not a chain answer
  log.warn("console.register_read_failed", { vault, kind });
  return kind === "contract" ? "not_found" : "unavailable";
}

// ---- overview ------------------------------------------------------------------------------------

export interface SpendSummary {
  held: SpendView[];
  /** The newest 20, newest first. */
  recent: SpendView[];
  /** By status, as the chain reports it (an unknown status is counted under its own name). */
  counts: Record<string, number>;
  total: number;
}

export interface MandateSummary {
  counts: Record<string, number>;
  total: number;
}

export interface VaultOverview {
  config: Read<VaultConfig>;
  /** NEP-141 balance of the vault's own configured USDC token. */
  usdc: Read<string>;
  /** Intents balance of the network's Base USDC asset, when the vault allows it. */
  intentsBase: Read<string>;
  near: Read<NearRunway>;
  spends: Read<SpendSummary>;
  mandates: Read<MandateSummary>;
}

function countBy<T extends { status: string }>(items: readonly T[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1;
  return counts;
}

/**
 * Everything the overview shows, each part read on its own. Any error on a balance, the NEAR
 * account or a list makes that part unavailable: a contract error on a balance view means a
 * wrong token or Intents id, not a zero (NEP-141 answers "0" for an unregistered account), and an
 * outage says nothing about the vault. Without a readable config nothing else is read: the token
 * ids come from it.
 */
export async function loadOverview(
  reader: VaultReader,
  chain: ChainReads,
  vault: string,
  consts: { base: string },
): Promise<VaultOverview> {
  const read0 = await read("get_config", vault, () => reader.getConfig(vault));
  const config: Read<VaultConfig> =
    read0.ok && !isVaultConfig(read0.value) ? { ok: false, kind: "rpc" } : read0;
  if (!config.ok) {
    return {
      config,
      usdc: SKIPPED,
      intentsBase: SKIPPED,
      near: SKIPPED,
      spends: SKIPPED,
      mandates: SKIPPED,
    };
  }
  const c = config.value;
  const [usdc, intentsBase, near, spends, mandates] = await Promise.all([
    read("ft_balance_of", vault, () => reader.ftBalance(c.usdc, vault)),
    c.allowed_assets.includes(consts.base)
      ? read("mt_balance_of", vault, () => reader.intentsBalance(c.intents, vault, consts.base))
      : Promise.resolve({ ok: false, kind: "not_allowed" } as const),
    read("view_account", vault, async () => nearRunway(await chain.viewAccount(vault))),
    read("list_spends", vault, async (): Promise<SpendSummary> => {
      const all = await listAll((from, limit) => reader.listSpends(vault, from, limit));
      return {
        held: all.filter((s) => s.status === "held"),
        recent: all.slice(-20).reverse(),
        counts: countBy(all),
        total: all.length,
      };
    }),
    read("list_mandates", vault, async (): Promise<MandateSummary> => {
      const all: MandateView[] = await listAll((from, limit) =>
        reader.listMandates(vault, from, limit),
      );
      return { counts: countBy(all), total: all.length };
    }),
  ]);
  return { config, usdc, intentsBase, near, spends, mandates };
}
