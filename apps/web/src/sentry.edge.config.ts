import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "@/lib/sentry-scrub";

Sentry.init({
  ...sentryOptions(process.env.SENTRY_DSN?.trim() || undefined),
  environment: process.env.VERCEL_ENV?.trim() || "development",
});
// The default component, on the global scope so that a route's tagRequest() wins over it (sentry.server.config.ts).
Sentry.getGlobalScope().setTag("component", "web");
