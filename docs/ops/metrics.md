# The usage numbers (`/usage`)

OWNER only. The public page `/usage` shows counts of vaults, payments, refusals and model decisions, with team vaults, external owners and Canary participants kept in separate columns. This page is about keeping those numbers fresh, running them hourly if you want that, and setting the price that turns tokens into dollars.

## Where the numbers come from

- **Migration `20261108000009_metrics.sql`** adds a `network` column to `metrics_daily` and to `canary_attempts`, a table `metrics_runs`, and four functions, and replaces `canary_attempt_insert` so that it records the network:
  - `metrics_compute({ network, day? })` (service role only) replaces one UTC day of one network's rows with what the source tables say now, then writes the network's row in `metrics_runs`. Running it again for the same day is harmless, and two runs for the same network and day take a lock so they cannot interleave.
  - `metrics_runs` holds, per network, when it was last computed and the two counts of people (Canary participants, external owners). It is written at the end of every run, even a run that found nothing to count, so "Updated" and "is it stale" are about the last run.
  - `public_usage_metrics({ network, days? })` (public) reads `metrics_daily`, `metrics_runs` and the pilots back. It scans nothing else. The page calls it with the network of the address it was opened at (`docs/runbooks/web-deploy.md`, "Both networks in one project"), so testnet activity never reads as mainnet, and each network's page has its own cached numbers.
  - `metrics_backfill({ network?, from? })` (service role only) computes every day of the history. The migration calls it once at its end (see "The history").
  - `rate_limits_prune` (service role only) deletes the rate limiter's rows whose window began more than a day ago. No window the app uses is longer than a day, so nothing live is deleted; `src/lib/ratelimit.test.ts` holds every window to that.
- **A Canary attempt carries the network of the Canary vault it was made on**, so a mainnet Canary beside a testnet one keep separate numbers on `/usage`. The attempts that existed when the migration was applied were given the network of the Canary vault when every Canary vault was on the same network; otherwise they have none, and an attempt with no network counts for no network.
- **Payments and mandates** come from `vault_events`, which the watcher fills from the chain (`docs/ops/watcher.md`). They read 0 until the watcher runs. A vault's first watcher run records its whole history as observed at that moment, so on `/usage` that history lands on the day of the first run, and the totals are right.
- **Totals add up the days that were computed.** The migration computes the days of the history that exist when it is applied; after that, each day is computed as it happens.

## How they stay fresh

- **A daily run.** `apps/web/vercel.json` has one cron, `10 0 * * *` (00:10 UTC), that calls `GET /api/cron/metrics`. For every network the site serves, mainnet first, it computes yesterday, which is complete by then, and today; a network whose compute fails does not stop the other. Then it prunes the old rate-limit rows once. The answer is `{"ok":true,"networks":[{"network":"mainnet","results":[...]},{"network":"testnet","results":[...]}],"prune":{...}}`. A failed prune is logged as a warning and the answer says `"prune":{"ok":false}`; it does not undo the computes. Vercel sends `Authorization: Bearer <CRON_SECRET>` on its own when `CRON_SECRET` is set in the project, and the route answers 401 to anything else. A daily schedule is the most the Vercel Hobby plan accepts.
- **A refresh when someone looks.** When the network was last computed more than an hour ago (or never), the page computes today before it draws, with a 5 second limit. That read sits in the page's one-minute cache, so it runs at most about once a minute however many people look, and in practice about once an hour. If it fails, the page shows what is there.
- **A hand-run compute for a past day** marks the network as updated now, so the page skips its own refresh for up to an hour. After such a run, run today as well: `select public.metrics_compute(jsonb_build_object('network', 'mainnet', 'day', (now() at time zone 'utc')::date));`.
- **So the numbers** are at most about an hour old while the page is being viewed, and up to a day old when nobody looks. The page says when they were computed ("Updated 2026-11-06 10:15 UTC"), or "not computed yet" before the first run.

## Run it hourly instead

Pick one. Both are your choice and cost nothing in the code.

- **Vercel Pro.** In `apps/web/vercel.json` change the schedule to `5 * * * *` and redeploy. The Hobby plan rejects an hourly schedule at deploy time. The prune then runs hourly too, which is harmless.
- **Supabase Cron** (`pg_cron`), which needs no Vercel plan. In the dashboard, Integrations, Cron, turn it on, then run this in the SQL Editor, once per network the project holds (change `mainnet` for `testnet`). It is not a migration, because the migration test refuses `pg_cron`. It has not been run here: the local test database has no `pg_cron`.

  ```sql
  select cron.schedule('usage-metrics-mainnet-yesterday', '5 * * * *', $$
    select public.metrics_compute(jsonb_build_object('network', 'mainnet', 'day', (now() at time zone 'utc')::date - 1))
  $$);
  select cron.schedule('usage-metrics-mainnet-today', '6 * * * *', $$
    select public.metrics_compute(jsonb_build_object('network', 'mainnet', 'day', (now() at time zone 'utc')::date))
  $$);
  select cron.schedule('rate-limits-prune', '15 0 * * *', $$
    select public.rate_limits_prune('{}'::jsonb)
  $$);
  ```

  To stop one: `select cron.unschedule('usage-metrics-mainnet-today');`. Leave the daily Vercel cron in place as well, or remove it from `vercel.json`: both do the same work.

## The history

Applying the migration computes every day from the earliest record of each network (one of its tenants, a ledger entry of its tenants, or a Canary attempt made on it) up to today, for each network that has a tenant. On a new database it does nothing. To recompute, run this in the SQL Editor (it replaces each day's rows, so it is safe to repeat):

```sql
select public.metrics_backfill('{}'::jsonb);
```

To recompute one network, or start from a later day, name them: `select public.metrics_backfill('{"network": "mainnet", "from": "2026-11-01"}'::jsonb);`. It returns how many networks, days and runs it did.

## Check that it works

From your own terminal, with `CRON_SECRET` taken from your password manager (do not paste it into a shared place):

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<deployment-url>/api/cron/metrics          # 401
curl -s -H "Authorization: Bearer $CRON_SECRET" https://<deployment-url>/api/cron/metrics   # {"ok":true,...,"prune":{"ok":true,"deleted":0}}
```

Then in the SQL Editor: `select * from public.metrics_runs;` shows when each network was last computed, and `select day, network, segment, metric, value, computed_at from public.metrics_daily order by day desc, segment, metric limit 40;` shows the counts. An empty `metrics_daily` is right for a network where nothing has happened yet; its `metrics_runs` row still says it was computed.

## The price behind "USD per decision"

The page shows tokens per decision as measured, and a dollar figure only when a price is set. Edit `NEARAI_PRICE` in `apps/web/src/lib/usage/pricing.ts` with the input and output price per million tokens for the model the app really uses (`NEARAI_MODEL`), taken from NEAR AI Cloud's own price list, and write the date you read it in `source`:

```ts
export const NEARAI_PRICE: NearAiPrice | null = {
  model: "<the model id>",
  inputPerMTok: 0,   // US dollars per million input tokens, from the price list
  outputPerMTok: 0,  // US dollars per million output tokens, from the price list
  source: "price list read on <date>",
};
```

Use the numbers from the list, not these placeholders. While it stays `null` the page says "price not set yet". Gas per spend and hosting are shown as "not measured yet" and "not published yet" until there is something true to put there.
