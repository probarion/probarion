import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALARM,
  badgeShown,
  connectWithCode,
  type Deps,
  disconnect,
  ensureAlarm,
  handleMenu,
  installMenus,
  MENU_LINK,
  MENU_SELECTION,
  onConnectMessage,
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
  TOKEN_B,
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

/**
 * What the worker does with a connect message: every answer it hands the page, each with how many requests to
 * Probarion had been made by then. It resolves once the work after the answer is done too.
 */
async function connect(f: ReturnType<typeof fetchOf>, msg: unknown, sender: MessageSender) {
  const answers: Array<{ answer: unknown; asked: number }> = [];
  await onConnectMessage(deps(f.fetch), msg, sender, (answer) =>
    answers.push({ answer, asked: f.calls.length }),
  );
  return answers;
}

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
      text: "Couldn't reach Probarion. Try again.",
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

  it("start the alarm again for a live connection chosen while Probarion can't be reached", async () => {
    await putConnection(c, OTHER_ORIGIN, conn());
    await putConnection(c, ORIGIN, conn());
    await ensureAlarm(deps());
    await refresh(deps(fetchOf(() => problem(401, "bad_token", "x")).fetch));
    expect(c.alarmsSet.has(ALARM)).toBe(false);
    await selectOrigin(c, OTHER_ORIGIN);
    expect((await refresh(deps(offline))).kind).toBe("error");
    expect(c.alarmsSet.get(ALARM)).toBe(PERIOD_MINUTES);
  });

  it("expire only the connection that got the 401, not one stored while the request was out", async () => {
    await putConnection(c, ORIGIN, conn());
    let asked = 0;
    const f = fetchOf(async () => {
      asked += 1;
      if (asked > 1) return json(inboxBody());
      // The person reconnected (a new token for this address) while the first request was out.
      await putConnection(c, ORIGIN, conn({ token: TOKEN_B }));
      return problem(401, "bad_token", "x");
    });
    expect((await refresh(deps(f.fetch))).kind).toBe("ok");
    expect((await loadLocal(c)).connections[ORIGIN]).toMatchObject({
      token: TOKEN_B,
      expired: false,
    });
    expect(new Headers(f.calls[1]?.init?.headers).get("authorization")).toBe(`Bearer ${TOKEN_B}`);
    expect(c.badge.text).toBe("3");
    expect(c.alarmsSet.has(ALARM)).toBe(true);
  });

  it("read the capture after the inbox: one an open popup page showed meanwhile shows no +", async () => {
    await putConnection(c, ORIGIN, conn());
    const failed = { state: "error" as const, text: "x" };
    await setPending(c, { ...failed, seen: false });
    // The popup page, open in a tab, shows the capture while the worker's inbox read is out.
    const f = fetchOf(async () => {
      await setPending(c, { ...failed, seen: true });
      return json(inboxBody());
    });
    await refresh(deps(f.fetch));
    expect(c.badge.text).toBe("3");
    // The same while Probarion can't be reached: no "+" is set for a capture already shown.
    await setPending(c, { ...failed, seen: false });
    await refresh(
      deps(async () => {
        await setPending(c, { ...failed, seen: true });
        throw new TypeError("Failed to fetch");
      }),
    );
    expect(c.badge.text).toBe("3");
  });
});

describe("the badge once the popup has shown the capture", () => {
  const ok = async () => {
    const s = await refresh(deps(fetchOf(() => json(inboxBody())).fetch));
    if (s.kind !== "ok") throw new Error("fixture");
    return s;
  };

  it("goes from + to the count of the inbox on the popup's screen", async () => {
    await putConnection(c, ORIGIN, conn());
    await setPending(c, { state: "error", text: "x", seen: false });
    const s = await ok();
    expect(c.badge.text).toBe("+");
    await setPending(c, { state: "error", text: "x", seen: true });
    await badgeShown(deps(), s);
    expect(c.badge.text).toBe("3");
  });

  it("keeps + while a capture still waits unseen, a newer one say", async () => {
    await putConnection(c, ORIGIN, conn());
    await setPending(c, { state: "error", text: "x", seen: false });
    const s = await ok();
    await badgeShown(deps(), s);
    expect(c.badge.text).toBe("+");
  });

  it("leaves the badge alone when the screen's connection is no longer the chosen live one", async () => {
    await putConnection(c, ORIGIN, conn());
    const s = await ok();
    c.badge.text = "!";
    await putConnection(c, ORIGIN, conn({ expired: true }));
    await badgeShown(deps(), s);
    expect(c.badge.text).toBe("!");
    await putConnection(c, ORIGIN, conn({ token: TOKEN_B }));
    await badgeShown(deps(), s);
    expect(c.badge.text).toBe("!");
    await putConnection(c, OTHER_ORIGIN, conn());
    await badgeShown(deps(), s);
    expect(c.badge.text).toBe("!");
    await badgeShown(deps(), { kind: "none" });
    expect(c.badge.text).toBe("!");
  });
});

