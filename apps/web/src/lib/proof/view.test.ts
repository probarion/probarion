import {
  type CheckResult,
  type LedgerEntry,
  NETWORKS,
  runChecks,
  type Snapshot,
  type VerifyReport,
} from "@probarion/core";
import { describe, expect, it } from "vitest";
import { proofSnapshot, txHash } from "../../../test/fixtures/proof";
import { makeSnapshot } from "../../../test/fixtures/snapshot";
import { cli, PRE_LEDGER_FLAGS } from "./cli";
import { ledgerFileName } from "./ledger-file";
import {
  burnRows,
  chainCommand,
  HEADLINE_TEXT,
  headline,
  headlineNote,
  modelDecisionCount,
  proofIndexTarget,
  proofRows,
  unprovenRows,
} from "./view";

/** True when the text still holds a right-to-left override, a line separator or a BEL. */
const hasUnsafe = (text: string): boolean =>
  [...text].some((c) => [0x202e, 0x2028, 0x07].includes(c.codePointAt(0) ?? -1));

const V = "acme.vaults.probarion.near";
const PAY = txHash(1);
const ANCHOR = txHash(2);
const BURN = txHash(3);
const entry = (seq: number, kind: string, tx: string | null) =>
  ({
    body: {
      seq,
      kind,
      contract: tx ? { code: null, tx_hash: tx, spend_id: 1, status: "paid" } : null,
    },
    body_hash: String(seq).repeat(64).slice(0, 64),
  }) as unknown as LedgerEntry;

const check = (id: CheckResult["id"], status: string, detail = "ok"): CheckResult =>
  ({ id, name: `check-${id}`, status, detail }) as CheckResult;

const report: VerifyReport = {
  vault: V,
  network: "mainnet",
  ok: false,
  entries: 3,
  anchors: 1,
  generated_at: "2026-11-09T00:00:00Z",
  unproven: [],
  checks: [
    { id: "a", name: "ledger-signatures", status: "pass", detail: "3 signatures" },
    { id: "b", name: "hash-links", status: "pass", detail: "3 links" },
    {
      id: "c",
      name: "anchors",
      status: "fail",
      detail: "anchor 1 root mismatch",
      firstBrokenSeq: 2,
    },
    { id: "d", name: "spends-have-decisions", status: "pass", detail: "1 spend" },
    { id: "e", name: "attestations", status: "pass", detail: "0 attested" },
    { id: "f", name: "vault-locked", status: "pass", detail: "locked" },
    { id: "g", name: "intents-keys", status: "pass", detail: "no keys" },
    { id: "h", name: "burn-memos", status: "pass", detail: "1 burn" },
    { id: "i", name: "factory-version", status: "pass", detail: "v1" },
  ],
};

const snap = makeSnapshot({
  vault: V,
  ledgerKey: "ed25519:LK",
  ledger: [entry(0, "decision", null), entry(1, "payment", PAY), entry(2, "anchor", ANCHOR)],
  burns: [
    {
      spend_id: 1,
      tx_hash: BURN,
      memo: "WITHDRAW_TO:0x5290",
      intents_owner: V,
      amount: "5000000",
      status: "ok",
    },
  ],
});
const byId = (rows: ReturnType<typeof proofRows>) => Object.fromEntries(rows.map((r) => [r.id, r]));
const hrefs = (rows: ReturnType<typeof proofRows>, id: string) =>
  (byId(rows)[id]?.links ?? []).map((l) => l.href);

