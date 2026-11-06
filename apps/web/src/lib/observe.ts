import "server-only";
import { getIsolationScope } from "@sentry/nextjs";
import type { Network } from "@/lib/config";
import { type Component, PROCESS_SCOPE } from "@/lib/sentry-scrub";

/**
 * Tags the Sentry scope of the request being answered (Sentry's isolation scope, which the SDK forks for each request
 * it sees start), so an error it reports carries the same request id as its log lines. `network` is null for a run
 * that covers every network (the crons). `extra` must hold no secret and no personal data (a tenant id is fine, an
 * email address is not).
 *
 * The request that starts an instance is the exception: Next.js runs Sentry.init inside it, so Sentry never forked a
 * scope for it, and its isolation scope is the process-wide one that every later request's scope is copied from
 * (sentry.server.config.ts keeps it at PROCESS_SCOPE). Tags written there would show on other requests' events, with
 * another tenant and network, so that request is left untagged: its log-line events still carry their own request id
 * and network (sentry-scrub.ts).
 */
export function tagRequest(
  requestId: string,
  component: Component,
  network: Network | null,
  extra: Readonly<Record<string, string>> = {},
): void {
  const scope = getIsolationScope();
  if (scope === (globalThis as unknown as Record<symbol, unknown>)[PROCESS_SCOPE]) return;
  scope.setTags({
    ...extra,
    request_id: requestId,
    component,
    ...(network === null ? {} : { network }),
  });
}
