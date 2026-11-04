// The /proof pages and snapshot.json as a visitor meets them: what each state shows, and what an invalid or hidden
// vault answers. The reader is a fake (no RPC, no network); the snapshots are signed fixtures that core checks.
import type { LedgerEntry, Snapshot } from "@probarion/core";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/port";
import { ProofEvidenceError } from "@/lib/proof/evidence";
import { clearProofCache, type ProofDeps } from "@/lib/proof/service";
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
  /** Structured warn lines (proof.unavailable), kept off the test output. */
  warned: [] as string[],
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7" }),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("@/lib/db/clients", () => ({
  publicDb: (): Db => ({
    rpc: async <T>(fn: string, p: Record<string, unknown> = {}) => {
      h.publicCalls.push(fn);
      if (fn !== "public_vault") throw new Error(`unexpected ${fn}`);
      const v = h.publicVault;
      return (
        v !== null && p.vault_id === v.vault_id
          ? { ...v, kind: "team", display_name: "demo" }
          : null
      ) as T;
    },
  }),
  serviceDb: (): Db => ({
    rpc: async <T>(fn: string, p: Record<string, unknown> = {}) => {
      if (fn !== "rate_limit_take") throw new Error(`unexpected ${fn}`);
      h.limitCalls.push(String(p.bucket));
      return {
        allowed: h.allowed,
        remaining: 0,
        reset_at: new Date(Date.now() + 30_000).toISOString(),
      } as T;
    },
  }),
}));
vi.mock("@/lib/proof/deps", () => ({
  proofDeps: async () => {
    h.depsCalls++;
    return h.deps;
  },
}));
vi.mock("@/lib/env", () => ({ getEnv: () => h.env }));

import Home from "@/app/page";
import ProofPage, { generateMetadata } from "@/app/proof/[vault]/page";
import { GET } from "@/app/proof/[vault]/snapshot.json/route";
import ProofIndex from "@/app/proof/page";
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
  h.warned = [];
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
      "No decision in this snapshot carries an attestation, so check (e) has no model output to prove here. For an attested decision it proves the signatures, the response and the ledger position agree; it does not verify the TDX quote (needs --online , and even then the measurement is not pinned) or the request (needs the invoice, A8).",
    );
  });

  it("phrases the check (e) line per attested decision when there are some", async () => {
    const snapshot = await proofSnapshot("ok");
    const entry = snapshot.ledger[0] as LedgerEntry;
    entry.body = { ...entry.body, decided_by: "model+rules", evidence: { quote: "q" } as never };
    serve(snapshot);
    const t = text(await html(snapshot.vault));
    expect(t).toContain(
      "For each attested decision (1 in this snapshot), check (e) here proves the signatures, the response and the ledger position agree; it does not verify the TDX quote (needs --online , and even then the measurement is not pinned) or the request (needs the invoice, A8).",
    );
    expect(t).not.toContain("No decision in this snapshot carries an attestation");
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
    expect(t).toContain("Save the snapshot&#x27;s ledger as JSONL (step 3 below), then run:");
    expect(t).toContain(
      `npx probarion verify --network mainnet --vault ${snapshot.vault} --ledger ledger.jsonl --burn-tx 1=&lt;tx hash&gt;`,
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

  it("links the explorer of the vault's network, the download and the offline command", async () => {
    const { snapshot, out } = await served("ok", "testnet");
    expect(snapshot.vault).toBe("acme.vaults.probarion.testnet");
    expect(out).toContain(`href="https://testnet.nearblocks.io/address/${snapshot.vault}"`);
    expect(out).not.toContain("https://nearblocks.io/");
    expect(out).toContain(`href="/proof/${snapshot.vault}/snapshot.json"`);
    const t = text(out);
    expect(t).toContain(`npx probarion verify --offline probarion-${snapshot.vault}-snapshot.json`);
    expect(t).toContain(
      `npx probarion verify --network testnet --vault ${snapshot.vault} --ledger ledger.jsonl`,
    );
  });

  it("says the download is a fresh snapshot, to compare by its time, that matches unless the vault changed", async () => {
    const { snapshot, out } = await served("ok");
    const t = text(out);
    expect(t).toContain(
      "a fresh snapshot of this vault (its ledger and chain data). Within a minute of this page it is the snapshot these checks used; the verifier prints when it was taken, so compare it with 2026-11-08 12:00 UTC.",
    );
    expect(t).toContain(
      "Run it through the open-source verifier. It needs no network and no keys, and prints the result per check for that snapshot; it matches this page unless the vault changed in between:",
    );
    expect(t).toContain(`npx probarion verify --offline probarion-${snapshot.vault}-snapshot.json`);
    expect(t).not.toContain("the chain data these checks used, taken");
    expect(t).not.toContain("prints the same result per check as this page");
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
    expect(out.match(/<span class="sr-only"> \(opens in a new tab\)<\/span>/g)?.length).toBe(
      newTab,
    );
  });

  it("links /security the way a planned page is linked: as 'coming soon' text", async () => {
    const { out } = await served("ok");
    expect(out).not.toContain('href="/security"');
    expect(text(out)).toContain("Security (coming soon)");
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
  });

  it("names the vault in the title only when it is a valid account id", async () => {
    expect((await generateMetadata(params("acme.vaults.probarion.near"))).title).toBe(
      "Proof · acme.vaults.probarion.near",
    );
    expect((await generateMetadata(params("<script>"))).title).toBe("Proof");
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
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
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
      expect(out, String(demo)).toContain(
        "Open /proof/&lt;vault account&gt; to see a vault&#x27;s checks.",
      );
    }
    // A missing id, and one that is not an account, are never looked up.
    expect(h.publicCalls).toEqual(["public_vault", "public_vault"]);
  });
});

describe("the landing page and the menu", () => {
  it("link the proof page, and no longer call it coming", () => {
    const out = renderToStaticMarkup(createElement(Home));
    expect(out).toContain(`href="/proof"`);
    expect(text(out)).not.toMatch(/are coming/);
    expect(text(out)).toContain("npx probarion verify --offline");
    expect(SITE_NAV).toContainEqual({ route: "/proof", label: "Proof" });
  });
});
