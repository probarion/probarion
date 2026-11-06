import "server-only";
import { unstable_cache } from "next/cache";
import { publicDb, serviceDb } from "@/lib/db/clients";
import { log } from "@/lib/log";
import { type Board, type FeedRow, parseBoard, parseFeed } from "./board";

// What the Canary page reads from the database, behind Next's data cache. The leaderboard scans the table, so only the
// service role may call it, and the cache is what bounds that scan to one a minute however many people look. A failure
// is cached too (as an absent answer, for the same time): a database in trouble is asked once a minute, not once a view.
// The parsing is outside the cache, so that a reader of this file never sees a stale shape.

export const BOARD_REVALIDATE_S = 60;
export const FEED_REVALIDATE_S = 15;
export const FEED_LIMIT = 30;

const warn = (msg: string, error: unknown) =>
  log.warn(msg, { error: error instanceof Error ? error.message : String(error) });

/** The raw answer, or null when the read failed (no service key in a preview, the database down). */
const readBoard = unstable_cache(
  async (): Promise<unknown> => {
    try {
      return await serviceDb().rpc<unknown>("public_canary_leaderboard", {});
    } catch (error) {
      warn("canary.board_unavailable", error);
      return null;
    }
  },
  ["canary-leaderboard"],
  { revalidate: BOARD_REVALIDATE_S },
);

const readFeed = unstable_cache(
  async (): Promise<unknown> => {
    try {
      return await publicDb().rpc<unknown>("public_canary_feed", { limit: FEED_LIMIT });
    } catch (error) {
      warn("canary.feed_unavailable", error);
      return null;
    }
  },
  ["canary-feed"],
  { revalidate: FEED_REVALIDATE_S },
);

/** The scoreboard, or null when it cannot be read or is malformed. Never throws. */
export async function loadBoard(): Promise<Board | null> {
  return parseBoard(await readBoard());
}

/** The newest attempts: a list (empty when there are none), or null when the feed could not be read. Never throws. */
export async function loadFeed(): Promise<FeedRow[] | null> {
  const raw = await readFeed();
  return raw === null ? null : parseFeed(raw);
}
