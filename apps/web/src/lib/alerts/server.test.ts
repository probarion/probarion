import { beforeEach, describe, expect, it, vi } from "vitest";
import { deriveSubkey, parseMasterKey } from "@/lib/crypto/sodium";
import { MAINNET_ORIGIN, networkPart, TESTNET_ORIGIN } from "../../../test/fixtures/networks";
import { quietLogs } from "../../../test/fixtures/quiet-logs";

// The settings, the database, the key, the providers and the dispatch replaced; the logger and the stop links are real.
const mocks = vi.hoisted(() => ({
  env: vi.fn(),
  dispatch: vi.fn(),
  sendTelegram: vi.fn(),
  resendSender: vi.fn(),
  subkey: vi.fn(),
  db: { rpc: vi.fn() },
}));

vi.mock("@/lib/env", () => ({ getEnv: mocks.env }));
vi.mock("@/lib/db/clients", () => ({ serviceDb: () => mocks.db }));
vi.mock("@/lib/crypto/server", () => ({ subkey: mocks.subkey }));
vi.mock("./dispatch", () => ({ dispatchAlerts: mocks.dispatch }));
vi.mock("./telegram", () => ({ sendTelegram: mocks.sendTelegram }));
vi.mock("./email", () => ({ resendSender: mocks.resendSender }));

import { alertSenders, runAlerts } from "./server";

const logs = quietLogs();
const TOKEN = `123456789:AAH${"x".repeat(32)}`;
const COUNTS = { sent: 2, failed: 1, skipped: 0, deferred: 3 };

beforeEach(() => {
  for (const m of [
    mocks.env,
    mocks.dispatch,
    mocks.sendTelegram,
    mocks.resendSender,
    mocks.subkey,
  ]) {
    m.mockReset();
  }
  mocks.env.mockReturnValue({
    ...networkPart({ defaultNetwork: "testnet", both: true }),
    TELEGRAM_BOT_TOKEN: TOKEN,
    RESEND_API_KEY: "re_key",
  });
  mocks.dispatch.mockResolvedValue(COUNTS);
  mocks.resendSender.mockReturnValue({ send: vi.fn() });
});

describe("alertSenders", () => {
  it("has a sender for each provider that is configured, and none for one that is not", () => {
    const both = alertSenders();
    expect(both.telegram).toBeTypeOf("function");
    expect(both.email).not.toBeNull();
    expect(mocks.resendSender).toHaveBeenCalledWith("re_key");
    mocks.env.mockReturnValue({ TELEGRAM_BOT_TOKEN: null, RESEND_API_KEY: null });
    expect(alertSenders()).toEqual({ telegram: null, email: null });
    mocks.env.mockReturnValue({ TELEGRAM_BOT_TOKEN: TOKEN, RESEND_API_KEY: null });
    expect(alertSenders().email).toBeNull();
  });

  it("sends Telegram with the bot's token", async () => {
    mocks.sendTelegram.mockResolvedValue({ ok: true, id: "1" });
    expect(await alertSenders().telegram?.("42", "hi")).toEqual({ ok: true, id: "1" });
    expect(mocks.sendTelegram).toHaveBeenCalledWith(TOKEN, "42", "hi");
  });
});

describe("runAlerts", () => {
  it("dispatches for the network it is given, at that network's origin, with the service database, the deadline and the counts back", async () => {
    const deadline = Date.now() + 10_000;
    expect(await runAlerts("mainnet", deadline)).toEqual({ ...COUNTS, error: false });
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    const deps = mocks.dispatch.mock.calls[0]?.[0];
    expect(deps).toMatchObject({
      db: mocks.db,
      network: "mainnet",
      origin: MAINNET_ORIGIN,
      deadline,
    });
    expect(deps.senders.telegram).toBeTypeOf("function");
    // No hard limit given: the dispatch keeps its own default (the deadline plus its grace).
    expect(deps).not.toHaveProperty("hardLimit");
  });

  it("passes the function's end on as the dispatch's hard limit when the caller knows it", async () => {
    const deadline = Date.now() + 10_000;
    await runAlerts("testnet", deadline, deadline + 2_000);
    expect(mocks.dispatch.mock.calls[0]?.[0]).toMatchObject({
      network: "testnet",
      deadline,
      hardLimit: deadline + 2_000,
    });
  });

  it("links each network's alerts to that network's own origin, never the other's", async () => {
    await runAlerts("testnet", Date.now() + 1000);
    await runAlerts("mainnet", Date.now() + 1000);
    const [t, m] = mocks.dispatch.mock.calls.map((c) => c[0]);
    expect([t.network, t.origin]).toEqual(["testnet", TESTNET_ORIGIN]);
    expect([m.network, m.origin]).toEqual(["mainnet", MAINNET_ORIGIN]);
  });

  it("sends nothing for a network this site does not serve: there is no address to link to", async () => {
    mocks.env.mockReturnValue({
      ...networkPart({ defaultNetwork: "testnet" }),
      TELEGRAM_BOT_TOKEN: TOKEN,
      RESEND_API_KEY: "re_key",
    });
    expect(await runAlerts("mainnet", Date.now() + 1000)).toEqual({
      sent: 0,
      failed: 0,
      skipped: 0,
      deferred: 0,
      error: false,
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("makes the stop links of an email from the alerts subkey and the network's origin", async () => {
    const master = parseMasterKey(Buffer.alloc(32, 3).toString("base64"));
    mocks.subkey.mockImplementation((purpose: Parameters<typeof deriveSubkey>[1]) =>
      deriveSubkey(master, purpose),
    );
    await runAlerts("mainnet", Date.now() + 1000);
    const id = "6f9619ff-8b86-4d11-b42d-00c04fc964ff";
    const links = await mocks.dispatch.mock.calls[0]?.[0].stopLinks(id);
    expect(mocks.subkey).toHaveBeenCalledWith("alerts");
    expect(links.page).toMatch(
      new RegExp(`^${MAINNET_ORIGIN}/alerts/stop\\?s=${id}&t=[0-9a-f]{64}$`),
    );
    expect(links.oneClick).toMatch(
      new RegExp(`^${MAINNET_ORIGIN}/api/alerts/stop\\?s=${id}&t=[0-9a-f]{64}$`),
    );
  });

  it("never throws: a failed dispatch is a logged error and an answer that says so, with no counts", async () => {
    mocks.dispatch.mockRejectedValue(new Error(`connection refused ${TOKEN}`));
    const r = await runAlerts("mainnet", Date.now() + 1000);
    expect(r).toEqual({ sent: 0, failed: 0, skipped: 0, deferred: 0, error: true });
    const line = logs.lines.find((l) => l.includes("alerts.dispatch_failed"));
    expect(line).toBeDefined();
    expect(line).toContain('"level":"error"');
    expect(line).toContain("connection refused");
    expect(logs.lines.join("\n")).not.toContain(TOKEN);
  });

  it("never throws when the settings cannot be read either", async () => {
    mocks.env.mockImplementation(() => {
      throw new Error("Invalid environment: SUPABASE_URL is required");
    });
    expect((await runAlerts("mainnet", Date.now() + 1000)).error).toBe(true);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});
