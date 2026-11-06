import { memberForApi } from "@/lib/auth/guard";
import { assertSameOrigin, json, problem } from "@/lib/http";
import { log } from "@/lib/log";
import { isNearAccountId, isNearTxHash } from "@/lib/near/validate";
import { mainnetGate, topupLimited } from "@/lib/topup/gate";
import { submitDeposit } from "@/lib/topup/oneclick";

export const dynamic = "force-dynamic";

/**
 * Owner only. Tells 1Click which transaction paid a deposit address, so it need not wait to notice it. This is
 * a speed-up only: 1Click also finds the deposit by itself, so a refusal or an outage is not an error here.
 * The sender 1Click is told is the signed-in account, never a name from the request.
 */
export async function POST(req: Request) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const body = (await req.json().catch(() => null)) as {
    vault?: unknown;
    txHash?: unknown;
    depositAddress?: unknown;
  } | null;
  if (
    typeof body?.vault !== "string" ||
    !isNearTxHash(body.txHash) ||
    typeof body.depositAddress !== "string" ||
    !isNearAccountId(body.depositAddress)
  ) {
    return problem(400, "invalid_input");
  }
  const auth = await memberForApi(body.vault, ["owner"]);
  if (auth instanceof Response) return auth;
  const gate = mainnetGate(auth.member.network);
  if (gate instanceof Response) return gate;
  const limited = await topupLimited("submit", auth.member.network, auth.session.accountId);
  if (limited) return limited;
  await submitDeposit(gate.jwt, {
    txHash: body.txHash,
    depositAddress: body.depositAddress,
    nearSenderAccount: auth.session.accountId,
  }).catch((error: unknown) => {
    log.warn("topup.submit_failed", {
      vault: auth.member.vault_id,
      error: error instanceof Error ? error.name : "unknown",
    });
  });
  return json({ ok: true });
}
