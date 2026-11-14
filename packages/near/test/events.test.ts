import { describe, expect, it } from "vitest";
import { NearFormatError } from "../src/errors.js";
import {
  EVENT_JSON_PREFIX,
  type EventQuery,
  eventsOf,
  nep141Events,
  nep245Events,
  parseEventLog,
  receiptStatusKind,
  scanAllEvents,
} from "../src/events.js";
import type { OutcomeLike, OutcomeSource, ProvenOutcome, TxTreeLike } from "../src/types.js";
import { readFixture } from "./helpers/fixtures.js";

// Real testnet `tx` answers with receipt statuses (a byte copy of apps/web/test/fixtures/testnet-spend-trees.json).
const TREES = readFixture<Record<"paid" | "burned" | "noMandate", TxTreeLike>>(
  "events/testnet-spend-trees.json",
);
// The two mainnet payouts, statuses trimmed when they were recorded (see the fixture's _source).
const MAINNET = readFixture<Record<"spend2" | "spend3", TxTreeLike>>(
  "events/mainnet-payout-outcomes.json",
);

const VAULT = "v0.probarion.testnet";
const PAYEE = "probarion-payee.testnet";
const USDC = "usdc.probarion.testnet";
const STUB = "intents-stub.probarion.testnet";
const POA_ASSET = "base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";

/** A deep copy of a fixture tree, so a test can change it without touching the others. */
function copy<T>(value: T): T {
  return structuredClone(value);
}

function receiptBy(tree: TxTreeLike, executor: string): OutcomeLike {
  const found = tree.receipts_outcome.find((r) => r.outcome.executor_id === executor);
  if (found === undefined) throw new Error(`no receipt of ${executor}`);
  return found;
}

const event = (body: Record<string, unknown>) => `${EVENT_JSON_PREFIX}${JSON.stringify(body)}`;

describe("parseEventLog", () => {
  const good = {
    standard: "nep141",
    version: "1.0.0",
    event: "ft_burn",
    data: [{ owner_id: "a.near" }],
  };

  it("reads an EVENT_JSON: log written by the reference implementation", () => {
    expect(parseEventLog(event(good))).toEqual({ kind: "event", event: good });
  });

  it("keeps the prefix exact: other case, a leading space or no prefix is a plain log", () => {
    expect(parseEventLog(`event_json:${JSON.stringify(good)}`)).toEqual({ kind: "plain" });
    expect(parseEventLog(`Event_Json:${JSON.stringify(good)}`)).toEqual({ kind: "plain" });
    expect(parseEventLog(` ${event(good)}`)).toEqual({ kind: "plain" });
    expect(parseEventLog(JSON.stringify(good))).toEqual({ kind: "plain" });
    expect(parseEventLog("Transfer 100 from a.near to b.near")).toEqual({ kind: "plain" });
    expect(parseEventLog("")).toEqual({ kind: "plain" });
  });

  it("accepts JSON whitespace after the prefix (it is the same JSON value)", () => {
    expect(parseEventLog(`EVENT_JSON: ${JSON.stringify(good, null, 2)}\n`)).toEqual({
      kind: "event",
      event: good,
    });
  });

  it("calls the prefix alone, text that is not JSON, and trailing text malformed", () => {
    for (const log of [
      "EVENT_JSON:",
      "EVENT_JSON:{",
      "EVENT_JSON:{standard:nep141}",
      `${event(good)} trailing`,
    ]) {
      expect(parseEventLog(log)).toEqual({
        kind: "malformed",
        problem: "the text after EVENT_JSON: is not JSON",
      });
    }
  });

  it("calls JSON that is not one object malformed (arrays, strings, numbers, null)", () => {
    for (const rest of [`[${JSON.stringify(good)}]`, '"nep141"', "42", "null", "true"]) {
      expect(parseEventLog(`EVENT_JSON:${rest}`)).toEqual({
        kind: "malformed",
        problem: "the JSON after EVENT_JSON: is not an object",
      });
    }
  });

  it("needs standard, version and event as non-empty strings", () => {
    for (const field of ["standard", "version", "event"] as const) {
      const missing: Record<string, unknown> = { ...good };
      delete missing[field];
      for (const body of [
        missing,
        { ...good, [field]: "" },
        { ...good, [field]: 1 },
        { ...good, [field]: null },
      ]) {
        expect(parseEventLog(event(body))).toEqual({
          kind: "malformed",
          problem: `"${field}" is not a non-empty string`,
        });
      }
    }
  });

  it("keeps data as given (null included), leaves it out when absent, and drops other fields", () => {
    expect(parseEventLog(event({ standard: "s", version: "1.0.0", event: "e" }))).toEqual({
      kind: "event",
      event: { standard: "s", version: "1.0.0", event: "e" },
    });
    const withNull = parseEventLog(
      event({ standard: "s", version: "1.0.0", event: "e", data: null }),
    );
    expect(withNull).toEqual({
      kind: "event",
      event: { standard: "s", version: "1.0.0", event: "e", data: null },
    });
    expect(withNull.kind === "event" && "data" in withNull.event).toBe(true);
    const extra = parseEventLog(event({ ...good, extra: "x" }));
    expect(extra.kind === "event" && "extra" in extra.event).toBe(false);
  });

  it("never throws, also on a value that is not a string", () => {
    expect(parseEventLog(42 as unknown as string)).toEqual({
      kind: "malformed",
      problem: "the log is not a string",
    });
    expect(parseEventLog(null as unknown as string)).toEqual({
      kind: "malformed",
      problem: "the log is not a string",
    });
  });
});

