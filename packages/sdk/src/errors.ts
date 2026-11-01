import { VAULT_ERROR_CODES, type VaultErrorCode } from "@probarion/core";

export class ProbarionError extends Error {
  override name = "ProbarionError";
  readonly code: string;
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

/** One failed try against one endpoint. `url` is the origin only, so API keys in a path or query never reach logs. */
export interface RpcAttempt {
  url: string;
  error: string;
}

/**
 * A transport failure or a JSON-RPC error. `rpcError` is the raw JSON-RPC error object and is set
 * only for a JSON-RPC error answer; transport failures (network, HTTP status, exhausted failover)
 * leave it `null`. `cause` is the last underlying error when failover gave up.
 */
export class RpcError extends ProbarionError {
  override name = "RpcError";
  readonly attempts: readonly RpcAttempt[];
  readonly rpcError: unknown;
  constructor(
    message: string,
    attempts: readonly RpcAttempt[] = [],
    rpcError: unknown = null,
    options?: ErrorOptions,
  ) {
    super(message, "RpcError", options);
    this.attempts = attempts;
    this.rpcError = rpcError;
  }
}

/** Extra context a `ViewError` carries over from the `RpcError` it was built from. */
export interface ViewErrorContext {
  attempts?: readonly RpcAttempt[];
  rpcError?: unknown;
  cause?: unknown;
}

export class ViewError extends RpcError {
  override name = "ViewError";
  readonly contractId: string;
  readonly methodName: string;
  readonly probarionCode: VaultErrorCode | null;
  constructor(
    contractId: string,
    methodName: string,
    detail: string,
    context: ViewErrorContext = {},
  ) {
    super(
      `view ${contractId}.${methodName} failed: ${detail}`,
      context.attempts ?? [],
      context.rpcError ?? null,
      context.cause === undefined ? undefined : { cause: context.cause },
    );
    this.contractId = contractId;
    this.methodName = methodName;
    this.probarionCode = extractProbarionCode(detail);
  }
}

export class ContractError extends ProbarionError {
  override name = "ContractError";
  readonly vaultCode: VaultErrorCode | null;
  readonly txHash: string | null;
  constructor(vaultCode: VaultErrorCode | null, txHash: string | null, detail: string) {
    super(
      vaultCode === null ? `transaction failed: ${detail}` : `PROBARION:${vaultCode}`,
      vaultCode ?? "TxFailed",
    );
    this.vaultCode = vaultCode;
    this.txHash = txHash;
  }
}

export class ConfigError extends ProbarionError {
  override name = "ConfigError";
  constructor(message: string) {
    super(message, "ConfigError");
  }
}

export class NearAiError extends ProbarionError {
  override name = "NearAiError";
  constructor(message: string) {
    super(message, "NearAiError");
  }
}

export class LedgerError extends ProbarionError {
  override name = "LedgerError";
  constructor(message: string) {
    super(message, "LedgerError");
  }
}

const FLATTEN_MAX_DEPTH = 16;

/**
 * Collect every string an error or RPC failure carries (messages, nested objects, causes) into one
 * text. Cycles (`e.cause = e`) are cut with a WeakSet and nesting is capped, so a hostile or
 * self-referencing value can neither overflow the stack nor hang the caller.
 */
function collectStrings(value: unknown, seen: WeakSet<object>, depth: number, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (typeof value === "bigint") {
    out.push(value.toString());
    return;
  }
  if (typeof value !== "object" || value === null || depth > FLATTEN_MAX_DEPTH) return;
  if (seen.has(value)) return;
  seen.add(value);
  if (value instanceof Error) {
    out.push(value.message);
    const { cause } = value as { cause?: unknown };
    if (cause !== undefined) collectStrings(cause, seen, depth + 1, out);
    const { errors } = value as { errors?: unknown };
    if (Array.isArray(errors)) collectStrings(errors, seen, depth + 1, out);
  }
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    collectStrings(item, seen, depth + 1, out);
  }
}

function flatten(value: unknown): string {
  const out: string[] = [];
  collectStrings(value, new WeakSet<object>(), 0, out);
  return out.join(" ");
}

const CODE_RE = /PROBARION:([A-Za-z]+)/;
const KNOWN_CODES: ReadonlySet<string> = new Set(VAULT_ERROR_CODES);

/** Pull the contract's `PROBARION:<Code>` panic out of a string, an Error or a nested RPC failure. */
export function extractProbarionCode(value: unknown): VaultErrorCode | null {
  const match = CODE_RE.exec(flatten(value));
  const code = match?.[1];
  return code !== undefined && KNOWN_CODES.has(code) ? (code as VaultErrorCode) : null;
}

/** True when `code` is one of the contract's panic codes (core's `VAULT_ERROR_CODES`). */
export function isVaultErrorCode(code: unknown): code is VaultErrorCode {
  return typeof code === "string" && KNOWN_CODES.has(code);
}

/**
 * `check_spend` reports codes with or without the `PROBARION:` prefix; return the bare code.
 * The result is any string the contract sent, not necessarily a known code: callers must check it
 * with `isVaultErrorCode` before treating it as a `VaultErrorCode`.
 */
export function normalizeVaultCode(code: string | null): string | null {
  if (code === null) return null;
  return code.startsWith("PROBARION:") ? code.slice("PROBARION:".length) : code;
}
