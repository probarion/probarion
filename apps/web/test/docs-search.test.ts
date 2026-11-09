import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VAULT_ERROR_CODES } from "@probarion/core";
import { describe, expect, it, vi } from "vitest";
import { docsHref, findPage, PAGES } from "@/lib/docs/registry";
import {
  createSearch,
  groupHits,
  highlight,
  loadIndex,
  moveActive,
  parseIndex,
  runSearch,
  type SearchDoc,
} from "@/lib/docs/search";
import { buildSearchIndex, codesIn, kindOf } from "@/lib/docs/search-index";
import { WEB } from "./docs-helpers";

const ORIGIN = "https://probarion.xyz";

const doc = (over: Partial<SearchDoc> & Pick<SearchDoc, "id" | "title">): SearchDoc => ({
  href: `/docs/${over.id}`,
  section: "Concepts",
  kind: "concept",
  headings: "",
  codes: "",
  body: "",
  summary: "",
  ...over,
});

const DOCS: SearchDoc[] = [
  doc({
    id: "concepts/mandates",
    title: "Mandates",
    headings: "Mandate fields\nWho gets paid",
    codes: "NoMandate",
    body: "A mandate names the payee, the cap and the window. NoMandate means the id is unknown.",
    summary: "What a mandate allows.",
  }),
  doc({
    id: "build/errors",
    title: "Errors",
    kind: "reference",
    section: "Build",
    codes: "NoMandate PROBARION:NoMandate",
    body: "Every vault error code, with what to do next. NoMandate",
    summary: "Every error code.",
  }),
  doc({
    id: "error:NoMandate",
    href: "/docs/build/errors#NoMandate",
    title: "PROBARION:NoMandate",
    kind: "error",
    section: "Errors",
    codes: "NoMandate PROBARION:NoMandate",
    body: "The vault has no mandate with this id.",
    summary: "The vault has no mandate with this id.",
  }),
  doc({
    id: "trust/verify-a-vault",
    title: "Verify a vault yourself",
    kind: "guide",
    section: "Verify and trust",
    codes: "verify",
    body: "Run verify with the offline flag on a snapshot.",
    summary: "Check a vault from its snapshot.",
  }),
];

describe("runSearch", () => {
  const ms = createSearch(DOCS);
  const ids = (q: string, filter?: Parameters<typeof runSearch>[2]) =>
    runSearch(ms, q, filter).map((h) => h.id);

  it("puts an error code's own entry first when the query is that code", () => {
    expect(ids("NoMandate")[0]).toBe("error:NoMandate");
    expect(ids("PROBARION:NoMandate")[0]).toBe("error:NoMandate");
    expect(ids("nomandate")[0]).toBe("error:NoMandate");
  });

  it("matches prefixes and needs every word, falling back to any word", () => {
    expect(ids("mandat")).toContain("concepts/mandates");
    expect(ids("mandate fields")).toEqual(["concepts/mandates"]);
    expect(ids("mandate qqqzzz").length).toBeGreaterThan(0);
  });

  it("filters by kind and returns nothing for a blank query", () => {
    expect(ids("NoMandate", "error")).toEqual(["error:NoMandate"]);
    expect(ids("   ")).toEqual([]);
  });
});

describe("the dialog's pure logic", () => {
  it("groups hits by section, in the order their best hit ranks", () => {
    const hits = runSearch(createSearch(DOCS), "NoMandate");
    const groups = groupHits(hits);
    expect(groups[0]?.section).toBe("Errors");
    expect(new Set(groups.map((g) => g.section)).size).toBe(groups.length);
    expect(groups.flatMap((g) => g.hits)).toHaveLength(hits.length);
  });

  it("marks the matched terms, whatever their case", () => {
    expect(highlight("Mandate fields", ["mandate"])).toEqual([
      { text: "Mandate", mark: true, at: 0 },
      { text: " fields", mark: false, at: 7 },
    ]);
    expect(highlight("Errors", [])).toEqual([{ text: "Errors", mark: false, at: 0 }]);
    expect(highlight("a (b)", ["(b)"])).toEqual([
      { text: "a ", mark: false, at: 0 },
      { text: "(b)", mark: true, at: 2 },
    ]);
  });

  it("moves the active option round the list", () => {
    expect(moveActive(0, -1, 3)).toBe(2);
    expect(moveActive(2, 1, 3)).toBe(0);
    expect(moveActive(0, 1, 0)).toBe(-1);
  });
});

