# The watcher (`/api/cron/watch`)

OWNER only. The watcher reads every vault on the chain, and its ledger, and writes what it sees into the table `vault_events`, one row per event. The public page `/usage` counts those rows (payments, mandates, held payments, refusals by the contract), and the alerts (`docs/ops/alerts.md`) send them. This page says what it records, when it runs, how to turn on the per-minute schedule, and how to check it.

## What it records

One row per event, keyed by `(tenant, event_key)`. A key that already exists is never written again or changed, so reading the same chain twice adds nothing.

| Kind | Event key | When |
| --- | --- | --- |
| `spend_held`, `spend_pending`, `spend_paid`, `spend_burned`, `spend_failed`, `spend_rejected`, `spend_expired` | `spend:<id>:<status>` | A spend is seen with that status. One spend can give several rows (held, then paid). |
| `mandate_created` | `mandate:<id>` | A mandate is seen. |
| `anchor` | `anchor:<seq>` | An anchor of the ledger is seen. |
| `refused_by_contract` | `refused:<ledger seq>` | A payment entry of the ledger whose contract answered `refused` and that has a transaction hash. An outcome that is `unknown` or `failed` also has a code and a hash and is not a refusal, and a spend a dry run stopped has no hash. `/usage` counts refusals by the same rule. |
| `allowance_low` | `allowance_low:<public key>:<UTC date>` | An active agent or ledger key of the vault has under 0.2 NEAR of allowance left. At most once per key per UTC day. A key the chain does not show, or one with an unlimited allowance, gives none. |
| `near_low` | `near_low:<UTC date>` | The vault's free NEAR (balance minus the storage stake) is under 0.05 NEAR. At most once per UTC day. |

The ids in a key are the contract's own ids, which start at 1. The watcher's cursors are 0-based positions in the contract's lists (`from_index`), so a cursor of 0 means "from the first".

The row for a spend also keeps the destination, the `ref`, the hold's end and the memo. The `ref` and the memo are text the payee or the agent chose, and whatever renders them must treat them as untrusted. The alerts never print them.

## When it runs

- **Right after a request the app drives itself**: a Payables invoice upload and a Canary attempt each ask the watcher to look at their own vault as soon as the response is sent. The owner's alerts for those events can leave within seconds.
- **Every minute, once you turn on the Supabase schedule below.** Until then this does not happen.
- **Otherwise once a day.** `apps/web/vercel.json` has the cron `0 0 * * *` (00:00 UTC), because the Vercel Hobby plan accepts nothing more frequent: it rejects a per-minute or hourly schedule when it deploys. A change on the chain that nobody drove through the app (an owner approving a held payment in the wallet, a spend an agent sent through the SDK) is therefore recorded at the next run that reaches its vault: within a minute with the Supabase schedule, within a day without it. That holds while every vault fits in one run (see below): a run starts no new vault 40 seconds in, and the vaults it left wait for the next run, which without the Supabase schedule is the next day.

## What one run does

