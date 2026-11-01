// TEST DOUBLE of the Probarion vault, intents and factory views (interfaces v2 §4, §5). Not the contract.
//
// The semantics are read off the Rust, which is the authority (plan 02's sandbox tests run the real thing):
//   contracts/vault/src/checks.rs   Vault::evaluate: preconditions, then the ordered checks (lines 17-71)
//   contracts/vault/src/spend.rs    reserve, execute_payout, settle, fail_spend, release (lines 12-274)
//   contracts/vault/src/held.rs     approve, reject, expire_held
//   contracts/vault/src/anchors.rs  anchor, list_anchors
//   contracts/vault/src/keys.rs     the FC keys the vault grants itself
//   contracts/vault/src/events.rs   NEP-297 `probarion` 1.0.0
//   contracts/vault/src/types.rs    MandateView, SpendView, Mandate::status (derived)
//   contracts/vault/src/validate.rs is_hex64, is_ref
//   contracts/intents-stub/src/lib.rs, contracts/factory/src/lib.rs for the views
// What it does NOT model: owner calls (create_mandate, revoke_mandate, freeze, add_agent, ...; tests set
// `status = "revoked"`, `config.frozen`, ... directly), NEAR balances and storage staking, gas, FC key
// allowance use, and the vault's USDC balance.
import {
  type AccessKeyInfo,
  type AnchorView,
  type CheckSpendVerdict,
  EVENT_STANDARD,
  EVENT_VERSION,
  type FactoryConfig,
  type MandateStatus,
  type MandateView,
  type Payee,
  parsePublicKey,
  type SpendRequest,
  type SpendResult,
  type SpendStatus,
  type SpendView,
  sha256Bytes,
  utf8,
  type VaultConfig,
  type VersionView,
  WITHDRAW_MEMO_PREFIX,
} from "@probarion/core";
import { baseEncode } from "near-api-js";

/** A contract panic with a `PROBARION:<Code>` message (errors.rs `fail`). */
export class FakePanic extends Error {
  override name = "FakePanic";
  readonly code: string;
  constructor(code: string) {
    super(`PROBARION:${code}`);
    this.code = code;
  }
}

/**
 * A panic that is not a `PROBARION:` code: near-sdk's own "Failed to deserialize input from JSON" and
 * "doesn't accept deposit", an intents-stub `require!`, or `FAKE_UNSUPPORTED` for a call the fake does not model.
 * `code` is empty.
 */
export class FakeRawPanic extends FakePanic {
  override name = "FakeRawPanic";
  constructor(message: string) {
    super("");
    this.message = message;
  }
}

/** A JSON-RPC level refusal (the node answers with an error object instead of executing). */
export class FakeRpcFault extends Error {
  override name = "FakeRpcFault";
  readonly errorName: string;
  readonly causeName: string;
  /** The JSON-RPC error's `data`: the message string, or the structured `TxExecutionError`. */
  readonly data: unknown;
  /** The JSON-RPC error's `cause.info`. */
  readonly info: unknown;
  constructor(
    errorName: string,
    causeName: string,
    message: string,
    data?: unknown,
    info?: unknown,
  ) {
    super(message);
    this.errorName = errorName;
    this.causeName = causeName;
    this.data = data === undefined ? message : data;
    this.info = info === undefined ? {} : info;
  }
}

/** One receipt after the vault's own: executed by `executor`, with its logs and, if it failed, the panic text. */
export interface FakeReceipt {
  executor: string;
  logs: string[];
  /** The receipt's JSON return value. `undefined` is a unit return: an empty `SuccessValue`. */
  value?: unknown;
  /** Set when the receipt fails; the text after `Smart contract panicked: `. */
  failure?: string;
}

export interface FakeCallResult {
  /** What the transaction returns: the callback's result when there was a payout. `undefined` is `()`. */
  value: unknown;
  /** Logs of the first receipt, executed by the vault. */
  vaultLogs: string[];
  /**
   * Later receipts in execution order. A payout is the receipts before the last one, the vault's
   * callback (`on_transfer` / `on_withdraw`) is the last. Gas-refund receipts are added by the RPC server.
   */
  receipts: FakeReceipt[];
}

export interface FakeCall {
  /** The account that signed, which is also the predecessor of a transaction's first receipt. */
  signerId: string;
  signerPk: string;
  receiverId: string;
  method: string;
  args: Record<string, unknown>;
  deposit: bigint;
}

export interface FakeFactory {
  id: string;
  /** 1-based `index` (R14): the contract computes `index: i + 1`. */
  versions: VersionView[];
  vaultVersion: number | null;
  config: FactoryConfig;
}

/**
 * - `mainnet`: intents.near logs `mt_burn` in its own receipt and the POA asset contract logs `ft_burn`
 *   (owner = intents) in a SEPARATE receipt.
 * - `stub`: the testnet intents-stub logs both in ONE receipt (tx 3u4ffrwpiwLoNV6cU72NHLVBAMq729NwLs6ixDLdcvYe).
 */
