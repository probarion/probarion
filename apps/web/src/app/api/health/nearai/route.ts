import { nearAiHealth } from "@/lib/health-server";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

/** NEAR AI Cloud's public model list answers with at least one model. `configured`: the model key is set here. */
export async function GET(): Promise<Response> {
  const { probe, configured } = await nearAiHealth();
  return json({ ...probe, configured }, probe.ok ? 200 : 503);
}
