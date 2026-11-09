import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VAULT_ERROR_CODES } from "@probarion/core";
import type MiniSearch from "minisearch";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { docsHref, findPage, PAGES } from "@/lib/docs/registry";
import {
  activeIndex,
  createSearch,
  groupHits,
  highlight,
  isSearchShortcut,
  landingTarget,
  loadIndex,
  moveActive,
  optionId,
  parseIndex,
  RESULT_LIMIT,
  resultsMessage,
  runSearch,
  type SearchDoc,
} from "@/lib/docs/search";
import { BODY_LIMIT, buildSearchIndex, codesIn, kindOf } from "@/lib/docs/search-index";
import type { DocPage } from "@/lib/docs/types";
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
    codes: "NoMandate\nPROBARION:NoMandate",
    body: "Every vault error code, with what to do next. NoMandate",
    summary: "Every error code.",
  }),
  doc({
    id: "error:NoMandate",
    href: "/docs/build/errors#NoMandate",
    title: "PROBARION:NoMandate",
    kind: "error",
    section: "Errors",
    codes: "NoMandate\nPROBARION:NoMandate",
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
    expect(ids("probarion:nomandate")[0]).toBe("error:NoMandate");
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

  it("keeps a CLI command whole: one of its words is not the command", () => {
    const pages = [
      doc({
        id: "concepts/holds-and-approvals",
        title: "Holds and approvals",
        codes: "spend approve\nspend reject",
        body: "An approver runs spend approve.",
      }),
      doc({ id: "build/spend-outcomes", title: "Spend outcomes", body: "What a spend returns." }),
    ];
    const search = createSearch(pages);
    expect(runSearch(search, "spend")[0]?.id).toBe("build/spend-outcomes");
    expect(runSearch(search, "spend  Approve")[0]?.id).toBe("concepts/holds-and-approvals");
  });

  it("puts the error entry of a pasted PROBARION:<Code> first, as the filter allows", () => {
    const search = createSearch([
      ...DOCS,
      doc({
        id: "error:OverPerPayment",
        href: "/docs/build/errors#OverPerPayment",
        title: "PROBARION:OverPerPayment",
        kind: "error",
        section: "Errors",
        codes: "OverPerPayment\nPROBARION:OverPerPayment",
        body: "The amount is above the mandate's limit per payment.",
      }),
      doc({ id: "concepts/refusals", title: "Refusals", body: "A smart contract panicked." }),
    ]);
    const order = (q: string, filter?: Parameters<typeof runSearch>[2]) =>
      runSearch(search, q, filter).map((h) => h.id);
    expect(order("Smart contract panicked: PROBARION:NoMandate")[0]).toBe("error:NoMandate");
    expect(order("REFUSED: PROBARION:OverPerPayment")[0]).toBe("error:OverPerPayment");
    // The entry comes from the index, so it shows even when no other word of the line matched it.
    const hit = runSearch(search, "REFUSED: PROBARION:OverPerPayment")[0];
    expect(hit?.href).toBe("/docs/build/errors#OverPerPayment");
    expect(hit?.title).toBe("PROBARION:OverPerPayment");
    expect(order("Smart contract panicked: PROBARION:NoMandate", "error")[0]).toBe(
      "error:NoMandate",
    );
    expect(order("Smart contract panicked: PROBARION:NoMandate", "concept")).not.toContain(
      "error:NoMandate",
    );
    // A code the index does not hold promotes nothing.
    expect(order("Smart contract panicked: PROBARION:NoSuchCode")[0]).toBe("concepts/refusals");
  });

  it("does not let the PROBARION: prefix of every code score the word probarion", () => {
    const search = createSearch([
      ...DOCS,
      doc({
        id: "start/what-is-probarion",
        title: "What is Probarion",
        kind: "guide",
        section: "Start here",
        body: "Probarion is a mandate layer for AI agents.",
      }),
    ]);
    expect(runSearch(search, "probarion")[0]?.id).toBe("start/what-is-probarion");
    expect(runSearch(search, "probarion").map((h) => h.id)).not.toContain("error:NoMandate");
    // The stored title keeps the prefix: only the index drops it.
    expect(runSearch(search, "NoMandate")[0]?.title).toBe("PROBARION:NoMandate");
  });

  it("gives a bare PROBARION: no exact rank, so a page with no codes is not promoted", () => {
    const search = createSearch([
      doc({
        id: "build/errors",
        title: "Probarion errors",
        kind: "reference",
        codes: "PROBARION:NoMandate",
      }),
      doc({ id: "start/what-is-probarion", title: "What it is", body: "Probarion is a layer." }),
    ]);
    const order = (q: string) => runSearch(search, q).map((h) => h.id);
    expect(order("PROBARION:")).toEqual(order("probarion"));
    expect(order("PROBARION:")[0]).toBe("build/errors");
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

  it("keeps the active option on the list, even after a move with no results", () => {
    expect(activeIndex(-1, 3)).toBe(0);
    expect(activeIndex(5, 3)).toBe(2);
    expect(activeIndex(1, 3)).toBe(1);
    expect(activeIndex(0, 0)).toBe(-1);
  });

  it("finds where an opened result lands, once its page shows: the hash's element, else the h1", () => {
    const at = (path: string) => ({ pathname: path, href: `https://probarion.xyz${path}` });
    const errors = at("/docs/build/errors");
    expect(landingTarget(errors, "/docs/build/errors#NoMandate")).toEqual({ id: "NoMandate" });
    expect(landingTarget(errors, "/docs/build/errors")).toEqual({ id: null });
    expect(landingTarget(errors, "/docs/build/errors#a%20b")).toEqual({ id: "a b" });
    expect(landingTarget(errors, "/docs/build/errors#%E0%A4%A")).toEqual({ id: "%E0%A4%A" });
    // The old page still shows: wait.
    expect(landingTarget(at("/docs/start/what-is-probarion"), "/docs/build/errors#x")).toBeNull();
  });

  it("gives each option an id from its entry, valid in HTML", () => {
    expect(optionId("_r_1_", "error:NoMandate")).toBe("_r_1_-opt-error%3ANoMandate");
    expect(optionId("_r_1_", "build/errors")).toBe("_r_1_-opt-build%2Ferrors");
    expect(optionId("b", "a b")).not.toMatch(/\s/);
  });

  it("phrases the result count, naming the query, and says Top when the list stops at the limit", () => {
    expect(resultsMessage(0, "zzzqqq")).toBe('No results for "zzzqqq".');
    expect(resultsMessage(1, "vault")).toBe('1 result for "vault"');
    expect(resultsMessage(19, "vault")).toBe('19 results for "vault"');
    expect(resultsMessage(20, "vault")).toBe('20 results for "vault"');
    expect(resultsMessage(RESULT_LIMIT, "vault", true)).toBe('Top 20 results for "vault"');
  });

  it("lists up to RESULT_LIMIT results, and one more when asked, so the dialog can tell", () => {
    const many = Array.from({ length: RESULT_LIMIT + 5 }, (_, i) =>
      doc({ id: `concepts/vault-${i}`, title: `Vault ${i}`, body: "vault" }),
    );
    const search = createSearch(many);
    expect(runSearch(search, "vault")).toHaveLength(RESULT_LIMIT);
    expect(runSearch(search, "vault", "all", RESULT_LIMIT + 1)).toHaveLength(RESULT_LIMIT + 1);
  });

  it("opens on Ctrl K or ⌘K alone, on any keyboard layout", () => {
    const key = (over: Partial<Parameters<typeof isSearchShortcut>[0]>) =>
      isSearchShortcut({
        key: "k",
        code: "KeyK",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        ...over,
      });
    expect(key({ ctrlKey: true })).toBe(true);
    expect(key({ metaKey: true })).toBe(true);
    expect(key({ ctrlKey: true, key: "K" })).toBe(true);
    expect(key({ ctrlKey: true, key: "л" })).toBe(true);
    expect(key({ ctrlKey: true, key: "k", code: "KeyV" })).toBe(true);
    expect(key({})).toBe(false);
    expect(key({ ctrlKey: true, metaKey: true })).toBe(false);
    expect(key({ ctrlKey: true, shiftKey: true })).toBe(false);
    expect(key({ ctrlKey: true, altKey: true })).toBe(false);
    expect(key({ ctrlKey: true, key: "j", code: "KeyJ" })).toBe(false);
    expect(key({ ctrlKey: true, key: undefined, code: "" })).toBe(false);
    // Colemak and Workman put e on the physical K key: Ctrl E stays the browser's.
    expect(key({ ctrlKey: true, key: "e", code: "KeyK" })).toBe(false);
    expect(key({ metaKey: true, key: "E", code: "KeyK" })).toBe(false);
  });
});

describe("the dialog's styles", () => {
  // Without comments: a comment may name what no rule does.
  const css = readFileSync(
    join(WEB, "src", "components", "docs", "docs.module.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const forced = /@media \(forced-colors: active\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  const rule = (block: string, selector: string) =>
    new RegExp(
      `(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`,
    ).exec(block)?.[1];

  it("marks only the selected option and an unfocused pressed filter in forced colours", () => {
    // Forced colours paint a transparent outline, so a base outline would ring every option.
    expect(rule(css, ".searchOption")).toBeDefined();
    expect(rule(css, ".searchOption")).not.toMatch(/outline/);
    expect(rule(forced, '.searchOption[aria-selected="true"]')).toMatch(
      /outline: 2px solid Highlight/,
    );
    // The focus ring keeps its own colour on the pressed filter a keyboard reaches first.
    expect(rule(forced, '.searchButton[aria-pressed="true"]')).toBeUndefined();
    expect(rule(forced, '.searchButton[aria-pressed="true"]:not(:focus-visible)')).toMatch(
      /outline: 2px solid Highlight/,
    );
  });
});

describe("loadIndex", () => {
  const ok = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });
  let logged: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logged = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logged.mockRestore();
  });

  it("returns the docs, or null when the index does not load, and logs why", async () => {
    expect(await loadIndex(ok(DOCS))).toEqual(DOCS);
    expect(logged).not.toHaveBeenCalled();
    expect(await loadIndex(async () => new Response("down", { status: 500 }))).toBeNull();
    expect(await loadIndex(async () => new Response("{not json", { status: 200 }))).toBeNull();
    expect(await loadIndex(ok([{ id: 1 }]))).toBeNull();
    expect(await loadIndex(ok([DOCS[0], DOCS[0]]))).toBeNull();
    expect(
      await loadIndex(async () => {
        throw new TypeError("offline");
      }),
    ).toBeNull();
    expect(logged).toHaveBeenCalledTimes(5);
    for (const call of logged.mock.calls) {
      expect(call[0]).toBe("Docs search: the index did not load.");
    }
    expect(String(logged.mock.calls[0]?.[1])).toMatch(/500/);
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

  it("refuses an entry with a missing field, an unknown kind or a repeated id", () => {
    expect(() => parseIndex({})).toThrow(/not a list/);
    expect(() => parseIndex([{ ...DOCS[0], body: 1 }])).toThrow(/entry 0 has no body/);
    expect(() => parseIndex([{ ...DOCS[0], kind: "faq" }])).toThrow(/entry 0 has kind "faq"/);
    expect(() => parseIndex([DOCS[0], DOCS[1], DOCS[0]])).toThrow(
      /entry 2 repeats id concepts\/mandates/,
    );
  });
});

describe("the search index", () => {
  const pageAt = (path: string): DocPage => {
    const page = findPage(path);
    if (!page) throw new Error(`no page ${path}`);
    return page;
  };

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

  it("files each page type under a search kind, and leaves the docs home out", () => {
    expect(kindOf(pageAt("start/evaluate-in-5-minutes"))).toBe("guide");
    expect(kindOf(pageAt("build/install"))).toBe("guide");
    expect(kindOf(pageAt("concepts/mandates"))).toBe("concept");
    expect(kindOf(pageAt("build/errors"))).toBe("reference");
    expect(kindOf(pageAt(""))).toBeNull();
  });

  describe("built from the real pages", () => {
    let index: SearchDoc[] = [];
    let ms: MiniSearch<SearchDoc>;
    const first = (q: string) => runSearch(ms, q)[0];

    // One build for every test below: it converts all the pages to Markdown.
    beforeAll(async () => {
      index = await buildSearchIndex(ORIGIN);
      ms = createSearch(index);
    }, 60_000);

    it("has one entry per page but the hub, then one per vault error code, and survives JSON", () => {
      const listed = PAGES.filter((p) => p.type !== "hub");
      const pages = index.filter((d) => d.kind !== "error");
      expect(pages.map((d) => d.href)).toEqual(listed.map((p) => docsHref(p.path)));
      expect(pages.map((d) => d.kind)).toEqual(listed.map(kindOf));
      expect(new Set(index.map((d) => d.id)).size).toBe(index.length);
      // No page comes near the limit, so none is clipped: a clipped body sits just under
      // BODY_LIMIT, far above half of it.
      for (const d of index) expect(d.body.length, d.id).toBeLessThan(BODY_LIMIT / 2);
      expect(parseIndex(JSON.parse(JSON.stringify(index)))).toEqual(index);
      if (findPage("build/errors")) {
        expect(index.filter((d) => d.kind === "error").map((d) => d.href)).toEqual(
          VAULT_ERROR_CODES.map((c) => `/docs/build/errors#${c}`),
        );
      }
    });

    it("puts a vault code's own entry first, with or without its prefix, in any case", () => {
      expect(first("NoMandate")?.id).toBe("error:NoMandate");
      expect(first("PROBARION:NoMandate")?.id).toBe("error:NoMandate");
      expect(first("probarion:nomandate")?.id).toBe("error:NoMandate");
      expect(first("NoMandate")?.href).toBe("/docs/build/errors#NoMandate");
    });

    it("ranks What is Probarion in the top 3 for the word probarion, not a wall of codes", () => {
      const top = runSearch(ms, "probarion")
        .slice(0, 3)
        .map((h) => h.id);
      expect(top).toContain("start/what-is-probarion");
    });

    it("puts the error entry first for a pasted refusal line", () => {
      expect(first("Smart contract panicked: PROBARION:NoMandate")?.id).toBe("error:NoMandate");
      expect(first("REFUSED: PROBARION:OverPerPayment")?.id).toBe("error:OverPerPayment");
    });

    it("ranks one word of a CLI command by its pages, and the whole command by its own", () => {
      expect(["build/spend-outcomes", "concepts/why-spend-has-no-payee"]).toContain(
        first("spend")?.id,
      );
      expect(["concepts/vaults-roles-and-keys", "trust/verify-a-vault"]).toContain(
        first("vault")?.id,
      );
      expect(first("spend approve")?.codes.split("\n")).toContain("spend approve");
    });

    it("puts the CLI reference first for a whole command, whichever guide runs it", () => {
      for (const q of ["spend approve", "ledger export", "agent keygen", "vault create"]) {
        expect(first(q)?.id, q).toBe("build/cli-reference");
      }
    });

    it("searches the whole page, generated tables included", () => {
      expect(first("TxOutcomeUnknown")?.id).toBe("build/errors");
      expect(first("rate_limited")?.id).toBe("build/errors");
      // Both words sit well past the first 6000 characters of their page.
      const found = (q: string) => runSearch(ms, q).map((h) => h.id);
      expect(found("rustup")).toContain("start/evaluate-in-5-minutes");
      expect(found("invoiceHash")).toContain("build/install");
      const body = (id: string) => index.find((d) => d.id === id)?.body ?? "";
      expect(body("start/evaluate-in-5-minutes").indexOf("rustup")).toBeGreaterThan(6000);
      expect(body("build/install").indexOf("invoiceHash")).toBeGreaterThan(6000);
    });

    it("lists only identifier-shaped catalog codes: a plain word does not pin build/errors", () => {
      const errors = index.find((d) => d.id === "build/errors")?.codes.split("\n") ?? [];
      expect(errors).toEqual(expect.arrayContaining(["rate_limited", "not_found"]));
      expect(errors).toEqual(expect.arrayContaining(["TxOutcomeUnknown"]));
      expect(errors).not.toContain("failed");
      expect(errors).not.toContain("duplicate");
      expect(first("failed")?.id).not.toBe("build/errors");
      expect(first("duplicate")?.id).not.toBe("build/errors");
    });
  });

  it("is mounted once, in the docs layout, with the Glossary link worked out on the server", () => {
    const layout = readFileSync(join(WEB, "src", "app", "docs", "layout.tsx"), "utf8");
    expect(layout).toContain("<SearchDialog glossaryHref=");
    const dialog = readFileSync(join(WEB, "src", "components", "docs", "SearchDialog.tsx"), "utf8");
    expect(dialog.startsWith('"use client";')).toBe(true);
    expect(dialog).not.toMatch(/@\/lib\/docs\/(registry|search-index|source|twins)/);
  });
});
