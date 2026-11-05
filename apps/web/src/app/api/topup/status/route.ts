import { memberForApi } from "@/lib/auth/guard";
import { getEnv } from "@/lib/env";
import { json, problem } from "@/lib/http";
import { isNearAccountId } from "@/lib/near/validate";
import { getDepositStatus, QuoteError } from "@/lib/topup/oneclick";

export const dynamic = "force-dynamic";

/**
 * Owner only. The state 1Click reports for a deposit address (`?vault=&depositAddress=`): its status word and
 * the time it last changed, nothing else of 1Click's answer.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const vault = url.searchParams.get("vault") ?? "";
  const depositAddress = url.searchParams.get("depositAddress") ?? "";
  if (!isNearAccountId(vault) || !isNearAccountId(depositAddress)) {
    return problem(400, "invalid_input");
  }
  const auth = await memberForApi(vault, ["owner"]);
  if (auth instanceof Response) return auth;
  const env = getEnv();
  if (env.NEAR_NETWORK !== "mainnet") {
    return problem(409, "mainnet_only", "NEAR Intents and 1Click exist on mainnet only.");
  }
  const jwt = env.ONECLICK_JWT;
  if (!jwt) return problem(503, "not_configured");
  try {
    return json(await getDepositStatus(jwt, depositAddress));
  } catch (e) {
    if (e instanceof QuoteError) return problem(502, "status_unavailable", e.message);
    throw e;
  }
}
