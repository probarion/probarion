import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageSender } from "../src/chrome";
import { readConnectMessage } from "../src/connect";
import { addNonce, loadLocal } from "../src/storage";
import { type FakeChrome, fakeChrome } from "./fake-chrome";
import { fetchOf, inboxBody, json, NOW, ORIGIN, OTHER_ORIGIN, TOKEN } from "./helpers";

// The /extension page's connect message goes page -> content script (src/content.ts) -> worker (src/worker.ts) ->
// handleConnect. These tests run the two real scripts on a fake window and a fake chrome, so a shape one side
// writes and the other doesn't read shows up here.

const NONCE = "n".repeat(22);
const posted = {
  type: "probarion:connect",
  v: 1,
  nonce: NONCE,
  token: TOKEN,
  account: "owner.testnet",
  network: "testnet",
  expires_at: "2026-12-10T00:00:00.000Z",
};
const pageSender: MessageSender = {
  id: "testextensionid",
  origin: ORIGIN,
  url: `${ORIGIN}/extension?nonce=${NONCE}`,
  tab: { id: 7 },
};

type Listener = (
  message: unknown,
  sender: MessageSender,
  sendResponse: (answer: unknown) => void,
) => boolean;

interface Page {
  c: FakeChrome;
  /** What the content script sent to the worker, as Chrome would hand it over (a JSON copy). */
  sent: unknown[];
  /** The page's window.postMessage to itself. */
  post(data: unknown, from?: { source?: unknown; origin?: string }): void;
  marked(): string | undefined;
}

/** Loads the content script and the worker on a fake window and a fake chrome, joined as Chrome joins them. */
async function load(): Promise<Page> {
  const c = fakeChrome();
  const listeners: Listener[] = [];
  c.runtime.onMessage = { addListener: (f) => listeners.push(f) };
  const sent: unknown[] = [];
  c.runtime.sendMessage = (message) => {
    const copy = JSON.parse(JSON.stringify(message)) as unknown;
    sent.push(copy);
    return new Promise((resolve) => {
      const async = listeners.some((f) => f(copy, pageSender, resolve));
      if (!async) resolve(undefined);
    });
  };
  let onMessage: ((event: unknown) => void) | undefined;
  const win = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, f: (event: unknown) => void) => {
      if (type === "message") onMessage = f;
    },
  };
  const doc = { documentElement: { dataset: {} as Record<string, string> } };
  vi.stubGlobal("chrome", c);
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("fetch", fetchOf(() => json(inboxBody())).fetch);
  vi.resetModules();
  await import("../src/worker");
  await import("../src/content");
  return {
    c,
    sent,
    post: (data, from = {}) => onMessage?.({ data, source: win, origin: ORIGIN, ...from }),
    marked: () => doc.documentElement.dataset.probarionExtension,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the connect message, from the page to the worker", () => {
  it("is kept by the worker, and the page is marked Connected", async () => {
    const p = await load();
    await addNonce(p.c, NONCE, ORIGIN, NOW);
    p.post(posted);
    await vi.waitFor(() => expect(p.marked()).toBe("connected"));
    expect((await loadLocal(p.c)).connections[ORIGIN]).toMatchObject({
      token: TOKEN,
      account: "owner.testnet",
      network: "testnet",
      expired: false,
    });
  });

  it("reaches the worker in the shape the worker reads", async () => {
    const p = await load();
    p.post(posted);
    await settle();
    expect(p.sent).toHaveLength(1);
    const forwarded = p.sent[0] as { type: string; message: unknown };
    expect(forwarded.type).toBe("probarion:connect");
    expect(readConnectMessage(forwarded.message, NOW)).toEqual({
      nonce: NONCE,
      token: TOKEN,
      account: "owner.testnet",
      network: "testnet",
      expires_at: "2026-12-10T00:00:00.000Z",
    });
  });

  it("leaves the page unmarked when the worker has no such nonce, and keeps nothing", async () => {
    const p = await load();
    p.post(posted);
    await settle();
    expect(p.sent).toHaveLength(1);
    expect(p.marked()).toBeUndefined();
    expect((await loadLocal(p.c)).connections).toEqual({});
  });

  it("is used once: the same message again is not kept a second time", async () => {
    const p = await load();
    await addNonce(p.c, NONCE, ORIGIN, NOW);
    p.post(posted);
    await vi.waitFor(() => expect(p.marked()).toBe("connected"));
    const first = (await loadLocal(p.c)).connections[ORIGIN];
    p.post({ ...posted, token: `pbx_${"B".repeat(43)}` });
    await settle();
    expect((await loadLocal(p.c)).connections[ORIGIN]).toEqual(first);
  });

  it.each<[string, { source?: unknown; origin?: string }]>([
    ["another window", { source: {} }],
    ["another origin", { origin: OTHER_ORIGIN }],
    ["an origin Probarion doesn't own", { origin: "https://probarion.xyz.evil.example" }],
  ])("is ignored from %s", async (_name, from) => {
    const p = await load();
    await addNonce(p.c, NONCE, ORIGIN, NOW);
    p.post(posted, from);
    await settle();
    expect(p.sent).toHaveLength(0);
    expect(p.marked()).toBeUndefined();
  });

  it.each<[string, unknown]>([
    ["another type", { ...posted, type: "probarion:other" }],
    ["a bad token", { ...posted, token: "pbx_abc" }],
    ["a token that already ended", { ...posted, expires_at: "2026-11-01T00:00:00.000Z" }],
    ["a string", "probarion:connect"],
  ])("is not sent on when it is %s", async (_name, data) => {
    const p = await load();
    p.post(data);
    await settle();
    expect(p.sent).toHaveLength(0);
  });
});
