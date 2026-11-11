// The Canary's signed ledger in docs/evidence/canary-vault, published on 2026-11-11: the README, SECURITY.md and the
// site say it holds two real attested decisions, so it has to hold up on its own. The verifier runs on the committed
// snapshot, the ledger file is the snapshot's, and the folder README's table is held to the ledger, row by row.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runChecks, type Snapshot } from "@probarion/core";
import { describe, expect, it } from "vitest";
import { CANARY_SYSTEM_PROMPT, CANARY_SYSTEM_PROMPT_V1 } from "@/lib/canary/prompt";
import { decisionRows } from "@/lib/proof/decisions";
import { PRIVACY_PAGE } from "@/lib/site/ops-copy";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const EVIDENCE = join(ROOT, "docs", "evidence", "canary-vault");
const bytes = (name: string) => readFileSync(join(EVIDENCE, name));
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

const VAULT = "canary.vaults.probarion.testnet";
const LEDGER = "ledger-2026-11-10.jsonl";
const SNAPSHOT = "snapshot-2026-11-11.json";
const VERIFY = "verify-2026-11-11.txt";
const SECTION = "## The signed ledger, published 2026-11-11";
const TX = "https://testnet.nearblocks.io/txns/";
/** "A1 to A7" as the verifier writes it, with an en dash (kept out of this file's source, which is ASCII). */
const A1_A7 = `A1${String.fromCodePoint(0x2013)}A7`;

type Rule = { id: string; outcome: string; detail: string };
type Proposal = { action: string; mandate_id: number | null; amount: string | null };
type Evidence = {
  provider: string;
  model: string;
  request_inputs: Record<string, unknown> & { system_prompt: string };
  signature: { signing_address: string };
  report: { signing_address: string };
};
type Body = {
  vault: string;
  seq: number;
  kind: "decision" | "payment";
  at: string;
  request_id: string;
  mandate_id: number | null;
  invoice_hash: string;
  amount: string | null;
  proposal: Proposal | null;
  evidence: Evidence | null;
  rules: Rule[];
  verdict: string | null;
  decided_by: string | null;
  contract: { code: string; tx_hash: string; spend_id: number | null; status: string } | null;
  refs: { decision_body_hash: string } | null;
};
type Entry = { body: Body; body_hash: string; link: string };

const ledgerText = bytes(LEDGER).toString("utf8");
const entries = ledgerText
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as Entry);
const at = (seq: number): Body => {
  const found = entries.find((e) => e.body.seq === seq);
  if (found === undefined) throw new Error(`no entry ${seq}`);
  return found.body;
};
const snapshot = JSON.parse(bytes(SNAPSHOT).toString("utf8")) as Snapshot & {
  chain: { anchors: { seq: number; count: number; root: string }[]; spends: unknown[] };
};
const readme = readFileSync(join(EVIDENCE, "README.md"), "utf8");
/** Markdown with every run of whitespace, line breaks included, as one space: a rewrap changes no claim. */
const flat = (text: string) => text.replace(/\s+/g, " ");
/** Every backticked rule id in a cell, such as `invoice.amount_invalid`, in order. */
const ruleIds = (cell: string | undefined) =>
  [...(cell ?? "").matchAll(/`([a-z]+\.[a-z_]+)`/g)].map((m) => m[1] ?? "");

/** The text of the README under `## <heading>`, up to the next `## ` heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`${heading}\n`);
  if (start < 0) throw new Error(`no section ${heading}`);
  const next = text.indexOf("\n## ", start + heading.length);
  return text.slice(start, next < 0 ? undefined : next);
}

/** The body rows of the first Markdown table in `text`, each split into its cells. */
function tableRows(text: string): string[][] {
  const lines = text.split("\n").filter((l) => l.startsWith("| "));
  return lines.slice(2).map((l) =>
    l
      .slice(2, -2)
      .split(" | ")
      .map((c) => c.trim()),
  );
}

