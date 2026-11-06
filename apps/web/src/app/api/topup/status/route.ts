import { memberForApi } from "@/lib/auth/guard";
import { json, problem } from "@/lib/http";
import { isNearAccountId } from "@/lib/near/validate";
import { mainnetGate, topupLimited } from "@/lib/topup/gate";
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
  const gate = mainnetGate(auth.member.network);
  if (gate instanceof Response) return gate;
  const limited = await topupLimited("status", auth.session.accountId);
  if (limited) return limited;
  try {
    return json(await getDepositStatus(gate.jwt, depositAddress));
  } catch (e) {
    if (e instanceof QuoteError) return problem(502, "status_unavailable", e.message);
    throw e;
  }
}
