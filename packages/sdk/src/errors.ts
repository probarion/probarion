import { VAULT_ERROR_CODES, type VaultErrorCode } from "@probarion/core";

export class ProbarionError extends Error {
  override name = "ProbarionError";
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export interface RpcAttempt {
  url: string;
  error: string;
}

export class RpcError extends ProbarionError {
  override name = "RpcError";
  readonly attempts: readonly RpcAttempt[];
  readonly rpcError: unknown;
  constructor(message: string, attempts: readonly RpcAttempt[] = [], rpcError: unknown = null) {
    super(message, "RpcError");
    this.attempts = attempts;
    this.rpcError = rpcError;
  }
}

export class ViewError extends RpcError {
  override name = "ViewError";
  readonly contractId: string;
  readonly methodName: string;
  readonly probarionCode: VaultErrorCode | null;
  constructor(contractId: string, methodName: string, detail: string) {
    super(`view ${contractId}.${methodName} failed: ${detail}`);
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

function flatten(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) {
    const cause = (value as { cause?: unknown }).cause;
    return `${value.message} ${flatten({ ...value })} ${cause === undefined ? "" : flatten(cause)}`;
  }
  try {
    return (
      JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v)) ??
      String(value)
    );
  } catch {
    return String(value);
  }
}

const CODE_RE = /PROBARION:([A-Za-z]+)/;
const KNOWN_CODES: ReadonlySet<string> = new Set(VAULT_ERROR_CODES);

/** Pull the contract's `PROBARION:<Code>` panic out of a string, an Error or a nested RPC failure. */
export function extractProbarionCode(value: unknown): VaultErrorCode | null {
  const match = CODE_RE.exec(flatten(value));
  const code = match?.[1];
  return code !== undefined && KNOWN_CODES.has(code) ? (code as VaultErrorCode) : null;
}

/** `check_spend` reports codes with or without the `PROBARION:` prefix; return the bare code. */
export function normalizeVaultCode(code: string | null): string | null {
  if (code === null) return null;
  return code.startsWith("PROBARION:") ? code.slice("PROBARION:".length) : code;
}
