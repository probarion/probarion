// The Canary's signed ledger in docs/evidence/canary-vault, published on 2026-11-11: the README, SECURITY.md and the
// site say it holds two real attested decisions, so it has to hold up on its own. The verifier runs on the committed
// snapshot, the ledger file is the snapshot's, and the folder README's table is held to the ledger, row by row. The
// online run of 2026-11-11 (verify --online: O1 and O2) is kept as the CLI printed it, and held to what the SDK's
// applyOnlineChecks writes when both pass on this ledger.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractReportDataFromQuote, runChecks, type Snapshot } from "@probarion/core";
import {
  ACCEPTED_TCB_STATUSES,
  applyOnlineChecks,
  InMemoryLedgerStore,
  loadDefaultOnlineVerifier,
  O1_MEASUREMENT_PINNED,
  type OnlineAttestationVerifier,
  Probarion,
} from "@probarion/sdk";
import { describe, expect, it } from "vitest";
import { CANARY_SYSTEM_PROMPT, CANARY_SYSTEM_PROMPT_V1 } from "@/lib/canary/prompt";
import { findPage } from "@/lib/docs/registry";
import { decisionRows } from "@/lib/proof/decisions";
import { STATUS } from "@/lib/site/facts";
import { PRIVACY_PAGE } from "@/lib/site/ops-copy";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const EVIDENCE = join(ROOT, "docs", "evidence", "canary-vault");
const bytes = (name: string) => readFileSync(join(EVIDENCE, name));
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

const VAULT = "canary.vaults.probarion.testnet";
const LEDGER = "ledger-2026-11-10.jsonl";
const SNAPSHOT = "snapshot-2026-11-11.json";
const VERIFY = "verify-2026-11-11.txt";
/** The live run with --online, the same ledger, after the owner synced the computer's clock. */
const VERIFY_ONLINE = "verify-online-2026-11-11.txt";
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
  nonce: string;
  signature: { signing_address: string };
  report: {
    signing_address: string;
    report_data: string;
    intel_quote: string;
    nvidia_payload: string | null;
  };
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