describe("loadIndex", () => {
  const ok = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });

  it("returns the docs, or null when the index does not load", async () => {
    expect(await loadIndex(ok(DOCS))).toEqual(DOCS);
    expect(await loadIndex(async () => new Response("down", { status: 500 }))).toBeNull();
    expect(await loadIndex(async () => new Response("{not json", { status: 200 }))).toBeNull();
    expect(await loadIndex(ok([{ id: 1 }]))).toBeNull();
    expect(
      await loadIndex(async () => {
        throw new TypeError("offline");
      }),
    ).toBeNull();
  });

  it("gives the default request a 10 s limit, and an aborted request gives null", async () => {
    const aborted = async (): Promise<Response> => {
      throw new DOMException("This operation was aborted", "AbortError");
    };
    expect(await loadIndex(aborted)).toBeNull();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    // The default fetcher, on a stubbed fetch: no network. A timed-out signal rejects like this.
    const inits: (RequestInit | undefined)[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit): Promise<Response> => {
      inits.push(init);
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    try {
      expect(await loadIndex()).toBeNull();
      expect(timeout).toHaveBeenCalledWith(10_000);
      expect(inits[0]?.signal).toBe(timeout.mock.results[0]?.value);
    } finally {
      vi.unstubAllGlobals();
      timeout.mockRestore();
    }
  });

  it("refuses an entry with a missing field or an unknown kind", () => {
    expect(() => parseIndex({})).toThrow(/not a list/);
    expect(() => parseIndex([{ ...DOCS[0], body: 1 }])).toThrow(/entry 0 has no body/);
    expect(() => parseIndex([{ ...DOCS[0], kind: "faq" }])).toThrow(/entry 0 has kind "faq"/);
  });
});

describe("the search index", () => {
  it("finds codes and CLI commands in a page", () => {
    const md =
      "Run `node packages/cli/dist/bin.js mandate create --cap 5`, then `node packages/cli/dist/bin.js verify --offline x.json`, and `node packages/cli/dist/bin.js --network testnet vault create`. It fails with PROBARION:NoMandate.";
    expect(codesIn(md)).toEqual([
      "NoMandate",
      "PROBARION:NoMandate",
      "mandate create",
      "vault create",
      "verify",
    ]);
  });

  it("has one entry per page, then one per vault error code, and survives JSON", async () => {
    const index = await buildSearchIndex(ORIGIN);
    const pages = index.filter((d) => d.kind !== "error");
    expect(pages.map((d) => d.href)).toEqual(PAGES.map((p) => docsHref(p.path)));
    expect(pages.map((d) => d.kind)).toEqual(PAGES.map(kindOf));
    expect(new Set(index.map((d) => d.id)).size).toBe(index.length);
    for (const d of index) expect(d.body.length, d.id).toBeLessThanOrEqual(6000);
    expect(parseIndex(JSON.parse(JSON.stringify(index)))).toEqual(index);
    if (findPage("build/errors")) {
      expect(index.filter((d) => d.kind === "error").map((d) => d.href)).toEqual(
        VAULT_ERROR_CODES.map((c) => `/docs/build/errors#${c}`),
      );
      expect(runSearch(createSearch(index), "NoMandate")[0]?.href).toBe(
        "/docs/build/errors#NoMandate",
      );
    }
  });

  it("is mounted once, in the docs layout, with the Glossary link worked out on the server", () => {
    const layout = readFileSync(join(WEB, "src", "app", "docs", "layout.tsx"), "utf8");
    expect(layout).toContain("<SearchDialog glossaryHref=");
    const dialog = readFileSync(join(WEB, "src", "components", "docs", "SearchDialog.tsx"), "utf8");
    expect(dialog.startsWith('"use client";')).toBe(true);
    expect(dialog).not.toMatch(/@\/lib\/docs\/(registry|search-index|source|twins)/);
  });
});
