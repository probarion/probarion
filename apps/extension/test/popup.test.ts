import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureSelection, TAB_UNREADABLE } from "../src/capture";
import {
  type Connection,
  getPending,
  type Pending,
  putConnection,
  setPending,
} from "../src/storage";
import { type FakeChrome, fakeChrome } from "./fake-chrome";
import { FakeDocument, FakeElement } from "./fake-dom";
import {
  type Call,
  fetchOf,
  inboxBody,
  json,
  NOW,
  ORIGIN,
  problem,
  TOKEN,
  TOKEN_B,
} from "./helpers";

// The popup itself (src/popup/main.ts), run on a small fake DOM (test/fake-dom.ts) and a fake chrome: what it shows,
// where focus goes, and what it writes to storage and the badge.

const conn = (over: Partial<Connection> = {}): Connection => ({
  network: "testnet",
  account: "owner.testnet",
  token: TOKEN,
  expires_at: "2026-12-10T00:00:00.000Z",
  connected_at: "2026-11-10T00:00:00.000Z",
  expired: false,
  ...over,
});

const SELECTION = "Invoice INV-88 total 6 USDC";
const item = (() => {
  const r = captureSelection(SELECTION);
  if (!r.ok) throw new Error(r.text);
  return r.item;
})();
const ready = (seen: boolean): Pending => ({ state: "ready", item, seen });

const sent = {
  invoice_id: "6f1c2a90-0000-4000-8000-000000000009",
  status: "awaiting_owner",
  duplicate: false,
  url: `${ORIGIN}/console/acme.vault.testnet/payables/6f1c2a90-0000-4000-8000-000000000009`,
};

type Answer = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

/** Probarion as the tests answer it: the inbox, and a send that is queued. */
const probarion: Answer = (url, init) =>
  url.endsWith("/api/ext/invoices") && init?.method === "POST"
    ? json(sent, 201)
    : json(inboxBody());

interface Popup {
  c: FakeChrome;
  doc: FakeDocument;
  app: FakeElement;
  calls: Call[];
  /** The popup's text, as a person reads it. */
  text(): string;
  /** The control with this data-focus name. */
  control(key: string): FakeElement;
  /** The buttons whose text is `label`. */
  buttons(label: string): FakeElement[];
}

let c: FakeChrome;

/** Opens the popup page (popup.html, or popup.html?view=tab) on the fake DOM and the fake chrome. */
async function open(answer: Answer = probarion, search = ""): Promise<Popup> {
  const doc = new FakeDocument();
  const app = doc.createElement("main");
  app.setAttribute("id", "app");
  doc.body.append(app);
  const f = fetchOf(answer);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("location", { search });
  vi.stubGlobal("window", { addEventListener: () => {} });
  vi.stubGlobal("chrome", c);
  vi.stubGlobal("fetch", f.fetch);
  vi.resetModules();
  await import("../src/popup/main");
  const control = (key: string) => {
    const el = app.querySelector(`[data-focus="${key}"]`);
    if (el === null) throw new Error(`no control ${key} on the screen: ${app.text}`);
    return el;
  };
  return {
    c,
    doc,
    app,
    calls: f.calls,
    text: () => app.text,
    control,
    buttons: (label) => app.querySelectorAll("button").filter((b) => b.text === label),
  };
}

/** Waits for `check` to pass, with room for a loaded machine. */
const until = <T>(check: () => T | Promise<T>) =>
  vi.waitFor(check, { timeout: 5000, interval: 20 });

/** Lets the popup's pending work run out, before checking that something did not happen. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Presses a button as a person does: it takes focus, then the click. */
function press(el: FakeElement): void {
  el.focus();
  el.click();
}

const count = (text: string, part: string) => text.split(part).length - 1;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  c = fakeChrome();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the popup's page", () => {
  it("has one level-one heading, the brand, on every screen", async () => {
    const p = await open();
    await until(() => expect(p.text()).toContain("Connect Probarion"));
    const brand = () => p.app.querySelectorAll("h1");
    expect(brand().map((h) => [h.text, h.className])).toEqual([["Probarion", "brand"]]);
    await putConnection(c, ORIGIN, conn());
    await until(() => expect(p.text()).toContain("Waiting for you (3)"));
    expect(brand().map((h) => h.text)).toEqual(["Probarion"]);
    // The screen's own title is still the h2 a heading-only screen gives focus to.
    expect(p.app.querySelector("h2")?.text).toBe("Waiting for you (3)");
  });
});