/** The text of a section under `### <heading>`, up to the next `### ` or `## ` heading. */
function subsection(text: string, heading: string): string {
  const start = text.indexOf(`${heading}\n`);
  if (start < 0) throw new Error(`no subsection ${heading}`);
  const next = text.slice(start + heading.length).search(/\n#{2,3} /);
  return text.slice(start, next < 0 ? undefined : start + heading.length + next);
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
  it("keeps the bytes of the owner's export of 2026-11-11 and of the live runs", () => {
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
    expect(sha256(bytes(VERIFY_ONLINE))).toBe(
      "fcaa6b3fdeaea35b1012184d52ce81e886dc3aac1786d133e991965359dff336",
    );
    for (const name of [LEDGER, SNAPSHOT, VERIFY, VERIFY_ONLINE]) {
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

describe("the online run of 2026-11-11: O1 and O2 on the two attested decisions", () => {
  const out = bytes(VERIFY_ONLINE).toString("utf8");
  const lines = out.split("\n");
  /** The detail the CLI printed on check e's row. */
  const printedE = /^e {2}attestations +PASS +(.+)$/m.exec(out)?.[1] ?? "";
  /** What applyOnlineChecks appends to check e when O1 and O2 pass on 2 decisions, each with a GPU payload. */
  const ONLINE_E =
    "online: 2 DCAP-genuine TDX quotes bound to this request (O1: debug off, an accepted TCB status, report_data matches; measurement not pinned, so quote_verified stays false) and 2 GPU payloads bound to the request nonce and verified by NRAS (O2)";
  const O1_LEGEND =
    "online legend: O1 checks that a TDX quote is DCAP-genuine (Intel DCAP; debug off, an accepted TCB status) and bound to this request; measurement not pinned (O1b deferred), so O1 does not show which image the TD runs";
  const O2_LEGEND =
    "online legend: O2 checks that a GPU payload carries the request nonce and that NVIDIA NRAS verifies it";
  /**
   * A verifier that passes whatever it is asked: the run's own answers came from Intel DCAP and NVIDIA NRAS, which a
   * test cannot ask. It records what it was asked, and gives back the report data inside each quote.
   */
  const passingVerifier = (asked = { quotes: [] as string[], gpus: [] as string[] }) => {
    const verifier: OnlineAttestationVerifier = {
      async verifyQuote(quote) {
        asked.quotes.push(quote);
        return {
          reportDataHex: extractReportDataFromQuote(quote) ?? "",
          tcbStatus: "UpToDate",
          debugEnabled: false,
        };
      },
      async verifyGpu(payload) {
        asked.gpus.push(payload);
      },
    };
    return verifier;
  };

  it("read the chain with this ledger at 07:43 UTC and ends RESULT: PASS, 9 passed", () => {
    expect(lines[0]).toBe(`Probarion verify: ${VAULT} (testnet)`);
    expect(lines[1]).toBe("entries 5, anchors 4, generated 2026-11-11T07:43:23.076Z");
    for (const id of ["a", "b", "c", "d", "e", "f", "g", "h", "i"])
      expect(out, `check ${id}`).toMatch(new RegExp(`^${id} {2}\\S+ +PASS {2,}\\S`, "m"));
    expect(out).not.toMatch(/^[a-i] {2}\S+ +(?:FAIL|UNPROVEN|SKIP)\b/m);
    expect(out.endsWith("\n9 passed, 0 failed, 0 unproven\nRESULT: PASS\n")).toBe(true);
  });

  it("says in check e that O1 and O2 passed on 2 decisions, with the measurement not pinned", () => {
    expect(printedE.startsWith(`2 attested decisions pass ${A1_A7};`)).toBe(true);
    expect(printedE.endsWith(`; ${ONLINE_E}`)).toBe(true);
    expect(printedE).toContain("2 DCAP-genuine TDX quotes bound to this request");
    expect(printedE).toContain(
      "2 GPU payloads bound to the request nonce and verified by NRAS (O2)",
    );
    expect(printedE).toContain("measurement not pinned, so quote_verified stays false");
    expect(lines).toContain(O1_LEGEND);
    expect(lines).toContain(O2_LEGEND);
    expect(out).not.toMatch(/did not run|online: unavailable|O1\/O2 failed|O[12] failed/);
  });

  it("is the offline check e of the committed snapshot plus what applyOnlineChecks adds when O1 and O2 pass", async () => {
    // What it does check: the printed line is the SDK's own, for these two entries, and each GPU payload carries its
    // entry's nonce (applyOnlineChecks compares them before it asks NRAS).
    const asked = { quotes: [] as string[], gpus: [] as string[] };
    const passing = passingVerifier(asked);
    const report = await applyOnlineChecks(await runChecks(snapshot), snapshot, passing);
    const e = report.checks.find((c) => c.id === "e");
    expect(e?.status).toBe("pass");
    expect(e?.detail).toBe(printedE);
    expect(report.ok).toBe(true);
    expect(asked.quotes).toEqual([1, 2].map((s) => at(s).evidence?.report.intel_quote));
    expect(asked.gpus).toEqual([1, 2].map((s) => at(s).evidence?.report.nvidia_payload));
  });

  it("binds what 'report_data matches' compares: the signing address and the entry's nonce, inside the quote", () => {
    // O1 holds the DCAP-verified quote's report data to the evidence's report_data (o1PolicyProblem). Here, offline,
    // that report data is the one inside the quote, and it holds the zero-padded signer, then the entry's nonce.
    for (const seq of [1, 2]) {
      const ev = at(seq).evidence;
      const data = ev?.report.report_data ?? "";
      expect(extractReportDataFromQuote(ev?.report.intel_quote ?? ""), `seq ${seq}`).toBe(data);
      expect(data.slice(0, 64)).toBe(
        `${(ev?.signature.signing_address ?? "").toLowerCase().slice(2)}${"0".repeat(24)}`,
      );
      expect(data.slice(64)).toBe(ev?.nonce);
      expect(JSON.parse(ev?.report.nvidia_payload ?? "{}").nonce).toBe(ev?.nonce);
    }
    // O1's policy as the README states it: these TCB statuses, and no measurement pin.
    expect([...ACCEPTED_TCB_STATUSES]).toEqual(["UpToDate", "OutOfDate", "TDRelaunchAdvised"]);
    expect(O1_MEASUREMENT_PINNED).toBe(false);
  });

  it("runs O1 and O2 on the committed snapshot through the SDK's verify, and still reports them after check c fails", async () => {
    // The folder README: the CLI's --offline refuses --online, but the SDK's verify({ snapshot, online: true }) runs
    // O1 and O2 on the snapshot it is given; and a live run that check c fails still reports them in check e.
    const pb = new Probarion(
      { network: "testnet", vault: VAULT, model: null, ledger: new InMemoryLedgerStore() },
      { onlineVerifier: passingVerifier() },
    );
    const report = await pb.verify({ snapshot, online: true });
    expect(report.checks.find((c) => c.id === "e")?.detail).toBe(printedE);
    expect(report.ok).toBe(true);
    // The Canary anchors a newer entry: the chain's last anchor covers 6 entries, and this file holds 5.
    const last = snapshot.chain.anchors.at(-1);
    if (last === undefined) throw new Error("no anchor");
    const newer = structuredClone(snapshot);
    newer.chain.anchors.push({ ...last, seq: last.seq + 1, count: 6, root: "ab".repeat(32) });
    const live = await pb.verify({ snapshot: newer, online: true });
    expect(live.checks.find((c) => c.id === "c")?.status).toBe("fail");
    const e = live.checks.find((c) => c.id === "e");
    expect(e?.status).toBe("pass");
    expect(e?.detail.endsWith(`; ${ONLINE_E}`)).toBe(true);
    expect(live.ok).toBe(false);
  });

  it("loads @nearai/inference-sdk without a check of the Node version", async () => {
    // The folder README: the package's engines field declares Node 24.22.1 or later, and the SDK does not check it.
    const fake = {
      createTdxQuoteVerifier: () => async () => ({}),
      createGpuEvidenceVerifier: () => async () => undefined,
    };
    expect(await loadDefaultOnlineVerifier(async () => fake)).not.toBeNull();
  });

  it("the folder README gives the command, the time and the output, and says what O1 and O2 show and do not", () => {
    const raw = subsection(section(readme, SECTION), "### The online run of 2026-11-11");
    const said = flat(raw);
    expect(said).toContain(
      "[`verify-online-2026-11-11.txt`](verify-online-2026-11-11.txt) is a live run with `--online`, on 2026-11-11 at 07:43 UTC (the file says `generated 2026-11-11T07:43:23.076Z`)",
    );
    // The run read a copy of the ledger at another path; the README gives its hash, which is the committed file's.
    expect(said).toContain(
      `The run read a byte-identical copy of this folder's ledger at another path (sha256 \`${sha256(bytes(LEDGER))}\`, the hash of \`${LEDGER}\`). With the committed file, the command is:`,
    );
    expect(raw).toContain(
      `\`\`\`bash\nnode packages/cli/dist/bin.js verify --network testnet --vault ${VAULT} --ledger docs/evidence/canary-vault/${LEDGER} --online\n\`\`\``,
    );
    expect(said).toContain("`9 passed, 0 failed, 0 unproven` and `RESULT: PASS`");
    expect(raw).toContain(`\`\`\`text\n${ONLINE_E}\n\`\`\``);
    // What O1 binds, as the code checks it.
    expect(said).toContain(
      "its TCB status is one O1 accepts (`UpToDate`, `OutOfDate` or `TDRelaunchAdvised`)",
    );
    expect(said).toContain(
      '"report_data matches" means that the report data inside the verified quote is the evidence\'s `report_data`, all 64 bytes.',
    );
    expect(said).toContain(
      "the first 32 are the signing address of A2, zero-padded, and the last 32 are the entry's nonce, which A6 recomputes from its ledger position.",
    );
    expect(said).toContain(
      "So software in a genuine TDX TD, not in debug mode, asked for a quote that names that signing address and that nonce.",
    );
    expect(said).toContain(
      "Its nonce is the entry's nonce, and NVIDIA's attestation service NRAS verified the payload",
    );
    // What it does not show.
    expect(said).toContain(
      "so `quote_verified` stays false. The run does not show that the TD runs NEAR AI's published image, which model image answered, or what the code in the TD does with the signing key.",
    );
    expect(said).toContain(
      "A8 was not run, so the online run does not show either that the model was sent the standard request for this invoice.",
    );
    // The caveats: the clock, the outside services, and that it is a live run.
    expect(said).toContain(
      "`[gpu.jwt_verification_failed] NVIDIA JWT verification failed: not_yet_valid`. The computer's clock was about 3 s behind NVIDIA's",
    );
    expect(said).toContain(
      "After the owner synced the clock, the same command passed: the file is that run.",
    );
    expect(said).toContain("`api.trustedservices.intel.com`");
    expect(said).toContain("`nras.attestation.nvidia.com`");
    expect(said).toContain(
      "That package's `engines` field declares Node 24.22.1 or later; the SDK loads it without checking the Node version, and the output does not record which one the run used.",
    );
    expect(said).toContain(
      "it stops passing check c once the Canary anchors an entry this file does not have, whatever O1 and O2 say; such a run still reports O1 and O2 in check e after check c fails.",
    );
    expect(said).toContain(
      "The CLI's `verify --offline` refuses `--online`, so the CLI cannot run O1 and O2 on `snapshot-2026-11-11.json`. The SDK can: `verify({ snapshot, online: true })` on a `Probarion` instance runs them on the snapshot it is given.",
    );
    expect(said).not.toContain("cannot be run again");
    expect(said).not.toContain("asks for Node 24.22.1");
    // The CLI's hint for the clock (packages/cli/src/report.ts) is what the README says it is.
    expect(said).toContain(
      "Since then, when O2 fails this way, the CLI adds a line that starts `online hint:` and says to sync the clock.",
    );
    const report = readFileSync(join(ROOT, "packages/cli/src/report.ts"), "utf8");
    expect(report).toMatch(/export const CLOCK_HINT =\s*"online hint: [^"]*sync the clock/);
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
  it("SECURITY.md: real attested decisions pass O1 and O2 online too, and do not show which image ran", () => {
    const security = flat(readFileSync(join(ROOT, "SECURITY.md"), "utf8"));
    expect(security).toContain("- **Real attested decisions do not show which image ran.**");
    expect(security).toContain("pass A1 to A7 offline.");
    expect(security).toContain(
      "On 2026-11-11 they also passed the online checks O1 and O2 ([output](docs/evidence/canary-vault/verify-online-2026-11-11.txt))",
    );
    // O1's policy limits: an accepted TCB status can be OutOfDate, and the output does not say which one each had.
    expect(security).toContain(
      "each TDX quote is a genuine Intel TDX quote (Intel DCAP, debug off, an accepted TCB status, which can be `OutOfDate`) whose report data holds the signing address and the entry's nonce",
    );
    expect(ACCEPTED_TCB_STATUSES).toContain("OutOfDate");
    expect(security).toContain(
      "The TEE measurement is not pinned, so this does not show which model image ran, and A8 was not run",
    );
    expect(security).toContain(
      "(docs/evidence/canary-vault/README.md#the-signed-ledger-published-2026-11-11)",
    );
    expect(security).not.toContain("No recorded real decision yet");
    expect(security).not.toContain("Real attested decisions are checked offline only");
    expect(security).not.toMatch(/O1 and O2 are not recorded/);
  });

  it("the privacy page: two of the Canary's and five of the payables agent's, checked offline and online, each dated, and three on mainnet", () => {
    const invoices = PRIVACY_PAGE.sections.find((s) => s.id === "invoices");
    const said = flat((invoices?.paragraphs ?? []).join(" "));
    expect(said).toContain(
      "The attested decisions recorded in the repository so far: on testnet, two of the Canary's, which pass A1 to A7 offline and, on 2026-11-11, O1 and O2 online, and five of the payables agent's on the demo vault, which pass A1 to A7 offline; four of them, entries 10 to 13, also passed O1 and O2 online on 2026-11-12. On mainnet, three on v0.probarion.near of 2026-11-13, which pass A1 to A7 and, with the invoice texts, A8 offline, and have not been checked online; one of them led to a 0.25 USDC test payout to the owner's own Base address. The TEE measurement is not pinned, and A8 was not run on the Canary's two; on the demo vault's five it passed on 2026-11-12, with the invoices committed in the repository.",
    );
    expect(said).not.toContain("offline and O1 and O2 online");
    expect(said).not.toContain("checked offline only");
    expect(said).not.toMatch(/no attested decision|none recorded/i);
    expect(said).not.toContain("none is the payables agent's");
    // S2 committed three attested decisions on mainnet, so the list is no longer all on testnet.
    expect(said).not.toMatch(/are all on testnet/);
  });

  it("the threat model: the app keeps the Canary's ledger private, and the team published its own entries", () => {
    const threat = flat(readFileSync(join(ROOT, "docs", "THREAT_MODEL.md"), "utf8"));
    expect(threat).toContain(
      "the Canary's 2 of 2026-11-10, pass A1 to A7 offline and, on 2026-11-11, O1 and O2 online ([evidence](evidence/canary-vault/README.md#the-signed-ledger-published-2026-11-11), [online output](evidence/canary-vault/verify-online-2026-11-11.txt),",
    );
    expect(threat).toContain(
      "but the TEE measurement is not pinned, so this does not show which model image ran, and A8 was not run",
    );
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

  it("no page says any more that the Canary's two decisions are checked offline only, or that O1 and O2 are not recorded", () => {
    // The online run of 2026-11-11 passed O1 and O2 on both. Older CHANGELOG releases keep their words; the
    // Unreleased section is held here.
    const docs = join(ROOT, "apps", "web", "content", "docs");
    const pages = readdirSync(docs, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".mdx"))
      .map((f) => join(docs, f));
    const read = (f: string) => readFileSync(f, "utf8");
    const changelog = read(join(ROOT, "CHANGELOG.md"));
    const unreleased = changelog.slice(
      changelog.indexOf("## Unreleased"),
      changelog.indexOf("\n## ", changelog.indexOf("## Unreleased") + 1),
    );
    const texts: [string, string][] = [
      ...[
        "README.md",
        "SECURITY.md",
        join("docs", "THREAT_MODEL.md"),
        join("docs", "evidence", "canary-vault", "README.md"),
        join("apps", "web", "src", "lib", "site", "facts.ts"),
        join("apps", "web", "src", "lib", "site", "ops-copy.ts"),
      ].map((f): [string, string] => [f, read(join(ROOT, f))]),
      ...pages.map((f): [string, string] => [f, read(f)]),
      ["CHANGELOG.md, Unreleased", unreleased],
    ];
    const OLD = [
      /O1 and O2 (?:are )?not recorded/i,
      /online checks? (?:O1 and O2 )?(?:is |are )?not recorded/i,
      /online quote check is not recorded/i,
      /no online run (?:is )?recorded/i,
      /checked offline only/i,
      /attested decisions, checked offline\b/i,
      /Recorded on testnet, checked offline/,
      /The quote is not verified online/,
      /nothing here shows yet that the signing key/,
      /offline and O1 and O2 online/,
    ];
    expect(pages.length).toBeGreaterThan(30);
    expect(unreleased.length).toBeGreaterThan(1000);
    for (const [name, text] of texts) {
      for (const old of OLD) expect(flat(text), `${name}: ${old}`).not.toMatch(old);
    }
  });

  it("the CHANGELOG's Unreleased entry gives the status row's pill, the limits and the clock", () => {
    const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    const unreleased = changelog.slice(
      changelog.indexOf("## Unreleased"),
      changelog.indexOf("\n## ", changelog.indexOf("## Unreleased") + 1),
    );
    const start = unreleased.indexOf("- The Canary's signed ledger, published as evidence");
    expect(start).toBeGreaterThan(0);
    const next = unreleased.indexOf("\n- ", start + 1);
    const entry = flat(unreleased.slice(start, next < 0 ? undefined : next));
    const pill = STATUS.rows.find((r) => r.id === "attested-model-run")?.pill;
    expect(pill).toBe("Checked online on testnet, image not pinned");
    expect(entry).toContain(
      `the status row "Live attested model run" reads "${pill}", and stays Preview`,
    );
    expect(entry).toContain(
      "each TDX quote is a genuine Intel TDX quote (Intel DCAP, debug off, an accepted TCB status, which can be `OutOfDate`) whose report data holds the signing address and the entry's nonce",
    );
    expect(entry).toContain(
      "The TEE measurement is not pinned, so this does not show which model image ran, and A8 was not run",
    );
    expect(entry).toContain(
      "A first online attempt failed O2 with `not_yet_valid`, because the computer's clock was about 3 s behind NVIDIA's, and passed after a clock sync.",
    );
    expect(entry).toContain(
      "The CLI's `verify --offline` refuses `--online`, so O1 and O2 do not run on the snapshot from the CLI; the SDK's `verify({ snapshot, online: true })` runs them on a snapshot it is given.",
    );
    expect(entry).not.toMatch(/\bnever\b/i);
  });

  it("the root README: the NEAR AI Cloud row and the Canary's paragraph give the date, the output and the limits", () => {
    const root = readFileSync(join(ROOT, "README.md"), "utf8");
    const row = root.split("\n").find((l) => l.startsWith("| **NEAR AI Cloud** |"));
    expect(row).toContain("pass A1 to A7 offline and, on 2026-11-11, O1 and O2 online");
    expect(row).toContain(
      "[online output](docs/evidence/canary-vault/verify-online-2026-11-11.txt)",
    );
    expect(row).toContain(
      "the TEE measurement is not pinned, so this does not show which model image ran, and A8 was not run",
    );
    const said = flat(root);
    // The live runs are dated: a live run with this file stops passing check c once the Canary anchors more.
    expect(said).toContain(
      "With it, a live `verify` on 2026-11-11 passed checks a to i ([output](docs/evidence/canary-vault/verify-2026-11-11.txt)), and check e found 2 decisions by NEAR AI Cloud that are attested and signed and pass A1 to A7 offline.",
    );
    expect(said).toContain(
      "The same day a live run with `--online` passed O1 and O2 on both ([output](docs/evidence/canary-vault/verify-online-2026-11-11.txt))",
    );
    expect(said).toContain(
      "each TDX quote is a genuine Intel TDX quote (Intel DCAP, debug off, an accepted TCB status, which can be `OutOfDate`) whose report data holds the signing address and the entry's nonce, and NVIDIA NRAS verified each GPU payload.",
    );
    expect(said).toContain(
      "The TEE measurement is not pinned, so this does not show which model image ran, and A8 was not run ([what that shows](docs/evidence/canary-vault/README.md#the-signed-ledger-published-2026-11-11)).",
    );
    expect(said).toContain(
      "A live run with this file stops passing check c once the Canary anchors a newer entry, such as a visitor's attempt; the offline command below, on the snapshot that run wrote, keeps passing.",
    );
    // The offline command checks a to i and A1 to A7; it does not run O1 and O2 again.
    expect(said).toContain(
      "To run checks a to i and A1 to A7 offline, from a clone of the repository (the CLI runs O1 and O2 only in a live run with `--online`): ```bash npx probarion verify --offline docs/evidence/canary-vault/snapshot-2026-11-11.json ```",
    );
    expect(said).not.toContain("To check it offline, from a clone of the repository:");
    expect(said).not.toContain("With it, a live `verify` passes checks a to i");
  });

  it("each docs page that names the Canary's two decisions gives the date, both links and the limits", () => {
    const docs = join(ROOT, "apps", "web", "content", "docs");
    const GH = "https://github.com/probarion/probarion/blob/main/docs/evidence/canary-vault/";
    const EVIDENCE_LINK = `(${GH}README.md#the-signed-ledger-published-2026-11-11)`;
    const ONLINE_LINK = `(${GH}${VERIFY_ONLINE})`;
    const ONLINE_DATED = "pass A1 to A7 offline and, on 2026-11-11, O1 and O2 online";
    const PAGES: Record<string, string> = {
      "build/let-an-agent-pay": ONLINE_DATED,
      "build/sdk-reference": ONLINE_DATED,
      "operate/architecture": ONLINE_DATED,
      "resources/glossary": ONLINE_DATED,
      "start/how-one-payment-works": ONLINE_DATED,
      "start/what-is-probarion": ONLINE_DATED,
      "start/what-works-today": ONLINE_DATED,
      "trust/security-model": ONLINE_DATED,
      "trust/verifier-checks": "which passed O1 and O2 on 2026-11-11",
    };
    const all = readdirSync(docs, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".mdx"))
      .map((f) => f.replaceAll("\\", "/").replace(/\.mdx$/, ""));
    expect(all.length).toBeGreaterThan(30);
    // The table is every page that says what the Canary's decisions passed: a new one has to be added here.
    const naming = all.filter((p) =>
      /Canary's (?:ledger of 2026-11-10|on testnet)/.test(
        flat(readFileSync(join(docs, `${p}.mdx`), "utf8")),
      ),
    );
    expect(naming.sort()).toEqual(Object.keys(PAGES).sort());
    for (const [path, claim] of Object.entries(PAGES)) {
      const said = flat(readFileSync(join(docs, `${path}.mdx`), "utf8"));
      expect(said, path).toContain(claim);
      expect(said, path).toMatch(
        /measurement is not pinned, so (?:this does|they do) not show which model image ran, and A8 was not run/,
      );
      expect(said, path).toContain(EVIDENCE_LINK);
      expect(said, path).toContain(ONLINE_LINK);
      // The page lists the evidence among the files it was checked against.
      const sources = findPage(path)?.sources ?? [];
      expect(sources, path).toContain("docs/evidence/canary-vault/README.md");
      expect(sources, path).toContain(`docs/evidence/canary-vault/${VERIFY_ONLINE}`);
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
    expect(text).toContain("- **Offline, the quote is not verified.**");
    expect(text).not.toContain("The online checks are not recorded for this ledger yet");
    expect(text).toContain("check e says `A8 not run`");
    expect(text).toContain("deliberately gullible prompt");
    expect(flat(readFileSync(join(ROOT, "SECURITY.md"), "utf8"))).toContain(
      'Probarion says "attested and signed", not "proven to run a given model image"',
    );
  });

  it("claims no more for the two answers than A1 to A7 show offline, and O1 and O2 online", () => {
    const said = flat(text);
    // Offline, nothing shows that the signing key is a TEE's. Online, O1 shows a genuine TDX quote that names the
    // signer and the nonce, not which image the TD runs, so not that the key stays inside it.
    expect(said).not.toMatch(/TEE key|TEE's key/);
    expect(said).toContain(
      "- A1: the text the signature covers is the one core's `formatProviderTeeText` builds",
    );
    expect(said).toContain(
      "so the offline checks alone do not show that the signing key is held in a genuine TEE.",
    );
    expect(said).toContain(
      "O1 shows that each quote is a genuine Intel TDX quote (Intel DCAP, debug off, an accepted TCB status) whose report data holds the signing address of A2 and the entry's nonce, and O2 that each GPU payload carries that nonce and that NVIDIA NRAS verifies it.",
    );
    expect(said).toContain(
      "They do not show which image the TD runs, and so not that the key stays inside it: the measurement is not pinned, so `quote_verified` stays false. A8 was not run.",
    );
    expect(said).not.toContain("nothing here shows yet that the signing key");
    expect(said).toContain("The attestation ties each answer to the key that signed it");
    // A5 compares the report with the evidence's nonce; whether the chat carried it is A8's question.
    expect(said).toContain(
      "- A5: the last 32 bytes of the report data, and the report's `request_nonce`, are the evidence's nonce.",
    );
    expect(said).toContain(
      "the standard request for this invoice at this ledger position: A5 and A6 bind the attestation report, not the chat",
    );
    // Seq 1 wrote "50", which is not 50 USDC, and only the rehearsal's raw spend reached the contract. The section
    // counts three attempts (10:48, 10:53, 12:22), so it does not call the rehearsal's the second.
    expect(said).toContain('seq 1 wrote the amount as `"50"`');
    expect(said).toContain("These 5 entries come from the team's own three attempts on 2026-11-10");
    expect(said).toContain(
      "the contract refused the raw spend of the rehearsal's attempt (seq 3 and 4)",
    );
    expect(said).not.toContain("raw spend of the second attempt");
    expect(said).not.toContain("and code and the contract refused");
  });

  it("gives the offline command, which keeps working, and the live ones, which check c ends by design", () => {
    expect(text).toContain(
      "npx probarion verify --offline docs/evidence/canary-vault/snapshot-2026-11-11.json",
    );
    expect(text).toContain(
      `npx probarion verify --network testnet --vault ${VAULT} --ledger docs/evidence/canary-vault/${LEDGER}`,
    );
    expect(text).toContain("check c fails on this file, by design");
    expect(flat(text)).toContain(
      "The online run above reads the chain too, so its command stops passing check c at the same point.",
    );
    // Two live runs on 2026-11-11: the snapshot is the one of 07:17 UTC, not the online run's.
    expect(flat(text)).toContain(
      "is the snapshot the live run of 2026-11-11 at 07:17 UTC wrote (`--snapshot`)",
    );
    expect(snapshot.taken_at.startsWith("2026-11-11T07:17")).toBe(true);
    expect(flat(text)).toContain(
      "The offline and live commands were run again on 2026-11-11 with the CLI built from this repository at commit `75a7262`, and both end `RESULT: PASS`.",
    );
    expect(text).not.toContain("Both commands were run again");
  });

  it("counts the three live runs it records in its Check it lead", () => {
    const lead = flat(section(readme, "## Check it"));
    expect(lead).toContain("Three live runs are recorded.");
    expect(lead).toContain(
      "The first, on 2026-11-10, had no ledger and fails check c. The second, on 2026-11-11, has the signed ledger and passes checks a to i, and the third, the same day, runs the online checks O1 and O2 as well and passes them",
    );
    expect(readme).not.toMatch(/\bTwo live runs are recorded/);
    // The three files it counts.
    for (const name of ["verify-2026-11-10.txt", VERIFY, VERIFY_ONLINE]) {
      expect(readme).toContain(`(${name})`);
    }
  });
});
