import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { walk } from "../../test/deploy-scan";
import { elements, textOf } from "../../test/fixtures/mini-react";

// The loading shells (loading.tsx) and the console's error page, as markup. A shell shows the moment a page is opened
// and stays until its server reads are done, so it has to look like the page it stands for (the same head, in the same
// classes, so nothing moves when the page lands) and say what is loading without claiming anything about it.

const nav = vi.hoisted(() => ({
  path: "/" as string | null,
  params: {} as Record<string, string | string[] | undefined>,
}));
vi.mock("next/navigation", () => ({ usePathname: () => nav.path, useParams: () => nav.params }));

/** The console error page's transition, held by the test: whether it runs, and how often it was started. */
const transition = vi.hoisted(() => ({ pending: false, started: 0 }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useTransition: () => [
    transition.pending,
    (run: () => void) => {
      transition.started += 1;
      run();
    },
  ],
}));

import { segmentText } from "@/components/pending/segment";
import c from "@/components/site/canary.module.css";
import s from "@/components/site/site.module.css";
import { CANARY_COPY, RULES_HEAD } from "@/lib/canary/copy";
import CanaryLoading from "./canary/loading";
import VaultLoading from "./console/[vault]/loading";
import ConsoleError from "./console/error";
import ProofLoading from "./proof/loading";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const source = (path: string) => readFileSync(join(SRC, path), "utf8");
const posix = (f: string) => relative(SRC, f).replaceAll("\\", "/");

const VAULT = "acme.vaults.probarion.testnet";
const html = (component: () => unknown) =>
  renderToStaticMarkup(createElement(component as () => null));
/** The markup's text, tags dropped and entities read back. */
const visible = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, "")
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&");
/** The class list of the first `<tag>` in the markup. */
const classOf = (markup: string, tag: string) =>
  new RegExp(`<${tag}\\b[^>]*class="([^"]*)"`).exec(markup)?.[1] ?? null;
/** What an `<a>` with aria-current says, per link. */
const current = (markup: string) =>
  [...markup.matchAll(/<a\b([^>]*)>(.*?)<\/a>/g)]
    .filter((m) => /\saria-current="page"/.test(m[1] ?? ""))
    .map((m) => visible(m[2] ?? ""));
/** Words and characters the site's copy keeps out (no dashes, no absolute promises). */
const BANNED = /[\u2013\u2014]|\b(?:first|only|never|unhackable|unbreakable|guaranteed)\b/i;

beforeEach(() => {
  nav.path = "/";
  nav.params = {};
  transition.pending = false;
  transition.started = 0;
});

describe("segmentText", () => {
  it("decodes the segment, keeps one that is not valid percent-encoding, and has nothing for none", () => {
    expect(segmentText(VAULT)).toBe(VAULT);
    expect(segmentText("a%2Db.testnet")).toBe("a-b.testnet");
    expect(segmentText("100%.testnet")).toBe("100%.testnet");
    expect(segmentText(["x.testnet", "y"])).toBe("x.testnet");
    expect(segmentText(undefined)).toBeNull();
    expect(segmentText("")).toBeNull();
    expect(segmentText([])).toBeNull();
  });
});

/** Each shell, rendered at an address under it. */
const SHELLS = [
  {
    name: "vault",
    render: () => {
      nav.path = `/console/${VAULT}/keys`;
      nav.params = { vault: VAULT };
      return html(VaultLoading);
    },
    line: "Loading the vault from NEAR…",
  },
  {
    name: "spend approval",
    render: () => {
      nav.path = `/console/${VAULT}/approve/12`;
      nav.params = { vault: VAULT, spend: "12" };
      return html(VaultLoading);
    },
    line: "Loading the spend from NEAR…",
  },
  {
    name: "proof",
    render: () => {
      nav.path = `/proof/${VAULT}`;
      nav.params = { vault: VAULT };
      return html(ProofLoading);
    },
    line: "Loading the proof from NEAR…",
  },
  {
    name: "proof index",
    render: () => {
      nav.path = "/proof";
      return html(ProofLoading);
    },
    line: "Loading the proof from NEAR…",
  },
  {
    name: "canary",
    render: () => {
      nav.path = "/canary";
      return html(CanaryLoading);
    },
    line: "Loading the Canary…",
  },
  {
    name: "canary rules",
    render: () => {
      nav.path = "/canary/rules";
      return html(CanaryLoading);
    },
    line: "Loading the Canary rules…",
  },
];

