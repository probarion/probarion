import { appOrigin } from "@/lib/config";
import { findPage, pathFromSlug, slugParams } from "@/lib/docs/registry";
import { pageMarkdown } from "@/lib/docs/twins";

// Built once per page. next.config.ts rewrites /docs.md and /docs/<path>.md here; any other path
// is a 404.
export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return slugParams();
}

export async function GET(_request: Request, context: RouteContext<"/docs-md/[[...slug]]">) {
  const page = findPage(pathFromSlug((await context.params).slug));
  if (!page) {
    return new Response("Not found\n", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(await pageMarkdown(page, appOrigin()), {
    headers: { "Content-Type": "text/markdown; charset=utf-8", "X-Robots-Tag": "noindex" },
  });
}
