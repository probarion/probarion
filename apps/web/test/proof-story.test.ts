// The three lines at the top of /proof: what a vault's snapshot records, counted from its chain spends and its
// decision rows. Rendered as a visitor gets them, on the committed snapshots of the mainnet vault, the testnet demo,
// Canary and 402 vaults, and on crafted rows. The lines count; they never call a refusal a win.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runChecks, type Snapshot } from "@probarion/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProofStory, proofStoryFacts } from "@/components/proof/ProofStory";
import { ProofView } from "@/components/proof/ProofView";
import type { Network } from "@/lib/config";
import { type DecisionRow, decisionRows } from "@/lib/proof/decisions";
import type { ProofOk } from "@/lib/proof/service";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const read = (path: string) =>
  JSON.parse(readFileSync(join(ROOT, "docs", "evidence", path), "utf8")) as Snapshot;

const MAINNET = "mainnet-v0/s2-2026-11-13/snapshot-2026-11-13.json";
const DEMO = "demo-vault/snapshot-2026-11-12.json";
const CANARY = "canary-vault/snapshot-2026-11-11.json";
const PERCALL = "402-vault/snapshot-2026-11-11.json";

/** Each line of the story as text: tags dropped, the entities React writes decoded. */
function lines(markup: string): string[] {
  return [...markup.matchAll(/<li data-story-line="[a-z]+">(.*?)<\/li>/g)].map((m) =>
    (m[1] ?? "")
      .replace(/<[^>]+>/g, "")
      .replaceAll("&#x27;", "'")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&"),
  );
}

async function story(snapshot: Snapshot, rows?: readonly DecisionRow[]) {
  const r = rows ?? (await decisionRows(snapshot, snapshot.network as Network));
  return renderToStaticMarkup(
    createElement(ProofStory, { snapshot, rows: r, takenAt: "2026-11-13T19:08:17.870Z" }),
  );
}

describe("the story lines on the committed snapshots", () => {
  it("mainnet: the 3 paid spends by how each was decided, and the 2 refusals by their rule only", async () => {
    const out = await story(read(MAINNET));
    expect(lines(out)).toEqual([
      "As of 2026-11-13T19:08:17.870Z, this vault has paid out 3 spends on chain, 2.25 USDC in all.",
      "Of these, 1 was paid after an attested model proposed it (A1 to A7 pass on this snapshot), 1 on the code rules alone, and 1 on a decision from before the signed ledger.",
      "2 decisions were refused by the code rules (mandate.payee_mismatch).",
    ]);
    // Those two refusals were false ones (docs/evidence/mainnet-v0/s1-2026-11-13): the line names the rule, never more.
    expect(lines(out).join(" ")).not.toMatch(
      /attack|hijack|stopped|blocked|caught|changed payee|saved/i,
    );
  });

  it("testnet demo: the attested and the rules-only payments, then the refusals and the hold by rule", async () => {
    expect(lines(await story(read(DEMO)))).toEqual([
      "As of 2026-11-13T19:08:17.870Z, this vault has paid out 4 spends on chain, 12 USDC in all.",
      "Of these, 1 was paid after an attested model proposed it (A1 to A7 pass on this snapshot), and 3 on the code rules alone.",
      "6 decisions were refused by the code rules (4 mandate.payee_mismatch, 2 custom.owner_confirms_without_model). 1 decision was held (custom.owner_confirms_without_model).",
    ]);
  });

  it("Canary: nothing paid, what the ledger holds, and the contract's refusal on chain", async () => {
    expect(lines(await story(read(CANARY)))).toEqual([
      "As of 2026-11-13T19:08:17.870Z, this vault has paid out no spend on chain.",
      "Its signed ledger holds 4 decisions, 2 made with model output.",
      "3 decisions were refused by the code rules (invoice.amount_invalid). The contract refused 1 payment on chain (OverPerPayment).",
    ]);
  });

  it("402: every payment on the code rules alone", async () => {
    expect(lines(await story(read(PERCALL)))).toEqual([
      "As of 2026-11-13T19:08:17.870Z, this vault has paid out 21 spends on chain, 0.21 USDC in all.",
      "All 21 were paid on the code rules alone.",
      "2 decisions were refused by the code rules (mandate.uses_exhausted).",
    ]);
  });
});

