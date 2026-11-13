// The mainnet payout's logic: the seven checks on the recorded reads and on tampered copies of them, the RPC helper's
// retries and fallback, the views pinned to the spend's block, and a whole run on a fake fetch. No network: every
// answer comes from lib/site/mainnet-payout-recorded.json or from the fakes below.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BACKOFF_MS,
  BASE_RPC_URLS,
  base58,
  CHECKS,
  type CheckOutcome,
  chainLinks,
  checkNumber,
  evaluate,
  evaluateAll,
  fill,
  NEAR_RPC_URLS,
  type Payout,
  type PayoutCheckId,
  READ_NAMES,
  ReadError,
  type ReadName,
  type Reads,
  type RecordedFile,
  type RecordedPayout,
  recordedReads,
  rpc,
  runPayout,
  SPEND_FIELDS,
  sha256,
  shortAddr,
  shortHash,
  shortHex,
  shortKey,
  startReads,
  TIMEOUT_MS,
  tally,
  trimRead,
  usdc,
} from "./mainnet-payout";
import recordedJson from "./mainnet-payout-recorded.json";

const RECORDED = recordedJson as unknown as RecordedFile;
const S1 = RECORDED.payouts[0] as RecordedPayout;
const P = S1.payout;

type Json = Record<string, unknown>;
/** A deep copy of the recorded reads, to tamper with. */
const copy = (): Record<ReadName, Json> => structuredClone(S1.reads) as Record<ReadName, Json>;
const asReads = (values: Record<ReadName, unknown>): Reads =>
  Object.fromEntries(
    READ_NAMES.map((n) => [n, { ok: true, value: values[n], host: "test" }]),
  ) as Reads;
/** The ids of the checks that do not pass, and the outcomes by id; `payout` is the page's own facts, P unless changed. */
function run(values: Record<ReadName, unknown>, payout: Payout = P) {
  const outcomes = evaluateAll(asReads(values), payout);
  const byId = Object.fromEntries(CHECKS.map((c, i) => [c.id, outcomes[i]])) as Record<
    PayoutCheckId,
    CheckOutcome
  >;
  return { failed: CHECKS.filter((c) => byId[c.id].state !== "pass").map((c) => c.id), byId };
}
const problem = (o: CheckOutcome) => (o.state === "fail" ? o.problem : null);

const b64 = (v: unknown) => btoa(JSON.stringify(v));
const unb64 = (s: string) => JSON.parse(atob(s)) as Json;
/** The spend transaction's own call arguments, decoded, changed by `edit`, and encoded again. */
function editSpendArgs(reads: Record<ReadName, Json>, edit: (args: Json) => void) {
  const fc = ((reads.spend.transaction as Json).actions as Json[])[0]?.FunctionCall as Json;
  const args = unb64(fc.args as string);
  edit(args);
  fc.args = b64(args);
}
type Outcome = { outcome: { executor_id: string; logs: string[] } };
/** The spend's receipt logs of one event, changed by `edit`. */
function editEvent(reads: Record<ReadName, Json>, event: string, edit: (log: string) => string) {
  for (const o of reads.spend.receipts_outcome as Outcome[]) {
    o.outcome.logs = o.outcome.logs.map((l) => (l.includes(`"event":"${event}"`) ? edit(l) : l));
  }
}
/** The root the anchor wrote on chain, from its ledger_anchored event. */
function anchoredRoot(): string {
  for (const o of (S1.reads.anchor as Json).receipts_outcome as Outcome[]) {
    for (const l of o.outcome.logs) {
      if (!l.includes('"event":"ledger_anchored"')) continue;
      return (JSON.parse(l.slice("EVENT_JSON:".length)) as { data: { root: string } }).data.root;
    }
  }
  throw new Error("no ledger_anchored event");
}

