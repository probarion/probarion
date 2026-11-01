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
  | "contract.check_failed" | `custom.${string}`;

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

export interface AttestationEvidence {
  provider: "near-ai-cloud";
  model: string;
  chat_id: string;
  nonce: Hex32;
  request_sha256: Hex32;
  response_sha256: Hex32;
  signature: { text: string; signature: string; signing_address: string; signing_algo: "ecdsa" };
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
- An anchor = `anchor(seq = k, root = link of entry[count-1], count)`. `k` starts at 1. The SDK anchors after every cycle.

Nonce:

```
nonce = sha256( utf8("probarion/v1") || bytes32(prev_link) || bytes32(invoice_hash ?? 0x00*32) || u64be(mandate_id ?? 0) || u64be(seq) )
```

`seq` is the seq of the decision entry about to be written. The output is lowercase hex of 64 chars.

## 7. Attestation checks (offline, in `@probarion/core/attestation`)

Given an `AttestationEvidence` and the expected nonce:

**Fetching (from spike S2):** `GET /v1/attestation/report?model=<id>&signing_algo=ecdsa&nonce=<64 hex>&provider=near&include_tls_fingerprint=false` with header `x-no-aliasing: true`. The docs say the JSON does **not** return `report_data`; it must be read from the TDX quote: `report_data` = TD report body bytes `[520, 584)`, where the body starts at quote byte offset 48 (quote v4) or 54 (quote v5). From the candidates returned, keep exactly the one whose signing address matches the response signature; if not exactly one, set `report: null`, mark `decided_by` normally, and check `e` reports the entry as unattested.


| Check | Requirement |
|---|---|
| A1 | `signature.text === \`${model}:${request_sha256}:${response_sha256}\`` |
| A2 | The EIP-191 signer recovered from (`text`, `signature.signature`) equals `signature.signing_address`, case-insensitive. Use `viem` `recoverMessageAddress` |
| A3 | `report.signing_address` equals `signature.signing_address` |
| A4 | `report_data` bytes 0–31 hold the 20-byte address left-aligned, zero-padded. If they instead hold `sha256(signer \|\| tls_fingerprint)`, mark `binding: "tls"` and pass A4 only online |
| A5 | `report_data` bytes 32–63 equal `nonce` |
| A6 | `nonce` equals the recomputed nonce from the ledger context |

Online-only checks (O1 TDX quote via DCAP, O2 NVIDIA NRAS) are **optional**, run behind `--online`, and may use `@nearai/inference-sdk`.

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
export interface LedgerStore { head(): Promise<LedgerEntry | null>; append(body: Omit<LedgerEntryBody, "seq" | "prev_link">, sign: (bodyHash: Uint8Array) => Promise<{ sig: string; signer: string }>): Promise<LedgerEntry>; all(): Promise<LedgerEntry[]> }
export type SpendOutcomeStatus = "refused_by_code" | "refused_by_contract" | "held" | "paid" | "burned" | "settled" | "failed";
export interface SpendOutcome { status: SpendOutcomeStatus; spendId: number | null; code: string | null /* RuleId for code outcomes, bare vault code for contract outcomes */; txHash: string | null; ledgerSeq: number /* last entry written */; decisionHash: Hex32; modelUsage?: { model: string; promptTokens: number; completionTokens: number } | null }
// requestSpend input also accepts skipPreflight?: boolean (always sends spend; returns refused_by_contract with code + failed tx hash). Used only by Canary raw mode.
// Also exported: NearAiProposer { constructor({ apiKey, model?, baseUrl? }); readonly model: string; propose({ invoiceText, mandates, nonce }): Promise<{ proposal; evidence }> }, and hashInvoice(bytes | string): Hex32.
// Outcome entries use kind "payment" with contract.status in SpendStatus values | "check_failed" | "refused". A code-level hold is submitted only if check_spend says would_hold; otherwise status "held" with spendId null.

export class Probarion {
  constructor(opts: ProbarionOptions, deps?: ProbarionDeps); // deps: injected rpc/fetch/clock/proposer for tests
  readonly spends: { get(id: number): Promise<SpendView | null> };
  readonly anchors: { latest(): Promise<AnchorView | null> };
  readonly mandates: { list(): Promise<MandateView[]>; get(id: number): Promise<MandateView | null> };
  readonly rules: { add(rule: CustomRule): void };
  checkSpend(input: { mandateId: number; amount: string; invoiceHash: Hex32; ref: string }): Promise<{ ok: boolean; code: string | null; would_hold: boolean }>;
  /** Full cycle: (optional) model → policy → ledger decision entry → contract spend → ledger outcome entry → anchor. */
  process(invoice: { text: string; facts: InvoiceFacts; ref: string }): Promise<SpendOutcome>;
  /** Low-level: caller already decided; still writes ledger + checks contract. No recipient parameter exists. */
  requestSpend(input: { mandateId: number; amount: string; invoiceHash: Hex32; ref: string; proposal?: ModelProposal | null; evidence?: AttestationEvidence | null }): Promise<SpendOutcome>;
  verify(opts?: { online?: boolean; snapshot?: Snapshot }): Promise<VerifyReport>;
  snapshot(): Promise<Snapshot>;
}
```

## 10. Verifier (`@probarion/core/verify` for pure checks; `@probarion/sdk` gathers the chain data)

```ts
export type CheckId = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i";
export interface CheckResult { id: CheckId; name: string; status: "pass" | "fail" | "skip"; detail: string; firstBrokenSeq?: number }
export interface VerifyReport { vault: string; network: "mainnet" | "testnet"; ok: boolean; checks: CheckResult[]; entries: number; anchors: number; generated_at: string }

export interface AccessKeyInfo { public_key: string; permission: "FullAccess" | { receiver_id: string; method_names: string[]; allowance: string | null } }
export interface Snapshot {
  v: 1; vault: string; network: "mainnet" | "testnet"; taken_at: string;
  ledger: LedgerEntry[];
  chain: {
    access_keys: AccessKeyInfo[]; code_hash: string; config: VaultConfig;
    anchors: AnchorView[]; spends: SpendView[];
    intents_public_keys: string[]; intents_predecessor_auth: boolean;
    factory_version: number | null; factory_versions: VersionView[];
    burns: { spend_id: number; tx_hash: string; memo: string; intents_owner: string; amount: string; status: "ok" | "missing" }[]; // POA ft_burn (owner_id = intents.near, memo) matched with intents.near mt_burn (owner_id = vault) in the same tx
  };
  expected_code_hashes: string[]; // from reproducible build + factory versions
}
export function runChecks(s: Snapshot, opts?: { now?: Date }): Promise<VerifyReport>; // pure, offline; async because EIP-191 recovery is async
// Snapshot also carries pre_ledger_decision_hashes: Hex32[] (Day-4 v0 spends recorded in docs/evidence/ before the ledger existed); check d reports them as "pre-ledger (documented)", not fail.
// Check a (v2): entries in each anchor range (prev.count, anchor.count] must be signed by that anchor's ledger_key; entries after the last anchor by config.ledger_key.
// Check h uses NEAR_ARCHIVAL_RPC_URLS for tx lookups older than about 2.5 days.
// @probarion/core also exports KNOWN_VAULT_CODE_HASHES (from contracts/code-hashes.json) for non-factory vaults, and checkAttestation(evidence, nonce): Promise<{ ok; binding; checks: { id: "A1".."A6"; pass; detail }[] }>. A3 requires signing_algo "ecdsa"; A5 requires report.request_nonce == nonce.
```

| Check | Name | Passes when |
|---|---|---|
| a | `ledger-signatures` | Every `sig` verifies with `signer`, and `signer` is the vault's ledger key: an FC key with methods `["anchor"]` |
| b | `hash-links` | Every `body_hash` and `link` recomputes, and `prev_link` chains |
| c | `anchors` | For every anchor, `root == ledger[count-1].link` |
| d | `spends-have-decisions` | Every on-chain spend's `decision_hash` is the `body_hash` of a `decision` entry with verdict `allow` or `hold` |
| e | `attestations` | Every entry with `evidence` passes A1–A6; entries with `decided_by = "rules-only"` are reported, not failed |
| f | `vault-locked` | No FullAccess key, and `code_hash` ∈ `expected_code_hashes` |
| g | `intents-keys` | `intents_public_keys` is empty and `intents_predecessor_auth` is true |
| h | `burn-memos` | Every Burned spend has a matched burn pair in its tx: POA token `ft_burn` (owner_id `intents.near`) with memo == `WITHDRAW_TO:` + destination.address, and `intents.near` `mt_burn` with owner_id == vault and amount == spend amount |
| i | `factory-version` | `factory_version` is non-null and present in `factory_versions` (`skip` for non-factory vaults) |

## 11. CLI (`probarion`)

```
probarion vault create --name <n> --approvers a.near,b.near --daily-backstop 500 --held-ttl-hours 72   # prints the near-connect/near-cli tx for the OWNER to sign
probarion mandate create --vault <id> --payee near:<acct> | base:<0x..> --max-per 100 --max-total 1000 --uses 10 --expires 2026-12-31 --approval-above 100 --agent-pk ed25519:.. --purpose <file|hex> --label "..."
probarion agent keygen                      # prints new ed25519 keypair (public to share, secret to env)
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
