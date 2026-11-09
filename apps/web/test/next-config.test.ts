import { describe, expect, it } from "vitest";
import { docsHref, sidebarGroups } from "@/lib/docs/registry";
import withSentry, { nextConfig } from "../next.config";

const HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
};

async function headersOf(config: typeof nextConfig): Promise<Record<string, string>> {
  const rules = (await config.headers?.()) ?? [];
  expect(rules).toHaveLength(1);
  const rule = rules[0];
  expect(rule?.source).toBe("/(.*)");
  return Object.fromEntries((rule?.headers ?? []).map((h) => [h.key, h.value]));
}

describe("next.config headers", () => {
  it("sends Cross-Origin-Opener-Policy: same-origin-allow-popups and keeps every other security header", async () => {
    expect(await headersOf(nextConfig)).toEqual(HEADERS);
  });

  it("keeps the same headers once Sentry wraps the config", async () => {
    expect(await headersOf(withSentry)).toEqual(HEADERS);
  });
});

type Rewrite = { source: string; destination: string };
type Rewrites =
  | Rewrite[]
  | { beforeFiles?: Rewrite[]; afterFiles?: Rewrite[]; fallback?: Rewrite[] };

/** The rewrites as one list, whichever of Next's two shapes the config returns. */
async function rewritesOf(config: typeof nextConfig): Promise<Rewrite[]> {
  const out = ((await config.rewrites?.()) ?? []) as Rewrites;
  if (Array.isArray(out)) return out.map(({ source, destination }) => ({ source, destination }));
  return [...(out.beforeFiles ?? []), ...(out.afterFiles ?? []), ...(out.fallback ?? [])].map(
    ({ source, destination }) => ({ source, destination }),
  );
}

describe("next.config redirects", () => {
  // From the registry, so a new section or a reordered sidebar needs no edit here.
  const firstPages = () =>
    sidebarGroups().map((g) => ({
      source: `/docs/${g.section}`,
      destination: docsHref(g.pages[0]?.path ?? ""),
      permanent: true,
    }));

  it("send a docs section's address to its first page in sidebar order, with a 308", async () => {
    const out = await nextConfig.redirects?.();
    expect(out).toEqual(firstPages());
    expect(out?.map((r) => r.source)).toEqual([
      "/docs/start",
      "/docs/concepts",
      "/docs/build",
      "/docs/trust",
      "/docs/resources",
    ]);
    expect(out?.find((r) => r.source === "/docs/build")?.destination).toBe("/docs/build/install");
  });

  it("keep the same redirects once MDX and Sentry wrap the config", async () => {
    expect(await withSentry.redirects?.()).toEqual(firstPages());
  });
});

describe("next.config rewrites", () => {
  const TWINS = [
    { source: "/docs.md", destination: "/docs-md" },
    { source: "/docs/:path*.md", destination: "/docs-md/:path*" },
  ];

  it("serve each docs page's Markdown twin from /docs-md", async () => {
    expect(await rewritesOf(nextConfig)).toEqual(TWINS);
  });

  it("keep the same rewrites once MDX and Sentry wrap the config", async () => {
    expect(await rewritesOf(withSentry)).toEqual(TWINS);
  });
});
