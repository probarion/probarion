/** Every SQL entry point is `public.<fn>(p jsonb) returns jsonb` (Decision D2). */
export interface Db {
  rpc<T>(fn: string, p?: Record<string, unknown>): Promise<T>;
}

/** Postgres' own messages that carry a code of ours: [the start of the message, the code]. */
const NATIVE: readonly (readonly [string, string])[] = [
  ["permission denied", "permission_denied"],
  ["duplicate", "duplicate"],
];

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
  // Our own functions raise `<code>` or `<code>: detail`, with the code first. Read it as a PREFIX, never as a
  // substring: the detail can hold text a caller chose (a vault named "ledger_conflict.near" in "invalid_input: the
  // entry is for vault ledger_conflict.near ..."), and that must not become the code.
  const coded = /^([a-z_]+)(:|$)/.exec(msg);
  if (coded?.[1] !== undefined) {
    return coded[1] === msg ? new DbError(coded[1]) : new DbError(coded[1], msg);
  }
  // Postgres' own wording (`permission denied for ...`, `duplicate key value violates ...`), again from the start.
  const known = NATIVE.find(([phrase]) => msg.startsWith(phrase));
  return new DbError(known ? known[1] : "db_error", msg);
}