describe("receiptStatusKind", () => {
  const RECEIPT = "C7aoovt8hQneqUrrqoaZaWurwNRuwCE3P5rr1RTAXnJe";

  it("reads SuccessValue and SuccessReceiptId as success, Failure as failure", () => {
    expect(receiptStatusKind({ SuccessValue: "" })).toBe("success");
    expect(receiptStatusKind({ SuccessValue: "IjEwMDAwMDAi" })).toBe("success");
    expect(receiptStatusKind({ SuccessReceiptId: RECEIPT })).toBe("success");
    expect(receiptStatusKind({ Failure: { ActionError: { index: 0 } } })).toBe("failure");
    expect(receiptStatusKind({ Failure: null })).toBe("failure");
  });

  it("fails closed on everything else", () => {
    for (const status of [
      undefined,
      null,
      "Unknown",
      "SuccessValue",
      [],
      {},
      { SuccessValue: 1 },
      { SuccessValue: "not base64!" },
      { SuccessValue: "QR==" }, // non-zero trailing bits: not the canonical spelling
      { SuccessReceiptId: "x" },
      { SuccessReceiptId: `1${RECEIPT}` }, // 33 bytes
      { SuccessValue: "", Failure: {} },
      { successValue: "" },
    ]) {
      expect(receiptStatusKind(status)).toBe("unknown");
    }
  });

  it("matches every status in the recorded testnet trees", () => {
    const kinds = [TREES.paid, TREES.burned, TREES.noMandate].flatMap((tree) =>
      [tree.transaction_outcome, ...tree.receipts_outcome].map((o) =>
        receiptStatusKind(o?.outcome.status),
      ),
    );
    expect(kinds.filter((k) => k === "failure")).toHaveLength(1); // noMandate's NoMandate panic
    expect(kinds.filter((k) => k === "unknown")).toHaveLength(0);
  });
});