describe("the seven checks on the recorded reads", () => {
  it("are seven, in the route's order, numbered 01 to 07", () => {
    expect(CHECKS.map((c) => c.id)).toEqual([
      "owner",
      "key",
      "noaddr",
      "memo",
      "burn",
      "anchor",
      "base",
    ]);
    expect(CHECKS.map((c) => checkNumber(c.id))).toEqual([
      "01",
      "02",
      "03",
      "04",
      "05",
      "06",
      "07",
    ]);
    // Every read is needed by some check, and the checks need nothing else.
    expect([...new Set(CHECKS.flatMap((c) => c.needs))].sort()).toEqual([...READ_NAMES].sort());
  });

  it("all pass, with the values the rows show", () => {
    const outcomes = evaluateAll(recordedReads(S1), P);
    expect(outcomes.map((o) => o.state)).toEqual(Array(7).fill("pass"));
    expect(tally(outcomes)).toEqual({ total: 7, pass: 7, fail: 0, unread: 0, state: "pass" });
    const values = Object.fromEntries(
      CHECKS.map((c, i) => [c.id, (outcomes[i] as { values: Record<string, string> }).values]),
    );
    expect(values.owner).toEqual({
      signer: "probarion.near",
      payee: "0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27",
      max: "1.00",
      uses: "1",
      until: "2026-11-20",
      mandateId: "2",
    });
    expect(values.key).toEqual({
      key: "ed25519:GADeVCXt…Cycd",
      spendId: "2",
      methods: "spend",
      receiver: "v0.probarion.near",
      height: String(P.pin.height),
    });
    expect(values.noaddr).toMatchObject({
      mandate_id: "2",
      amount: "1000000",
      ref: "INV-M002",
      fields: "5",
      code: "3cQXYDvf…9MF1",
    });
    expect(values.memo).toEqual({
      from: "v0.probarion.near",
      to: "intents.near",
      memo: "WITHDRAW_TO:0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27",
    });
    expect(values.burn).toEqual({
      raw: "1000000",
      usdc: "1.00",
      owner: "intents.near",
      spendId: "2",
      status: "burned",
    });
    expect(values.anchor).toEqual({
      seq: "3",
      count: "4",
      root: "28ac4e58…e6c6",
      decisionSeq: "2",
      decisionHash: "d64f0de7…a336",
      links: "2",
    });
    expect(values.base).toEqual({
      block: "56821514",
      raw: "997600",
      usdc: "0.9976",
      token: "0x8335…02913",
      to: "0xB22E…6EB27",
      from: "0x2cff…02680",
      burned: "1.00",
      fee: "0.0024",
    });
  });

  it("read the spend request's fields as the contract's SpendRequest has them", () => {
    let fields: string[] = [];
    editSpendArgs(copy(), (a) => {
      fields = Object.keys(a.request as Json);
    });
    expect(fields.sort()).toEqual([...SPEND_FIELDS].sort());
  });

  it("keep passing on a recorded read trimmed again: trimRead keeps what they read", () => {
    const again = Object.fromEntries(
      READ_NAMES.map((n) => [n, trimRead(n, S1.reads[n])]),
    ) as Record<ReadName, unknown>;
    expect(again).toEqual(S1.reads);
    expect(run(again).failed).toEqual([]);
  });
});

