import { appOrigin } from "@/lib/config";
import { llmsIndex } from "@/lib/docs/llms";

export const dynamic = "force-static";

export function GET() {
  return new Response(llmsIndex(appOrigin()), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
