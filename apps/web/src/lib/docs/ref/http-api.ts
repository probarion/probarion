import { CANARY_LIMITS } from "@/lib/canary/limits";
import { MAX_INVOICE_BYTES } from "@/lib/payables/limits";
import { LIMITS } from "@/lib/ratelimit";
import type { RefColumn, RefTable } from "./types";

/**
 * The HTTP routes of the hosted app (`apps/web/src/app/api`), one table per group. They serve the site and its
 * console; there is no public agent HTTP API. test/docs-ref-http-api.test.ts reads the route files and holds these
 * rows to them: every route and method, who may call it, its error codes, its rate limits and what each one counts,
 * and the fields of a success answer the route writes out. A row's id is `http-api-<method>-<path after /api>`.
 * The settings a cell writes out as numbers (a cookie's lifetime, a body cap, a code's length, the faucet's mint, the
 * probe cache) are held by the same test to the constants that set them. A success status code is not.
 */

const COLUMNS: readonly RefColumn[] = [
  { key: "route", label: "Route" },
  { key: "who", label: "Who may call" },
  { key: "body", label: "Body" },
  { key: "success", label: "Success" },
  { key: "errors", label: "Errors" },
  { key: "limit", label: "Rate limit" },
];

/** A window in words: 60 is "a minute", 600 "in 10 minutes". */
function perWindow(seconds: number): string {
  if (seconds === 60) return "a minute";
  if (seconds === 3600) return "an hour";
  if (seconds === 86_400) return "a day";
  if (seconds % 60 === 0) return `in ${seconds / 60} minutes`;
  return `in ${seconds} seconds`;
}

/** One `LIMITS` entry as a cell reads it: "20 a minute per IP address (`authChallenge`)". */
function limit(key: keyof typeof LIMITS, scope: string): string {
  const [max, seconds] = LIMITS[key];
  return `${max} ${perWindow(seconds)} ${scope} (\`${key}\`)`;
}

/** 4259840 -> "4,259,840". */
const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * The console's invoices route caps the whole request at the invoice cap plus 64 KiB for the form: `MAX_REQUEST_BYTES`
 * in lib/payables/upload.ts. That module loads pdf-parse (through extract.ts), so it is not imported here: the test
 * reads its sum and holds this one to it.
 */
const INVOICE_REQUEST_BYTES = MAX_INVOICE_BYTES + 64 * 1024;

/**
 * The extension's invoices route caps the whole request at the invoice cap plus 16 KiB, as it sends no purpose
 * document. A route file exports only its handlers and its config, so its `MAX_EXT_REQUEST_BYTES` cannot be imported
 * here: the test reads the route's sum and holds this one to it.
 */
const EXT_INVOICE_REQUEST_BYTES = MAX_INVOICE_BYTES + 16 * 1024;

const SAME = "from a page at the same address";
const BEARER = "`Authorization: Bearer pbx_...`";
const CRON = "`CRON_SECRET`, sent as `Authorization: Bearer` and the secret";
const CACHED = "None. Each probe's answer is kept 30 seconds per server instance";

function table(
  id: string,
  label: string,
  rows: readonly { id: string; cells: Record<string, string> }[],
): RefTable {
  return { id, label, columns: COLUMNS, rows };
}