describe("eventsOf", () => {
  it("binds each event to its receipt, emitter and log index, in source order", () => {
    const events = eventsOf(TREES.burned, { emitters: [STUB] });
    const stub = receiptBy(TREES.burned, STUB);
    expect(
      events.map((e) => [
        e.standard,
        e.event,
        e.receiptId,
        e.emitter,
        e.logIndex,
        e.status,
        e.proven,
      ]),
    ).toEqual([
      ["nep245", "mt_burn", stub.id, STUB, 0, "success", false],
      ["nep141", "ft_burn", stub.id, STUB, 1, "success", false],
    ]);
  });

  it("filters by standard and event, and reads several emitters", () => {
    expect(
      eventsOf(TREES.burned, { emitters: [STUB], standard: "nep141" }).map((e) => e.event),
    ).toEqual(["ft_burn"]);
    expect(
      eventsOf(TREES.paid, { emitters: [VAULT], standard: "probarion" }).map((e) => e.event),
    ).toEqual(["spend_submitted", "spend_paid"]);
    expect(eventsOf(TREES.paid, { emitters: [VAULT], event: "spend_paid" })).toHaveLength(1);
    expect(eventsOf(TREES.paid, { emitters: [USDC, VAULT] }).map((e) => e.emitter)).toEqual([
      VAULT,
      USDC,
      VAULT,
    ]);
  });

  it("reads nothing for an emitter that wrote no event", () => {
    expect(eventsOf(TREES.paid, { emitters: [PAYEE] })).toEqual([]);
    expect(eventsOf(TREES.noMandate, { emitters: [VAULT], status: "any" })).toEqual([]);
  });

  it("drops a failed receipt's events by default and returns them with status any", () => {
    // Derived from the real `paid` tree: the token's receipt marked failed (a failed receipt keeps its logs).
    const failed = copy(TREES.paid);
    const token = receiptBy(failed, USDC);
    (token.outcome as { status?: unknown }).status = {
      Failure: {
        ActionError: {
          index: 0,
          kind: { FunctionCallError: { ExecutionError: "Smart contract panicked" } },
        },
      },
    };
    expect(eventsOf(failed, { emitters: [USDC] })).toEqual([]);
    expect(eventsOf(failed, { emitters: [USDC], status: "any" }).map((e) => e.status)).toEqual([
      "failure",
    ]);
  });

  it("drops the status-less mainnet outcomes by default and reads them as unknown with status any", () => {
    expect(eventsOf(MAINNET.spend2, { emitters: ["intents.near"] })).toEqual([]);
    const any = eventsOf(MAINNET.spend2, { emitters: ["intents.near", POA_ASSET], status: "any" });
    expect(any.map((e) => [e.emitter, e.event, e.status])).toEqual([
      ["intents.near", "mt_burn", "unknown"],
      [POA_ASSET, "ft_burn", "unknown"],
    ]);
  });

  it("reads transaction_outcome before receipts_outcome", () => {
    const tree = copy(TREES.paid);
    const txOutcome = tree.transaction_outcome as OutcomeLike;
    (txOutcome.outcome as { logs: readonly string[] }).logs = [
      event({ standard: "s", version: "1.0.0", event: "tx_level" }),
    ];
    expect(eventsOf(tree, { emitters: [VAULT] }).map((e) => [e.event, e.receiptId])).toEqual([
      ["tx_level", txOutcome.id],
      ["spend_submitted", tree.receipts_outcome[0]?.id],
      ["spend_paid", tree.receipts_outcome[3]?.id],
    ]);
  });

  it("reads hand-built ProvenOutcome objects as proven", () => {
    // Hand-built in this test from the `paid` tree, labelled: not recomputed from a light_client_proof.
    const proven: ProvenOutcome[] = TREES.paid.receipts_outcome.map((r) => ({
      id: r.id,
      executorId: r.outcome.executor_id,
      logs: r.outcome.logs,
      receiptIds: r.outcome.receipt_ids ?? [],
      gasBurnt: 0n,
      tokensBurnt: 0n,
      status: { kind: "success_value", value: new Uint8Array() },
      block: { hash: "hand-built", height: 0, timestampNs: 0n, epochId: "hand-built" },
      head: { blockMerkleRoot: "hand-built" },
    }));
    const events = eventsOf(proven, { emitters: [USDC] });
    expect(events.map((e) => [e.event, e.receiptId, e.proven, e.status])).toEqual([
      ["ft_transfer", receiptBy(TREES.paid, USDC).id, true, "success"],
    ]);
    const failed = proven.map((p) =>
      p.executorId === USDC ? { ...p, status: { kind: "failure" as const } } : p,
    );
    expect(eventsOf(failed, { emitters: [USDC] })).toEqual([]);
    expect(eventsOf(failed, { emitters: [USDC], status: "any" })[0]?.status).toBe("failure");
  });

  it("throws TypeError for a query with no emitter or a bad field", () => {
    const bad: unknown[] = [
      { emitters: [] },
      {},
      { emitters: "usdc.probarion.testnet" },
      { emitters: ["Not An Account"] },
      { emitters: [USDC], status: "all" },
      { emitters: [USDC], standard: "" },
      { emitters: [USDC], event: 1 },
      null,
    ];
    for (const query of bad) {
      expect(() => eventsOf(TREES.paid, query as EventQuery)).toThrow(TypeError);
    }
  });

  it("throws NearFormatError for a source it cannot read in full", () => {
    const sources: unknown[] = [
      {},
      { receipts_outcome: "x" },
      { receipts_outcome: [{ id: "r", outcome: { executor_id: USDC } }] }, // no logs
      { receipts_outcome: [{ id: "r", outcome: { executor_id: USDC, logs: [1] } }] },
      { receipts_outcome: [{ outcome: { executor_id: USDC, logs: [] } }] },
      { transaction_outcome: { id: "t" }, receipts_outcome: [] }, // the trimmed shape: no outcome
      [{ id: "r", executor_id: USDC, logs: [] }], // an RPC outcome passed as a ProvenOutcome
      [{ id: "r", executorId: USDC, logs: [], status: { kind: "maybe" } }],
    ];
    for (const source of sources) {
      let error: unknown;
      try {
        eventsOf(source as OutcomeSource, { emitters: [USDC] });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(NearFormatError);
      expect((error as NearFormatError).what).toBe("source");
    }
    const twice = copy(TREES.paid);
    (twice.receipts_outcome as OutcomeLike[]).push(receiptBy(twice, USDC));
    expect(() => eventsOf(twice, { emitters: [USDC] })).toThrow(/duplicate_outcome/);
  });
});

describe("scanAllEvents (diagnostics, untrusted)", () => {
  it("lists every event of every emitter with its status, and every malformed EVENT_JSON: log", () => {
    const tree = copy(TREES.paid);
    // Derived from the real tree, labelled: the vault logs a forged nep141 transfer and a broken event line.
    const vault = receiptBy(tree, VAULT);
    (vault.outcome.logs as string[]).push(
      event({
        standard: "nep141",
        version: "1.0.0",
        event: "ft_transfer",
        data: [{ old_owner_id: VAULT, new_owner_id: PAYEE, amount: "5000000" }],
      }),
      "EVENT_JSON:{broken",
      "a plain log",
    );
    const { events, malformed } = scanAllEvents(tree);
    expect(events.map((e) => [e.emitter, e.standard, e.event])).toEqual([
      [VAULT, "probarion", "spend_submitted"],
      [VAULT, "nep141", "ft_transfer"],
      [USDC, "nep141", "ft_transfer"],
      [VAULT, "probarion", "spend_paid"],
    ]);
    expect(malformed).toEqual([
      {
        receiptId: vault.id,
        emitter: VAULT,
        logIndex: 2,
        problem: "malformed_event: the text after EVENT_JSON: is not JSON",
      },
    ]);
    // The forged vault line is in the scan and nowhere in the token's own events.
    expect(nep141Events(tree, USDC).items.map((i) => i.item)).toEqual([
      {
        event: "ft_transfer",
        oldOwnerId: VAULT,
        newOwnerId: PAYEE,
        amount: 1_000_000n,
        memo: "probarion:1",
      },
    ]);
  });

  it("reports a malformed source instead of throwing", () => {
    expect(scanAllEvents({} as OutcomeSource)).toEqual({
      events: [],
      malformed: [
        {
          receiptId: "",
          emitter: "",
          logIndex: -1,
          problem:
            "malformed_outcome: the source is not a tx answer with receipts_outcome or a list of proven outcomes",
        },
      ],
    });
  });

  it("reads the status-less mainnet outcomes as unknown", () => {
    const { events } = scanAllEvents(MAINNET.spend3);
    expect(events.map((e) => [e.standard, e.event, e.status])).toEqual([
      ["probarion", "spend_submitted", "unknown"],
      ["nep245", "mt_burn", "unknown"],
      ["nep141", "ft_burn", "unknown"],
      ["probarion", "spend_burned", "unknown"],
    ]);
    expect(nep245Events(MAINNET.spend3, "intents.near").items).toEqual([]);
  });
});
