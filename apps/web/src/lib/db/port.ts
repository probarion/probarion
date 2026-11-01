/** Every SQL entry point is `public.<fn>(p jsonb) returns jsonb` (Decision D2). */
export interface Db {
  rpc<T>(fn: string, p?: Record<string, unknown>): Promise<T>;
}

const KNOWN_CODES = [
  "ledger_conflict",
  "ledger_append_only",
  "invalid_input",
  "owner_mismatch",
  "not_found",
  "duplicate",
  "permission denied",
] as const;

export class DbError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "DbError";
  }
}

export function toDbError(e: unknown): DbError {
  if (e instanceof DbError) return e;
  // String(undefined) and String(null) are bare lowercase words, which the rule below would take for a code.
  const msg =
    e === undefined || e === null
      ? "unknown database error"
      : e instanceof Error
        ? e.message
        : typeof e === "object" && "message" in e
          ? String((e as { message: unknown }).message)
          : String(e);
  if (/^[a-z_]+$/.test(msg)) return new DbError(msg);
  const known = KNOWN_CODES.find((c) => msg.includes(c));
  return new DbError(known ? known.replace(" ", "_") : "db_error", msg);
}
