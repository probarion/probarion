import { beforeEach, describe, expect, it } from "vitest";
import {
  ALARM,
  connectWithCode,
  type Deps,
  disconnect,
  ensureAlarm,
  handleConnect,
  handleMenu,
  installMenus,
  MENU_LINK,
  MENU_SELECTION,
  PERIOD_MINUTES,
  refresh,
  startConnect,
} from "../src/background";
import { ALERT_COLOR } from "../src/badge";
import { LINK_ELSEWHERE } from "../src/capture";
import type { Fetch, MessageSender } from "../src/chrome";
import {
  addNonce,
  type Connection,
  getPending,
  loadLocal,
  putConnection,
  selectOrigin,
  setPending,
} from "../src/storage";
import { type FakeChrome, fakeChrome } from "./fake-chrome";
import {
  fetchOf,
  inboxBody,
  json,
  NOW,
  ORIGIN,
  OTHER_ORIGIN,
  offline,
  PDF,
  problem,
  TOKEN,
} from "./helpers";

const conn = (over: Partial<Connection> = {}): Connection => ({
  network: "testnet",
  account: "owner.testnet",
  token: TOKEN,
  expires_at: "2026-12-10T00:00:00.000Z",
  connected_at: "2026-11-10T00:00:00.000Z",
  expired: false,
  ...over,
});
const NONCE = "n".repeat(22);
const message = {
  type: "probarion:connect",
  v: 1,
  nonce: NONCE,
  token: TOKEN,
  account: "owner.testnet",
  network: "testnet",
  expires_at: "2026-12-10T00:00:00.000Z",
};
const page: MessageSender = {
  id: "testextensionid",
  origin: ORIGIN,
  url: `${ORIGIN}/extension?nonce=${NONCE}`,
  tab: { id: 7 },
};

let c: FakeChrome;
const deps = (fetch: Fetch = offline): Deps => ({ chrome: c, fetch, now: () => NOW });
beforeEach(() => {
  c = fakeChrome();
});

describe("the badge and its alarm", () => {
  it("count what waits for the chosen connection", async () => {
    await putConnection(c, ORIGIN, conn());
    const f = fetchOf(() => json(inboxBody()));
    expect((await refresh(deps(f.fetch))).kind).toBe("ok");
    expect(c.badge.text).toBe("3");
  });

  it("marks an expired connection and stops the alarm", async () => {
    await putConnection(c, ORIGIN, conn());
    await ensureAlarm(deps());
    expect(c.alarmsSet.get(ALARM)).toBe(PERIOD_MINUTES);
    const f = fetchOf(() => problem(401, "bad_token", "Reconnect the extension."));
    expect((await refresh(deps(f.fetch))).kind).toBe("expired");
    expect(c.badge).toEqual({ text: "!", color: ALERT_COLOR });
    expect(c.alarmsSet.has(ALARM)).toBe(false);
    expect((await loadLocal(c)).connections[ORIGIN]?.expired).toBe(true);
    // The next alarm, or the next popup, asks nothing: no stream of 401s.
    expect((await refresh(deps(f.fetch))).kind).toBe("expired");
    expect(f.calls).toHaveLength(1);
  });

  it("treat a token past its end as expired without asking Probarion", async () => {
    await putConnection(c, ORIGIN, conn({ expires_at: "2026-11-09T00:00:00.000Z" }));
    const f = fetchOf(() => json(inboxBody()));
    expect((await refresh(deps(f.fetch))).kind).toBe("expired");
    expect(f.calls).toHaveLength(0);
    expect(c.badge.text).toBe("!");
  });

  it("show + while a captured invoice waits unseen", async () => {
    await putConnection(c, ORIGIN, conn());
    const f = fetchOf(() => json(inboxBody()));
    await setPending(c, { state: "error", text: "x", seen: false });
    await refresh(deps(f.fetch));
    expect(c.badge.text).toBe("+");
    await setPending(c, { state: "error", text: "x", seen: true });
    await refresh(deps(f.fetch));
    expect(c.badge.text).toBe("3");
  });

  it("stay as they were when Probarion can't be reached", async () => {
    await putConnection(c, ORIGIN, conn());
    c.badge.text = "3";
    expect(await refresh(deps(offline))).toMatchObject({
      kind: "error",
      text: "Couldn't reach Probarion. Retry",
    });
    expect(c.badge.text).toBe("3");
  });

  it("run only while a connection is live, every 5 minutes", async () => {
    await ensureAlarm(deps());
    expect(c.alarmsSet.has(ALARM)).toBe(false);
    await putConnection(c, ORIGIN, conn());
    await ensureAlarm(deps());
    await ensureAlarm(deps());
    expect([...c.alarmsSet]).toEqual([[ALARM, 5]]);
  });

  it("follow the chosen connection: a switch to a live one starts the alarm again", async () => {
    await putConnection(c, OTHER_ORIGIN, conn());
    await putConnection(c, ORIGIN, conn());
    await ensureAlarm(deps());
    await refresh(deps(fetchOf(() => problem(401, "bad_token", "x")).fetch));
    expect(c.alarmsSet.has(ALARM)).toBe(false);
    await selectOrigin(c, OTHER_ORIGIN);
    expect((await refresh(deps(fetchOf(() => json(inboxBody(OTHER_ORIGIN))).fetch))).kind).toBe(
      "ok",
    );
    expect(c.alarmsSet.get(ALARM)).toBe(PERIOD_MINUTES);
  });

  it("keep no alarm while the chosen connection has ended, though another one is live", async () => {
    await putConnection(c, OTHER_ORIGIN, conn());
    await putConnection(c, ORIGIN, conn({ expired: true }));
    await ensureAlarm(deps());
    expect(c.alarmsSet.has(ALARM)).toBe(false);
  });

  it("show + for an unseen capture even when Probarion can't be reached", async () => {
    await putConnection(c, ORIGIN, conn());
    await setPending(c, { state: "error", text: "x", seen: false });
    expect((await refresh(deps(offline))).kind).toBe("error");
    expect(c.badge.text).toBe("+");
  });
});

