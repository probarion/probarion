import * as Sentry from "@sentry/nextjs";
import { PROCESS_SCOPE, sentryOptions } from "@/lib/sentry-scrub";

// The server's Sentry. Off until SENTRY_DSN is set (read here, not through getEnv(), so a deployment whose other
// settings are broken still reports). console.error lines become events: lib/log.ts has already masked them, and
// sentry-scrub.ts gives each log key its own issue.
Sentry.init({
  ...sentryOptions(process.env.SENTRY_DSN?.trim() || undefined),
  environment: process.env.VERCEL_ENV?.trim() || "development",
  integrations: [Sentry.captureConsoleIntegration({ levels: ["error"] })],
});
// The default component. Sentry merges the global, then the isolation, then the current scope, so a default on the
// global scope is the one that a route's tagRequest() (the isolation scope) replaces. initialScope would put it on the
// current scope, where it would win over every route's tag.
Sentry.getGlobalScope().setTag("component", "web");
// The process-wide isolation scope, as found right after init: Next.js runs this file inside the request that starts
// the instance, which Sentry has given no scope of its own, so getIsolationScope() is the fallback that every later
// request's scope is copied from. observe.ts never tags it (lib/sentry-scrub.ts PROCESS_SCOPE).
(globalThis as unknown as Record<symbol, unknown>)[PROCESS_SCOPE] = Sentry.getIsolationScope();
