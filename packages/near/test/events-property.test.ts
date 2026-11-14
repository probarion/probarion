import { describe, expect, it } from "vitest";
import { EVENT_JSON_PREFIX, ftDeltas, nep141Events, parseEventLog } from "../src/events.js";
import type { OutcomeLike } from "../src/types.js";
import { mulberry32 } from "./helpers/prng.js";

// Seeded properties (mulberry32): a failing case names its seed and run, so it reproduces exactly.
const SEED = 0x297e_7e17;
const RUNS = 500;

type Next = () => number;

const int = (next: Next, n: number) => Math.floor(next() * n);
const pick = <T>(next: Next, items: readonly T[]): T => items[int(next, items.length)] as T;

function randomString(next: Next, alphabet: string, max: number): string {
  let out = "";
  const length = int(next, max + 1);
  for (let i = 0; i < length; i++) out += alphabet[int(next, alphabet.length)];
  return out;
}

const WORD = "abcdefghijklmnopqrstuvwxyz0123456789_";
const TEXT = `${WORD} é中\u{1f600}"\\/\n\t{}[]:,`;

function randomJson(next: Next, depth: number): unknown {
  const kind = int(next, depth > 0 ? 7 : 5);
  switch (kind) {
    case 0:
      return null;
    case 1:
      return next() < 0.5;
    case 2:
      return int(next, 2_000_000) - 1_000_000;
    case 3:
    case 4:
      return randomString(next, TEXT, 12);
    case 5:
      return Array.from({ length: int(next, 4) }, () => randomJson(next, depth - 1));
    default:
      return Object.fromEntries(
        Array.from({ length: int(next, 4) }, () => [
          randomString(next, WORD, 6),
          randomJson(next, depth - 1),
        ]),
      );
  }
}

