/**
 * OWNER only. Tells Telegram where this app's bot webhook is, and the secret it must send. Run it once after the first
 * deploy that has TELEGRAM_BOT_TOKEN, and again after a new KEY_ENCRYPTION_SECRET (the secret is derived from it).
 * Runbook: docs/ops/alerts.md.
 *
 *   # all three come from your secret manager; nothing is typed on the command line
 *   TELEGRAM_BOT_TOKEN=… KEY_ENCRYPTION_SECRET=… pnpm --filter @probarion/web telegram-webhook
 *   # APP_ORIGIN=https://… for a deployment that is not https://probarion.xyz
 *
 * It calls setWebhook itself and prints one JSON line, Telegram's `ok` and `description`, and never the token or the
 * secret. Exit 0 = Telegram set it, 1 = Telegram refused or could not be reached, 2 = bad input.
 */
import { runWebhookSetup } from "../src/lib/alerts/webhook-setup";

process.exitCode = await runWebhookSetup(process.env, {
  fetch,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