describe("every loading shell", () => {
  it("is one busy region that holds 70% of the screen, so the footer does not jump up and back", () => {
    for (const shell of SHELLS) {
      const out = shell.render();
      expect(out.match(/aria-busy="true"/g), shell.name).toHaveLength(1);
      const busy = /<div aria-busy="true" class="([^"]*)"/.exec(out)?.[1] ?? "";
      expect(busy.split(/\s+/), shell.name).toContain("min-h-[70vh]");
    }
  });

  it("says what is loading in one line for a screen reader, and adds no live region (Next announces the page)", () => {
    for (const shell of SHELLS) {
      const out = shell.render();
      expect(
        [...out.matchAll(/<p class="sr-only">([^<]*)<\/p>/g)].map((m) => m[1]),
        shell.name,
      ).toEqual([shell.line]);
      expect(out, shell.name).not.toMatch(/\srole="|\saria-live="/);
    }
  });

  it("fades its skeleton in after the 200 ms gate, and every skeleton part is hidden from a screen reader", () => {
    for (const shell of SHELLS) {
      const out = shell.render();
      expect(out, shell.name).toContain('class="animate-pending-in"');
      for (const tag of out.match(/<[a-z]+\b[^>]*\bbg-soft\b[^>]*>/g) ?? []) {
        expect(tag, shell.name).toMatch(/aria-hidden="true"/);
      }
    }
  });

  it("keeps its own words to the site's copy rules: a label that ends in an ellipsis, no dash, no promise", () => {
    for (const shell of SHELLS) {
      expect(shell.line, shell.name).toMatch(/^Loading the [^.]+…$/);
      expect(shell.line, shell.name).not.toMatch(BANNED);
    }
  });
});

describe("the vault shell", () => {
  const render = (path = `/console/${VAULT}/keys`) => {
    nav.path = path;
    nav.params = { vault: VAULT };
    return html(VaultLoading);
  };

  it("names the vault in the h1 every vault page uses, so the head does not move when the page lands", () => {
    const pages = walk(join(SRC, "app", "console", "[vault]")).filter((f) =>
      f.endsWith("page.tsx"),
    );
    const classes = pages.flatMap((f) =>
      [...readFileSync(f, "utf8").matchAll(/<h1 className="([^"]*)">\{vault\}<\/h1>/g)].map(
        (m) => `${posix(f)}: ${m[1]}`,
      ),
    );
    // Overview, Keys, Agent, Mandates, Payables and one payable, Alerts, and Top-up's two heads.
    expect(classes.length).toBeGreaterThanOrEqual(9);
    const out = render();
    const h1 = classOf(out, "h1");
    expect(h1).toBe("mono mb-1 text-2xl font-semibold break-all");
    for (const line of classes) expect(line).toMatch(new RegExp(`: ${h1}$`));
    expect(out).toContain(`>${VAULT}</h1>`);
  });

  it("shows the name the address holds, decoded", () => {
    nav.path = "/console/a-b.testnet";
    nav.params = { vault: "a%2Db.testnet" };
    expect(html(VaultLoading)).toContain(">a-b.testnet</h1>");
  });

  it("has the real tab bar, with the tab that was opened already marked", () => {
    expect(render()).toMatch(/<nav\b[^>]*aria-label="Vault"/);
    expect(current(render())).toEqual(["Keys"]);
    expect(current(render(`/console/${VAULT}`))).toEqual(["Overview"]);
    expect(current(render(`/console/${VAULT}/payables/7`))).toEqual(["Payables"]);
  });

  it("draws the name and the tabs at once, and the role line and the cards after the gate", () => {
    const out = render();
    const head = out.indexOf("<h1");
    const tabs = out.indexOf("<nav");
    const gated = [...out.matchAll(/class="animate-pending-in"/g)].map((m) => m.index ?? -1);
    expect(gated).toHaveLength(2);
    expect(head).toBeLessThan(gated[0] ?? -1);
    expect(gated[0]).toBeLessThan(tabs);
    expect(tabs).toBeLessThan(gated[1] ?? -1);
    expect(out.match(/rounded-3xl border border-line bg-surface/g)).toHaveLength(3);
  });

  it("on a spend's approval page has that page's column and head, the link back and the spend's number, and no tabs", () => {
    nav.path = `/console/${VAULT}/approve/12`;
    nav.params = { vault: VAULT, spend: "12" };
    const out = html(VaultLoading);
    const page = source("app/console/[vault]/approve/[spend]/page.tsx");
    expect(page).toContain('<div className="mx-auto max-w-xl">');
    expect(classOf(out, "div")?.split(/\s+/)).toEqual(
      expect.arrayContaining(["mx-auto", "max-w-xl", "min-h-[70vh]"]),
    );
    const h1 = /<h1 className="([^"]*)">Spend #\{spendId\}<\/h1>/.exec(page)?.[1];
    expect(h1).toBeTruthy();
    expect(out).toContain(`<h1 class="${h1}">Spend #12</h1>`);
    const link = /const textLink =\s*"([^"]*)";/.exec(page)?.[1];
    expect(link).toBeTruthy();
    expect(out).toContain(
      `<p class="text-sm leading-6"><a class="${link}" href="/console/${VAULT}"><span aria-hidden="true">←\u00a0</span><span class="mono wrap-anywhere">${VAULT}</span></a></p>`,
    );
    expect(out).not.toContain("<nav");
  });
});