/** The oracle: what NEP-297 says the log is, written independently of parseEventLog. */
function oracle(log: string): "event" | "malformed" | "plain" {
  if (log.slice(0, EVENT_JSON_PREFIX.length) !== EVENT_JSON_PREFIX) return "plain";
  let value: unknown;
  try {
    value = JSON.parse(log.substring(EVENT_JSON_PREFIX.length));
  } catch {
    return "malformed";
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "malformed";
  const record = value as Record<string, unknown>;
  const ok = ["standard", "version", "event"].every(
    (field) => typeof record[field] === "string" && (record[field] as string) !== "",
  );
  return ok ? "event" : "malformed";
}

describe("parseEventLog (seeded properties)", () => {
  it("round-trips random valid events, with or without data and extra fields", () => {
    const next = mulberry32(SEED);
    for (let run = 0; run < RUNS; run++) {
      const body: Record<string, unknown> = {
        standard: `s${randomString(next, WORD, 10)}`,
        version: `${int(next, 3)}.${int(next, 20)}.${int(next, 20)}`,
        event: `e${randomString(next, TEXT, 10)}`,
      };
      if (next() < 0.8) body.data = randomJson(next, 3);
      const extra =
        next() < 0.3 ? { [`x${randomString(next, WORD, 5)}`]: randomJson(next, 2) } : {};
      const log = `${EVENT_JSON_PREFIX}${JSON.stringify({ ...extra, ...body })}`;
      const parsed = parseEventLog(log);
      expect(parsed, `seed ${SEED} run ${run}`).toEqual({
        kind: "event",
        event: JSON.parse(JSON.stringify(body)),
      });
    }
  });

  it("never throws on random text after the prefix, and agrees with an independent oracle", () => {
    const next = mulberry32(SEED + 1);
    const pieces = [
      '{"standard":"a","version":"1.0.0","event":"e"',
      '"data":',
      "[",
      "]",
      "{",
      "}",
      ",",
      "null",
      '"x"',
    ];
    const seen = new Set<string>();
    for (let run = 0; run < RUNS * 2; run++) {
      let rest = "";
      const count = int(next, 8);
      for (let i = 0; i < count; i++)
        rest += next() < 0.5 ? pick(next, pieces) : randomString(next, TEXT, 4);
      const log = `${EVENT_JSON_PREFIX}${rest}`;
      let parsed: ReturnType<typeof parseEventLog> | undefined;
      expect(
        () => {
          parsed = parseEventLog(log);
        },
        `seed ${SEED + 1} run ${run}`,
      ).not.toThrow();
      expect(parsed?.kind, `seed ${SEED + 1} run ${run}: ${JSON.stringify(log)}`).toBe(oracle(log));
      seen.add(String(parsed?.kind));
    }
    expect(seen).toEqual(new Set(["event", "malformed"]));
  });

  it("calls any text without the exact prefix plain", () => {
    const next = mulberry32(SEED + 2);
    for (let run = 0; run < RUNS; run++) {
      const log = `${pick(next, ["", " ", "event_json:", "EVENT_JSON", "EVENT-JSON:", "x"])}${randomString(next, TEXT, 30)}`;
      if (log.startsWith(EVENT_JSON_PREFIX)) continue;
      expect(parseEventLog(log), `seed ${SEED + 2} run ${run}`).toEqual({ kind: "plain" });
    }
  });

  it("reports a deeply nested value as a problem instead of overflowing the stack", () => {
    // Built as text. A NEAR log is at most 16 KB (about 8000 levels of `[`); 20000 levels go past that bound.
    const deep = `${"[".repeat(20_000)}"1"${"]".repeat(20_000)}`;
    const log = `${EVENT_JSON_PREFIX}{"standard":"nep141","version":"1.0.0","event":"ft_mint","data":[{"owner_id":"a.near","amount":${deep},"memo":${deep}}]}`;
    const source = {
      receipts_outcome: [
        {
          id: "deep",
          outcome: { executor_id: "ft.near", logs: [log], status: { SuccessValue: "" } },
        },
      ],
    };
    expect(nep141Events(source, "ft.near").problems.map((p) => p.problem)).toEqual([
      "bad_item: ft_mint item 0: amount a list of 1 is not a canonical U128 decimal string",
    ]);
  });
});

describe("ftDeltas (seeded property)", () => {
  // Synthetic trees (labelled): random nep141 events from the token and from another account, in receipts that
  // succeeded, failed or carry no status. The oracle replays the token's successful events on a plain ledger.
  const FT = "ft.test.near";
  const ACCOUNTS = ["alice.near", "bob.near", "carol.near", "dave.near"] as const;
  const STATUSES = [
    { SuccessValue: "" },
    { Failure: { ActionError: { index: 0 } } },
    undefined,
  ] as const;

  it("equals a ledger replay of the token's successful events, and conserves mint minus burn", () => {
    const next = mulberry32(SEED + 3);
    for (let run = 0; run < 300; run++) {
      const receipts: OutcomeLike[] = [];
      const ledger = new Map<string, bigint>();
      let minted = 0n;
      let burned = 0n;
      let unknownWithEvents = 0;
      const outcomes = 1 + int(next, 8);
      for (let r = 0; r < outcomes; r++) {
        const executor = next() < 0.75 ? FT : "other.near";
        const status = pick(next, STATUSES);
        const counted = executor === FT && status !== undefined && "SuccessValue" in status;
        const logs: string[] = [];
        const events = int(next, 4);
        for (let e = 0; e < events; e++) {
          if (next() < 0.2) {
            logs.push(`plain log ${run}.${r}.${e}`);
            continue;
          }
          const amount = BigInt(Math.floor(next() * 2 ** 40)) * BigInt(1 + int(next, 2 ** 20));
          const kind = pick(next, ["ft_mint", "ft_burn", "ft_transfer"] as const);
          const a = pick(next, ACCOUNTS);
          const b = pick(next, ACCOUNTS);
          const data =
            kind === "ft_transfer"
              ? [{ old_owner_id: a, new_owner_id: b, amount: amount.toString() }]
              : [{ owner_id: a, amount: amount.toString(), memo: next() < 0.5 ? null : "m" }];
          logs.push(
            `${EVENT_JSON_PREFIX}${JSON.stringify({ standard: "nep141", version: "1.0.0", event: kind, data })}`,
          );
          if (!counted) continue;
          if (kind === "ft_transfer") {
            ledger.set(a, (ledger.get(a) ?? 0n) - amount);
            ledger.set(b, (ledger.get(b) ?? 0n) + amount);
          } else if (kind === "ft_mint") {
            ledger.set(a, (ledger.get(a) ?? 0n) + amount);
            minted += amount;
          } else {
            ledger.set(a, (ledger.get(a) ?? 0n) - amount);
            burned += amount;
          }
        }
        if (
          executor === FT &&
          status === undefined &&
          logs.some((l) => l.startsWith(EVENT_JSON_PREFIX))
        ) {
          unknownWithEvents++;
        }
        receipts.push({
          id: `run-${run}-receipt-${r}`,
          outcome: { executor_id: executor, logs, status },
        });
      }
      const { deltas, problems } = ftDeltas({ receipts_outcome: receipts }, FT);
      const where = `seed ${SEED + 3} run ${run}`;
      expect(Object.fromEntries(deltas), where).toEqual(Object.fromEntries(ledger));
      expect(
        [...deltas.values()].reduce((sum, d) => sum + d, 0n),
        where,
      ).toBe(minted - burned);
      expect(problems.length, where).toBe(unknownWithEvents);
      expect(new Set(problems.map((p) => p.problem.split(":")[0])), where).toEqual(
        new Set(unknownWithEvents > 0 ? ["unknown_status"] : []),
      );
    }
  });
});
