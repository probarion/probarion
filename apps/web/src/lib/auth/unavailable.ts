import { problem } from "@/lib/http";
import { log } from "@/lib/log";

/**
 * The one answer for an infrastructure failure on an auth route (database, key derivation, RPC, a body that
 * was cut off, a missing setting): 503 `unavailable`. The cause goes to the log (which scrubs secrets); the
 * response carries no detail, so it cannot leak a URL, a key name or a database message.
 */
export function authUnavailable(event: string, error: unknown, requestId?: string): Response {
  log.error(event, {
    error: error instanceof Error ? error.message : "unknown",
    request_id: requestId,
  });
  return problem(503, "unavailable");
}