describe("sending an invoice", () => {
  beforeEach(async () => {
    await putConnection(c, ORIGIN, conn());
    await setPending(c, ready(true));
  });

  it("lands focus on the result's Open and brings the result line into view", async () => {
    const p = await open();
    await until(() => expect(p.control("send").disabled).toBe(false));
    press(p.control("send"));
    await until(() => expect(p.text()).toContain("Queued. It waits for your confirmation. Open"));
    await settle();
    // Send is off now (the invoice is gone), so focus does not fall to the first row at the top of the popup.
    expect(p.control("send").disabled).toBe(true);
    expect(p.doc.activeElement.dataset.focus).toBe("Open");
    expect(p.doc.activeElement.text).toBe("Open");
    const status = p.app.querySelector('[role="status"]');
    expect(status?.text).toBe("Queued. It waits for your confirmation. Open");
    expect(
      p.doc.scrolled.some((el) => el.text === "Queued. It waits for your confirmation. Open"),
    ).toBe(true);
  });

  it("keeps the Vault and Mandate selects off while it sends", async () => {
    let answer: (r: Response) => void = () => {};
    const p = await open((url, init) =>
      url.endsWith("/api/ext/invoices") && init?.method === "POST"
        ? new Promise<Response>((resolve) => {
            answer = resolve;
          })
        : json(inboxBody()),
    );
    await until(() => expect(p.control("send").disabled).toBe(false));
    expect([p.control("vault").disabled, p.control("mandate").disabled]).toEqual([false, false]);
    press(p.control("send"));
    await until(() => expect(p.calls.some((x) => x.url.endsWith("/invoices"))).toBe(true));
    expect(p.text()).toContain("Sending…");
    expect([p.control("vault").disabled, p.control("mandate").disabled]).toEqual([true, true]);
    answer(json(sent, 201));
    await until(() => expect(p.text()).toContain("Queued."));
    expect([p.control("vault").disabled, p.control("mandate").disabled]).toEqual([false, false]);
  });

  it("names the per-payment amount before the payee, and titles each select with its whole text", async () => {
    const p = await open();
    await until(() => expect(p.control("send").disabled).toBe(false));
    const vault = p.control("vault");
    const mandate = p.control("mandate");
    expect(vault.title).toBe("Acme operations (acme.vault.testnet)");
    expect(mandate.options().map((o) => o.text)).toEqual([
      "Northwind hosting · 2000 USDC per payment · near:northwind.testnet",
      "Mandate #5 · 5000 USDC per payment · near:contractor.testnet",
    ]);
    expect(mandate.title).toBe(
      "Northwind hosting · 2000 USDC per payment · near:northwind.testnet",
    );
    mandate.value = "5";
    mandate.dispatch("change");
    expect(mandate.title).toBe("Mandate #5 · 5000 USDC per payment · near:contractor.testnet");
  });

  it("shows the expired screen alone after a 401: one heading, one Reconnect, no second sentence", async () => {
    const p = await open((url, init) =>
      url.endsWith("/api/ext/invoices") && init?.method === "POST"
        ? problem(
            401,
            "bad_token",
            "Connect the extension again: open Probarion, then Browser extension.",
          )
        : json(inboxBody()),
    );
    await until(() => expect(p.control("send").disabled).toBe(false));
    press(p.control("send"));
    await until(() => expect(p.text()).toContain("Your connection expired"));
    await settle();
    expect(count(p.text(), "Your connection expired")).toBe(1);
    expect(p.buttons("Reconnect")).toHaveLength(1);
    expect(count(p.text(), "Reconnect")).toBe(2); // the sentence under the heading, and the button
    expect(p.app.querySelector('[role="alert"]')).toBeNull();
    expect(p.app.querySelector("[data-message]")).toBeNull();
    expect(p.c.badge.text).toBe("!");
    expect(await getPending(c)).toMatchObject({ state: "ready" }); // the invoice is kept for after reconnecting
  });
});

describe("the error screen", () => {
  it("says Try again in its sentence, and offers Retry once, as the button", async () => {
    await putConnection(c, ORIGIN, conn());
    const p = await open(() => Promise.reject(new TypeError("Failed to fetch")));
    await until(() => expect(p.app.querySelector('[role="alert"]')).not.toBeNull());
    expect(p.app.querySelector('[role="alert"]')?.text).toBe(
      "Couldn't reach Probarion. Try again.",
    );
    expect(p.buttons("Retry")).toHaveLength(1);
    expect(count(p.text(), "Retry")).toBe(1);
  });
});