export type BurnShape = "mainnet" | "stub";

/** `local`: the vault account has its own code. `global`: NEP-591, the code hash is all ones and `global_contract_hash` names the code. */
export type CodeMode = "local" | "global";

/** Makes the next payout fail the way the named step of the real payout can (spend.rs:30-54). */
export type PayoutFailure = "ft_transfer_failed" | "ft_withdraw_failed" | "ft_withdraw_refunded";

export interface FakeChainInit {
  vaultId: string;
  config: VaultConfig;
  /** The vault's code identity (base58 sha256). */
  codeHash: string;
  /** Default `local`. */
  codeMode?: CodeMode;
  /** Default `stub` unless `config.intents` is `intents.near`. */
  burnShape?: BurnShape;
  mandates?: MandateView[];
  spends?: SpendView[];
  anchors?: AnchorView[];
  agentKeys?: { publicKey: string; label: string }[];
  extraAccessKeys?: AccessKeyInfo[];
  factory?: FakeFactory | null;
  intents?: { publicKeys?: string[]; predecessorAuth?: boolean; balances?: Record<string, string> };
  nowNs?: () => bigint;
}

export interface FakeKeyState {
  info: AccessKeyInfo;
  nonce: number;
}

/** The all-ones base58 string a NEAR account without contract code reports as `code_hash`. */
export const ZERO_CODE_HASH = "11111111111111111111111111111111";

const RELEASED: ReadonlySet<SpendStatus> = new Set(["failed", "rejected", "expired"]);
const DAY_NS = 86_400_000_000_000n;
const MAX_PAGE = 100n;
const U128_MAX = (1n << 128n) - 1n;
const HEX64 = /^[0-9a-f]{64}$/;
const NEAR_MEMO_PREFIX = "probarion:";
const VAULT_STORAGE_USAGE = 2048;
const BALANCE = "10000000000000000000000000";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventLine(standard: string, version: string, name: string, data: unknown): string {
  return `EVENT_JSON:${JSON.stringify({ standard, version, event: name, data })}`;
}

/** events.rs: `{"standard":"probarion","version":"1.0.0","event":<snake_case>,"data":{...}}`. */
function probarion(name: string, data: unknown): string {
  return eventLine(EVENT_STANDARD, EVENT_VERSION, name, data);
}

function nep141(name: string, data: unknown): string {
  return eventLine("nep141", "1.0.0", name, data);
}

function nep245(name: string, data: unknown): string {
  return eventLine("nep245", "1.0.0", name, data);
}

function withdrawMemo(payee: Payee): string | null {
  return payee.type === "intents" ? `${WITHDRAW_MEMO_PREFIX}${payee.address}` : null;
}

/** u128::saturating_add (checks.rs:53, :63). */
function sat(a: bigint, b: bigint): bigint {
  const sum = a + b;
  // biome-ignore lint/complexity/useMathMinMax: bigint operands, Math.min takes numbers
  return sum > U128_MAX ? U128_MAX : sum;
}

/** Mandate::status (types.rs:195-203): revoked, else exhausted at max_uses or spent >= max_total, else active. */
function deriveStatus(m: MandateView): MandateStatus {
  if (m.status === "revoked") return "revoked";
  return m.uses >= m.max_uses || BigInt(m.spent) >= BigInt(m.max_total) ? "exhausted" : "active";
}

function deserializeError(detail: string): FakeRawPanic {
  return new FakeRawPanic(`Failed to deserialize input from JSON.: ${detail}`);
}

function u64Arg(source: Record<string, unknown>, name: string): bigint {
  const value = source[name];
  if (value === undefined) throw deserializeError(`missing field \`${name}\``);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw deserializeError(`invalid value for \`${name}\`: expected a u64`);
  }
  return BigInt(value);
}

function stringArg(source: Record<string, unknown>, name: string): string {
  const value = source[name];
  if (value === undefined) throw deserializeError(`missing field \`${name}\``);
  if (typeof value !== "string")
    throw deserializeError(`invalid type for \`${name}\`: expected a string`);
  return value;
}

/** near-sdk U128 reads a JSON string with `u128::from_str`: digits with an optional `+`. */
function u128Arg(source: Record<string, unknown>, name: string): bigint {
  const text = stringArg(source, name);
  if (!/^\+?[0-9]+$/.test(text))
    throw deserializeError(`\`${name}\`: invalid digit found in string`);
  const value = BigInt(text);
  if (value > U128_MAX)
    throw deserializeError(`\`${name}\`: number too large to fit in target type`);
  return value;
}

interface ParsedRequest {
  mandateId: bigint;
  amount: bigint;
  invoiceHash: string;
  ref: string;
  decisionHash: string;
}