describe("proof rows", () => {
  it("links each check to its on-chain evidence and keeps firstBrokenSeq", () => {
    const rows = proofRows(report, snap, "mainnet");
    const by = byId(rows);
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
    expect(hrefs(rows, "a")[0]).toBe(`https://nearblocks.io/address/${V}`);
    expect(hrefs(rows, "b")).toEqual([`/proof/${V}/snapshot.json`]);
    expect(hrefs(rows, "c")).toContain(`https://nearblocks.io/txns/${ANCHOR}`);
    expect(by.c?.firstBrokenSeq).toBe(2);
    expect(by.a?.firstBrokenSeq).toBeUndefined();
    expect(hrefs(rows, "d")).toContain(`https://nearblocks.io/txns/${PAY}`);
    expect(hrefs(rows, "e")).toEqual(["https://docs.near.ai/cloud/verification"]);
    expect(hrefs(rows, "f")).toEqual([`https://nearblocks.io/address/${V}`]);
    expect(hrefs(rows, "g")).toEqual(["https://nearblocks.io/address/intents.near"]);
    expect(hrefs(rows, "h")).toContain(`https://nearblocks.io/txns/${BURN}`);
    expect(hrefs(rows, "i")).toEqual(["https://nearblocks.io/address/vaults.probarion.near"]);
    expect(by.d?.links.find((l) => l.href?.endsWith(PAY))?.label).toBe("payment tx, seq 1");
    expect(by.h?.links[0]?.label).toBe("burn tx for spend #1");
    expect(by.c?.links[0]?.label).toBe("anchor tx, seq 2");
  });

  it("keeps each check's name, detail and status", () => {
    const by = byId(proofRows(report, snap, "mainnet"));
    expect(by.c).toMatchObject({
      name: "anchors",
      status: "fail",
      detail: "anchor 1 root mismatch",
    });
    expect(by.a).toMatchObject({
      name: "ledger-signatures",
      status: "pass",
      detail: "3 signatures",
    });
  });

  it("shows the four statuses as they are and any other as unknown", () => {
    const statuses = ["pass", "fail", "skip", "unproven", "maybe", "", "PASS"];
    const r: VerifyReport = {
      ...report,
      checks: statuses.map((s, i) =>
        check((["a", "b", "c", "d", "e", "f", "g"] as const)[i] ?? "a", s),
      ),
    };
    expect(proofRows(r, snap, "mainnet").map((row) => row.status)).toEqual([
      "pass",
      "fail",
      "skip",
      "unproven",
      "unknown",
      "unknown",
      "unknown",
    ]);
  });

  it("always gives check c evidence: the vault's anchor calls, even with no anchor entry (R20)", () => {
    const bare = makeSnapshot({ vault: V, ledgerKey: "ed25519:LK", ledger: [] });
    const c = byId(proofRows(report, bare, "mainnet")).c;
    expect(c?.links).toEqual([
      { label: "Anchor calls on the vault", href: `https://nearblocks.io/address/${V}` },
    ]);
    const withAnchor = byId(proofRows(report, snap, "mainnet")).c;
    expect(withAnchor?.links.at(-1)).toEqual({
      label: "Anchor calls on the vault",
      href: `https://nearblocks.io/address/${V}`,
    });
    expect(withAnchor?.links.length).toBe(2);
  });

  it("links at most the last three transactions of a kind", () => {
    const many = makeSnapshot({
      vault: V,
      ledgerKey: "ed25519:LK",
      ledger: [1, 2, 3, 4, 5].map((i) => entry(i, "payment", txHash(10 + i))),
      burns: [1, 2, 3, 4].map((i) => ({
        spend_id: i,
        tx_hash: txHash(20 + i),
        memo: "m",
        intents_owner: V,
        amount: "1",
        status: "ok" as const,
      })),
    });
    const rows = proofRows(report, many, "mainnet");
    expect(hrefs(rows, "d")).toEqual(
      [3, 4, 5].map((i) => `https://nearblocks.io/txns/${txHash(10 + i)}`),
    );
    expect(hrefs(rows, "h")).toEqual(
      [2, 3, 4].map((i) => `https://nearblocks.io/txns/${txHash(20 + i)}`),
    );
  });

  it("gives a malformed tx hash no link and says so", () => {
    const bad = makeSnapshot({
      vault: V,
      ledgerKey: "ed25519:LK",
      ledger: [entry(0, "payment", "PAYTX"), entry(1, "anchor", "not a hash")],
      burns: [
        {
          spend_id: 4,
          tx_hash: "javascript:alert(1)",
          memo: "m",
          intents_owner: V,
          amount: "1",
          status: "ok",
        },
      ],
    });
    const by = byId(proofRows(report, bad, "mainnet"));
    expect(by.d?.links).toEqual([{ label: "payment tx, seq 0: malformed tx hash", href: null }]);
    expect(by.c?.links[0]).toEqual({ label: "anchor tx, seq 1: malformed tx hash", href: null });
    expect(by.h?.links).toEqual([{ label: "burn tx for spend #4: malformed tx hash", href: null }]);
    const burn = burnRows(bad, "mainnet")[0];
    expect(burn?.txUrl).toBeNull();
    expect(burn?.txNote).toBe("malformed tx hash");
  });

  it("uses the testnet explorer on testnet", () => {
    const t = { ...snap, network: "testnet" as const, vault: "v0.probarion.testnet" };
    t.chain = {
      ...t.chain,
      config: {
        ...t.chain.config,
        intents: NETWORKS.testnet.intents,
        factory: NETWORKS.testnet.factory,
      },
    };
    const rows = proofRows(report, t, "testnet");
    expect(hrefs(rows, "a")).toEqual([
      "https://testnet.nearblocks.io/address/v0.probarion.testnet",
    ]);
    expect(hrefs(rows, "d")).toContain(`https://testnet.nearblocks.io/txns/${PAY}`);
    expect(hrefs(rows, "i")).toEqual([
      "https://testnet.nearblocks.io/address/vaults.probarion.testnet",
    ]);
    expect(burnRows(t, "testnet")[0]?.txUrl).toBe(`https://testnet.nearblocks.io/txns/${BURN}`);
  });

  it("links no factory for a vault that has none, and no account that is not an account id", () => {
    const plain = {
      ...snap,
      chain: { ...snap.chain, config: { ...snap.chain.config, factory: null } },
    };
    expect(hrefs(proofRows(report, plain, "mainnet"), "i")).toEqual([]);
    const odd = {
      ...snap,
      chain: {
        ...snap.chain,
        config: { ...snap.chain.config, intents: "Not An Account", factory: "../x" },
      },
    };
    const by = byId(proofRows(report, odd, "mainnet"));
    expect(by.g?.links).toEqual([{ label: "Not An Account: not an account id", href: null }]);
    expect(by.i?.links).toEqual([{ label: "../x: not an account id", href: null }]);
  });

  it("passes every string from the ledger or the chain through the sanitiser", () => {
    const evil = "pass\u202Eliaf\u2028\u0007";
    const r: VerifyReport = {
      ...report,
      checks: [
        { id: "c", name: `anchors${evil}`, status: "fail", detail: `detail${evil}` },
        { id: "h", name: "burn-memos", status: "pass", detail: "ok" },
      ],
    };
    const s = makeSnapshot({
      vault: V,
      ledgerKey: "ed25519:LK",
      ledger: [
        { body: { seq: `1${evil}`, kind: "anchor", contract: { tx_hash: ANCHOR } } } as never,
      ],
      burns: [
        {
          spend_id: `7${evil}` as never,
          tx_hash: BURN,
          memo: `WITHDRAW_TO:${evil}`,
          intents_owner: `x${evil}`,
          amount: `1${evil}`,
          status: `ok${evil}` as never,
        },
      ],
    });
    const [row, h] = proofRows(r, s, "mainnet");
    const shown = [row?.name, row?.detail, ...(row?.links ?? []).map((l) => l.label)].join("|");
    // The burn link of check h is labelled with the spend id the chain gave.
    expect(h?.links[0]?.label).toBe("burn tx for spend #7pass\uFFFDliaf\uFFFD\uFFFD");
    const burn = burnRows(s, "mainnet")[0];
    const burnShown = Object.values(burn ?? {}).join("|");
    for (const text of [shown, burnShown]) {
      expect(hasUnsafe(text)).toBe(false);
      expect(text).toContain("\uFFFD");
    }
    expect(burn?.status).toBe("unknown");
  });
});

