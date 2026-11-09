import { appOrigin } from "@/lib/config";
import { buildSearchIndex } from "@/lib/docs/search-index";

export const dynamic = "force-static";

/** The docs search index, built once at build time from the Markdown twins. */
export async function GET(): Promise<Response> {
  return Response.json(await buildSearchIndex(appOrigin()), {
    headers: { "X-Robots-Tag": "noindex" },
  });
}