/** Deserialises a `SpendRequest` like serde would. An unreadable request is a panic, not a verdict. */
function parseRequest(raw: unknown): ParsedRequest {
  if (raw === undefined) throw deserializeError("missing field `request`");
  if (!isRecord(raw)) throw deserializeError("`request`: expected an object");
  return {
    mandateId: u64Arg(raw, "mandate_id"),
    amount: u128Arg(raw, "amount"),
    invoiceHash: stringArg(raw, "invoice_hash"),
    ref: stringArg(raw, "ref"),
    decisionHash: stringArg(raw, "decision_hash"),
  };
}

function pageOf<T>(all: readonly T[], args: Record<string, unknown>): T[] {
  const from = u64Arg(args, "from_index");
  const limit = u64Arg(args, "limit");
  const end = from + (limit < MAX_PAGE ? limit : MAX_PAGE);
  const stop = end < BigInt(all.length) ? end : BigInt(all.length);
  return from >= stop ? [] : all.slice(Number(from), Number(stop));
}

interface Verdict {
  code: string | null;
  hold: boolean;
}

export class FakeChain {
  readonly vaultId: string;
  config: VaultConfig;
  codeHash: string;
  codeMode: CodeMode;
  burnShape: BurnShape;
  mandates: MandateView[];
  spends: SpendView[];
  anchors: AnchorView[];
  factory: FakeFactory | null;
  intents: { publicKeys: string[]; predecessorAuth: boolean; balances: Record<string, string> };
  readonly nowNs: () => bigint;
  readonly txs = new Map<string, Record<string, unknown>>();
  readonly hooks: {
    checkSpendCode: string | null;
    spendPanic: string | null;
    payoutFailure: PayoutFailure | null;
  } = { checkSpendCode: null, spendPanic: null, payoutFailure: null };
  readonly height = 190_000_000;
  readonly blockHash = baseEncode(sha256Bytes(utf8("probarion/test-double/block")));
  private readonly keys = new Map<string, FakeKeyState>();
  private readonly agentLabels = new Map<string, string>();

  constructor(init: FakeChainInit) {
    this.vaultId = init.vaultId;
    this.config = init.config;
    this.codeHash = init.codeHash;
    this.codeMode = init.codeMode ?? "local";
    this.burnShape =
      init.burnShape ?? (init.config.intents === "intents.near" ? "mainnet" : "stub");
    this.mandates = init.mandates ?? [];
    this.spends = init.spends ?? [];
    this.anchors = init.anchors ?? [];
    this.factory = init.factory ?? null;
    this.intents = {
      publicKeys: init.intents?.publicKeys ?? [],
      predecessorAuth: init.intents?.predecessorAuth ?? true,
      balances: init.intents?.balances ?? {},
    };
    this.nowNs = init.nowNs ?? (() => BigInt(Date.now()) * 1_000_000n);
    // keys.rs: add_agent grants FunctionCall { receiver: the vault, method_names: ["spend"] }, set_ledger_key
    // FunctionCall { receiver: the vault, method_names: ["anchor"] }. There are no other keys (I9).
    for (const key of init.agentKeys ?? []) {
      this.addAccessKey(this.vaultId, {
        public_key: key.publicKey,
        permission: {
          receiver_id: this.vaultId,
          method_names: ["spend"],
          allowance: "1000000000000000000000000",
        },
      });
      this.agentLabels.set(key.publicKey, key.label);
    }
    if (init.config.ledger_key !== null) {
      this.addAccessKey(this.vaultId, {
        public_key: init.config.ledger_key,
        permission: {
          receiver_id: this.vaultId,
          method_names: ["anchor"],
          allowance: "250000000000000000000000",
        },
      });
    }
    for (const key of init.extraAccessKeys ?? []) this.addAccessKey(this.vaultId, key);
    this.refreshStatuses();
  }

  // ---- accounts and keys ---------------------------------------------------------------------

  /** Adds an access key to any account. Real nonces start at `block_height * 1_000_000`. */
  addAccessKey(accountId: string, info: AccessKeyInfo): void {
    this.keys.set(`${accountId}|${info.public_key}`, { info, nonce: this.height * 1_000_000 });
  }

  accessKeysOf(accountId: string): FakeKeyState[] {
    return [...this.keys.entries()]
      .filter(([key]) => key.startsWith(`${accountId}|`))
      .map(([, state]) => state);
  }

  accessKey(accountId: string, publicKey: string): FakeKeyState | undefined {
    return this.keys.get(`${accountId}|${publicKey}`);
  }

  /** Accounts the fake knows: any other account is `UNKNOWN_ACCOUNT`, as on a node. */
  knownAccount(accountId: string): boolean {
    const known = new Set<string>([
      this.vaultId,
      this.config.owner,
      this.config.usdc,
      this.config.intents,
      ...this.config.approvers,
      ...this.config.allowed_assets,
    ]);
    if (this.factory !== null) known.add(this.factory.id);
    for (const key of this.keys.keys()) known.add(key.slice(0, key.indexOf("|")));
    return known.has(accountId);
  }

