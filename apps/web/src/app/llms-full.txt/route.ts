import { appOrigin } from "@/lib/config";
import { llmsFull } from "@/lib/docs/llms";

export const dynamic = "force-static";

export async function GET() {
  return new Response(await llmsFull(appOrigin()), {
    // Every page in one file: search engines list the pages themselves, not this copy.
    headers: { "Content-Type": "text/plain; charset=utf-8", "X-Robots-Tag": "noindex" },
  });
}
