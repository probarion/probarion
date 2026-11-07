import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtTokenItem } from "@/lib/ext/store";
import { utcMinute } from "@/lib/payables/forms";

// The /extension page's two client panels. A static render shows what they show first; the rest needs a browser, so the
// wiring the extension relies on is held to the source, and the wait for the extension's mark is run on fake timers.
vi.mock("@/app/extension/actions", () => ({
  connectExtensionAction: vi.fn(),
  showPairCodeAction: vi.fn(),
  revokeExtensionAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const { ConnectPanel, extensionTookIt } = await import("./ConnectPanel");
const { ConnectedBrowsers } = await import("./ConnectedBrowsers");

const here = fileURLToPath(new URL(".", import.meta.url));
const flat = (file: string) => readFileSync(join(here, file), "utf8").replace(/\s+/g, " ");
const panel = flat("ConnectPanel.tsx");
const browsers = flat("ConnectedBrowsers.tsx");
const connect = panel.slice(
  panel.indexOf("async function connect("),
  panel.indexOf("async function code("),
);
const text = (html: string) => html.replace(/<!-- -->/g, "");

describe("the wait for the extension's mark", () => {
  const dataset: Record<string, string | undefined> = {};
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.stubGlobal("document", { documentElement: { dataset } });
    delete dataset.probarionExtension;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** The answer of a 3 s wait when the content script sets the mark `markAt` ms in, or never. */
  async function waitWithMarkAt(markAt: number | null): Promise<boolean> {
    delete dataset.probarionExtension;
    const answer = extensionTookIt(3000);
    if (markAt !== null) {
      await vi.advanceTimersByTimeAsync(markAt);
      dataset.probarionExtension = "connected";
    }
    await vi.advanceTimersByTimeAsync(5000);
    return answer;
  }

  it("counts a mark set at any moment of the 3 s, the last 200 ms too", async () => {
    for (const markAt of [0, 150, 1500, 2801, 2900, 2999]) {
      expect(await waitWithMarkAt(markAt), `${markAt} ms`).toBe(true);
    }
  });

  it("answers no once 3 s are over without a mark", async () => {
    expect(await waitWithMarkAt(null)).toBe(false);
    expect(await waitWithMarkAt(3300)).toBe(false);
  });
});

describe("the Connect panel", () => {
  const render = (nonce: string | null) =>
    text(
      renderToStaticMarkup(
        createElement(ConnectPanel, { nonce, account: "alice.testnet", network: "testnet" }),
      ),
    );

  it("offers Connect extension when the extension opened the page, and a code either way", () => {
    const opened = render("n".repeat(22));
    expect(opened).toMatch(/<button[^>]*>Connect extension<\/button>/);
    expect(opened).toMatch(/<button[^>]*>Show a code instead<\/button>/);
    expect(opened).not.toContain("To connect again");
    const direct = render(null);
    expect(direct).not.toContain("Connect extension");
    expect(direct).toContain("Open the Probarion extension and press Connect");
    expect(direct).toMatch(/<button[^>]*>Show a code instead<\/button>/);
  });

  it("clears the extension's mark, then posts the token to its own window in the shape the extension reads", () => {
    expect(connect.split('removeAttribute("data-probarion-extension")')).toHaveLength(2);
    expect(connect.indexOf('removeAttribute("data-probarion-extension")')).toBeLessThan(
      connect.indexOf("window.postMessage("),
    );
    expect(connect).toContain(
      'window.postMessage( { type: "probarion:connect", v: 1, nonce, token: r.token, account: r.account, network: r.network, expires_at: r.expires_at, }, window.location.origin, );',
    );
  });

  it("offers Connect extension once per nonce, and then says how to connect again", () => {
    expect(connect).toContain("if (nonce === null || posted) return;");
    expect(connect.indexOf("setPosted(true)")).toBeGreaterThan(
      connect.indexOf("window.postMessage("),
    );
    expect(panel).toMatch(
      /\) : posted \? \( <p className="mb-3">To connect again, press Connect in the extension\.<\/p> \) : \( <button /,
    );
  });

  it("says something went wrong when an action cannot be reached, and frees its buttons", () => {
    expect(panel.split("await connectExtensionAction(")).toHaveLength(2);
    expect(panel.split("await showPairCodeAction(")).toHaveLength(2);
    expect(panel).toMatch(
      /try \{ r = await connectExtensionAction\(browserLabel\(\)\); \} catch \{ setState\(\{ kind: "error", text: UNREACHABLE \}\); return; \}/,
    );
    expect(panel).toMatch(
      /try \{ const r = await showPairCodeAction\(\);[^}]*\}[^}]*\}[^}]*\} catch \{ setState\(\{ kind: "error", text: UNREACHABLE \}\); \}/,
    );
    expect(panel).toContain('const UNREACHABLE = "Probarion could not do this now. Try again.";');
  });

  it("warns that whoever types the code in first gets the connection", () => {
    expect(panel).toContain(
      "It works once, for ten minutes. Type it only into your own extension: whoever enters it first gets a 30-day connection to your account.",
    );
  });
});

describe("Connected browsers", () => {
  const item = (over: Partial<ExtTokenItem>): ExtTokenItem => ({
    id: "00000000-0000-4000-8000-000000000001",
    hint: "AbC1",
    label: "Chrome on Windows",
    created_at: "2026-11-07T10:00:00Z",
    last_used_at: null,
    expires_at: "2026-12-07T10:00:00Z",
    ...over,
  });

  it("says a connection is not used yet, or when it was last used", () => {
    const html = text(
      renderToStaticMarkup(
        createElement(ConnectedBrowsers, {
          items: [
            item({}),
            item({
              id: "00000000-0000-4000-8000-000000000002",
              last_used_at: "2026-11-07T11:30:00Z",
            }),
          ],
        }),
      ),
    );
    expect(html).toContain(
      `Connected ${utcMinute("2026-11-07T10:00:00Z")} · not used yet · ends ${utcMinute("2026-12-07T10:00:00Z")}`,
    );
    expect(html).toContain(`last used ${utcMinute("2026-11-07T11:30:00Z")}`);
    expect(html).not.toMatch(/\bnever\b/i);
  });

  it("says something went wrong when Revoke cannot be reached", () => {
    expect(browsers.split("await revokeExtensionAction(")).toHaveLength(2);
    expect(browsers).toMatch(
      /try \{ const r = await revokeExtensionAction\(t\.id\);[^}]*\} catch \{ setProblem\(UNREACHABLE\); \}/,
    );
    expect(browsers).toContain(
      'const UNREACHABLE = "Probarion could not do this now. Try again.";',
    );
  });
});
