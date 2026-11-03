# Probarion: shared interfaces (source of truth for all plans)

This is the contract between the plans:

- `01-spikes`: the throwaway pre-hackathon spikes, run in a separate repo.
- `02-contracts`: the vault, factory and test contracts (Rust).
- `03-core-sdk-cli`: the TypeScript packages.
- `04-web`: the hosted app.
- `05-mcp-ops-launch`: the MCP server, operations, docs and submission.

When a plan needs a name, a type, a JSON shape or a constant, it takes it from here, verbatim. If a plan finds something here wrong or missing, it records a proposed change in its own "Interface change requests" section. It does not silently diverge.

Spec: `docs/superpowers/specs/2026-10-21-probarion-design.md`. Evidence: `reports/Chiến lược NEAR Hackathon 2026.md`.

---

## 1. Repository layout (fresh repo `probarion/probarion`, created after 2026-11-01 00:00 UTC)

```
probarion/
├─ package.json                # pnpm workspaces root; scripts: verify, verify:full, build, test, lint, typecheck
├─ pnpm-workspace.yaml         # packages/*, apps/*, eval
├─ tsconfig.base.json
├─ biome.json                  # lint + format for TS
├─ .nvmrc                      # 24
├─ rust-toolchain.toml         # stable, wasm32-unknown-unknown target
├─ .github/workflows/ci.yml    # rust unit + sandbox tests, TS typecheck/test, gitleaks
├─ contracts/
│  ├─ Cargo.toml               # [workspace] members = vault, factory, intents-stub, test-ft, integration-tests
│  ├─ vault/                   # crate probarion-vault
│  ├─ factory/                 # crate probarion-factory
│  ├─ intents-stub/            # crate intents-stub   (sandbox/testnet stand-in for intents.near; never on mainnet)
│  ├─ test-ft/                 # crate test-ft        (NEP-141 test token; sandbox/testnet only)
│  └─ integration-tests/       # crate integration-tests (near-workspaces)
├─ packages/
│  ├─ core/                    # @probarion/core  — pure TS, no network: types, canonical hashing, policy, ledger, attestation checks, verifier checks
│  ├─ sdk/                     # @probarion/sdk   — NEAR RPC client, vault client, executor, NEAR AI Cloud adapter, Probarion class, FileLedgerStore
│  ├─ cli/                     # probarion        — CLI (bin: probarion)
│  └─ mcp/                     # @probarion/mcp   — MCP server (bin: probarion-mcp)
├─ apps/
│  └─ web/                     # Next.js app: console, payables, /proof, /open, /canary, /docs, /status link, /security
├─ eval/                       # 60-invoice eval set + runner (workspace package @probarion/eval, private)
├─ docs/                       # ARCHITECTURE.md, THREAT_MODEL.md, RUNBOOK.md, PRIOR_WORK.md, specs/ (copy of pre-hackathon spec, disclosed)
├─ README.md  AGENTS.md  SECURITY.md  LICENSE (MIT)  CHANGELOG.md
```

## 2. Toolchain and versions (pin exactly; change only through an interface change request)