describe("the checks on tampered copies", () => {
  it("a Transfer of another amount fails 07 and names the amount", () => {
    const r = copy();
    const log = (r.base.logs as Json[])[0] as Json;
    log.data = `0x${(997601).toString(16).padStart(64, "0")}`;
    const { failed, byId } = run(r);
    expect(failed).toEqual(["base"]);
    expect(problem(byId.base)).toEqual({ code: "base.amount", vars: { got: "997601" } });
  });

  it("a Transfer to another address fails 07: no USDC Transfer to the mandate's payee", () => {
    const r = copy();
    const log = (r.base.logs as Json[])[0] as Json;
    (log.topics as string[])[2] = `0x${"0".repeat(24)}${"ab".repeat(20)}`;
    const { failed, byId } = run(r);
    expect(failed).toEqual(["base"]);
    expect(problem(byId.base)?.code).toBe("base.transfer");
  });

  it("another owner in get_config fails 01: the mandate was not signed by the vault's owner", () => {
    const r = copy();
    (r.config.value as Json).owner = "someone-else.near";
    const { failed, byId } = run(r);
    expect(failed).toEqual(["owner"]);
    expect(problem(byId.owner)).toEqual({
      code: "owner.signer",
      vars: { signer: "probarion.near", owner: "someone-else.near" },
    });
  });

  it("a mandate for another Base address fails 01, 04 and 07", () => {
    const r = copy();
    const fc = ((r.mandate.transaction as Json).actions as Json[])[0]?.FunctionCall as Json;
    const args = unb64(fc.args as string);
    ((args.input as Json).payee as Json).address = `0x${"ab".repeat(20)}`;
    fc.args = b64(args);
    const { failed, byId } = run(r);
    expect(failed).toEqual(["owner", "memo", "base"]);
    expect(problem(byId.owner)?.code).toBe("owner.payee");
    expect(problem(byId.memo)?.code).toBe("memo.memo");
  });

  it("a spend with no ft_burn fails 05 and names the token", () => {
    const r = copy();
    for (const o of r.spend.receipts_outcome as Outcome[]) {
      o.outcome.logs = o.outcome.logs.filter((l) => !l.includes('"event":"ft_burn"'));
    }
    const { failed, byId } = run(r);
    expect(failed).toEqual(["burn"]);
    expect(problem(byId.burn)).toEqual({ code: "burn.none", vars: { asset: shortAddr(P.asset) } });
  });

  it("an ft_burn of another amount, or with another memo, fails 05", () => {
    const amount = copy();
    const memo = copy();
    const edit = (r: Record<ReadName, Json>, f: (d: Json) => void) => {
      for (const o of r.spend.receipts_outcome as Outcome[]) {
        o.outcome.logs = o.outcome.logs.map((l) => {
          if (!l.includes('"event":"ft_burn"')) return l;
          const e = JSON.parse(l.slice("EVENT_JSON:".length)) as { data: Json[] };
          f(e.data[0] as Json);
          return `EVENT_JSON:${JSON.stringify(e)}`;
        });
      }
    };
    edit(amount, (d) => {
      d.amount = "999999";
    });
    edit(memo, (d) => {
      d.memo = `WITHDRAW_TO:0x${"ab".repeat(20)}`;
    });
    expect(problem(run(amount).byId.burn)?.code).toBe("burn.amount");
    expect(problem(run(memo).byId.burn)?.code).toBe("burn.memo");
  });

  it("an address field in the spend request fails 03: the request has the fields it names", () => {
    const r = copy();
    editSpendArgs(r, (a) => {
      (a.request as Json).payee = "0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27";
    });
    const { failed, byId } = run(r);
    expect(failed).toEqual(["noaddr"]);
    expect(problem(byId.noaddr)).toEqual({
      code: "noaddr.fields",
      vars: { got: "mandate_id, amount, invoice_hash, ref, decision_hash, payee" },
    });
  });

  it.each([
    ["an EVM address", "0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27"],
    ["a NEAR account", "probarion-duong.near"],
    ["an EVM address inside other text", "INV-M002 0xB22EAcDf11177d6D635E8956BBbBdd54B3E6EB27"],
    ["a NEAR account inside other text", "pay someone.near for INV-M002"],
    ["a withdrawal memo", "WITHDRAW_TO:INV-M002"],
    ["an implicit NEAR account", `INV ${"ab".repeat(32)}`],
  ])("%s in one of the five fields fails 03: the field holds an address", (_, value) => {
    const r = copy();
    editSpendArgs(r, (a) => {
      (a.request as Json).ref = value;
    });
    const { failed, byId } = run(r);
    expect(failed).toEqual(["noaddr"]);
    expect(problem(byId.noaddr)).toEqual({ code: "noaddr.address", vars: { field: "ref" } });
  });

  it("a field of another type fails 03 and names it: an object or a number in text is not the request", () => {
    const nested = copy();
    editSpendArgs(nested, (a) => {
      (a.request as Json).ref = { to: "someone.near" };
    });
    expect(run(nested).failed).toEqual(["noaddr"]);
    expect(problem(run(nested).byId.noaddr)).toEqual({
      code: "noaddr.type",
      vars: { field: "ref" },
    });
    const text = copy();
    editSpendArgs(text, (a) => {
      (a.request as Json).mandate_id = "2";
    });
    expect(problem(run(text).byId.noaddr)).toEqual({
      code: "noaddr.type",
      vars: { field: "mandate_id" },
    });
  });

  it("a vault that runs another build fails 03: the recorded build is the one whose request has five fields", () => {
    const r = copy();
    r.account.code_hash = "11111111111111111111111111111111";
    const { failed, byId } = run(r);
    expect(failed).toEqual(["noaddr"]);
    expect(problem(byId.noaddr)).toEqual({
      code: "noaddr.build",
      vars: { got: shortHash("11111111111111111111111111111111"), want: "3cQXYDvf…9MF1" },
    });
  });

  it("an argument beside the request fails 03", () => {
    const r = copy();
    editSpendArgs(r, (a) => {
      a.receiver_id = "probarion-duong.near";
    });
    expect(problem(run(r).byId.noaddr)?.code).toBe("noaddr.args");
  });

  it("a key that may call more methods fails 02 and names them", () => {
    const r = copy();
    ((r.key.permission as Json).FunctionCall as Json).method_names = ["spend", "create_mandate"];
    const { failed, byId } = run(r);
    expect(failed).toEqual(["key"]);
    expect(problem(byId.key)).toEqual({
      code: "key.methods",
      vars: { got: "spend, create_mandate" },
    });
  });

  it("a full-access key fails 02", () => {
    const r = copy();
    r.key.permission = "FullAccess";
    expect(problem(run(r).byId.key)).toEqual({ code: "key.full", vars: { spendId: "2" } });
  });

  it("a spend sent from another account fails 02: the key is the vault's own", () => {
    const r = copy();
    (r.spend.transaction as Json).signer_id = "someone-else.near";
    const { failed, byId } = run(r);
    expect(failed).toEqual(["key", "noaddr"]);
    expect(problem(byId.key)).toEqual({
      code: "key.account",
      vars: { spendId: "2", got: "someone-else.near" },
    });
  });

  it("a spend signed by another key fails 02", () => {
    const r = copy();
    (r.spend.transaction as Json).public_key =
      "ed25519:22222222222222222222222222222222222222222222";
    expect(problem(run(r).byId.key)?.code).toBe("key.signer");
  });

  it("an anchor signed by a key other than the ledger key fails 06", () => {
    const r = copy();
    (r.config.value as Json).ledger_key = "ed25519:GADeVCXtgcxS3E5JrcVpEWTuZiNMJ4gu17iyuEgyCycd";
    const { failed, byId } = run(r);
    expect(failed).toEqual(["anchor"]);
    expect(problem(byId.anchor)?.code).toBe("anchor.key");
  });

  it("an mt_burn of another token fails 05: the vault burns the mandate's asset", () => {
    const r = copy();
    editEvent(r, "mt_burn", (l) => l.replace(`nep141:${P.asset}`, "nep141:other.near"));
    const { failed, byId } = run(r);
    expect(failed).toEqual(["burn"]);
    expect(problem(byId.burn)).toEqual({
      code: "burn.mt",
      vars: { amount: "1000000", intents: "intents.near", asset: shortAddr(P.asset) },
    });
  });

  it("a spend whose decision_hash is not the ledger's entry fails 06", () => {
    const r = copy();
    editSpendArgs(r, (a) => {
      (a.request as Json).decision_hash = "0".repeat(64);
    });
    const { failed, byId } = run(r);
    expect(failed).toEqual(["anchor"]);
    expect(problem(byId.anchor)).toEqual({
      code: "anchor.decision",
      vars: { got: shortHex("0".repeat(64)), want: "d64f0de7…a336", seq: "2" },
    });
  });

  it("ledger entries that do not hash to the anchored root fail 06", () => {
    const tampered = (edit: (p: Payout) => void) => {
      const p = structuredClone(P);
      edit(p);
      return problem(run(copy(), p).byId.anchor)?.code;
    };
    // Another body, another signature, a gap in the entries, or entries that stop before the anchor's last one.
    expect(
      tampered((p) => {
        (p.links[1] as Payout["links"][number]).bodyHash = "0".repeat(64);
      }),
    ).toBe("anchor.link");
    expect(
      tampered((p) => {
        const l = p.links[1] as Payout["links"][number];
        l.sig = `${l.sig.slice(0, -1)}${l.sig.endsWith("2") ? "3" : "2"}`;
      }),
    ).toBe("anchor.link");
    expect(
      tampered((p) => {
        (p.links[1] as Payout["links"][number]).seq = 4;
      }),
    ).toBe("anchor.link");
    expect(
      tampered((p) => {
        p.links = p.links.slice(0, 1);
      }),
    ).toBe("anchor.link");
    // An opening entry that is not the spend's decision.
    expect(
      tampered((p) => {
        p.decision = { ...p.decision, bodyHash: "1".repeat(64) };
      }),
    ).toBe("anchor.decision");
  });

  it("an anchor of another count fails 06 and names what it read", () => {
    const r = copy();
    for (const o of r.anchor.receipts_outcome as Outcome[]) {
      o.outcome.logs = o.outcome.logs.map((l) => l.replace('"count":4', '"count":3'));
    }
    expect(problem(run(r).byId.anchor)).toEqual({
      code: "anchor.event",
      vars: { seq: "3", count: "3" },
    });
  });

  it("a spend that did not succeed fails the checks that read its result", () => {
    const r = copy();
    r.spend.status = { Failure: { ActionError: { index: 0 } } };
    const { byId } = run(r);
    expect(problem(byId.burn)).toEqual({ code: "tx.failed", vars: { read: "spend" } });
  });

  it("a spend with no call fails the checks that read its request, and names the count", () => {
    const r = copy();
    (r.spend.transaction as Json).actions = [];
    const { failed, byId } = run(r);
    expect(failed).toEqual(["noaddr", "memo", "anchor", "base"]);
    expect(problem(byId.noaddr)).toEqual({
      code: "tx.actions",
      vars: { read: "spend", count: "0" },
    });
    expect(problem(byId.memo)).toEqual({ code: "tx.actions", vars: { read: "spend", count: "0" } });
  });

  it("an answer that is not shaped like the RPC's is unread, never a fail and never an exception", () => {
    const unshaped = { state: "unread", missing: [], shape: true };
    // A key with no permission is not a full-access key.
    const key = copy();
    delete key.key.permission;
    expect(run(key).byId.key).toEqual(unshaped);
    // A spend with no receipts is not a spend with no withdrawal.
    const receipts = copy();
    delete receipts.spend.receipts;
    const { byId } = run(receipts);
    expect(byId.memo).toEqual(unshaped);
    expect(tally(CHECKS.map((c) => byId[c.id]))).toMatchObject({ fail: 0, state: "unread" });
  });

  it("cut a value read from the chain to 120 characters in the sentence", () => {
    const r = copy();
    (r.config.value as Json).owner = "x".repeat(500);
    expect(problem(run(r).byId.owner)?.vars.owner).toHaveLength(120);
  });

  it("a read that did not come back makes its checks unread, never a fail, and the tally says so", () => {
    const reads = recordedReads(S1);
    reads.base = {
      ok: false,
      failures: [{ host: "mainnet.base.org", kind: "http", detail: "503" }],
    };
    const outcomes = evaluateAll(reads, P);
    expect(outcomes.map((o) => o.state)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "unread",
    ]);
    expect(outcomes[6]).toEqual({
      state: "unread",
      missing: [
        { read: "base", failures: [{ host: "mainnet.base.org", kind: "http", detail: "503" }] },
      ],
    });
    expect(tally(outcomes)).toMatchObject({ pass: 6, unread: 1, state: "unread" });
    // A failed check outweighs an unread one.
    const bad = { state: "fail", problem: { code: "tx.actions", vars: {} } } as const;
    expect(tally([...outcomes.slice(0, 6), bad]).state).toBe("fail");
    // A read that was never asked counts as missing too.
    delete reads.config;
    expect(evaluate(CHECKS[0] as (typeof CHECKS)[number], reads, P)).toEqual({
      state: "unread",
      missing: [{ read: "config", failures: [] }],
    });
  });
});