describe("burn rows (D9)", () => {
  it("renders burns with memo, amount and intents owner", () => {
    expect(burnRows(snap, "mainnet")).toEqual([
      {
        spendId: "1",
        txUrl: `https://nearblocks.io/txns/${BURN}`,
        txNote: null,
        memo: "WITHDRAW_TO:0x5290",
        amount: "5 USDC",
        intentsOwner: V,
        intentsOwnerUrl: `https://nearblocks.io/address/${V}`,
        status: "ok",
      },
    ]);
  });

  it("shows an amount that is not a decimal as it is, and an owner that is not an account without a link", () => {
    const s = makeSnapshot({
      vault: V,
      ledgerKey: "ed25519:LK",
      ledger: [],
      burns: [
        {
          spend_id: 2,
          tx_hash: BURN,
          memo: "",
          intents_owner: "Bad Owner",
          amount: "-5",
          status: "missing",
        },
        {
          spend_id: 3,
          tx_hash: txHash(4),
          memo: "m",
          intents_owner: V,
          amount: "1500000",
          status: "unavailable",
        },
      ],
    });
    const [a, b] = burnRows(s, "mainnet");
    expect(a).toMatchObject({
      amount: "-5 (not a USDC amount)",
      intentsOwner: "Bad Owner",
      intentsOwnerUrl: null,
      status: "missing",
    });
    expect(b).toMatchObject({ amount: "1.5 USDC", status: "unavailable" });
  });

  it("lists no burns when the snapshot has none", () => {
    expect(burnRows(makeSnapshot({ vault: V, ledgerKey: "k", ledger: [] }), "mainnet")).toEqual([]);
  });
});

