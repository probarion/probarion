import { getSession, membership } from "@/lib/auth/guard";
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
 * At any other network's address the route does not exist (404), and a stranger, an approver, a viewer or a vault
 * registered on another network gets the same 404, so a vault id is never confirmed. Every check that can refuse
 * runs before the counters are touched, so a refusal does not use the vault's day.
 */
export async function POST(req: Request) {
  if ((await requestNetwork()) !== "testnet") return notFound();
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const body = (await req.json().catch(() => null)) as { vault?: unknown } | null;
  if (typeof body?.vault !== "string") return problem(400, "invalid_input");
  const session = await getSession();
  if (!session) return problem(401, "unauthenticated");
  const member = await membership(body.vault, session.accountId, ["owner"]);
  if (member === null || member.network !== "testnet") return notFound();

  const key = getEnv().TESTNET_FAUCET_KEY;
  const sender = key === null ? null : faucetSender(key);
  if (sender === null) {
    return problem(503, "not_configured", faucetCopy(FAUCET_USDC).unavailable);
  }
  const vault = member.vault_id;
  const refusal = await faucetVaultRefusal(vault, session.accountId);
  if (refusal) return refusal;
  const limited = await faucetLimited(vault);
  if (limited) return limited;
  return mintToVault(sender, vault);
}