describe("the views, pinned to the spend's block", () => {
  it("fail when a view was read at another block, and name both blocks", () => {
    const r = copy();
    r.config.block_hash = "4uFZy3fZGuaPWWVxPjQZNHqpHPYMpGJbg7oQZrXNtJg1";
    r.key.block_hash = "4uFZy3fZGuaPWWVxPjQZNHqpHPYMpGJbg7oQZrXNtJg1";
    const { failed, byId } = run(r);
    expect(failed).toEqual(["owner", "key", "anchor"]);
    for (const [id, read] of [
      ["owner", "config"],
      ["key", "key"],
      ["anchor", "config"],
    ] as const) {
      expect(problem(byId[id])).toEqual({
        code: "view.pin",
        vars: { read, got: "4uFZy3fZGuaPWWVxPjQZNHqpHPYMpGJbg7oQZrXNtJg1", want: P.pin.hash },
      });
    }
  });

  it("fail 03 when the vault's code was read at another block", () => {
    const r = copy();
    r.account.block_hash = "4uFZy3fZGuaPWWVxPjQZNHqpHPYMpGJbg7oQZrXNtJg1";
    const { failed, byId } = run(r);
    expect(failed).toEqual(["noaddr"]);
    expect(problem(byId.noaddr)).toEqual({
      code: "view.pin",
      vars: {
        read: "account",
        got: "4uFZy3fZGuaPWWVxPjQZNHqpHPYMpGJbg7oQZrXNtJg1",
        want: P.pin.hash,
      },
    });
  });

  it("fail when the spend is not in the pinned block", () => {
    const r = copy();
    (r.spend.transaction_outcome as Json).block_hash =
      "4uFZy3fZGuaPWWVxPjQZNHqpHPYMpGJbg7oQZrXNtJg1";
    expect(problem(run(r).byId.key)?.code).toBe("key.block");
  });

  it("are the spend's own block in the recorded file", () => {
    expect((S1.reads.spend as Json).transaction_outcome).toMatchObject({ block_hash: P.pin.hash });
    expect(S1.reads.config).toMatchObject({ block_hash: P.pin.hash, block_height: P.pin.height });
    expect(S1.reads.key).toMatchObject({ block_hash: P.pin.hash, block_height: P.pin.height });
    expect(S1.reads.account).toMatchObject({
      block_hash: P.pin.hash,
      block_height: P.pin.height,
      code_hash: P.build.codeHash,
    });
  });

  it("ask the node for the spend's block by its hash, never for the latest state", async () => {
    const asked: { url: string; body: Json }[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      asked.push({ url: String(url), body: JSON.parse(String(init?.body)) as Json });
      return new Response("{}", { status: 400 });
    }) as typeof fetch;
    const pending = startReads(P, { fetch: fetchFn, backoffMs: [] });
    await Promise.all(READ_NAMES.map((n) => pending[n]));
    const views = asked.filter((a) => a.body.method === "query");
    expect(views).toHaveLength(3 * NEAR_RPC_URLS.length);
    for (const v of views) {
      const params = v.body.params as Json;
      expect(params.block_id).toBe(P.pin.hash);
      expect(params).not.toHaveProperty("finality");
      expect(params.account_id).toBe(P.vault);
    }
    expect(views.map((v) => (v.body.params as Json).request_type).sort()).toEqual([
      "call_function",
      "call_function",
      "view_access_key",
      "view_access_key",
      "view_account",
      "view_account",
    ]);
    expect(
      views.find((v) => (v.body.params as Json).request_type === "view_access_key")?.body.params,
    ).toMatchObject({ public_key: P.agentKey });
  });
});