describe("connecting from Probarion's page", () => {
  it("keeps the connection once, and the nonce is used up", async () => {
    await addNonce(c, NONCE, ORIGIN, NOW - 60_000);
    const f = fetchOf(() => json(inboxBody()));
    expect(await handleConnect(deps(f.fetch), message, page)).toEqual({ ok: true });
    const s = await loadLocal(c);
    expect(s.selectedOrigin).toBe(ORIGIN);
    expect(s.connections[ORIGIN]).toEqual({
      network: "testnet",
      account: "owner.testnet",
      token: TOKEN,
      expires_at: message.expires_at,
      connected_at: new Date(NOW).toISOString(),
      expired: false,
    });
    expect(c.alarmsSet.has(ALARM)).toBe(true);
    // handleConnect asks Probarion nothing: the worker reads the inbox after the page has its answer.
    expect(f.calls).toHaveLength(0);
    await refresh(deps(f.fetch));
    expect(c.badge.text).toBe("3");
    // The same message again (a replay) is ignored.
    expect(await handleConnect(deps(f.fetch), message, page)).toEqual({ ok: false });
  });

  it("answers the connect page before it asks Probarion anything", async () => {
    await addNonce(c, NONCE, ORIGIN, NOW);
    const f = fetchOf(() => new Promise<Response>(() => {}));
    expect(await handleConnect(deps(f.fetch), message, page)).toEqual({ ok: true });
    expect(f.calls).toHaveLength(0);
    expect((await loadLocal(c)).connections[ORIGIN]?.token).toBe(TOKEN);
  });

  it.each<[string, MessageSender, unknown]>([
    ["another extension", { ...page, id: "otherextension" }, message],
    ["no tab (the popup or the worker)", { ...page, tab: undefined }, message],
    [
      "another site",
      { ...page, origin: "https://evil.example", url: "https://evil.example/extension" },
      message,
    ],
    ["another Probarion page", { ...page, url: `${ORIGIN}/console` }, message],
    ["a message that isn't a connect message", page, { ...message, token: "pbx_short" }],
    ["a nonce this extension didn't make", page, { ...message, nonce: "m".repeat(22) }],
  ])("ignores %s", async (_name, sender, msg) => {
    await addNonce(c, NONCE, ORIGIN, NOW);
    expect(await handleConnect(deps(), msg, sender)).toEqual({ ok: false });
    expect((await loadLocal(c)).connections).toEqual({});
  });

  it("ignores a nonce made for another origin, or one 15 minutes old", async () => {
    await addNonce(c, NONCE, OTHER_ORIGIN, NOW);
    expect(await handleConnect(deps(), message, page)).toEqual({ ok: false });
    await addNonce(c, NONCE, ORIGIN, NOW - 15 * 60_000);
    expect(await handleConnect(deps(), message, page)).toEqual({ ok: false });
    expect((await loadLocal(c)).connections).toEqual({});
  });

  it("opens the connect page with a fresh nonce, only for a Probarion origin", async () => {
    await startConnect(deps(), ORIGIN);
    const nonce = new URL(c.opened[0] ?? "").searchParams.get("nonce") ?? "";
    expect(c.opened).toEqual([`${ORIGIN}/extension?nonce=${nonce}`]);
    const f = fetchOf(() => json(inboxBody()));
    expect(await handleConnect(deps(f.fetch), { ...message, nonce }, page)).toEqual({ ok: true });
    await startConnect(deps(), "https://evil.example");
    expect(c.opened).toHaveLength(1);
  });
});

