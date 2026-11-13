// The /proof pages and snapshot.json as a visitor meets them: what each state shows, and what an invalid or hidden
// vault answers. The reader is a fake (no RPC, no network); the snapshots are signed fixtures that core checks.
import type { LedgerEntry, Snapshot } from "@probarion/core";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, DbError } from "@/lib/db/port";
import {
  CLI_NOTE,
  CLI_ON_NPM,
  CLI_SETUP_LINES,
  cli,
  EVIDENCE_CLONE,
  PRE_LEDGER_FLAGS,
} from "@/lib/proof/cli";
import { ProofEvidenceError } from "@/lib/proof/evidence";
import { clearProofCache, type ProofDeps } from "@/lib/proof/service";
import { elementsOf } from "./fixtures/elements";
import { MAINNET_ORIGIN, TESTNET_ORIGIN } from "./fixtures/networks";
import { noServiceDb, type ProofState, proofSnapshot, publicDbFor, txHash } from "./fixtures/proof";

const h = vi.hoisted(() => ({
  deps: null as unknown as ProofDeps,
  depsCalls: 0,
  limitCalls: [] as string[],
  allowed: true,
  env: { NEAR_NETWORK: "mainnet", PROBARION_VAULT_ID: null as string | null },
  /** The vault public_vault answers for (/proof with no vault), and the anon calls made. */
  publicVault: null as { vault_id: string; network: string } | null,
  publicCalls: [] as string[],
  /** The anon client fails (a database outage seen by /proof with no vault). */
  publicDown: false,
  /** The service database client cannot be built (no or a malformed environment). */
  serviceDown: false,
  /** The rate limiter's database call fails. */
  limitDown: false,
  /** Building the proof page's dependencies fails. */
  depsDown: false,
  /** The server's environment does not parse. */
  envDown: false,
  /** Structured warn lines (proof.unavailable), kept off the test output. */
  warned: [] as string[],
  /** Building the decision rows fails, and how many times they were built. */
  rowsDown: false,
  rowsBuilt: 0,
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7" }),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("@/lib/db/clients", () => ({
  publicDb: (): Db => ({
    rpc: async <T>(fn: string, p: Record<string, unknown> = {}) => {
      h.publicCalls.push(fn);
      if (h.publicDown) throw new DbError("db_error", "connection reset");
      if (fn !== "public_vault") throw new Error(`unexpected ${fn}`);
      const v = h.publicVault;
      return (
        v !== null && p.vault_id === v.vault_id
          ? { ...v, kind: "team", display_name: "demo" }
          : null
      ) as T;
    },
  }),
  serviceDb: (): Db => {
    if (h.serviceDown) throw new Error("Invalid environment: SUPABASE_URL is required");
    return {
      rpc: async <T>(fn: string, p: Record<string, unknown> = {}) => {
        if (fn !== "rate_limit_take") throw new Error(`unexpected ${fn}`);
        h.limitCalls.push(String(p.bucket));
        if (h.limitDown) throw new DbError("db_error", "connection reset");
        return {
          allowed: h.allowed,
          remaining: 0,
          reset_at: new Date(Date.now() + 30_000).toISOString(),
        } as T;
      },
    };
  },
}));
// The real decision rows, counted, or a failure when the test asks for one.
vi.mock("@/lib/proof/decisions", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/proof/decisions")>();
  return {
    ...real,
    decisionRows: async (...args: Parameters<typeof real.decisionRows>) => {
      h.rowsBuilt++;
      if (h.rowsDown) throw new Error("the rows broke");
      return real.decisionRows(...args);
    },
  };
});
vi.mock("@/lib/proof/deps", () => ({
  proofDeps: async () => {
    h.depsCalls++;
    if (h.depsDown) throw new Error("the database client could not be built");
    return h.deps;
  },
}));
// The settings in this file are one network's: the default network (so every request is for it), and its demo vault.
vi.mock("@/lib/env", async () => {
  const { networkPart } = await import("./fixtures/networks");
  return {
    getEnv: () => {
      if (h.envDown) throw new Error("Invalid environment: SUPABASE_URL is required");
      const network = h.env.NEAR_NETWORK as "mainnet" | "testnet";
      return networkPart({
        defaultNetwork: network,
        [network]: { demoVaultId: h.env.PROBARION_VAULT_ID },
      });
    },
  };
});

import Home from "@/app/page";
import { GET as GET_LEDGER } from "@/app/proof/[vault]/ledger.jsonl/route";
import ProofPage, { generateMetadata } from "@/app/proof/[vault]/page";
import { GET as GET_PAYMENTS } from "@/app/proof/[vault]/payments.csv/route";
import { GET } from "@/app/proof/[vault]/snapshot.json/route";
import ProofIndex, { generateMetadata as proofIndexMetadata } from "@/app/proof/page";
import { ProofLimited, ProofView } from "@/components/proof/ProofView";
import { SiteHeader } from "@/components/site/SiteHeader";
import { TamperPanel } from "@/components/site/TamperPanel";
import { decisionRows } from "@/lib/proof/decisions";
import { PAYMENTS_COLUMNS, paymentsCsv } from "@/lib/proof/payments-csv";
import { SITE_NAV } from "@/lib/routes";

/** True when the text still holds a right-to-left override, a line separator or a BEL. */
const hasUnsafe = (text: string): boolean =>
  [...text].some((c) => [0x202e, 0x2028, 0x07].includes(c.codePointAt(0) ?? -1));

async function digest(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    return String((e as { digest?: unknown }).digest ?? e);
  }
  return "no throw";
}

const params = (vault: string) => ({ params: Promise.resolve({ vault }) });
const page = (vault: string) => ProofPage(params(vault));
const html = async (vault: string) => renderToStaticMarkup((await page(vault)) as ReactElement);
const get = (vault: string) =>
  GET(
    new Request(`https://probarion.xyz/proof/${vault}/snapshot.json`, {
      headers: { "x-forwarded-for": "203.0.113.7" },
    }),
    params(vault),
  );

/** Serve `snapshot` as a public vault of `network`, through the fake anon Db. */
function serve(snapshot: Snapshot, over: Partial<ProofDeps> = {}) {
  const calls: string[] = [];
  h.deps = {
    network: snapshot.network,
    publicDb: publicDbFor(
      snapshot.vault,
      snapshot.network,
      snapshot.ledger as LedgerEntry[],
      calls,
    ),
    serviceDb: noServiceDb,
    sessionAccount: null,
    makeReader: () => ({ snapshot: async () => structuredClone(snapshot) }),
    // A fixed clock, so nothing the page prints depends on when the test runs.
    now: () => Date.parse("2026-11-09T10:00:00.000Z"),
    ...over,
  };
  h.env.NEAR_NETWORK = snapshot.network;
  return calls;
}

