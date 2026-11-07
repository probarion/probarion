import { appOrigin } from "@/lib/config";
import { llmsFull } from "@/lib/docs/llms";

export const dynamic = "force-static";

export async function GET() {
  return new Response(await llmsFull(appOrigin()), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
