import "server-only";
import { setTags } from "@sentry/nextjs";
import type { Network } from "@/lib/config";
import type { Component } from "@/lib/sentry-scrub";

/**
 * Tags the Sentry scope of the request being answered (Sentry's isolation scope, which the SDK is expected to fork per
 * request: not verified on Vercel, section 5), so an error it reports carries the same request id as its log lines. `network` is null for a run that covers every network (the
 * crons). `extra` must hold no secret and no personal data (a tenant id is fine, an email address is not).
 */
export function tagRequest(
  requestId: string,
  component: Component,
  network: Network | null,
  extra: Readonly<Record<string, string>> = {},
): void {
  setTags({
    ...extra,
    request_id: requestId,
    component,
    ...(network === null ? {} : { network }),
  });
}
