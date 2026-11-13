import { MAX_REASONING_CHARS, PROPOSAL_MAX_TOKENS, USDC_DECIMALS } from "@probarion/core";
import {
  ANCHOR_GAS,
  CATALOG_PAGE_SIZE,
  DEFAULT_NEARAI_TIMEOUTS_MS,
  MAX_PAGE_LIMIT,
  MAX_RESPONSE_BODY_BYTES,
  PAGE_SIZE,
  PAYEE_SIGNALS_BUDGET_MS,
  PAYEE_SIGNALS_TIMEOUT_MS,
  SPEND_GAS,
  UNKNOWN_SETTLE_MS,
} from "@probarion/sdk";
import { CANARY_LIMITS } from "@/lib/canary/limits";
import { CANARY_KEY_ALLOWANCES, VAULT_DEFAULTS } from "@/lib/config";
import { MAX_EXPIRY_AHEAD_MS, MAX_USES_BETA, MIN_EXPIRY_AHEAD_MS } from "@/lib/console/mandates";
import {
  ALLOWANCE_LOW_ALERT_YOCTO,
  DEFAULT_TOPUP_YOCTO,
  EMBEDDED_CODE_ESTIMATE_BYTES,
  EMBEDDED_VAULT_WASM_BYTES,
  FRESH_VAULT_STATE_BYTES,
  LOW_NEAR_YOCTO,
  MAX_CREATE_DEPOSIT_YOCTO,
  MAX_TOPUP_YOCTO,
  NEAR_LOW_ALERT_YOCTO,
  NEAR_PER_SPEND_YOCTO,
  STORAGE_BYTE_COST_YOCTO,
} from "@/lib/near/runway";
import {
  FT_STORAGE_DEPOSIT,
  GAS,
  type GasMethod,
  MANDATE_STORAGE_DEPOSIT,
  METHOD_DEPOSIT,
  ONE_YOCTO,
  type OwnerMethod,
  TGAS,
} from "@/lib/near/tx";
import { MAX_INVOICE_BYTES } from "@/lib/payables/limits";
import { LIMITS } from "@/lib/ratelimit";
import { MAX_ATTESTATIONS, MAX_REPORT_BYTES } from "@/lib/tee/limits";
import { MAX_TOPUP_UNITS, MIN_TOPUP_UNITS } from "@/lib/topup/amount";
import { MIN_LEFT_MS } from "@/lib/topup/block";
import type { RefColumn, RefRow, RefTable } from "./types";

/**
 * Limits and costs (`/docs/build/limits-and-costs`). The Rust values are written here as the source
 * writes them, and `test/docs-ref-limits.test.ts` parses `contracts/vault/src` and
 * `contracts/factory/src/lib.rs` to hold them: every `pub const` of the two `lib.rs` files and every
 * `MAX_*` must be shown with its value, and each deposit and gas row must match the method's code.
 * Every TypeScript value is imported from the module that defines it, and the test checks that the
 * tables show it. The few values whose module loads server code (pdf-parse, the database) or that
 * live in SQL are written below as their source writes them, and the test parses that source.
 */

// --- values written as their source writes them ---------------------------------------------------

/** `contracts/deployments/testnet.json` `factory.min_deposit`. */
const TESTNET_MIN_DEPOSIT = 500_000_000_000_000_000_000_000n;
/** `apps/web/src/lib/payables/extract.ts`, which loads pdf-parse. */
const MAX_TEXT_CHARS = 50_000;
const MAX_PDF_PAGES = 20;
/** `apps/web/src/lib/ext/inbox.ts`, server only. */
const MAX_VAULTS = 10;
const MAX_ROWS = 10;
/** `apps/web/src/lib/topup/faucet.ts`, server only: whole test USDC. */
const FAUCET_USDC = "25";
/** `alert_subscription_create` in `apps/web/supabase/migrations/20261108000011_alerts.sql`. */
const MAX_ACTIVE_ALERTS = 20;

// --- formatting -----------------------------------------------------------------------------------

/** 4194304 -> "4,194,304". */
const thousands = (n: number | bigint) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const YOCTO_PER_NEAR = 10n ** 24n;

