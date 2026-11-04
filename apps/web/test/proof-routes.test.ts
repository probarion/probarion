// The /proof pages and snapshot.json as a visitor meets them: what each state shows, and what an invalid or hidden
// vault answers. The reader is a fake (no RPC, no network); the snapshots are signed fixtures that core checks.
import type { LedgerEntry, Snapshot } from "@probarion/core";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7" }),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("@/lib/db/clients", () => ({
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

import ProofPage, { generateMetadata } from "@/app/proof/[vault]/page";
import { GET } from "@/app/proof/[vault]/snapshot.json/route";

/** True when the text still holds a right-to-left override, a line separator or a BEL. */
const hasUnsafe = (text: string): boolean =>
  [...text].some((c) => [0x202e, 0x2028, 0x07].includes(c.codePointAt(0) ?? -1));

import ProofIndex from "@/app/proof/page";

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

beforeEach(() => {
  clearProofCache();
  h.depsCalls = 0;
  h.limitCalls = [];
  h.allowed = true;
  h.env = { NEAR_NETWORK: "mainnet", PROBARION_VAULT_ID: null };
});

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
    // Nine checks, each with its status.
    expect(out.match(/data-check="[a-i]"/g)).toHaveLength(9);
    expect(out.match(/data-status="pass"/g)).toHaveLength(9);
  });

  it("titles the table with what it really is, and adds the fixed line about check e (R19)", async () => {
    const t = text((await served("ok")).out);
    expect(t).toContain("These are the checks probarion verify --offline runs on this snapshot.");
    expect(t).not.toMatch(/the same ones/);
    expect(t).toContain(
      "Check (e) here proves the signatures, the response and the ledger position agree; it does not verify the TDX quote (needs --online , and even then the measurement is not pinned) or the request (needs the invoice, A8).",
    );
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
      `npx probarion verify --network mainnet --vault ${snapshot.vault} --burn-tx 1=&lt;tx hash&gt;`,
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
    expect(t).toContain(`npx probarion verify --network testnet --vault ${snapshot.vault}`);
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
        throw new ProofEvidenceError("content/proof-evidence.json: the file is not a JSON object");
      },
    });
    const out = await html("acme.vaults.probarion.near");
    const t = text(out);
    expect(out).toMatch(/data-headline="error"/);
    expect(t).toContain("No result: the checks did not run");
    expect(t).toContain("evidence file");
    expect(t).not.toMatch(/All offline checks pass|data-status="pass"/);
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
    expect(t).toContain("could not be read");
    expect(t).not.toContain("RPC down");
    expect(t).not.toContain("All offline checks pass");
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

  it("downloads the snapshot the page checked, named after the vault, cached only when public", async () => {
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
  });
});

describe("/proof", () => {
  it("sends a visitor to the demo vault", async () => {
    h.env.PROBARION_VAULT_ID = "v0.probarion.testnet";
    expect(await digest(() => ProofIndex())).toMatch(
      /^NEXT_REDIRECT;[a-z]+;\/proof\/v0\.probarion\.testnet;/,
    );
  });

  it("explains how to open a vault when there is no valid demo vault", async () => {
    for (const demo of [null, "../etc"]) {
      h.env.PROBARION_VAULT_ID = demo;
      const out = text(renderToStaticMarkup(ProofIndex() as ReactElement));
      expect(out).toContain("Open /proof/&lt;vault account&gt; to see a vault&#x27;s checks.");
    }
  });
});