describe("connecting from Probarion's page", () => {
  it("keeps the connection once, and the nonce is used up", async () => {
    await addNonce(c, NONCE, ORIGIN, NOW - 60_000);
    const f = fetchOf(() => json(inboxBody()));
    // The page has its answer before Probarion is asked anything.
    expect(await connect(f, message, page)).toEqual([{ answer: { ok: true }, asked: 0 }]);
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
    // After the answer the worker reads the inbox, for the badge.
    expect(f.calls.map((x) => x.url)).toEqual([`${ORIGIN}/api/ext/inbox`]);
    expect(c.badge.text).toBe("3");
    // The same message again (a replay) is ignored, and asks nothing.
    expect(await connect(f, message, page)).toEqual([{ answer: { ok: false }, asked: 1 }]);
    expect(f.calls).toHaveLength(1);
  });

  it("answers the connect page before it asks Probarion anything, however slow Probarion is", async () => {
    await addNonce(c, NONCE, ORIGIN, NOW);
    const f = fetchOf(() => new Promise<Response>(() => {})); // Probarion never answers
    const answered = new Promise<{ answer: unknown; asked: number }>((resolve) => {
      void onConnectMessage(deps(f.fetch), message, page, (answer) =>
        resolve({ answer, asked: f.calls.length }),
      );
    });
    expect(await answered).toEqual({ answer: { ok: true }, asked: 0 });
    expect((await loadLocal(c)).connections[ORIGIN]?.token).toBe(TOKEN);
    await vi.waitFor(() => expect(f.calls.map((x) => x.url)).toEqual([`${ORIGIN}/api/ext/inbox`]));
  });

  it("answers no when the connection can't be stored", async () => {
    await addNonce(c, NONCE, ORIGIN, NOW);
    c.storage.local.set = () => Promise.reject(new Error("quota"));
    expect(
      await connect(
        fetchOf(() => json(inboxBody())),
        message,
        page,
      ),
    ).toEqual([{ answer: { ok: false }, asked: 0 }]);
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
    const f = fetchOf(() => json(inboxBody()));
    expect(await connect(f, msg, sender)).toEqual([{ answer: { ok: false }, asked: 0 }]);
    expect((await loadLocal(c)).connections).toEqual({});
    expect(f.calls).toHaveLength(0);
  });

  it("ignores a nonce made for another origin, or one 15 minutes old", async () => {
    const f = fetchOf(() => json(inboxBody()));
    await addNonce(c, NONCE, OTHER_ORIGIN, NOW);
    expect(await connect(f, message, page)).toEqual([{ answer: { ok: false }, asked: 0 }]);
    await addNonce(c, NONCE, ORIGIN, NOW - 15 * 60_000);
    expect(await connect(f, message, page)).toEqual([{ answer: { ok: false }, asked: 0 }]);
    expect((await loadLocal(c)).connections).toEqual({});
  });

  it("opens the connect page with a fresh nonce, only for a Probarion origin", async () => {
    await startConnect(deps(), ORIGIN);
    const nonce = new URL(c.opened[0] ?? "").searchParams.get("nonce") ?? "";
    expect(c.opened).toEqual([`${ORIGIN}/extension?nonce=${nonce}`]);
    const f = fetchOf(() => json(inboxBody()));
    expect(await connect(f, { ...message, nonce }, page)).toEqual([
      { answer: { ok: true }, asked: 0 },
    ]);
    await startConnect(deps(), "https://evil.example");
    expect(c.opened).toHaveLength(1);
  });
});

