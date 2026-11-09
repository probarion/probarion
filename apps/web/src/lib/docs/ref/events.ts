import type { RefColumn, RefTable } from "./types";

/**
 * The events tables of the docs reference (`/docs/build/events`). The rows follow the event enums in
 * `contracts/vault/src/events.rs` and `contracts/factory/src/lib.rs`, in declaration order, and
 * `test/docs-ref-events.test.ts` pins them to that source: the names, the fields and their types, the
 * standards, the versions, the functions that build each event and the exported methods whose receipt
 * logs it, read from the call graph.
 */

/** A `data` cell: each field as `name: Type`, in the order the enum declares them. */
const data = (...fields: string[]): string => fields.map((f) => `\`${f}\``).join(", ");

const EVENT_COLUMNS: readonly RefColumn[] = [
  { key: "event", label: "Event" },
  { key: "by", label: "Emitted by" },
  { key: "data", label: "Data fields" },
  { key: "meaning", label: "Meaning" },
];

/** The four keys of a NEP-297 line, with each contract's values. */
const LINE: RefTable = {
  id: "events-line",
  label: "The keys of an event line",
  columns: [
    { key: "key", label: "Key" },
    { key: "vault", label: "Vault contract" },
    { key: "factory", label: "Factory contract" },
    { key: "meaning", label: "Meaning" },
  ],
  rows: [
    {
      id: "events-line-standard",
      cells: {
        key: "`standard`",
        vault: "`probarion`",
        factory: "`probarion_factory`",
        meaning:
          "The family of events. Filter on it together with the account that logged the line.",
      },
    },
    {
      id: "events-line-version",
      cells: {
        key: "`version`",
        vault: "`1.0.0`",
        factory: "`1.0.0`",
        meaning: "The version of the event's shape. Every event of both contracts is at this one.",
      },
    },
    {
      id: "events-line-event",
      cells: {
        key: "`event`",
        vault: "A name from the vault events table",
        factory: "A name from the factory events table",
        meaning: "The Rust variant's name in snake_case.",
      },
    },
    {
      id: "events-line-data",
      cells: {
        key: "`data`",
        vault: "One JSON object",
        factory: "One JSON object",
        meaning:
          "The variant's fields, in the order the tables list them. An object, not the array that NEP-141 events use.",
      },
    },
  ],
};

