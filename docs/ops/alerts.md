# Owner alerts (Telegram and email)

OWNER only, for the setup. A vault's owners and approvers can get a message on Telegram or by email when the watcher (`docs/ops/watcher.md`) records something on their vault. The page for it is `/console/<vault>/alerts`. This page says what is sent, when, how it is kept to one message per event, how to set up the two providers, how a person stops alerts, and how to try it. **Not tried here:** a real bot and real Resend sending. Every test runs against a fake provider, so the steps under "Set up" and "Try it" are unchecked until you run them.

## What is sent

One message per alert and event. The kinds (a new alert takes all of them; the database's default is the one list, `alert_subscriptions.kinds` in migration 0001):

| Kind | Message | Tells you |
| --- | --- | --- |
| `spend_held` | Approval needed | A spend is held until an approver signs. Says when the hold ends, and links the console. |
| `refused_by_contract` | Contract refused a spend | The vault rejected a spend with the code it gave (`NoMandate` and so on). No funds moved. Links the failed transaction. |
| `spend_paid` | Paid | A spend was paid on NEAR. |
| `spend_burned` | Paid to Base | A spend was withdrawn through NEAR Intents to the mandate's Base address. |
| `spend_failed` | Payout failed | A payout failed and its reservation was released. Nothing left the vault. |
| `allowance_low` | Key gas allowance low | An agent or ledger key has under 0.2 NEAR of allowance left. |
| `near_low` | Vault is low on NEAR | The vault's free NEAR is under 0.05 NEAR. At most once per UTC day. |

Every message links the console and an explorer page (the transaction when there is one, the vault's account otherwise), and ends with how to stop: `Stop or change alerts: send /stop to stop alerts for every vault in this chat, or open <origin>/console/<vault>/alerts` on Telegram (`/stop` ends the chat's alerts for every vault, and the bot says how many), and the stop link plus the console link in an email.

A message is plain text. It never carries a spend's `ref`, its memo or its destination: those are words a payee or an agent chose. A refusal code is shown only when it is plain letters (otherwise the message says "a code the contract returned"), and a hash or a key only when it is well formed. Control and bidi characters are removed from everything printed.

## When a message arrives

Not "within a minute". A message leaves when the watcher has recorded the event and a dispatch has run after it:

- **Right after a Payables invoice upload or a Canary attempt**: the route asks the watcher to look at that vault as soon as its response is sent, and then dispatches alerts for every vault, not only that one (for 10 seconds at most). That is one job for the whole network hung off a request for one vault; it is safe because every alert is claimed before it is sent, so two dispatches never send one twice.
- **Every minute**, once you turn on the per-minute schedule in `docs/ops/watcher.md`. Until then this does not happen.
- **Otherwise once a day**, when the daily cron of `apps/web/vercel.json` runs. A change that nobody drove through the app (an approver signing in a wallet, a spend an agent sent through the SDK) is recorded, and so alerted, at the next run that reaches its vault.

The cron route dispatches after the heartbeat, until 55 seconds after it started. What the deadline leaves waits for the next run. No send outlives the function: the route's limit is 60 seconds, a send is not started with less than 3 seconds of it left, and is given no longer than what is left less 2 seconds, so its claim is marked before the function ends (a send that is cut short is counted as failed, and tried again). A dispatch that fails is a log line (`alerts.dispatch_failed`) and `"alerts":{"error":true,...}` in the route's answer; it never changes the watch's health, its status or its heartbeat.

## Once per alert and event

The table `alerts_sent` is unique on `(subscription, event)`, and the only way to a send is `alert_claim` (migration 0011). A run claims an alert right before it sends, so two runs that overlap cannot both send it.

- A **failed** send is tried again on later runs, three attempts in all, each after 5 minutes for every attempt so far (the second after 5, the third after 10), so a short outage of a provider does not use up all three at once. An alert that cannot be made at all (it should not happen) is marked failed with a short sentence and the run goes on with the next.
- A claim left `sending` by a run that died is taken again after 2 minutes, also within the three attempts. An email carries a Resend idempotency key, so that path cannot send an email twice. A Telegram send has no such key: if Telegram took a message but the answer never came back (the call timed out), the message can arrive twice. That is the one case.
- A claim is made only for an alert that is still on: an alert removed a moment ago sends nothing more.
- An event older than 24 hours is not sent, and neither is one that happened before the alert existed.

## No flood of history

A vault's first watch records its whole history, observed at that moment. An owner who added an alert before that would otherwise get one message per old spend. So an event recorded before a vault has **caught up** (`vault_events.initial`) is not sent, with two exceptions that are still true now: `allowance_low` and `near_low`, and a `spend_held` whose hold is still open (an approval is still possible). A vault has caught up when a run has read everything: every list (spends, mandates, anchors) ended on a short page rather than at the 1,000-row cap, and the ledger answered fewer than 500 entries. The watcher says so when it writes that run's cursors (`caught_up`); a run that stopped at a cap moves its cursors and says nothing, so the next slice of the same history is history too. A vault with more history than one run reads therefore takes several runs, and none of what they record is sent. A hold that pins the spend cursor does not stop a vault from catching up, as long as the reads from the pin reached the end. A first run that fails part way writes no cursor, so the next run's events are flagged too. An event after the run that caught up is sent normally. The consequence to know: what a vault does before its first run has finished is history to the alerts, a payment made just before that run included. A vault that the per-minute schedule has already watched once (even while empty) loses nothing; with only the daily cron, a vault's first look can come after its first payments. Migration 0011 marks no vault as caught up, not even one that already ran under 0010 (a cursor past 0 could be the end of a short list or the cap of a long one), so the first run after it decides, and the events that run records are history.

The Canary never alerts `refused_by_contract`: in live mode every visitor attempt makes one. Its other kinds alert as usual.

## Who can do what

- Any member of a vault sees `/console/<vault>/alerts`: the alerts that are on, never a link code. An owner or an approver sees each address and chat id whole; a viewer sees them masked (an address as its first letter, three bullets and its domain, a chat as four bullets and its last 2 digits), and the database does the masking.
- Only an **owner** or an **approver** adds or removes an alert (the actions check the role on the server). A vault keeps at most 20 live alerts, and new emails and Telegram links together are limited to 5 per vault in 10 minutes. One address gets at most 3 confirmation emails a day, from every vault together (counted by a keyed hash of the address, never the address). An address is one address and nothing a mailer could read as a list, a display name or a comment, so `a@b.co,victim@x.co` is refused; the app and the database apply the same rule, and the address goes to Resend as a list of one.
- A confirmation link and a Telegram link work **once and for 24 hours**.

## How a person stops alerts

- **In the console:** Remove, on the Alerts tab.
- **By email:** every alert email ends with a stop link, `<origin>/alerts/stop?s=<alert id>&t=<token>`, and carries the `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers (RFC 8058), so a mail client's own unsubscribe button works. The token is a keyed hash of the alert's id under the `alerts` subkey of `KEY_ENCRYPTION_SECRET`. The page shows a button, and the button POSTs; opening the link (a mail scanner does that) stops nothing. The answer is the same whether or not the alert still exists. **A new `KEY_ENCRYPTION_SECRET` makes the stop links in earlier emails stop working** (the Remove button and `/stop` do not depend on it, and every email sent after the change has a working link).
- **On Telegram:** `/stop` ends every Telegram alert of that chat, and the bot says for how many vaults.

An email address is confirmed the same careful way: the confirmation email's link opens `/alerts/confirm?code=<code>`, a page that names the vault and has a button; only the button turns the alert on. Both pages are `noindex` and are not in the sitemap.

## Set up

### Apply migration 0011 (OWNER)

Apply `apps/web/supabase/migrations/20261108000011_alerts.sql` after 0010, the way `docs/runbooks/web-deploy.md` says (in order, stop at the first error, never a file twice). It adds `tenants.watch_caught_up_at`, `vault_events.initial`, the alert functions (all service role only) and redefines two functions of 0010. Apply it before the build that has the alerts goes live. The two redefined functions answer the old build exactly as before, and the old build never calls the alert functions. A build that runs without the migration logs `alerts.dispatch_failed` on every watcher run and its Alerts page says the alerts could not be read; nothing else is affected.

### Telegram (OWNER)

1. **OWNER:** in Telegram, talk to `@BotFather`: `/newbot`, a name, a username ending in `bot`. BotFather answers a token. Keep it in your password manager; do not paste it anywhere shared.
2. **OWNER:** in Vercel, Settings, Environment Variables: `TELEGRAM_BOT_TOKEN`, marked **Sensitive**, Production. Redeploy (a changed variable applies to the next build).
3. **OWNER:** tell Telegram where the webhook is. From `apps/web`, with the token and the production `KEY_ENCRYPTION_SECRET` taken from your password manager:

   ```bash
   TELEGRAM_BOT_TOKEN=… KEY_ENCRYPTION_SECRET=… pnpm --filter @probarion/web telegram-webhook
   # APP_ORIGIN=https://… when the deployment is not https://probarion.xyz
   ```

   The script calls `setWebhook` itself, with the route `/api/telegram/webhook`, a secret derived from `KEY_ENCRYPTION_SECRET` (the route checks it on every call) and `allowed_updates=["message"]`. It prints one line, Telegram's answer, for example `{"ok":true,"description":"Webhook was set"}`, and never the token or the secret. Exit code 0 means Telegram set it, 1 that Telegram refused or could not be reached, 2 that an input is missing or wrong (the message names the variable, never its value). **Run it again after every new `KEY_ENCRYPTION_SECRET`**, because the secret is derived from it (`docs/ops/key-rotation.md`).

### Email through Resend (OWNER)

1. **OWNER:** create a Resend account and add the domain `probarion.xyz` (Domains, Add domain). Add the DNS records Resend shows (the SPF and DKIM records) at your DNS host, and wait until Resend marks the domain verified. Until then Resend refuses to send from `alerts@probarion.xyz`, which is the address in `ALERT_FROM` (`apps/web/src/lib/config.ts`).
2. **OWNER:** create an API key in Resend, with permission to send only if it offers that. In Vercel: `RESEND_API_KEY`, marked **Sensitive**, Production. Redeploy.

A deployment with no token or no key simply has no sender for that channel: the page's buttons say "not set up on this server", and an alert for such a channel is left for the day the sender exists (the dispatch counts it as `skipped`).

### The links in a message

The origin in every link is the production address Vercel gives the build (`VERCEL_PROJECT_PRODUCTION_URL`, as `appOrigin()` reads it). A build without it (local development) writes `http://localhost:3000`.

## Try it (OWNER)

Once both providers are set up, on the demo vault:

1. **OWNER:** open `/console/<demo vault>/alerts`. Add your email, open the link in the confirmation email within 24 hours, press the button on the page it opens: the Alerts tab shows "Email confirmed. Alerts are on."
2. **OWNER:** press Create a Telegram link, open it, press Start. The bot answers "Linked to <vault>. You will get a message when ..." and the Alerts tab lists a Telegram alert that is on.
3. **OWNER:** make a spend that is held: a mandate whose `approval_above` is below the amount, then the spend. The message arrives after the next watcher look (see "When a message arrives") and links the console and the explorer.
4. **OWNER:** press Stop in the email's stop link, or send `/stop` to the bot, and check that the alert is gone from the Alerts tab and that nothing more arrives.

## Check that it works

In the SQL Editor:

```sql
select s.channel, s.verified_at, s.active, s.created_at from public.alert_subscriptions s join public.tenants t on t.id = s.tenant_id where t.vault_id = '<the vault>' order by s.created_at;
select a.status, a.attempts, a.error, a.updated_at, e.kind, e.event_key from public.alerts_sent a join public.vault_events e on e.id = a.vault_event_id order by a.id desc limit 20;
```

`failed` rows with an `error` are sends a provider refused (three attempts, then no more). The cron's answer and its `cron.watch` log line carry `alerts`: `sent`, `failed`, `skipped` (a channel with no sender here), `deferred` (left for the next run by the deadline) and `error`. The dispatch's own log lines are `alerts.send_failed` (channel, alert id and event id, and the provider's words cut to 200 characters), `alerts.item_failed`, `alerts.mark_failed` and `alerts.dispatch_failed`. **No log line holds an address, a chat id, a link code or a message.**

## What it does not do

- It does not send history. See "No flood of history".
- A Telegram message can arrive twice when Telegram's answer to a send is lost (see "Once per alert and event"). An email cannot.
- It does not send `mandate_created`, `spend_pending`, `spend_rejected`, `spend_expired` or `anchor` events by default; they are kinds an alert could be made for, and no page offers them yet.
- Telegram's `/start` with no code, and any other text, gets no answer.
