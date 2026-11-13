// The live run's words: each check's state, the verdict, and why a read did not come back, filled from the copy the
// client component is handed. The section's server words are held in test/site-facts.test.ts.
import { describe, expect, it } from "vitest";
import { MAINNET_PAYOUT } from "./facts";
import {
  type CheckOutcome,
  evaluateAll,
  type RecordedFile,
  type RecordedPayout,
  recordedReads,
  tally,
} from "./mainnet-payout";
import recordedJson from "./mainnet-payout-recorded.json";
import {
  CHECK_ORDER,
  checkRows,
  listText,
  liveCopy,
  liveVerdict,
  numberWord,
  READ_COUNTS,
  readingVerdict,
  restVerdict,
  rowState,
  unreadText,
} from "./mainnet-payout-view";

const C = liveCopy(MAINNET_PAYOUT);
const S1 = (recordedJson as unknown as RecordedFile).payouts[0] as RecordedPayout;
const OUTCOMES = evaluateAll(recordedReads(S1), S1.payout);
const pass = OUTCOMES[0] as CheckOutcome;

describe("the live run's copy", () => {
  it("is the part of MAINNET_PAYOUT the run needs, and nothing that links", () => {
    expect(Object.keys(C).sort()).toEqual(
      ["and", "checks", "comma", "problems", "reads", "rowState", "run"].sort(),
    );
    expect(JSON.stringify(C)).not.toContain("https://");
  });
});

describe("rowState", () => {
  it("says Recorded at rest, with no date (the verdict above gives it), Reading while the reads run, and Pass after", () => {
    expect(rowState(C, "recorded")).toEqual({ word: "Recorded", note: null, tone: "neutral" });
    expect(rowState(C, "reading")).toEqual({ word: "Reading", note: null, tone: "neutral" });
    expect(rowState(C, pass, "earlier")).toEqual({ word: "Pass", note: "read now", tone: "ok" });
  });

  it("names the value a failed check read, and says where the values on show come from", () => {
    const o: CheckOutcome = {
      state: "fail",
      problem: { code: "base.amount", vars: { got: "997601" } },
    };
    expect(rowState(C, o, "recorded")).toEqual({
      word: "Does not match: the Transfer is 997601.",
      note: "The values shown are the recorded ones.",
      tone: "bad",
    });
    expect(rowState(C, o, "earlier").note).toBe(
      "The values shown are from this browser's last read that passed.",
    );
  });

  it("says an answer it cannot read is unread, never a mismatch", () => {
    const o: CheckOutcome = { state: "unread", missing: [], shape: true };
    expect(rowState(C, o, "recorded")).toEqual({
      word: "Could not read: the answers it needs are not in the shape this page reads.",
      note: "The values shown are the recorded ones.",
      tone: "neutral",
    });
  });

  it("says which read did not come back and what each host answered, and keeps the recorded values", () => {
    const o: CheckOutcome = {
      state: "unread",
      missing: [
        {
          read: "spend",
          failures: [
            { host: "archival-rpc.mainnet.fastnear.com", kind: "timeout", detail: "8" },
            { host: "rpc.mainnet.fastnear.com", kind: "rpc", detail: "UNKNOWN_TRANSACTION" },
          ],
        },
        { read: "config", failures: [] },
      ],
    };
    const s = rowState(C, o, "recorded");
    expect(s.word).toBe(
      "Could not read: the spend transaction: archival-rpc.mainnet.fastnear.com did not answer in 8 s; rpc.mainnet.fastnear.com answered UNKNOWN_TRANSACTION; get_config: no node was asked.",
    );
    expect(s.note).toBe("The values shown are the recorded ones.");
  });

  it("has a sentence for each way a host can fail", () => {
    const host = "mainnet.base.org";
    const said = (kind: "timeout" | "network" | "http" | "rpc" | "body" | "none", detail: string) =>
      unreadText(C, [{ read: "base", failures: [{ host, kind, detail }] }]);
    expect(said("network", "")).toBe("the Base transaction: mainnet.base.org could not be reached");
    expect(said("http", "503")).toBe("the Base transaction: mainnet.base.org answered HTTP 503");
    expect(said("rpc", "")).toBe("the Base transaction: mainnet.base.org answered with an error");
    expect(said("rpc", "-32005")).toBe("the Base transaction: mainnet.base.org answered -32005");
    expect(said("body", "")).toBe(
      "the Base transaction: mainnet.base.org sent an answer this page cannot read",
    );
    expect(said("none", "")).toBe("the Base transaction: mainnet.base.org has no such transaction");
  });
});