describe("the story lines on crafted data", () => {
  it("leaves out the total when an amount is not whole base units, and names an unbound spend", async () => {
    const s = structuredClone(read(PERCALL));
    const spends = s.chain.spends;
    (spends[0] as { amount: string }).amount = "1.5";
    (spends[1] as { decision_hash: string }).decision_hash = "f".repeat(64);
    const [paid, decided] = lines(await story(s));
    expect(paid).toBe(
      "As of 2026-11-13T19:08:17.870Z, this vault has paid out 21 spends on chain.",
    );
    expect(decided).toBe(
      "Of these, 20 were paid on the code rules alone, and 1 on no decision in the signed ledger (see check d).",
    );
  });

  it("does not count a payment as attested when its A1 to A7 fail, or when the decider is unknown", async () => {
    const s = read(DEMO);
    const rows = await decisionRows(s, "testnet");
    const broken = rows.map((r) =>
      r.decidedBy === "model+rules" && r.attestation !== null
        ? { ...r, attestation: { ...r.attestation, ok: false } }
        : r.seq === 1
          ? { ...r, decidedBy: "unknown" as const }
          : r,
    );
    expect(lines(await story(s, broken))[1]).toBe(
      "Of these, 2 were paid on the code rules alone, and 2 on another kind of decision (see their cards below).",
    );
    expect(proofStoryFacts(s, broken)).toMatchObject({ paid: 4, attested: 0, unplaced: 2 });
  });

  it("names at most four rules and counts the rest, with crafted text escaped", async () => {
    const s = read(DEMO);
    const [base] = await decisionRows(s, "testnet");
    if (base === undefined) throw new Error("no row");
    const ids = ["a.one", "b.two", "c.three", "d.four", "e.five", "<b>x</b>"];
    const rows = ids.map((id, i) => ({
      ...base,
      seq: i,
      id: `seq-${i}`,
      verdict: "refuse" as const,
      checked: {
        ...base.checked,
        spends: [],
        payments: [],
        firstBlocking: { id, outcome: "refuse" as const, detail: "" },
      },
    }));
    const out = await story(s, rows);
    expect(lines(out)[2]).toBe(
      "6 decisions were refused by the code rules (1 <b>x</b>, 1 a.one, 1 b.two, 1 c.three, and 2 others).",
    );
    expect(out).not.toContain("<b>x</b>");
  });

  it("says the ledger is empty and drops the third line when there is no decision", async () => {
    const s = structuredClone(read(CANARY));
    s.ledger = [];
    expect(lines(await story(s, []))).toEqual([
      "As of 2026-11-13T19:08:17.870Z, this vault has paid out no spend on chain.",
      "Its signed ledger holds no decision yet.",
    ]);
  });

  it("says when nothing was refused or held", async () => {
    const s = read(PERCALL);
    const rows = (await decisionRows(s, "testnet")).filter((r) => r.verdict === "allow");
    expect(lines(await story(s, rows))[2]).toBe(
      "No decision was refused or held, and the contract refused no payment.",
    );
  });
});

describe("the story on the page", () => {
  const view = async (snapshot: Snapshot, withRows = true) => {
    const network = snapshot.network as Network;
    const result: ProofOk = {
      status: "ok",
      vault: snapshot.vault,
      network,
      kind: "team",
      audience: "public",
      snapshot,
      report: await runChecks(snapshot),
    };
    const decisions = withRows ? await decisionRows(snapshot, network) : null;
    return renderToStaticMarkup(createElement(ProofView, { result, decisions }));
  };

  it("opens the page: in the header, before the result, dated with the snapshot's full time", async () => {
    const s = read(DEMO);
    const out = await view(s);
    const at = out.indexOf("data-story=");
    expect(at).toBeGreaterThan(out.indexOf("<header"));
    expect(at).toBeLessThan(out.indexOf("</header>"));
    expect(at).toBeLessThan(out.indexOf("data-headline="));
    // The time the panel and the verifier print ("snapshot taken <taken_at>"), never a rounded one.
    expect(s.taken_at).toMatch(/^2026-11-12T\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(lines(out)[0]).toBe(
      `As of ${s.taken_at}, this vault has paid out 4 spends on chain, 12 USDC in all.`,
    );
    expect(out).toContain(`snapshot taken ${s.taken_at}`);
  });

  it("is left out when the decision rows could not be built", async () => {
    const out = await view(read(DEMO), false);
    expect(out).not.toContain("data-story=");
    expect(out).toContain('data-headline="ok"');
  });
});
