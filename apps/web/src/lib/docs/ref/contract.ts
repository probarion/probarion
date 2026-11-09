import type { RefColumn, RefRow, RefTable } from "./types";

/**
 * The contract reference: every method of the vault (`contracts/vault/src`) and of the factory
 * (`contracts/factory/src/lib.rs`). `test/docs-ref-contract.test.ts` reads the Rust source and
 * fails when a method, its receiver, `#[payable]`, `#[private]`, its one-yocto rule, its owner or
 * approver check, its arguments, its return type, the events it or its callbacks emit, or the codes
 * it raises (through its helpers too, in order) no longer match these rows.
 */

/** `view` takes `&self`. `call` takes `&mut self`. `init` is `#[init]`. A `#[private]` method is a `private callback`. */
type Kind = "view" | "call" | "init" | "private callback";

interface MethodCells {
  readonly kind: Kind;
  readonly who: string;
  /** "None" exactly when the method is not `#[payable]`. */
  readonly deposit: string;
  /** Each argument as `name: Type` in backticks, in order, or "None". */
  readonly args: string;
  /** The Rust return type in the first backticks, or "None" for no return value. */
  readonly returns: string;
  /**
   * Event names in backticks, and the callback that logs an event in a later receipt, or "None".
   */
  readonly events: string;
  /** `PROBARION:<Code>` codes a caller can meet, in the order the method checks them, or "None". */
  readonly errors: string;
}

const COLUMNS: readonly RefColumn[] = [
  { key: "method", label: "Method" },
  { key: "kind", label: "Kind" },
  { key: "who", label: "Who may call" },
  { key: "deposit", label: "Deposit" },
  { key: "args", label: "Arguments" },
  { key: "returns", label: "Returns" },
  { key: "events", label: "Events emitted" },
  { key: "errors", label: "Errors" },
];

const NONE = "None";
const ANYONE = "Anyone";
const ONE_YOCTO = "Exactly 1 yoctoNEAR";
const OWNER = "The owner, from a full-access key";
const APPROVER = "An approver, from a full-access key";
const FACTORY_OWNER = "The factory owner, from a full-access key";
const OWNER_GUARDS = "`NotOwner`, `RequiresOneYocto`";
const PAGE = "`from_index: u64`, `limit: u64`";

/** One row, anchored at `<prefix>-<name>`. */
function method(prefix: "vault" | "factory", name: string, cells: MethodCells): RefRow {
  return { id: `${prefix}-${name}`, cells: { method: `\`${name}\``, ...cells } };
}