describe("the verdict", () => {
  const t = tally(OUTCOMES);

  it("at rest counts the recorded checks and the reads", () => {
    expect(restVerdict(C, t, "2026-11-13T11:02:19.512Z")).toEqual({
      title: "Recorded on 2026-11-13: 7 of 7 checks passed.",
      sub: "Press the button and this page reads the same 4 transactions and 3 views again, in your browser, from public RPC.",
      tone: "ok",
    });
    expect(READ_COUNTS).toEqual({ txs: 4, views: 3 });
  });

  it("while reading, says what it reads and from where", () => {
    expect(readingVerdict(C)).toEqual({
      title: "Reading 4 transactions and 3 views",
      sub: "From FastNEAR's public nodes and mainnet.base.org, in this browser.",
      tone: "neutral",
    });
  });

  it("after a run, says when, how long and from which hosts", () => {
    const at = Date.parse("2026-11-13T12:34:56.789Z");
    expect(
      liveVerdict(C, t, at, 2345, ["archival-rpc.mainnet.fastnear.com", "mainnet.base.org"]),
    ).toEqual({
      title: "Read just now: 7 of 7 checks pass.",
      sub: "At 12:34:56 UTC, in 2.3 s, from archival-rpc.mainnet.fastnear.com and mainnet.base.org.",
      tone: "ok",
    });
  });

  it("says a mismatch is a failure, and a missing read is not a pass", () => {
    const fail = { ...t, pass: 6, fail: 1, state: "fail" as const };
    const unread = { ...t, pass: 6, unread: 1, state: "unread" as const };
    expect(liveVerdict(C, fail, 0, 0, [])).toMatchObject({
      title: "A check failed: 6 of 7 pass.",
      tone: "bad",
    });
    expect(liveVerdict(C, unread, 0, 0, [])).toMatchObject({
      title: "6 of 7 checks pass, and 1 could not be read, so this is not a pass.",
      tone: "neutral",
    });
  });
});

describe("the rows and the counts", () => {
  it("fill each passing check's rows with the values it read", () => {
    const rows = CHECK_ORDER.map(({ id }, i) => {
      const o = OUTCOMES[i];
      return o?.state === "pass" ? checkRows(C, id, o.values) : [];
    });
    expect(rows.flat().every((r) => !/\{\w+(\|[^}]*)?\}/.test(r.text))).toBe(true);
    expect(rows[2]?.at(-1)).toEqual({
      label: "",
      text: "5 fields, and none of them is an address. The vault runs the recorded build 3cQXYDvf…9MF1.",
      full: false,
      note: true,
    });
    expect(rows[5]?.map((r) => r.text)).toEqual([
      "seq 3, 4 entries, signed by the ledger key in get_config",
      "28ac4e58…e6c6",
      "entry 2, d64f0de7…a336: the spend's decision_hash",
      "The ledger file's 2 entries from entry 2 on hash to this root.",
    ]);
    expect(rows[6]?.map((r) => r.text)).toEqual([
      "56821514, status success",
      "997600, that is 0.9976 USDC, on Base USDC 0x8335…02913",
      "0xB22E…6EB27, the payee in 01, from 0x2cff…02680",
      "0.0024 USDC: 1.00 burned less 0.9976 arrived",
    ]);
    expect(rows[1]?.[2]?.text).toBe(`block ${S1.payout.pin.height}, the block of spend 2`);
    expect(CHECK_ORDER.map((c) => c.n)).toEqual(["01", "02", "03", "04", "05", "06", "07"]);
  });

  it("say small counts in words, and larger ones in digits", () => {
    expect(numberWord(MAINNET_PAYOUT, 2)).toBe("two");
    expect(numberWord(MAINNET_PAYOUT, 12)).toBe("12");
    expect(listText(C, ["a"])).toBe("a");
    expect(listText(C, ["a", "b", "c"])).toBe("a, b and c");
  });
});