describe("unproven burns (T14-R2)", () => {
  const unprovenReport = (reasons: string[]): VerifyReport => ({
    ...report,
    unproven: reasons.map((reason, i) => ({ check: "h", spend_id: i + 1, reason }) as never),
  });

  it("says why in plain words and how to prove it, with the CLI's own flags", () => {
    const rows = unprovenRows(
      unprovenReport(["tx_unavailable", "approver_tx", "not_recorded", "pre_ledger_no_tx"]),
      "testnet",
      "v0.probarion.testnet",
    );
    expect(rows.map((r) => r.reason)).toEqual([
      "tx_unavailable",
      "approver_tx",
      "not_recorded",
      "pre_ledger_no_tx",
    ]);
    expect(rows[0]).toMatchObject({
      spendId: "1",
      why: "Its burn transaction could not be read right now (a node outage, or a transaction old enough to need an archival RPC).",
      hint: cli(
        "verify --network testnet --vault v0.probarion.testnet --ledger probarion-v0.probarion.testnet-ledger.jsonl --archival-rpc <archival RPC URLs>",
      ),
    });
    expect(rows[1]).toMatchObject({
      spendId: "2",
      why: "An approver paid this held spend out. Its burn is in the approver's transaction, which was not read.",
      hint: cli(
        "verify --network testnet --vault v0.probarion.testnet --ledger probarion-v0.probarion.testnet-ledger.jsonl --burn-tx 2=<tx hash>",
      ),
    });
    expect(rows[2]?.why).toBe(
      "No payment entry in the ledger names the transaction that burned it.",
    );
    expect(rows[2]?.hint).toBe(
      cli(
        "verify --network testnet --vault v0.probarion.testnet --ledger probarion-v0.probarion.testnet-ledger.jsonl --burn-tx 3=<tx hash>",
      ),
    );
    expect(rows[3]?.why).toBe(
      "It predates the signed ledger, and nobody has supplied the transaction that burned it.",
    );
    // Mainnet v0 only: the CLI needs the documented Day-4 decisions, which are in the repository at docs/evidence.
    expect(rows[3]?.hint).toBe(
      cli(
        `verify --network testnet --vault v0.probarion.testnet --ledger probarion-v0.probarion.testnet-ledger.jsonl ${PRE_LEDGER_FLAGS} --burn-tx 4=<tx hash>`,
      ),
    );
  });

  it("names an unknown reason without trusting it, and never puts a crafted spend id in a command", () => {
    const r: VerifyReport = {
      ...report,
      unproven: [
        { check: "h", spend_id: "1;rm -rf /\u202E" as never, reason: "new\u2028reason" as never },
      ],
    };
    const [row] = unprovenRows(r, "mainnet", V);
    expect(row?.reason).toBe("new\uFFFDreason");
    expect(row?.why).toBe("This page does not know the reason new\uFFFDreason.");
    expect(row?.hint).toBe(
      cli(
        `verify --network mainnet --vault ${V} --ledger probarion-${V}-ledger.jsonl --burn-tx <spend_id>=<tx hash>`,
      ),
    );
    expect(row?.spendId).toBe("1;rm -rf /\uFFFD");
  });

  it("The page links the vault's ledger file for it: every hint passes --ledger <that file>", () => {
    const reasons = ["tx_unavailable", "approver_tx", "not_recorded", "pre_ledger_no_tx", "other"];
    for (const network of ["mainnet", "testnet"] as const) {
      const rows = unprovenRows(unprovenReport(reasons), network, V);
      expect(rows).toHaveLength(reasons.length);
      for (const row of rows) {
        expect(row.hint, row.reason).toContain(` --ledger probarion-${V}-ledger.jsonl --`);
        expect(
          row.hint.startsWith(
            cli(`verify --network ${network} --vault ${V} --ledger probarion-${V}-ledger.jsonl --`),
          ),
          row.hint,
        ).toBe(true);
      }
    }
  });

  it("lists none when nothing is unproven, or when the list is not a list", () => {
    expect(unprovenRows(report, "mainnet", V)).toEqual([]);
    expect(unprovenRows({ ...report, unproven: undefined as never }, "mainnet", V)).toEqual([]);
  });
});