// --- the RPC helper -------------------------------------------------------------------------------

const A = "https://a.example";
const B = "https://b.example";
const ok = (result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: "probarion-site", result }), { status: 200 });
const rpcError = (name: string) =>
  new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "probarion-site",
      error: { code: -32000, cause: { name } },
    }),
    { status: 200 },
  );

/** A fetch that answers each call with the next item of `script`, and records what it was asked. */
function scripted(script: ((url: string) => Response | Promise<Response>)[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = script.shift();
    if (next === undefined) throw new Error("no more answers");
    return next(String(url));
  }) as typeof fetch;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return { calls, fetchFn, sleeps, sleep };
}

/** A fetch that never answers, until its signal aborts. */
const hanging = ((_: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("aborted", "AbortError")),
    );
  })) as typeof fetch;

describe("rpc", () => {
  it("uses public hosts: FastNEAR's archival node before the regular one, and Base's own", () => {
    expect(NEAR_RPC_URLS).toEqual([
      "https://archival-rpc.mainnet.fastnear.com",
      "https://rpc.mainnet.fastnear.com",
    ]);
    expect(BASE_RPC_URLS).toEqual(["https://mainnet.base.org"]);
    for (const u of [...NEAR_RPC_URLS, ...BASE_RPC_URLS]) expect(u).not.toMatch(/probarion/);
    expect(TIMEOUT_MS).toBe(8000);
    expect(BACKOFF_MS).toEqual([500, 1500]);
  });

  it("sends a JSON-RPC POST with no credentials and no referrer", async () => {
    const s = scripted([() => ok({ x: 1 })]);
    await expect(rpc([A], "status", [1], { fetch: s.fetchFn })).resolves.toEqual({
      value: { x: 1 },
      host: "a.example",
    });
    const init = s.calls[0]?.init;
    expect(init).toMatchObject({
      method: "POST",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "content-type": "application/json" },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toEqual({
      jsonrpc: "2.0",
      id: "probarion-site",
      method: "status",
      params: [1],
    });
  });

  it("retries a host twice, 0.5 s then 1.5 s, then moves to the next one", async () => {
    const s = scripted([
      () => new Response("busy", { status: 503 }),
      () => new Response("busy", { status: 503 }),
      () => new Response("busy", { status: 503 }),
      () => ok("from b"),
    ]);
    const got = await rpc([A, B], "m", {}, { fetch: s.fetchFn, sleep: s.sleep });
    expect(got).toEqual({ value: "from b", host: "b.example" });
    expect(s.calls.map((c) => c.url)).toEqual([A, A, A, B]);
    expect(s.sleeps).toEqual([500, 1500]);
  });

  it("stops retrying as soon as a try answers", async () => {
    const s = scripted([() => Promise.reject(new TypeError("offline")), () => ok(7)]);
    await expect(rpc([A, B], "m", {}, { fetch: s.fetchFn, sleep: s.sleep })).resolves.toEqual({
      value: 7,
      host: "a.example",
    });
    expect(s.sleeps).toEqual([500]);
  });

  it("retries a node timeout and a rate limit, but not an answer another try cannot change", async () => {
    const retried = scripted([
      () => rpcError("TIMEOUT_ERROR"),
      () => new Response("", { status: 429 }),
      () => ok(1),
    ]);
    await expect(
      rpc([A], "m", {}, { fetch: retried.fetchFn, sleep: retried.sleep }),
    ).resolves.toMatchObject({
      value: 1,
    });
    expect(retried.sleeps).toEqual([500, 1500]);

    const moved = scripted([() => rpcError("UNKNOWN_TRANSACTION"), () => ok(2)]);
    await expect(
      rpc([A, B], "m", {}, { fetch: moved.fetchFn, sleep: moved.sleep }),
    ).resolves.toEqual({
      value: 2,
      host: "b.example",
    });
    expect(moved.sleeps).toEqual([]);
    expect(moved.calls.map((c) => c.url)).toEqual([A, B]);

    const http400 = scripted([() => new Response("", { status: 400 }), () => ok(3)]);
    await rpc([A, B], "m", {}, { fetch: http400.fetchFn, sleep: http400.sleep });
    expect(http400.sleeps).toEqual([]);
  });

  it("gives up on a host after its timeout, and says how long it waited", async () => {
    await expect(
      rpc([A], "m", {}, { fetch: hanging, timeoutMs: 5, backoffMs: [] }),
    ).rejects.toEqual(new ReadError([{ host: "a.example", kind: "timeout", detail: "0.005" }]));
  });

  it("names each host's last answer when none gives a usable one", async () => {
    const s = scripted([
      () => new Response("", { status: 502 }),
      () => ok(null),
      () => new Response("not json", { status: 200 }),
      () => rpcError("lower case is not shown"),
    ]);
    const err = await rpc(
      [A, B, "https://c.example", "https://d.example"],
      "m",
      {},
      {
        fetch: s.fetchFn,
        backoffMs: [],
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReadError);
    expect((err as ReadError).failures).toEqual([
      { host: "a.example", kind: "http", detail: "502" },
      { host: "b.example", kind: "none", detail: "" },
      { host: "c.example", kind: "body", detail: "" },
      // A cause that is not a plain upper-case name is not shown: the code stands in for it.
      { host: "d.example", kind: "rpc", detail: "-32000" },
    ]);
  });

  it("moves to the next host when the answer cannot be read, without a retry", async () => {
    const s = scripted([() => ok({ wrong: true }), () => ok({ right: true })]);
    const accept = (r: unknown) => {
      if (!(r as Json).right) throw new Error("unreadable");
      return r;
    };
    await expect(
      rpc([A, B], "m", {}, { fetch: s.fetchFn, sleep: s.sleep }, accept),
    ).resolves.toEqual({
      value: { right: true },
      host: "b.example",
    });
    expect(s.sleeps).toEqual([]);
  });

  it("stops at once with the caller's reason when the caller aborts", async () => {
    const ctl = new AbortController();
    const stop = new Error("stop");
    const p = rpc([A, B], "m", {}, { fetch: hanging, signal: ctl.signal });
    ctl.abort(stop);
    await expect(p).rejects.toBe(stop);
    // Aborted already: no fetch at all.
    let asked = 0;
    const counting = (async () => {
      asked += 1;
      return ok(1);
    }) as typeof fetch;
    await expect(rpc([A], "m", {}, { fetch: counting, signal: ctl.signal })).rejects.toBe(stop);
    expect(asked).toBe(0);
  });

  it("stops waiting between tries when the caller aborts", async () => {
    const ctl = new AbortController();
    const stop = new Error("stop");
    const s = scripted([() => new Response("", { status: 503 })]);
    const p = rpc([A], "m", {}, { fetch: s.fetchFn, signal: ctl.signal, backoffMs: [60_000] });
    setTimeout(() => ctl.abort(stop), 5);
    await expect(p).rejects.toBe(stop);
    expect(s.calls).toHaveLength(1);
  });
});

// --- a whole run ----------------------------------------------------------------------------------

/** The JSON-RPC result a node gives for each recorded read: views get their raw shape back. */
function answerFor(body: Json): unknown {
  if (body.method === "eth_getTransactionReceipt") {
    return (body.params as unknown[])[0] === P.tx.base ? S1.reads.base : null;
  }
  const params = body.params as Json;
  if (body.method === "EXPERIMENTAL_tx_status") {
    const name = (["mandate", "spend", "anchor"] as const).find(
      (n) => P.tx[n].hash === params.tx_hash,
    );
    return name === undefined ? null : S1.reads[name];
  }
  if (body.method === "query" && params.request_type === "call_function") {
    const c = S1.reads.config as Json;
    return {
      block_hash: c.block_hash,
      block_height: c.block_height,
      logs: [],
      result: [...new TextEncoder().encode(JSON.stringify(c.value))],
    };
  }
  if (body.method === "query" && params.request_type === "view_access_key") return S1.reads.key;
  if (body.method === "query" && params.request_type === "view_account") return S1.reads.account;
  return null;
}

/** A fetch that answers like the chain, from the recorded reads; `down` hosts answer HTTP 503. */
function chain(down: readonly string[] = []) {
  const urls: string[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    if (down.some((d) => String(url).startsWith(d))) return new Response("", { status: 503 });
    return ok(answerFor(JSON.parse(String(init?.body)) as Json));
  }) as typeof fetch;
  return { urls, fetchFn };
}

describe("runPayout", () => {
  it("reads 4 transactions and 3 views, reports each read and check once, and passes 7 of 7", async () => {
    const c = chain();
    const reads: ReadName[] = [];
    const checks: PayoutCheckId[] = [];
    const clock = [1_000, 3_500];
    const result = await runPayout(P, {
      fetch: c.fetchFn,
      onRead: (n) => reads.push(n),
      onCheck: (id, o) => {
        checks.push(id);
        expect(o.state).toBe("pass");
      },
      now: () => clock.shift() ?? 0,
    });
    expect(c.urls).toHaveLength(7);
    expect([...reads].sort()).toEqual([...READ_NAMES].sort());
    expect([...checks].sort()).toEqual(CHECKS.map((x) => x.id).sort());
    expect(result.tally).toEqual({ total: 7, pass: 7, fail: 0, unread: 0, state: "pass" });
    expect(result.startedAt).toBe(1_000);
    expect(result.ms).toBe(2_500);
    expect([...result.hosts].sort()).toEqual([
      "archival-rpc.mainnet.fastnear.com",
      "mainnet.base.org",
    ]);
    // No request goes anywhere but the public hosts.
    for (const u of c.urls) expect([...NEAR_RPC_URLS, ...BASE_RPC_URLS]).toContain(u);
  });

  it("falls back to the regular node when the archival one is down", async () => {
    const c = chain([NEAR_RPC_URLS[0] as string]);
    const result = await runPayout(P, { fetch: c.fetchFn, sleep: async () => {} });
    expect(result.tally.state).toBe("pass");
    expect(result.hosts.sort()).toEqual(["mainnet.base.org", "rpc.mainnet.fastnear.com"]);
    // 6 NEAR reads, 3 tries each on the archival node, then 1 on the regular one; 1 Base read.
    expect(c.urls).toHaveLength(6 * 4 + 1);
  });

  it("moves to the next node when one answers for another transaction, or not yet final", async () => {
    for (const wrong of [
      S1.reads.anchor,
      { ...(S1.reads.spend as Json), final_execution_status: "EXECUTED_OPTIMISTIC" },
    ]) {
      const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Json;
        const spend = (body.params as Json).tx_hash === P.tx.spend.hash;
        return ok(String(url) === NEAR_RPC_URLS[0] && spend ? wrong : answerFor(body));
      }) as typeof fetch;
      const result = await runPayout(P, { fetch: fetchFn, sleep: async () => {} });
      expect(result.tally.state).toBe("pass");
      expect(result.reads.spend).toMatchObject({ ok: true, host: "rpc.mainnet.fastnear.com" });
      expect(result.reads.anchor).toMatchObject({
        ok: true,
        host: "archival-rpc.mainnet.fastnear.com",
      });
    }
  });

  it("says 07 could not be read when Base answers for another transaction or without its logs", async () => {
    for (const wrong of [
      { ...(S1.reads.base as Json), transactionHash: `0x${"ab".repeat(32)}` },
      { status: "0x1", transactionHash: P.tx.base },
    ]) {
      const fetchFn = (async (_: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Json;
        return ok(body.method === "eth_getTransactionReceipt" ? wrong : answerFor(body));
      }) as typeof fetch;
      const result = await runPayout(P, { fetch: fetchFn, sleep: async () => {} });
      expect(result.tally).toMatchObject({ pass: 6, unread: 1, fail: 0, state: "unread" });
      expect(result.reads.base).toMatchObject({ ok: false });
    }
  });

  it("says a check could not be read when its host is down, and keeps the other checks", async () => {
    const c = chain([BASE_RPC_URLS[0] as string]);
    const result = await runPayout(P, { fetch: c.fetchFn, sleep: async () => {} });
    expect(result.tally).toMatchObject({ pass: 6, unread: 1, fail: 0, state: "unread" });
    expect(result.reads.base).toEqual({
      ok: false,
      failures: [{ host: "mainnet.base.org", kind: "http", detail: "503" }],
    });
  });

  it("rejects with the caller's reason when aborted, and reports nothing after", async () => {
    const ctl = new AbortController();
    const stop = new Error("stop");
    let reported = 0;
    const p = runPayout(P, {
      fetch: hanging,
      signal: ctl.signal,
      onRead: () => {
        reported += 1;
      },
      onCheck: () => {
        reported += 1;
      },
    });
    ctl.abort(stop);
    await expect(p).rejects.toBe(stop);
    expect(reported).toBe(0);
  });
});