describe("the proof shell", () => {
  it("has the proof page's frame and head: a Proof eyebrow and the vault in ProofView's h1", () => {
    nav.path = `/proof/${VAULT}`;
    nav.params = { vault: VAULT };
    const out = html(ProofLoading);
    const view = source("components/proof/ProofView.tsx");
    const h1 = /<h1 className="([^"]*)">\{vault\}<\/h1>/.exec(view)?.[1];
    expect(h1).toBeTruthy();
    expect(classOf(out, "h1")).toBe(h1);
    expect(out).toContain(`>${VAULT}</h1>`);
    const eyebrow = /<p className="([^"]*)">\s*\{eyebrow\}/.exec(view)?.[1];
    expect(eyebrow).toBeTruthy();
    expect(out).toContain(`<p class="${eyebrow}">Proof</p>`);
    // The boundary is above /proof/[vault]'s layout, so the shell draws that layout's frame (Container) itself.
    expect(out).toMatch(
      /^<div class="mx-auto w-full max-w-\[1320px\] px-4 py-8 min-\[621px\]:px-6">/,
    );
    expect(classOf(out.replace(/^<div[^>]*>/, ""), "div")).toBe("mx-auto min-h-[70vh] max-w-3xl");
  });

  it("on /proof, before the vault is known, has a bar where the name goes and no empty h1", () => {
    nav.path = "/proof";
    const out = html(ProofLoading);
    expect(out).not.toContain("<h1");
    expect(out).toMatch(
      /<header class="mb-6"><p [^>]*>Proof<\/p><div class="animate-pending-in"><span aria-hidden="true" class="[^"]*bg-soft/,
    );
  });
});

