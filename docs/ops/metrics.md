# The usage numbers (`/usage`)

OWNER only. The public page `/usage` shows counts of vaults, payments, refusals and model decisions, with team vaults, external owners and Canary participants kept in separate columns. This page is about keeping those numbers fresh, running them hourly if you want that, and setting the price that turns tokens into dollars.

## Where the numbers come from

- **Migration `20261108000009_metrics.sql`** adds a `network` column to `metrics_daily` and two functions:
  - `metrics_compute({ network, day? })` (service role only) replaces one UTC day of one network's rows with what the source tables say now. Running it again for the same day is harmless, and two runs for the same network and day take a lock so they cannot interleave.
  - `public_usage_metrics({ network, days? })` (public) reads those rows back, with the counts of people and the pilots. The page calls it with the network the app runs on (`NEAR_NETWORK`), so testnet activity never reads as mainnet.
- **Payments and mandates** come from `vault_events`, which the watcher fills from the chain. They read 0 until the watcher runs.
- **Totals add up the days that were computed.** A day before the first run is not in the table unless you backfill it (see below).

## How they stay fresh

- **A daily run.** `apps/web/vercel.json` has one cron, `10 0 * * *` (00:10 UTC), that calls `GET /api/cron/metrics`. It computes yesterday, which is complete by then, and today. Vercel sends `Authorization: Bearer <CRON_SECRET>` on its own when `CRON_SECRET` is set in the project, and the route answers 401 to anything else. A daily schedule is the most the Vercel Hobby plan accepts.
- **A refresh when someone looks.** When the newest row of the network is over an hour old (or there is none), the page computes today before it draws, with a 5 second limit. That read sits in the page's one-minute cache, so it runs at most about once a minute however many people look, and in practice about once an hour. If it fails, the page shows what is there.
- **So the numbers** are at most about an hour old while the page is being viewed, and up to a day old when nobody looks. The page says when they were computed ("Updated 2026-11-06 10:15 UTC").

## Run it hourly instead

Pick one. Both are your choice and cost nothing in the code.

- **Vercel Pro.** In `apps/web/vercel.json` change the schedule to `5 * * * *` and redeploy. The Hobby plan rejects an hourly schedule at deploy time.
- **Supabase Cron** (`pg_cron`), which needs no Vercel plan. In the dashboard, Integrations, Cron, turn it on, then run this in the SQL Editor, once per network the project holds (change `mainnet` for `testnet`). It is not a migration, because the migration test refuses `pg_cron`. It has not been run here: the local test database has no `pg_cron`.

  ```sql
  select cron.schedule('usage-metrics-mainnet-yesterday', '5 * * * *', $$
    select public.metrics_compute(jsonb_build_object('network', 'mainnet', 'day', (now() at time zone 'utc')::date - 1))
  $$);
  select cron.schedule('usage-metrics-mainnet-today', '6 * * * *', $$
    select public.metrics_compute(jsonb_build_object('network', 'mainnet', 'day', (now() at time zone 'utc')::date))
  $$);
  ```

  To stop one: `select cron.unschedule('usage-metrics-mainnet-today');`. Leave the daily Vercel cron in place as well, or remove it from `vercel.json`: both do the same work.

## Backfill the days before the first run

Run once, in the SQL Editor, after the migration. Change the first date to the day anything first happened on that network:

```sql
select public.metrics_compute(jsonb_build_object('network', 'mainnet', 'day', d::date))
  from generate_series('2026-11-01'::date, (now() at time zone 'utc')::date, interval '1 day') as d;
```

## Check that it works

From your own terminal, with `CRON_SECRET` taken from your password manager (do not paste it into a shared place):

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<deployment-url>/api/cron/metrics          # 401
curl -s -H "Authorization: Bearer $CRON_SECRET" https://<deployment-url>/api/cron/metrics   # {"ok":true,...}
```

Then in the SQL Editor: `select day, network, segment, metric, value, computed_at from public.metrics_daily order by day desc, segment, metric limit 40;`. An empty table is right for a network where nothing has happened yet.

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