describe("the ledger's hash chain", () => {
  it("hashes with SHA-256 as node:crypto does, over one block and over several", () => {
    const long = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7 + 3) % 256);
    for (const data of [new Uint8Array(0), new TextEncoder().encode("abc"), long]) {
      const want = createHash("sha256").update(data).digest("hex");
      expect(Buffer.from(sha256(data)).toString("hex")).toBe(want);
    }
  });

  it("reads base58, keeps leading zeros, and refuses a character outside the alphabet", () => {
    expect([...(base58("2g") ?? [])]).toEqual([0x61]);
    expect([...(base58("11") ?? [])]).toEqual([0, 0]);
    expect(base58("0OIl")).toBeNull();
    for (const l of P.links) expect(base58(l.sig.slice("ed25519:".length))).toHaveLength(64);
  });

  it("hashes the ledger file's entries from the decision on to the root the anchor wrote", () => {
    const root = anchoredRoot();
    expect(chainLinks(P.links)).toBe(root);
    // The same links, by node:crypto: sha256(prev_link || body_hash || the raw signature).
    let link = "";
    for (const l of P.links) {
      const sig = base58(l.sig.slice("ed25519:".length)) as Uint8Array;
      link = createHash("sha256")
        .update(Buffer.from(l.prevLink, "hex"))
        .update(Buffer.from(l.bodyHash, "hex"))
        .update(sig)
        .digest("hex");
    }
    expect(link).toBe(root);
    expect(P.links[0]).toMatchObject({ seq: P.decision.seq, bodyHash: P.decision.bodyHash });
    expect(P.links.at(-1)?.seq).toBe(P.anchor.count - 1);
    expect(chainLinks([])).toBeNull();
  });
});

