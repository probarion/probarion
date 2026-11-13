// The mainnet vault's files the site serves under /samples/mainnet, so that `npx -y probarion@0.1.1 verify --network
// mainnet` passes in an empty folder with no clone: each one a byte-for-byte copy of its source in docs/, at an
// address that keeps its name when the ledger is refreshed. A new mainnet spend or anchor changes the judge's
// MAINNET_V0_LEDGER, and this test then fails until the served copy is refreshed in the same change.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ledgerPrefix, MAINNET_V0_INVOICES, MAINNET_V0_LEDGER } from "../../../scripts/judge.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const ROOT = join(WEB, "..", "..");
const SERVED_DIR = join(WEB, "public", "samples", "mainnet");
// The S2 run's snapshot (2026-11-13): the chain as the vault's latest committed ledger was verified against.
const S2_SNAPSHOT = "docs/evidence/mainnet-v0/s2-2026-11-13/snapshot-2026-11-13.json";

/** Each served file, by its path under /samples/mainnet, and the repository file it copies. */
const SERVED: { path: string; source: string }[] = [
  { path: "ledger.jsonl", source: MAINNET_V0_LEDGER },
  { path: "mainnet-proof.json", source: "docs/mainnet-proof.json" },
  { path: "evidence/v0-decision-m001.json", source: "docs/evidence/v0-decision-m001.json" },
  ...MAINNET_V0_INVOICES.map((source: string) => ({
    path: `invoices/${basename(source)}`,
    source,
  })),
];

const served = (path: string) => readFileSync(join(SERVED_DIR, ...path.split("/")));
const source = (path: string) => readFileSync(join(ROOT, ...path.split("/")));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? filesUnder(join(dir, d.name))
      : [relative(SERVED_DIR, join(dir, d.name)).split("\\").join("/")],
  );
}

type Snapshot = {
  ledger: { link: string }[];
  chain: { spends: { id: number; decision_hash: string }[] };
  pre_ledger_decision_hashes: string[];
};

const ledgerBodies = () =>
  served("ledger.jsonl")
    .toString("utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map(
      (l) =>
        JSON.parse(l).body as {
          seq: number;
          kind: string;
          invoice_hash: string;
          evidence?: object;
        },
    );

describe("the mainnet samples the site serves", () => {
  it.each(SERVED)("serves $path byte for byte as $source", ({ path, source: from }) => {
    const copy = served(path);
    const original = source(from);
    expect(sha256(copy)).toBe(sha256(original));
    expect(copy.equals(original)).toBe(true);
  });

  it("is marked -text in .gitattributes, so git keeps the copies' bytes as it keeps their sources'", () => {
    expect(source(".gitattributes").toString("utf8")).toMatch(
      /^apps\/web\/public\/samples\/mainnet\/\*\* -text$/m,
    );
  });

  it("holds those files and no other, so a stale copy cannot stay behind", () => {
    expect(filesUnder(SERVED_DIR).sort()).toEqual(SERVED.map((f) => f.path).sort());
  });

  it("serves the ledger the judge verifies the mainnet vault with, which starts with the S2 snapshot's", () => {
    expect(MAINNET_V0_LEDGER).toMatch(/^docs\/evidence\/mainnet-v0\/.+\.jsonl$/);
    const snapshot = JSON.parse(source(S2_SNAPSHOT).toString("utf8")) as Snapshot;
    const s2 = snapshot.ledger.map((e) => JSON.stringify(e)).join("\n");
    expect(ledgerPrefix(s2, served("ledger.jsonl").toString("utf8"))).toEqual({
      ok: true,
      detail: `its first ${snapshot.ledger.length} entries are the committed ledger's, link for link`,
    });
  });

  it("serves the invoice text of every attested decision in the ledger, and only those", () => {
    const attested = new Set(
      ledgerBodies()
        .filter((b) => b.kind === "decision" && b.evidence !== undefined)
        .map((b) => b.invoice_hash),
    );
    const invoices = SERVED.filter((f) => f.path.startsWith("invoices/"));
    expect(invoices).toHaveLength(MAINNET_V0_INVOICES.length);
    expect(new Set(invoices.map((f) => sha256(served(f.path))))).toEqual(attested);
  });

  it("serves the pre-ledger decision check d needs: the one whose sha256 is spend 1's decision_hash", () => {
    const snapshot = JSON.parse(source(S2_SNAPSHOT).toString("utf8")) as Snapshot;
    const preLedger = snapshot.chain.spends.filter((s) =>
      snapshot.pre_ledger_decision_hashes.includes(s.decision_hash),
    );
    expect(preLedger.map((s) => s.id)).toEqual([1]);
    const evidence = SERVED.filter((f) => f.path.startsWith("evidence/"));
    // probarion 0.1.1 reads every v0-decision-*.json in --evidence <dir>, and nothing else there.
    for (const f of evidence) expect(f.path).toMatch(/^evidence\/v0-decision-[^/]+\.json$/);
    expect(evidence.map((f) => sha256(served(f.path)))).toEqual(
      preLedger.map((s) => s.decision_hash),
    );
  });
});

describe("the no-clone workflow", () => {
  const wf = source(".github/workflows/no-clone-verify.yml")
    .toString("utf8")
    .replace(/\r\n/g, "\n");

  it("reads only: no checkout, no secret, no token, no write", () => {
    expect(wf).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(wf).not.toMatch(/write|secrets|GITHUB_TOKEN|github\.token|id-token/i);
    expect(wf).not.toMatch(/pull_request_target|workflow_run|actions\/checkout/);
    expect(wf).not.toMatch(/\b(publish|deploy)\b/i);
  });

  it("runs on Node 22 and 24, on pull requests and on pushes to dev and main", () => {
    expect(wf).toMatch(/^ {2}pull_request:\n/m);
    expect(wf).toMatch(/^ {2}push:\n {4}branches: \[main, dev\]\n/m);
    expect(wf).toMatch(/^ {8}node: \[22, 24\]\n/m);
  });

  it("downloads the served files of the pushed commit and verifies with probarion 0.1.1", () => {
    expect(wf).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, plain text here
      "https://raw.githubusercontent.com/probarion/probarion/${{ github.event.pull_request.head.sha || github.sha }}/apps/web/public/samples/mainnet",
    );
    for (const f of SERVED.filter((s) => !s.path.startsWith("invoices/"))) {
      expect(wf).toContain(`-o ${f.path} "$B/${f.path}"`);
    }
    expect(wf).toContain(
      "npx -y probarion@0.1.1 verify --network mainnet --vault v0.probarion.near \\\n",
    );
    expect(wf).toContain("--ledger ledger.jsonl --evidence evidence --proof mainnet-proof.json");
  });
});