/** `#[near(event_json(standard = "probarion"))] pub enum VaultEvent` in contracts/vault/src/events.rs. */
const VAULT: RefTable = {
  id: "events-vault",
  label: "Vault events",
  columns: EVENT_COLUMNS,
  rows: [
    {
      id: "events-mandate_created",
      cells: {
        event: "`mandate_created`",
        by: "`create_mandate`",
        data: data(
          "mandate_id: u64",
          "payee: Payee",
          "max_total: U128",
          "max_per_payment: U128",
          "expires_at_ns: U64",
          "purpose_hash: String",
          "agent_pk: PublicKey",
        ),
        meaning:
          "The owner stored a new mandate. The line leaves out `max_uses`, `approval_above` and `label`: read them with `get_mandate`.",
      },
    },
    {
      id: "events-mandate_revoked",
      cells: {
        event: "`mandate_revoked`",
        by: "`revoke_mandate`",
        data: data("mandate_id: u64"),
        meaning:
          "The owner revoked the mandate. It refuses new spends and approvals from now on. A payout already sent still settles.",
      },
    },
    {
      id: "events-agent_added",
      cells: {
        event: "`agent_added`",
        by: "`add_agent`",
        data: data("public_key: PublicKey", "label: Option<String>"),
        meaning:
          "The owner registered an agent key. `label` is always set here. The key itself is added, limited to `spend`, in a separate receipt that can still fail.",
      },
    },
    {
      id: "events-agent_removed",
      cells: {
        event: "`agent_removed`",
        by: "`remove_agent`",
        data: data("public_key: PublicKey", "label: Option<String>"),
        meaning:
          "The owner removed an agent key. `label` is always set: the removed key's label. The key is deleted in a separate receipt.",
      },
    },
    {
      id: "events-ledger_key_set",
      cells: {
        event: "`ledger_key_set`",
        by: "`set_ledger_key`",
        data: data("public_key: PublicKey"),
        meaning:
          "The owner set the ledger key, which may call only `anchor`. Deleting the previous key and adding this one run as two separate receipts.",
      },
    },
    {
      id: "events-spend_held",
      cells: {
        event: "`spend_held`",
        by: "`spend`, through `hold`",
        data: data(
          "spend_id: u64",
          "mandate_id: u64",
          "amount: U128",
          "invoice_hash: String",
          "decision_hash: String",
          "held_until_ns: U64",
        ),
        meaning:
          "The amount is above the mandate's `approval_above`. Nothing is sent. The amount stays reserved until an approver rejects it, the approved payout settles or fails, or someone calls `expire_held` after `held_until_ns`.",
      },
    },
    {
      id: "events-spend_submitted",
      cells: {
        event: "`spend_submitted`",
        by: "`spend` or `approve`, through `execute_payout`",
        data: data(
          "spend_id: u64",
          "mandate_id: u64",
          "amount: U128",
          "invoice_hash: String",
          "decision_hash: String",
          "destination: Payee",
        ),
        meaning:
          "The vault started the payout to the mandate's payee. Not final: `spend_paid`, `spend_burned` or `spend_failed` follows in the callback receipt.",
      },
    },
    {
      id: "events-spend_approved",
      cells: {
        event: "`spend_approved`",
        by: "`approve`",
        data: data("spend_id: u64", "by: AccountId"),
        meaning:
          "An approver approved a held spend. `spend_submitted` follows in the same receipt.",
      },
    },
    {
      id: "events-spend_rejected",
      cells: {
        event: "`spend_rejected`",
        by: "`reject`",
        data: data("spend_id: u64", "by: AccountId"),
        meaning:
          "An approver rejected a held spend. The reservation is released, and the spend's ref stays used.",
      },
    },
    {
      id: "events-spend_expired",
      cells: {
        event: "`spend_expired`",
        by: "`expire_held`",
        data: data("spend_id: u64"),
        meaning:
          "Someone released a hold after its window ended: anyone may call `expire_held`. The reservation is released, and the ref stays used.",
      },
    },
    {
      id: "events-spend_paid",
      cells: {
        event: "`spend_paid`",
        by: "`on_transfer`, through `settle`",
        data: data("spend_id: u64", "mandate_id: u64", "amount: U128", "destination: Payee"),
        meaning:
          "The USDC transfer to the NEAR payee succeeded. The amount counts as spent, and the spend is final.",
      },
    },
    {
      id: "events-spend_burned",
      cells: {
        event: "`spend_burned`",
        by: "`on_withdraw`, through `settle`",
        data: data(
          "spend_id: u64",
          "mandate_id: u64",
          "amount: U128",
          "chain: Chain",
          "address: String",
          "asset: AccountId",
          "memo: String",
        ),
        meaning:
          'The withdrawal through NEAR Intents neither failed nor returned `"0"`, so the vault counts the amount as spent toward `address` on `chain`. `memo` is `WITHDRAW_TO:` and the address. The release on that chain is not in this event.',
      },
    },
    {
      id: "events-spend_failed",
      cells: {
        event: "`spend_failed`",
        by: "`on_transfer` or `on_withdraw`, through `fail_spend`",
        data: data("spend_id: u64", "mandate_id: u64", "amount: U128", "reason: String"),
        meaning:
          "The payout did not go through, and the reservation is released. `reason` is `ft_transfer_failed`, `ft_withdraw_failed` or `ft_withdraw_refunded`.",
      },
    },
    {
      id: "events-frozen",
      cells: {
        event: "`frozen`",
        by: "`freeze`",
        data: data("by: AccountId"),
        meaning:
          "The owner froze the vault. Spends and approvals are refused until it is unfrozen. Reject and expiry still work.",
      },
    },
    {
      id: "events-unfrozen",
      cells: {
        event: "`unfrozen`",
        by: "`unfreeze`",
        data: data("by: AccountId"),
        meaning: "The owner unfroze the vault.",
      },
    },
    {
      id: "events-ledger_anchored",
      cells: {
        event: "`ledger_anchored`",
        by: "`anchor`",
        data: data("seq: u64", "root: String", "count: u64"),
        meaning:
          "The ledger key anchored the off-chain ledger. `seq` goes up by one each time, `count` is the number of entries covered, and `root` is the link of the last of them.",
      },
    },
    {
      id: "events-withdrawn",
      cells: {
        event: "`withdrawn`",
        by: "`withdraw` or `withdraw_intents`",
        data: data("to: AccountId", "token: AccountId", "amount: U128"),
        meaning:
          "The owner asked for `amount` of `token` back to `to`, the owner's account. It is logged before the transfer runs, and its receipt shows `SuccessReceiptId` even when the transfer then fails: follow that receipt id to the token's or NEAR Intents' receipt, or read the transaction's final status.",
      },
    },
  ],
};