describe("formatting", () => {
  it("writes USDC base units with at least two decimals", () => {
    expect(usdc("1000000")).toBe("1.00");
    expect(usdc("997600")).toBe("0.9976");
    expect(usdc(2400n)).toBe("0.0024");
    expect(usdc("1500000")).toBe("1.50");
    expect(usdc("1")).toBe("0.000001");
    expect(usdc(-2400n)).toBe("-0.0024");
  });

  it("shortens hashes, addresses and keys the way the site labels them", () => {
    expect(shortHash("BdN7oB76hAv1o5iAGsyszQx6S5NwEuerYDsWguRbrSQ9")).toBe("BdN7oB76…rSQ9");
    expect(shortHash(P.tx.base)).toBe("0xc2df8f87…ea71");
    expect(shortHash("short")).toBe("short");
    expect(shortAddr(P.payee)).toBe("0xB22E…6EB27");
    expect(shortKey(P.agentKey)).toBe("ed25519:GADeVCXt…Cycd");
  });

  it("fills values and counts, and leaves an unknown name in place", () => {
    expect(fill("{n|entry|entries} and {m|anchor|anchors}", { n: 4, m: 1 })).toBe(
      "4 entries and 1 anchor",
    );
    expect(fill("{a}, {missing}", { a: "x" })).toBe("x, {missing}");
    expect(fill("{constructor}", {})).toBe("{constructor}");
  });
});
