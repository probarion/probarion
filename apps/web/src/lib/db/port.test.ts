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

  it("recognises known codes inside longer messages", () => {
    expect(toDbError(new Error("permission denied for function rate_limit_take")).code).toBe(
      "permission_denied",
    );
    expect(toDbError(new Error('duplicate key value violates unique constraint "x"')).code).toBe(
      "duplicate",
    );
    expect(toDbError(new Error("ERROR: ledger_conflict at seq 3")).code).toBe("ledger_conflict");
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