/** `#[near(event_json(standard = "probarion_factory"))] pub enum FactoryEvent` in contracts/factory/src/lib.rs. */
const FACTORY: RefTable = {
  id: "events-factory",
  label: "Factory events",
  columns: EVENT_COLUMNS,
  rows: [
    {
      id: "events-vault_created",
      cells: {
        event: "`vault_created`",
        by: "`on_vault_created`, the callback of `create_vault`",
        data: data("account_id: AccountId", "owner: AccountId", "version: u32"),
        meaning:
          "The factory created and initialised the vault account and recorded it. When the batch failed, nothing is logged and the deposit goes back to the owner.",
      },
    },
    {
      id: "events-version_added",
      cells: {
        event: "`version_added`",
        by: "`add_version`",
        data: data("index: u32", "code_hash: String", "mode: String"),
        meaning:
          "The factory owner added a vault code version, which new vaults now get. `mode` is `global` or `embedded`, and `code_hash` is base58.",
      },
    },
  ],
};

/** How each Rust type of an event field looks in the JSON line. */
const TYPES: RefTable = {
  id: "events-types",
  label: "Field types in the JSON line",
  columns: [
    { key: "type", label: "Rust type" },
    { key: "json", label: "In the line" },
    { key: "example", label: "Example" },
  ],
  rows: [
    {
      id: "events-type-u64",
      cells: {
        type: "`u64`",
        json: "A JSON number: an id, a seq or a count.",
        example: "`1`",
      },
    },
    {
      id: "events-type-u32",
      cells: { type: "`u32`", json: "A JSON number.", example: "`1`" },
    },
    {
      id: "events-type-json-u128",
      cells: {
        type: "`U128`",
        json: "A decimal string, so no precision is lost. Amounts are in the token's smallest unit: 6 decimals for USDC.",
        example: '`"1000000"`, which is 1 USDC',
      },
    },
    {
      id: "events-type-json-u64",
      cells: {
        type: "`U64`",
        json: "A decimal string. The `_ns` fields are nanoseconds since the Unix epoch, on the block clock.",
        example: '`"1794182400000000000"`',
      },
    },
    {
      id: "events-type-string",
      cells: {
        type: "`String`",
        json: "A JSON string. The vault's `_hash` fields and `root` are 64 lowercase hex characters, and the factory's `code_hash` is base58.",
        example: '`"8f94c0bb..."`',
      },
    },
    {
      id: "events-type-option-string",
      cells: {
        type: "`Option<String>`",
        json: "A string, or `null`. The vault always sets it today.",
        example: '`"research agent"`',
      },
    },
    {
      id: "events-type-accountid",
      cells: {
        type: "`AccountId`",
        json: "A NEAR account id, as a string.",
        example: '`"v0.probarion.testnet"`',
      },
    },
    {
      id: "events-type-publickey",
      cells: {
        type: "`PublicKey`",
        json: "A public key as a string, with its curve first.",
        example: '`"ed25519:..."`',
      },
    },
    {
      id: "events-type-payee",
      cells: {
        type: "`Payee`",
        json: "An object tagged by `type`: `near` with `account_id`, or `intents` with `chain`, `address` and `asset`.",
        example: '`{"type":"near","account_id":"probarion-payee.testnet"}`',
      },
    },
    {
      id: "events-type-chain",
      cells: {
        type: "`Chain`",
        json: "A string: `base` or `solana`.",
        example: '`"base"`',
      },
    },
  ],
};

export const TABLES: readonly RefTable[] = [LINE, VAULT, FACTORY, TYPES];
