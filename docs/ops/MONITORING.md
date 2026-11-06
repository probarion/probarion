# Monitoring

What watches the hosted service, and for which address. The app itself answers three health routes and shows them on
`/status`. A third-party uptime service (Better Stack in this guide) calls those routes from outside, receives the
watcher's heartbeat, and will host the public status page. Sentry receives the app's errors once the OWNER sets
`SENTRY_DSN`. One Vercel deployment serves both NEAR networks, and the address a request is opened at decides its
network ([both networks in one project](../runbooks/web-deploy.md#35-both-networks-in-one-project)), so every monitor
below names the address it calls. Monitors point at production addresses only: previews sit behind Vercel sign-in and
are not monitored. What to do when a signal turns red is in the [incident runbook](../RUNBOOK.md).

## Health routes

Each route answers JSON with `cache-control: no-store`, for the network of the address it is called at. No answer
names a configured URL or a setting's value.

| Route | 200 | Not 200 |
|---|---|---|
| `GET /api/health` | `{"ok":true,"service":"probarion-web","network":"testnet","commit":"<12 hex>","time":"<ISO time>"}` (`commit` is `null` outside Vercel) | 503 with `"ok":false` and `"detail":"settings"`: the deployment cannot read its settings, so its console cannot start. The log line `health.settings_invalid` says which setting. |
| `GET /api/health/rpc?provider=<n>` | `{"name":...,"ok":true,"latency_ms":...,"detail":"block <h>, <s> s behind","network":...,"provider":<n>,"providers":<N>}` | 503 with the same shape and `"ok":false` when the provider fails; 404 `provider must be between 0 and <N-1>` (or `no providers`) for an index the list does not have, and no call is made; 503 `{"ok":false,"network":...,"detail":"settings"}` when the settings cannot be read |
| `GET /api/health/nearai` | `{"name":"NEAR AI Cloud","ok":true,"latency_ms":...,"detail":...,"configured":true}` | 503 with the same shape and `"ok":false` |

- **RPC providers.** `provider` counts from 0 and defaults to 0. Provider n is entry n+1 of the variable that sets the
  network's list (`NEAR_RPC_URLS_MAINNET` or `NEAR_RPC_URLS_TESTNET`), or of the built-in list when the variable is
  unset: two providers on mainnet, one on testnet (`packages/core/src/constants.ts`). `providers` says how many there
  are. A provider is named by its host when it is a built-in URL, and otherwise as `<VARIABLE> entry <n+1>`, because a
  configured URL can hold an API key.
- **What 200 means.** For an RPC provider: one JSON-RPC `status` call, in 5 seconds, answered for the address's own
  chain, not syncing, with a last block at most 120 seconds old. For NEAR AI Cloud: its public model list, read with
  no key, lists at least one model. `configured` says whether `NEARAI_API_KEY` is set on this deployment; it does not
  change `ok`.
- **The detail strings** are a fixed set: `block <h>, <s> s behind`, `stale: block <h>, <s> s behind`,
  `syncing: block <h>`, `wrong chain`, `rpc error`, `no sync_info in the status response`, `malformed status answer`,
  `HTTP <code>`, `timeout after 5000 ms`, `network error`, `<n> model(s) listed, <m> with attestation and structured
  output`, `no models listed`, `malformed catalog answer` and `probe failed`.
- **Cache.** Each server instance keeps each answer for 30 seconds, failures included, keyed by network and provider
  (and one key for NEAR AI Cloud). `/status` reads the same cache. A monitor that checks every few minutes therefore
  sees a fresh probe, and a burst of requests makes at most one outbound call per key and instance every 30 seconds.
- **`/status`** shows the same probes, for its own network only, and links the other network's `/status` when that
  network has an address.

## Monitors

Better Stack's free plan was reported as 10 monitors with 3-minute checks; that is not verified here, so check it at
sign-up. Use keyword checks where the table gives a keyword, and let monitors follow redirects. There is one heartbeat
for both networks.

### Stage A (today)

The site serves testnet only, so every address answers for testnet.

| # | Name | URL | Passes when |
|---|---|---|---|
| 1 | App | `https://probarion.xyz/` | 200, and the body contains `Probarion` |
| 2 | API (testnet) | `https://probarion.xyz/api/health` | 200, and the body contains `"network":"testnet"` |
| 3 | NEAR RPC testnet, provider 0 | `https://probarion.xyz/api/health/rpc?provider=0` | 200 |
| 4 | NEAR AI Cloud | `https://probarion.xyz/api/health/nearai` | 200 |
| 5 | Proof | `https://probarion.xyz/proof` | 200, and the body contains `Probarion` |
| 6 | Canary | `https://probarion.xyz/canary` | 200, and the body contains `Canary` |
| 7 | security.txt | `https://probarion.xyz/.well-known/security.txt` | 200, and the body contains `Contact:` |
| 8 | Watcher heartbeat | none: the watcher pings Better Stack | a ping within the period and grace of [the heartbeat](#heartbeat) |

### Stage B (after web-deploy 3.5 step 2)

Step 2 of [both networks in one project](../runbooks/web-deploy.md#35-both-networks-in-one-project) gives each network
its own address: mainnet on `https://probarion.xyz` and testnet on `https://testnet.probarion.xyz`.

| # | Name | URL | Passes when |
|---|---|---|---|
| 1 | App (mainnet) | `https://probarion.xyz/` | 200, and the body contains `Probarion` |
| 2 | App (testnet) | `https://testnet.probarion.xyz/` | 200, and the body contains `Probarion` |
| 3 | API (mainnet) | `https://probarion.xyz/api/health` | 200, and the body contains `"network":"mainnet"` |
| 4 | API (testnet) | `https://testnet.probarion.xyz/api/health` | 200, and the body contains `"network":"testnet"` |
| 5 | NEAR RPC mainnet, provider 0 | `https://probarion.xyz/api/health/rpc?provider=0` | 200; alert after 2 failures in a row |
| 6 | NEAR RPC mainnet, provider 1 | `https://probarion.xyz/api/health/rpc?provider=1` | 200; alert after 2 failures in a row |
| 7 | NEAR RPC testnet, provider 0 | `https://testnet.probarion.xyz/api/health/rpc?provider=0` | 200 |
| 8 | NEAR AI Cloud | `https://probarion.xyz/api/health/nearai` | 200 |
| 9 | Watcher heartbeat | none: the watcher pings Better Stack | as in stage A |
| 10 | security.txt | `https://probarion.xyz/.well-known/security.txt` | 200, and the body contains `Contact:` |

- Add one RPC monitor for each entry added to a network's list. The `providers` field of any RPC answer says how many
  entries the list has.
- The two API keyword monitors catch a wrong `APP_ORIGIN_MAINNET` or `APP_ORIGIN_TESTNET` after a redeploy: the
  address then answers for the other network.
- NEAR AI Cloud is one service for the whole project, so one monitor covers both networks.

## Heartbeat

`/api/cron/watch` pings `BETTERSTACK_HEARTBEAT_URL` after the watches, only when every served network's watch was
healthy ([what one run does](watcher.md#what-one-run-does)). The URL holds a token, so it is a secret and never logged.

- **Period.** Set the heartbeat's expected period to the schedule in use. With the daily Vercel cron (00:00 UTC), that
  is a day plus a grace: the Hobby plan does not promise the minute a daily cron runs, so check how late it runs on
  first use and set the grace above it. With the OWNER's per-minute Supabase job
  ([per-minute schedule](watcher.md#turn-on-the-per-minute-schedule-once)), about 3 minutes.
- **A missed heartbeat means** that a network's watch was not healthy, or that nothing ran the watcher: the database
  is down, a network's chain could not be read, every tenant tried on a network failed, a network was starved, or the
  cron did not call the route.
- **It does not mean** that owner alerts were not delivered. Alerts go out after the heartbeat and never change it.
  Delivery failures show in the logs and in Sentry ([what each signal means](#what-each-signal-means)).
- A single missed ping can come from one starved run; the grace should absorb one.

## Status page

The third-party status page the OWNER creates in Better Stack. Until it exists, `/status` on each address and posts on
X from [@probarionhq](https://x.com/probarionhq) are the status page, and nothing in the repository links a status host.

- **Components**, each fed by the monitors of the current stage:
  - App: the App monitors;
  - API: the API monitors;
  - NEAR RPC (mainnet): the mainnet RPC monitors, from stage B (stage A has none, so leave the component out until
    then);
  - NEAR RPC (testnet): the testnet RPC monitor;
  - Confidential AI (NEAR AI Cloud): the NEAR AI Cloud monitor;
  - Owner alerts: the watcher heartbeat. Alerts need the watcher's events, but a green heartbeat does not prove that
    a message was delivered.

  There is no database component: no route probes the database.
- **Announcement**, permanent, word for word:

  > Unaudited beta. Probarion runs on NEAR testnet today, with test tokens. It is non-custodial: vault owners can freeze and withdraw from their own wallet even when this site is down.

  Change it when mainnet goes live, in the same change that says so elsewhere.
- **Links:** the security policy,
  <https://github.com/probarion/probarion/blob/main/SECURITY.md>, and support by a direct message to
  [@probarionhq](https://x.com/probarionhq) on X. No email address, until the OWNER has confirmed that the inbox
  receives mail.
- **Subscriptions:** email on.
- **Alert routing:** email and push to the OWNER for every monitor. Press "Send test alert" once and write down
  whether the email and the push arrived (check the button's name on first use).

## Sentry

Off until the OWNER sets `SENTRY_DSN`: the SDK is enabled only with a DSN. The browser's DSN is fixed at build time,
so a new value needs a redeploy.

### What is sent

One place decides it for the server, the edge and the browser (`apps/web/src/lib/sentry-scrub.ts`):

- Errors only. Tracing is off, and no trace header goes to another service.
- No user, no cookies, no headers, no request bodies, no query strings and no local variables. A request is cut to
  its URL without the query, and its method. Breadcrumb URLs lose their query too: alert links carry one-time tokens.
- Every string passes through the log's scrubber, which masks the value of every secret setting it knows and secret
  shapes such as a Telegram bot token in a URL path.
- Environment: `VERCEL_ENV` on the server and the edge (`production` or `preview`; `development` outside Vercel). The
  browser sets none, so Sentry's default, `production`, applies to browser events, also from a preview build that has
  a DSN.

### The console bridge

Routes catch their errors and log them, so few exceptions reach Sentry on their own. On the server, every
`console.error` line becomes an event (`captureConsoleIntegration` with the `error` level only). The app's log lines
are JSON with a key such as `alerts.dispatch_failed`: such an event's message and fingerprint are the key, so each key
is one issue, and the line itself, masked, is attached to the event as extra data. `log.warn` lines, such as
`alerts.send_failed` and `cron.rate_limits_prune_failed`, are not sent.

### Tags

- `request_id`: the id the proxy gives every request and returns as `x-request-id`; the log lines and the ledger
  entries carry it too.
- `network`: `mainnet` or `testnet`.
- `component`: one of `component:web`, `component:auth`, `component:console`, `component:payables`,
  `component:topup`, `component:canary`, `component:proof`, `component:usage`, `component:watcher`,
  `component:alerts`, `component:metrics`, `component:health` and `component:extension` (the last is for the browser
  extension's routes, not built yet).

Where the tags come from:

- Four routes tag their own requests: the Payables upload (`component:payables`, with the network and the tenant),
  the Canary attempt (`component:canary`, with the network), the watch cron (`component:watcher`) and the metrics cron
  (`component:metrics`). The crons cover every network, so they set no network. Every event of those requests,
  unhandled exceptions included, carries the route's component and request id, and a log line from them keeps the
  route's component: `alerts.dispatch_failed` in a watch run is `component:watcher`.
- Any other event made from a log line takes the component of its key's prefix (`alerts.` and `telegram.` are
  `component:alerts`, `topup.` is `component:topup`, `chain.` and `auth.` are `component:auth`, and so on), and the
  line's own `request_id` and `network`. A key with no known prefix stays `component:web`.
- An exception with no log line in a route that is not tagged (the top-up, auth, alerts or proof routes, or a server
  action) has `component:web` and no `request_id`.

### Alert rules

The OWNER creates them in Sentry and sends a test notification for each. They filter only on values the app sets.

| # | Rule | Filter | Then | Interval |
|---|---|---|---|---|
| 1 | A new issue | environment is `production` | email the OWNER | 5 min |
| 2 | A regression | environment is `production` | email | 5 min |
| 3 | A burst: more than 20 events in 10 minutes | environment is `production` | email | 30 min |
| 4 | Money path: a new issue, or more than 1 event in an hour | `component:payables`, `component:topup`, `component:canary`, `component:watcher` or `component:alerts` (and `component:extension` once the extension's routes exist) | email | 5 min |
| 4b | Optional. Mainnet: a new issue | `network` is `mainnet` | email and push | 5 min |
| 5 | Optional. Error rate (a metric alert) | only if the plan includes metric alerts (not verified) | email | not set |

There is no rule 6 for a missed watcher run: the Better Stack heartbeat already covers it, and the watcher's schedule
(daily, or per minute) is an OWNER choice that a cron monitor in Sentry would have to follow.

Rule 4 has a gap to know about: an unhandled exception in a top-up route has `component:web`, so rule 4 sees top-up
failures only through their `topup.` log lines. Rules 1 to 3 still see the exception.

### Data scrubber fields

Turn on Sentry's Data Scrubber and "Prevent storing of IP addresses", and add these fields. They are every secret
setting the app knows (`SECRET_ENV_NAMES`, `apps/web/src/lib/log.ts`) and the field names that carry secrets or
invoice text:

- `NEARAI_API_KEY`, `ONECLICK_JWT`, `SUPABASE_SERVICE_ROLE_KEY`, `KEY_ENCRYPTION_SECRET`, `SENTRY_DSN`,
  `TELEGRAM_BOT_TOKEN`, `RESEND_API_KEY`, `CRON_SECRET`, `BETTERSTACK_HEARTBEAT_URL`;
- `NEAR_RPC_URLS`, `NEAR_RPC_URLS_MAINNET`, `NEAR_RPC_URLS_TESTNET`, `NEAR_ARCHIVAL_RPC_URLS`,
  `NEAR_ARCHIVAL_RPC_URLS_MAINNET`, `NEAR_ARCHIVAL_RPC_URLS_TESTNET`, `BASE_RPC_URL`;
- `PROBARION_AGENT_KEY`, `PROBARION_LEDGER_KEY`, `OLD_KEY_ENCRYPTION_SECRET`, `NEW_KEY_ENCRYPTION_SECRET`;
- `agent_key`, `secret`, `invoice_text`, `authorization`, `cookie`, `token`.

The app already scrubs before anything leaves; this is the second wall.

## What each signal means

| Signal | Means | Go to |
|---|---|---|
| App or API monitor red | The site is down, or (API, 503 `settings`) the deployment cannot read its settings | [App down](../RUNBOOK.md#app-down) |
| API keyword missing (`"network":...`) | The address answers for the wrong network: an `APP_ORIGIN_*` setting is wrong | [App down](../RUNBOOK.md#app-down) |
| One RPC monitor red, another green | One provider is down or on the wrong chain; the readers fail over | [RPC failover](../RUNBOOK.md#rpc-failover) |
| Every RPC monitor of a network red | That network's chain cannot be read: sign-in, Register, the watcher and `/proof` stop for it | [RPC failover](../RUNBOOK.md#rpc-failover) |
| NEAR AI Cloud red | Decisions fall back to the rules alone | [Severity levels](../RUNBOOK.md#severity-levels) |
| Heartbeat missed | A network's watch was not healthy, or the watcher did not run ([heartbeat](#heartbeat)) | [Severity levels](../RUNBOOK.md#severity-levels) |
| Sentry `alerts.dispatch_failed`, `alerts.item_failed`, `alerts.mark_failed` or `alerts.stop_links_failed` | Owner alerts are failing; `alerts.send_failed` is a warning and shows only in the logs | [Alerts not delivered](../RUNBOOK.md#alerts-not-delivered) |
| Sentry rule 4 | A failure on the money path | [Severity levels](../RUNBOOK.md#severity-levels) |
| security.txt red | The security contact file is missing from the deployment | [Severity levels](../RUNBOOK.md#severity-levels) (SEV4) |

## OWNER setup

Every step is the OWNER's; none is for an agent.

1. **Sentry.**
   - Create the organisation and a Next.js project, and copy its DSN.
   - Set `SENTRY_DSN` in Vercel Production (and Preview if wanted), marked Sensitive, then redeploy: the browser's DSN
     is fixed at build time.
   - Optional source maps: `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and `SENTRY_PROJECT` as Vercel build settings.
   - Create rules 1 to 4 (4b and 5 optional) from [alert rules](#alert-rules) and send a test notification for each.
   - Turn on the Data Scrubber with [the fields above](#data-scrubber-fields), and "Prevent storing of IP addresses".
   - Trigger one error on a preview and check the `request_id`, `component` and `network` tags. An error in the
     Payables upload should show `component:payables`, and two requests at the same time should not share tags.
2. **Better Stack.**
   - Create the [stage A monitors](#stage-a-today). Move to stage B when web-deploy 3.5 step 2 is done.
   - Create the status page as [status page](#status-page) describes it: the components, the announcement, the
     links and the subscriptions. Set the alert routing, press "Send test alert", and write down whether the email
     and the push arrived.
   - When a status host name is chosen, add its CNAME at the registrar.
   - Set `BETTERSTACK_HEARTBEAT_URL` in Vercel (Sensitive), and the heartbeat's period for the schedule in use: a day
     plus a grace with the daily cron, about 3 minutes with the per-minute job.
   - Once the status page exists, record its address in the evidence file and commit it through a task branch:

     ```bash
     pnpm proof set links.status_page <the status page URL> --source "<where it was created>"
     ```