  private isContract(accountId: string): boolean {
    return (
      accountId === this.vaultId ||
      accountId === this.config.usdc ||
      accountId === this.config.intents ||
      this.config.allowed_assets.includes(accountId) ||
      (this.factory !== null && accountId === this.factory.id)
    );
  }

  /** The `code_hash` field of view_account. A global-mode vault has no code of its own, so it is all ones. */
  codeHashOf(accountId: string): string {
    if (accountId === this.vaultId)
      return this.codeMode === "global" ? ZERO_CODE_HASH : this.codeHash;
    if (this.isContract(accountId))
      return baseEncode(sha256Bytes(utf8(`probarion/test-double/code/${accountId}`)));
    return ZERO_CODE_HASH;
  }

  /** NEP-591 `global_contract_hash`: the vault's real code identity in global mode, else `null` (RPC omits the field). */
  globalContractHashOf(accountId: string): string | null {
    return accountId === this.vaultId && this.codeMode === "global" ? this.codeHash : null;
  }

  /** The RPC `view_account` result for `accountId`, without the block fields. */
  accountView(accountId: string): Record<string, unknown> {
    if (!this.knownAccount(accountId)) throw this.unknownAccount(accountId);
    const view: Record<string, unknown> = {
      amount: BALANCE,
      locked: "0",
      code_hash: this.codeHashOf(accountId),
      storage_usage: VAULT_STORAGE_USAGE,
      storage_paid_at: 0,
    };
    const global = this.globalContractHashOf(accountId);
    if (global !== null) view.global_contract_hash = global;
    return view;
  }

  unknownAccount(accountId: string): FakeRpcFault {
    return new FakeRpcFault(
      "HANDLER_ERROR",
      "UNKNOWN_ACCOUNT",
      `account ${accountId} does not exist`,
      undefined,
      {
        requested_account_id: accountId,
        block_height: this.height,
        block_hash: this.blockHash,
      },
    );
  }

  /**
   * What a node checks before a call executes: the key exists, the nonce is above the key's, and a
   * function-call key attaches no deposit and names this receiver and method. A refusal does not use the nonce.
   */
  useNonce(
    accountId: string,
    publicKey: string,
    nonce: number,
    methodName: string,
    receiverId: string,
    deposit = 0n,
  ): void {
    const key = this.accessKey(accountId, publicKey);
    const invalid = (error: Record<string, unknown> | string, text: string) =>
      new FakeRpcFault("HANDLER_ERROR", "INVALID_TRANSACTION", text, {
        TxExecutionError: { InvalidTxError: error },
      });
    if (key === undefined) {
      throw invalid(
        {
          InvalidAccessKeyError: {
            AccessKeyNotFound: { account_id: accountId, public_key: publicKey },
          },
        },
        `access key ${publicKey} not found on ${accountId}`,
      );
    }
    if (nonce <= key.nonce) {
      throw invalid(
        { InvalidNonce: { tx_nonce: nonce, ak_nonce: key.nonce } },
        `nonce ${nonce} <= ${key.nonce}`,
      );
    }
    const permission = key.info.permission;
    if (permission !== "FullAccess") {
      if (deposit > 0n)
        throw invalid(
          { InvalidAccessKeyError: "DepositWithFunctionCall" },
          "DepositWithFunctionCall",
        );
      if (permission.receiver_id !== receiverId) {
        throw invalid(
          {
            InvalidAccessKeyError: {
              ReceiverMismatch: { tx_receiver: receiverId, ak_receiver: permission.receiver_id },
            },
          },
          `ReceiverMismatch: ${receiverId}`,
        );
      }
      if (permission.method_names.length > 0 && !permission.method_names.includes(methodName)) {
        throw invalid(
          { InvalidAccessKeyError: { MethodNameMismatch: { method_name: methodName } } },
          `MethodNameMismatch: ${methodName}`,
        );
      }
    }
    key.nonce = nonce;
  }

  // ---- views -----------------------------------------------------------------------------------

  view(contractId: string, method: string, args: Record<string, unknown>): unknown {
    this.refreshStatuses();
    if (contractId === this.vaultId) return this.vaultView(method, args);
    if (contractId === this.config.intents) return this.intentsView(method, args);
    if (this.factory !== null && contractId === this.factory.id)
      return this.factoryView(method, args);
    throw this.unknownAccount(contractId);
  }

  private methodNotFound(method: string): FakeRpcFault {
    return new FakeRpcFault(
      "HANDLER_ERROR",
      "CONTRACT_EXECUTION_ERROR",
      `wasm execution failed with error: MethodResolveError(MethodNotFound): ${method}`,
    );
  }

