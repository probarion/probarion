import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "@/lib/sentry-scrub";

// The browser's Sentry. The DSN is inlined at build time from SENTRY_DSN (next.config.ts `env`). No environment name:
// the only public build-time names allowed are the six in test/deploy.test.ts, and VERCEL_ENV is not one of them.
// Errors only: without the BrowserSession integration, a page view sends Sentry nothing.
Sentry.init({
  ...sentryOptions(process.env.NEXT_PUBLIC_SENTRY_DSN || undefined),
  integrations: (defaults) => defaults.filter((i) => i.name !== "BrowserSession"),
});
// The default component, on the global scope, as on the server (sentry.server.config.ts).
Sentry.getGlobalScope().setTag("component", "web");

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