- It lists the tenants of the network the app runs on (`NEAR_NETWORK`), the ones looked at longest ago first, and watches them one after another. Each tenant is watched under a 50 second lease, so two runs do not normally work on one vault together. A run that outlives its lease can overlap one that starts after it; that is safe, because every event has a key that is written once and a cursor written by the slower run can only move back, never past rows it did not read.
- It reads the tenant's row again (a request the app drives, or you, may have moved its cursors since the run listed them), marks the tenant as looked at before any chain read, and reads each vault's spends, anchors and mandates from the tenant's cursor, 100 at a time and at most 10 pages of each kind per run, and the ledger 500 entries per run. A vault with more than that catches up over the next runs.
- It writes the events, then moves the cursors. If a run dies in between, the next one reads the same rows again and writes nothing twice. A spend that is `pending`, or `held` and still inside its window, keeps the spend cursor where it is, so it is read again until it settles; see "Limits" for a hold that was never decided.
- A vault's first run records that vault's whole history, as observed at that moment. On `/usage` the history therefore lands on the day of the first run, and the totals are right. The alerts do not send that history: an event recorded before the vault's first run has finished (its cursors written) is flagged `initial`, and only a low key, a low vault and a hold that is still open are sent from it (`docs/ops/alerts.md`).
- A tenant whose run fails is logged (`watch.tenant_failed`) and does not stop the others. Its cursors do not move. It was marked as looked at when it was started, so it goes to the back of the queue and cannot use up every run, even if a run is killed while it hangs.
- It starts no new tenant 40 seconds into the run. The answer says how many it left (`skipped`), and they go first next time.
- A check that cannot be read (a key's allowance, the vault's balance) is logged as `watch.check_failed` (one line per failed key, with the key's public key and no event data), counted in `checkErrors`, and the vault's spends, anchors, mandates and refusals are still recorded. The check is tried again next run. `checkErrors` is not part of the run's health, so watch it: a number that stays above 0 on every run means the allowance and low-NEAR alerts are not working. The events for those two checks are written in calls of their own, so a failed batch of spends does not hide a low-NEAR alert, and the other way round.
- The Better Stack heartbeat (`BETTERSTACK_HEARTBEAT_URL`, optional) is sent after a healthy run: no tenant at all, or at least one tenant that was tried and did not fail. Set its expected period in Better Stack to the schedule you use. A run where every tenant that was tried failed answers 503 and sends no heartbeat.
- The log and the answer carry counts (`tenants`, `inserted`, `errors`, `skipped`, `checkErrors`, and the alert counts under `alerts`, see `docs/ops/alerts.md`) and nothing else: no event data, and not the heartbeat address, which holds a token.

## Turn on the per-minute schedule (once)

Use Supabase Cron (`pg_cron`) with `pg_net`: it needs no Vercel plan. It is not a migration, because the migration test refuses `pg_cron` and `pg_net`. **It has not been run here:** the local test database has neither extension, so these statements are unchecked until you run them.

1. In the Supabase dashboard turn on Integrations, Cron (`pg_cron`) and Database, Extensions, `pg_net`.
2. Keep the cron secret in Supabase Vault, under the name `cron_secret`, with the same value as `CRON_SECRET` in the Vercel project. Use your own value, taken from your password manager; do not paste it anywhere shared. In the SQL Editor:

   ```sql
   select vault.create_secret('<the value of CRON_SECRET>', 'cron_secret', 'Bearer for /api/cron/watch');
   ```

3. Schedule the call, in the SQL Editor. Use the address of your deployment if it is not `probarion.xyz`. A Supabase project that holds both networks needs one job per deployment, because each deployment watches only its own network.

   ```sql
   select cron.schedule('probarion-watch', '* * * * *', $$
     select net.http_get(
       url := 'https://probarion.xyz/api/cron/watch',
       headers := jsonb_build_object(
         'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
       ),
       timeout_milliseconds := 55000
     );
   $$);
   ```

4. After a minute or two, check it (see below).

To stop it: `select cron.unschedule('probarion-watch');`. The daily Vercel cron stays and keeps recording.

**Vercel Hobby usage.** A call a minute is about 43,200 function calls a month, most of each spent waiting on RPC answers. If the Vercel dashboard shows the usage quota tightening, make the job `*/5 * * * *` (re-run `cron.schedule` with the same name, which replaces it): alerts for chain-only changes are then up to five minutes late.

## Check that it works

From your own terminal, with `CRON_SECRET` taken from your password manager (do not paste it into a shared place):

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<deployment-url>/api/cron/watch          # 401
curl -s -H "Authorization: Bearer $CRON_SECRET" https://<deployment-url>/api/cron/watch   # {"ok":true,"network":"mainnet","watch":{"tenants":...,"inserted":...,"errors":0,"skipped":0,"checkErrors":0},"alerts":{"sent":0,"failed":0,"skipped":0,"deferred":0,"error":false},"heartbeat":false}
```

Then in the SQL Editor:

```sql
select vault_id, watch_spend_from, watch_mandate_from, watch_anchor_from, watch_ledger_seq, watch_last_at from public.tenants order by watch_last_at nulls first;
select id, tenant_id, event_key, kind, observed_at from public.vault_events order by id desc limit 20;
```

With the Supabase schedule on, `select * from cron.job_run_details order by start_time desc limit 5;` shows the job running, and `select id, status_code, timed_out, error_msg, created from net._http_response order by created desc limit 5;` shows what the route answered (200, or 503 when every tenant failed).

## Read a vault again

The cursors only say where the next run starts. To read a vault's history again (after fixing a bug, say), set its cursors to 0. Nothing is written twice, because the keys exist:

```sql
update public.tenants set watch_spend_from = 0, watch_mandate_from = 0, watch_anchor_from = 0, watch_ledger_seq = 0 where vault_id = '<the vault>';
```

## Limits

- **A hold that nobody decides.** A held spend leaves `held` only when an approver approves or rejects it, or when someone calls `expire_held`, and nothing in the app calls `expire_held`: a hold left alone stays `held` on the chain for good. Once a hold's window (`held_until_ns`) has passed, `approve` fails with `HoldExpired`, so no payment can follow it; it can only still become `rejected` or `expired`. So the spend cursor passes a hold whose window ended more than 10 minutes ago (the margin covers clock skew and an approve already in flight). **What is not recorded:** a later `spend_rejected` or `spend_expired` for such a hold; its `spend_held` row is the last one the watcher has. No event is made for a state the chain has not reached. **The bound:** a hold pins the cursor at most for the vault's hold time (`held_ttl_ns`, 3 days by default) plus 10 minutes. A `pending` spend always pins the cursor; it settles within a few blocks of its callback.
- **While a spend pins the cursor,** a run reads at most 1,000 spends from its position. In a vault with more than 1,000 spends after a hold that is still inside its window, the later ones are recorded once the hold's window has passed (at most the hold time and 10 minutes), or sooner if an approver decides it.
- The first run on a vault with a long history takes several runs to catch up: 1,000 rows of each kind and 500 ledger entries per run.