describe("headline (three states, R19)", () => {
  const reportOf = (statuses: string[], ok: boolean): VerifyReport => ({
    ...report,
    ok,
    checks: statuses.map((s, i) => check((["a", "b", "c", "d"] as const)[i] ?? "a", s)),
  });

  it("is green only when the report is ok, amber for unproven, red for any fail", () => {
    expect(headline(reportOf(["pass", "pass", "skip"], true))).toBe("ok");
    expect(headline(reportOf(["pass", "unproven"], false))).toBe("unproven");
    expect(headline(reportOf(["pass", "fail", "unproven"], false))).toBe("failed");
    expect(headline(reportOf(["fail"], true))).toBe("failed");
  });

  it("never shows green for a report that is not ok, an unknown status or no checks", () => {
    expect(headline(reportOf(["pass", "pass"], false))).toBe("unproven");
    expect(headline(reportOf(["pass", "maybe"], true))).toBe("unproven");
    expect(headline(reportOf([], true))).toBe("unproven");
  });

  it("says 'All offline checks pass', never 'All checks pass'", () => {
    expect(HEADLINE_TEXT).toEqual({
      ok: "All offline checks pass",
      unproven: "Not proven yet",
      failed: "A check failed",
    });
  });

  it("agrees with core on real snapshots in each state", async () => {
    for (const state of ["ok", "unproven", "failed"] as const) {
      const s: Snapshot = await proofSnapshot(state);
      expect(headline(await runChecks(s)), state).toBe(state);
    }
  });
});

describe("/proof with no vault", () => {
  it("sends it to the demo vault, and to nothing when there is no valid one", () => {
    expect(proofIndexTarget("demo.vaults.probarion.near")).toBe(
      "/proof/demo.vaults.probarion.near",
    );
    expect(proofIndexTarget("v0.probarion.testnet")).toBe("/proof/v0.probarion.testnet");
    expect(proofIndexTarget(null)).toBeNull();
    expect(proofIndexTarget("")).toBeNull();
    for (const bad of ["../etc", "a..b", "UPPER.near", "a/b", "x", "a.near\n", "a".repeat(65)]) {
      expect(proofIndexTarget(bad), bad).toBeNull();
    }
  });
});