async function served(state: ProofState, network: "mainnet" | "testnet" = "mainnet") {
  const snapshot = await proofSnapshot(state, { network });
  serve(snapshot);
  return { snapshot, out: await html(snapshot.vault) };
}

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const warnedReasons = () => h.warned.map((l) => JSON.parse(l) as { msg: string; reason: string });

beforeEach(() => {
  clearProofCache();
  h.depsCalls = 0;
  h.limitCalls = [];
  h.allowed = true;
  h.env = { NEAR_NETWORK: "mainnet", PROBARION_VAULT_ID: null };
  h.publicVault = null;
  h.publicCalls = [];
  h.publicDown = false;
  h.serviceDown = false;
  h.limitDown = false;
  h.depsDown = false;
  h.envDown = false;
  h.warned = [];
  h.rowsDown = false;
  h.rowsBuilt = 0;
  vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
    h.warned.push(String(line));
  });
});
afterEach(() => vi.restoreAllMocks());

describe("/proof/[vault]", () => {
  it("answers 404 for a vault id that is not a NEAR account, before any database or RPC call", async () => {
    for (const bad of ["..", "../etc", "Not A Vault", "a", "x%2Fy", "a..b.near", "acme.near%0A"]) {
      expect(await digest(page(bad)), bad).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    }
    expect(h.limitCalls).toEqual([]);
    expect(h.depsCalls).toBe(0);
  });

  it("answers 404 for a vault that is private or not registered", async () => {
    serve(await proofSnapshot("ok"));
    expect(await digest(page("nobody.vaults.probarion.near"))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("rate-limits per address, and then reads nothing", async () => {
    serve(await proofSnapshot("ok"));
    h.allowed = false;
    const out = text(await html("acme.vaults.probarion.near"));
    expect(out).toContain("Too many proof requests from your address");
    expect(h.limitCalls).toEqual(["proof:203.0.113.7"]);
    expect(h.depsCalls).toBe(0);
  });

  describe("when the database or the server's environment fails", () => {
    const unavailable = async () => {
      const out = text(await html("acme.vaults.probarion.near"));
      expect(out).toContain("No result: the checks did not run");
      expect(out).toContain("database could not be reached right now");
      expect(out).toContain("Nothing on this page is a pass.");
      expect(out).not.toContain("All offline checks pass");
      expect(warnedReasons()).toMatchObject([{ msg: "proof.unavailable", reason: "database" }]);
    };

    it("says the checks did not run when the rate limiter's database call fails", async () => {
      serve(await proofSnapshot("ok"));
      h.limitDown = true;
      await unavailable();
      expect(h.depsCalls).toBe(0);
    });

    it("says the checks did not run when the page's dependencies cannot be built", async () => {
      h.depsDown = true;
      await unavailable();
    });

    it("says the checks did not run when the environment does not parse", async () => {
      h.depsDown = true;
      h.envDown = true;
      await unavailable();
    });

    it("still answers 404 for a private vault and for an id that is not an account", async () => {
      serve(await proofSnapshot("ok"));
      expect(await digest(page("nobody.vaults.probarion.near"))).toBe(
        "NEXT_HTTP_ERROR_FALLBACK;404",
      );
      h.limitDown = true;
      expect(await digest(page("Not A Vault"))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    });
  });

  it("ok: a green 'All offline checks pass', never 'All checks pass'", async () => {
    const { snapshot, out } = await served("ok");
    const t = text(out);
    expect(t).toContain("All offline checks pass");
    expect(t).not.toMatch(/All checks pass/);
    expect(t).not.toContain("Not proven yet");
    expect(t).not.toContain("A check failed");
    expect(out).toMatch(/data-headline="ok"/);
    expect(t).toContain(snapshot.vault);
    expect(t).toContain("Team vault");
    expect(t).toContain("No check failed or is unproven on this snapshot.");
    // Nine checks, each with its status.
    expect(out.match(/data-check="[a-i]"/g)).toHaveLength(9);
    expect(out.match(/data-status="pass"/g)).toHaveLength(9);
  });

  it("titles the table with what it really is, and adds the fixed line about check e (R19)", async () => {
    const t = text((await served("ok")).out);
    expect(t).toContain("These are the checks probarion verify --offline runs on this snapshot.");
    expect(t).not.toMatch(/the same ones/);
    // This vault decides by rules only: no decision carries an attestation, and the line says so.
    expect(t).toContain(
      "No decision in this snapshot was decided with model output, so check (e) has none to prove here. For a decision that is, it proves the signatures, the response and the ledger position agree; it does not verify the TDX quote (needs --online , and even then the measurement is not pinned) or the request (needs the invoice, A8).",
    );
  });

  it("phrases the check (e) line per attested decision when a decision used the model, attested or not", async () => {
    for (const evidence of [{ quote: "q" }, null]) {
      clearProofCache();
      const snapshot = await proofSnapshot("ok");
      const entry = snapshot.ledger[0] as LedgerEntry;
      entry.body = { ...entry.body, decided_by: "model+rules", evidence: evidence as never };
      serve(snapshot);
      const t = text(await html(snapshot.vault));
      expect(t, String(evidence)).toContain(
        "For each attested decision, check (e) here proves the signatures, the response and the ledger position agree; it does not verify the TDX quote (needs --online , and even then the measurement is not pinned) or the request (needs the invoice, A8).",
      );
      expect(t).not.toContain("decided with model output");
      expect(t).not.toContain("carries an attestation");
    }
  });

  it("does not say 'no model output' for a decision whose decided_by is null or unknown", async () => {
    for (const decidedBy of [null, "model-only"]) {
      clearProofCache();
      const snapshot = await proofSnapshot("ok");
      const entry = snapshot.ledger[0] as LedgerEntry;
      entry.body = { ...entry.body, decided_by: decidedBy as never };
      serve(snapshot);
      const t = text(await html(snapshot.vault));
      expect(t, String(decidedBy)).toContain(
        "For each attested decision, check (e) here proves the signatures",
      );
      expect(t).not.toContain("decided with model output");
    }
  });

  it("calls a rules-only decision that carries evidence what it is: not model output", async () => {
    const snapshot = await proofSnapshot("ok");
    const entry = snapshot.ledger[0] as LedgerEntry;
    entry.body = { ...entry.body, decided_by: "rules-only", evidence: { quote: "q" } as never };
    serve(snapshot);
    const t = text(await html(snapshot.vault));
    expect(t).toContain(
      "No decision in this snapshot was decided with model output, so check (e) has none to prove here.",
    );
    expect(t).not.toContain("carries an attestation");
  });

  it("unproven: an amber 'Not proven yet', the spend, why, and how to prove it", async () => {
    const { snapshot, out } = await served("unproven");
    const t = text(out);
    expect(t).toContain("Not proven yet");
    expect(t).not.toContain("All offline checks pass");
    expect(t).not.toContain("A check failed");
    expect(out).toMatch(/data-headline="unproven"/);
    expect(out).toMatch(/data-check="h"[^>]*data-status="unproven"/);
    expect(t).toContain("not proven");
    expect(t).toContain("Spend #1");
    expect(t).toContain("No payment entry in the ledger names the transaction that burned it.");
    expect(t).toContain(
      `Download probarion-${snapshot.vault}-ledger.jsonl ${CLI_ON_NPM ? "" : "into the repository folder (set up below) "}just before you run the command (replace any earlier copy; again if the vault has acted since), then run:`,
    );
    expect(out).toContain(`href="/proof/${snapshot.vault}/ledger.jsonl"`);
    expect(out).toContain(`download="probarion-${snapshot.vault}-ledger.jsonl"`);
    expect(t).toContain(
      "Find the tx hash on the vault&#x27;s explorer page: the transaction that paid the spend, or the approver&#x27;s approve transaction.",
    );
    expect(t).toContain(
      cli(
        `verify --network mainnet --vault ${snapshot.vault} --ledger probarion-${snapshot.vault}-ledger.jsonl --burn-tx 1=&lt;tx hash&gt;`,
      ),
    );
  });

  it("failed: a red 'A check failed' that names the check and the first broken entry", async () => {
    const { out } = await served("failed");
    const t = text(out);
    expect(t).toContain("A check failed");
    expect(t).not.toContain("All offline checks pass");
    expect(t).not.toContain("Not proven yet");
    expect(out).toMatch(/data-headline="failed"/);
    expect(out).toMatch(/data-check="c"[^>]*data-status="fail"/);
    expect(t).toContain("Failed: check (c).");
    expect(t).toContain("The first broken ledger entry is seq 0.");
  });

  it("ends with the next step, whatever the result: a link to the console, after the steps to verify", async () => {
    for (const state of ["ok", "unproven", "failed"] as const) {
      const { out } = await served(state);
      expect(out, state).toMatch(
        /<a[^>]*href="\/console"[^>]*>Put your agent behind a mandate <span aria-hidden="true">→<\/span><\/a>/,
      );
      const t = text(out);
      expect(t.indexOf("Put your agent behind a mandate"), state).toBeGreaterThan(
        t.indexOf("Verify it yourself, offline"),
      );
    }
  });

  it("does not offer the next step when the checks did not run", async () => {
    const { snapshot } = await served("ok");
    h.limitDown = true;
    clearProofCache();
    expect(await html(snapshot.vault)).not.toContain("Put your agent behind a mandate");
  });

  it("links the explorer of the vault's network, the download and the offline command", async () => {
    const { snapshot, out } = await served("ok", "testnet");
    expect(snapshot.vault).toBe("acme.vaults.probarion.testnet");
    expect(out).toContain(`href="https://testnet.nearblocks.io/address/${snapshot.vault}"`);
    expect(out).not.toContain("https://nearblocks.io/");
    expect(out).toContain(`href="/proof/${snapshot.vault}/snapshot.json"`);
    const t = text(out);
    expect(t).toContain(cli(`verify --offline probarion-${snapshot.vault}-snapshot.json`));
    expect(t).toContain(
      cli(
        `verify --network testnet --vault ${snapshot.vault} --ledger probarion-${snapshot.vault}-ledger.jsonl`,
      ),
    );
    expect(t).toContain(
      `To read the chain half again instead of trusting the file, download probarion-${snapshot.vault}-ledger.jsonl ${CLI_ON_NPM ? "" : "into the repository folder "}just before you run the command (replace any earlier copy; again if the vault has acted since), then run:`,
    );
    expect(out).toContain(`href="/proof/${snapshot.vault}/ledger.jsonl"`);
    if (!CLI_ON_NPM) expect(t).not.toContain("npx probarion");
  });

  it("offers the payments CSV next to snapshot.json, named by the route, in the same pill row", async () => {
    const { snapshot, out } = await served("ok", "testnet");
    const snap = out.indexOf(`href="/proof/${snapshot.vault}/snapshot.json"`);
    const csv = out.indexOf(`href="/proof/${snapshot.vault}/payments.csv"`);
    const verify = out.indexOf(`href="#verify"`);
    expect(snap).toBeGreaterThan(-1);
    expect(csv).toBeGreaterThan(snap);
    expect(verify).toBeGreaterThan(csv);
    // One link: a pill like "Verify it yourself", with a bare download attribute, so the file keeps the route's name.
    expect(out.split("/payments.csv").length - 1).toBe(1);
    const classOf = (href: string) => {
      const end = out.indexOf(`" href="${href}"`);
      return out.slice(out.lastIndexOf('<a class="', end) + '<a class="'.length, end);
    };
    expect(classOf("#verify")).not.toBe("");
    expect(classOf(`/proof/${snapshot.vault}/payments.csv`)).toBe(classOf("#verify"));
    expect(out).toContain(
      `href="/proof/${snapshot.vault}/payments.csv" download="">Download payments (CSV)</a>`,
    );
  });

  it("lists each decision of the checked snapshot under the checks, with its audit anchors (G7, G4)", async () => {
    const { snapshot, out } = await served("ok", "testnet");
    const t = text(out);
    expect(out).toContain('id="decisions"');
    // The one decision, by its seq, and the spend the chain binds to it.
    expect(out).toContain('id="seq-0"');
    expect(out).toContain('id="spend-1"');
    expect(out).toMatch(/<a[^>]*href="#spend-1"[^>]*>Link to this decision<\/a>/);
    expect(out).toMatch(/<a[^>]*href="#decisions"[^>]*>Each decision, below<\/a>/);
    expect(t).toContain("1 decision, 0 made with model output");
    expect(t).toContain("No model was used.");
    expect(t.indexOf("Decisions Every decision")).toBeGreaterThan(t.indexOf("Checks These are"));
    // The page hands ProofView the rows of the very snapshot the checks ran on.
    clearProofCache();
    const [view] = elementsOf(await page(snapshot.vault), ProofView);
    if (!view) throw new Error("the page did not render ProofView");
    expect((view.props as { decisions: unknown }).decisions).toMatchObject([
      { id: "seq-0", spendIds: ["spend-1"] },
    ]);
  });

  it("builds the decision rows once per cached snapshot, not once per view", async () => {
    const { snapshot } = await served("ok", "testnet");
    expect(h.rowsBuilt).toBe(1);
    // The next views within the 60 s get the cached result, and with it the same rows.
    for (let i = 0; i < 3; i++) await html(snapshot.vault);
    expect(h.rowsBuilt).toBe(1);
    // A new gather is a new snapshot, so its rows are built again.
    clearProofCache();
    await html(snapshot.vault);
    expect(h.rowsBuilt).toBe(2);
  });

  it("still shows the checks when the decision rows cannot be built, says so, and logs why", async () => {
    h.rowsDown = true;
    const { snapshot, out } = await served("ok", "testnet");
    const t = text(out);
    expect(t).toContain("Checks These are");
    expect(out).toContain('id="check-e"');
    expect(t).toContain(
      "The decisions could not be listed from this snapshot. The checks above still ran on it.",
    );
    expect(out).not.toContain('id="seq-0"');
    expect(warnedReasons()).toMatchObject([{ msg: "proof.decisions_unavailable" }]);
    expect(h.warned.join("\n")).toContain("the rows broke");
    // A failed build is not kept: the next view of the same cached snapshot tries again.
    h.rowsDown = false;
    const again = await html(snapshot.vault);
    expect(again).toContain('id="seq-0"');
  });

  it("renders an older decision's full card when the address names its seq (?seq=N)", async () => {
    const snapshot = await proofSnapshot("ok", { network: "testnet" });
    serve(snapshot);
    const seqOf = async (search: Record<string, string | string[] | undefined>) => {
      const tree = await ProofPage({
        ...params(snapshot.vault),
        searchParams: Promise.resolve(search),
      });
      const [view] = elementsOf(tree, ProofView);
      if (!view) throw new Error("the page did not render ProofView");
      return (view.props as { fullSeq: unknown }).fullSeq;
    };
    expect(await seqOf({ seq: "0" })).toBe(0);
    expect(await seqOf({ seq: "21" })).toBe(21);
    for (const bad of ["", "-1", "01", "1.5", "x", "1e3", "12345678901"]) {
      expect(await seqOf({ seq: bad }), bad).toBeNull();
    }
    expect(await seqOf({ seq: ["3", "4"] })).toBeNull();
    expect(await seqOf({})).toBeNull();
    expect(await seqOf({ other: "1" })).toBeNull();
  });

  it("promises no identity between the page and the download: it gives the full time to compare", async () => {
    const { snapshot, out } = await served("ok");
    const t = text(out);
    // The page's taken_at in full, as the CLI prints it ("snapshot taken <taken_at>").
    expect(snapshot.taken_at).toBe("2026-11-08T12:00:00.000Z");
    const step1 =
      "a snapshot of this vault (its ledger and chain data), taken when you click or shortly before. The verifier prints when it was taken. If it prints 2026-11-08T12:00:00.000Z , it is the very snapshot these checks used, and a verifier built from the current repository gives the same result; otherwise it is another snapshot of this vault, and its result can differ from this page.";
    expect(t).toContain(step1);
    expect(t).toContain("snapshot taken 2026-11-08T12:00:00.000Z");
    expect(t).toContain("Checked 2026-11-09 10:00 UTC");
    for (const gone of [
      "matches this page unless",
      "unless the vault changed",
      "newer one",
      "up to a minute",
      "Within a minute of this page",
      "2026-11-08 12:00 UTC",
      "the chain data these checks used, taken",
    ]) {
      expect(t, gone).not.toContain(gone);
    }
  });

  it("shows the command that runs today: npx probarion from npm, or else the repository's", async () => {
    const { snapshot, out } = await served("ok");
    const t = text(out);
    expect(t).toContain(cli(`verify --offline probarion-${snapshot.vault}-snapshot.json`));
    expect(t).toContain(CLI_NOTE);
    const raw = out.replace(/<[^>]+>/g, "").replaceAll("&quot;", '"');
    if (CLI_ON_NPM) {
      // npx fetches the package, so there is nothing to set up, and the relative file name needs its folder.
      for (const line of CLI_SETUP_LINES) expect(raw).not.toContain(line);
      expect(t).toContain(
        "In the folder that holds the file, run the open-source verifier. It needs no network and no keys, and prints the result per check for that snapshot:",
      );
      expect(t).not.toContain("repository folder");
      return;
    }
    // The four set-up commands, one per line (as React writes them: & and " escaped).
    // Four commands separated by real newlines, so text without styles (an AI reading the page, say) keeps them apart.
    // A newline before the first command and after the last, so neither runs into the prose around it.
    expect(raw).toContain(`\n${CLI_SETUP_LINES.join("\n")}\n`);
    expect(raw).not.toContain(`:${CLI_SETUP_LINES[0]}`);
    expect(out).toMatch(/whitespace-pre-wrap/);
    expect(t).toContain(
      "From the repository folder, with the file in it, run the open-source verifier. It needs no network and no keys, and prints the result per check for that snapshot:",
    );
    expect(t).not.toContain("npx probarion");
  });

  it("tells a screen reader which links open a new tab", async () => {
    const snapshot = await proofSnapshot("ok");
    snapshot.chain.burns = [
      {
        spend_id: 1,
        tx_hash: txHash(9),
        memo: "WITHDRAW_TO:0x5290",
        intents_owner: snapshot.vault,
        amount: "25000000",
        status: "ok",
      },
    ];
    serve(snapshot);
    const out = await html(snapshot.vault);
    const newTab = out.match(/target="_blank"/g)?.length ?? 0;
    expect(newTab).toBeGreaterThan(5);
    // The withdrawal link says it opens the burn tx.
    expect(text(out)).toContain("Spend #1 burn tx (opens in a new tab)");
    expect(out.match(/<span class="sr-only"> \(opens in a new tab\)<\/span>/g)?.length).toBe(
      newTab,
    );
  });

  it("links /security now that the page is built", async () => {
    const { out } = await served("ok");
    expect(out).toContain('href="/security"');
    expect(text(out)).not.toContain("Security (coming soon)");
  });

  it("shows crafted ledger and chain text with its controls replaced", async () => {
    const snapshot = await proofSnapshot("unproven");
    snapshot.chain.burns = [
      {
        spend_id: 1,
        tx_hash: "not\u202Ea hash",
        memo: "WITHDRAW_TO:\u202Essap",
        intents_owner: "evil\u2028owner",
        amount: "1\u0007",
        status: "ok",
      },
    ];
    serve(snapshot);
    const out = await html(snapshot.vault);
    expect(hasUnsafe(out)).toBe(false);
    expect(out).toContain("WITHDRAW_TO:\uFFFDssap");
    expect(text(out)).toContain("malformed tx hash");
  });

  it("burns: memo, amount in USDC and the intents owner, linked to the burn tx", async () => {
    const snapshot = await proofSnapshot("ok");
    snapshot.chain.burns = [
      {
        spend_id: 1,
        tx_hash: txHash(9),
        memo: "WITHDRAW_TO:0x5290",
        intents_owner: snapshot.vault,
        amount: "25000000",
        status: "ok",
      },
    ];
    serve(snapshot);
    const out = await html(snapshot.vault);
    expect(out).toContain(`href="https://nearblocks.io/txns/${txHash(9)}"`);
    const t = text(out);
    expect(t).toContain("WITHDRAW_TO:0x5290");
    expect(t).toContain("25 USDC");
  });

  it("shows an error state, not a pass, when the evidence file is malformed", async () => {
    serve(await proofSnapshot("ok"), {
      makeReader: () => {
        throw new ProofEvidenceError("the file is not a JSON object");
      },
    });
    const out = await html("acme.vaults.probarion.near");
    const t = text(out);
    expect(out).toMatch(/data-headline="error"/);
    expect(t).toContain("No result: the checks did not run");
    expect(t).toContain("evidence file");
    expect(t).not.toMatch(/All offline checks pass|data-status="pass"/);
    expect(warnedReasons()).toMatchObject([{ msg: "proof.unavailable", reason: "evidence" }]);
  });

  it("shows an error state when the chain cannot be read", async () => {
    serve(await proofSnapshot("ok"), {
      makeReader: () => ({
        snapshot: async () => {
          throw new Error("RPC down");
        },
      }),
    });
    const t = text(await html("acme.vaults.probarion.near"));
    expect(t).toContain("No result: the checks did not run");
    expect(t).toContain(
      "The vault&#x27;s chain data could not be read right now, so the checks were not run.",
    );
    expect(t).not.toContain("RPC down");
    expect(t).not.toContain("All offline checks pass");
    expect(warnedReasons()).toMatchObject([{ msg: "proof.unavailable", reason: "chain" }]);
    // The chain command comes after the set-up, and runs from the repository folder.
    const vault = "acme.vaults.probarion.near";
    const command = cli(
      `verify --network mainnet --vault ${vault} --ledger probarion-${vault}-ledger.jsonl`,
    );
    expect(t).toContain(command);
    expect(t).toContain(
      `download probarion-${vault}-ledger.jsonl ${CLI_ON_NPM ? "" : "into the repository folder "}just before you run the command (replace any earlier copy; again if the vault has acted since), then run:`,
    );
    // What the command needs comes before it, on npm too (Node 24).
    expect(t.indexOf(CLI_NOTE)).toBeGreaterThan(-1);
    expect(t.indexOf(CLI_NOTE)).toBeLessThan(t.indexOf(command));
    expect(t).toContain(
      CLI_ON_NPM
        ? "You can check this vault yourself"
        : "From the repository folder, you can check this vault yourself",
    );
    // Not a pre-ledger vault: no evidence files, so no clone.
    expect(t).not.toContain(EVIDENCE_CLONE);
  });

  it("gives a pre-ledger vault's chain command the clone its evidence flags read, from npm", () => {
    const vault = "v0.probarion.near";
    const t = text(
      renderToStaticMarkup(createElement(ProofLimited, { vault, network: "mainnet" })),
    );
    const command = cli(
      `verify --network mainnet --vault ${vault} --ledger probarion-${vault}-ledger.jsonl ${PRE_LEDGER_FLAGS}`,
    );
    expect(t).toContain(command);
    const clone = `It also reads the repository&#x27;s evidence files: in the same folder, first run ${EVIDENCE_CLONE} .`;
    if (CLI_ON_NPM) {
      expect(t.indexOf(clone)).toBeGreaterThan(t.indexOf(command));
    } else {
      expect(t).not.toContain(clone);
    }
  });

  it("names the ledger, not the chain, when the vault's ledger cannot be read", async () => {
    const snapshot = await proofSnapshot("ok");
    const pub = publicDbFor(snapshot.vault, "mainnet", []);
    serve(snapshot, {
      publicDb: {
        rpc: async <T>(fn: string, p?: Record<string, unknown>) =>
          fn === "public_ledger" ? ([{ seq: 0 }] as T) : pub.rpc<T>(fn, p),
      },
      makeReader: (_vault, store) => ({
        snapshot: async () => {
          await store.all();
          return structuredClone(snapshot);
        },
      }),
    });
    const t = text(await html(snapshot.vault));
    expect(t).toContain("No result: the checks did not run");
    expect(t).toContain(
      "This vault&#x27;s signed ledger could not be read from Probarion&#x27;s database right now, so the checks were not run. Nothing on this page is a pass. Try again in a minute.",
    );
    expect(t).not.toContain("chain data could not be read");
    expect(warnedReasons()).toMatchObject([{ msg: "proof.unavailable", reason: "ledger" }]);
    // The ledger download reads the same database, so neither it nor the command needing it is offered.
    const out = await html(snapshot.vault);
    expect(out).not.toContain(`/proof/${snapshot.vault}/ledger.jsonl`);
    expect(t).not.toContain("--ledger");
  });

  it("names the vault in the title only when it is a valid account id", async () => {
    expect((await generateMetadata(params("acme.vaults.probarion.near"))).title).toBe(
      "Proof · acme.vaults.probarion.near",
    );
    expect((await generateMetadata(params("<script>"))).title).toBe("Proof");
  });

  it("names a vault's page at the address of the request's network, and gives an invalid one no canonical", async () => {
    // The settings of this file serve one network, mainnet by default: every request is for it.
    expect((await generateMetadata(params("acme.vaults.probarion.near"))).alternates).toEqual({
      canonical: `${MAINNET_ORIGIN}/proof/acme.vaults.probarion.near`,
    });
    expect((await generateMetadata(params("<script>"))).alternates).toBeUndefined();
  });
});

describe("/proof/[vault]/snapshot.json", () => {
  it("answers 404 for an invalid vault id, before any database or RPC call", async () => {
    for (const bad of ["..", "Not A Vault", "a", 'x"; filename="evil']) {
      const res = await get(bad);
      expect(res.status, bad).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    expect(h.limitCalls).toEqual([]);
    expect(h.depsCalls).toBe(0);
  });

  it("downloads a snapshot of the vault, named after it, cached only when public", async () => {
    const snapshot = await proofSnapshot("ok");
    serve(snapshot);
    const res = await get(snapshot.vault);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="probarion-${snapshot.vault}-snapshot.json"`,
    );
    // Never reused by a browser: each click asks the route again.
    expect(res.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
    expect(await res.text()).toBe(`${JSON.stringify(snapshot, null, 2)}\n`);
    expect(h.limitCalls).toEqual(["snapshot:203.0.113.7"]);
  });

  it("is never cached for a member's view of a private vault", async () => {
    const snapshot = await proofSnapshot("ok");
    serve(snapshot, {
      publicDb: { rpc: async <T>() => null as T },
      serviceDb: {
        rpc: async <T>(fn: string) =>
          (fn === "member_role"
            ? {
                tenant_id: "00000000-0000-0000-0000-000000000001",
                vault_id: snapshot.vault,
                network: "mainnet",
                kind: "external",
                role: "owner",
              }
            : null) as T,
      },
      sessionAccount: "owner.near",
    });
    const res = await get(snapshot.vault);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("answers 404 for a hidden vault, 429 when rate-limited, 503 when the checks could not run", async () => {
    const snapshot = await proofSnapshot("ok");
    serve(snapshot);
    expect((await get("nobody.vaults.probarion.near")).status).toBe(404);

    h.allowed = false;
    const limited = await get(snapshot.vault);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    h.allowed = true;

    clearProofCache();
    serve(snapshot, {
      makeReader: () => ({
        snapshot: async () => {
          throw new Error("RPC down");
        },
      }),
    });
    const down = await get(snapshot.vault);
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: "unavailable" });
    expect(warnedReasons()).toMatchObject([{ msg: "proof.unavailable", reason: "chain" }]);
  });
});

describe("/proof", () => {
  it("names itself at the address of the request's network", async () => {
    expect((await proofIndexMetadata()).alternates).toEqual({
      canonical: `${MAINNET_ORIGIN}/proof`,
    });
    h.env = { NEAR_NETWORK: "testnet", PROBARION_VAULT_ID: null };
    expect((await proofIndexMetadata()).alternates).toEqual({
      canonical: `${TESTNET_ORIGIN}/proof`,
    });
  });

  it("sends a visitor to the demo vault when its proof page is public", async () => {
    h.env = { NEAR_NETWORK: "testnet", PROBARION_VAULT_ID: "demo.vaults.probarion.testnet" };
    h.publicVault = { vault_id: "demo.vaults.probarion.testnet", network: "testnet" };
    expect(await digest(() => ProofIndex())).toMatch(
      /^NEXT_REDIRECT;[a-z]+;\/proof\/demo\.vaults\.probarion\.testnet;/,
    );
  });

  it("explains how to open a vault, instead of a 404, when the demo vault is missing, invalid, private or on the other network", async () => {
    const cases: [string | null, { vault_id: string; network: string } | null][] = [
      [null, null],
      ["../etc", null],
      ["v0.probarion.testnet", null],
      [
        "demo.vaults.probarion.testnet",
        { vault_id: "demo.vaults.probarion.testnet", network: "mainnet" },
      ],
    ];
    for (const [demo, row] of cases) {
      h.env = { NEAR_NETWORK: "testnet", PROBARION_VAULT_ID: demo };
      h.publicVault = row;
      const out = text(renderToStaticMarkup((await ProofIndex()) as ReactElement));
      expect(out, String(demo)).toContain("No public vault is listed here yet.");
      expect(out, String(demo)).toContain("A vault&#x27;s owner must make its proof page public");
    }
    // A missing id, and one that is not an account, are never looked up.
    expect(h.publicCalls).toEqual(["public_vault", "public_vault"]);
  });

  it("explains how to open a vault, instead of an error page, when the database cannot be reached", async () => {
    h.env = { NEAR_NETWORK: "testnet", PROBARION_VAULT_ID: "demo.vaults.probarion.testnet" };
    h.publicDown = true;
    const out = text(renderToStaticMarkup((await ProofIndex()) as ReactElement));
    expect(out).toContain("No public vault is listed here yet.");
    expect(out).toContain("A vault&#x27;s owner must make its proof page public");
    expect(warnedReasons()).toMatchObject([{ msg: "proof.demo_unavailable" }]);
  });

  it("is still a page when the server's environment does not parse", async () => {
    h.envDown = true;
    const out = text(renderToStaticMarkup((await ProofIndex()) as ReactElement));
    expect(out).toContain("No public vault is listed here yet.");
    expect(warnedReasons()).toMatchObject([{ msg: "proof.demo_unavailable" }]);
  });

  describe("with no public demo vault", () => {
    const index = (vault?: string | string[]) =>
      ProofIndex(vault === undefined ? {} : { searchParams: Promise.resolve({ vault }) });
    const render = async (vault?: string | string[]) =>
      renderToStaticMarkup((await index(vault)) as ReactElement);

    beforeEach(() => {
      h.env = { NEAR_NETWORK: "testnet", PROBARION_VAULT_ID: null };
      h.publicVault = null;
    });

    it("is a real page: what a proof page shows, that none is listed, and that an owner must make one public", async () => {
      const out = text(await render());
      expect(out).toContain("checks a to i with explorer links");
      expect(out).toContain("a ledger and a snapshot file you can download");
      expect(out).toContain("Offline, the verifier checks that file against itself.");
      expect(out).toContain("The page also gives the command that reads the chain again.");
      expect(out).toContain("No public vault is listed here yet.");
      expect(out).toContain("A vault&#x27;s owner must make its proof page public first.");
      expect(out).toContain("If the owner has not, that address answers page not found.");
      expect(out).not.toContain("to see a vault&#x27;s checks");
    });

    it("has a labelled GET form that works with no JavaScript", async () => {
      const out = await render();
      expect(out).toContain('method="get"');
      expect(out).toContain('action="/proof"');
      expect(out).toContain('for="proof-vault"');
      expect(out).toContain('id="proof-vault"');
      expect(out).toContain('name="vault"');
      expect(out).not.toContain("proof-vault-error");
      expect(out).not.toContain("autofocus");
    });

    it("stays quiet on an empty submit", async () => {
      expect(await render("")).not.toContain("proof-vault-error");
    });

    it("sends a NEAR account on to its proof page", async () => {
      expect(await digest(() => index("alice.testnet"))).toMatch(
        /^NEXT_REDIRECT;[a-z]+;\/proof\/alice\.testnet;/,
      );
      expect(await digest(() => index("  alice.testnet "))).toMatch(
        /^NEXT_REDIRECT;[a-z]+;\/proof\/alice\.testnet;/,
      );
    });

    it("shows an inline error for anything else, instead of a 404", async () => {
      const typed = ["Not A Vault", "a", "../etc/passwd", "x".repeat(65), ["a b", "c"], " ", "   "];
      for (const bad of typed) {
        const out = await render(bad);
        expect(out, String(bad)).toContain('id="proof-vault-error"');
        expect(out, String(bad)).toContain('aria-invalid="true"');
        // Focus lands on the input, so a screen reader reads its label and the error.
        expect(out, String(bad)).toContain("autofocus");
        expect(text(out), String(bad)).toContain("That is not a NEAR account.");
      }
    });

    it("escapes what was typed, and never makes it a link", async () => {
      const out = await render('"><script>alert(1)</script>');
      expect(out).not.toContain("<script>");
      expect(out).not.toContain('href="&quot;');
    });

    it("keeps the ledger test on the page, so it does not dead-end", async () => {
      const out = text(await render());
      expect(out).toContain("Try the verifier here");
      expect(out).toContain("Change an amount");
      expect(out).toContain("All 9 offline checks pass.");
    });

    it("gives its ledger test no link to /proof: the form above it is the next step here", async () => {
      const panels = elementsOf(await index(), TamperPanel);
      expect(panels.map((p) => (p.props as { next?: boolean }).next)).toEqual([undefined]);
    });

    it("still prefers the public demo vault to the form", async () => {
      h.env = { NEAR_NETWORK: "testnet", PROBARION_VAULT_ID: "demo.vaults.probarion.testnet" };
      h.publicVault = { vault_id: "demo.vaults.probarion.testnet", network: "testnet" };
      expect(await digest(() => index("alice.testnet"))).toMatch(
        /^NEXT_REDIRECT;[a-z]+;\/proof\/demo\.vaults\.probarion\.testnet;/,
      );
    });
  });
});

describe("the landing page and the menu", () => {
  it("link the proof page, and no longer call it coming", () => {
    const out = renderToStaticMarkup(createElement(Home));
    expect(renderToStaticMarkup(createElement(SiteHeader))).toContain(`href="/proof"`);
    expect(text(out)).not.toMatch(/are coming/);
    expect(text(out)).toContain(cli("verify --offline"));
    expect(text(out)).toContain("packages/core/test/fixtures/valid-snapshot.json");
    // Step 5's labelled note, read as a person reads it: no new-tab arrow, no screen-reader words.
    const note = text(out.replace(/<span[^>]*aria-hidden="true"[^>]*>↗<\/span>/g, ""))
      .replace(/ \(opens in a new tab\)/g, "")
      .replace(/ ([.,])/g, "$1");
    expect(note).toContain(
      "On real data. The testnet demo vault&#x27;s proof page runs the same checks on its own ledger and chain data. Its record, below",
    );
    if (CLI_ON_NPM) {
      expect(note).toContain(
        "What the commands run on A test fixture. This site serves an exact copy of the file in the repository.",
      );
      expect(text(out)).toContain("curl -O https://probarion.xyz/samples/valid-snapshot.json");
      expect(text(out)).toContain("npx probarion verify --offline valid-snapshot.json");
      expect(text(out)).not.toContain("run it at the root of a clone");
    } else {
      expect(note).toContain(
        "What the command runs on A test fixture. The command reads the file in the repository. Build the CLI from a clone first (README step 1).",
      );
      expect(text(out)).not.toContain("npx probarion");
    }
    expect(SITE_NAV).toContainEqual({ route: "/proof", label: "Proof" });
  });
});

describe("/proof/[vault]/ledger.jsonl", () => {
  const getLedger = (vault: string) =>
    GET_LEDGER(
      new Request(`https://probarion.xyz/proof/${vault}/ledger.jsonl`, {
        headers: { "x-forwarded-for": "203.0.113.7" },
      }),
      params(vault),
    );

  it("answers 404 for an invalid vault id, before any database call", async () => {
    for (const bad of ["..", "Not A Vault", "a", 'x"; filename="evil']) {
      const res = await getLedger(bad);
      expect(res.status, bad).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    expect(h.limitCalls).toEqual([]);
    expect(h.depsCalls).toBe(0);
  });

  it("downloads the vault's ledger, saved as probarion-<vault>-ledger.jsonl: one entry per line, as the CLI reads it", async () => {
    const snapshot = await proofSnapshot("ok");
    serve(snapshot);
    const res = await getLedger(snapshot.vault);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="probarion-${snapshot.vault}-ledger.jsonl"`,
    );
    expect(res.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
    expect(await res.text()).toBe(snapshot.ledger.map((e) => `${JSON.stringify(e)}\n`).join(""));
    expect(h.limitCalls).toEqual(["ledger:203.0.113.7"]);
  });

  it("answers 404 for a hidden vault, 429 when rate-limited, and 503 when the ledger cannot be read", async () => {
    const snapshot = await proofSnapshot("ok");
    serve(snapshot);
    expect((await getLedger("nobody.vaults.probarion.near")).status).toBe(404);

    h.allowed = false;
    const limited = await getLedger(snapshot.vault);
    expect(limited.status).toBe(429);
    h.allowed = true;

    const pub = publicDbFor(snapshot.vault, "mainnet", []);
    serve(snapshot, {
      publicDb: {
        rpc: async <T>(fn: string, p?: Record<string, unknown>) =>
          fn === "public_ledger" ? ([{ seq: 0 }] as T) : pub.rpc<T>(fn, p),
      },
    });
    const down = await getLedger(snapshot.vault);
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: "unavailable" });
    expect(warnedReasons()).toMatchObject([{ msg: "proof.unavailable", reason: "ledger" }]);
  });

  it("is never cached for a member's view of a private vault", async () => {
    const snapshot = await proofSnapshot("ok");
    serve(snapshot, {
      publicDb: { rpc: async <T>() => null as T },
      serviceDb: {
        rpc: async <T>(fn: string) =>
          (fn === "member_role"
            ? {
                tenant_id: "00000000-0000-0000-0000-000000000001",
                vault_id: snapshot.vault,
                network: "mainnet",
                kind: "external",
                role: "owner",
              }
            : fn === "ledger_all"
              ? []
              : null) as T,
      },
      sessionAccount: "owner.near",
    });
    const res = await getLedger(snapshot.vault);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("/proof/[vault]/payments.csv", () => {
  const getPayments = (vault: string) =>
    GET_PAYMENTS(
      new Request(`https://probarion.xyz/proof/${vault}/payments.csv`, {
        headers: { "x-forwarded-for": "203.0.113.7" },
      }),
      params(vault),
    );
  const member = (
    vault: string,
    network: "mainnet" | "testnet" = "mainnet",
  ): Partial<ProofDeps> => ({
    publicDb: { rpc: async <T>() => null as T },
    serviceDb: {
      rpc: async <T>(fn: string) =>
        (fn === "member_role"
          ? {
              tenant_id: "00000000-0000-0000-0000-000000000001",
              vault_id: vault,
              network,
              kind: "external",
              role: "owner",
            }
          : null) as T,
    },
    sessionAccount: "owner.near",
  });

  it("answers 404 for an invalid vault id, before any database or RPC call", async () => {
    for (const bad of ["..", "Not A Vault", "a", 'x"; filename="evil']) {
      const res = await getPayments(bad);
      expect(res.status, bad).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    expect(h.limitCalls).toEqual([]);
    expect(h.depsCalls).toBe(0);
  });

  it("downloads a public vault's payments as CSV, named after the vault and the snapshot's capture time", async () => {
    const snapshot = await proofSnapshot("ok");
    serve(snapshot);
    const res = await getPayments(snapshot.vault);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="${snapshot.vault}-payments-20261108T120000Z.csv"`,
    );
    expect(res.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
    const body = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
    expect(body).toBe(
      paymentsCsv(await decisionRows(snapshot, snapshot.network), snapshot.taken_at),
    );
    const lines = body.split("\r\n");
    expect(lines[0]).toBe(`${String.fromCharCode(0xfeff)}${PAYMENTS_COLUMNS.join(",")}`);
    // The snapshot's taken_at, the time in the file name, is each row's Chain read.
    expect(lines[1]).toContain(",paid,2026-11-08 12:00:00,");
    expect(lines).toHaveLength(3);
    // Its own bucket key, under snapshot.json's limit.
    expect(h.limitCalls).toEqual(["payments:203.0.113.7"]);
  });

  it("is never cached for a member's view of a private vault", async () => {
    const snapshot = await proofSnapshot("ok");
    serve(snapshot, member(snapshot.vault));
    const res = await getPayments(snapshot.vault);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("answers 404 for a vault whose proof page is not public, to anyone who is not a member", async () => {
    const snapshot = await proofSnapshot("ok");
    serve(snapshot, { publicDb: { rpc: async <T>() => null as T } });
    const res = await getPayments(snapshot.vault);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect((await getPayments("nobody.vaults.probarion.near")).status).toBe(404);
  });

  it("answers 404 for a vault registered on the other network", async () => {
    // A testnet vault, asked for at the mainnet address: public there, and a member's alike.
    const snapshot = await proofSnapshot("ok", { network: "testnet" });
    serve(snapshot, { network: "mainnet" });
    const res = await getPayments(snapshot.vault);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    clearProofCache();
    serve(snapshot, { network: "mainnet", ...member(snapshot.vault, "testnet") });
    expect((await getPayments(snapshot.vault)).status).toBe(404);
  });

  it("answers 429 with Retry-After when rate-limited, and reads nothing", async () => {
    const snapshot = await proofSnapshot("ok");
    serve(snapshot);
    h.allowed = false;
    const limited = await getPayments(snapshot.vault);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(h.depsCalls).toBe(0);
  });

  it("answers 503 when the chain cannot be read, or the decision rows cannot be built", async () => {
    const snapshot = await proofSnapshot("ok");
    serve(snapshot, {
      makeReader: () => ({
        snapshot: async () => {
          throw new Error("RPC down");
        },
      }),
    });
    const down = await getPayments(snapshot.vault);
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: "unavailable" });
    expect(warnedReasons()).toMatchObject([{ msg: "proof.unavailable", reason: "chain" }]);

    clearProofCache();
    h.warned = [];
    serve(snapshot);
    h.rowsDown = true;
    const rows = await getPayments(snapshot.vault);
    expect(rows.status).toBe(503);
    expect(await rows.json()).toEqual({ error: "unavailable" });
    expect(warnedReasons()).toMatchObject([{ msg: "proof.decisions_unavailable" }]);
  });
});

describe("a database error before the access check", () => {
  it("shows the page's no-result state, and both downloads answer 503", async () => {
    const snapshot = await proofSnapshot("ok");
    serve(snapshot, {
      publicDb: {
        rpc: async () => {
          throw new DbError("db_error", "connection reset");
        },
      },
    });
    const out = await html(snapshot.vault);
    const t = text(out);
    expect(t).toContain("No result: the checks did not run");
    expect(t).toContain(
      `Probarion&#x27;s database could not be reached right now, so this page cannot say whether ${snapshot.vault} has a proof page. Nothing on this page is a pass. Try again in a minute.`,
    );
    expect(t).not.toContain("signed ledger");
    expect(out).not.toContain(`/proof/${snapshot.vault}/ledger.jsonl`);
    expect(t).not.toContain("--ledger");
    expect(warnedReasons()).toMatchObject([{ msg: "proof.unavailable", reason: "database" }]);
    const snap = await GET(
      new Request(`https://probarion.xyz/proof/${snapshot.vault}/snapshot.json`, {
        headers: { "x-forwarded-for": "203.0.113.7" },
      }),
      params(snapshot.vault),
    );
    expect(snap.status).toBe(503);
    const ledger = await GET_LEDGER(
      new Request(`https://probarion.xyz/proof/${snapshot.vault}/ledger.jsonl`, {
        headers: { "x-forwarded-for": "203.0.113.7" },
      }),
      params(snapshot.vault),
    );
    expect(ledger.status).toBe(503);
    expect(await ledger.json()).toEqual({ error: "unavailable" });
  });
});

describe.each([
  { name: "snapshot.json", route: GET },
  { name: "ledger.jsonl", route: GET_LEDGER },
  { name: "payments.csv", route: GET_PAYMENTS },
])("/proof/[vault]/$name when the database fails", ({ name, route }) => {
  const answer = (vault: string) =>
    route(
      new Request(`https://probarion.xyz/proof/${vault}/${name}`, {
        headers: { "x-forwarded-for": "203.0.113.7" },
      }),
      params(vault),
    );
  const expectUnavailable = async (res: Response) => {
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
    expect(warnedReasons()).toMatchObject([{ msg: "proof.unavailable", reason: "database" }]);
  };

  it("answers 503 when the rate limiter's call fails, and does not go on to the load", async () => {
    const snapshot = await proofSnapshot("ok");
    serve(snapshot);
    h.limitDown = true;
    await expectUnavailable(await answer(snapshot.vault));
    expect(h.depsCalls).toBe(0);
  });

  it("answers 503 when the database client cannot be built", async () => {
    const snapshot = await proofSnapshot("ok");
    serve(snapshot);
    h.serviceDown = true;
    await expectUnavailable(await answer(snapshot.vault));
    expect(h.limitCalls).toEqual([]);
  });

  it("answers 503 when the load's dependencies cannot be built", async () => {
    const snapshot = await proofSnapshot("ok");
    serve(snapshot);
    h.depsDown = true;
    await expectUnavailable(await answer(snapshot.vault));
  });

  it("still answers 404 for an id that is not an account, before any database call", async () => {
    h.serviceDown = true;
    const res = await answer("Not A Vault");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(h.warned).toEqual([]);
  });

  it("still answers 404 for a vault that is not public, on a healthy database", async () => {
    const snapshot = await proofSnapshot("ok");
    serve(snapshot, {
      publicDb: {
        rpc: async <T>() => null as T,
      },
    });
    const res = await answer(snapshot.vault);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("still answers 429 when the limiter refuses", async () => {
    const snapshot = await proofSnapshot("ok");
    serve(snapshot);
    h.allowed = false;
    const res = await answer(snapshot.vault);
    expect(res.status).toBe(429);
    expect(h.depsCalls).toBe(0);
  });
});
