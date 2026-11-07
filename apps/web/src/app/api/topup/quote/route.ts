import { memberForApi } from "@/lib/auth/guard";
import { isVaultConfig } from "@/lib/console/vaults";
import { assertSameOrigin, json, problem } from "@/lib/http";
import { log } from "@/lib/log";
import { chainConsts, getReader } from "@/lib/near/server";
import { intentsDepositTx } from "@/lib/near/tx";
import { parseTopupAmount } from "@/lib/topup/amount";
import { mainnetGate, topupLimited } from "@/lib/topup/gate";
import { buildQuoteRequest, checkQuote, fetchQuote, QuoteError } from "@/lib/topup/oneclick";

export const dynamic = "force-dynamic";
// 1Click may take its 15 s timeout, and the vault's config is read first (two rounds of 8 s per node, at worst).
export const maxDuration = 30;

/**
 * Owner only. Asks 1Click for a quote that puts Base USDC into the vault's own Intents account, and
 * answers only with a quote that `checkQuote` accepted: its signature verifies against 1Click's key and it
 * says what we asked for. The transaction the owner then signs is built here from that verified quote and
 * from this network's USDC, never from anything the browser sent.
 */
export async function POST(req: Request) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const body = (await req.json().catch(() => null)) as {
    vault?: unknown;
    amountUsdc?: unknown;
  } | null;
  if (typeof body?.vault !== "string" || typeof body.amountUsdc !== "string") {
    return problem(400, "invalid_input");
  }
  const auth = await memberForApi(body.vault, ["owner"]);
  if (auth instanceof Response) return auth;
  const vault = auth.member.vault_id;
  // The vault's own network (the guard has shown it is the request's): 1Click exists on mainnet only.
  const network = auth.member.network;
  const gate = mainnetGate(network);
  if (gate instanceof Response) return gate;
  const limited = await topupLimited("quote", network, auth.session.accountId);
  if (limited) return limited;

  const amount = parseTopupAmount(body.amountUsdc);
  if ("problem" in amount) return problem(400, "invalid_amount", amount.problem);

  const consts = chainConsts(network);
  let config: unknown;
  try {
    config = await getReader(network).getConfig(vault);
  } catch (error) {
    log.warn("topup.config_unreadable", { vault, error });
    return problem(503, "chain_unavailable", "The vault could not be read from NEAR. Try again.");
  }
  if (!isVaultConfig(config)) {
    log.warn("topup.config_unreadable", { vault, error: "not a vault config" });
    return problem(503, "chain_unavailable", "The vault could not be read from NEAR. Try again.");
  }
  // The refund goes to the owner the chain names, and that must be the account that is signed in.
  if (config.owner !== auth.session.accountId) return problem(403, "forbidden");
  if (!config.allowed_assets.includes(consts.allowedAssets.base)) {
    return problem(409, "asset_not_allowed");
  }

  const request = buildQuoteRequest(
    {
      vault,
      owner: config.owner,
      amountOut: amount.units,
      usdc: consts.usdc,
      baseAsset: consts.allowedAssets.base,
    },
    new Date(),
  );
  try {
    const resp = await fetchQuote(request, gate.jwt);
    const check = checkQuote(resp, request, new Date());
    if (!check.ok) {
      log.warn("topup.quote_rejected", {
        reason: check.reason,
        vault,
        request_id: req.headers.get("x-request-id") ?? undefined,
      });
      return problem(502, "quote_rejected", check.reason);
    }
    const { quote } = check;
    return json({
      quote,
      tx: intentsDepositTx(consts.usdc, quote.depositAddress, quote.amountIn, quote.depositMemo),
    });
  } catch (e) {
    if (e instanceof QuoteError) return problem(502, "quote_unavailable", e.message);
    throw e;
  }
}