  private vaultView(method: string, args: Record<string, unknown>): unknown {
    switch (method) {
      case "get_config":
        return this.config;
      case "get_mandate": {
        const id = u64Arg(args, "mandate_id");
        return this.mandates.find((m) => BigInt(m.id) === id) ?? null;
      }
      case "list_mandates":
        return pageOf(this.mandates, args);
      case "get_spend": {
        const id = u64Arg(args, "spend_id");
        return this.spends.find((s) => BigInt(s.id) === id) ?? null;
      }
      case "list_spends":
        return pageOf(this.spends, args);
      case "list_anchors":
        return pageOf(this.anchors, args);
      case "list_agents":
        return [...this.agentLabels.entries()].map(([public_key, label]) => ({
          public_key,
          label,
          added_at_ns: "0",
        }));
      case "check_spend": {
        const request = parseRequest(args.request);
        const signer = stringArg(args, "signer_pk");
        try {
          parsePublicKey(signer);
        } catch {
          throw deserializeError("`signer_pk`: not a public key");
        }
        return this.verdict(request, signer);
      }
      default:
        throw this.methodNotFound(method);
    }
  }

  private intentsView(method: string, args: Record<string, unknown>): unknown {
    const isVault = args.account_id === this.vaultId;
    switch (method) {
      case "public_keys_of":
        return isVault ? this.intents.publicKeys : [];
      case "is_auth_by_predecessor_id_enabled":
        return isVault ? this.intents.predecessorAuth : true;
      case "mt_balance_of": {
        const token = stringArg(args, "token_id");
        if (!token.startsWith("nep141:"))
          throw new FakeRawPanic("intents-stub: token_id must be nep141:<account>");
        return isVault ? (this.intents.balances[token] ?? "0") : "0";
      }
      default:
        throw this.methodNotFound(method);
    }
  }

  private factoryView(method: string, args: Record<string, unknown>): unknown {
    const factory = this.factory;
    if (factory === null) throw this.unknownAccount("(no factory)");
    switch (method) {
      case "versions":
        return factory.versions;
      case "vault_version":
        return args.account_id === this.vaultId ? factory.vaultVersion : null;
      case "get_config":
        return factory.config;
      case "list_vaults":
        return pageOf(
          [
            {
              account_id: this.vaultId,
              owner: this.config.owner,
              version: factory.vaultVersion ?? 0,
              created_at_ns: "0",
            },
          ],
          args,
        );
      default:
        throw this.methodNotFound(method);
    }
  }

  // ---- spend check (checks.rs) ---------------------------------------------------------------

  private mandate(id: bigint): MandateView | undefined {
    return this.mandates.find((m) => BigInt(m.id) === id);
  }

  /** The amount counted in UTC day `day`: Held, Pending, Paid and Burned spends created in it (a release gives it back). */
  private dayTotal(day: bigint): bigint {
    let total = 0n;
    for (const s of this.spends) {
      if (!RELEASED.has(s.status) && BigInt(s.created_at_ns) / DAY_NS === day)
        total += BigInt(s.amount);
    }
    return total;
  }

  /** checks.rs `evaluate`: the order of the checks is the order of this function. */
  private evaluate(req: ParsedRequest, signerPk: string, now: bigint): Verdict {
    const refuse = (code: string): Verdict => ({ code, hold: false });
    if (!this.agentLabels.has(signerPk)) return refuse("NotAgent"); // :23
    const refBytes = Buffer.byteLength(req.ref, "utf8");
    if (
      !HEX64.test(req.invoiceHash) ||
      !HEX64.test(req.decisionHash) ||
      refBytes === 0 ||
      refBytes > 64
    ) {
      return refuse("InvalidInput"); // :26
    }
    if (this.config.frozen) return refuse("Frozen"); // :29
    const m = this.mandate(req.mandateId);
    if (m === undefined) return refuse("NoMandate"); // :32-33
    if (m.status === "revoked") return refuse("MandateInactive"); // :34, a revoked mandate only
    if (now >= BigInt(m.expires_at_ns)) return refuse("MandateExpired"); // :37
    if (m.agent_pk !== signerPk) return refuse("NotMandateAgent"); // :40
    if (req.amount === 0n) return refuse("ZeroAmount"); // :44
    if (req.amount > BigInt(m.max_per_payment)) return refuse("OverPerPayment"); // :47
    if (m.uses >= m.max_uses) return refuse("UsesExhausted"); // :50
    if (sat(sat(BigInt(m.spent), BigInt(m.reserved)), req.amount) > BigInt(m.max_total)) {
      return refuse("OverMandateTotal"); // :53
    }
    const invoice = req.invoiceHash;
    if (this.spends.some((s) => s.invoice_hash === invoice && !RELEASED.has(s.status))) {
      return refuse("DuplicateInvoice"); // :56
    }
    if (this.spends.some((s) => s.ref === req.ref)) return refuse("DuplicateRef"); // :59, refs are never released
    if (sat(this.dayTotal(now / DAY_NS), req.amount) > BigInt(this.config.daily_backstop)) {
      return refuse("OverDailyBackstop"); // :63
    }
    return { code: null, hold: req.amount > BigInt(m.approval_above) }; // :66-69
  }