describe("the Canary shell", () => {
  it("has the Canary page's head in its classes: eyebrow, title, lede and the Rules pill", () => {
    nav.path = "/canary";
    const out = html(CanaryLoading);
    expect(classOf(out, "div")?.split(/\s+/)).toEqual(
      expect.arrayContaining([s.site, s.wrap, c.page].filter(Boolean)),
    );
    expect(out).toContain(`<h1 class="${c.title}">${CANARY_COPY.head.title}</h1>`);
    expect(visible(out)).toContain(CANARY_COPY.head.lede);
    expect(out).toMatch(/<a class="[^"]*" href="\/canary\/rules">Rules<\/a>/);
    // The network is read from the address after mount: until then the eyebrow names none.
    expect(out).toContain(`<p class="${s.eyebrow}">${RULES_HEAD.eyebrow}</p>`);
    const page = source("app/canary/page.tsx");
    for (const cls of ["s.eyebrow", "c.title", "c.lede", "c.pills"]) {
      expect(page, cls).toContain(`className={${cls}}`);
    }
  });

  it("on the rules page has the rules' own head, not the Canary's title", () => {
    nav.path = "/canary/rules";
    const out = html(CanaryLoading);
    expect(out).toContain(`<h1 class="${c.title}">${RULES_HEAD.title}</h1>`);
    expect(out).not.toContain(CANARY_COPY.head.title);
    const page = source("app/canary/rules/page.tsx");
    expect(page).toContain("<h1 className={c.title}>{RULES_HEAD.title}</h1>");
  });
});

describe("where the shells are", () => {
  it("one loading.tsx per slow route, none at the root (it would wrap every page) and none over the vault list yet", () => {
    const files = walk(join(SRC, "app"))
      .filter((f) => /[\\/]loading\.tsx$/.test(f))
      .map(posix)
      .sort();
    expect(files).toEqual([
      "app/canary/loading.tsx",
      "app/console/[vault]/loading.tsx",
      "app/proof/loading.tsx",
    ]);
  });

  it("the header, the footer and every page link draw the route bar while their page loads", () => {
    for (const path of [
      "components/RouteLink.tsx",
      "components/site/SiteHeader.tsx",
      "components/site/SiteFooter.tsx",
      "components/canary/CanarySkeleton.tsx",
      "components/console/VaultSkeleton.tsx",
    ]) {
      const src = source(path);
      const ends = src.match(/<\/Link>/g) ?? [];
      expect(ends.length, path).toBeGreaterThan(0);
      expect(src.match(/<LinkPending \/>\s*<\/Link>/g), path).toHaveLength(ends.length);
    }
  });
});

describe("the console's error page", () => {
  const render = (retry = () => {}) => html(() => ConsoleError({ error: new Error("x"), retry }));

  it("says the page could not load, offers Try again and the vault list, and claims nothing about what happened", () => {
    const out = render();
    expect(out).toMatch(/<h1 [^>]*>This page could not load\.<\/h1>/);
    expect(out).toMatch(/<button type="button" class="[^"]*"><span class="busy-label">/);
    expect(out).not.toMatch(/\saria-disabled=/);
    expect(out).toMatch(/<a class="[^"]*" href="\/console">Your vaults<\/a>/);
    const text = visible(out);
    expect(text).toContain("Try again");
    expect(text).toContain(
      "check its result on its page or on the explorer before you do it again",
    );
    // No word on the chain's or the database's state: nothing changed, nothing was sent, it is safe to repeat.
    expect(text).not.toMatch(
      /nothing (?:was|has been) (?:changed|sent|saved)|not affected|safe to|was (?:not )?(?:sent|saved|changed)|\b(?:chain|NEAR|database|funds)\b/i,
    );
    expect(text).not.toMatch(BANNED);
  });

  it("is sized for its busy label, so the button does not move while it tries again", () => {
    expect(render()).toContain('data-label="Trying again…"');
  });

  it("asks Next to read the page again, and ignores a second press while that runs", () => {
    const retry = vi.fn();
    const button = () => {
      const found = elements(ConsoleError({ error: null, retry })).find((e) => e.type === "button");
      if (!found) throw new Error("no button");
      return found;
    };
    (button().props.onClick as () => void)();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(transition.started).toBe(1);

    transition.pending = true;
    const busy = button();
    expect(busy.props["aria-disabled"]).toBe(true);
    expect(textOf(busy)).toBe("Trying again…");
    (busy.props.onClick as () => void)();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(transition.started).toBe(1);
  });
});
