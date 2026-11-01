import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../proof.js";

const NOW = new Date("2026-11-04T10:00:00.000Z");
const HASH = "8qkFz1q7mJpQd9wZ3yX4hT6uV2bN5cR1sE7gK3aL9mP";
const HASH2 = "5Rk2nWdQ8vYbT3gH7jL4mN9pS6uX1zA2cE5fG8hJ3kM";

let logs: string[];
let errors: string[];

beforeEach(() => {
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const freshPath = () => join(mkdtempSync(join(tmpdir(), "proof-")), "mainnet-proof.json");

function initialised(): string {
  const path = freshPath();
  expect(main(["init"], NOW, path)).toBe(0);
  return path;
}

const read = (path: string) => readFileSync(path, "utf8");

function addTxArgs(over: Record<string, string> = {}): string[] {
  const flags: Record<string, string> = {
    id: "first_near_payment",
    hash: HASH,
    signer: "v0.probarion.near",
    receiver: "v0.probarion.near",
    kind: "near_payment",
    "signed-by": "agent_key",
    what: "First NEAR payment",
    "spend-id": "1",
    amount: "2.00",
    ...over,
  };
  return ["add-tx", ...Object.entries(flags).flatMap(([k, v]) => [`--${k}`, v])];
}

const setArgs = (key: string, value: string, ...extra: string[]) => [
  "set",
  key,
  value,
  "--source",
  "pnpm count:external",
  ...extra,
];

describe("pnpm proof", () => {
  it("init, add-tx, set and show work on a fresh file", () => {
    const path = freshPath();
    expect(main(["init"], NOW, path)).toBe(0);
    expect(main(["init"], NOW, path)).toBe(1);
    expect(errors.join("\n")).toMatch(/already exists/);
    expect(main(addTxArgs(), NOW, path)).toBe(0);
    expect(main(setArgs("metrics.external_owners", "2", "--type", "number"), NOW, path)).toBe(0);
    expect(main(["show"], NOW, path)).toBe(0);
    expect(logs.join("\n")).toMatch(/first_near_payment .*mainnet .*success .*First NEAR payment/);
    expect(logs).toContain("metrics.external_owners = 2");
    const saved = JSON.parse(read(path));
    expect(saved.txs.first_near_payment.spend_id).toBe(1);
    expect(saved.metrics.external_owners).toBe(2);
  });

  it("exits 2 with usage when required flags are missing", () => {
    const path = initialised();
    expect(main(["add-tx", "--id", "x_tx"], NOW, path)).toBe(2);
    expect(main(["set", "metrics.n", "1"], NOW, path)).toBe(2);
    expect(main(["bogus"], NOW, path)).toBe(2);
    expect(errors.join("\n")).toMatch(/usage:/);
  });

  describe("a refused add-tx leaves the file byte-identical", () => {
    it("exits 1 for a duplicate id, then for a duplicate hash", () => {
      const path = initialised();
      expect(main(addTxArgs(), NOW, path)).toBe(0);
      const before = read(path);

      expect(main(addTxArgs({ hash: HASH2 }), NOW, path)).toBe(1); // same id, new hash
      expect(errors.join("\n")).toMatch(/txs\.first_near_payment already exists/);
      expect(read(path)).toBe(before);

      errors.length = 0;
      expect(main(addTxArgs({ id: "second_payment" }), NOW, path)).toBe(1); // new id, same hash
      expect(errors.join("\n")).toMatch(/hash already recorded as txs\.first_near_payment/);
      expect(read(path)).toBe(before);
    });

    it("exits 1 for an unknown kind and 2 for a malformed --spend-id", () => {
      const path = initialised();
      const before = read(path);
      expect(main(addTxArgs({ kind: "teleport" }), NOW, path)).toBe(1);
      for (const bad of ["", "1.5", "abc", "1e2", " 1", "0x1", "99999999999999999999"]) {
        errors.length = 0;
        expect(main(addTxArgs({ "spend-id": bad }), NOW, path), `--spend-id "${bad}"`).toBe(2);
        expect(errors.join("\n")).toMatch(/--spend-id must be a non-negative integer/);
      }
      expect(main(addTxArgs().concat("--spend-id=-1"), NOW, path)).toBe(2);
      expect(read(path)).toBe(before);
    });

    it("never turns an empty --spend-id into 0", () => {
      const path = initialised();
      expect(main(addTxArgs({ "spend-id": "" }), NOW, path)).toBe(2);
      expect(JSON.parse(read(path)).txs).toEqual({});
    });
  });

  describe("set", () => {
    it("--type boolean takes true or false and nothing else", () => {
      const path = initialised();
      expect(main(setArgs("verify.all_green", "true", "--type", "boolean"), NOW, path)).toBe(0);
      expect(JSON.parse(read(path)).verify.all_green).toBe(true);
      expect(main(setArgs("verify.all_green", "false", "--type", "boolean"), NOW, path)).toBe(0);
      expect(JSON.parse(read(path)).verify.all_green).toBe(false);
      const before = read(path);
      expect(main(setArgs("verify.all_green", "yes", "--type", "boolean"), NOW, path)).toBe(2);
      expect(errors.join("\n")).toMatch(/a boolean must be true or false/);
      expect(read(path)).toBe(before);
    });

    it("--type bogus is an error and writes nothing", () => {
      const path = initialised();
      const before = read(path);
      expect(main(setArgs("metrics.external_owners", "2", "--type", "bogus"), NOW, path)).toBe(2);
      expect(errors.join("\n")).toMatch(/--type must be string, number or boolean/);
      expect(read(path)).toBe(before);
    });

    it("--type number is strict: digits, an optional minus and decimals, never '' as 0", () => {
      const path = initialised();
      const before = read(path);
      const bad = ["", " ", "1e3", " 5", "5 ", "0x10", "-", "1,5", "NaN", "Infinity", "5.", ".5"];
      for (const value of bad) {
        errors.length = 0;
        const code = main(setArgs("metrics.external_owners", value, "--type", "number"), NOW, path);
        expect(code, `value "${value}"`).toBe(2);
        expect(errors.join("\n")).toMatch(/not a number/);
      }
      expect(read(path)).toBe(before);

      for (const [value, expected] of [
        ["0", 0],
        ["42", 42],
        ["2.50", 2.5],
        ["-3.5", -3.5],
      ] as const) {
        // "--" so that a leading minus is a value, not a flag
        const argv = [
          "set",
          "metrics.delta_count",
          "--source",
          "test",
          "--type",
          "number",
          "--",
          value,
        ];
        expect(main(argv, NOW, path), `value "${value}"`).toBe(0);
        expect(JSON.parse(read(path)).metrics.delta_count).toBe(expected);
      }
    });

    it("keeps its upsert semantics and says what it replaced", () => {
      const path = initialised();
      expect(main(setArgs("metrics.external_owners", "2", "--type", "number"), NOW, path)).toBe(0);
      expect(logs).toContain("set metrics.external_owners = 2");
      expect(logs.join("\n")).not.toMatch(/was/);

      logs.length = 0;
      expect(main(setArgs("metrics.external_owners", "3", "--type", "number"), NOW, path)).toBe(0);
      expect(logs).toEqual(["set metrics.external_owners = 3 (was 2)"]);
      const saved = JSON.parse(read(path));
      expect(saved.metrics.external_owners).toBe(3);
      expect(saved.sources["metrics.external_owners"]).toBe("pnpm count:external");

      logs.length = 0;
      expect(main(["set", "facts.factory_mode", "embedded", "--source", "s1"], NOW, path)).toBe(0);
      expect(
        main(["set", "facts.factory_mode", "global contract by hash", "--source", "s2"], NOW, path),
      ).toBe(0);
      expect(logs).toEqual([
        "set facts.factory_mode = embedded",
        "set facts.factory_mode = global contract by hash (was embedded)",
      ]);
      expect(JSON.parse(read(path)).sources["facts.factory_mode"]).toBe("s2");
    });
  });
});