  private verdict(req: ParsedRequest, signerPk: string): CheckSpendVerdict {
    if (this.hooks.checkSpendCode !== null)
      return { ok: false, code: this.hooks.checkSpendCode, would_hold: false };
    this.refreshStatuses();
    const v = this.evaluate(req, signerPk, this.nowNs());
    return v.code === null
      ? { ok: true, code: null, would_hold: v.hold }
      : { ok: false, code: v.code, would_hold: false };
  }

  /** The contract's free `check_spend` view. A request the contract could not deserialise throws, as the view would fail. */
  checkSpend(request: SpendRequest, signerPk: string): CheckSpendVerdict {
    return this.verdict(parseRequest(request), signerPk);
  }

  // ---- calls ---------------------------------------------------------------------------------

  /** Runs one function call. A panic throws `FakePanic` and leaves no state behind. */
  applyFunctionCall(call: FakeCall): FakeCallResult {
    if (call.receiverId !== this.vaultId) {
      throw new FakeRpcFault(
        "HANDLER_ERROR",
        "UNKNOWN_ACCOUNT",
        `the fake chain only executes calls to ${this.vaultId}`,
      );
    }
    this.refreshStatuses();
    try {
      switch (call.method) {
        case "spend":
          return this.spend(call);
        case "anchor":
          return this.anchor(call);
        case "approve":
          return this.approve(call);
        case "reject":
          return this.reject(call);
        case "expire_held":
          return this.expireHeld(call);
        default:
          throw new FakeRawPanic(
            `FAKE_UNSUPPORTED: the fake vault does not model \`${call.method}\``,
          );
      }
    } finally {
      this.refreshStatuses();
    }
  }

  /** v2: the contract derives MandateStatus from state, so it is refreshed after every change. */
  private refreshStatuses(): void {
    for (const m of this.mandates) m.status = deriveStatus(m);
  }

  /** near-sdk refuses an attached deposit on a method that is not `#[payable]` before it runs the method. */
  private assertNotPayable(call: FakeCall): void {
    if (call.deposit !== 0n) throw new FakeRawPanic(`Method ${call.method} doesn't accept deposit`);
  }

  private assertApprover(call: FakeCall): void {
    if (!this.config.approvers.includes(call.signerId)) throw new FakePanic("NotApprover"); // held.rs:72-76
  }

  private assertOneYocto(call: FakeCall): void {
    if (call.deposit !== 1n) throw new FakePanic("RequiresOneYocto"); // errors.rs:471
  }

  /** execute_payout refuses an Intents payee whose asset left the allow-list (spend.rs:130-134). Checked up front: the call reverts anyway. */
  private assertPayable(m: MandateView): void {
    if (m.payee.type === "intents" && !this.config.allowed_assets.includes(m.payee.asset)) {
      throw new FakePanic("AssetNotAllowed");
    }
  }

  private spendRecord(spendId: bigint): SpendView | undefined {
    return this.spends.find((s) => BigInt(s.id) === spendId);
  }

  private heldSpend(spendId: bigint): SpendView {
    const found = this.spendRecord(spendId);
    if (found === undefined || found.status !== "held") throw new FakePanic("NotHeld"); // held.rs:78-83
    return found;
  }

  private mandateOfSpend(spend: SpendView): MandateView {
    const m = this.mandate(BigInt(spend.mandate_id));
    if (m === undefined) throw new FakePanic("NoMandate");
    return m;
  }

  private spend(call: FakeCall): FakeCallResult {
    this.assertNotPayable(call);
    const req = parseRequest(call.args.request);
    if (call.signerId !== this.vaultId) throw new FakePanic("NotAgent"); // spend.rs:13
    if (this.hooks.spendPanic !== null) throw new FakePanic(this.hooks.spendPanic);
    const now = this.nowNs();
    const verdict = this.evaluate(req, call.signerPk, now);
    if (verdict.code !== null) throw new FakePanic(verdict.code);
    const m = this.mandate(req.mandateId);
    if (m === undefined) throw new FakePanic("NoMandate");
    if (!verdict.hold) this.assertPayable(m);
    const spend = this.reserve(req, m, call.signerPk, now, verdict.hold);
    const vaultLogs: string[] = [];
    if (verdict.hold) {
      // held.rs:55-70
      vaultLogs.push(
        probarion("spend_held", {
          spend_id: spend.id,
          mandate_id: spend.mandate_id,
          amount: spend.amount,
          invoice_hash: spend.invoice_hash,
          decision_hash: spend.decision_hash,
          held_until_ns: spend.held_until_ns,
        }),
      );
      return {
        value: { spend_id: spend.id, status: "held" } satisfies SpendResult,
        vaultLogs,
        receipts: [],
      };
    }
    const payout = this.executePayout(spend, m, vaultLogs);
    return { value: payout.result, vaultLogs, receipts: payout.receipts };
  }

