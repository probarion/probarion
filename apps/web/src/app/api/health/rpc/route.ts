import { parseProvider } from "@/lib/health";
import { rpcHealth } from "@/lib/health-server";
import { json } from "@/lib/http";
import { softRequestNetwork } from "@/lib/network";

export const dynamic = "force-dynamic";

/**
 * One RPC provider of the address's network: `?provider=<n>`, 0-based, default 0. 200 when it answers for the right
 * chain with a fresh block, 503 when not, 404 for an index the list does not have (no call is made).
 */
export async function GET(req: Request): Promise<Response> {
  const network = await softRequestNetwork();
  const provider = parseProvider(new URL(req.url).searchParams.get("provider"));
  const health = await rpcHealth(network, provider);
  if (health.kind === "settings") return json({ ok: false, network, detail: "settings" }, 503);
  if (health.kind === "unknown_provider") {
    const detail =
      health.providers === 0
        ? "no providers"
        : `provider must be between 0 and ${health.providers - 1}`;
    return json({ ok: false, network, providers: health.providers, detail }, 404);
  }
  return json(
    { ...health.probe, network, provider: health.provider, providers: health.providers },
    health.probe.ok ? 200 : 503,
  );
}