describe("proof rows: labels and odd input", () => {
  it("labels each link for a reader", () => {
    const by = byId(proofRows(report, snap, "mainnet"));
    expect(by.a?.links[0]?.label).toBe("Vault account and keys");
    expect(by.b?.links[0]?.label).toBe("snapshot.json");
    expect(by.e?.links[0]?.label).toBe("How NEAR AI Cloud attestation works");
    expect(by.g?.links[0]?.label).toBe("intents.near");
    expect(by.i?.links[0]?.label).toBe("vaults.probarion.near");
  });

  it("gives a burn record that names no tx no link, and says so", () => {
    const s = makeSnapshot({
      vault: V,
      ledgerKey: "k",
      ledger: [
        entry(0, "payment", null),
        { body: { seq: 1, kind: "payment", contract: { tx_hash: "" } } } as never,
      ],
      burns: [
        { spend_id: 1, tx_hash: "", memo: "", intents_owner: V, amount: "1", status: "missing" },
        {
          spend_id: 2,
          tx_hash: null as never,
          memo: "",
          intents_owner: V,
          amount: "1",
          status: "missing",
        },
        {
          spend_id: 3,
          tx_hash: undefined as never,
          memo: "",
          intents_owner: V,
          amount: "1",
          status: "missing",
        },
      ],
    });
    const by = byId(proofRows(report, s, "mainnet"));
    expect(by.h?.links).toEqual([]);
    expect(by.d?.links).toEqual([]);
    expect(burnRows(s, "mainnet").map((b) => [b.txUrl, b.txNote])).toEqual([
      [null, "no tx recorded"],
      [null, "no tx recorded"],
      [null, "no tx recorded"],
    ]);
  });

  it("skips list items that are not records, and never throws on a snapshot without its chain", () => {
    const s = makeSnapshot({ vault: V, ledgerKey: "k", ledger: ["junk", 7, null, [1]] as never });
    s.chain.burns = ["junk", 7, null, [BURN], snap.chain.burns[0]] as never;
    expect(burnRows(s, "mainnet")).toHaveLength(1);
    expect(byId(proofRows(report, s, "mainnet")).d?.links).toEqual([]);
    const bare = { ...snap, chain: undefined } as never as Snapshot;
    const rows = proofRows(report, bare, "mainnet");
    expect(byId(rows).g?.links).toEqual([{ label: "undefined: not an account id", href: null }]);
    expect(burnRows(bare, "mainnet")).toEqual([]);
    const noConfig = { ...snap, chain: { ...snap.chain, config: null } } as never as Snapshot;
    expect(byId(proofRows(report, noConfig, "mainnet")).i?.links).toEqual([]);
  });

  it("sanitises a value that is not an account id before naming it", () => {
    const odd = {
      ...snap,
      chain: {
        ...snap.chain,
        config: { ...snap.chain.config, intents: `a${String.fromCharCode(0x202e)}b` },
      },
    };
    expect(byId(proofRows(report, odd, "mainnet")).g?.links[0]?.label).toBe(
      "a\uFFFDb: not an account id",
    );
  });

  it("gives a check id core does not define no evidence, inherited names included", () => {
    const r = {
      ...report,
      checks: [
        check("z" as never, "pass"),
        check("constructor" as never, "pass"),
        check("toString" as never, "pass"),
      ],
    };
    expect(proofRows(r, snap, "mainnet").map((row) => row.links)).toEqual([[], [], []]);
  });

  it("refuses an amount with a leading zero as a USDC amount", () => {
    const s = makeSnapshot({ vault: V, ledgerKey: "k", ledger: [] });
    s.chain.burns = [
      { ...(snap.chain.burns[0] as Snapshot["chain"]["burns"][number]), amount: "05000000" },
    ];
    expect(burnRows(s, "mainnet")[0]?.amount).toBe("05000000 (not a USDC amount)");
    s.chain.burns = [
      { ...(snap.chain.burns[0] as Snapshot["chain"]["burns"][number]), amount: "0" },
    ];
    expect(burnRows(s, "mainnet")[0]?.amount).toBe("0 USDC");
  });
});

