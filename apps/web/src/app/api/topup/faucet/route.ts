import { memberForApi } from "@/lib/auth/guard";
import { getEnv } from "@/lib/env";
import { assertSameOrigin, problem } from "@/lib/http";
import { requestNetwork } from "@/lib/network";
import { faucetCopy } from "@/lib/topup/copy";
import {
  FAUCET_USDC,
  faucetLimited,
  faucetSender,
  faucetVaultRefusal,
  mintToVault,
} from "@/lib/topup/faucet";

export const dynamic = "force-dynamic";
/** The mint waits for FINAL. */
export const maxDuration = 60;

const notFound = () => problem(404, "not_found");

/**
 * Testnet only, owner only (audit P0-2). Mints the fixed amount of test USDC straight into the vault, signed by the
 * team's mint-only key, once a day per vault and within a daily cap for all vaults. The body names the vault and
 * nothing else: the amount is fixed and the vault minted to is the membership row's.
 *
 * At any other network's address the route does not exist (404). The guard answers 401 without a session; a stranger,
 * an approver, a viewer (its 403) and a vault registered on the other network (its 409) all get the same 404 here, so a
 * vault id is never confirmed. Every check that can refuse runs before the counters are touched, so a refusal does not
 * use the vault's day.
 */
export async function POST(req: Request) {
  if ((await requestNetwork()) !== "testnet") return notFound();
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const body = (await req.json().catch(() => null)) as { vault?: unknown } | null;
  if (typeof body?.vault !== "string") return problem(400, "invalid_input");
  const auth = await memberForApi(body.vault, ["owner"]);
  if (auth instanceof Response) return auth.status === 401 ? auth : notFound();
  const { member, session } = auth;
  // The guard has shown the vault's network to be the request's, which is testnet; this narrows the type.
  const network = member.network;
  if (network !== "testnet") return notFound();

  const key = getEnv().TESTNET_FAUCET_KEY;
  const sender = key === null ? null : faucetSender(network, key);
  if (sender === null) {
    return problem(503, "not_configured", faucetCopy(FAUCET_USDC).unavailable);
  }
  const vault = member.vault_id;
  const refusal = await faucetVaultRefusal(network, vault, session.accountId);
  if (refusal) return refusal;
  const limited = await faucetLimited(vault);
  if (limited) return limited;
  return mintToVault(sender, vault);
}