describe("the pairing code", () => {
  it("stores the connection it is traded for", async () => {
    const f = fetchOf((url) =>
      url.endsWith("/api/ext/pair")
        ? json({
            token: TOKEN,
            account: "owner.testnet",
            network: "testnet",
            expires_at: message.expires_at,
          })
        : json(inboxBody()),
    );
    await connectWithCode(deps(f.fetch), ORIGIN, "K7QM-4XRA", "Chrome on Windows");
    expect((await loadLocal(c)).connections[ORIGIN]?.account).toBe("owner.testnet");
    expect(c.badge.text).toBe("3");
  });

  it("throws the server's sentence for a wrong code, and stores nothing", async () => {
    const f = fetchOf(() => problem(401, "bad_code", "This code is wrong, used or expired."));
    await expect(connectWithCode(deps(f.fetch), ORIGIN, "K7QM-4XRA", "Chrome")).rejects.toThrow(
      "This code is wrong, used or expired.",
    );
    expect((await loadLocal(c)).connections).toEqual({});
  });
});

describe("Disconnect", () => {
  it("ends the token on Probarion, then forgets it", async () => {
    await putConnection(c, ORIGIN, conn());
    await ensureAlarm(deps());
    const f = fetchOf(() => new Response(null, { status: 204 }));
    expect(await disconnect(deps(f.fetch), ORIGIN)).toEqual({ revoked: true });
    expect(f.calls[0]?.url).toBe(`${ORIGIN}/api/ext/revoke`);
    expect((await loadLocal(c)).connections).toEqual({});
    expect(c.alarmsSet.has(ALARM)).toBe(false);
    expect(c.badge.text).toBe("");
  });

  it("forgets it even when Probarion can't be reached, and says so", async () => {
    await putConnection(c, ORIGIN, conn());
    expect(await disconnect(deps(offline), ORIGIN)).toEqual({ revoked: false });
    expect((await loadLocal(c)).connections).toEqual({});
  });
});

describe("the right-click menus", () => {
  it("are the two the spec names", async () => {
    await installMenus(deps());
    expect(c.menus).toEqual([
      { id: MENU_LINK, title: "Send invoice to Probarion", contexts: ["link"] },
      { id: MENU_SELECTION, title: "Send selection as invoice text", contexts: ["selection"] },
    ]);
  });

  it("hand selected text to the popup", async () => {
    await handleMenu(deps(), {
      menuItemId: MENU_SELECTION,
      selectionText: "Invoice INV-7 Total 120 USDC",
      pageUrl: "https://billing.example/inv/7",
    });
    expect(c.popupOpens).toBe(1);
    expect(await getPending(c)).toMatchObject({
      state: "ready",
      seen: true,
      item: { name: "selection.txt", type: "text/plain" },
    });
  });

  it("fetch a link on the page's own site", async () => {
    const f = fetchOf(() => new Response(PDF, { headers: { "content-type": "application/pdf" } }));
    await handleMenu(deps(f.fetch), {
      menuItemId: MENU_LINK,
      linkUrl: "https://billing.example/files/7.pdf",
      pageUrl: "https://billing.example/inv/7",
    });
    expect(f.calls.map((x) => x.url)).toEqual(["https://billing.example/files/7.pdf"]);
    expect(await getPending(c)).toMatchObject({
      state: "ready",
      item: { name: "7.pdf", type: "application/pdf" },
    });
  });

  it("say why a link to another site can't be read, without fetching it", async () => {
    const f = fetchOf(() => new Response(PDF));
    await handleMenu(deps(f.fetch), {
      menuItemId: MENU_LINK,
      linkUrl: "https://cdn.other.example/7.pdf",
      pageUrl: "https://billing.example/inv/7",
    });
    expect(f.calls).toHaveLength(0);
    expect(await getPending(c)).toMatchObject({ state: "error", text: LINK_ELSEWHERE });
  });

  it("say why a link can't be read when its download breaks off", async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(ctl) {
        ctl.error(new TypeError("network reset"));
      },
    });
    const f = fetchOf(
      () => new Response(broken, { headers: { "content-type": "application/pdf" } }),
    );
    await handleMenu(deps(f.fetch), {
      menuItemId: MENU_LINK,
      linkUrl: "https://billing.example/files/7.pdf",
      pageUrl: "https://billing.example/inv/7",
    });
    expect(await getPending(c)).toMatchObject({ state: "error", text: LINK_ELSEWHERE });
  });

  it("show + when the popup can't open", async () => {
    c.popupFails = true;
    await handleMenu(deps(), { menuItemId: MENU_SELECTION, selectionText: "Total 5 USDC" });
    expect(await getPending(c)).toMatchObject({ state: "ready", seen: false });
    expect(c.badge.text).toBe("+");
  });

  it("show + when Chrome has no openPopup for this extension (a throw, not a rejection)", async () => {
    c.action.openPopup = () => {
      throw new TypeError("c.action.openPopup is not a function");
    };
    await handleMenu(deps(), { menuItemId: MENU_SELECTION, selectionText: "Total 5 USDC" });
    expect(await getPending(c)).toMatchObject({ state: "ready", seen: false });
    expect(c.badge.text).toBe("+");
  });

  it("ignore a menu that isn't theirs", async () => {
    await handleMenu(deps(), { menuItemId: "other", selectionText: "x" });
    expect(await getPending(c)).toBeNull();
    expect(c.popupOpens).toBe(0);
  });
});
