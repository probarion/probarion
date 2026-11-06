import { beforeEach, describe, expect, it, vi } from "vitest";
import { quietLogs } from "../../../test/fixtures/quiet-logs";

// `unstable_cache` needs the Next runtime. Here it records how it was called and runs the function it wraps at once.
const mocks = vi.hoisted(() => ({
  cached: [] as { keys: string[]; options: { revalidate?: number } }[],
  service: vi.fn(),
  anon: vi.fn(),
}));

vi.mock("next/cache", () => ({
  unstable_cache: (
    fn: (...a: unknown[]) => unknown,
    keys: string[],
    options: { revalidate?: number },
  ) => {
    mocks.cached.push({ keys, options });
    return fn;
  },
}));
vi.mock("@/lib/db/clients", () => ({
  serviceDb: () => ({ rpc: mocks.service }),
  publicDb: () => ({ rpc: mocks.anon }),
}));

import { FEED_LIMIT, loadBoard, loadFeed } from "./board-data";

const logs = quietLogs();

const BOARD = {
  browsers: 3,
  addresses: 2,
  attempts_external: 8,
  attempts_team: 1,
  raw_external: 2,
  techniques: [],
  contract_codes: [{ code: "NoMandate", n: 2 }],
};
const ROW = {
  created_at: "2026-11-06T10:15:30Z",
  techniques: ["roleplay"],
  code_status: "refused_by_code",
  code_rule: "custom.canary_no_autopay",
  raw: false,
  contract_status: null,
  contract_code: null,
  tx_hash: null,
  is_team: false,
};

beforeEach(() => {
  mocks.service.mockReset();
  mocks.anon.mockReset();
});

describe("how the scoreboard and the feed are cached", () => {
  it("keeps the leaderboard for a minute and the feed for 15 seconds, each under its own key", () => {
    const [board, feed] = mocks.cached;
    expect(mocks.cached).toHaveLength(2);
    expect(board?.options.revalidate).toBe(60);
    expect(feed?.options.revalidate).toBe(15);
    expect(board?.keys).not.toEqual(feed?.keys);
  });
});

describe("loadBoard", () => {
  it("reads the leaderboard with the service role, which is the only role allowed to", async () => {
    mocks.service.mockResolvedValue(BOARD);
    const board = await loadBoard();
    expect(mocks.service).toHaveBeenCalledWith("public_canary_leaderboard", {});
    expect(mocks.anon).not.toHaveBeenCalled();
    expect(board).toMatchObject({ visitors: 2, attempts_external: 8 });
  });

  it("is null when the answer is malformed", async () => {
    mocks.service.mockResolvedValue({ ...BOARD, browsers: -1 });
    expect(await loadBoard()).toBeNull();
  });

  it("is null, and logs a warning, when the database throws", async () => {
    mocks.service.mockRejectedValue(new Error("connection refused"));
    expect(await loadBoard()).toBeNull();
    const warned = logs.lines.filter((l) => l.includes("canary.board_unavailable"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("connection refused");
  });

  it("is null when the service key is not set, as in a preview", async () => {
    mocks.service.mockImplementation(() => {
      throw new Error("Invalid environment: SUPABASE_SERVICE_ROLE_KEY is required");
    });
    expect(await loadBoard()).toBeNull();
  });
});

describe("loadFeed", () => {
  it("reads the newest 30 attempts with the public key", async () => {
    mocks.anon.mockResolvedValue([ROW]);
    const feed = await loadFeed();
    expect(mocks.anon).toHaveBeenCalledWith("public_canary_feed", { limit: 30 });
    expect(FEED_LIMIT).toBe(30);
    expect(mocks.service).not.toHaveBeenCalled();
    expect(feed).toEqual([ROW]);
  });

  it("keeps the rows that are well formed", async () => {
    mocks.anon.mockResolvedValue([ROW, { ...ROW, created_at: "never" }, "garbage"]);
    expect(await loadFeed()).toEqual([ROW]);
  });

  it("is an empty list when the database says the feed is empty", async () => {
    mocks.anon.mockResolvedValue([]);
    expect(await loadFeed()).toEqual([]);
  });

  it("is null, not an empty list, and logs a warning when the database throws", async () => {
    mocks.anon.mockRejectedValue(new Error("timeout"));
    expect(await loadFeed()).toBeNull();
    expect(logs.lines.filter((l) => l.includes("canary.feed_unavailable"))).toHaveLength(1);
  });
});
