"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

/**
 * The last boundary: it replaces the root layout when that layout fails, so it brings its own html and body and no
 * styles of the site. It reports the error (when a DSN is set) and shows none of it, only the digest the server logs.
 */
export default function GlobalError({ error }: { error: unknown }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  const digest =
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof error.digest === "string"
      ? error.digest
      : null;
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: "40px 16px" }}>
        <main style={{ maxWidth: 560, margin: "0 auto" }}>
          <h1 style={{ fontWeight: 300 }}>Something went wrong.</h1>
          <p>This page could not load. Reload it, or go back to the home page.</p>
          {digest === null ? null : (
            <p>
              Reference: <code>{digest}</code>
            </p>
          )}
          <p>
            <a href="/">Back to the home page</a>
          </p>
        </main>
      </body>
    </html>
  );
}