describe("unproven burns: the spend id in the command", () => {
  it("is the id when it is a whole number from 0, else a placeholder", () => {
    const ids: unknown[] = [0, 1, 9007199254740991, -1, 1.5, "3", 9007199254740992, null];
    const r = {
      ...report,
      unproven: ids.map((spend_id) => ({ check: "h", spend_id, reason: "not_recorded" })),
    } as never as VerifyReport;
    expect(unprovenRows(r, "mainnet", V).map((u) => u.hint.split("--burn-tx ")[1])).toEqual([
      "0=<tx hash>",
      "1=<tx hash>",
      "9007199254740991=<tx hash>",
      "<spend_id>=<tx hash>",
      "<spend_id>=<tx hash>",
      "<spend_id>=<tx hash>",
      "<spend_id>=<tx hash>",
      "<spend_id>=<tx hash>",
    ]);
  });
});

describe("the sentence under the headline", () => {
  const withChecks = (
    statuses: [string, string][],
    over: Partial<VerifyReport> = {},
  ): VerifyReport => ({
    ...report,
    ok: false,
    checks: statuses.map(([id, s]) => check(id as never, s)),
    ...over,
  });

  it("ok: says no check failed or is unproven on this snapshot, and names a skipped check", () => {
    expect(
      headlineNote(
        withChecks(
          [
            ["a", "pass"],
            ["i", "pass"],
          ],
          { ok: true },
        ),
      ),
    ).toBe("No check failed or is unproven on this snapshot.");
    const skipped = withChecks(
      [
        ["a", "pass"],
        ["i", "skip"],
      ],
      { ok: true },
    );
    (skipped.checks[1] as { detail: string }).detail = "not a factory vault";
    expect(headlineNote(skipped)).toBe(
      "No check failed or is unproven on this snapshot. Check (i) was skipped: not a factory vault.",
    );
  });

  it("unproven: counts the burned spends, in the singular and the plural", () => {
    const one = withChecks([["h", "unproven"]], {
      unproven: [{ check: "h", spend_id: 1, reason: "not_recorded" }],
    });
    expect(headlineNote(one)).toBe(
      "No check failed, but 1 burned spend is not proven from this snapshot. Check (h) says what is missing.",
    );
    const two = withChecks([["h", "unproven"]], {
      unproven: [
        { check: "h", spend_id: 1, reason: "not_recorded" },
        { check: "h", spend_id: 2, reason: "approver_tx" },
      ],
    });
    expect(headlineNote(two)).toBe(
      "No check failed, but 2 burned spends are not proven from this snapshot. Check (h) says what is missing.",
    );
    expect(headlineNote(withChecks([["a", "maybe"]]))).toBe(
      "No check failed, but not every check could be proven.",
    );
    // A report whose unproven list is missing counts no spend.
    expect(headlineNote(withChecks([["a", "maybe"]], { unproven: undefined as never }))).toBe(
      "No check failed, but not every check could be proven.",
    );
  });

  it("failed: names every failed check and the first broken entry, when one is known", () => {
    const r = withChecks([
      ["a", "pass"],
      ["c", "fail"],
      ["f", "fail"],
    ]);
    r.checks[1] = { ...(r.checks[1] as CheckResult), firstBrokenSeq: 4 };
    r.checks[2] = { ...(r.checks[2] as CheckResult), firstBrokenSeq: 2 };
    expect(headlineNote(r)).toBe(
      "Failed: checks (c), (f). The first broken ledger entry is seq 2.",
    );
    expect(headlineNote(withChecks([["g", "fail"]]))).toBe("Failed: check (g).");
    const evil = withChecks([["c", "fail"]]);
    (evil.checks[0] as { id: string }).id = `c${String.fromCharCode(0x202e)}`;
    expect(headlineNote(evil)).toBe("Failed: check (c\uFFFD).");
  });
});