const VAULT_ROWS: readonly RefRow[] = [
  // Setup and config: lib.rs
  method("vault", "new", {
    kind: "init",
    who: "Once, at deploy. The caller is stored as `factory` unless it is the vault account itself",
    deposit: NONE,
    args: "`owner: AccountId`, `approvers: Vec<AccountId>`, `usdc: AccountId`, `intents: AccountId`, `allowed_assets: Vec<AccountId>`, `daily_backstop: U128`, `held_ttl_ns: U64`",
    returns: "None. It stores the vault unfrozen, with no agents, no ledger key and no mandates",
    events: NONE,
    errors:
      "`InvalidInput`: no approvers or more than 10, more than 10 allowed assets, a zero `daily_backstop`, or a `held_ttl_ns` of 0 or over 30 days",
  }),
  method("vault", "get_config", {
    kind: "view",
    who: ANYONE,
    deposit: NONE,
    args: NONE,
    returns:
      "`VaultConfig`: `owner`, `approvers`, `usdc`, `intents`, `allowed_assets`, `daily_backstop`, `held_ttl_ns`, `frozen`, `factory`, `version`, `ledger_key`",
    events: NONE,
    errors: NONE,
  }),
  // Owner controls: admin.rs
  method("vault", "freeze", {
    kind: "call",
    who: "The owner, from a full-access key or a function-call key that may call the vault",
    deposit: NONE,
    args: NONE,
    returns: "None. New spends and approvals are refused until `unfreeze`",
    events: "`frozen`",
    errors: "`NotOwner`",
  }),
  method("vault", "unfreeze", {
    kind: "call",
    who: OWNER,
    deposit: ONE_YOCTO,
    args: NONE,
    returns: NONE,
    events: "`unfrozen`",
    errors: OWNER_GUARDS,
  }),
  method("vault", "withdraw", {
    kind: "call",
    who: OWNER,
    deposit: ONE_YOCTO,
    args: "`amount: U128`, in USDC base units",
    returns:
      "`Promise`: the USDC `ft_transfer` to the owner. A failed transfer fails the transaction",
    events: "`withdrawn`",
    errors: `${OWNER_GUARDS}, \`InvalidInput\` for a zero amount`,
  }),
  method("vault", "withdraw_intents", {
    kind: "call",
    who: OWNER,
    deposit: ONE_YOCTO,
    args: "`token: AccountId`, `amount: U128`",
    returns:
      "`Promise`: the NEAR Intents `ft_withdraw` of `amount` of `token` from the vault's balance there to the owner's NEAR account",
    events: "`withdrawn`",
    errors: `${OWNER_GUARDS}, \`InvalidInput\` for a zero amount`,
  }),
  // Mandates: mandates.rs
  method("vault", "create_mandate", {
    kind: "call",
    who: OWNER,
    deposit:
      "The mandate's storage, plus 0.00125 NEAR for a NEAR payee's USDC registration. The excess goes back to the caller",
    args: "`input: MandateInput`, with `payee`, `purpose_hash`, `max_per_payment`, `max_total`, `max_uses`, `expires_at_ns`, `approval_above`, `agent_pk`, `label`",
    returns: "`u64`: the new mandate's id, counting from 1",
    events: "`mandate_created`",
    errors: "`NotOwner`, `InvalidInput`, `AssetNotAllowed`, `InsufficientDeposit`",
  }),
  method("vault", "revoke_mandate", {
    kind: "call",
    who: OWNER,
    deposit: ONE_YOCTO,
    args: "`mandate_id: u64`",
    returns: "None. Payouts already sent keep their reservation until their callback",
    events: "`mandate_revoked`",
    errors: `${OWNER_GUARDS}, \`NoMandate\`, \`MandateInactive\` when it is already revoked`,
  }),
  method("vault", "get_mandate", {
    kind: "view",
    who: ANYONE,
    deposit: NONE,
    args: "`mandate_id: u64`",
    returns:
      "`Option<MandateView>`: the input's fields plus `id`, `spent`, `reserved`, `uses`, `status` and `created_at_ns`, or null",
    events: NONE,
    errors: NONE,
  }),
  method("vault", "list_mandates", {
    kind: "view",
    who: ANYONE,
    deposit: NONE,
    args: PAGE,
    returns: "`Vec<MandateView>`: up to 100 mandates, from position `from_index`",
    events: NONE,
    errors: NONE,
  }),
  // Keys: keys.rs
  method("vault", "add_agent", {
    kind: "call",
    who: OWNER,
    deposit: ONE_YOCTO,
    args: "`public_key: PublicKey`, `allowance: U128`, `label: String`",
    returns:
      "None. The vault adds the key to itself, allowed to call only `spend`, with `allowance` yoctoNEAR of gas",
    events: "`agent_added`",
    errors: `${OWNER_GUARDS}, \`InvalidInput\`: a zero allowance, a label over 64 bytes, 16 agents already, or a key that is already an agent key or the ledger key`,
  }),
  method("vault", "remove_agent", {
    kind: "call",
    who: OWNER,
    deposit: ONE_YOCTO,
    args: "`public_key: PublicKey`",
    returns: "None. The vault deletes the key from its account",
    events: "`agent_removed`",
    errors: `${OWNER_GUARDS}, \`InvalidInput\` when the key is not an agent key`,
  }),
  method("vault", "set_ledger_key", {
    kind: "call",
    who: OWNER,
    deposit: ONE_YOCTO,
    args: "`public_key: PublicKey`, `allowance: U128`",
    returns:
      "None. The vault deletes the previous ledger key, then adds this one, allowed to call only `anchor`",
    events: "`ledger_key_set`",
    errors: `${OWNER_GUARDS}, \`InvalidInput\`: a zero allowance, or a key that is already an agent key or the ledger key`,
  }),
  method("vault", "list_agents", {
    kind: "view",
    who: ANYONE,
    deposit: NONE,
    args: NONE,
    returns: "`Vec<AgentView>`: `public_key`, `label` and `added_at_ns` of every agent key",
    events: NONE,
    errors: NONE,
  }),
  // Spends: checks.rs and spend.rs
  method("vault", "check_spend", {
    kind: "view",
    who: "Anyone. It checks the request as if `signer_pk` had signed it",
    deposit: NONE,
    args: "`request: SpendRequest`, `signer_pk: PublicKey`",
    returns: "`Verdict`: `ok`, `code` and `would_hold`",
    events: NONE,
    errors: "None. A refusal comes back as the bare code in `code`",
  }),
  method("vault", "spend", {
    kind: "call",
    who: "An agent key: the vault account signs with a key `add_agent` added",
    deposit: NONE,
    args: "`request: SpendRequest`, with `mandate_id`, `amount`, `invoice_hash`, `ref`, `decision_hash`",
    returns:
      "`PromiseOrValue<SpendResult>`: `held` at once, or the payout, which resolves to `paid`, `burned` or `failed`",
    events:
      "`spend_held`, or `spend_submitted` and then, from `on_transfer` or `on_withdraw`, `spend_paid`, `spend_burned` or `spend_failed`",
    errors:
      "`NotAgent` when the call does not come from the vault itself, then the codes of the 14 spend checks",
  }),
  method("vault", "on_transfer", {
    kind: "private callback",
    who: "The vault itself, after its USDC `ft_transfer` to a NEAR payee",
    deposit: NONE,
    args: "`spend_id: u64`",
    returns: "`SpendResult`: `failed` when the transfer failed, else `paid`",
    events: "`spend_paid` or `spend_failed`",
    errors: NONE,
  }),
  method("vault", "on_withdraw", {
    kind: "private callback",
    who: "The vault itself, after its NEAR Intents `ft_withdraw` to a Base or Solana payee",
    deposit: NONE,
    args: "`spend_id: u64`",
    returns:
      '`SpendResult`: `failed` when the `ft_withdraw` failed or returned `"0"`, else `burned`, whatever else it returned',
    events: "`spend_burned` or `spend_failed`",
    errors: NONE,
  }),
  method("vault", "get_spend", {
    kind: "view",
    who: ANYONE,
    deposit: NONE,
    args: "`spend_id: u64`",
    returns:
      "`Option<SpendView>`: the request's fields plus `id`, `agent_pk`, `destination`, `status`, `created_at_ns`, `held_until_ns` and `memo`, or null",
    events: NONE,
    errors: NONE,
  }),
  method("vault", "list_spends", {
    kind: "view",
    who: ANYONE,
    deposit: NONE,
    args: PAGE,
    returns: "`Vec<SpendView>`: up to 100 spends, from position `from_index`",
    events: NONE,
    errors: NONE,
  }),
  // Holds: held.rs
  method("vault", "approve", {
    kind: "call",
    who: APPROVER,
    deposit: ONE_YOCTO,
    args: "`spend_id: u64`",
    returns:
      "`PromiseOrValue<SpendResult>`: always the payout, which resolves to `paid`, `burned` or `failed`",
    events:
      "`spend_approved`, `spend_submitted`, and then, from `on_transfer` or `on_withdraw`, `spend_paid`, `spend_burned` or `spend_failed`",
    errors:
      "`NotApprover`, `RequiresOneYocto`, `Frozen`, `NotHeld`, `HoldExpired`, `MandateInactive`",
  }),
  method("vault", "reject", {
    kind: "call",
    who: APPROVER,
    deposit: ONE_YOCTO,
    args: "`spend_id: u64`",
    returns: "None. It releases the reservation, the use and the invoice hash. The ref stays used",
    events: "`spend_rejected`",
    errors: "`NotApprover`, `RequiresOneYocto`, `NotHeld`",
  }),
  method("vault", "expire_held", {
    kind: "call",
    who: "Anyone, once the spend's `held_until_ns` has passed",
    deposit: NONE,
    args: "`spend_id: u64`",
    returns: "None. It releases the spend as `reject` does, and the spend then reads `expired`",
    events: "`spend_expired`",
    errors: "`NotHeld`, `HoldNotExpired`",
  }),
  // Anchors: anchors.rs
  method("vault", "anchor", {
    kind: "call",
    who: "The ledger key: the vault account signs with the key `set_ledger_key` added",
    deposit: NONE,
    args: "`seq: u64`, `root: String`, `count: u64`",
    returns: "None. It stores the anchor with its signing key and the block time",
    events: "`ledger_anchored`",
    errors:
      "`NotLedgerKey`, `BadSeq` unless `seq` is one above the last, `InvalidInput`: a `root` that is not 64 lowercase hex characters, or a `count` of 0 or below the last one",
  }),
  method("vault", "list_anchors", {
    kind: "view",
    who: ANYONE,
    deposit: NONE,
    args: PAGE,
    returns:
      "`Vec<AnchorView>`: `seq`, `root`, `count`, `at_ns` and `ledger_key` of up to 100 anchors",
    events: NONE,
    errors: NONE,
  }),
];