describe("a captured invoice the popup can't show yet", () => {
  it("stays unseen behind Connect, and the badge keeps its +", async () => {
    await setPending(c, ready(false));
    const p = await open();
    await until(() => expect(p.text()).toContain("Connect Probarion"));
    await settle();
    expect(p.text()).not.toContain(SELECTION);
    expect(await getPending(c)).toMatchObject({ state: "ready", seen: false });
    expect(c.badge.text).toBe("+");
  });

  it("stays unseen behind Your connection expired", async () => {
    await putConnection(c, ORIGIN, conn({ expired: true }));
    await setPending(c, ready(false));
    const p = await open();
    await until(() => expect(p.text()).toContain("Your connection expired"));
    await settle();
    expect(await getPending(c)).toMatchObject({ seen: false });
    expect(c.badge.text).toBe("!");
  });

  it("stays unseen while Probarion can't be reached, and is marked seen once Retry shows it", async () => {
    await putConnection(c, ORIGIN, conn());
    await setPending(c, ready(false));
    let up = false;
    const p = await open((url, init) =>
      up ? probarion(url, init) : Promise.reject(new TypeError("Failed to fetch")),
    );
    await until(() => expect(p.text()).toContain("Couldn't reach Probarion. Try again."));
    await settle();
    expect(await getPending(c)).toMatchObject({ seen: false });
    expect(c.badge.text).toBe("+");
    up = true;
    press(p.buttons("Retry")[0] as FakeElement);
    await until(() => expect(p.text()).toContain(SELECTION));
    await until(async () => expect(await getPending(c)).toMatchObject({ seen: true }));
    await until(() => expect(c.badge.text).toBe("3"));
  });

  it("is marked seen when the Send section shows it, and the badge goes from + to the count", async () => {
    await putConnection(c, ORIGIN, conn());
    await setPending(c, ready(false));
    const p = await open();
    await until(() => expect(p.text()).toContain(SELECTION));
    await until(async () => expect(await getPending(c)).toMatchObject({ seen: true }));
    await until(() => expect(c.badge.text).toBe("3"));
  });
});

describe("a capture that reaches a popup page already open", () => {
  it("takes the badge from + back to the count once the page shows it", async () => {
    await putConnection(c, ORIGIN, conn());
    const p = await open();
    await until(() => expect(p.text()).toContain("Waiting for you (3)"));
    expect(c.badge.text).toBe("3");
    // The worker's menu click: openPopup failed, so it stored the capture unseen and its refresh set "+".
    c.badge.text = "+";
    await setPending(c, ready(false));
    await until(() => expect(p.text()).toContain(SELECTION));
    await until(async () => expect(await getPending(c)).toMatchObject({ seen: true }));
    await until(() => expect(c.badge.text).toBe("3"));
  });
});

describe("the tab view", () => {
  it("follows the connection the worker stores after Reconnect", async () => {
    await putConnection(c, ORIGIN, conn({ expired: true }));
    const p = await open(probarion, "?view=tab");
    await until(() => expect(p.text()).toContain("Your connection expired"));
    press(p.control("Reconnect"));
    await until(() => expect(c.opened).toHaveLength(1));
    // The person connects on the /extension page; the worker stores the new token.
    await putConnection(c, ORIGIN, conn({ token: TOKEN_B }));
    await until(() => expect(p.text()).toContain("Waiting for you (3)"));
    expect(p.text()).not.toContain("Your connection expired");
    const inbox = p.calls.filter((x) => x.url.endsWith("/api/ext/inbox"));
    expect(new Headers(inbox.at(-1)?.init?.headers).get("authorization")).toBe(`Bearer ${TOKEN_B}`);
  });
});

describe("Use the PDF in this tab", () => {
  it("names the tab, not a link, when the PDF can't be read", async () => {
    await putConnection(c, ORIGIN, conn());
    c.activeUrl = "https://billing.example/files/7.pdf";
    const p = await open((url, init) =>
      url.startsWith("https://billing.example/")
        ? Promise.reject(new TypeError("Failed to fetch"))
        : probarion(url, init),
    );
    await until(() => expect(p.buttons("Use the PDF in this tab")).toHaveLength(1));
    press(p.buttons("Use the PDF in this tab")[0] as FakeElement);
    await until(() => expect(p.text()).toContain(TAB_UNREADABLE));
    expect(p.text()).not.toContain("link");
  });
});