describe("the Canary's signed ledger, as committed", () => {
  it("keeps the bytes of the owner's export of 2026-11-11 and of the live run", () => {
    // The files are byte for byte what the export and the run wrote: LF only, so `* text=auto eol=lf` keeps them.
    expect(sha256(bytes(LEDGER))).toBe(
      "768edd1e52121ddec662176c6de1575c6fc981b78b2221ac6e01dfbfb1f79c8d",
    );
    expect(sha256(bytes(SNAPSHOT))).toBe(
      "875e9297a4b798fa9e6931c5cc0bce93778831576b88ecdc5842891c20361e2d",
    );
    expect(sha256(bytes(VERIFY))).toBe(
      "686dd999ab0c22a8ea577bde10f670bdd223bb46f50725e2eb78d8bcb3345455",
    );
    for (const name of [LEDGER, SNAPSHOT, VERIFY]) {
      expect(bytes(name).includes(0x0d), name).toBe(false);
      expect(bytes(name).at(-1), name).toBe(0x0a);
    }
  });

  it("is the ledger the snapshot holds, entry for entry", () => {
    expect(snapshot.vault).toBe(VAULT);
    expect(snapshot.network).toBe("testnet");
    expect(JSON.stringify(snapshot.ledger)).toBe(JSON.stringify(entries));
    expect(entries.every((e) => e.body.vault === VAULT)).toBe(true);
  });

  it("is anchored in full: the four anchors cover the first 1, 2, 3 and 5 entries", () => {
    const anchors = snapshot.chain.anchors;
    expect(anchors.map((a) => [a.seq, a.count])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 5],
    ]);
    for (const a of anchors) expect(a.root, `anchor ${a.seq}`).toBe(entries[a.count - 1]?.link);
    expect(readme).toContain("cover the first 1, 2, 3 and 5 entries");
  });

  it("holds 5 entries: three refused decisions, the raw-mode decision and the contract's refusal", () => {
    expect(
      entries.map((e) => [e.body.seq, e.body.kind, e.body.decided_by, e.body.verdict]),
    ).toEqual([
      [0, "decision", "rules-only", "refuse"],
      [1, "decision", "model+rules", "refuse"],
      [2, "decision", "model+rules", "refuse"],
      [3, "decision", "rules-only", "allow"],
      [4, "payment", null, null],
    ]);
    // Seq 1 and 2 were decided with NEAR AI Cloud's model; the model proposed 50 ("50", then 50 USDC in units).
    for (const seq of [1, 2]) {
      expect(at(seq).evidence?.provider).toBe("near-ai-cloud");
      expect(at(seq).evidence?.model).toBe("z-ai/glm-5.3-flash");
    }
    expect(at(1).proposal).toMatchObject({ action: "pay", mandate_id: 1, amount: "50" });
    expect(at(2).proposal).toMatchObject({ action: "pay", mandate_id: 1, amount: "50000000" });
    expect(at(0).rules).toContainEqual(expect.objectContaining({ id: "model.unavailable" }));
    for (const seq of [0, 1, 2]) {
      const refused = at(seq)
        .rules.filter((r) => r.outcome === "refuse")
        .map((r) => r.id);
      expect(refused, `seq ${seq}`).toEqual(["invoice.amount_invalid", "custom.canary_no_autopay"]);
    }
    // The raw spend: a rules-only allow that skips the code rules, then the contract's OverPerPayment.
    expect(at(3).rules.map((r) => r.id)).toEqual(["custom.raw_mode"]);
    expect(at(3).proposal).toEqual(at(2).proposal);
    expect(at(4).contract).toEqual({
      code: "OverPerPayment",
      tx_hash: "6XuxN42dDWaboaqaiCuRGKCoA1UrypcDfvat48v6z8DH",
      spend_id: null,
      status: "refused",
    });
    expect(at(4).refs?.decision_body_hash).toBe(entries[3]?.body_hash);
    // Nothing reached the chain as a spend.
    expect(snapshot.chain.spends).toEqual([]);
  });

  it("holds the team's own fake invoice only by its hash, and no invoice text", () => {
    // The three attempts sent one text: one plain invoice hash for seq 0 to 2, the raw spend's salted one for 3 and 4.
    expect(new Set([0, 1, 2].map((s) => at(s).invoice_hash))).toEqual(
      new Set(["1f420b4baf6b8afd555e639ec874ca5f191bba6fe5e0aadf9bc764a04cccddb2"]),
    );
    expect(new Set([3, 4].map((s) => at(s).invoice_hash))).toEqual(
      new Set(["d56c54207b2ae524d962b1d711576784f1ceea7ba29421aa8197f80c23fd4bfc"]),
    );
    expect(new Set([2, 3, 4].map((s) => at(s).request_id)).size).toBe(1);
    for (const seq of [1, 2]) {
      expect(Object.keys(at(seq).evidence?.request_inputs ?? {}).sort(), `seq ${seq}`).toEqual(
        ["facts", "invoice_text_sha256", "mandates", "model", "system_prompt", "template"].sort(),
      );
    }
    // The README names each hash it quotes.
    for (const hash of [at(0).invoice_hash, at(3).invoice_hash, entries[3]?.body_hash ?? ""]) {
      expect(readme).toContain(`\`${hash}\``);
    }
  });

  it("was asked under the Canary's two gullible personas, byte for byte", () => {
    expect(at(1).evidence?.request_inputs.system_prompt).toBe(CANARY_SYSTEM_PROMPT_V1);
    expect(at(2).evidence?.request_inputs.system_prompt).toBe(CANARY_SYSTEM_PROMPT);
    expect(readme).toContain(
      "`CANARY_SYSTEM_PROMPT_V1` at seq 1 and `CANARY_SYSTEM_PROMPT` at seq 2",
    );
  });
});