| Tool | Version |
|---|---|
| Rust | stable **≥ 1.93** (near-sdk 5.29.1 declares `rust-version = 1.93`); pin the exact version recorded by spike S3 (proposed 1.99.1) in `rust-toolchain.toml`; target `wasm32-unknown-unknown` |
| near-sdk | `=5.29.1` (do **not** use 5.30 release candidates; protocol 88 / NEP-655) |
| near-contract-standards | `=5.29.1` |
| cargo-near | `0.22.0` |
| near-workspaces | `0.23.0` |
| near-cli-rs | `0.30.1` |
| Node.js | 24 LTS (required by `@nearai/inference-sdk`) |
| pnpm | 10.x |
| TypeScript | 5.x (strict) |
| Vitest | latest 3.x at 2026-11-01 |
| @modelcontextprotocol/sdk | 1.x (>= 1.32.1; not the v2 split packages) |
| zod | 4.x |
| pdf-lib / unpdf / tsx | 1.17.1 / 1.x / 4.x |
| Next.js | 16.x (App Router) |
| @hot-labs/near-connect | 0.11.4 or later 0.x |
| near-api-js | 7.x (`7.3.1` or later 7.x) |
| Wallet connect (web) | `@hot-labs/near-connect` (NEAR docs' current recommendation) |

**Dev OS:** use **WSL2 Ubuntu** (or a Linux devcontainer) for everything that touches contracts. `near-sandbox`, which `near-workspaces` uses, ships Linux/macOS binaries, and `cargo near build` reproducible mode uses Docker. Confirming this is part of spike S3.

**Library API drift rule:** this plan set writes code against the APIs above as best understood on 2026-10-21. If an installed library's API differs, follow the installed version's docs, but keep **this document's** names, JSON shapes and error codes unchanged.

## 3. Network constants

```ts
// packages/core/src/constants.ts
export const NETWORKS = {
  mainnet: {
    rpcUrls: ["https://rpc.mainnet.fastnear.com", "https://rpc.intea.rs"], // intea answered on 2026-10-21 but ran nearcore 2.14.0-rc.2; S3 confirms. Configurable via NEAR_RPC_URLS
    usdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", // native USDC, 6 decimals
    intents: "intents.near",
    allowedAssets: {
      base: "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",   // POA USDC on Base, 6 decimals
      solana: "sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",    // POA USDC on Solana, 6 decimals (stretch)
    },
    factory: "vaults.probarion.near",
    explorerTx: "https://nearblocks.io/txns/",
  },
  testnet: {
    rpcUrls: ["https://rpc.testnet.fastnear.com"],
    usdc: "usdc.probarion.testnet",           // test-ft deployment
    intents: "intents-stub.probarion.testnet", // intents-stub deployment (Intents has no testnet)
    allowedAssets: { base: "base-usdc.probarion.testnet", solana: "sol-usdc.probarion.testnet" }, // test-ft deployments acting as POA tokens
    factory: "vaults.probarion.testnet",
    explorerTx: "https://testnet.nearblocks.io/txns/",
  },
} as const;
export const USDC_DECIMALS = 6;
export const WITHDRAW_MEMO_PREFIX = "WITHDRAW_TO:";
export const EVENT_STANDARD = "probarion";
export const FACTORY_EVENT_STANDARD = "probarion_factory";
export const EVENT_VERSION = "1.0.0";
export const NEARAI_BASE_URL = "https://cloud-api.near.ai/v1";
```

## 4. Vault contract ABI (`contracts/vault`, JSON over near-sdk; amounts are `U128` decimal strings in USDC smallest units; times are `U64` nanosecond strings)

### 4.1 Types

```rust
#[near(serializers = [json, borsh])]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Payee {
    Near { account_id: AccountId },
    Intents { chain: Chain, address: String, asset: AccountId },
}
#[near(serializers = [json, borsh])] #[serde(rename_all = "snake_case")]
pub enum Chain { Base, Solana }

#[near(serializers = [json])]
pub struct MandateInput {
    pub payee: Payee,
    pub purpose_hash: String,     // 64 lowercase hex chars
    pub max_per_payment: U128,
    pub max_total: U128,
    pub max_uses: u32,
    pub expires_at_ns: U64,
    pub approval_above: U128,     // spends with amount > approval_above are Held
    pub agent_pk: PublicKey,      // "ed25519:..."
    pub label: String,            // ≤ 64 bytes
}

#[near(serializers = [json])] #[serde(rename_all = "snake_case")]
pub enum MandateStatus { Active, Revoked, Exhausted }

#[near(serializers = [json])]
pub struct MandateView {
    pub id: u64, pub payee: Payee, pub purpose_hash: String,
    pub max_per_payment: U128, pub max_total: U128, pub spent: U128, pub reserved: U128,
    pub max_uses: u32, pub uses: u32, pub expires_at_ns: U64, pub approval_above: U128,
    pub agent_pk: PublicKey, pub label: String, pub status: MandateStatus, pub created_at_ns: U64,
}

#[near(serializers = [json])]
pub struct SpendRequest {
    pub mandate_id: u64,
    pub amount: U128,
    pub invoice_hash: String,   // 64 hex
    pub r#ref: String,          // JSON key "ref"; idempotency key, ≤ 64 bytes, unique per vault
    pub decision_hash: String,  // 64 hex = body_hash of the ledger decision entry
}

#[near(serializers = [json, borsh])] #[serde(rename_all = "snake_case")]
pub enum SpendStatus { Held, Pending, Paid, Burned, Failed, Rejected, Expired }

#[near(serializers = [json])]
pub struct SpendView {
    pub id: u64, pub mandate_id: u64, pub amount: U128, pub invoice_hash: String, pub r#ref: String,
    pub decision_hash: String, pub agent_pk: PublicKey, pub destination: Payee,
    pub status: SpendStatus, pub created_at_ns: U64, pub held_until_ns: Option<U64>,
    pub memo: Option<String>,    // "WITHDRAW_TO:<address>" for Intents payees
}

#[near(serializers = [json])]
pub struct SpendResult { pub spend_id: u64, pub status: SpendStatus }

#[near(serializers = [json])]
pub struct Verdict { pub ok: bool, pub code: Option<String>, pub would_hold: bool }

#[near(serializers = [json])]
pub struct AnchorView { pub seq: u64, pub root: String, pub count: u64, pub at_ns: U64, pub ledger_key: PublicKey } // ledger_key = signer pk at anchor time (supports rotation)

#[near(serializers = [json])]
pub struct AgentView { pub public_key: PublicKey, pub label: String, pub added_at_ns: U64 }

#[near(serializers = [json])]
pub struct VaultConfig {
    pub owner: AccountId, pub approvers: Vec<AccountId>, pub usdc: AccountId, pub intents: AccountId,
    pub allowed_assets: Vec<AccountId>, pub daily_backstop: U128, pub held_ttl_ns: U64,
    pub frozen: bool, pub factory: Option<AccountId>, pub version: String, // version = crate version, e.g. "0.1.0"
    pub ledger_key: Option<PublicKey>,
}
```

### 4.2 Methods

| Method | Kind | Caller rule | Behaviour |
|---|---|---|---|
| `new(owner, approvers, usdc, intents, allowed_assets, daily_backstop, held_ttl_ns)` | `#[init]` | any (atomic with deploy) | Stores config; `factory = Some(predecessor)` if predecessor ≠ current account |
| `add_agent(public_key, allowance: U128, label)` | change | owner | Adds FC key to **self**: receiver = self, methods `"spend"`, allowance in yoctoNEAR. Event `agent_added` |
| `remove_agent(public_key)` | change | owner | DeleteKey; event `agent_removed` |
| `set_ledger_key(public_key, allowance: U128)` | change | owner | Deletes previous ledger key if any; adds FC key methods `"anchor"`; event `ledger_key_set` |
| `create_mandate(input: MandateInput) -> u64` | `#[payable]` change | owner | Validates; for `Near` payee calls `usdc.storage_deposit({account_id, registration_only:true})` with 0.00125 NEAR (detached); refunds excess deposit. Event `mandate_created` |
| `revoke_mandate(mandate_id)` | change | owner | Status Revoked; reserved amounts of pending spends are untouched. Event `mandate_revoked` |
| `spend(request: SpendRequest) -> PromiseOrValue<SpendResult>` | change | **agent key only**: `predecessor == current_account` AND `signer_account_pk` ∈ agents AND == `mandate.agent_pk` | Checks in this order: frozen, mandate exists, active, not expired, agent matches, amount > 0, ≤ per-payment, uses left, spent+reserved+amount ≤ total, invoice unused, ref unused, daily backstop. Reserves. If amount > approval_above → Held (Value). Else executes payout (Promise) |
| `approve(spend_id) -> PromiseOrValue<SpendResult>` | change | approver | Held and not expired → executes payout. Event `spend_approved` |
| `reject(spend_id)` | change | approver | Held → Rejected, release reservation. Event `spend_rejected` |
| `expire_held(spend_id)` | change | anyone | Held and `now > held_until_ns` → Expired, release. Event `spend_expired` |
| `freeze()` / `unfreeze()` | change | owner | Events `frozen` / `unfrozen` |
| `withdraw(amount: U128)` | change | owner | `usdc.ft_transfer(owner, amount)`; event `withdrawn` |
| `withdraw_intents(token: AccountId, amount: U128)` | change | owner | `intents.ft_withdraw(token, receiver_id=owner, amount, memo=None, msg=None)` 1 yocto; event `withdrawn` |
| `anchor(seq: u64, root: String, count: u64)` | change | **ledger key only** (predecessor == self AND signer pk == ledger_key) | `seq == last_seq + 1` (first is 1); stores in Vector; event `ledger_anchored` |
| `on_transfer(spend_id) -> SpendResult` | `#[private]` callback | self | Success → Paid (event `spend_paid`); failure → Failed, release (event `spend_failed`) |
| `on_withdraw(spend_id) -> SpendResult` | `#[private]` callback | self | Returned U128 == amount → Burned (event `spend_burned`); 0 or error → Failed, release |
| `check_spend(request: SpendRequest, signer_pk: PublicKey) -> Verdict` | view | any | Same checks as `spend`, no state change |
| `get_mandate(mandate_id) -> Option<MandateView>` | view | | |
| `list_mandates(from_index: u64, limit: u64) -> Vec<MandateView>` | view | | |
| `get_spend(spend_id) -> Option<SpendView>` | view | | |
| `list_spends(from_index: u64, limit: u64) -> Vec<SpendView>` | view | | |
| `list_anchors(from_index: u64, limit: u64) -> Vec<AnchorView>` | view | | |
| `get_config() -> VaultConfig` | view | | |
| `list_agents() -> Vec<AgentView>` | view | | |

**v2 rules (reconciliation 2026-10-21):**
- **One-yocto rule:** these mutating owner and approver methods require **exactly 1 yoctoNEAR** attached, otherwise `PROBARION:RequiresOneYocto`: `add_agent`, `remove_agent`, `set_ledger_key`, `revoke_mandate`, `approve`, `reject`, `unfreeze`, `withdraw`, `withdraw_intents`. The effect is that only a full-access key, through an explicit wallet prompt, can call them. Dapp login FC keys and XSS cannot. Three exceptions: `create_mandate` (payable; its deposit must already cover storage), `freeze` (protective, so any owner key may call it, no deposit) and `expire_held` (anyone). Factory owner methods (`add_version`, `store_code`, optional `publish_global`) follow the same rule.
- **Ids and pagination:** mandate, spend, anchor and factory-version ids start at **1**. `from_index` in `list_*` views is a 0-based position, and `limit` is capped at 100.
- **Preconditions** run before the ordered checks: `NotAgent` (signer pk is not an agent; for `spend`, also predecessor != vault), then `InvalidInput` (hash or ref format).
- **`Verdict.code`** is the bare code (`"NoMandate"`), without the `PROBARION:` prefix. The TS mirror type is named `CheckSpendVerdict`.
- **`MandateStatus`** is derived from state. `uses` counts live spends, and a released spend gives its use back.
- **Lifecycle:** `invoice_hash` and `ref` are consumed at reservation. On Failed, Rejected or Expired the `invoice_hash` is released and `ref` stays consumed.
- **Daily backstop:** UTC bucket `block_timestamp_ns / 86_400_000_000_000`. Each spend stores its day index; a release subtracts only within that same day.
- **`on_withdraw`:** releases only on an error or a `"0"` result; anything else counts as Burned.
- **`approve`:** refuses with `Frozen` while frozen and with `MandateInactive` after a revocation. It is valid while `now <= held_until_ns`; `expire_held` is valid only when `now > held_until_ns`.
- **`create_mandate` validation:**
  - an Intents asset must be in `allowed_assets` and carry its chain prefix (`base-`, `sol-`);
  - a NEAR payee is not the vault itself;
  - the deposit covers the measured storage, plus 0.00125 NEAR for a NEAR payee.
- **Input limits** (`InvalidInput` otherwise):
  - 1-10 approvers, <= 10 allowed assets, `daily_backstop > 0`, `held_ttl_ns` <= 30 days;
  - <= 16 agents, with agent and ledger keys distinct;
  - anchor root is 64 hex and `count` never decreases.
- **Withdrawals:** `withdraw` and `withdraw_intents` return the transfer promise.
- **Factory:** reuses `NotOwner`, `InvalidInput` and `InsufficientDeposit`. `store_code` returns the base58 hash. Embedded mode needs `min_deposit` plus the code-storage cost. Optional `publish_global()` (owner, 1 yocto) deploys the stored code as a global contract by hash.

Payout execution:
- `Near` payee: `usdc.ft_transfer(receiver_id = payee, amount, memo = Some("probarion:<spend_id>"))` with 1 yocto and 15 Tgas, then `on_transfer`.
- `Intents` payee: `intents.ft_withdraw(token = asset, receiver_id = asset, amount, memo = Some("WITHDRAW_TO:<address>"), msg = None)` with 1 yocto and 100 Tgas, then `on_withdraw`.

### 4.3 Error codes (panic message is exactly `PROBARION:<Code>`)

`NoMandate`, `MandateInactive`, `MandateExpired`, `NotMandateAgent`, `ZeroAmount`, `OverPerPayment`, `UsesExhausted`, `OverMandateTotal`, `DuplicateInvoice`, `DuplicateRef`, `OverDailyBackstop`, `Frozen`, `NotAgent`, `NotOwner`, `NotApprover`, `NotLedgerKey`, `NotHeld`, `HoldExpired`, `HoldNotExpired`, `BadSeq`, `AssetNotAllowed`, `InvalidInput`, `InsufficientDeposit`, `RequiresOneYocto`.

`PayeeMismatch` is **off-chain only** (rule `mandate.payee_mismatch`), because `SpendRequest` has no address field.

### 4.4 Events (NEP-297, `standard: "probarion"`, `version: "1.0.0"`; log line `EVENT_JSON:{...}`)

| event | data fields |
|---|---|
| `mandate_created` | `mandate_id, payee, max_total, max_per_payment, expires_at_ns, purpose_hash, agent_pk` |
| `mandate_revoked` | `mandate_id` |
| `agent_added` / `agent_removed` | `public_key, label?` |
| `ledger_key_set` | `public_key` |
| `spend_held` | `spend_id, mandate_id, amount, invoice_hash, decision_hash, held_until_ns` |
| `spend_submitted` | `spend_id, mandate_id, amount, invoice_hash, decision_hash, destination` |
| `spend_approved` / `spend_rejected` | `spend_id, by` |
| `spend_expired` | `spend_id` |
| `spend_paid` | `spend_id, mandate_id, amount, destination` |
| `spend_burned` | `spend_id, mandate_id, amount, chain, address, asset, memo` |
| `spend_failed` | `spend_id, mandate_id, amount, reason` |
| `frozen` / `unfrozen` | `by` |
| `ledger_anchored` | `seq, root, count` |
| `withdrawn` | `to, token, amount` |

### 4.5 Invariants (property-tested in 02-contracts)

- I1: no transfer without an active mandate.
- I2: `spent + reserved ≤ max_total`.
- I3: each `invoice_hash` is paid at most once per vault.
- I4: an agent key can call only `spend` and attaches no deposit.
- I5: only an approver executes a Held spend.
- I6: anchor seq is strictly +1.
- I7: memo == `WITHDRAW_TO:` + `mandate.address`, and the asset is in `allowed_assets`.
- I8: the vault never calls `add_public_key` on intents.
- I9: a factory vault has zero access keys at creation.

## 5. Factory contract ABI (`contracts/factory`, account `vaults.probarion.near`)

| Method | Kind | Caller | Behaviour |
|---|---|---|---|
| `new(owner: AccountId, usdc, intents, allowed_assets: Vec<AccountId>, min_deposit: U128)` | init | deployer | |
| `create_vault(name: String, approvers: Vec<AccountId>, daily_backstop: U128, held_ttl_ns: U64) -> Promise` | `#[payable]` | anyone; **owner of the new vault = predecessor** | `name` matches `^[a-z0-9][a-z0-9_-]{1,30}$`; deposit ≥ `min_deposit`; batch on `<name>.<factory>`: CreateAccount, Transfer(deposit), UseGlobalContract(hash) **or** DeployContract(stored wasm), FunctionCall `new` with factory config; then `on_vault_created` |
| `on_vault_created(name, owner, deposit: U128, version: u32) -> Option<AccountId>` | `#[private]` | self | Success → registry + event `vault_created`; failure → refund the deposit to owner |
| `add_version(code_hash: String, mode: "global" \| "embedded", notes: String) -> u32` | change | factory owner | For `embedded`, wasm must have been stored by `store_code` with the same sha256 |
| `store_code()` | change | factory owner | Raw wasm as input bytes (`env::input()`), stored under its sha256 |
| `versions() -> Vec<VersionView>` | view | | `VersionView { index: u32, code_hash: String, mode: String, notes: String, at_ns: U64 }` |
| `vault_version(account_id) -> Option<u32>` | view | | |
| `list_vaults(from_index: u64, limit: u64) -> Vec<VaultRecord>` | view | | `VaultRecord { account_id, owner, version: u32, created_at_ns: U64 }` |
| `get_config() -> FactoryConfig` | view | | `{ owner, usdc, intents, allowed_assets, min_deposit, current_version: Option<u32> }` |

Events: `standard: "probarion_factory"`, `version: "1.0.0"`. `vault_created { account_id, owner, version }` and `version_added { index, code_hash, mode }`.

## 6. Ledger (`@probarion/core`)

```ts
export type Hex32 = string; // /^[0-9a-f]{64}$/
export type Verdict = "allow" | "hold" | "refuse";
export type LedgerEntryKind = "decision" | "payment" | "approval" | "anchor" | "note";
export type RuleId =
  | "mandate.none" | "mandate.inactive" | "mandate.expired" | "mandate.payee_mismatch"
  | "mandate.over_per_payment" | "mandate.over_total" | "mandate.uses_exhausted" | "mandate.agent_mismatch"
  | "invoice.duplicate" | "invoice.po_mismatch" | "invoice.amount_invalid"
  | "model.attestation_invalid" | "model.low_confidence" | "model.refused" | "model.unavailable"
  | "intents.balance_low" | "vault.frozen" | "vault.daily_backstop"
  | "contract.check_failed" | "ledger.unresolved" | `custom.${string}`; // ledger.unresolved (ICR-8): an earlier payment of the invoice has an unknown outcome and has not settled ("unknown, wait"); invoice.duplicate stays "already paid"

export interface RuleResult { id: RuleId; outcome: "pass" | "hold" | "refuse"; detail: string }

export interface ModelProposal {
  action: "pay" | "hold" | "refuse";
  mandate_id: number | null;
  amount: string | null;          // smallest units
  payee_hint: PayeeHint | null;   // what the invoice claims; never used as destination
  reasoning: string;              // ≤ 2000 chars
  confidence: number;             // 0..1
}
export interface PayeeHint { near_account?: string; chain?: "base" | "solana"; address?: string; name?: string }

// ICR-3 and ICR-3b: every input of the chat request except the invoice text. The auditor check A8 rebuilds the request from these plus the invoice text and requires them to have exactly this shape: the six keys and no others, hex32 hashes, decimal-string amounts, `payee` as the exact tagged union of §4.1 with no extra keys and each value in its chain format (ICR-9: `account_id` and `asset` follow the NEAR AccountId grammar, 2 to 64 lowercase `[a-z0-9]` parts separated by single `.`, `_` or `-`, implicit accounts included; the asset starts with `base-` or `sol-` for its chain; `address` is `0x` + 40 hex on Base and 32 to 44 base58 characters on Solana, as contracts/vault/src/validate.rs checks them), `status` from the enum, and (for A8) a non-null `facts`.
export interface ProposalRequestInputs {
  template: "probarion-proposal/v1";
  model: string;                       // equals AttestationEvidence.model
  system_prompt: string;               // the exact system message: PROPOSAL_SYSTEM_PROMPT or a persona; never carries the nonce
  facts: { invoice_hash: Hex32; amount: string; po_ref: string | null; purpose_hash: Hex32 | null } | null; // what the model was shown, nothing more; invoice_hash = sha256Hex(utf8(invoiceText)); po_ref is null or a verbatim substring of the invoice text (ICR-3c); A8 fails when facts is null
  mandates: { id: number; label: string; payee: Payee; purpose_hash: string; max_per_payment: U128; remaining: U128; expires_at_ns: U64; status: MandateStatus }[]; // what the model was shown, in the order shown
  invoice_text_sha256: Hex32;          // sha256(utf8(invoice text)) = the entry's invoice_hash (ICR-3b); the text itself is never stored
}

export interface AttestationEvidence {
  provider: "near-ai-cloud";
  model: string;
  chat_id: string;          // the completion's `id`; A7 compares it with the `id` inside response_body
  nonce: Hex32;
  request_sha256: Hex32;    // sha256 of the exact chat request body, the UTF-8 bytes of buildProposalRequest's output (section 7); the auditor check A8 recomputes it
  request_inputs?: ProposalRequestInputs; // ICR-3: written by the SDK on every attested decision; optional in the type only so evidence recorded before ICR-3 (the Task 6 fixtures) still parses; A8 fails closed without it
  response_sha256: Hex32;
  response_body: string;    // ICR-2: the exact UTF-8 text of the chat-completion HTTP response body as received; sha256(utf8(response_body)) === response_sha256 (A7); the full model output, which may quote invoice details; at most 64 KiB (ICR-3)
  signature: { text: string; signature: string; signing_address: string; signing_algo: "ecdsa" }; // ICR-3: stored normalized at capture, v in {27, 28} and low-s
  report: { signing_address: string; signing_algo: "ecdsa"; request_nonce: Hex32; report_data: string /* 128 hex, EXTRACTED from intel_quote (see §7) */; intel_quote: string; nvidia_payload: string | null; event_log: unknown | null } | null; // exactly one signer-matched attestation candidate, else null
  fetched_at: string; // ISO-8601
}

export interface LedgerEntryBody {
  v: 1;
  vault: string;
  seq: number;                 // 0-based, contiguous
  prev_link: Hex32;            // "0".repeat(64) when seq = 0
  kind: LedgerEntryKind;
  at: string;                  // ISO-8601 UTC
  request_id: string;          // also in logs/Sentry
  mandate_id: number | null;
  invoice_hash: Hex32 | null;
  amount: string | null;
  proposal: ModelProposal | null;
  evidence: AttestationEvidence | null;
  rules: RuleResult[];
  verdict: Verdict | null;     // null for non-decision kinds
  decided_by: "model+rules" | "rules-only" | null;
  contract: { code: string | null; tx_hash: string | null; spend_id: number | null; status: string | null } | null;
  settlement: { chain: "base" | "solana"; tx_hash: string | null; burn_tx_hash: string | null } | null;
  refs: { decision_body_hash?: Hex32; anchor_seq?: number } | null; // payment/approval entries point back to their decision
}

export interface LedgerEntry {
  body: LedgerEntryBody;
  body_hash: Hex32;   // sha256(utf8(canonicalize(body)))  — RFC 8785 via npm "canonicalize"
  sig: string;        // "ed25519:<base58 64-byte signature>" over the 32 raw bytes of body_hash
  signer: string;     // "ed25519:<base58 32-byte public key>" = vault's ledger FC key
  link: Hex32;        // sha256(bytes(prev_link) || bytes(body_hash) || raw 64-byte sig)
}
```

Rules:
- `decision_hash` sent to the contract = `body_hash` of the `decision` entry. The decision entry is written **before** `spend` is sent.
- Every chain outcome (`payment`, `approval`) is a new entry with `refs.decision_body_hash`.
- **`invoice_hash` is the hash of the text the model saw (ICR-3b).** `invoice_hash := sha256Hex(utf8(invoiceText))`, where `invoiceText` is the exact invoice text given to the model; for a PDF that is the extracted text. The file's own hash may be recorded separately as `document_sha256`, but the `invoice_hash` of the ledger entry and of the contract `spend` is the text hash. Check d ties each spend's `invoice_hash` to its decision entry, and A8 ties the decision's `request_inputs.invoice_text_sha256` and `facts.invoice_hash` to it, so an auditor who holds the text can compare it with a value the chain also holds.
- An anchor = `anchor(seq = k, root = link of entry[count-1], count)`. `k` starts at 1. The SDK anchors after every cycle.

Nonce:

```
nonce = sha256( utf8("probarion/v1") || bytes32(prev_link) || bytes32(invoice_hash ?? 0x00*32) || u64be(mandate_id ?? 0) || u64be(seq) || u32be(byteLength(utf8(vault))) || utf8(vault) )
```

`seq` is the seq of the decision entry about to be written. `vault` is the vault account id, the same string as `LedgerEntryBody.vault`; it is appended for every `seq` as a 4-byte big-endian byte length followed by its UTF-8 bytes (ICR-1, 2026-11-01). The length prefix keeps the preimage unambiguous for account ids of any length. The output is lowercase hex of 64 chars.

Why the vault is in the preimage: the first decision of every vault has `prev_link = 0x00*32` and `seq = 0`, and mandate ids restart at 1 in each vault, so without it the seq-0 nonce depends only on `(invoice_hash, mandate_id)` and attestation evidence from one vault's public seq-0 decision would pass A5 and A6 in another vault.

## 7. Attestation checks (offline, in `@probarion/core/attestation`)

Given an `AttestationEvidence`, the expected nonce (recomputed from the ledger context) and the decision entry's recorded `proposal`:

**Fetching (from spike S2):** `GET /v1/attestation/report?model=<id>&signing_algo=ecdsa&nonce=<64 hex>&provider=near&include_tls_fingerprint=false` with header `x-no-aliasing: true`. The docs say the JSON does **not** return `report_data`; it must be read from the TDX quote: `report_data` = TD report body bytes `[520, 584)`, where the body starts at quote byte offset 48 (quote v4) or 54 (quote v5). From the candidates returned, keep exactly the one whose signing address matches the response signature; if not exactly one, set `report: null`, mark `decided_by` normally, and check `e` reports the entry as unattested.


| Check | Requirement |
|---|---|
| A1 | `signature.text` equals the text that core's `formatProviderTeeText` builds from `model`, `request_sha256` and `response_sha256` using `PROVIDER_TEE_TEXT_FORMAT`, the single constant that decides the signed-text format (see "The signed text" below) |
| A2 | The EIP-191 signer recovered from (`text`, `signature.signature`) equals `signature.signing_address`, case-insensitive. Use `viem` `recoverMessageAddress` |
| A3 | `report.signing_address` equals `signature.signing_address` |
| A4 | `report_data` bytes 0–31 hold the 20-byte address left-aligned, zero-padded. If they instead hold `sha256(signer \|\| tls_fingerprint)`, mark `binding: "tls"` and pass A4 only online |
| A5 | `report_data` bytes 32–63 equal `nonce` |
| A6 | `nonce` equals the recomputed nonce from the ledger context (`prev_link`, `invoice_hash`, `mandate_id`, `seq` and the vault account id) |
| A7 | Response binding (ICR-2). All three hold: (1) `sha256Hex(utf8(response_body)) === response_sha256`; (2) `JSON.parse(response_body).id === chat_id`; (3) the proposal parsed from `choices[0].message.content` with `extractJsonObject` and `parseModelProposal` equals the decision entry's recorded `proposal` by `canonicalJson`. With no recorded proposal (`null`), A7 fails with "no recorded proposal to bind": a decision entry with evidence must have a proposal |
| A8 (auditor, ICR-3 and ICR-3b) | Request binding, run only with the invoice text and the decision entry's ledger context (`vault`, `prev_link`, `seq`, `invoice_hash`, `mandate_id`). All hold: (1) the nonce recomputed from the context equals `evidence.nonce`, and the request that is rebuilt carries it in its `nonce:` header; (2) `request_inputs.invoice_text_sha256 === context.invoice_hash` and `sha256Hex(utf8(invoiceText)) === request_inputs.invoice_text_sha256`; (3) `request_inputs.facts` is not null, `facts.invoice_hash === context.invoice_hash`, and `facts.po_ref` is null or occurs in the invoice text byte for byte, as a substring (ICR-3c); (4) `sha256Hex(utf8(system_prompt))` is in the allow-list, by default `KNOWN_SYSTEM_PROMPT_HASHES` of core (`PROPOSAL_SYSTEM_PROMPT` and published personas), which the caller may extend (for example with plan 04's Canary persona); the result names the prompt that matched; (5) `request_inputs` has the strict shape of §6 and the known template, and `request_inputs.model === model`; (6) `sha256Hex(utf8(buildProposalRequest(request_inputs.model, { invoiceText, nonce, facts, mandates }, request_inputs.system_prompt))) === request_sha256`. In verify (ICR-9) A8's verdict also folds in (7) the mandate match `matchRequestMandates`: every id in `request_inputs.mandates` exists in `Snapshot.chain.mandates`, appears once and has the chain's immutable fields (`id`, `label`, `payee`, `purpose_hash`, `max_per_payment`, `expires_at_ns`); the entry's `mandate_id` is among them; and `facts.amount` equals the entry's `amount` when it has one. A different `remaining` or `status` is a note (the values at decision time need archival state), never a failure, and verify never reports A8 without the match. Without the invoice text or the context A8 is "not run", which is neither a pass nor a fail |