/** yoctoNEAR as an exact NEAR decimal: 50000000000000000000000 -> "0.05". */
function near(yocto: bigint | string): string {
  const y = BigInt(yocto);
  const whole = y / YOCTO_PER_NEAR;
  const frac = (y % YOCTO_PER_NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return frac === "" ? `${whole}` : `${whole}.${frac}`;
}

/** Gas in gas units (bigint) or in Tgas (number), as "200 Tgas". */
const tgas = (gas: bigint | number) => `${typeof gas === "bigint" ? gas / TGAS : gas} Tgas`;

/** 4194304 -> "4,194,304 bytes (4 MiB)". */
function bytes(n: number | bigint): string {
  const v = Number(n);
  const unit =
    v % 1_048_576 === 0 ? ` (${v / 1_048_576} MiB)` : v % 1024 === 0 ? ` (${v / 1024} KiB)` : "";
  return `${thousands(v)} bytes${unit}`;
}

/** 172800000 -> "172,800,000 ms (48 hours)". */
function millis(n: number): string {
  const day = 86_400_000;
  const hour = 3_600_000;
  let unit = "";
  if (n % day === 0 && n >= 3 * day) unit = ` (${n / day} days)`;
  else if (n === hour) unit = " (1 hour)";
  else if (n % hour === 0) unit = ` (${n / hour} hours)`;
  else if (n === 60_000) unit = " (1 minute)";
  else if (n % 60_000 === 0) unit = ` (${n / 60_000} minutes)`;
  else if (n % 1000 === 0) unit = ` (${n / 1000} seconds)`;
  return `${thousands(n)} ms${unit}`;
}

const USDC_UNIT = 10n ** BigInt(USDC_DECIMALS);

/** USDC base units: 1000000000 -> "1,000,000,000 units (1,000 USDC)". */
function usdcUnits(units: bigint): string {
  const whole = units / USDC_UNIT;
  const frac = (units % USDC_UNIT).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return `${thousands(units)} units (${thousands(whole)}${frac === "" ? "" : `.${frac}`} USDC)`;
}

/** A rate-limit window in words: 60 is "a minute", 600 "10 minutes". */
function perWindow(seconds: number): string {
  if (seconds === 60) return "a minute";
  if (seconds === 3600) return "an hour";
  if (seconds === 86_400) return "a day";
  if (seconds % 86_400 === 0) return `${seconds / 86_400} days`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

const NONE = "None";
const ONE_YOCTO_CELL = "Exactly 1 yoctoNEAR";
const NOT_SET = "Not set by a Probarion tool";

function row(id: string, cells: Record<string, string>): RefRow {
  return { id, cells };
}

// --- vault ----------------------------------------------------------------------------------------

const CONSTANT_COLUMNS: readonly RefColumn[] = [
  { key: "name", label: "Constant" },
  { key: "value", label: "Value" },
  { key: "limits", label: "What it limits" },
  { key: "past", label: "Past the limit" },
];

/** `contracts/vault/src/lib.rs`, in source order. */
const VAULT: RefTable = {
  id: "limits-vault",
  label: "Vault limits",
  columns: CONSTANT_COLUMNS,
  rows: [
    row("limits-vault-day_ns", {
      name: "`DAY_NS`",
      value: "86,400,000,000,000 ns (one day)",
      limits:
        "The day of the daily backstop: a spend counts in UTC day `block_timestamp / DAY_NS`, and the vault's `daily_backstop` caps each day's total",
      past: "`OverDailyBackstop`",
    }),
    row("limits-vault-max_held_ttl_ns", {
      name: "`MAX_HELD_TTL_NS`",
      value: "2,592,000,000,000,000 ns (30 days)",
      limits:
        "The `held_ttl_ns` of `new`: how long a held spend waits for an approver. It must also be above 0",
      past: "`InvalidInput`, and the vault is not created",
    }),
    row("limits-vault-max_approvers", {
      name: "`MAX_APPROVERS`",
      value: "10",
      limits:
        "Approvers named in `new`, at least 1. No method changes them after the vault is created",
      past: "`InvalidInput`, and the vault is not created",
    }),
    row("limits-vault-max_assets", {
      name: "`MAX_ASSETS`",
      value: "10",
      limits: "The `allowed_assets` of `new`: the Intents assets a mandate may pay out in",
      past: "`InvalidInput`, and the vault is not created",
    }),
    row("limits-vault-max_agents", {
      name: "`MAX_AGENTS`",
      value: "16",
      limits: "Agent keys on the vault at one time, added with `add_agent`",
      past: "`InvalidInput`. Remove a key with `remove_agent` first",
    }),
    row("limits-vault-max_page", {
      name: "`MAX_PAGE`",
      value: "100",
      limits:
        "Items one call of `list_mandates`, `list_spends` or `list_anchors` returns. `from_index` is a position counted from 0",
      past: "None: a larger `limit` returns 100 items",
    }),
    row("limits-vault-one_yocto", {
      name: "`ONE_YOCTO`",
      value: "1 yoctoNEAR",
      limits:
        "The deposit the vault attaches to its own `ft_transfer` and `ft_withdraw` calls: in each payout, in `withdraw` and in `withdraw_intents`",
      past: "None: the vault sets it",
    }),
    row("limits-vault-usdc_storage_deposit", {
      name: "`USDC_STORAGE_DEPOSIT`",
      value: "1,250,000,000,000,000,000,000 yoctoNEAR (0.00125 NEAR)",
      limits:
        "What `create_mandate` passes to the USDC token's `storage_deposit` for a NEAR payee, out of the owner's deposit: the `storage_balance_bounds().min` of mainnet's USDC",
      past: "`InsufficientDeposit` when the owner's deposit does not cover it and the mandate's storage",
    }),
  ],
};

/** Strings and hashes the vault and the factory check, with the function or constant that holds the rule. */
const FORMATS: RefTable = {
  id: "limits-formats",
  label: "String and hash formats",
  columns: [
    { key: "input", label: "Input" },
    { key: "format", label: "Format" },
    { key: "check", label: "Checked by" },
    { key: "past", label: "Refused with" },
  ],
  rows: [
    row("limits-format-hex64", {
      input:
        "A mandate's `purpose_hash`, a spend's `invoice_hash` and `decision_hash`, and an anchor's `root`",
      format: "64 lowercase hex characters: a sha256 digest",
      check: "`is_hex64`",
      past: "`InvalidInput`",
    }),
    row("limits-format-evm_address", {
      input: "The `address` of a Base payee",
      format: "`0x` and 40 hex digits in any case, 42 characters in all. `0X` is refused",
      check: "`is_evm_address`",
      past: "`InvalidInput`",
    }),
    row("limits-format-solana_address", {
      input: "The `address` of a Solana payee",
      format: "Base58 in the Bitcoin alphabet, with no `0`, `O`, `I` or `l`, 32 to 44 characters",
      check: "`is_solana_address`",
      past: "`InvalidInput`",
    }),
    row("limits-format-asset", {
      input: "The `asset` of an Intents payee",
      format:
        "Starts with `base-` for a Base payee or `sol-` for a Solana payee, and is one of the vault's `allowed_assets`",
      check: "`asset_matches_chain`",
      past: "`AssetNotAllowed`",
    }),
    row("limits-format-ref", {
      input: "A spend's `ref`, its idempotency key",
      format: "1 to 64 bytes. Once the vault accepts a spend, its `ref` stays used",
      check: "`is_ref`",
      past: "`InvalidInput`, or `DuplicateRef` for a used one",
    }),
    row("limits-format-mandate_label", {
      input: "A mandate's `label`",
      format: "At most 64 bytes",
      check: "`validate_mandate`",
      past: "`InvalidInput`",
    }),
    row("limits-format-agent_label", {
      input: "An agent key's `label`",
      format: "At most 64 bytes",
      check: "`add_agent`",
      past: "`InvalidInput`",
    }),
    row("limits-format-withdraw_memo", {
      input: "The memo of a payout to a Base or Solana payee",
      format:
        "`WITHDRAW_TO:` and the payee's address, byte for byte. `@probarion/core` exports the same `WITHDRAW_MEMO_PREFIX`",
      check: "`WITHDRAW_MEMO_PREFIX`",
      past: "None: the vault writes it from the mandate",
    }),
    row("limits-format-near_memo", {
      input: "The memo of a payout to a NEAR payee",
      format: "`probarion:` and the spend id",
      check: "`NEAR_MEMO_PREFIX`",
      past: "None: the vault writes it",
    }),
    row("limits-format-vault_name", {
      input: "The `name` of `create_vault`",
      format:
        "2 to 31 characters, `^[a-z0-9][a-z0-9_-]{1,30}$`. `<name>.<factory>` must also be a valid NEAR account id: no `-` or `_` at the end, never two of them in a row, and at most 64 characters in all",
      check: "`valid_name`",
      past: "`InvalidInput`",
    }),
    row("limits-format-code_hash", {
      input: "The `code_hash` of `add_version`",
      format:
        "Base58 of 32 bytes. An `embedded` version also needs that code stored by `store_code`",
      check: "`add_version`",
      past: "`InvalidInput`",
    }),
    row("limits-format-version_mode", {
      input: "The `mode` of `add_version`",
      format: "`global` or `embedded`",
      check: "`add_version`",
      past: "`InvalidInput`",
    }),
    row("limits-format-store_code", {
      input: "The input of `store_code`: the raw vault wasm, sent with `file-args`",
      format: "Not empty. The factory stores it under its sha256, which `store_code` returns",
      check: "`store_code`",
      past: "`InvalidInput`",
    }),
  ],
};

// --- factory --------------------------------------------------------------------------------------

/** `contracts/factory/src/lib.rs`, plus the one factory setting a builder pays against. */
const FACTORY: RefTable = {
  id: "limits-factory",
  label: "Factory limits",
  columns: CONSTANT_COLUMNS,
  rows: [
    row("limits-factory-max_notes", {
      name: "`MAX_NOTES`",
      value: "256",
      limits: "Bytes of `notes` in `add_version`",
      past: "`InvalidInput`",
    }),
    row("limits-factory-max_page", {
      name: "`MAX_PAGE`",
      value: "100",
      limits: "Vaults one call of `list_vaults` returns",
      past: "None: a larger `limit` returns 100 items",
    }),
    row("limits-factory-max_assets", {
      name: "`MAX_ASSETS`",
      value: "10",
      limits: "The `allowed_assets` of the factory's `new`, which every vault it creates receives",
      past: "`InvalidInput`",
    }),
    row("limits-factory-max_approvers", {
      name: "`MAX_APPROVERS`",
      value: "10",
      limits:
        "Approvers in `create_vault`, at least 1: the vault's own limit, checked before anything is created",
      past: "`InvalidInput`, and nothing is created",
    }),
    row("limits-factory-max_held_ttl_ns", {
      name: "`MAX_HELD_TTL_NS`",
      value: "2,592,000,000,000,000 ns (30 days)",
      limits:
        "The `held_ttl_ns` of `create_vault`, above 0: the vault's own limit, checked before anything is created",
      past: "`InvalidInput`, and nothing is created",
    }),
    row("limits-factory-min_deposit", {
      name: "`min_deposit`, set in the factory's `new`",
      value: `${thousands(TESTNET_MIN_DEPOSIT)} yoctoNEAR (${near(TESTNET_MIN_DEPOSIT)} NEAR) on Testnet`,
      limits: `The least \`create_vault\` accepts for a \`global\` version. An \`embedded\` version also charges the byte cost of the vault's copy of the code. \`get_config\` returns it. The Testnet factory's current version is \`embedded\`, so a Testnet vault needs \`min_deposit\` plus the code's byte cost, about ${near(TESTNET_MIN_DEPOSIT + EMBEDDED_VAULT_WASM_BYTES * STORAGE_BYTE_COST_YOCTO)} NEAR for the ${thousands(EMBEDDED_VAULT_WASM_BYTES)}-byte vault wasm, and the CLI requires \`--deposit\` for it`,
      past: "`InsufficientDeposit`, and nothing is created",
    }),
  ],
};

// --- deposits and gas per call ----------------------------------------------------------------------

const OWNER_KEY = "The owner, from a full-access key";
const APPROVER_KEY = "An approver, from a full-access key";
const FACTORY_OWNER = "The factory owner, from a full-access key";
const BY_HAND = "Not built by a Probarion tool: the factory owner signs it with near-cli-rs";

/** What the console attaches (`METHOD_DEPOSIT`); the CLI attaches the same. */
function attached(method: OwnerMethod): string {
  return METHOD_DEPOSIT[method] === "0" ? NONE : `${METHOD_DEPOSIT[method]} yoctoNEAR`;
}

/** The prepaid gas the console (`GAS`) and the CLI attach. */
const gasOf = (method: GasMethod) => tgas(GAS[method]);

/** A vault owner or approver method whose deposit comes from `METHOD_DEPOSIT`. */
function ownerCall(method: OwnerMethod, signer: string, deposit: string): RefRow {
  return row(`limits-deposit-${method}`, {
    call: `\`${method}\` on the vault`,
    signer,
    deposit,
    attached: attached(method),
    gas: gasOf(method),
  });
}

const DEPOSITS: RefTable = {
  id: "limits-deposits",
  label: "Deposits and gas per call",
  columns: [
    { key: "call", label: "Call" },
    { key: "signer", label: "Signed by" },
    { key: "deposit", label: "Deposit the contract asks" },
    { key: "attached", label: "Deposit the console and the CLI attach" },
    { key: "gas", label: "Prepaid gas" },
  ],
  rows: [
    ownerCall(
      "freeze",
      "The owner, from a full-access key or a function-call key that may call the vault",
      NONE,
    ),
    ownerCall("unfreeze", OWNER_KEY, ONE_YOCTO_CELL),
    ownerCall("withdraw", OWNER_KEY, ONE_YOCTO_CELL),
    ownerCall("withdraw_intents", OWNER_KEY, ONE_YOCTO_CELL),
    row("limits-deposit-create_mandate", {
      call: "`create_mandate` on the vault",
      signer: OWNER_KEY,
      deposit:
        "The storage the new mandate takes at the byte cost, plus `USDC_STORAGE_DEPOSIT` for a NEAR payee. Less is `InsufficientDeposit`, and the excess is refunded to the owner",
      attached: `${near(MANDATE_STORAGE_DEPOSIT)} NEAR: the console's \`MANDATE_STORAGE_DEPOSIT\` and the CLI's \`--deposit\` default`,
      gas: gasOf("create_mandate"),
    }),
    ownerCall("revoke_mandate", OWNER_KEY, ONE_YOCTO_CELL),
    ownerCall("add_agent", OWNER_KEY, ONE_YOCTO_CELL),
    ownerCall("remove_agent", OWNER_KEY, ONE_YOCTO_CELL),
    ownerCall("set_ledger_key", OWNER_KEY, ONE_YOCTO_CELL),
    ownerCall("approve", APPROVER_KEY, ONE_YOCTO_CELL),
    ownerCall("reject", APPROVER_KEY, ONE_YOCTO_CELL),
    row("limits-deposit-spend", {
      call: "`spend` on the vault",
      signer: "An agent key on the vault account. The vault's own NEAR pays the gas",
      deposit: `${NONE}: a function-call key cannot attach one`,
      attached: NONE,
      gas: `${tgas(SPEND_GAS)}, the SDK's \`SPEND_GAS\``,
    }),
    row("limits-deposit-anchor", {
      call: "`anchor` on the vault",
      signer: "The ledger key on the vault account. The vault's own NEAR pays the gas",
      deposit: `${NONE}: a function-call key cannot attach one`,
      attached: NONE,
      gas: `${tgas(ANCHOR_GAS)}, the SDK's \`ANCHOR_GAS\``,
    }),
    row("limits-deposit-expire_held", {
      call: "`expire_held` on the vault",
      signer: "Anyone, once the hold has expired",
      deposit: NONE,
      attached: "Not built by a Probarion tool",
      gas: NOT_SET,
    }),
    row("limits-deposit-create_vault", {
      call: "`create_vault` on the factory",
      signer: "Anyone. The caller becomes the new vault's owner",
      deposit:
        "At least `min_deposit`, plus the byte cost of the code for an `embedded` version. Less is `InsufficientDeposit`. The deposit stays in the vault as its NEAR, and is refunded if the name is taken",
      attached: `The owner's choice, at most ${near(MAX_CREATE_DEPOSIT_YOCTO)} NEAR in the console. The CLI attaches \`min_deposit\` unless \`--deposit\` is given, and needs \`--deposit\` for an \`embedded\` version`,
      gas: gasOf("create_vault"),
    }),
    row("limits-deposit-store_code", {
      call: "`store_code` on the factory",
      signer: FACTORY_OWNER,
      deposit: ONE_YOCTO_CELL,
      attached: BY_HAND,
      gas: NOT_SET,
    }),
    row("limits-deposit-add_version", {
      call: "`add_version` on the factory",
      signer: FACTORY_OWNER,
      deposit: ONE_YOCTO_CELL,
      attached: BY_HAND,
      gas: NOT_SET,
    }),
    row("limits-deposit-publish_global", {
      call: "`publish_global` on the factory",
      signer: FACTORY_OWNER,
      deposit: `${ONE_YOCTO_CELL}. The factory's own balance pays for the global contract`,
      attached: BY_HAND,
      gas: NOT_SET,
    }),
    row("limits-deposit-usdc-storage_deposit", {
      call: "`storage_deposit` on the USDC token",
      signer:
        "The owner, to register the vault on the token before funding it, or the 1Click deposit address of a top-up",
      deposit: "Set by the token contract",
      attached: `${near(FT_STORAGE_DEPOSIT)} NEAR, the console's \`FT_STORAGE_DEPOSIT\``,
      gas: gasOf("storage_deposit"),
    }),
    row("limits-deposit-usdc-ft_transfer", {
      call: "`ft_transfer` on the USDC token",
      signer: "The owner, to fund the vault with USDC, or to pay a 1Click top-up quote",
      deposit: "Set by the token contract",
      attached: `${ONE_YOCTO} yoctoNEAR`,
      gas: gasOf("ft_transfer"),
    }),
  ],
};

// --- gas the contracts attach ---------------------------------------------------------------------

/** The `GAS_*` constants: the gas each contract gives the calls it makes itself. */
const GAS_TABLE: RefTable = {
  id: "limits-gas",
  label: "Gas the contracts attach to their own calls",
  columns: [
    { key: "name", label: "Constant" },
    { key: "value", label: "Value" },
    { key: "call", label: "The call it pays for" },
    { key: "deposit", label: "Deposit attached" },
  ],
  rows: [
    row("limits-gas-gas_ft_transfer", {
      name: "`GAS_FT_TRANSFER`, vault",
      value: "15 Tgas",
      call: "`ft_transfer` on the USDC token: a payout to a NEAR payee, and `withdraw`",
      deposit: "`ONE_YOCTO`",
    }),
    row("limits-gas-gas_ft_withdraw", {
      name: "`GAS_FT_WITHDRAW`, vault",
      value: "100 Tgas",
      call: "`ft_withdraw` on NEAR Intents: a payout to a Base or Solana payee, and `withdraw_intents`",
      deposit: "`ONE_YOCTO`",
    }),
    row("limits-gas-gas_storage_deposit", {
      name: "`GAS_STORAGE_DEPOSIT`, vault",
      value: "10 Tgas",
      call: "`storage_deposit` on the USDC token for a NEAR payee, from `create_mandate`. The vault does not wait for its result",
      deposit: "`USDC_STORAGE_DEPOSIT`",
    }),
    row("limits-gas-gas_callback", {
      name: "`GAS_CALLBACK`, vault",
      value: "15 Tgas",
      call: "The payout's callback, `on_transfer` or `on_withdraw`, which settles or releases the spend",
      deposit: NONE,
    }),
    row("limits-gas-gas_vault_new", {
      name: "`GAS_VAULT_NEW`, factory",
      value: "30 Tgas",
      call: "`new` on the vault account that `create_vault` makes",
      deposit: NONE,
    }),
    row("limits-gas-gas_on_vault_created", {
      name: "`GAS_ON_VAULT_CREATED`, factory",
      value: "15 Tgas",
      call: "The callback of `create_vault`, `on_vault_created`, which records the vault or refunds the deposit",
      deposit: NONE,
    }),
  ],
};

// --- the vault's own NEAR -------------------------------------------------------------------------

const VALUE_COLUMNS: readonly RefColumn[] = [
  { key: "name", label: "Constant" },
  { key: "value", label: "Value" },
  { key: "what", label: "What it is" },
];

/** `apps/web/src/lib/near/runway.ts`: the console's figures for a vault's NEAR. */
const RUNWAY: RefTable = {
  id: "limits-runway",
  label: "What a vault spends from its own NEAR",
  columns: VALUE_COLUMNS,
  rows: [
    row("limits-runway-storage_byte_cost_yocto", {
      name: "`STORAGE_BYTE_COST_YOCTO`",
      value: `${near(STORAGE_BYTE_COST_YOCTO)} NEAR a byte`,
      what: "NEAR's storage staking: the NEAR an account keeps locked for each byte it stores",
    }),
    row("limits-runway-near_per_spend_yocto", {
      name: "`NEAR_PER_SPEND_YOCTO`",
      value: `${near(NEAR_PER_SPEND_YOCTO)} NEAR`,
      what: "About what one paid spend costs the vault: the storage it leaves for good and the gas it burns. A failed spend costs less",
    }),
    row("limits-runway-embedded_vault_wasm_bytes", {
      name: "`EMBEDDED_VAULT_WASM_BYTES`",
      value: bytes(EMBEDDED_VAULT_WASM_BYTES),
      what: "The size of the vault wasm, which an `embedded` vault stores a copy of",
    }),
    row("limits-runway-embedded_code_estimate_bytes", {
      name: "`EMBEDDED_CODE_ESTIMATE_BYTES`",
      value: bytes(EMBEDDED_CODE_ESTIMATE_BYTES),
      what: `What the console counts for that copy, the wasm plus 10 percent: ${near(EMBEDDED_CODE_ESTIMATE_BYTES * STORAGE_BYTE_COST_YOCTO)} NEAR at the byte cost. What the code does not take stays in the vault`,
    }),
    row("limits-runway-fresh_vault_state_bytes", {
      name: "`FRESH_VAULT_STATE_BYTES`",
      value: bytes(FRESH_VAULT_STATE_BYTES),
      what: "What a new vault stores besides its code, for the console's estimate of a new vault's NEAR",
    }),
    row("limits-runway-low_near_yocto", {
      name: "`LOW_NEAR_YOCTO`",
      value: `${near(LOW_NEAR_YOCTO)} NEAR`,
      what: "Below this much free NEAR the console shows the vault's runway in amber",
    }),
    row("limits-runway-near_low_alert_yocto", {
      name: "`NEAR_LOW_ALERT_YOCTO`",
      value: `${near(NEAR_LOW_ALERT_YOCTO)} NEAR`,
      what: "Below this much free NEAR the watcher records a `near_low` event, at most once a UTC day",
    }),
    row("limits-runway-allowance_low_alert_yocto", {
      name: "`ALLOWANCE_LOW_ALERT_YOCTO`",
      value: `${near(ALLOWANCE_LOW_ALERT_YOCTO)} NEAR`,
      what: "Below this much allowance left on an agent or ledger key the watcher records an `allowance_low` event, at most once a key and UTC day",
    }),
    row("limits-runway-max_create_deposit_yocto", {
      name: "`MAX_CREATE_DEPOSIT_YOCTO`",
      value: `${near(MAX_CREATE_DEPOSIT_YOCTO)} NEAR`,
      what: "The most the console attaches to `create_vault`: a taken name is refunded from the factory's own balance",
    }),
    row("limits-runway-max_topup_yocto", {
      name: "`MAX_TOPUP_YOCTO`",
      value: `${near(MAX_TOPUP_YOCTO)} NEAR`,
      what: "The most one plain NEAR transfer to the vault sends from the console. NEAR sent to a vault does not come back out",
    }),
    row("limits-runway-default_topup_yocto", {
      name: "`DEFAULT_TOPUP_YOCTO`",
      value: `${near(DEFAULT_TOPUP_YOCTO)} NEAR`,
      what: "The top-up the console suggests",
    }),
  ],
};

// --- key allowances -------------------------------------------------------------------------------

const ALLOWANCE_RULE =
  "An allowance above 0 yoctoNEAR. An allowance of 0, an unlimited key, fails with `InvalidInput`";

/** The two function-call keys a vault adds to itself, and the allowance that caps the gas each may burn. */
const KEYS: RefTable = {
  id: "limits-keys",
  label: "Key allowances",
  columns: [
    { key: "key", label: "Key" },
    { key: "calls", label: "May call" },
    { key: "allowance", label: "Allowance the console gives it, and the CLI's default" },
    { key: "rule", label: "What the vault checks" },
  ],
  rows: [
    row("limits-keys-agent", {
      key: "An agent key, added with `add_agent`",
      calls: "`spend` on the vault",
      allowance: `${near(BigInt(VAULT_DEFAULTS.agentAllowanceYocto))} NEAR: the console's \`VAULT_DEFAULTS.agentAllowanceYocto\` and the default of \`agent add --allowance\`. For the Canary's vault the console asks for ${near(BigInt(CANARY_KEY_ALLOWANCES.agentAllowanceYocto))} NEAR (\`CANARY_KEY_ALLOWANCES.agentAllowanceYocto\`): its raw mode stops when the agent key has under ${near(CANARY_LIMITS.minAllowanceYocto)} NEAR left`,
      rule: ALLOWANCE_RULE,
    }),
    row("limits-keys-ledger", {
      key: "The ledger key, set with `set_ledger_key`",
      calls: "`anchor` on the vault",
      allowance: `${near(BigInt(VAULT_DEFAULTS.ledgerAllowanceYocto))} NEAR: the console's \`VAULT_DEFAULTS.ledgerAllowanceYocto\` and the default of \`ledger set-key --allowance\`. For the Canary's vault the console asks for ${near(BigInt(CANARY_KEY_ALLOWANCES.ledgerAllowanceYocto))} NEAR (\`CANARY_KEY_ALLOWANCES.ledgerAllowanceYocto\`): the Canary does not open while the ledger key has under ${near(CANARY_LIMITS.minLedgerAllowanceYocto)} NEAR left`,
      rule: ALLOWANCE_RULE,
    }),
  ],
};

// --- hosted app -----------------------------------------------------------------------------------

/**
 * The hosted app's own caps: Payables, the mandate form, top-ups, the faucet, alerts, and the extension's inbox and
 * invoice queue.
 */
const CONSOLE: RefTable = {
  id: "limits-console",
  label: "Hosted app limits",
  columns: VALUE_COLUMNS,
  rows: [
    row("limits-console-max_invoice_bytes", {
      name: "`MAX_INVOICE_BYTES`",
      value: bytes(MAX_INVOICE_BYTES),
      what: "The largest invoice file, pasted invoice text or purpose document the console's Payables upload takes, and the largest invoice file the browser extension queues. The upload's whole request may be 64 KiB larger, for the form: `MAX_REQUEST_BYTES` in `lib/payables/upload.ts`. Past a cap, `413 too_large`",
    }),
    row("limits-console-max_text_chars", {
      name: "`MAX_TEXT_CHARS`",
      value: thousands(MAX_TEXT_CHARS),
      what: "The UTF-16 units of invoice text Payables reads, shows the model and hashes: the invoice hash is the hash of exactly that text. Longer text is cut, and its amount is refused",
    }),
    row("limits-console-max_pdf_pages", {
      name: "`MAX_PDF_PAGES`",
      value: thousands(MAX_PDF_PAGES),
      what: "The pages of a PDF invoice Payables reads. The pages past them are not read or hashed, and the amount is refused",
    }),
    row("limits-console-max_uses_beta", {
      name: "`MAX_USES_BETA`",
      value: thousands(MAX_USES_BETA),
      what: "The most payments the console's mandate form allows a mandate during the beta. The contract takes any `u32` above 0",
    }),
    row("limits-console-max_expiry_ahead_ms", {
      name: "`MAX_EXPIRY_AHEAD_MS`",
      value: millis(MAX_EXPIRY_AHEAD_MS),
      what: "How far ahead the console's mandate form lets an expiry be, during the beta. The contract asks only for a time in the future",
    }),
    row("limits-console-min_expiry_ahead_ms", {
      name: "`MIN_EXPIRY_AHEAD_MS`",
      value: millis(MIN_EXPIRY_AHEAD_MS),
      what: "The earliest expiry the form accepts, counted from now: time for the owner to sign before it passes",
    }),
    row("limits-console-min_topup_units", {
      name: "`MIN_TOPUP_UNITS`",
      value: usdcUnits(MIN_TOPUP_UNITS),
      what: "The least one 1Click top-up asks for. The top-up is built for mainnet only and has not been tried with a live quote yet",
    }),
    row("limits-console-max_topup_units", {
      name: "`MAX_TOPUP_UNITS`",
      value: usdcUnits(MAX_TOPUP_UNITS),
      what: "The most one 1Click top-up asks for, during the beta",
    }),
    row("limits-console-min_left_ms", {
      name: "`MIN_LEFT_MS`",
      value: millis(MIN_LEFT_MS),
      what: "A 1Click quote with less time than this left before its deadline is not offered for signing",
    }),
    row("limits-console-faucet_usdc", {
      name: "`FAUCET_USDC`",
      value: `${FAUCET_USDC} test USDC`,
      what: "What one use of the testnet faucet mints into the vault. The `faucet` limiters in the rate limits cap how often",
    }),
    row("limits-console-active_alerts", {
      name: "Active alerts, checked in `alert_subscription_create`",
      value: thousands(MAX_ACTIVE_ALERTS),
      what: "The most active alerts one vault may have, email and Telegram together. Past it the console asks the owner to remove one first",
    }),
    row("limits-console-max_vaults", {
      name: "`MAX_VAULTS`",
      value: thousands(MAX_VAULTS),
      what: "The vaults one `GET /api/ext/inbox` answer covers, of those the account owns or approves on that network",
    }),
    row("limits-console-max_rows", {
      name: "`MAX_ROWS`",
      value: thousands(MAX_ROWS),
      what: "The invoices waiting for the owner, and the held payments, that the extension's inbox lists for each vault. Its counts include every one",
    }),
    row("limits-console-max_report_bytes", {
      name: "`MAX_REPORT_BYTES`",
      value: bytes(MAX_REPORT_BYTES),
      what: "The most of NEAR AI's attestation report the proof page's live TEE check (`GET /api/tee/check`) reads. A larger report is not read: the next preferred model is asked when `NEARAI_MODEL` is unset, else each check is `unavailable`",
    }),
    row("limits-console-max_attestations", {
      name: "`MAX_ATTESTATIONS`",
      value: thousands(MAX_ATTESTATIONS),
      what: "The model attestations of one report that the live TEE check checks, the first ones. Any past them are not checked: the answer's `attestations_total` counts them, and a pass says it covered the first of them only",
    }),
  ],
};

/** Who each `LIMITS` bucket counts, and where it applies. A new key fails the type check here. */
const RATE_SCOPE: Readonly<Record<keyof typeof LIMITS, { per: string; where: string }>> = {
  authChallenge: { per: "IP address", where: "`GET /api/auth/challenge`, the start of sign-in" },
  authVerify: { per: "IP address", where: "`POST /api/auth/verify`, the signed sign-in" },
  snapshot: {
    per: "IP address, for each file",
    where:
      "`GET /proof/<vault>/snapshot.json`, `GET /proof/<vault>/ledger.jsonl` and `GET /proof/<vault>/payments.csv`",
  },
  proofPage: { per: "IP address", where: "The public proof page, `/proof/<vault>`" },
  topupQuote: {
    per: "Signed-in account and network",
    where:
      "`POST /api/topup/quote`. The top-up is built for mainnet only and has not been tried with a live quote yet",
  },
  topupStatus: { per: "Signed-in account and network", where: "`GET /api/topup/status`" },
  topupSubmit: { per: "Signed-in account and network", where: "`POST /api/topup/submit`" },
  invoiceUpload: {
    per: "Vault",
    where: "`POST /api/console/<vault>/invoices`, the Payables upload",
  },
  canaryModelVisitor: {
    per: "IP address",
    where: "`POST /api/canary/attempt`, before the model is asked",
  },
  canaryModelGlobal: { per: "All visitors together", where: "`POST /api/canary/attempt`" },
  telegramWebhook: { per: "All calls together", where: "`POST /api/telegram/webhook`" },
  alertTest: {
    per: "Vault",
    where: "New alerts, emails and Telegram links on the console's alerts page, together",
  },
  alertLink: {
    per: "IP address",
    where: "The email confirmation page `/alerts/confirm` and `POST /api/alerts/confirm`",
  },
  alertConfirmAddress: {
    per: "Email address, from every vault together",
    where: "The confirmation emails the alerts page sends",
  },
  confirmPerAccount: {
    per: "Signed-in account and network",
    where:
      "The console's chain reads for a signed transaction: its confirmation, and the block height read when the send starts, each with its own counters",
  },
  confirmGlobal: {
    per: "All accounts together",
    where: "The same reads, each with its own counter",
  },
  registerPerAccount: {
    per: "Signed-in account and network",
    where: "Registering an existing vault in the console",
  },
  extPairPerIp: {
    per: "IP address and network",
    where: "`POST /api/ext/pair`, the browser extension's pairing-code exchange",
  },
  extPairGlobal: { per: "All addresses together, per network", where: "`POST /api/ext/pair`" },
  extInbox: { per: "Extension token's account and network", where: "`GET /api/ext/inbox`" },
  extInvoice: {
    per: "Extension token's account and network",
    where:
      "`POST /api/ext/invoices`: invoices the browser extension queues for the owner's Confirm",
  },
  extMint: {
    per: "Signed-in account and network",
    where: "Tokens and pairing codes the extension page makes, together",
  },
  faucetVault: {
    per: "Vault, each UTC day",
    where: "`POST /api/topup/faucet`, the test USDC faucet on testnet",
  },
  faucetAccount: {
    per: "Signed-in owner account, each UTC day",
    where: "`POST /api/topup/faucet`, the same faucet",
  },
  faucetGlobal: {
    per: "All vaults together, each UTC day",
    where: "`POST /api/topup/faucet`, the same faucet",
  },
  faucetTries: {
    per: "Signed-in account",
    where: "`POST /api/topup/faucet`: each press of the faucet button, before the chain is read",
  },
  teeCheck: {
    per: "All visitors together",
    where: "`GET /api/tee/check`, the proof page's live TEE check",
  },
};

const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const RATE: RefTable = {
  id: "limits-rate",
  label: "Rate limits of the hosted app",
  columns: [
    { key: "name", label: "Limiter" },
    { key: "limit", label: "Limit" },
    { key: "per", label: "Counted per" },
    { key: "where", label: "Applies to" },
  ],
  rows: (Object.keys(LIMITS) as (keyof typeof LIMITS)[]).map((key) => {
    const [max, seconds] = LIMITS[key];
    return row(`limits-rate-${snake(key)}`, {
      name: `\`${key}\``,
      limit: `${max} in ${perWindow(seconds)}`,
      per: RATE_SCOPE[key].per,
      where: RATE_SCOPE[key].where,
    });
  }),
};

// --- SDK and core ---------------------------------------------------------------------------------

const SDK: RefTable = {
  id: "limits-sdk",
  label: "SDK and core limits",
  columns: [
    { key: "name", label: "Constant" },
    { key: "from", label: "Package" },
    { key: "value", label: "Value" },
    { key: "what", label: "What it is" },
  ],
  rows: [
    row("limits-sdk-usdc_decimals", {
      name: "`USDC_DECIMALS`",
      from: "`@probarion/core`",
      value: String(USDC_DECIMALS),
      what: `Amounts travel in USDC's base units, so 1 USDC is \`${10 ** USDC_DECIMALS}\``,
    }),
    row("limits-sdk-page_size", {
      name: "`PAGE_SIZE`",
      from: "`@probarion/sdk`",
      value: String(PAGE_SIZE),
      what: "Items the SDK asks for in each page when it reads a whole list",
    }),
    row("limits-sdk-max_page_limit", {
      name: "`MAX_PAGE_LIMIT`",
      from: "`@probarion/sdk`",
      value: String(MAX_PAGE_LIMIT),
      what: "The largest `limit` the SDK sends: the contracts' `MAX_PAGE`",
    }),
    row("limits-sdk-max_response_body_bytes", {
      name: "`MAX_RESPONSE_BODY_BYTES`",
      from: "`@probarion/sdk`",
      value: bytes(MAX_RESPONSE_BODY_BYTES),
      what: "The largest NEAR AI response the SDK uses. The response goes into the ledger entry",
    }),
    row("limits-sdk-catalog_page_size", {
      name: "`CATALOG_PAGE_SIZE`",
      from: "`@probarion/sdk`",
      value: thousands(CATALOG_PAGE_SIZE),
      what: "Models the SDK asks NEAR AI's model catalog for in each page",
    }),
    row("limits-sdk-default_nearai_timeouts_ms", {
      name: "`DEFAULT_NEARAI_TIMEOUTS_MS`",
      from: "`@probarion/sdk`",
      value: Object.entries(DEFAULT_NEARAI_TIMEOUTS_MS)
        .map(([phase, ms]) => `\`${phase}\` ${millis(ms)}`)
        .join(", "),
      what: "How long each kind of NEAR AI call may take, headers and body together, before the SDK gives up on it. The `timeoutMs` option overrides it per kind",
    }),
    row("limits-sdk-proposal_max_tokens", {
      name: "`PROPOSAL_MAX_TOKENS`",
      from: "`@probarion/core`",
      value: thousands(PROPOSAL_MAX_TOKENS),
      what: "The `max_tokens` of a decision request to the model",
    }),
    row("limits-sdk-max_reasoning_chars", {
      name: "`MAX_REASONING_CHARS`",
      from: "`@probarion/core`",
      value: thousands(MAX_REASONING_CHARS),
      what: "The model's `reasoning` is cut to this many Unicode code points",
    }),
    row("limits-sdk-unknown_settle_ms", {
      name: "`UNKNOWN_SETTLE_MS`",
      from: "`@probarion/sdk`",
      value: millis(UNKNOWN_SETTLE_MS),
      what: "How long code refuses an invoice whose spend has an unknown outcome, unless the chain shows the spend sooner",
    }),
    row("limits-sdk-payee_signals_timeout_ms", {
      name: "`PAYEE_SIGNALS_TIMEOUT_MS`",
      from: "`@probarion/sdk`",
      value: millis(PAYEE_SIGNALS_TIMEOUT_MS),
      what: "How long each read of a payee check may take. Each endpoint gets one more try",
    }),
    row("limits-sdk-payee_signals_budget_ms", {
      name: "`PAYEE_SIGNALS_BUDGET_MS`",
      from: "`@probarion/sdk`",
      value: millis(PAYEE_SIGNALS_BUDGET_MS),
      what: "How long all of a payee check's reads may take together. A read still waiting then is unknown, which warns",
    }),
  ],
};

/** The limits tables, in the order the page shows them. */
export const TABLES: readonly RefTable[] = [
  VAULT,
  FORMATS,
  FACTORY,
  DEPOSITS,
  GAS_TABLE,
  RUNWAY,
  KEYS,
  CONSOLE,
  RATE,
  SDK,
];