  /** spend.rs:74-113: reserves before anything is sent: a use, the amount, today's backstop share, the invoice, the ref. */
  private reserve(
    req: ParsedRequest,
    m: MandateView,
    signerPk: string,
    now: bigint,
    hold: boolean,
  ): SpendView {
    const id = this.spends.length + 1; // v2: ids start at 1
    m.reserved = (BigInt(m.reserved) + req.amount).toString();
    m.uses += 1;
    const spend: SpendView = {
      id,
      mandate_id: m.id,
      amount: req.amount.toString(),
      invoice_hash: req.invoiceHash,
      ref: req.ref,
      decision_hash: req.decisionHash,
      agent_pk: signerPk,
      destination: m.payee,
      status: hold ? "held" : "pending",
      created_at_ns: now.toString(),
      held_until_ns: hold ? (now + BigInt(this.config.held_ttl_ns)).toString() : null,
      memo: withdrawMemo(m.payee),
    };
    this.spends.push(spend);
    return spend;
  }

  /** How the payout fails, or null when it goes through. */
  private payoutFailure(
    m: MandateView,
    amount: bigint,
  ): { step: PayoutFailure; text: string } | null {
    const hooked = this.hooks.payoutFailure;
    if (hooked !== null) return { step: hooked, text: `TEST DOUBLE: ${hooked}` };
    if (m.payee.type === "intents") {
      const balance = BigInt(this.intents.balances[`nep141:${m.payee.asset}`] ?? "0");
      // intents-stub `debit` (contracts/intents-stub/src/lib.rs): require!(current >= amount, "insufficient balance")
      if (balance < amount)
        return { step: "ft_withdraw_failed", text: "intents-stub: insufficient balance" };
    }
    return null;
  }

  /**
   * spend.rs:118-163 and the callbacks :30-54, :165-233, run to completion. The payout receipts and the
   * callback receipt are returned; the vault's own logs gain `spend_submitted`.
   */
  private executePayout(
    spend: SpendView,
    m: MandateView,
    vaultLogs: string[],
  ): { result: SpendResult; receipts: FakeReceipt[] } {
    if (spend.status !== "held" && spend.status !== "pending") throw new FakePanic("InvalidInput");
    const payee = m.payee;
    const amount = BigInt(spend.amount);
    spend.status = "pending";
    vaultLogs.push(
      probarion("spend_submitted", {
        spend_id: spend.id,
        mandate_id: spend.mandate_id,
        amount: spend.amount,
        invoice_hash: spend.invoice_hash,
        decision_hash: spend.decision_hash,
        destination: payee,
      }),
    );
    const failure = this.payoutFailure(m, amount);
    const receipts: FakeReceipt[] = [];
    if (payee.type === "near") {
      if (failure === null) {
        receipts.push({
          executor: this.config.usdc,
          logs: [
            nep141("ft_transfer", [
              {
                old_owner_id: this.vaultId,
                new_owner_id: payee.account_id,
                amount: spend.amount,
                memo: `${NEAR_MEMO_PREFIX}${spend.id}`,
              },
            ]),
          ],
        });
      } else {
        receipts.push({ executor: this.config.usdc, logs: [], failure: failure.text });
      }
    } else if (failure === null) {
      const token = `nep141:${payee.asset}`;
      this.intents.balances[token] = (
        BigInt(this.intents.balances[token] ?? "0") - amount
      ).toString();
      const mtBurn = nep245("mt_burn", [
        { owner_id: this.vaultId, token_ids: [token], amounts: [spend.amount], memo: "withdraw" },
      ]);
      const ftBurn = nep141("ft_burn", [
        {
          owner_id: this.config.intents,
          amount: spend.amount,
          memo: `${WITHDRAW_MEMO_PREFIX}${payee.address}`,
        },
      ]);
      if (this.burnShape === "stub") {
        receipts.push({
          executor: this.config.intents,
          logs: [mtBurn, ftBurn],
          value: spend.amount,
        });
      } else {
        receipts.push({ executor: this.config.intents, logs: [mtBurn] });
        receipts.push({ executor: payee.asset, logs: [ftBurn] });
      }
    } else if (failure.step === "ft_withdraw_refunded") {
      receipts.push({ executor: this.config.intents, logs: [], value: "0" }); // spend.rs:48: a resolved 0 releases
    } else {
      receipts.push({ executor: this.config.intents, logs: [], failure: failure.text });
    }

    if (failure === null) {
      const status: SpendStatus = payee.type === "near" ? "paid" : "burned";
      const log = this.settle(spend, m, status);
      const result: SpendResult = { spend_id: spend.id, status };
      receipts.push({ executor: this.vaultId, logs: [log], value: result });
      return { result, receipts };
    }
    const reason =
      payee.type === "near"
        ? "ft_transfer_failed"
        : failure.step === "ft_withdraw_refunded"
          ? "ft_withdraw_refunded"
          : "ft_withdraw_failed";
    this.release(spend, m, "failed");
    const result: SpendResult = { spend_id: spend.id, status: "failed" };
    receipts.push({
      executor: this.vaultId,
      logs: [
        probarion("spend_failed", {
          spend_id: spend.id,
          mandate_id: spend.mandate_id,
          amount: spend.amount,
          reason,
        }),
      ],
      value: result,
    });
    return { result, receipts };
  }