The checks A1 to A7 (`checkAttestation`) run in order and every check always runs: a failed check never skips a later one, so a result always lists all seven. A8 is a separate function, `checkRequestBinding(evidence, invoiceText, context, opts?)`, that returns one `AttestationCheck` with id `A8` (`context` is the `NonceContext` of the decision entry; `opts.systemPrompts` replaces the default allow-list); `verify` runs it only when invoice texts are supplied (plan 03 Task 14): `runChecks(s, { invoiceTexts, systemPrompts })` and `Probarion.verify({ invoiceTexts, systemPrompts })` (ICR-9), where `invoiceTexts` maps `invoice_hash` to the text (a `Map` or a loader) and `systemPrompts` extends `KNOWN_SYSTEM_PROMPT_HASHES` (and, in the SDK, the instance's `model.systemPrompt` persona), never replacing it. The text-free subset of A8 (`requestInputsProblemWithoutText`: strict shape, model, both invoice hashes, allow-listed prompt) is in core too; `requestSpend` holds caller evidence to it.

**Response binding (ICR-2, A7).** A1 to A6 alone do not tie the recorded proposal to what the model said. The evidence held only `response_sha256`, and the check never saw the entry's `proposal`, so whoever writes the ledger could record `pay` after the model answered `refuse`. The evidence therefore carries `response_body`, the exact UTF-8 text of the chat-completion HTTP response body as received, and `response_sha256` is the hash of those same bytes. A1 ties the signed text to `response_sha256`, A7 ties `response_sha256` to the body, the body's `id` to `chat_id`, and the proposal inside the body to the proposal in the entry. The `chat_id` field is the evidence's existing chat id; no field is added for it. **What `response_body` stores.** It is the full model output, not a summary: it may quote invoice details, and its size is bounded only by the model's response. Unlike the request (see A8 below), it is kept in the ledger entry.

**Request binding (A8, auditor).** A7 detects post-hoc tampering with a genuine exchange, for example a swapped proposal or an edited response. It does not show that the exchange itself was the honest one. A5 and A6 bind the attestation REPORT to the ledger position, not the chat. Until A8 runs with the invoice text, A1 to A7 do NOT prove that the request was the honest one for this invoice and position: whoever writes the ledger could send a request of their choosing and record its signed answer. This includes pairing a genuine chat from another position or vault with a report fetched for this entry's nonce; A7 catches that only when the replayed proposal differs from the recorded one.

**What A8 proves (ICR-3b).** When A8 passes, the TEE answered the standard Probarion request (template `probarion-proposal/v1`, rebuilt byte for byte), under an allow-listed system prompt, for exactly the invoice text that the on-chain `spend.invoice_hash` is bound to (through check d, which ties each spend to its decision entry), at this ledger position. Every piece of free text the model was shown is therefore tied to something the auditor can check: the invoice text itself (the hash, and `facts.po_ref` as a substring of it, ICR-3c), the immutable on-chain mandate fields (`label` and the account ids and addresses inside `payee` are fixed when the mandate is created, so Task 14's match of `request_inputs.mandates` against the snapshot covers them), and the allow-listed prompt. It does **not** prove that `request_inputs.facts` and `request_inputs.mandates` matched the chain at decision time. Plan 03 Task 14 checks `request_inputs.mandates` against the snapshot's immutable mandate fields (`payee`, `purpose_hash`, `max_per_payment`, `expires_at_ns`, `label`), checks that the entry's `mandate_id` is among them and that `facts.amount` equals the entry's `amount`; the historical `remaining` and `status` cannot be checked without archival chain state, and the report says so. Prompt injection inside the invoice text itself is out of A8's scope: `decide()` and the contract are the defence, because the model only advises. `facts.purpose_hash` is chosen by the writer. It is hex, so it can mislead but carries no directive. A8 does not prove the invoice is authentic: an invented invoice whose hash is written into both the entry and the spend passes.

- **The nonce rides in the request (ICR-3).** It is in the USER message under a fixed header, so the signed request itself names its ledger position. The system message is only the system prompt: `PROPOSAL_SYSTEM_PROMPT` or a persona such as the Canary's. It stays replaceable and never carries the nonce.
- **Where the builder lives.** `buildProposalRequest(model, input, systemPrompt?)`, `PROPOSAL_SYSTEM_PROMPT`, `KNOWN_SYSTEM_PROMPT_HASHES` and the template id `probarion-proposal/v1` live in `@probarion/core`, because they are pure; their output bytes are deterministic, and the schema and constants are deep-frozen so that nothing in the process can change them. `@probarion/sdk` re-exports them. The `input` is `{ invoiceText, nonce, facts, mandates }`, with `facts` and `mandates` in the `ProposalRequestInputs` shape (§6); the builder also accepts a full `MandateView` and reduces it to the shape the model is shown (`remaining = max_total - spent - reserved`).
- **Request bytes.** The body is the RFC 8785 canonical JSON (`canonicalJson`, keys sorted) of `{ model, messages: [{ role: "system", content: <system prompt> }, { role: "user", content: <user message> }], response_format: { type: "json_schema", json_schema: { name: "ModelProposal", schema: MODEL_PROPOSAL_JSON_SCHEMA } }, max_tokens: 4096, temperature: 0, stream: false }`. `max_tokens: 4096` is part of template v1 (decided before any real decision froze the v1 bytes) so that a thinking model's output stays under the 64 KiB response cap. The user message is these lines joined by `\n`, with no trailing newline added:

  ```
  Probarion decision request v1
  nonce: <64 lowercase hex>
  facts: <canonicalJson(facts), or null>
  mandates: <canonicalJson(mandates)>
  invoice_text:
  <the invoice text, verbatim to the end of the message>
  ```

  A lone surrogate in the invoice text is replaced by U+FFFD first, which are the bytes that `utf8()` hashes anyway. The label text, the order, the line breaks and `max_tokens` are part of the template: any change needs a new template id (`probarion-proposal/v2`) and A8 dispatches on `request_inputs.template`.
- **System prompt allow-list (ICR-3b).** A system prompt is the strongest lever over the answer, so a request is accepted only under a prompt the auditor knows. `KNOWN_SYSTEM_PROMPT_HASHES` in core lists `{ name, sha256 }` for `PROPOSAL_SYSTEM_PROMPT` and the published personas. A8 requires `sha256Hex(utf8(request_inputs.system_prompt))` to be in the list it is given (default: that one) and names the entry that matched; a caller adds a persona, for example plan 04's Canary, by passing an extended list. A prompt that is not listed fails A8, with the recorded prompt still readable in `request_inputs`.
- **Strict shapes (ICR-3b).** `request_inputs` has exactly the keys of §6 and no others; `facts` has exactly its four keys; each mandate exactly its eight. Hashes are 64 lowercase hex, amounts and times are decimal strings, ids are integers >= 1, `payee` is the exact tagged union (`near`: `type`, `account_id`; `intents`: `type`, `chain`, `address`, `asset`) with no extra keys, `status` is one of `active`, `revoked`, `exhausted`. A free-text field that does not fit these shapes (a directive hidden in a hash, an extra payee key) fails A8 instead of reaching the model unnoticed. Free text that the shapes leave open is held in place by other checks (ICR-3c): `facts.po_ref` must be null or a verbatim substring of the invoice text, so a writer cannot put a directive there unless it is in the invoice itself (the out-of-scope injection case); `label` and the account ids and addresses of a `payee` are immutable on chain and are compared with the snapshot by Task 14, not by A8.
- **Evidence.** `request_inputs` (§6) records everything the builder was given except the invoice text. The invoice text of the REQUEST is never stored in the ledger, for privacy, so only an auditor who holds the invoice documents can run A8. Without them, the binding of a chat to its ledger position rests on A8 being run by an auditor.
- **Response size cap (ICR-3).** `response_body` is at most 64 KiB (65,536 UTF-8 bytes). A larger response, or one that is not valid UTF-8 (which could not round-trip through a string), is reported by the proposer as `model_unavailable` and the decision is rules-only; the oversized body is never written to a ledger line.
- **Signature normalization at capture (ICR-3).** The stored `signature.signature` is `0x` + r + s + v with v in {27, 28} and s <= n/2: a provider v of 0 or 1 becomes 27 or 28, and a high-s signature becomes the low-s twin (s := n - s, v flipped). The SDK never deduplicates on raw signature bytes, because both twins verify.
- **The signed text (ICR-3).** The text the TEE signs is built by core's `formatProviderTeeText` from one constant, `PROVIDER_TEE_TEXT_FORMAT`, which A1, the SDK test doubles and the recorded fixtures all use. It is the format NEAR AI documents and spike S2 used. The OWNER recording of one real decision (plan 03 Task 11 Step 7) settles what NEAR AI really signs; a different real format (for example without the model prefix) is changed in that one constant.

**What the offline checks prove.** A1 to A7 prove internal consistency only: the signature, the response body and the recorded proposal agree with each other, and the attestation report agrees with the ledger position (A5 and A6 bind the report, not the chat). They do not prove that the request was the standard Probarion request for this invoice text and position (that is A8, above, and only for an auditor who holds the text). They do not prove that the quote came from genuine TEE hardware or that the signing key belongs to a measured TEE either. That needs O1 online, the DCAP verification of the TDX quote, plus the O1b measurement pin. Every `checkAttestation` result therefore carries `quote_verified: boolean`, always false from the offline `checkAttestation`; it is true only after O1 verifies the DCAP quote and the O1b measurement pin.

**Parser contract (A7).** A7 runs `extractJsonObject` and `parseModelProposal` on the signed content, so both are part of the verification contract. They are frozen for ledger `v` 1: any behavioural change (what they accept, how they normalise, the reasoning length) needs a new ledger `v`, and A7 must dispatch on the entry's `v`. Versioning is not built now; this records the rule only.

Online-only checks (O1, O2) are **optional**, run behind `--online`, and may use `@nearai/inference-sdk` (ICR-11, ruling T14-R1):
- **O1** = DCAP + policy + report_data. The TDX quote is verified through Intel DCAP and held to the policy of the library's own `verifyTdxQuote`: debug mode off, and a TCB status the library accepts (`UpToDate`, `OutOfDate` or `TDRelaunchAdvised`; `Revoked`, `Unknown` and the configuration-needed statuses fail). The verified report data must equal `report_data`, which A4/A5 tie to the signer and this request's nonce. The result reads "DCAP-genuine TDX quote bound to this request; measurement not pinned".
- **O1b, measurement pinning, is deferred.** TODO: pin NEAR AI's published TD: the quote's `mrConfigId` (the app-compose hash), `rtMr3` replayed from the event log, and the deployment's image provenance. Until O1b lands, `quote_verified` stays false whatever O1 says, so the README keeps "attested and signed".
- **O2.** The NVIDIA GPU payload's own `nonce` (32 bytes of hex, `0x` optional, as the library reads it) must equal `evidence.nonce`, and NVIDIA NRAS must verify the payload; a payload replayed from another session fails.
- Online never upgrades an offline failure of check e; its `firstBrokenSeq` is the lower of the offline and the online one.

## 8. Policy engine (`@probarion/core/policy`)

```ts
export interface InvoiceFacts { invoice_hash: Hex32; amount: string; po_ref: string | null; purpose_hash: Hex32 | null; payee_hint: PayeeHint | null }
export interface DecisionInput {
  vault: string; agentPk: string; now: Date;
  invoice: InvoiceFacts;
  proposal: ModelProposal | null;        // null → rules-only
  attestationOk: boolean | null;         // null when no model was used
  mandates: MandateView[];               // TS mirror of the contract view (camel-free: same snake_case keys)
  paidInvoiceHashes: ReadonlySet<string>;
  usedRefs: ReadonlySet<string>;
  intentsBalance: bigint | null;         // POA balance of the vault in intents.near for the mandate's asset
  frozen: boolean;
  confidenceFloor: number;               // default 0.7
  customRules?: CustomRule[];
  ref: string;                                           // current spend ref; a used ref -> refuse invoice.duplicate
  daily: { backstop: string; spent_today: string } | null; // mirror of the contract's UTC-day backstop
}
// Also: proposal.amount !== invoice.amount -> refuse invoice.amount_invalid.
// The decision entry's mandate_id is the code's purpose-hash pre-selection committed in the nonce; a proposal that picks a different mandate -> refuse invoice.po_mismatch.
// Model attempted but unavailable is signalled as proposal: null, attestationOk: false (decided_by rules-only).
export interface Decision { verdict: Verdict; mandate_id: number | null; amount: string | null; rules: RuleResult[]; decided_by: "model+rules" | "rules-only" }
export interface CustomRule { id: `custom.${string}`; check(input: DecisionInput, chosen: MandateView | null): RuleResult }
export function decide(input: DecisionInput): Decision; // pure, deterministic; built-in rules run first and cannot be removed
```

The mandate is chosen from `proposal.mandate_id` if present, otherwise by matching `purpose_hash`. The destination is **always** the chosen mandate's payee. If `payee_hint` contradicts the mandate payee, the result is `refuse` with `mandate.payee_mismatch`.

## 9. SDK public API (`@probarion/sdk`)

```ts
export interface ProbarionOptions {
  network: "mainnet" | "testnet";
  vault: string;
  agentKey?: string;      // "ed25519:<secret>" FC key (spend-only)
  ledgerKey?: string;     // "ed25519:<secret>" FC key (anchor-only)
  rpcUrls?: string[];
  model?: { provider: "near-ai-cloud"; apiKey: string; model?: string } | null; // null → rules-only
  ledger?: LedgerStore;   // default FileLedgerStore(".probarion/ledger.jsonl")
  confidenceFloor?: number;
  requestId?: string;     // propagated into ledger entries
}
// model options also accept systemPrompt?: string (used only by the Canary's gullible agent).
// A read-only instance (no keys, model: null) must support mandates.*, spends.get, snapshot() and verify() (used by /proof).
export interface LedgerStore { head(): Promise<LedgerEntry | null>; append(body: Omit<LedgerEntryBody, "seq" | "prev_link">, sign: (bodyHash: Uint8Array) => Promise<{ sig: string; signer: string }>, opts?: { expect?: { seq: number; prev_link: Hex32 } }): Promise<LedgerEntry>; all(): Promise<LedgerEntry[]> }
// ICR-6 amendment: `opts.expect` makes `append` a compare-and-append, checked under the store's lock (the file lock across processes): if the head does not give that position it throws `LedgerConflictError` (a `LedgerError`, exported) and writes nothing. Without `opts` it behaves as before. `process`/`requestSpend` write every decision with the position its nonce was computed for; a conflict means no entry and no spend ("ledger moved since this decision was attested; retry"), never retried automatically.
export type SpendOutcomeStatus = "refused_by_code" | "refused_by_contract" | "held" | "paid" | "burned" | "settled" | "failed" | "unconfirmed";
// ICR-6: "unconfirmed" means `spend` was sent but its outcome is not known: a TxOutcomeUnknownError, or an answer that cannot say whether it paid (an unreadable return value, a failed callback after the payout, a payout still pending). `txHash` is set whenever the sender knows it, and the payment entry records `contract.status: "unknown"`. The caller must never send it again, least of all under a fresh `ref`; it can look the spend up by `ref`. Until the chain shows the spend, or until `UNKNOWN_SETTLE_MS` (48 h, counted from the payment entry's `at`) has passed, `process`/`requestSpend` refuse the same invoice by code (T13-R2, RuleId `ledger.unresolved`, ICR-8); after 86,400 blocks the tx expires (≤48 h at ≤2 s blocks); even if it lands later, the contract lets at most one spend of the invoice pay.
export interface SpendOutcome { status: SpendOutcomeStatus; spendId: number | null; code: string | null /* RuleId for code outcomes, bare vault code for contract outcomes */; txHash: string | null; ledgerSeq: number /* last entry written */; decisionHash: Hex32; modelUsage?: { model: string; promptTokens: number; completionTokens: number } | null; anchorTxHash: string | null /* ICR-6: the hash of this cycle's anchor tx; null when the anchor failed or was not attempted. Returned only, never stored in a ledger entry: an entry cannot hold the hash of the tx that anchors it */; ledgerComplete?: false /* ICR-6 amendment: set only when this cycle's payment entry could not be written; the outcome stands and the chain keeps the spend with its decision_hash */ }
// requestSpend input also accepts skipPreflight?: boolean (always sends spend, except while an unconfirmed payment for the same invoice is unsettled, which refuses by code; returns refused_by_contract with code + failed tx hash). Used only by Canary raw mode.
// Also exported: NearAiProposer { constructor({ apiKey, model?, baseUrl? }); readonly model: string; propose({ invoiceText, facts, mandates, nonce }): Promise<{ proposal; evidence; usage }> } (ICR-3b: `facts` is required and `facts.invoice_hash` must equal `hashInvoice(invoiceText)` and `facts.po_ref` must be null or copied verbatim from `invoiceText`, so `request_inputs.facts` is always filled and passes A8), and hashInvoice(content: string | Uint8Array): Hex32. For text, `hashInvoice` is `sha256Hex(utf8(text))`: the invoice hash is the hash of the text the model saw, never of a PDF file. ICR-6: a Uint8Array must be valid UTF-8 (fatal decode, a BOM kept) and hashes the same as its text; anything that is not UTF-8 text throws ProbarionError `InvalidInput`, which says to pass the extracted text (a PDF's file hash belongs in `document_sha256`).
// Outcome entries use kind "payment" with contract.status in SpendStatus values | "check_failed" | "refused" | "unknown" (ICR-6: the outcome of a sent spend is not known). A code-level hold is submitted only if check_spend says would_hold; otherwise status "held" with spendId null.

export class Probarion {
  constructor(opts: ProbarionOptions, deps?: ProbarionDeps); // deps: injected rpc/fetch/clock/proposer for tests
  readonly spends: { get(id: number): Promise<SpendView | null> };
  readonly anchors: { latest(): Promise<AnchorView | null> };
  readonly mandates: { list(): Promise<MandateView[]>; get(id: number): Promise<MandateView | null> };
  readonly rules: { add(rule: CustomRule): void };
  checkSpend(input: { mandateId: number; amount: string; invoiceHash: Hex32; ref: string }): Promise<{ ok: boolean; code: string | null; would_hold: boolean }>;
  /** Full cycle: (optional) model → policy → ledger decision entry → contract spend → ledger outcome entry → anchor. ICR-6: `facts.invoice_hash` must equal `hashInvoice(text)` (ICR-3b) and `facts.po_ref` must be null or a verbatim substring of `text` (ICR-3c; an empty `po_ref` is written as null). Otherwise it throws ProbarionError `InvalidInput` before any write. */
  process(invoice: { text: string; facts: InvoiceFacts; ref: string }): Promise<SpendOutcome>;
  /** Low-level: caller already decided; still writes ledger + checks contract. No recipient parameter exists. */
  requestSpend(input: { mandateId: number; amount: string; invoiceHash: Hex32; ref: string; proposal?: ModelProposal | null; evidence?: AttestationEvidence | null }): Promise<SpendOutcome>;
  verify(opts?: { online?: boolean; snapshot?: Snapshot; invoiceTexts?: InvoiceTextSource; systemPrompts?: readonly KnownSystemPrompt[] }): Promise<VerifyReport>; // ICR-9
  snapshot(opts?: { online?: boolean }): Promise<Snapshot>; // online: burns may also be looked up in the FastNEAR tx index
}
// ICR-9: verify runs checks a-i; `invoiceTexts` adds A8 with the mandate match to check e; `systemPrompts` extends the instance's A8 allow-list (KNOWN_SYSTEM_PROMPT_HASHES plus opts.model.systemPrompt), so a read-only instance passes the Canary persona here; `online` adds O1/O2. What a check could not establish is a note in its detail, never a pass of its own.
// ProbarionDeps for snapshot()/verify() (Task 14; final names, plan 04 R5): archivalRpc?: RpcClient | null (null disables archival lookups; default NEAR_ARCHIVAL_RPC_URLS or FastNEAR archival), preLedgerDecisionHashes?: Hex32[] and evidenceDir?: string (default "docs/evidence"; both used only for v0.probarion.near on mainnet), burnTxHints?: ReadonlyMap<number, readonly BurnTxHint[]>, where BurnTxHint = string | { hash: string; signer?: string } (default: the vault's txs in docs/mainnet-proof.json, each with its signer_id, loadBurnTxHints), onlineVerifier?: OnlineAttestationVerifier | null, txIndex?: TxIndex | null (online only; default FastNEAR's tx API). `expectedCodeHashes` is deprecated and ignored.
```

## 10. Verifier (`@probarion/core/verify` for pure checks; `@probarion/sdk` gathers the chain data)

```ts
export type CheckId = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i";
export interface CheckResult { id: CheckId; name: string; status: "pass" | "fail" | "skip" | "unproven" /* ICR-12: h only */; detail: string; firstBrokenSeq?: number; lastUnprovenSeq?: number /* check c only: the last seq of the range it cannot prove; information only */ }
export interface VerifyReport { vault: string; network: "mainnet" | "testnet"; ok: boolean /* ICR-12: true only when no check is fail or unproven */; checks: CheckResult[]; entries: number; anchors: number; generated_at: string; unproven: UnprovenBurn[] /* ICR-12 */ }
export interface UnprovenBurn { check: "h"; spend_id: number; reason: "pre_ledger_no_tx" | "approver_tx" | "not_recorded" | "tx_unavailable" /* ICR-13 */ } // ICR-12: every burn check h could not prove (listed when h is unproven)

export interface AccessKeyInfo { public_key: string; permission: "FullAccess" | { receiver_id: string; method_names: string[]; allowance: string | null } }
export interface Snapshot {
  v: 1; vault: string; network: "mainnet" | "testnet"; taken_at: string;
  ledger: LedgerEntry[];
  chain: {
    access_keys: AccessKeyInfo[]; code_hash: string; config: VaultConfig;
    anchors: AnchorView[]; spends: SpendView[];
    intents_public_keys: string[]; intents_predecessor_auth: boolean;
    factory_version: number | null; factory_versions: VersionView[];
    mandates?: MandateView[]; // ICR-9: list_mandates; A8's mandate match compares request_inputs.mandates with it (optional so older snapshots parse; A8 fails without it)
    burns: { spend_id: number; tx_hash: string; memo: string; intents_owner: string; amount: string; status: "ok" | "missing" | "unavailable" /* ICR-13 */ }[]; // POA ft_burn (owner_id = intents.near, memo) matched with intents.near mt_burn (owner_id = vault) in the same tx
  };
  expected_code_hashes: string[]; // advisory (ICR-5): check f derives its own trusted set and FAILS if this lists a hash outside it
}
export function runChecks(s: Snapshot, opts?: { now?: Date; invoiceTexts?: InvoiceTextSource; systemPrompts?: readonly KnownSystemPrompt[] }): Promise<VerifyReport>; // pure, offline; async because EIP-191 recovery is async. ICR-9: InvoiceTextSource = ReadonlyMap<Hex32, string> | ((invoiceHash) => string | null | undefined | Promise<...>)
// firstBrokenSeq(report): number | null is the LOWEST seq any failing check points to; nothing refines it; an `unproven` check is not a failure and is ignored (ICR-12). a and b point to the exact entry that fails, c to the first entry of the anchor range it cannot prove (lastUnprovenSeq ends that range and is information only), e to the entry whose attestation fails, d and h to the decision whose chain outcome failed, which is not necessarily unproven ledger history. a and b only show that an entry is self-consistent, not that it is the history an anchor pinned.
// Snapshot also carries pre_ledger_decision_hashes: Hex32[] (Day-4 v0 spends recorded in docs/evidence/ before the ledger existed). ICR-4b: each listed hash exempts at most ONE spend, the lowest spend id that references it, and, when the snapshot has an anchor, only a spend created before the first anchor's at_ns; check d reports it as "listed as pre-ledger by the snapshot", not fail; any other spend that references the hash fails.
// Check a (v2): entries in each anchor range (prev.count, anchor.count] must be signed by that anchor's ledger_key; entries after the last anchor by config.ledger_key.
// Check h uses NEAR_ARCHIVAL_RPC_URLS for tx lookups older than about 2.5 days.
// ICR-10 (Task 14, how the SDK gathers a snapshot): code_hash = global_contract_hash ?? code_hash (`codeIdentity`, R6); expected_code_hashes = KNOWN_VAULT_CODE_HASHES plus the canonical factory's versions() only when config.factory is the network's canonical factory (the set check f trusts); pre_ledger_decision_hashes only for v0.probarion.near on mainnet (from docs/evidence/v0-decision-*.json), [] for every other vault. A burned spend's tx is looked for in burnTxHints, then the tx hashes of its payment entries (by decision hash or spend id; never those alone: a by-ref outcome records no burn tx), then, online only, the FastNEAR tx index; each is read with `tx` as the vault and then each approver. findBurnPair (R5) accepts the POA ft_burn from the asset contract, and on testnet only also from the intents account (the intents-stub's one-receipt shape); the vault's own logs never count. A burn that is not found is `missing` with the hash of a tx that was read and holds no pair, or "".
// @probarion/core also exports KNOWN_VAULT_CODE_HASHES (from contracts/code-hashes.json) for non-factory vaults, and checkAttestation(evidence, nonce, proposal: ModelProposal | null): Promise<{ ok; binding; quote_verified: boolean; checks: { id: "A1".."A7"; pass; detail }[] }>. A3 requires signing_algo "ecdsa"; A5 requires report.request_nonce == nonce; A7 binds response_body to response_sha256, chat_id and the entry's proposal (ICR-2); quote_verified is a boolean: always false from the offline checkAttestation, true only after O1 verifies the DCAP quote and the O1b measurement pin.
```

| Check | Name | Passes when |
|---|---|---|
| a | `ledger-signatures` | Every `sig` verifies with `signer`, and `signer` is the vault's ledger key: an FC key with methods `["anchor"]` |
| b | `hash-links` | Every `body_hash` and `link` recomputes, and `prev_link` chains |
| c | `anchors` | For every anchor, `root == ledger[count-1].link` |
| d | `spends-have-decisions` | ICR-10 notes, never failures: a payment entry with `contract.status: "unknown"` is resolved from chain state (the spend carrying its decision hash), or reported pending when no spend carries it; a spend bound to its decision with no payment entry (`ledgerComplete: false`) is noted. ICR-4: every on-chain spend whose `decision_hash` is not in `pre_ledger_decision_hashes` is bound to exactly one allow decision. The `decision_hash` is the `body_hash` of a `decision` entry in the ledger; that entry's `invoice_hash`, `mandate_id` and `amount` equal the spend's; its verdict is `allow`, or `hold` only if the spend went through `held` (its `held_until_ns` is non-null); and no other spend references it. Pre-ledger spends are exempt only once (ICR-4b): each hash in `pre_ledger_decision_hashes` exempts at most one spend, the lowest spend id that references it, and when there is an anchor only a spend created before the first anchor's `at_ns`. Any other spend that references a pre-ledger hash fails ("already used by spend N" or "created after the ledger began"). The report calls them "listed as pre-ledger by the snapshot", which is all the verifier knows |
| e | `attestations` | Every entry with `evidence` passes A1–A7, with the entry's own `proposal` as the expected proposal (an entry with evidence but no proposal fails A7); entries with `decided_by = "rules-only"` are reported, not failed. The report says the TDX quote was not verified offline. ICR-9: with invoice texts, every attested decision whose text is supplied must also pass A8 with the mandate match; one without its text is "A8 not run" for that seq |
| f | `vault-locked` | ICR-5: no FullAccess key; every other access key is either the current ledger key (receiver = the vault, methods exactly `["anchor"]`) or an agent key (receiver = the vault, methods exactly `["spend"]`); and `code_hash` is in the trusted set `KNOWN_VAULT_CODE_HASHES` ∪ the `code_hash` of every `factory_versions` entry, the second part only when `config.factory` is the network's canonical factory. For a vault that factory created (`factory_version` set) the `code_hash` must also equal the `code_hash` of `factory_versions[factory_version]` (1-based), else f fails with "code hash does not match factory version N". `expected_code_hashes` is not trusted: it fails the check if it lists any hash outside the trusted set |
| g | `intents-keys` | T14-R1: `config.intents === NETWORKS[network].intents` (a vault names its intents contract itself, so any other account proves nothing); `intents_public_keys` (read in the network's own intents contract) is empty and `intents_predecessor_auth` is true |
| h | `burn-memos` | Every Burned spend has a matched burn pair in its tx: POA token `ft_burn` (owner_id `intents.near`) with memo == `WITHDRAW_TO:` + destination.address, and `intents.near` `mt_burn` with owner_id == vault and amount == spend amount; one tx burns for one spend (ICR-10). T14-R1: h fails unless `config.intents === NETWORKS[network].intents` and every burned spend's destination asset is in `NETWORKS[network].allowedAssets`; the SDK looks burns up in the network's own intents contract and POA assets only, and only a receipt that succeeded (`SuccessValue` or `SuccessReceiptId`) counts. ICR-12 (T14-R2): when the burn record names no tx at all, h is `unproven` (never a pass; `ok` is false and `VerifyReport.unproven` lists the spend) for: a burned spend that d exempted as pre-ledger with no supplied tx (`pre_ledger_no_tx`, "listed as pre-ledger by the snapshot, burn tx not supplied"); a held spend an approver paid out, whose burn is in the approver's tx that was not read (`approver_tx`; the SDK never counts the reservation tx in the ledger as read); a spend bound to its decision with no payment entry (`not_recorded`); and (ICR-13) a burn record with status `unavailable`, whose tx could not be read right now (`tx_unavailable`, "re-run, or add an archival RPC"). Only the held spend's reservation entry (`contract.status: "held"`) is not counted as read; a tx the node says does not exist (UNKNOWN_TRANSACTION, a bogus hint too) fails like a tx read without a pair. The detail says "supply a hint (`pnpm proof add-tx --spend-id`) or run `--online`". A burn record naming a tx that was read and holds no burn pair FAILS, for every spend; a failure wins over unproven burns |
| i | `factory-version` | `factory_version` is non-null and present in `factory_versions` (`skip` for non-factory vaults) |

## 11. CLI (`probarion`)

```
probarion vault create --name <n> --approvers a.near,b.near --daily-backstop 500 --held-ttl-hours 72   # prints the near-connect/near-cli tx for the OWNER to sign
probarion mandate create --vault <id> --payee near:<acct> | base:<0x..> --max-per 100 --max-total 1000 --uses 10 --expires 2026-12-31 --approval-above 100 --agent-pk ed25519:.. --purpose <file|hex> --label "..."
probarion agent keygen --out <file> | --print-secret   # new ed25519 keypair; one of the two flags is required (ICR-7). --out saves the pair to an owner-only file (never overwritten) and prints only the public key; --print-secret prints the secret to the terminal
probarion agent add --vault <id> --pk ed25519:.. --allowance 1     # prints tx for OWNER to sign
probarion check --vault <id> --mandate 1 --amount 25 --invoice <file> --ref INV-001
probarion verify --vault <id> [--online] [--snapshot out.json] [--offline snapshot.json] [--json]
probarion ledger export --out ledger.jsonl
```

v2 additions: global `--network`, `--rpc`, `--json`; `probarion ledger set-key --vault <id> --pk ed25519:.. --allowance 1` (prints tx); `verify --ledger <path>`; owner-tx printers accept `--sign-as`, `--deposit`, `--out-dir`. Printed owner/approver txs attach **1 yoctoNEAR** per the one-yocto rule (§4.2).

v2 printers (all print, never sign): `agent remove`, `mandate revoke`, `spend approve|reject` (approver), `vault unfreeze`, `vault withdraw`, `vault withdraw-intents` (1 yocto each), and `vault freeze` (no deposit). `verify --evidence <dir>` loads `pre_ledger_decision_hashes` from `docs/evidence/v0-decision-*.json`.

Amounts on the CLI are human USDC (decimal). The CLI converts them with `USDC_DECIMALS`. **The CLI never signs owner-only transactions.** It prints them for the owner's wallet or for `near-cli-rs`.

## 12. MCP tools (`@probarion/mcp`)

`list_mandates`, `check_spend { mandate_id, amount, invoice_hash, ref }`, `request_spend { mandate_id, amount, invoice_hash, ref, reasoning }`, `get_spend_status { spend_id }`, `verify {}`.

No tool takes an address, and no tool creates or changes mandates.

**v2:** MCP `amount` is a human USDC decimal string matching `^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$`, and outputs carry both `amount_usdc` and smallest units. `request_spend` calls `requestSpend` with `proposal = { action: "pay", mandate_id, amount, payee_hint: null, reasoning: "mcp: " + reasoning, confidence: 1 }` and `evidence: null`, so these spends verify as unattested.

## 13. Web app data (Supabase; names fixed, columns defined in 04-web)

Tables:
- `tenants` (one per vault)
- `tenant_members`
- `agent_keys` (encrypted)
- `invoices` (encrypted content, or hash only in zero-retention mode)
- `ledger_entries`
- `vault_events` (from the watcher)
- `alert_subscriptions`
- `alerts_sent`
- `canary_attempts`
- `metrics_daily`
- `pilots`

RLS on every table. **v2:** `rate_limits` is added (shared serverless counters). `pilots` has `vault_account_id text`, `owner_account_id text`, `cohort text check (cohort in ('team','external','canary'))`, `consent_name boolean default false`, `consent_at timestamptz null`, `display_name text null`; `/open` groups by cohort, consistent with `tenants.kind`.

## 14. Environment variables

| Name | Used by | Notes |
|---|---|---|
| `NEAR_NETWORK` | all | `mainnet` \| `testnet` |
| `NEAR_RPC_URLS` | all | comma-separated, failover order |
| `PROBARION_FACTORY_ID` | sdk/web | |
| `PROBARION_VAULT_ID` | sdk/cli/mcp | |
| `PROBARION_AGENT_KEY` | sdk/cli/mcp | FC spend-only secret; server-side only |
| `PROBARION_LEDGER_KEY` | sdk/cli/mcp | FC anchor-only secret |
| `NEARAI_API_KEY` | sdk/web | spend cap set in dashboard |
| `NEARAI_MODEL` | sdk/web | optional; default resolved from public paginated `GET /v1/model/list` filtered on `providerType == "vllm"`, `attestationSupported`, `verifiable`, `structured_outputs` |
| `ONECLICK_JWT` | web | top-up quotes |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | web (server) | |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | web (client) | |
| `KEY_ENCRYPTION_SECRET` | web | 32-byte base64; libsodium secretbox master key for `agent_keys` |
| `SENTRY_DSN` | web | |
| `TELEGRAM_BOT_TOKEN`, `RESEND_API_KEY` | web | alerts |
| `CANARY_VAULT_ID` | web | |
| `BASE_RPC_URL` | sdk/web | public Base RPC for settlement lookups (online verify) |
| `CRON_SECRET` | web | protects cron endpoints |
| `PROBARION_LEDGER_PATH` | sdk/cli/mcp | ledger file; MCP default `~/.probarion/<vault>/ledger.jsonl` |
| `NEAR_ARCHIVAL_RPC_URLS` | scripts/verifier | tx lookups older than about 2.5 days; default `https://archival-rpc.mainnet.fastnear.com` (testnet: `https://archival-rpc.testnet.fastnear.com`) |
| `BETTERSTACK_HEARTBEAT_URL` | web | optional; the watcher pings it each run |
| `CANARY_MODE` | web | `live` \| `code-only` \| `replay` \| `off` |

Supabase projects created in 2026 issue `sb_publishable_...`/`sb_secret_...` keys. Put them in the existing `*_ANON_KEY`/`*_SERVICE_ROLE_KEY` names. The browser Sentry DSN is derived from `SENTRY_DSN`.

## 16. Evidence file `docs/mainnet-proof.json`

Plan 05 Task 1 owns the schema and the `pnpm proof` CLI. From Day 4, every mainnet transaction the README cites is recorded with `pnpm proof add-tx ...` **in the same commit as the work** (plans 02-04). The README never contains a hash or number that is not in this file or in `eval/results/latest.json`.

## 17. Claim markers

A comment `probarion-claim: <ID>` goes on the line above the test or code that proves a claim: Rust `// probarion-claim: I4`, TS `// probarion-claim: V-TAMPER`, SQL `-- probarion-claim: RLS`. Each ID appears **exactly once** across `contracts/ packages/ apps/ eval/`.

| IDs | Owner |
|---|---|
| `I1`-`I9`, `EVENTS`, `ONE-YOCTO` | plan 02 |
| `V-TAMPER`, `V-ATTEST`, `P-PAYEE`, `NEARAI-NONCE` | plan 03 |
| `ONECLICK-QUOTE`, `NEAR-CONNECT`, `CANARY-RAW`, `ALERTS`, `RLS` | plan 04 |
| `MCP-NOADDR`, `EVAL-REGRESSION` | plan 05 |

The owning plan adds the marker in the same task that writes the proving test. Plan 05's `check-claims` enforces them.

## 15. Global rules for every plan

- **TDD.** Write the failing test first, then the minimal code.
- **Commits.** Small commits with conventional messages. The repo history must show steady work inside the window.
- **No placeholders in shipped code.** Every "simulated" behaviour is listed in the README's "What's real vs simulated".
- **Mainnet transactions that move funds are signed by the human owner.** Code and scripts prepare them, and the plan steps say "OWNER SIGNS" explicitly.
- **Secrets.** Never commit them. `.env.example` lists every variable in §14. gitleaks runs in CI.
- **`pnpm verify`** must pass offline after `pnpm install` and `cargo fetch`. It runs Rust unit tests, TS typecheck, and TS tests with fixtures. `pnpm verify:full` adds the sandbox integration tests.


## Changelog

- 2026-10-21: applied ICR-1..5 from plan 01 (spikes). Changes: Rust ≥ 1.93; RPC note; `report_data` extracted from the TDX quote plus `request_nonce`/`signing_algo` in `report`; burn-pair matching for check h and `Snapshot.burns`; model resolution through `/v1/model/list`. Confirmed: near-sdk 5.29.1 has `Promise::deploy_global_contract` and `use_global_contract(hash)` (no feature gate; see the `factory-contract-global` example); mainnet protocol 86 has global contracts live; testnet runs protocol 87.
- 2026-10-21 (v2 reconciliation, after all five plans): applied ICRs from plans 02-05 and coordinator decisions:
  - the one-yocto rule plus `RequiresOneYocto`;
  - ids start at 1;
  - `AnchorView.ledger_key` and per-anchor check (a);
  - the invoice/ref lifecycle and the daily-backstop bucket;
  - `DecisionInput.ref`/`daily`;
  - async `runChecks`/`checkAttestation`;
  - `pre_ledger_decision_hashes`;
  - SDK additions (`spends.get`, `requestId`, `skipPreflight`, `systemPrompt`, `modelUsage`, `NearAiProposer`, `hashInvoice`, deps injection, read-only mode);
  - CLI additions;
  - MCP human amounts;
  - the `rate_limits` and `pilots` columns;
  - new env vars;
  - §16 evidence file;
  - §17 claim markers;
  - version additions.

  **Open OWNER decision:** repo visibility. The default recommendation is public from Day 1 (build in public, npm provenance on Day 7).
- 2026-10-21: accepted plan 05 ICR-16 (claim ID ONE-YOCTO, owned by plan 02) and ICR-17 (Probarion.anchors.latest()).
- 2026-10-21: recorded plan 03 additions: the extra CLI printers, `verify --evidence`, and the default archival RPC URLs. Interfaces v2 is final for execution.
- 2026-11-01: ICR-1 from the plan 03 Task 3 review: bound the §6 ledger nonce to the vault. Why: the seq-0 nonce was not bound to a vault (every vault's first decision has `prev_link` = 0x00*32 and `seq` = 0, and mandate ids restart at 1), so NEAR AI evidence from one vault's seq-0 decision could be reused in another vault. What: `u32be(len) || utf8(vault)` is appended to the nonce preimage for every `seq`; A6 recomputes with the vault. `computeNonce` takes `vault`.
- 2026-11-01: ICR-2 from the plan 03 Task 5 review: bind the model response and the recorded proposal (A7) and document request binding (A8). Why: a probe passed A1 to A6 for two attacks. (1) Proposal swap: the check never saw the entry's proposal and the evidence held only `response_sha256`, so whoever writes the ledger could record `pay` after the model said `refuse`. (2) Replay: a chat signature from vault A combined with a report fetched for vault B's nonce passed, because the chat request carries no nonce. What: `AttestationEvidence.response_body` (new, the exact response text as received); check A7 (response hash, chat id, proposal equality by `canonicalJson`); `checkAttestation(evidence, nonce, proposal)`; `quote_verified: false` on every offline result; the optional auditor check A8 (`request_sha256` recomputed from the invoice document and the recorded inputs, plan 03 Task 7/14); check e runs A1 to A7. Limit, stated plainly: offline A1 to A7 prove internal consistency only (genuine TEE needs O1 online), and the binding of a chat to its ledger position rests on A8 being run by an auditor who holds the invoice documents.
- 2026-11-01: ICR-2 wording fixes from the plan 03 Task 5 re-review (no behaviour change). A5/A6 bind the attestation report, not the chat, so A1 to A7 do not prove that the request was the honest one for this invoice and position until the auditor check A8 runs with the invoice documents; the invoice text is not stored for the REQUEST, but `response_body` stores the full model output (it may quote invoice details, size bounded only by the model's response); `extractJsonObject` and `parseModelProposal` are frozen for ledger `v` 1 and A7 must dispatch on the entry's `v`; `quote_verified` is a `boolean` (false offline, true only after O1).
- 2026-11-01: ICR-4 from the plan 03 Task 7 review: check d binds each spend to exactly one allow decision. Why: the vault contract only checks that `decision_hash` is 64 lowercase hex and does not de-duplicate it, so an agent key could send several spends that all point at one allow decision (a different invoice, mandate or amount each time), or spend without approval by pointing at a hold decision; the old check d, which only looked for any allow or hold decision with that hash, passed all of them. Now, for every spend not in `pre_ledger_decision_hashes`, the decision must carry the spend's `invoice_hash`, `mandate_id` and `amount`, must be `allow` (or `hold`, only when the spend went through `held`, which the snapshot shows as a non-null `held_until_ns`: the contract's `reserve` sets it only for a held spend and no code path clears it, so it survives approval, payout, rejection and expiry), and must be referenced by no other spend. Cost if wrong: the SDK must write each decision with the invoice, mandate and amount of the spend it then sends, and send one spend per decision.
- 2026-11-01: ICR-4b from the plan 03 Task 7 review (opus): the pre-ledger exemption of check d is one-shot. Why: the documented pre-ledger hashes are public and the vault contract does not de-duplicate `decision_hash`, so a rogue agent key could send any number of spends that point at one documented hash, and ICR-4 exempted every one of them (probe: three rogue spends passed). Now each hash in `pre_ledger_decision_hashes` exempts at most one spend, the lowest spend id that references it, and when the snapshot has at least one anchor only a spend created before the first anchor's `at_ns` qualifies. Any other spend that references a pre-ledger hash fails d ("decision_hash is a pre-ledger hash already used by spend N" or "... created after the ledger began"). The report says "listed as pre-ledger by the snapshot" and makes no claim about `docs/evidence`. Cost if wrong: a vault with several v0 spends needs one distinct documented decision hash per spend, which the Day-4 evidence files already are.
- 2026-11-01: ICR-5 from the plan 03 Task 7 review (opus): check f stops trusting the snapshot's `expected_code_hashes` and checks every access key. Why: the list is free text in the snapshot, so a hash added to it was accepted (probe: an unknown wasm passed for both a non-factory vault and a canonical-factory vault), and any function-call key other than the ledger and agent keys (an any-method key, one whose receiver is intents, an agent that may also call the callbacks) passed. Now the trusted code hashes are `KNOWN_VAULT_CODE_HASHES` plus the `code_hash` of every `factory_versions` entry, the latter only when `config.factory` is the network's canonical factory; `expected_code_hashes` is advisory and f fails with "snapshot lists an untrusted code hash" if it lists anything outside that set. Every access key must be the current ledger key (receiver = the vault, methods exactly `["anchor"]`, as `set_ledger_key` grants) or an agent key (receiver = the vault, methods exactly `["spend"]`, as `add_agent` grants), otherwise f fails and names the key and its permission. Cost if wrong: the SDK must build `expected_code_hashes` from `KNOWN_VAULT_CODE_HASHES` plus the canonical factory's `versions()` only (Task 14), and a vault with any extra key now fails.
- 2026-11-01: plan 03 Task 7 re-review (opus), three Minors, no change to the rules above beyond these: (1) `CheckResult` gains the optional `lastUnprovenSeq`, set by check c, so that `firstBrokenSeq(report)`, defined as the first seq whose history is not proven, can tell whether the exact entry that check a or b names lies inside the anchor range c cannot prove: it is the lowest seq named by any failing check, except that an exact a/b seq inside c's range replaces c's start (a seq outside the range refines nothing, so a consistent rewrite of entries 2 to 3 plus a bad entry at 5 reports 2). (2) Check f also requires a vault the canonical factory created at version N to run exactly version N's `code_hash`, not any other trusted build. (3) Check h says "burn tx not supplied" only for a spend that check d actually exempted as pre-ledger, and names `docs/mainnet-proof.json` only on mainnet. Cost if wrong: a consumer that reads `CheckResult` ignores one optional field; a vault whose code is a trusted build other than its factory version now fails f.
- 2026-11-01: plan 03 Task 7 re-review (opus), `firstBrokenSeq`: corrects the re-review entry above. `firstBrokenSeq(report)` is the lowest seq any failing check points to and nothing refines it; the refinement that let an exact check a or b seq inside check c's range replace c's start is withdrawn. Why: a and b only prove that an entry is self-consistent, not that it is the history the anchor pinned, so entries of c's range before the exact seq stay unproven (probe: entry 2 rewritten and re-linked consistently, entry 3 then tampered: the answer is 2, not 3; a fork inside the range reports its range start too). `lastUnprovenSeq` stays as information only. For d and h the seq is the decision whose chain outcome failed, not necessarily unproven ledger history. Cost if wrong: none for consumers; a fork now reports the start of the range the anchor cannot prove.
- 2026-11-02: ICR-3 from the plan 03 Task 11 dispatch (controller ruling on the Task 5 re-review carry): make A8 computable offline. Why: A1 to A7 cannot show that a chat was requested for this invoice and position (the replay and writer-chosen-request gap of ICR-2), and the old plan put no nonce in the request and recorded none of its inputs. What: (a) the nonce goes in the USER message under the header `Probarion decision request v1` / `nonce: <64 hex>`, followed by the canonical facts, the mandates and the invoice text in a fixed order with fixed labels; the system message stays the replaceable system prompt, so the Canary persona is still `messages[0].content`; (b) `buildProposalRequest`, `PROPOSAL_SYSTEM_PROMPT` and the template id `probarion-proposal/v1` live in `@probarion/core`; (c) `AttestationEvidence.request_inputs` = `{ template, model, system_prompt, facts, mandates, invoice_text_sha256 }`, never the invoice text; (d) A8, `checkRequestBinding(evidence, invoiceText, expectedNonce?)`: invoice hash, rebuilt request hash equals `request_sha256`, nonce header equals the ledger nonce, "not run" without the invoice text; (e) `response_body` is capped at 64 KiB, and over the cap the proposer reports `model_unavailable` (rules-only); (f) the signature is stored normalized (v in {27, 28}, low-s); (g) the A1 signed-text format is the single core constant `PROVIDER_TEE_TEXT_FORMAT`. Cost if wrong: one more optional evidence field and one more function; the Task 11 OWNER recording may change the A1 constant.
- 2026-11-02: ICR-3b from the plan 03 Task 11 review (opus): A8 binds the invoice to the chain and the request to an allow-listed prompt. Why: with the ICR-3 form of A8 a writer who builds the evidence themselves passed it with a request they chose: (P1) a persona that dictates the answer, recorded honestly in `request_inputs`; (P1b) a directive hidden in `facts.po_ref` and in a non-hex `facts.invoice_hash`; (P1c) a fabricated mandate with extra payee keys and a directive in its label; and (P2) an auditor handed another invoice text than the one the model saw, because `invoice_text_sha256` was never tied to anything on chain. What: (a) `invoice_hash := sha256Hex(utf8(invoiceText))`, the text the model saw (a PDF's extracted text), with the file hash recordable separately as `document_sha256`; (b) `checkRequestBinding(evidence, invoiceText, context, opts?)` takes the decision entry's ledger context and requires: the recomputed nonce equals the header nonce, `invoice_text_sha256 === context.invoice_hash` and `sha256(invoiceText) === invoice_text_sha256`, `facts` non-null with `facts.invoice_hash === context.invoice_hash`, `sha256(system_prompt)` in an allow-list (`KNOWN_SYSTEM_PROMPT_HASHES`, extendable, the matching prompt is named), strict shapes (hex32 hashes, decimal-string amounts, `Payee` as the exact tagged union, status from the enum, no extra keys), and the rebuilt `request_sha256`; (c) what A8 then proves and does not (the TEE answered the standard request under an allow-listed prompt for exactly the invoice text bound on chain at this position; not that `facts` and `mandates` matched the chain, which Task 14 checks against the snapshot's immutable mandate fields, the entry's `mandate_id` and amount, while historical `remaining` and `status` need archival state; injection inside the invoice text is left to `decide()` and the contract); (d) the overclaiming wording ("A8 closes that gap") is replaced by that statement; (e) template v1 carries `max_tokens: 4096`, decided before any real decision freezes the v1 bytes; (f) the A1 row refers to `PROVIDER_TEE_TEXT_FORMAT`; (g) §9: `NearAiProposer.propose` requires `facts`, whose `invoice_hash` must be the text hash. Cost if wrong: a stricter A8, one more required argument to `propose`, and a changed v1 byte layout (nothing real was recorded under the old bytes).
- 2026-11-02: ICR-3c from the plan 03 Task 11 fix round 1 (controller adoption of the implementer's concern): A8 requires `request_inputs.facts.po_ref` to be null or a verbatim substring of the invoice text. Why: after ICR-3b the only free text the model was shown that nothing tied to an auditable source was `facts.po_ref`: with a valid hash and the default prompt a writer who builds the evidence themselves could put a directive there (probe P1b with a valid hash) and still pass A8. The auditor holds the invoice text, so the check is free; the Task 13 extractor must emit `po_ref` as a verbatim substring (no trimming, case change or reformatting), and `NearAiProposer.propose` refuses facts whose `po_ref` is not. Mandate `label` and the account ids and addresses of a `payee` need no A8 rule: they are immutable on chain and Task 14 matches `request_inputs.mandates` against the snapshot. Cost if wrong: an extractor that normalises `po_ref` makes honest decisions fail A8; it must copy the text instead.
- 2026-11-02: ICR-6 from the plan 03 Task 13 dispatch (controller ruling): the spend outcome model and the `process` input checks of §9. Why: a `spend` whose answer was lost (`TxOutcomeUnknownError`) or cannot say whether it paid had no outcome status, so a caller could only read it as `failed` and pay again under a fresh `ref`; the anchor of a cycle had no place to be returned; and `process` accepted facts that `NearAiProposer.propose` and A8 refuse. What: (a) `SpendOutcomeStatus` gains `"unconfirmed"`: `txHash` is set, the payment entry records `contract.status: "unknown"`, never retried; (b) `SpendOutcome` gains `anchorTxHash: string | null`, returned only and not stored in any ledger entry, because an entry cannot hold the hash of the tx that anchors it (this corrects plan 04's R20 wording); (c) `process` requires `facts.invoice_hash === hashInvoice(text)` and `facts.po_ref` null or a verbatim substring of `text`, else `InvalidInput` before any write; (d) `hashInvoice(content: string | Uint8Array)`: a string is `sha256Hex(utf8(text))`, bytes must be valid UTF-8 and hash the same as their text, anything else throws `InvalidInput`. Cost if wrong: one more status for callers to handle and one more outcome field.
- 2026-11-02: ICR-6 amendment from the plan 03 Task 13 fix round 1 (ruling T13-R1). (a) `SpendOutcome.ledgerComplete?: false`, set only when the cycle's payment entry could not be written (the outcome is still returned, never thrown, because the spend may have gone through); the SDK's default logger is a structured `console.warn`. (b) `LedgerStore.append(body, sign, opts?: { expect?: { seq, prev_link } })` is a compare-and-append checked under the store's lock, throwing `LedgerConflictError` and writing nothing on a mismatch, so a lost cross-process race can no longer leave an attested decision at a seq its nonce does not bind (which would fail check e forever); calls without `opts` are unchanged. (c) A `DuplicateRef`/`DuplicateInvoice` answer is a refusal only when a spend of another decision holds the ref (or holds the invoice live); when nothing holds it in the view read (an RPC a block behind), the outcome is `unconfirmed`. (d) `process`/`requestSpend` refuse by code (`invoice.duplicate`) while the local ledger holds an unresolved `contract.status: "unknown"` payment of the same invoice hash (the ledger body holds no `ref`). Why: review of Task 13. Cost if wrong: one optional outcome field, one optional `append` argument, and a refusal a caller must resolve.
- 2026-11-02: T13-R2 from the plan 03 Task 13 fix round 2: the unconfirmed-payment guard is bounded in time. Why: an `unknown` payment entry counted as resolved only through a later known payment entry (no API writes one) or a chain spend with its decision hash, so a transaction that was never delivered, or one that panicked while its answer was lost, blocked its invoice forever. What: an `unknown` payment also settles once its `at` is more than `UNKNOWN_SETTLE_MS` (exported, 48 h) before the instance's clock and no chain spend carries its decision hash: after 86,400 blocks the tx expires (≤48 h at ≤2 s blocks); even if it lands later, the contract lets at most one spend of the invoice pay; the refusal (`invoice.duplicate`) says when the invoice can be retried; raw mode always sends except while such a payment is unsettled. Carried: RuleId `ledger.unresolved` (Task 14, ICR) and `Probarion.resolve()` with a CLI/MCP command (plan 05). Cost if wrong: a payment still in flight could land after 48 h; the contract lets at most one spend of the invoice pay, so it is never paid twice.
- 2026-11-02: ICR-7 from the plan 03 Task 15 review (ruling T15-R1): keygen requires `--out <file>` or `--print-secret`. Why: the default printed the secret key to the terminal, where it stays in scrollback and shell logs; the owner now chooses, and `--out` saves it to a file (mode 0600 where the OS enforces it, never overwritten) and prints only the public key, with a warning on Windows and warns whenever the file is inside a git work tree (whether git ignores or tracks it cannot be told reliably without running git, so the warning does not depend on it and names `git check-ignore -v` and `git ls-files`). Same ruling: the printed owner and approver transactions write `<method>.<first 12 hex of sha256(args JSON)>.args.json`, so a later print cannot rewrite the file under an earlier command (the file is created exclusively, an existing file with other content is refused, and the full sha256 of the file is printed beside the command); the Ledger hint is `sign-with-ledger usb send`.
- 2026-11-02: ICR-8 from the plan 03 Task 14 carries (B6): RuleId `ledger.unresolved`. Why: the unconfirmed-payment guard of T13-R2 refused with `invoice.duplicate`, which reads as "already paid" when the truth is "unknown, wait". What: `RuleId` gains `ledger.unresolved`; the SDK guard refuses with it (the passing `invoice.duplicate` rule stays, the refusal follows it); `invoice.duplicate` keeps meaning a used ref or a live invoice; `decide()` never emits the new id. Cost if wrong: a consumer that switches on RuleId sees one more value.
- 2026-11-02: ICR-9 from the plan 03 Task 14 carries (B1-B5): A8 in verify. Why: A8 was a separate function nothing ran, the mandates the model was shown were never compared with the chain, and a payee field could hold free text. What: (a) the strict shape of `request_inputs` holds `payee.account_id` and `payee.asset` to the NEAR AccountId grammar (the asset prefixed `base-`/`sol-` for its chain) and `payee.address` to `0x` + 40 hex (Base) or 32-44 base58 (Solana); (b) `Snapshot.chain.mandates?` (list_mandates); (c) `runChecks(s, { now, invoiceTexts, systemPrompts })` and `Probarion.verify({ online, snapshot, invoiceTexts, systemPrompts })`: with texts, check e runs A8 and the mandate match (`matchRequestMandates`: ids exist once, immutable fields equal, the entry's mandate among them, `facts.amount` = the entry's amount; `remaining`/`status` differences are archival notes) as one verdict; `systemPrompts` extends the allow-list, never replaces it; (d) the text-free A8 subset `requestInputsProblemWithoutText` moves to core; (e) the doc says that `facts.purpose_hash` is writer-chosen hex and that A8 does not prove the invoice authentic. Cost if wrong: verify needs the invoice texts for A8, and a Canary verifier must pass the persona.
- 2026-11-02: ICR-10 from the plan 03 Task 14 carries (A, C): how the SDK gathers a snapshot and what checks d and h note. Why: the stub burn shape, global-mode vaults, by-ref outcomes without a burn tx, the v0 vault's documented spends and Task 13's unknown and incomplete cycles would otherwise false-fail our own vaults, and a snapshot must not list code hashes check f does not trust. What: `codeIdentity` (R6); `expected_code_hashes` = the trusted set; pre-ledger hashes only for mainnet v0; burn txs from `burnTxHints`, then the ledger, then (online) FastNEAR; the stub ft_burn accepted on testnet only (R5); h notes a documented pre-ledger burn without a supplied tx instead of failing, fails a supplied tx without a pair and two spends citing one tx; d notes unknown payment entries (resolved from chain state, or pending) and spends without a payment entry; the SDK's chain reads map the four access-key permission variants (a gas key reads as its plain counterpart, an unknown shape throws), refuse a null POA balance, read the legacy 200 "does not exist while viewing" answers (a missing key is null, a missing account is UNKNOWN_ACCOUNT), and fail reads over on INTERNAL_ERROR, UNAVAILABLE_SHARD and NOT_SYNCED_YET (sends keep their rules); the final `ProbarionDeps` names are listed in §9. Cost if wrong: an undocumented v0 Base burn shows as a note rather than a failure until docs/mainnet-proof.json records its tx.
- 2026-11-02: T13-R2 wording (plan 03 Task 13 re-review, fixed by Task 14): "after 48 h the tx can no longer pay" is replaced in §9, the T13-R2 line and spend-outcome.ts by: after 86,400 blocks the tx expires (≤48 h at ≤2 s blocks); even if it lands later, the contract lets at most one spend of the invoice pay. No behaviour change.
- 2026-11-02: ICR-11 from the plan 03 Task 14 review (ruling T14-R1). Why: two false passes. (C1) O1 kept only the quote's report data, so a writer's own TDX guest (a debug TD, a revoked TCB, any cloud VM) signing with its own key passed as "verified", and O2 never tied the GPU payload to the request, so a replayed payload passed. (I1) verify trusted the intents contract and assets the vault names itself. What: O1 = DCAP + the library's quote policy (debug off; TCB `UpToDate`, `OutOfDate` or `TDRelaunchAdvised`) + report_data, reported as "DCAP-genuine TDX quote bound to this request; measurement not pinned"; O1b (pin `mrConfigId`, `rtMr3`, the deployment) is deferred and `quote_verified` stays false until it lands; O2 requires the payload nonce = `evidence.nonce` before NRAS; online never upgrades an offline e failure and reports the lower seq. g and h require `config.intents === NETWORKS[network].intents`, h requires every burned asset in `NETWORKS[network].allowedAssets`, and the SDK reads intents and burns from the network's own contract. Also: only a successful receipt counts in a burn pair; an approved held payout or an unrecorded burn is the note "burn is in the approver's tx (or not recorded); supply a hint or run --online"; the pre-ledger note says "listed as pre-ledger by the snapshot"; burn tx hints carry the evidence file's `signer_id`; a malformed docs/mainnet-proof.json is a warning, not a failed verify; `verify({ systemPrompts })` is validated. Cost if wrong: a vault on its own intents deployment or asset fails g/h, and O1 cannot be called a TEE proof until O1b.
- 2026-11-02: ICR-12 from the plan 03 Task 14 re-review (ruling T14-R2): check h gains the status `unproven`. Why: after T14-R1 an unproven burn passed h with a note and `ok` stayed true: an approved held Base payout verified offline, a writer who leaves out payment entries (every missing burn became a note), a read or hinted tx without a burn pair for a held spend, and the documented v0 burn without a tx. What: `CheckResult.status` adds `"unproven"` (h only); `VerifyReport.ok` is true only when no check is `fail` or `unproven`; `VerifyReport.unproven: { check: "h"; spend_id; reason: "pre_ledger_no_tx" | "approver_tx" | "not_recorded" }[]`; `firstBrokenSeq` ignores `unproven`; a tx that was read and holds no burn pair fails h for every spend, and the SDK never counts a held spend's reservation tx as read (it needs the approver's tx from a hint or, online, the tx index). This supersedes the R7 note of ICR-10 and ICR-11. Downstream: the CLI's `probarion verify` exits 2 on `unproven` and 1 on `fail` (fail wins); the web `/proof` shows h as an amber "not proven" badge listing the spends and the hint. Cost if wrong: an honest held payout or the v0 Day-4 burn reads "not proven" until its tx is supplied.
- 2026-11-03: ICR-13 from the plan 03 Task 14 fix round 2 re-review (follow-up to T14-R2). Why: a tx that could not be read on an honest vault (an RPC outage, an answer the client cannot read, an old tx with no archival RPC) was indistinguishable from one the node says does not exist, and every ledger tx of a held spend was skipped, not only its reservation. What: `Snapshot.chain.burns[].status` adds `"unavailable"` and `UnprovenBurn.reason` adds `"tx_unavailable"`: h is `unproven` for it, with "the tx could not be read right now; re-run, or add an archival RPC". A node's UNKNOWN_TRANSACTION answer is definitive (with an archival RPC for an old tx) and fails h like a tx read without a pair, so a writer-supplied bogus hash still fails; a definitive failure wins over an unavailable tx. Only the payment entry with `contract.status: "held"` (the reservation) is skipped for a held spend; any other ledger tx read without a pair fails. §9: `burnTxHints` holds `BurnTxHint[]` (a hash, or `{ hash, signer }`). Cost if wrong: a vault whose RPC is down reads "not proven" instead of failing.