describe("a new connection for an address that already has one", () => {
  const answerFor = (url: string) =>
    url.endsWith("/api/ext/revoke") ? new Response(null, { status: 204 }) : json(inboxBody());
  const revokes = (f: ReturnType<typeof fetchOf>) =>
    f.calls.filter((x) => x.url.endsWith("/api/ext/revoke"));
  const bearer = (call: { init: RequestInit | undefined } | undefined) =>
    new Headers(call?.init?.headers).get("authorization");

  it("ends the token it replaces, after the page has its answer", async () => {
    // Two /extension tabs were left open (two nonces). Tab 2 connected first; now tab 1's Connect extension arrives.
    await putConnection(c, ORIGIN, conn({ token: TOKEN_B }));
    await addNonce(c, NONCE, ORIGIN, NOW);
    const f = fetchOf(answerFor);
    expect(await connect(f, message, page)).toEqual([{ answer: { ok: true }, asked: 0 }]);
    expect((await loadLocal(c)).connections[ORIGIN]?.token).toBe(TOKEN);
    expect(revokes(f)).toHaveLength(1);
    expect(bearer(revokes(f)[0])).toBe(`Bearer ${TOKEN_B}`);
    expect(f.calls.map((x) => x.url)).toContain(`${ORIGIN}/api/ext/inbox`);
  });

  it("ends the token of a connection that was marked expired, too", async () => {
    await putConnection(c, ORIGIN, conn({ token: TOKEN_B, expired: true }));
    await addNonce(c, NONCE, ORIGIN, NOW);
    const f = fetchOf(answerFor);
    await connect(f, message, page);
    expect(bearer(revokes(f)[0])).toBe(`Bearer ${TOKEN_B}`);
  });

  it("keeps the new connection when the old token can't be ended", async () => {
    await putConnection(c, ORIGIN, conn({ token: TOKEN_B }));
    await addNonce(c, NONCE, ORIGIN, NOW);
    const f = fetchOf((url) =>
      url.endsWith("/api/ext/revoke")
        ? Promise.reject(new TypeError("Failed to fetch"))
        : json(inboxBody()),
    );
    expect(await connect(f, message, page)).toEqual([{ answer: { ok: true }, asked: 0 }]);
    expect((await loadLocal(c)).connections[ORIGIN]).toMatchObject({
      token: TOKEN,
      expired: false,
    });
    expect(revokes(f)).toHaveLength(1);
    expect(c.badge.text).toBe("3");
  });

  it("asks nothing to end when the address had no connection, or the same token", async () => {
    await addNonce(c, NONCE, ORIGIN, NOW);
    const f = fetchOf(answerFor);
    await connect(f, message, page);
    expect(revokes(f)).toHaveLength(0);
    await addNonce(c, NONCE, ORIGIN, NOW); // the same token again, as a replayed page would send it
    await connect(f, message, page);
    expect(revokes(f)).toHaveLength(0);
  });

  it("ends the replaced token when a pairing code makes the new connection", async () => {
    await putConnection(c, ORIGIN, conn({ token: TOKEN_B }));
    const f = fetchOf((url) =>
      url.endsWith("/api/ext/pair")
        ? json({
            token: TOKEN,
            account: "owner.testnet",
            network: "testnet",
            expires_at: message.expires_at,
          })
        : answerFor(url),
    );
    await connectWithCode(deps(f.fetch), ORIGIN, "K7QM-4XRA", "Chrome");
    expect((await loadLocal(c)).connections[ORIGIN]?.token).toBe(TOKEN);
    expect(revokes(f)).toHaveLength(1);
    expect(bearer(revokes(f)[0])).toBe(`Bearer ${TOKEN_B}`);
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

  it("counts a 401 as ended: the token was already dead", async () => {
    await putConnection(c, ORIGIN, conn());
    const f = fetchOf(() => problem(401, "bad_token", "Connect the extension again."));
    expect(await disconnect(deps(f.fetch), ORIGIN)).toEqual({ revoked: true });
    expect(f.calls).toHaveLength(1);
    expect((await loadLocal(c)).connections).toEqual({});
  });

  it("keeps a connection stored while the revoke was out, and does not wipe its token", async () => {
    await putConnection(c, ORIGIN, conn());
    // The revoke is slow. Meanwhile a connect page or a pairing code stores a new connection for this address.
    const f = fetchOf(async (url) => {
      if (!url.endsWith("/api/ext/revoke")) return json(inboxBody());
      await putConnection(c, ORIGIN, conn({ token: TOKEN_B }));
      return new Response(null, { status: 204 });
    });
    expect(await disconnect(deps(f.fetch), ORIGIN)).toEqual({ revoked: true });
    const s = await loadLocal(c);
    expect(s.connections[ORIGIN]).toMatchObject({ token: TOKEN_B, expired: false });
    expect(s.selectedOrigin).toBe(ORIGIN);
    expect(c.alarmsSet.has(ALARM)).toBe(true);
    // The kept connection is the one the badge reads.
    expect(new Headers(f.calls.at(-1)?.init?.headers).get("authorization")).toBe(
      `Bearer ${TOKEN_B}`,
    );
    expect(c.badge.text).toBe("3");
  });

  it("ends the token of a connection marked expired here, which may still be live on this address", async () => {
    await putConnection(c, ORIGIN, conn({ expired: true }));
    const f = fetchOf(() => new Response(null, { status: 204 }));
    expect(await disconnect(deps(f.fetch), ORIGIN)).toEqual({ revoked: true });
    expect(f.calls[0]?.url).toBe(`${ORIGIN}/api/ext/revoke`);
    expect(new Headers(f.calls[0]?.init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect((await loadLocal(c)).connections).toEqual({});
  });

  it("says so when an expired connection's token can't be ended because Probarion can't be reached", async () => {
    await putConnection(c, ORIGIN, conn({ expired: true }));
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

  it("hand selected text to the popup, unseen until the popup shows it", async () => {
    await handleMenu(deps(), {
      menuItemId: MENU_SELECTION,
      selectionText: "Invoice INV-7 Total 120 USDC",
      pageUrl: "https://billing.example/inv/7",
    });
    expect(c.popupOpens).toBe(1);
    // Chrome opened the popup, but the popup marks the invoice seen only once its Send section shows it.
    expect(await getPending(c)).toMatchObject({
      state: "ready",
      seen: false,
      item: { name: "selection.txt", type: "text/plain" },
    });
    expect(c.badge.text).toBe("+");
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