const FACTORY_ROWS: readonly RefRow[] = [
  method("factory", "new", {
    kind: "init",
    who: "Once, at the factory's deploy",
    deposit: NONE,
    args: "`owner: AccountId`, `usdc: AccountId`, `intents: AccountId`, `allowed_assets: Vec<AccountId>`, `min_deposit: U128`",
    returns: "None. It stores the factory with no versions and no vaults",
    events: NONE,
    errors: "`InvalidInput` for more than 10 allowed assets",
  }),
  method("factory", "get_config", {
    kind: "view",
    who: ANYONE,
    deposit: NONE,
    args: NONE,
    returns:
      "`FactoryConfig`: `owner`, `usdc`, `intents`, `allowed_assets`, `min_deposit`, and `current_version`, null before the first version",
    events: NONE,
    errors: NONE,
  }),
  method("factory", "create_vault", {
    kind: "call",
    who: "Anyone. The caller becomes the new vault's owner",
    deposit:
      "At least `min_deposit`, plus the code's storage for an embedded version. All of it goes to the new vault",
    args: "`name: String`, `approvers: Vec<AccountId>`, `daily_backstop: U128`, `held_ttl_ns: U64`",
    returns:
      "`Promise`: it resolves to the new vault's account id, `<name>.<factory>`, or to null when the batch failed, such as for a taken name",
    events: "`vault_created`, from `on_vault_created`, only when the batch succeeded",
    errors:
      "`InvalidInput`: a `name` outside `^[a-z0-9][a-z0-9_-]{1,30}$` or not a valid account id, init values the vault's `new` refuses, or no version yet. Then `InsufficientDeposit`",
  }),
  method("factory", "on_vault_created", {
    kind: "private callback",
    who: "The factory itself, after the `create_vault` batch",
    deposit: NONE,
    args: "`name: String`, `owner: AccountId`, `deposit: U128`, `version: u32`",
    returns:
      "`Option<AccountId>`: the vault's account id, or null after a failed batch, when it sends `deposit` back to `owner`",
    events: "`vault_created`",
    errors: NONE,
  }),
  method("factory", "list_vaults", {
    kind: "view",
    who: ANYONE,
    deposit: NONE,
    args: PAGE,
    returns:
      "`Vec<VaultRecord>`: `account_id`, `owner`, `version` and `created_at_ns` of up to 100 vaults",
    events: NONE,
    errors: NONE,
  }),
  method("factory", "vault_version", {
    kind: "view",
    who: ANYONE,
    deposit: NONE,
    args: "`account_id: AccountId`",
    returns:
      "`Option<u32>`: the version the factory created that vault from, or null for an account it did not create",
    events: NONE,
    errors: NONE,
  }),
  method("factory", "versions", {
    kind: "view",
    who: ANYONE,
    deposit: NONE,
    args: NONE,
    returns:
      "`Vec<VersionView>`: `index`, `code_hash`, `mode`, `notes` and `at_ns` of every version. The last one is current",
    events: NONE,
    errors: NONE,
  }),
  method("factory", "store_code", {
    kind: "call",
    who: FACTORY_OWNER,
    deposit: ONE_YOCTO,
    args: "None. The call's raw input is the wasm",
    returns: "`String`: the code's base58 sha256, which is its NEAR code hash",
    events: NONE,
    errors: `${OWNER_GUARDS}, \`InvalidInput\` for an empty input`,
  }),
  method("factory", "add_version", {
    kind: "call",
    who: FACTORY_OWNER,
    deposit: ONE_YOCTO,
    args: "`code_hash: String`, `mode: String`, `notes: String`",
    returns: "`u32`: the new version's index, counting from 1. It becomes the current version",
    events: "`version_added`",
    errors: `${OWNER_GUARDS}, \`InvalidInput\`: notes over 256 bytes, a hash that is not 32 bytes in base58, a \`mode\` other than \`global\` or \`embedded\`, or embedded code that was never stored`,
  }),
  method("factory", "publish_global", {
    kind: "call",
    who: FACTORY_OWNER,
    deposit: ONE_YOCTO,
    args: NONE,
    returns:
      "`Promise`: it deploys the current version's stored wasm as a global contract, paid from the factory's balance",
    events: NONE,
    errors: `${OWNER_GUARDS}, \`InvalidInput\` unless the current version is embedded and its code is stored`,
  }),
];

export const TABLES: readonly RefTable[] = [
  {
    id: "contract-vault-methods",
    label: "Vault methods",
    columns: COLUMNS,
    rows: VAULT_ROWS,
  },
  {
    id: "contract-factory-methods",
    label: "Factory methods",
    columns: COLUMNS,
    rows: FACTORY_ROWS,
  },
];