describe("decisions made with model output (the line under check e)", () => {
  it("counts the ledger entries decided by model and rules, with or without an attestation", () => {
    const decision = (decided_by: unknown, evidence: unknown) =>
      ({ body: { seq: 0, kind: "decision", decided_by, evidence } }) as never;
    const rulesOnly = makeSnapshot({
      vault: V,
      ledgerKey: "k",
      ledger: [decision("rules-only", null)],
    });
    expect(modelDecisionCount(rulesOnly)).toBe(0);
    // A rules-only decision that carries the caller's evidence (SDK raw mode) is still not model output.
    expect(
      modelDecisionCount(
        makeSnapshot({
          vault: V,
          ledgerKey: "k",
          ledger: [decision("rules-only", { quote: "q" })],
        }),
      ),
    ).toBe(0);
    const mixed = makeSnapshot({
      vault: V,
      ledgerKey: "k",
      ledger: [
        decision("model+rules", { quote: "q" }),
        decision("model+rules", null),
        decision("rules-only", { quote: "q" }),
        "junk" as never,
      ],
    });
    expect(modelDecisionCount(mixed)).toBe(2);
    // A decision whose decided_by is null or unknown is not rules-only: check e fails it, so it counts.
    const odd = (decided_by: unknown, kind = "decision") =>
      ({ body: { seq: 0, kind, decided_by, evidence: null } }) as never;
    for (const value of [null, undefined, "model-only", ""]) {
      expect(
        modelDecisionCount(makeSnapshot({ vault: V, ledgerKey: "k", ledger: [odd(value)] })),
        String(value),
      ).toBe(1);
    }
    // Other entries count only when they say model+rules (core attests those whatever their kind).
    expect(
      modelDecisionCount(
        makeSnapshot({
          vault: V,
          ledgerKey: "k",
          ledger: [odd(null, "payment"), odd(undefined, "anchor"), odd("model+rules", "payment")],
        }),
      ),
    ).toBe(1);
    expect(modelDecisionCount({ ...rulesOnly, ledger: "x" } as never)).toBe(0);
  });
});

describe("the vault's ledger file and the chain command", () => {
  it("names the ledger file after the vault", () => {
    expect(ledgerFileName(V)).toBe(`probarion-${V}-ledger.jsonl`);
  });

  it("passes that file as --ledger in the chain command, so an anchored vault checks out", () => {
    expect(chainCommand("testnet", V)).toBe(
      cli(`verify --network testnet --vault ${V} --ledger probarion-${V}-ledger.jsonl`),
    );
  });

  it("adds the pre-ledger evidence for mainnet v0, the one vault whose check d needs it, and nowhere else", () => {
    const v0 = "v0.probarion.near";
    expect(chainCommand("mainnet", v0)).toBe(
      cli(
        `verify --network mainnet --vault ${v0} --ledger probarion-${v0}-ledger.jsonl ${PRE_LEDGER_FLAGS}`,
      ),
    );
    expect(chainCommand("testnet", "v0.probarion.testnet")).not.toContain("--evidence");
    expect(chainCommand("mainnet", V)).not.toContain("--evidence");
  });

  it("builds every hint on the chain command, so a flag added there reaches the hints", () => {
    const v0 = "v0.probarion.near";
    const r = {
      ...report,
      unproven: [{ check: "h", spend_id: 2, reason: "not_recorded" }],
    } as never as VerifyReport;
    const [row] = unprovenRows(r, "mainnet", v0);
    expect(row?.hint).toBe(`${chainCommand("mainnet", v0)} --burn-tx 2=<tx hash>`);
    const [plain] = unprovenRows(r, "testnet", "v0.probarion.testnet");
    expect(plain?.hint).toBe(
      `${chainCommand("testnet", "v0.probarion.testnet")} --burn-tx 2=<tx hash>`,
    );
  });
});
