import { describe, expect, it } from "vitest";
import { DbError, toDbError } from "./port";

describe("toDbError", () => {
  it("passes a DbError through unchanged", () => {
    const e = new DbError("owner_mismatch");
    expect(toDbError(e)).toBe(e);
  });

  it("uses a bare snake_case message as the code (raise exception 'invalid_input')", () => {
    expect(toDbError(new Error("invalid_input"))).toMatchObject({
      code: "invalid_input",
      message: "invalid_input",
    });
    expect(toDbError({ message: "not_found", code: "P0001" })).toMatchObject({
      code: "not_found",
    });
  });

  it("reads a code only as a prefix, `<code>: detail`, and keeps the whole message", () => {
    const e = toDbError(new Error("ledger_conflict: the head gives seq 3 on prev_link 00"));
    expect(e.code).toBe("ledger_conflict");
    expect(e.message).toBe("ledger_conflict: the head gives seq 3 on prev_link 00");
    expect(
      toDbError(new Error("invalid_input: the entry is not at the position it expects")).code,
    ).toBe("invalid_input");
  });

  it("recognises Postgres' own wording from the start of the message", () => {
    expect(toDbError(new Error("permission denied for function rate_limit_take")).code).toBe(
      "permission_denied",
    );
    expect(toDbError(new Error('duplicate key value violates unique constraint "x"')).code).toBe(
      "duplicate",
    );
  });

  it("never takes a code from the middle of a message, so caller data cannot pick the code", () => {
    // A vault is named by the caller. It must not turn an invalid_input into a ledger_conflict.
    const refused = toDbError(
      new Error(
        "invalid_input: the entry is for vault ledger_conflict.near, not the tenant's vault x.near",
      ),
    );
    expect(refused.code).toBe("invalid_input");
    for (const msg of [
      "ERROR: ledger_conflict at seq 3",
      "connection to ledger_conflict.near failed",
      'invalid input syntax for type uuid: "duplicate"',
      "the permission denied word in the middle",
      "Ledger_conflict: wrong case",
      "ledger conflict: not snake_case",
    ]) {
      expect(toDbError(new Error(msg)), msg).toMatchObject({ code: "db_error", message: msg });
    }
  });

  it("falls back to db_error and keeps the text, for errors, objects and bare values", () => {
    expect(toDbError(new Error("connection reset"))).toMatchObject({
      code: "db_error",
      message: "connection reset",
    });
    expect(toDbError({ message: "Boom: 42" }).code).toBe("db_error");
    expect(toDbError("plain text").code).toBe("db_error");
    expect(toDbError(undefined).code).toBe("db_error");
    expect(toDbError(null).code).toBe("db_error");
  });

  it("is an Error with a stable name", () => {
    const e = toDbError(new Error("nope!"));
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("DbError");
  });
});
