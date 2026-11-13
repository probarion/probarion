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

- **A daily run.** `apps/web/vercel.json` has one cron, `10 0 * * *` (00:10 UTC), that calls `GET /api/cron/metrics`. For every network the site serves, mainnet first, it computes yesterday, which is complete by then, and today; a network whose compute fails does not stop the other. Then it prunes the old rate-limit rows once. The answer is `{"ok":true,"networks":[{"network":"mainnet","results":[...]},{"network":"testnet","results":[...]}],"prune":{...}}`. A failed prune is logged as a warning and the answer says `"prune":{"ok":false}`; it does not undo the computes. Vercel sends `Authorization: Bearer <CRON_SECRET>` on its own when `CRON_SECRET` is set in the project, and the route answers 401 to anything else. The schedule is daily by choice: Vercel Pro, which the project's team is on, also accepts an hourly or per-minute one ([run it hourly instead](#run-it-hourly-instead)).
- **A refresh when someone looks.** When the network was last computed more than an hour ago (or never), the page computes today before it draws, with a 5 second limit. That read sits in the page's one-minute cache, so it runs at most about once a minute however many people look, and in practice about once an hour. If it fails, the page shows what is there.
- **A hand-run compute for a past day** marks the network as updated now, so the page skips its own refresh for up to an hour. After such a run, run today as well: `select public.metrics_compute(jsonb_build_object('network', 'mainnet', 'day', (now() at time zone 'utc')::date));`.
- **So the numbers** are at most about an hour old while the page is being viewed, and up to a day old when nobody looks. The page says when they were computed ("Updated 2026-11-06 10:15 UTC"), or "not computed yet" before the first run.

## Run it hourly instead

Pick one. Both are your choice and cost nothing in the code.

- **The Vercel cron.** The project's team is on Vercel Pro, which accepts an hourly schedule. In `apps/web/vercel.json` change the schedule to `5 * * * *`, change the same line in `apps/web/test/deploy.test.ts` (it pins both cron schedules), and redeploy. The prune then runs hourly too, which is harmless. A project on the Hobby plan cannot do this: Hobby rejects an hourly schedule at deploy time.
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

## Where people come from, and how far owners get

OWNER only, by hand in the SQL Editor. None of this is on `/usage`. Each query is for one network: change `mainnet` for `testnet`. Quote only what a query returns, and only with the day you ran it. `test/db/metrics-queries.test.ts` runs these exact blocks on the real schema, so keep the `<!-- query: ... -->` line above each one.

### Canary attempts by source

A link of ours names where it was posted: `https://probarion.xyz/canary?via=x`. The form sends that word with the attempt, and migration `20261108000014_canary_via.sql` stores it in `canary_attempts.via`. The set is closed and lives in `apps/web/src/lib/canary/via.ts`:

| `via` | Where the link is |
| --- | --- |
| `x` | a post on X (@probarionhq). Every post that links the Canary uses `?via=x` |
| `readme` | the Canary row of the repository's README |
| `usage` | the Canary pill on `/usage` |
| `tg` | a link the team sends by hand on Telegram (`https://probarion.xyz/canary?via=tg`) |
| `home` | the landing page (not linked with it yet) |
| `tamper` | the "break a signed record" demo (not linked with it yet) |
| `proof` | a proof page (not linked with it yet) |
| `ext` | the browser extension (not linked with it yet) |
| `share` | a shared result of an attempt (no such link yet) |

Any other value, and a visit by the site's own menu, is stored as no source, shown as `(none)`. Attempts made before the migration have none too. The Canary's Rules link and the way back from the rules keep the source. A source is counted only when the visitor sends an attempt: opening the page records nothing. The team's own attempts are left out, as on the leaderboard. `browsers` counts distinct visitor cookies, so one person on two browsers counts twice. The source is whatever word the browser sent, so anyone can send any word of the set: read the numbers as where people say they came from, not as proof.

<!-- query: canary-by-source -->
```sql
select coalesce(via, '(none)') as via,
       count(*)::int as attempts,
       count(distinct visitor_hash)::int as browsers
from public.canary_attempts
where network = 'mainnet' and not is_team
group by 1
order by attempts desc, via;
```

### Outside owners, stage by stage

For vaults of outside owners (`tenants.kind = 'external'`). Each column counts the vaults that reached that stage and every stage before it:

- `vaults`: vaults created.
- `with_agent_key`: an agent key was active at some point (a key revoked since still counts).
- `with_mandate`: and the watcher saw a mandate created.
- `first_payment`: and the watcher saw a payment made, to NEAR or to Base.
- `first_payment_7_days_ago`: those whose first payment is at least 7 days old, the vaults old enough for the next column.
- `active_7_days_later`: of those, the ones with a spend or mandate event recorded 7 days or more after their first payment. Anchors, low-balance alerts and a hold that expired do not count: they happen without the owner or the agent doing anything.

The last four read `vault_events`, which the watcher fills (`docs/ops/watcher.md`). It records a vault's history when it first reads the vault, so `observed_at` is when the watcher saw an event, not when it happened on chain, and a long history can take several runs. Those catch-up events are marked `initial` and do not count as staying: only events seen after the watcher caught up do.

<!-- query: owner-funnel -->
```sql
with v as (
  select t.id,
         exists (select 1 from public.agent_keys k
                 where k.tenant_id = t.id and k.purpose = 'agent' and k.activated_at is not null) as has_key,
         exists (select 1 from public.vault_events e
                 where e.tenant_id = t.id and e.kind = 'mandate_created') as has_mandate,
         (select min(e.observed_at) from public.vault_events e
          where e.tenant_id = t.id and e.kind in ('spend_paid', 'spend_burned')) as first_paid
  from public.tenants t
  where t.kind = 'external' and t.network = 'mainnet'
), f as (
  select v.*,
         has_key and has_mandate and first_paid is not null as paid,
         exists (select 1 from public.vault_events e
                 where e.tenant_id = v.id and e.observed_at >= v.first_paid + interval '7 days' and not e.initial
                   and e.kind in ('mandate_created', 'spend_held', 'spend_pending', 'spend_paid', 'spend_burned',
                                  'spend_failed', 'spend_rejected', 'refused_by_contract')) as stayed
  from v
)
select count(*)::int as vaults,
       count(*) filter (where has_key)::int as with_agent_key,
       count(*) filter (where has_key and has_mandate)::int as with_mandate,
       count(*) filter (where paid)::int as first_payment,
       count(*) filter (where paid and first_paid <= now() - interval '7 days')::int as first_payment_7_days_ago,
       count(*) filter (where paid and first_paid <= now() - interval '7 days' and stayed)::int as active_7_days_later
from f;
```

### First payments by week

The number to watch: outside vaults whose agent made its first payment, by the week (from Monday, UTC) the watcher saw it. It counts every outside vault with a payment, so its total can be above the funnel's `first_payment` when the console holds no agent key of that vault (one added with the CLI) or the watcher saw no mandate. A vault whose history the watcher read late is counted in the week it read it.

<!-- query: first-payments-by-week -->
```sql
select date_trunc('week', first_paid at time zone 'utc')::date as week, count(*)::int as vaults
from (
  select e.tenant_id, min(e.observed_at) as first_paid
  from public.vault_events e
  join public.tenants t on t.id = e.tenant_id
  where t.kind = 'external' and t.network = 'mainnet' and e.kind in ('spend_paid', 'spend_burned')
  group by e.tenant_id
) p
group by 1
order by 1;
```

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