  /** spend.rs:165-211: the reservation becomes spent, the status settles, the event names it. */
  private settle(spend: SpendView, m: MandateView, status: "paid" | "burned"): string {
    const amount = BigInt(spend.amount);
    m.reserved = (BigInt(m.reserved) - amount).toString();
    m.spent = (BigInt(m.spent) + amount).toString();
    spend.status = status;
    const payee = m.payee;
    if (status === "burned" && payee.type === "intents") {
      return probarion("spend_burned", {
        spend_id: spend.id,
        mandate_id: spend.mandate_id,
        amount: spend.amount,
        chain: payee.chain,
        address: payee.address,
        asset: payee.asset,
        memo: `${WITHDRAW_MEMO_PREFIX}${payee.address}`,
      });
    }
    return probarion("spend_paid", {
      spend_id: spend.id,
      mandate_id: spend.mandate_id,
      amount: spend.amount,
      destination: payee,
    });
  }

  /**
   * spend.rs:239-257: gives back the reservation and the use. The invoice and the backstop share come
   * back because a released spend is no longer counted (derived from `status`); the ref stays consumed.
   */
  private release(
    spend: SpendView,
    m: MandateView,
    status: "failed" | "rejected" | "expired",
  ): void {
    if (spend.status !== "held" && spend.status !== "pending") throw new FakePanic("InvalidInput");
    m.reserved = (BigInt(m.reserved) - BigInt(spend.amount)).toString();
    m.uses -= 1;
    spend.status = status;
  }

  private approve(call: FakeCall): FakeCallResult {
    const spendId = u64Arg(call.args, "spend_id");
    this.assertApprover(call);
    this.assertOneYocto(call);
    if (this.config.frozen) throw new FakePanic("Frozen");
    const spend = this.heldSpend(spendId);
    if (this.nowNs() > BigInt(spend.held_until_ns ?? "0")) throw new FakePanic("HoldExpired"); // held.rs:16
    const m = this.mandate(BigInt(spend.mandate_id));
    if (m === undefined || m.status === "revoked") throw new FakePanic("MandateInactive"); // held.rs:19
    this.assertPayable(m);
    const vaultLogs = [probarion("spend_approved", { spend_id: spend.id, by: call.signerId })];
    const payout = this.executePayout(spend, m, vaultLogs);
    return { value: payout.result, vaultLogs, receipts: payout.receipts };
  }

  private reject(call: FakeCall): FakeCallResult {
    const spendId = u64Arg(call.args, "spend_id");
    this.assertApprover(call);
    this.assertOneYocto(call);
    const spend = this.heldSpend(spendId);
    this.release(spend, this.mandateOfSpend(spend), "rejected");
    return {
      value: undefined,
      vaultLogs: [probarion("spend_rejected", { spend_id: spend.id, by: call.signerId })],
      receipts: [],
    };
  }

  private expireHeld(call: FakeCall): FakeCallResult {
    this.assertNotPayable(call);
    const spendId = u64Arg(call.args, "spend_id");
    const spend = this.heldSpend(spendId);
    const heldUntil = spend.held_until_ns === null ? U128_MAX : BigInt(spend.held_until_ns);
    if (this.nowNs() <= heldUntil) throw new FakePanic("HoldNotExpired"); // held.rs:45
    this.release(spend, this.mandateOfSpend(spend), "expired");
    return {
      value: undefined,
      vaultLogs: [probarion("spend_expired", { spend_id: spend.id })],
      receipts: [],
    };
  }

  /** anchors.rs:8-33. Only the vault-signed call with the current ledger key may anchor, in order: key, seq, shape. */
  private anchor(call: FakeCall): FakeCallResult {
    this.assertNotPayable(call);
    const seq = u64Arg(call.args, "seq");
    const root = stringArg(call.args, "root");
    const count = u64Arg(call.args, "count");
    const byLedgerKey = call.signerId === this.vaultId && this.config.ledger_key === call.signerPk;
    if (!byLedgerKey) throw new FakePanic("NotLedgerKey");
    if (seq !== BigInt(this.anchors.length) + 1n) throw new FakePanic("BadSeq");
    const previous = BigInt(this.anchors.at(-1)?.count ?? 0);
    if (!HEX64.test(root) || count === 0n || count < previous) throw new FakePanic("InvalidInput");
    // The signing key is stored with the anchor so a later rotation keeps the range verifiable.
    this.anchors.push({
      seq: Number(seq),
      root,
      count: Number(count),
      at_ns: this.nowNs().toString(),
      ledger_key: call.signerPk,
    });
    return {
      value: undefined,
      vaultLogs: [probarion("ledger_anchored", { seq: Number(seq), root, count: Number(count) })],
      receipts: [],
    };
  }
}
