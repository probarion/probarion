// The demo vault's record on NEAR testnet (audit P1-5), in the docs since the landing's journey handed it over on
// 2026-11-14: the four real invoices under "The demo vault's four invoices" on start/how-one-payment-works, and the
// attested decisions under "Attested decisions on record" on trust/verifier-checks. Each row is held to STORY and
// ATTESTED in lib/site/facts.ts, and those to the evidence: the demo vault's in docs/evidence/demo-vault, the Canary's
// in docs/evidence/canary-vault, the mainnet vault's in docs/evidence/mainnet-v0 and the record in
// contracts/deployments/testnet.json, so the record cannot drift from what the chain and the signed ledgers show.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { explorerTxUrl } from "@/lib/config";
import { headingsOf } from "@/lib/docs/headings";
import { REPO_URL } from "@/lib/proof/cli";
import {
  ATTESTED,
  type AttestedCell,
  type CopyPart,
  type EvidenceLink,
  type EvidenceSlot,
  STORY,
} from "@/lib/site/facts";
import { fileOf, ROOT, readMdx } from "./docs-helpers";

const EVIDENCE = "docs/evidence/demo-vault";
const LEDGER = `${EVIDENCE}/ledger-2026-11-09.jsonl`;
const MAINNET = "docs/evidence/mainnet-v0/s2-2026-11-13";
const read = (path: string) => readFileSync(join(ROOT, path));
const sha256 = (path: string) => createHash("sha256").update(read(path)).digest("hex");
const blob = (path: string) => `${REPO_URL}/blob/main/${path}`;

type Rule = { id: string; outcome: string };
type Body = {
  seq: number;
  kind: string;
  verdict?: string;
  decided_by?: string;
  invoice_hash: string;
  amount?: string;
  proposal: unknown;
  evidence: unknown;
  rules: Rule[];
  contract: { tx_hash: string | null; status: string; spend_id: number } | null;
};
const ledgerOf = (path: string) =>
  read(path)
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { body: Body }).body);
const ledger = ledgerOf(LEDGER);
/** The demo vault's ledger after the filmed run: seventeen entries, the five attested decisions among them. */
const video = ledgerOf(`${EVIDENCE}/ledger-2026-11-12-video.jsonl`);
const demo = JSON.parse(read("contracts/deployments/testnet.json").toString("utf8")).demo_vault as {
  account: string;
  payee: string;
  spends: { id: number; invoice: string; amount: string; spend_tx: string; approve_tx?: string }[];
  refusals: { invoice: string; rule: string; ledger_seq: number }[];
};
const snapshot = JSON.parse(read(`${EVIDENCE}/snapshot-2026-11-09.json`).toString("utf8")) as {
  chain: {
    mandates: {
      id: number;
      max_per_payment: string;
      approval_above: string;
      payee: { account_id: string };
    }[];
  };
};
const [mandate] = snapshot.chain.mandates;

const INVOICES_PAGE = "start/how-one-payment-works";
const ATTESTED_PAGE = "trust/verifier-checks";