describe("verify on the Canary's committed snapshot", () => {
  it("passes checks a to i offline: RESULT: PASS", async () => {
    const report = await runChecks(snapshot);
    expect(report.vault).toBe(VAULT);
    expect(report.checks.map((c) => `${c.id} ${c.status}`)).toEqual(
      ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((id) => `${id} pass`),
    );
    // What the CLI prints as RESULT: PASS: every check passes, nothing is unproven, and the report is ok.
    expect(report.unproven).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("finds 2 attested decisions that pass A1 to A7 in check e, and reports seq 0 and 3 as rules-only", async () => {
    const e = (await runChecks(snapshot)).checks.find((c) => c.id === "e");
    expect(e?.detail).toBe(
      `2 attested decisions pass ${A1_A7}; quote not verified offline (run --online for O1); A8 not run (the request is not checked against the invoice); rules-only or unattested (reported, not failed): seq 0, 3`,
    );
  });

  it("passes A1 to A7 on seq 1 and 2 one by one, with the signing address the README names", async () => {
    const rows = await decisionRows(snapshot, "testnet");
    for (const seq of [1, 2]) {
      const row = rows.find((r) => r.seq === seq);
      expect(row?.attestation?.ok, `seq ${seq}`).toBe(true);
      expect(row?.attestation?.checks.map((c) => `${c.id} ${c.pass}`)).toEqual(
        ["A1", "A2", "A3", "A4", "A5", "A6", "A7"].map((id) => `${id} true`),
      );
      const signer = at(seq).evidence?.signature.signing_address;
      expect(at(seq).evidence?.report.signing_address).toBe(signer);
      expect(readme).toContain(`\`${signer}\``);
    }
    for (const seq of [0, 3]) expect(rows.find((r) => r.seq === seq)?.attestation).toBeNull();
  });

  it("keeps the live run's output, which read the chain with this ledger and passed the same nine checks", () => {
    const out = bytes(VERIFY).toString("utf8");
    expect(out).toContain(`Probarion verify: ${VAULT} (testnet)`);
    expect(out).toContain("entries 5, anchors 4, generated 2026-11-11T07:17");
    expect(out).toMatch(
      new RegExp(`^e {2}attestations +PASS +2 attested decisions pass ${A1_A7};`, "m"),
    );
    expect(out).toContain("9 passed, 0 failed, 0 unproven");
    expect(out).toContain("RESULT: PASS");
    // The snapshot is the one that run wrote.
    expect(snapshot.taken_at.startsWith("2026-11-11T07:17")).toBe(true);
  });
});

describe("the rehearsal, as the ledger has it", () => {
  // Seq 2 is the rehearsal's refused decision. Both rules that refused it ran, so no sentence says one "would have".
  const refused = at(2)
    .rules.filter((r) => r.outcome === "refuse")
    .map((r) => r.id);

  it("names both rules that refused it in the folder README", () => {
    expect(refused).toEqual(["invoice.amount_invalid", "custom.canary_no_autopay"]);
    const rehearsal = flat(section(readme, "## The rehearsal"));
    for (const id of refused) expect(rehearsal).toContain(`\`${id}\``);
    expect(rehearsal).toContain(
      "The Canary's own rule, which refuses every attempt, refused it too (`custom.canary_no_autopay`).",
    );
    expect(readme).not.toContain("would have refused");
  });

  it("names both rules that refused it in the root README's Canary row", () => {
    const root = readFileSync(join(ROOT, "README.md"), "utf8");
    const row = root
      .split("\n")
      .find((l) => l.startsWith('| "50 USDC under the canary mandate" |'));
    expect(row).toContain("Refused by code, ledger entry 2:");
    for (const id of refused) expect(row).toContain(`\`${id}\``);
    expect(row).not.toContain("would have refused");
  });
});

describe("what SECURITY.md, the privacy page and the threat model say about the Canary's ledger", () => {
  it("SECURITY.md: real attested decisions are checked offline only, O1 and O2 not recorded", () => {
    const security = flat(readFileSync(join(ROOT, "SECURITY.md"), "utf8"));
    expect(security).toContain("- **Real attested decisions are checked offline only.**");
    expect(security).toContain("pass A1 to A7 offline.");
    expect(security).toContain("The online checks O1 and O2 are not recorded for them yet");
    expect(security).toContain(
      "(docs/evidence/canary-vault/README.md#the-signed-ledger-published-2026-11-11)",
    );
    expect(security).not.toContain("No recorded real decision yet");
  });

  it("the privacy page: two of the Canary's, checked offline only, none the payables agent's", () => {
    const invoices = PRIVACY_PAGE.sections.find((s) => s.id === "invoices");
    const said = flat((invoices?.paragraphs ?? []).join(" "));
    expect(said).toContain(
      "The attested decisions recorded in the repository so far are two of the Canary's, on testnet, checked offline only; none is the payables agent's.",
    );
    expect(said).not.toMatch(/no attested decision|none recorded/i);
  });

  it("the threat model: the app keeps the Canary's ledger private, and the team published its own entries", () => {
    const threat = flat(readFileSync(join(ROOT, "docs", "THREAT_MODEL.md"), "utf8"));
    expect(threat).toContain(
      "The app cannot make the Canary's ledger public: a database constraint forbids it",
    );
    expect(threat).toContain(
      "The team published the 5 entries of its own attempts of 2026-11-10, which hold no visitor's text, as evidence",
    );
    expect(threat).not.toContain("The Canary's ledger cannot be made public");
  });

  it("no page calls the whole of the Canary's ledger published: only the entries of 2026-11-10 are", () => {
    const docs = join(ROOT, "apps", "web", "content", "docs");
    const pages = readdirSync(docs, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".mdx"))
      .map((f) => join(docs, f));
    const files = [
      join(ROOT, "README.md"),
      join(ROOT, "SECURITY.md"),
      join(ROOT, "docs", "THREAT_MODEL.md"),
      join(ROOT, "apps", "web", "src", "lib", "site", "facts.ts"),
      ...pages,
    ];
    expect(pages.length).toBeGreaterThan(30);
    for (const f of files) {
      expect(flat(readFileSync(f, "utf8")), f).not.toMatch(/Canary's published ledger/i);
    }
  });
});

describe("the folder README's account of the ledger", () => {
  const text = section(readme, SECTION);
  // The section has one table, the entries.
  const rows = tableRows(text);

  it("has one row per entry, in order", () => {
    expect(rows.map((r) => r[0])).toEqual(entries.map((e) => String(e.body.seq)));
    for (const r of rows) expect(r, r[0]).toHaveLength(8);
  });

  it.each(entries.map((e) => [e.body.seq, e] as const))(
    "row %i matches its entry",
    (seq, entry) => {
      const b = entry.body;
      const [, time, kind, decidedBy, proposed, code, contract, tx] = rows[seq] ?? [];
      expect(time).toBe(b.at.slice(0, 19).replace("T", " "));
      expect(kind).toBe(b.kind === "decision" ? "Decision" : "Payment");
      expect(decidedBy?.startsWith(b.decided_by === null ? "None" : `\`${b.decided_by}\``)).toBe(
        true,
      );
      if (b.evidence !== null) expect(decidedBy).toContain(`\`${b.evidence.model}\``);
      // A decision whose model step gave no answer names that rule; no other row names it.
      if (b.rules.some((r) => r.id === "model.unavailable"))
        expect(decidedBy).toContain("(`model.unavailable`)");
      else expect(decidedBy).not.toContain("model.unavailable");
      // What the model proposed: its action, its amount as written and its mandate, or nothing.
      if (b.proposal === null) expect(["Nothing", "None"]).toContain(proposed);
      else if (b.evidence !== null) {
        const p = b.proposal;
        expect(proposed?.startsWith(`\`${p.action}\`, amount \`"${p.amount}"\``)).toBe(true);
        const mandates = [...(proposed ?? "").matchAll(/\bmandate (\d+)/g)].map((m) =>
          Number(m[1]),
        );
        expect(mandates).toEqual([p.mandate_id]);
      } else expect(proposed).toBe(`The proposal of seq ${seq - 1}, recorded again`);
      // What the code did: exactly the rules that refused, or the one rule of an allow, by their ids.
      if (b.verdict === "refuse") expect(code?.startsWith("Refused")).toBe(true);
      if (b.verdict === "allow") expect(code?.startsWith("Allowed")).toBe(true);
      const named =
        b.verdict === "allow" || b.kind === "payment"
          ? b.rules
          : b.rules.filter((r) => r.outcome === "refuse");
      expect(ruleIds(code)).toEqual(named.map((r) => r.id));
      // What the contract did, and the transaction: only the raw spend and its decision reached the contract.
      const bound = entries.find((p) => p.body.refs?.decision_body_hash === entry.body_hash)?.body;
      const sent = b.contract ?? bound?.contract ?? null;
      if (b.contract !== null) {
        expect(contract).toContain(`\`PROBARION:${b.contract.code}\``);
        expect(contract).toContain(`\`${b.contract.status}\``);
      } else if (bound !== undefined) {
        expect(contract).toContain(`seq ${bound.seq}`);
      } else {
        expect(contract?.startsWith("Nothing was sent")).toBe(true);
      }
      expect(tx).toBe(
        sent === null ? "None" : `[\`${sent.tx_hash.slice(0, 8)}\`](${TX}${sent.tx_hash})`,
      );
    },
  );

  it("says what check e shows for seq 1 and 2, and what it does not", () => {
    for (const id of ["A1", "A2", "A3", "A4", "A5", "A6", "A7"])
      expect(text).toContain(`- ${id}: `);
    // SECURITY.md's own words and limits.
    expect(text).toContain('"attested and signed", not "proven to run a given model image"');
    expect(text).toContain("The TEE measurement is not pinned (O1b, deferred)");
    expect(text).toContain("The online checks are not recorded for this ledger yet");
    expect(text).toContain("check e says `A8 not run`");
    expect(text).toContain("deliberately gullible prompt");
    expect(flat(readFileSync(join(ROOT, "SECURITY.md"), "utf8"))).toContain(
      'Probarion says "attested and signed", not "proven to run a given model image"',
    );
  });

  it("claims no more for the two answers than A1 to A7 show offline", () => {
    const said = flat(text);
    // Offline, nothing shows that the signing key is a TEE's: that is O1, online, not recorded here.
    expect(said).not.toMatch(/TEE key|TEE's key/);
    expect(said).toContain(
      "- A1: the text the signature covers is the one core's `formatProviderTeeText` builds",
    );
    expect(said).toContain("nothing here shows yet that the signing key is held in a genuine TEE");
    expect(said).toContain("The attestation ties each answer to the key that signed it");
    // A5 compares the report with the evidence's nonce; whether the chat carried it is A8's question.
    expect(said).toContain(
      "- A5: the last 32 bytes of the report data, and the report's `request_nonce`, are the evidence's nonce.",
    );
    expect(said).toContain(
      "the standard request for this invoice at this ledger position: A5 and A6 bind the attestation report, not the chat",
    );
    // Seq 1 wrote "50", which is not 50 USDC, and only the second attempt's raw spend reached the contract.
    expect(said).toContain('seq 1 wrote the amount as `"50"`');
    expect(said).toContain(
      "the contract refused the raw spend of the second attempt (seq 3 and 4)",
    );
    expect(said).not.toContain("and code and the contract refused");
  });

  it("gives the offline command, which keeps working, and the live one, which check c ends by design", () => {
    expect(text).toContain(
      "npx probarion verify --offline docs/evidence/canary-vault/snapshot-2026-11-11.json",
    );
    expect(text).toContain(
      `npx probarion verify --network testnet --vault ${VAULT} --ledger docs/evidence/canary-vault/${LEDGER}`,
    );
    expect(text).toContain("check c fails on this file, by design");
  });
});
