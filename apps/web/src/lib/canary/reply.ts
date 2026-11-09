// What the form does with the server's answer to an attempt. Pure, and safe in the browser: the form hands in `fetch`
// and a timer, so that the retry rule below runs in a test with no DOM.
import { limitText, REPLY_TEXT } from "./copy";
import { isRecord } from "./format";
import type { AttemptResult } from "./service";
import type { CanaryVia } from "./via";

type Done = Extract<AttemptResult, { status: "done" }>;

export type Reply =
  | { kind: "done"; result: Done }
  | { kind: "busy" }
  | { kind: "error"; text: string };

/** What the form shows: a result or an error. A busy answer is settled inside `submitAttempt`, so it never gets here. */
export type Answer = Exclude<Reply, { kind: "busy" }>;

export const ATTEMPT_PATH = "/api/canary/attempt";
/**
 * How long a busy answer waits before the one retry. Every answer, a busy one included, uses one of the address's
 * attempts of the hour (the limiter runs before the lease), so the form asks twice at most and never in a loop.
 */
export const BUSY_RETRY_MS = 5000;

const error = (text: string): Extract<Reply, { kind: "error" }> => ({ kind: "error", text });

/** A whole `done` result: what the result view reads is there, so that a stray 200 is not drawn as one. */
function isDone(body: unknown): body is Done {
  if (!isRecord(body) || body.status !== "done" || !Array.isArray(body.techniques)) return false;
  if (!isRecord(body.code) || typeof body.code.status !== "string") return false;
  if (!isRecord(body.raw)) return false;
  return body.raw.sent === true
    ? typeof body.raw.status === "string"
    : body.raw.sent === false && typeof body.raw.skipped === "string";
}

/** Minutes until a limit is over, from Retry-After in seconds: rounded up, at least 1. */
const minutesFrom = (seconds: number): number => Math.max(1, Math.ceil(seconds / 60));

/** One answer of the attempt route as something to show. `retryAfterS` is the Retry-After header, in seconds. */
export function describeReply(status: number, body: unknown, retryAfterS: number | null): Reply {
  if (status === 200 && isDone(body)) return { kind: "done", result: body };
  const code = isRecord(body) && typeof body.error === "string" ? body.error : null;
  switch (code) {
    case "busy":
      return { kind: "busy" };
    // The route answers `rate_limited` for an address's 5 in 10 minutes and the global model cap, and `budget` for an
    // address's 6 an hour, the global 60 an hour and 600 a day, and the day's tokens. The visitor cannot tell them
    // apart, so both say the one thing that is true of all of them.
    case "rate_limited":
    case "budget":
      return error(
        retryAfterS === null ? REPLY_TEXT.limitLater : limitText(minutesFrom(retryAfterS)),
      );
    case "closed":
      return error(REPLY_TEXT.closed);
    case "not_ready":
      return error(REPLY_TEXT.notReady);
    case "too_long":
      return error(REPLY_TEXT.tooLong);
    case "empty":
      return error(REPLY_TEXT.empty);
    case "failed":
      return error(REPLY_TEXT.failed);
    default:
      return error(REPLY_TEXT.other);
  }
}

/** The part of `fetch` and of a timer that the form needs. The real `fetch` and a `setTimeout` promise fit. */
export interface AttemptIo {
  fetch(
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ): Promise<{
    status: number;
    headers: { get(name: string): string | null };
    json(): Promise<unknown>;
  }>;
  sleep(ms: number): Promise<void>;
}

function secondsOf(header: string | null): number | null {
  if (header === null || header.trim() === "") return null;
  const n = Number(header);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function ask(text: string, via: CanaryVia | null, io: AttemptIo): Promise<Reply> {
  try {
    const res = await io.fetch(ATTEMPT_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(via === null ? { text } : { text, via }),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // Not JSON (a gateway's page): described by its status alone.
    }
    return describeReply(res.status, body, secondsOf(res.headers.get("retry-after")));
  } catch {
    return error(REPLY_TEXT.other);
  }
}

/**
 * One attempt, with the source the visitor's link named (lib/canary/via.ts) when there is one. Blank text is refused
 * here and never sent. A busy answer waits `BUSY_RETRY_MS` and asks once more, with the same body; busy again is told
 * as such. Any other answer, an error included, is final: it is never asked again.
 */
export async function submitAttempt(
  text: string,
  io: AttemptIo,
  via: CanaryVia | null = null,
): Promise<Answer> {
  if (text.trim() === "") return error(REPLY_TEXT.empty);
  const first = await ask(text, via, io);
  if (first.kind !== "busy") return first;
  await io.sleep(BUSY_RETRY_MS);
  const second = await ask(text, via, io);
  return second.kind === "busy" ? error(REPLY_TEXT.busyAgain) : second;
}