/** A page's lines under `heading`, up to the next heading of the same depth or higher. */
function sectionOf(path: string, heading: string): string {
  const lines = readMdx(path).split("\n");
  const at = lines.indexOf(heading);
  if (at < 0) throw new Error(`${fileOf(path)}: no "${heading}"`);
  const depth = heading.indexOf(" ");
  const end = lines.findIndex((l, i) => i > at && /^#{2,3} /.test(l) && l.indexOf(" ") <= depth);
  return lines.slice(at + 1, end < 0 ? undefined : end).join("\n");
}
const invoices = sectionOf(INVOICES_PAGE, "### The demo vault's four invoices");
const attested = sectionOf(ATTESTED_PAGE, "## Attested decisions on record");
/** Whitespace folded, so a sentence reads as one line. */
const flat = (s: string) => s.replace(/\s+/g, " ");
/** The rows of a section's Markdown table, its header row first, each as its lines. */
const rowLines = (section: string) =>
  section.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| --- "));
/** The same rows, each as its cells. No cell of these tables holds a pipe. */
const tableRows = (section: string) =>
  rowLines(section).map((l) =>
    l
      .slice(2, -2)
      .split(" | ")
      .map((c) => c.trim()),
  );
/** A Markdown heading of a repository file, by GitHub's slug. */
const slugsOf = (path: string) =>
  read(path)
    .toString("utf8")
    .split("\n")
    .filter((l) => /^#{1,6} /.test(l))
    .map((l) =>
      l
        .replace(/^#+ /, "")
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s/g, "-"),
    );

type Card = (typeof STORY.invoices)[number];
const linksOf = (slot: EvidenceSlot) => (typeof slot === "string" ? [] : slot);
const card = (invoice: string, again = false) => {
  const found = STORY.invoices.find((c) => c.invoice === invoice && "again" in c === again);
  if (found === undefined) throw new Error(`no row ${invoice}${again ? " again" : ""}`);
  return found;
};
const name = (c: Card) => ("again" in c ? `${c.invoice}, ${c.again}` : c.invoice);
/** A link as the page writes it: the verb, then the label, in code for a file name or a hash. */
const linkMd = (l: EvidenceLink, code: boolean) =>
  `${l.verb === undefined ? "" : `${l.verb} `}[${code ? `\`${l.label}\`` : l.label}](${l.url})`;
const slotMd = (slot: EvidenceSlot, code: boolean) =>
  typeof slot === "string" ? slot : slot.map((l) => linkMd(l, code)).join(", ");
/** An invoice's row of the page's table, from STORY: its name, what it asked, the outcome with its body, the slots. */
const rowOf = (c: Card) =>
  [
    `| ${name(c)} | ${c.asks} | **${c.outcome}.** ${c.body} |`,
    `${STORY.slots.invoice}: ${slotMd(c.evidence.invoice, true)}.`,
    `${STORY.slots.tx}: ${slotMd(c.evidence.tx, true)}.`,
    `${STORY.slots.ledger}: ${slotMd(c.evidence.ledger, false)}. |`,
  ].join(" ");
/** The ledger lines a link points at (`#L4` or `#L1-L3`), as the entries' seq numbers. */
const seqsOf = (url: string) => {
  const m = url.match(/#L(\d+)(?:-L(\d+))?$/);
  if (m === null) throw new Error(`not a line link: ${url}`);
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  return Array.from({ length: to - from + 1 }, (_, i) => ledger[from - 1 + i]?.seq);
};
const hrefsOf = (parts: readonly CopyPart[]) =>
  parts.flatMap((p) => (typeof p === "string" ? [] : [p.href]));
/**
 * Every file and transaction the record links, from STORY and ATTESTED. A ledger's name links the Canary's page on
 * the landing, which the docs do not link (docs-helpers.ts NOT_LINKED), so the names are left out.
 */
const RECORD_LINKS = [
  ...STORY.invoices.flatMap((c) =>
    [c.evidence.invoice, c.evidence.tx, c.evidence.ledger].flatMap(linksOf).map((l) => l.url),
  ),
  ...ATTESTED.ledgers.flatMap((l) => hrefsOf(l.sub)),
  ...ATTESTED.rows.flatMap((r) =>
    r.cells.flatMap((c: AttestedCell) => [...hrefsOf(c.detail), ...hrefsOf(c.more ?? [])]),
  ),
  ...ATTESTED.paid.txs.map((t) => t.tx.url),
  STORY.proof.href,
  STORY.files.url,
];

describe("the demo vault's four invoices, on the one-payment page (audit P1-5)", () => {
  it("sit under See it on testnet, right after the smoke run", () => {
    const heads = headingsOf(readMdx(INVOICES_PAGE));
    const see = heads.findIndex((h) => h.id === "see-it-on-testnet");
    const four = heads.findIndex((h) => h.id === "the-demo-vaults-four-invoices");
    expect(heads[see]?.depth).toBe(2);
    expect(heads[four]?.depth).toBe(3);
    expect(four).toBe(see + 1);
  });

  it("say who sent them, and state the mandate as the chain has it", () => {
    expect(mandate?.payee.account_id).toBe(demo.payee);
    expect(mandate?.max_per_payment).toBe("5000000");
    expect(mandate?.approval_above).toBe("3000000");
    const intro = flat(invoices);
    expect(intro).toContain(
      `we sent four invoices to our own demo vault, \`${demo.account}\`, on NEAR testnet.`,
    );
    expect(intro).toContain(
      `Its mandate pays \`${demo.payee}\`, at most 5 test USDC a payment, and holds anything above 3 for an approver.`,
    );
    expect(intro).toContain("Whatever an invoice says, the money goes to that payee");
  });

  it("say no model read them, as every first decision in the ledger shows", () => {
    expect(flat(invoices)).toContain("No model read these invoices");
    expect(ledger.every((e) => e.proposal === null)).toBe(true);
    for (const id of ["INV-2001", "INV-2002", "INV-2003"]) {
      const first = ledger.find((e) => e.invoice_hash === sha256(`${EVIDENCE}/invoice-${id}.txt`));
      expect(
        first?.rules.map((r) => r.id),
        id,
      ).toContain("custom.owner_confirms_without_model");
    }
  });

  it("are STORY's four rows, in its order, each with the same three evidence slots", () => {
    expect(STORY.slots).toEqual({ invoice: "Invoice", tx: "Transaction", ledger: "Ledger" });
    const rows = rowLines(invoices);
    expect(rows[0]).toBe(
      `| Invoice | ${STORY.head.asks} | ${STORY.head.happened} | ${STORY.head.evidence} |`,
    );
    expect(rows.slice(1)).toEqual(STORY.invoices.map(rowOf));
    for (const c of STORY.invoices) {
      expect(Object.keys(c.evidence), name(c)).toEqual(["invoice", "tx", "ledger"]);
      for (const slot of [c.evidence.invoice, c.evidence.tx, c.evidence.ledger]) {
        if (typeof slot !== "string") expect(slot.length, name(c)).toBeGreaterThan(0);
      }
    }
  });

  it("link each invoice row to the exact file the chain hashed, by the file's own name", () => {
    for (const c of STORY.invoices) {
      if ("again" in c) continue;
      const path = `${EVIDENCE}/invoice-${c.invoice}.txt`;
      expect(linksOf(c.evidence.invoice), c.invoice).toEqual([
        { label: `invoice-${c.invoice}.txt`, url: blob(path) },
      ]);
      expect(read(path).toString("utf8"), c.invoice).toContain(`Invoice ${c.invoice}`);
    }
    expect(read(`${EVIDENCE}/invoice-INV-2002.txt`).toString("utf8")).toContain(
      "We changed banks.",
    );
  });

  it("link every ledger entry of an invoice, and only that invoice's entries", () => {
    for (const c of STORY.invoices) {
      const [ledgerLink] = linksOf(c.evidence.ledger);
      if (ledgerLink === undefined) continue;
      expect(ledgerLink.url.startsWith(`${blob(LEDGER)}#L`), name(c)).toBe(true);
      const hash = sha256(`${EVIDENCE}/invoice-${c.invoice}.txt`);
      expect(seqsOf(ledgerLink.url), name(c)).toEqual(
        ledger.filter((e) => e.invoice_hash === hash).map((e) => e.seq),
      );
      const seqs = seqsOf(ledgerLink.url);
      const label = seqs.length === 1 ? `Entry ${seqs[0]}` : `Entries ${seqs[0]} to ${seqs.at(-1)}`;
      expect(ledgerLink.label, name(c)).toBe(label);
    }
  });

  it("pay INV-2001 with spend 1, the transaction the deployment record names", () => {
    const paid = card("INV-2001");
    const spend = demo.spends.find((s) => s.id === 1);
    expect(spend?.invoice).toBe("INV-2001");
    expect(spend?.amount).toBe("2000000");
    expect(paid.outcome).toBe("Paid");
    expect(paid.tone).toBe("paid");
    expect(paid.asks).toBe("2 test USDC to the mandate's payee");
    expect(linksOf(paid.evidence.tx)).toEqual([
      { label: "HFyW61UZ…dQp1", url: explorerTxUrl("testnet", spend?.spend_tx ?? "") },
    ]);
  });

  it("refuse the same file again on upload, in the console's own words, with nothing in the ledger", () => {
    const again = card("INV-2001", true);
    expect("again" in again ? again.again : undefined).toBe("sent again");
    expect(again.outcome).toBe("Refused on upload");
    expect(again.evidence).toEqual({
      invoice: "Same file as above",
      tx: "None, nothing was sent",
      ledger: "No entry",
    });
    const route = read("apps/web/src/app/api/console/[vault]/invoices/route.ts").toString("utf8");
    expect(route).toContain('"This invoice was already processed."');
    expect(again.body).toContain('"This invoice was already processed."');
    // Spend 1's three entries are all the ledger holds for that file: the second upload added none.
    const hash = sha256(`${EVIDENCE}/invoice-INV-2001.txt`);
    expect(ledger.filter((e) => e.invoice_hash === hash).map((e) => e.kind)).toEqual([
      "decision",
      "decision",
      "payment",
    ]);
  });

  it("refuse the changed-bank invoice by code, with the rule the signed ledger records", () => {
    const changed = card("INV-2002");
    expect(changed.outcome).toBe("Refused by code");
    expect(demo.refusals).toEqual([
      { invoice: "INV-2002", rule: "mandate.payee_mismatch", ledger_seq: 3 },
    ]);
    expect(changed.body).toContain("`mandate.payee_mismatch`");
    expect(changed.body).toContain("entry 3");
    const entry = ledger.find((e) => e.seq === 3);
    expect(entry?.verdict).toBe("refuse");
    expect(entry?.rules).toContainEqual(
      expect.objectContaining({ id: "mandate.payee_mismatch", outcome: "refuse" }),
    );
    expect(changed.asks).toBe('"We changed banks": 2 test USDC to `new-account.testnet`');
    expect(demo.spends.map((s) => s.invoice)).not.toContain("INV-2002");
    // Nothing was sent, and the row says so where its transaction would be.
    expect(changed.evidence.tx).toBe("None, nothing was sent");
  });

  it("hold INV-2003 above the approval limit, then pay it on the approver's approval", () => {
    const held = card("INV-2003");
    const spend = demo.spends.find((s) => s.id === 2);
    expect(spend?.invoice).toBe("INV-2003");
    expect(spend?.amount).toBe("4000000");
    expect(held.outcome).toBe("Held, then paid");
    expect(held.tone).toBe("held");
    expect(held.asks).toBe("4 test USDC, above the 3 USDC approval limit");
    expect(linksOf(held.evidence.tx)).toEqual([
      {
        verb: "Held",
        label: "6oDNZEUB…y2Tb",
        url: explorerTxUrl("testnet", spend?.spend_tx ?? ""),
      },
      {
        verb: "Approved",
        label: "47VCARhw…NCJf",
        url: explorerTxUrl("testnet", spend?.approve_tx ?? ""),
      },
    ]);
  });

  it("shorten each transaction hash to its first 8 and last 4 characters", () => {
    const txs = [
      ...STORY.invoices.flatMap((c) => linksOf(c.evidence.tx)),
      ...ATTESTED.paid.txs.map((t) => ({ label: t.tx.label, url: t.tx.url })),
    ];
    expect(txs.length).toBe(5);
    for (const l of txs) {
      const hash = l.url.match(/\/txns\/([1-9A-HJ-NP-Za-km-z]+)$/)?.[1];
      expect(hash, l.url).toBeDefined();
      expect(l.label).toBe(`${hash?.slice(0, 8)}…${hash?.slice(-4)}`);
    }
  });

  it("close with the vault's proof page and its record, at the heading of its four invoices", () => {
    expect(STORY.proof.href).toBe(`/proof/${demo.account}`);
    expect(invoices).toContain(`[proof page](${STORY.proof.href})`);
    expect(STORY.files.url).toBe(blob(`${EVIDENCE}/README.md`));
    expect(invoices).toContain(`](${STORY.files.url}#the-four-invoices)`);
    expect(slugsOf(`${EVIDENCE}/README.md`)).toContain("the-four-invoices");
  });
});

describe("the attested decisions on record, on the verifier checks page", () => {
  const rows = tableRows(attested);
  const rowFor = (check: string) => {
    const found = rows.find((r) => r[0] === check);
    if (found === undefined) throw new Error(`${fileOf(ATTESTED_PAGE)}: no row "${check}"`);
    return found;
  };
  /** The mainnet vault's column, which ATTESTED does not have: its results, from the runs checked below. */
  const MAINNET_RESULT: Readonly<Record<string, string>> = {
    "A1 to A7 (offline checks)": "Pass",
    "O1 and O2 (online checks)": "Pass",
    A8: "Pass",
  };

  it("give each ledger a column, the Canary's named and not linked", () => {
    expect(rows.map((r) => r[0])).toEqual([
      "Check",
      "Attested decisions",
      ...ATTESTED.rows.map((r) => r.check),
    ]);
    expect(rows[0]).toEqual([
      "Check",
      "The Canary's ledger",
      "The demo vault's ledger",
      "The mainnet vault's ledger",
    ]);
    expect(ATTESTED.ledgers.map((l) => l.short)).toEqual(["Canary", "Demo vault"]);
    expect(attested).not.toContain("](/canary");
  });

  it("are ATTESTED's checks, each cell starting with its result word and linking its output", () => {
    for (const r of ATTESTED.rows) {
      const own: readonly AttestedCell[] = r.cells;
      const cells = rowFor(r.check).slice(1);
      expect(cells, r.check).toHaveLength(3);
      // A row with one cell spans every ledger, the mainnet vault's too.
      const words =
        own.length === 1
          ? cells.map(() => own[0]?.result)
          : [...own.map((c) => c.result), MAINNET_RESULT[r.check]];
      for (const [i, c] of cells.entries()) {
        const word = words[i];
        expect(word, `${r.check}, column ${i + 1}`).toBeDefined();
        expect(c.startsWith(word ?? "?"), `${r.check}, column ${i + 1}: ${c}`).toBe(true);
      }
      for (const href of own.flatMap((c) => [...hrefsOf(c.detail), ...hrefsOf(c.more ?? [])])) {
        expect(attested, `${r.check}: ${href}`).toContain(`](${href})`);
      }
    }
  });

  it("name the demo vault's five: later runs on the same vault, not its four invoices", () => {
    // The attested decisions of the demo vault's ledger are entries 10 to 13 and 15, one per invoice INV-2006 to 2010.
    const five = video.filter((e) => e.kind === "decision" && Boolean(e.evidence));
    expect(five.map((e) => e.seq)).toEqual([10, 11, 12, 13, 15]);
    expect(five.map((e) => e.decided_by)).toEqual(Array(5).fill("model+rules"));
    const ids = ["INV-2006", "INV-2007", "INV-2008", "INV-2009", "INV-2010"];
    expect(five.map((e) => e.invoice_hash)).toEqual(
      ids.map((id) => sha256(`${EVIDENCE}/invoice-${id}.txt`)),
    );
    // None of them is one of the four invoices on the one-payment page.
    const four = ["INV-2001", "INV-2002", "INV-2003"].map((id) =>
      sha256(`${EVIDENCE}/invoice-${id}.txt`),
    );
    for (const e of five) expect(four).not.toContain(e.invoice_hash);
    expect(rowFor("Attested decisions")[2]).toMatch(
      /^5, of 2026-11-11 and 2026-11-12: entries 10 to 13 and 15 /,
    );
    expect(flat(attested)).toContain(
      "The demo vault's five came after [its four invoices](/docs/start/how-one-payment-works#the-demo-vaults-four-invoices), on invoices INV-2006 to INV-2010.",
    );
    // The Canary's two are in its own ledger, of another vault.
    const canary = ledgerOf("docs/evidence/canary-vault/ledger-2026-11-10.jsonl");
    expect(
      canary.filter((e) => e.kind === "decision" && Boolean(e.evidence)).map((e) => e.seq),
    ).toEqual([1, 2]);
    expect(rowFor("Attested decisions")[1]).toMatch(/^2, of 2026-11-10 /);
  });

  it("count the mainnet vault's three as its signed ledger records them, and rest them on its own runs", () => {
    const three = ledgerOf(`${MAINNET}/ledger-2026-11-13.jsonl`).filter(
      (e) => e.kind === "decision" && Boolean(e.evidence),
    );
    expect(three.map((e) => e.seq)).toEqual([0, 1, 4]);
    expect(three.map((e) => e.verdict)).toEqual(["refuse", "refuse", "allow"]);
    const mainnet = rowFor("Attested decisions")[3] ?? "";
    expect(mainnet).toMatch(/^3, of 2026-11-13: entries 0, 1 and 4 /);
    expect(mainnet).toContain(`](${blob(`${MAINNET}/ledger-2026-11-13.jsonl`)})`);
    const offline = read(`${MAINNET}/verify-2026-11-13.txt`).toString("utf8");
    expect(offline).toMatch(/3 attested decisions pass A1.A7;/);
    expect(offline).toContain("passes for 3 of 3 attested decisions (seq 0, 1, 4)");
    expect(offline).toContain("RESULT: PASS");
    const online = read(`${MAINNET}/verify-online-2026-11-13.txt`).toString("utf8");
    expect(online).toContain("generated 2026-11-13T17:52");
    expect(online).toContain("3 DCAP-genuine TDX quotes bound to this request");
    expect(online).toContain("verified by NRAS (O2)");
    expect(online).toContain("RESULT: PASS");
    for (const check of ["A1 to A7 (offline checks)", "A8"]) {
      expect(rowFor(check)[3], check).toContain(`](${blob(`${MAINNET}/verify-2026-11-13.txt`)})`);
    }
    const o = rowFor("O1 and O2 (online checks)")[3];
    expect(o).toContain("2026-11-13 at 17:52 UTC");
    expect(o).toContain(`](${blob(`${MAINNET}/verify-online-2026-11-13.txt`)})`);
    expect(flat(attested)).toContain(
      "On mainnet, code refused the decisions of entries 0 and 1, and entry 4, by `z-ai/glm-5.3-flash`, led to spend 3, a 0.25 USDC test to the owner's own Base address",
    );
  });

  it("pay spends 4 and 5 on the two of the five the code allowed, as the ledger records them", () => {
    const allowed = video.filter(
      (e) => e.kind === "decision" && Boolean(e.evidence) && e.verdict === "allow",
    );
    expect(allowed.map((e) => e.seq)).toEqual([13, 15]);
    expect(allowed.map((e) => e.invoice_hash)).toEqual(
      ["INV-2009", "INV-2010"].map((id) => sha256(`${EVIDENCE}/invoice-${id}.txt`)),
    );
    expect(allowed.map((e) => e.amount)).toEqual(["2000000", "2000000"]);
    expect(flat(attested)).toContain(
      "On 2026-11-12 the code allowed two of them, entries 13 and 15 (INV-2009 and INV-2010), and the vault paid each invoice, 2.00 test USDC, on testnet",
    );
    const [four, five] = ATTESTED.paid.txs;
    expect([four?.label, five?.label]).toEqual(["Spend 4", "Spend 5"]);
    // Each spend's payment result names its transaction, paid, right after its decision.
    for (const [spend, seq, t] of [
      [4, 14, four],
      [5, 16, five],
    ] as const) {
      const entry = video.find((e) => e.seq === seq);
      expect(entry?.kind, `spend ${spend}`).toBe("payment");
      expect(entry?.contract, `spend ${spend}`).toMatchObject({
        tx_hash: t?.tx.hash,
        status: "paid",
        spend_id: spend,
      });
      expect(entry?.invoice_hash).toBe(video.find((e) => e.seq === seq - 1)?.invoice_hash);
      expect(t?.tx.url).toBe(explorerTxUrl("testnet", t?.tx.hash ?? ""));
      expect(attested).toContain(`spend ${spend}, [\`${t?.tx.label}\`](${t?.tx.url})`);
    }
    const readme = read(`${EVIDENCE}/README.md`).toString("utf8");
    expect(readme).toContain(`[\`EA7MbLts…\`](${four?.tx.url})`);
    expect(readme).toContain(`[\`3YEGw5Qd…\`](${five?.tx.url})`);
  });
});

describe("the record's links", () => {
  it("are all on the two docs sections, and point only at files, headings and transactions that exist", () => {
    const docs = `${invoices}\n${attested}`;
    expect(RECORD_LINKS.length).toBeGreaterThan(20);
    for (const href of RECORD_LINKS) {
      expect(docs, href).toContain(`](${href}`);
      if (href.startsWith(`${REPO_URL}/blob/main/`)) {
        const [path = "", anchor] = href.slice(`${REPO_URL}/blob/main/`.length).split("#");
        expect(existsSync(join(ROOT, ...path.split("/"))), href).toBe(true);
        if (anchor !== undefined && !/^L\d+(-L\d+)?$/.test(anchor)) {
          expect(slugsOf(path), href).toContain(anchor);
        }
      } else if (href.startsWith("https://testnet.nearblocks.io/txns/")) {
        expect(href).toMatch(
          /^https:\/\/testnet\.nearblocks\.io\/txns\/[1-9A-HJ-NP-Za-km-z]{43,44}$/,
        );
      } else if (href.startsWith("/proof/")) {
        expect(href).toBe(`/proof/${demo.account}`);
      } else {
        throw new Error(`a link the test does not know: ${href}`);
      }
    }
  });
});