export const TABLES: readonly RefTable[] = [
  table("http-api-auth", "Sign-in routes", [
    {
      id: "http-api-get-auth-challenge",
      cells: {
        route: "`GET /api/auth/challenge`",
        who: "Public",
        body: "None",
        success:
          "`200` with `{ message, recipient, nonce }`, and the `pb_chal` cookie for 5 minutes",
        errors: "`429 rate_limited`, `503 unavailable`",
        limit: limit("authChallenge", "per IP address"),
      },
    },
    {
      id: "http-api-post-auth-verify",
      cells: {
        route: "`POST /api/auth/verify`",
        who: `Public, ${SAME}, with the \`pb_chal\` cookie`,
        body: "JSON `{ accountId, publicKey, signature }`: the wallet's NEP-413 answer, 2048 bytes at most",
        success: "`200` with `{ accountId }`, and the `pb_session` cookie for 12 hours",
        errors:
          "`403 bad_origin`, `429 rate_limited`, `401 challenge_missing_or_expired`, `413 payload_too_large`, `503 wrong_chain`, `401 invalid_input`, `401 bad_signature`, `503 unavailable`",
        limit: limit("authVerify", "per IP address"),
      },
    },
    {
      id: "http-api-post-auth-logout",
      cells: {
        route: "`POST /api/auth/logout`",
        who: `Public, ${SAME}`,
        body: "None",
        success: "`200` with `{ ok: true }`. It clears `pb_session` and `pb_chal`.",
        errors: "`403 bad_origin`, `503 unavailable`",
        limit: "None",
      },
    },
  ]),

  table("http-api-console", "Console routes", [
    {
      id: "http-api-post-console-vault-invoices",
      cells: {
        route: "`POST /api/console/:vault/invoices`",
        who: `Signed-in session of the vault's owner or an approver, ${SAME}`,
        body: `\`multipart/form-data\`: the invoice as \`file\` (PDF or \`.txt\`) or as \`text\`, and an optional \`purpose\` file. A \`Content-Length\` header is required: ${thousands(INVOICE_REQUEST_BYTES)} bytes at most in all, and ${thousands(MAX_INVOICE_BYTES)} bytes at most for each file.`,
        success:
          "`200` with `{ invoiceId, status, outcome, recorded, amountIssue, requestId }`, and a `notice` when `status` is `unconfirmed` or `awaiting_owner`",
        errors:
          "`403 bad_origin`, `401 unauthenticated`, `403 forbidden`, `409 wrong_network`, `429 rate_limited`, `411 length_required`, `413 too_large`, `400 invalid_input`, `415 unsupported`, `409 duplicate`, `409 busy`, `409 no_keys`, `409 no_mandate`, `409 key_unavailable`, `503 key_unavailable`, `503 chain_unavailable`, `400 empty`, `400 unreadable`, `502 failed`, `500 internal`, `503 unavailable`",
        limit: limit("invoiceUpload", "per vault"),
      },
    },
  ]),

  table("http-api-extension", "Browser extension routes", [
    {
      id: "http-api-post-ext-pair",
      cells: {
        route: "`POST /api/ext/pair`",
        who: "Public: the pairing code is the credential",
        body: "JSON `{ code, label }` with a `Content-Length` header, 1 KiB at most",
        success:
          "`200` with `{ token, account, network, expires_at }`. The token is in this answer only: the server keeps its hash and its last four characters.",
        errors:
          "`429 rate_limited`, `400 invalid_input`, `400 bad_code_format`, `401 bad_code`, `503 unavailable`",
        limit: `${limit("extPairPerIp", "per IP address and network")}; ${limit("extPairGlobal", "per network")}`,
      },
    },
    {
      id: "http-api-get-ext-inbox",
      cells: {
        route: "`GET /api/ext/inbox`",
        who: `Extension token: ${BEARER}`,
        body: "None",
        success:
          "`200` with `{ network, account, counts, vaults }`. Each vault lists its `awaiting` invoices, its `held` spends and its `mandates`.",
        errors: "`401 bad_token`, `429 rate_limited`, `503 unavailable`",
        limit: limit("extInbox", "per account and network"),
      },
    },
    {
      id: "http-api-post-ext-invoices",
      cells: {
        route: "`POST /api/ext/invoices`",
        who: `Extension token: ${BEARER}, of an account that is the vault's owner or an approver. The role is read again on every request, and a Canary vault takes none.`,
        body: `\`multipart/form-data\`: \`vault\`, the vault's account id, \`mandate\`, the id of the mandate the member chose, and the invoice as \`file\` (PDF or \`.txt\`). A \`Content-Length\` header is required: ${thousands(EXT_INVOICE_REQUEST_BYTES)} bytes at most in all, and ${thousands(MAX_INVOICE_BYTES)} bytes at most for the file.`,
        success:
          "`201` with `{ invoice_id, status, url }`: `status` is `awaiting_owner`, and `url` opens the invoice in the console. Nothing is paid: the invoice waits there for the owner's wallet-signed Confirm. `200` with `{ invoice_id, status, duplicate, url }` when the invoice passes every check and the vault already holds it (the same text once normalised, or the same invoice number for the same payee): `duplicate` is `true`, `status` is the stored invoice's, and nothing new is stored.",
        errors:
          "`401 bad_token`, `429 rate_limited`, `411 length_required`, `413 too_large`, `400 invalid_input`, `403 not_member`, `409 wrong_network`, `415 unsupported`, `422 unreadable`, `422 empty`, `422 amount_unclear`, `503 chain_unavailable`, `404 mandate_not_found`, `422 mandate_inactive`, `409 no_keys`, `422 refused_by_code`, `503 unavailable`",
        limit: limit("extInvoice", "per account and network"),
      },
    },
    {
      id: "http-api-post-ext-revoke",
      cells: {
        route: "`POST /api/ext/revoke`",
        who: `Extension token: ${BEARER}`,
        body: "None",
        success: "`204` with no body. The calling token ends at once.",
        errors: "`401 bad_token`, `503 unavailable`",
        limit: "None",
      },
    },
  ]),

  table("http-api-topup", "Top-up routes", [
    {
      id: "http-api-post-topup-quote",
      cells: {
        route: "`POST /api/topup/quote`",
        who: `Signed-in session of the vault's owner, ${SAME}`,
        body: "JSON `{ vault, amountUsdc }`, the amount as a decimal string",
        success:
          "`200` with `{ quote, tx }`: a 1Click quote whose signature checked out, and the deposit transaction for the owner to sign",
        errors:
          "`403 bad_origin`, `400 invalid_input`, `401 unauthenticated`, `403 forbidden`, `409 wrong_network`, `409 mainnet_only`, `503 not_configured`, `429 rate_limited`, `503 unavailable`, `400 invalid_amount`, `503 chain_unavailable`, `409 asset_not_allowed`, `502 quote_rejected`, `502 quote_unavailable`",
        limit: limit("topupQuote", "per account and network"),
      },
    },
    {
      id: "http-api-get-topup-status",
      cells: {
        route: "`GET /api/topup/status`",
        who: "Signed-in session of the vault's owner",
        body: "None. Query: `vault` and `depositAddress`",
        success:
          "`200` with `{ status, updatedAt }` as 1Click reports them. `updatedAt` may be missing.",
        errors:
          "`400 invalid_input`, `401 unauthenticated`, `403 forbidden`, `409 wrong_network`, `409 mainnet_only`, `503 not_configured`, `429 rate_limited`, `503 unavailable`, `502 status_unavailable`",
        limit: limit("topupStatus", "per account and network"),
      },
    },
    {
      id: "http-api-post-topup-submit",
      cells: {
        route: "`POST /api/topup/submit`",
        who: `Signed-in session of the vault's owner, ${SAME}`,
        body: "JSON `{ vault, txHash, depositAddress }`",
        success: "`200` with `{ ok: true }`, even when 1Click refuses or cannot be reached",
        errors:
          "`403 bad_origin`, `400 invalid_input`, `401 unauthenticated`, `403 forbidden`, `409 wrong_network`, `409 mainnet_only`, `503 not_configured`, `429 rate_limited`, `503 unavailable`",
        limit: limit("topupSubmit", "per account and network"),
      },
    },
    {
      id: "http-api-post-topup-faucet",
      cells: {
        route: "`POST /api/topup/faucet`",
        who: `Signed-in session of the vault's owner, ${SAME}`,
        body: "JSON `{ vault }`",
        success:
          '`200` with `{ status: "minted", txHash, amount: "25" }`. `202` with `{ status: "unknown", txHash, detail }` when the mint was sent and its outcome is not known.',
        errors:
          "`404 not_found`, `403 bad_origin`, `400 invalid_input`, `401 unauthenticated`, `503 not_configured`, `429 rate_limited`, `409 not_owner`, `409 wrong_token`, `503 unavailable`, `502 mint_failed`",
        limit: `${limit("faucetTries", "per account")}; ${limit("faucetVault", "per vault")}; ${limit("faucetAccount", "per account")}; ${limit("faucetGlobal", "in all")}`,
      },
    },
  ]),

  table("http-api-canary", "Canary route", [
    {
      id: "http-api-post-canary-attempt",
      cells: {
        route: "`POST /api/canary/attempt`",
        who: `Public, ${SAME}`,
        body: `JSON \`{ text, via }\`: \`text\` is at most ${CANARY_LIMITS.maxTextChars} characters, and \`via\` is optional`,
        success:
          '`200` with `status: "done"`, `attemptId`, `techniques`, `proposal`, `code` and `raw`',
        errors:
          "`403 bad_origin`, `503 not_ready`, `429 rate_limited`, `400 invalid_input`, `400 empty`, `400 too_long`, `429 budget`, `409 busy`, `503 closed`, `502 failed`, `503 unavailable`",
        limit: `${limit("canaryModelVisitor", "per IP address")}; ${limit("canaryModelGlobal", "in all")}. Past those, ${CANARY_LIMITS.attemptsPerIpPerHour} attempts an hour per IP address, ${CANARY_LIMITS.attemptsGlobalPerHour} an hour and ${CANARY_LIMITS.attemptsGlobalPerDay} a day in all, and ${thousands(CANARY_LIMITS.dailyTokenBudget)} model tokens a UTC day (\`CANARY_LIMITS\`), each answered with \`429 budget\``,
      },
    },
  ]),

  table("http-api-health", "Health routes", [
    {
      id: "http-api-get-health",
      cells: {
        route: "`GET /api/health`",
        who: "Public",
        body: "None",
        success: "`200` with `{ ok: true, service, network, commit, time }`",
        errors:
          'None of the `error` codes. `503` with `ok: false` and `detail: "settings"` when the deployment cannot read its settings.',
        limit: "None",
      },
    },
    {
      id: "http-api-get-health-rpc",
      cells: {
        route: "`GET /api/health/rpc`",
        who: "Public",
        body: "None. Query: `provider`, a 0-based index into the network's RPC list, `0` by default",
        success:
          "`200` with `{ name, ok, latency_ms, detail, network, provider, providers }` when the provider answers for the right chain with a fresh block",
        errors:
          "None of the `error` codes. `503` with `ok: false` when the probe fails or the settings cannot be read, and `404` with `ok: false` for an index the list does not have.",
        limit: CACHED,
      },
    },
    {
      id: "http-api-get-health-nearai",
      cells: {
        route: "`GET /api/health/nearai`",
        who: "Public",
        body: "None",
        success:
          "`200` with `{ name, ok, latency_ms, detail, configured }` when NEAR AI Cloud's public model list answers with at least one model. `configured` says whether this deployment holds the model key.",
        errors:
          "None of the `error` codes. `503` with `ok: false` when the model list does not answer with a model.",
        limit: CACHED,
      },
    },
  ]),

  table("http-api-cron", "Scheduled job routes", [
    {
      id: "http-api-get-cron-watch",
      cells: {
        route: "`GET /api/cron/watch`",
        who: CRON,
        body: "None",
        success: "`200` with `{ ok: true, networks, heartbeat }`",
        errors:
          "`401 unauthorized`, `503 unavailable`. A run where a network's watch was not healthy is a `503` with `ok: false` and the same fields.",
        limit: "None",
      },
    },
    {
      id: "http-api-get-cron-metrics",
      cells: {
        route: "`GET /api/cron/metrics`",
        who: CRON,
        body: "None",
        success: "`200` with `{ ok: true, networks, prune }`",
        errors:
          "`401 unauthorized`, `503 unavailable`. When a network's numbers fail, the `503` also carries `prune`.",
        limit: "None",
      },
    },
  ]),

  table("http-api-telegram", "Telegram route", [
    {
      id: "http-api-post-telegram-webhook",
      cells: {
        route: "`POST /api/telegram/webhook`",
        who: "Telegram secret: the `x-telegram-bot-api-secret-token` header that `setWebhook` was given",
        body: "A Telegram update. The route acts on `/start <code>` and `/stop` only.",
        success:
          "`200` with `{ ok: true }` for every update past the secret check and the rate limit, even one it cannot act on",
        errors: "`503 unavailable`, `503 not_configured`, `401 unauthorized`, `429 rate_limited`",
        limit: limit("telegramWebhook", "in all"),
      },
    },
  ]),

  table("http-api-alerts", "Alert link routes", [
    {
      id: "http-api-post-alerts-confirm",
      cells: {
        route: "`POST /api/alerts/confirm`",
        who: "Public: the confirmation code from the email is the credential",
        body: "Form data: `code`, 32 hex characters",
        success:
          "`303` to `/console/<vault>/alerts?verified=1`. A code that is malformed, used, expired or unknown goes back to `/alerts/confirm`.",
        errors: "`429 rate_limited`, `503 unavailable`",
        limit: limit("alertLink", "per IP address"),
      },
    },
    {
      id: "http-api-post-alerts-stop",
      cells: {
        route: "`POST /api/alerts/stop`",
        who: "Public: the keyed token in the link is the credential",
        body: "Query: `s` and `t` from the link. The stop page adds the form field `from=page`.",
        success:
          "`200` with `{ ok: true }`, or with `from=page` a `303` back to `/alerts/stop` with `done=1`. The answer is the same whether or not the subscription existed or was on.",
        errors:
          "`400 invalid_link`, `503 unavailable`. With `from=page`, a failure is a `303` with `failed=1` instead of the `503`.",
        limit: "None: a valid token is all it needs",
      },
    },
  ]),
];
