# Incident runbook

What to do when something goes wrong with the hosted service, with a vault Probarion runs, or with an
owner's vault when Probarion is the cause. **Unaudited beta.**

- **Scope.** One Vercel project, one deployment and one Supabase database serve both NEAR networks. The
  address a request is opened at decides its network
  ([both networks in one project](runbooks/web-deploy.md#35-both-networks-in-one-project)). Only testnet
  is live today: the mainnet factory is not deployed (`contracts/deployments/mainnet.json`), so no mainnet
  vault exists yet. The vaults Probarion runs are, per network, the team vaults (`TEAM_VAULT_IDS_<NET>`),
  the demo vault of `/proof` (`PROBARION_VAULT_ID_<NET>`) and the Canary (`CANARY_VAULT_ID_<NET>`), plus
  the test deployments in `contracts/deployments/testnet.json`.
- **On call:** the OWNER. Claude investigates, drafts posts and messages, and prepares commands. It never
  signs a transaction, deploys, changes a setting or sends a message.
- **OWNER SIGNS** marks every transaction here that changes a vault. The vault's owner signs it, in a
  wallet prompt from the console or with near-cli-rs. For the vaults Probarion runs, that owner is the
  OWNER.
- **Security reports** go through [SECURITY.md](../SECURITY.md#reporting-a-vulnerability), never a
  public issue.
- **Status.** The in-app `/status` page of each address shows that network's live checks. Incident
  posts go on X from [@probarionhq](https://x.com/probarionhq), by the OWNER, until a third-party status
  page exists ([status page](ops/MONITORING.md#status-page)).

## Severity levels

| Level | Meaning | Examples | Respond within | Status post | Owners told | Postmortem |
|---|---|---|---|---|---|---|
| SEV1 | Funds at risk, or moved outside a mandate | A payment to an account no mandate names; a contract bug that gets past a cap; an owner's or the factory owner's full-access key leaked | 15 min | Major outage | Every owner, at once | Public, within 72 h |
| SEV2 | Payments blocked or delayed, or a bounded key leaked | App down for more than 15 min; every RPC provider of a network down; a spend "burned, awaiting bridge" for more than 2 h; owner alerts not delivered on the schedule in use; an agent or ledger key leaked | 1 h | Partial outage | The owners affected | Public, within 7 days |
| SEV3 | Degraded, with a workaround | One RPC provider down while another answers; NEAR AI Cloud down (rules-only fallback); "burned, awaiting bridge" for more than 30 min; Canary abuse | 4 h | Degraded | No | Internal note; public if an owner asks |
| SEV4 | Cosmetic or documentation | Wrong text on a page; a broken docs link; an agent key's allowance nearly used up | Next working day | No | No | No |

- When unsure, pick the higher level. The first postmortem is published even if the incident is small.
- **Testnet.** Only test tokens move on testnet, so an incident that touches testnet alone is at most
  SEV2. One exception: a way past what the vault contract enforces is SEV1 on either network, because
  both networks run the same vault contract (`contracts/vault`).
- **One RPC on testnet.** Testnet's built-in RPC list has one provider (`packages/core/src/constants.ts`),
  so on testnet one provider down is every provider down, unless `NEAR_RPC_URLS_TESTNET` adds a second.
  Mainnet has two built in.
- **Late alerts.** Judge "owner alerts not delivered" against the schedule in use: the watcher runs once
  a day unless the OWNER turned on the per-minute job ([watcher and owner alerts](#watcher-and-owner-alerts)).

## First 15 minutes

1. Open an incident note in a private place (not this repository), named `<UTC date>-<slug>`, and start
   a UTC timeline.
2. Decide the severity with the table above.
3. SEV1: go to the [freeze procedure](#freeze-procedure) now, before you investigate.
4. SEV1 to SEV3: post "Investigating" ([templates](#status-page-posts)).
5. Collect evidence: the vault ids and their network, spend ids, transaction hashes, Sentry issue links
   and request ids. The proxy gives every request an `x-request-id` and returns it in the response; the
   log lines and the ledger entries carry it, and so do the Sentry events
   ([Sentry tags](ops/MONITORING.md#tags)).
6. Snapshot each affected vault, so that later work does not depend on RPC history. From a clone of the
   repository, after `pnpm install` and `pnpm --filter "{packages/cli}..." build`:

   ```bash
   node packages/cli/dist/bin.js verify --network <mainnet|testnet> --vault <vault> --snapshot incident-<vault>-<UTC>.json
   ```

   For a hosted vault, download its ledger first from `/proof/<vault>/ledger.jsonl` on the address of its
   network (a member of the vault can, and anyone when its proof page is public), and add
   `--ledger <that file>`. Without a ledger, `verify` checks the chain against an empty ledger.

## If something looks wrong

For vault owners. If a payment you did not expect, an alert you do not understand or a console that acts
strangely worries you, you can stop your vault yourself, at once, without Probarion.

1. **Freeze it.** Open your vault in the console and press "Freeze vault". Freezing takes no deposit, so
   any key of your owner account can sign it. From then on every spend and every approval is refused with
   `PROBARION:Frozen`; your funds, mandates and ledger stay where they are. If the console is down, print
   the same transaction with the CLI and sign it with near-cli-rs ([freeze procedure](#freeze-procedure)).
2. **Move funds out, if you want to.** The vault's page has "Withdraw all ... to my wallet" for the USDC
   on NEAR, and "Withdraw all ... Base USDC out of Intents to my account" when the vault holds some. Each
   needs your full-access key (1 yoctoNEAR, a wallet prompt), and the money goes only to your own owner
   account.
3. **Tell us.** Send a direct message to [@probarionhq](https://x.com/probarionhq) on X with the vault and
   what you saw. If you think you found a vulnerability, follow [SECURITY.md](../SECURITY.md) instead and
   keep the details out of public posts.
4. **Unfreeze only when you are sure.** Unfreezing needs your full-access key (1 yoctoNEAR).

## Freeze procedure

Freezing makes `spend` and `approve` fail with `PROBARION:Frozen`. Mandates, balances and the ledger are
untouched. Only the vault's owner account can freeze or unfreeze, and the two differ on purpose
(`contracts/vault/src/admin.rs`): `freeze` takes no deposit, so any key of the owner account, a
function-call key included, can stop everything at once; `unfreeze` takes exactly 1 yoctoNEAR, so only
the owner's full-access key, through a wallet prompt, can start payments again.

The CLI prints every command below and signs nothing: it writes the arguments to a file, then prints the
near-cli-rs command and the file's sha256 for the owner to check and sign. Set it up once, from a clone of
the repository: `pnpm install`, then `pnpm --filter "{packages/cli}..." build`. The examples are for
mainnet. For a testnet vault, replace `mainnet` with `testnet` in the CLI command; the command it prints
then says `network-config testnet`. With a Ledger device, replace `sign-with-keychain send` with
`sign-with-ledger usb send` (the CLI says so too).

### Vaults Probarion runs

In the console, the vault's page has "Freeze vault" (its "Emergency stop" card shows the button even when
the vault's state cannot be read). Or print it:

**OWNER SIGNS**

```bash
node packages/cli/dist/bin.js vault freeze --network mainnet --vault <vault> --sign-as <owner account>
```

It prints a command of this shape (the arguments file holds `{}`):

**OWNER SIGNS**

```bash
near contract call-function as-transaction <vault> freeze file-args ./freeze.ca3d163bab05.args.json prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as <owner account> network-config mainnet sign-with-keychain send
```

Check that it worked (a view call, nothing to sign); the answer has `"frozen": true`:

```bash
near contract call-function as-read-only <vault> get_config json-args '{}' network-config mainnet now
```

Record a freeze in the evidence file (an id is lower-case letters, digits and underscores):
`pnpm proof add-tx --id freeze_<vault short name>_<yyyymmdd> --hash <hash> --signer <owner account> --receiver <vault> --kind freeze --signed-by owner --what "Incident freeze of <vault>"`.
For a testnet freeze add `--network testnet` (the default is `mainnet`).

### Owners' vaults

Probarion cannot freeze a vault it does not own; that is the point of the design. The OWNER tells each
affected owner directly, with the message below, on the channels the owner set up for alerts. There is no
broadcast tool and no console banner. The confirmed alert targets are rows of `public.alert_subscriptions`
with `verified_at` set and `active` true. They are personal data, so the OWNER reads them in the SQL
editor for an incident only.

```text
Probarion incident <id>, <UTC time>: <one sentence>. As a precaution, freeze your vault now:
1. Open <the address of your vault's network>/console/<your vault> and press "Freeze vault", or
2. With near-cli-rs and your owner key, call freeze on <your vault> as its owner, with no deposit.
Freezing stops every agent payment; your funds and mandates stay where they are.
Updates: https://x.com/probarionhq
```

### Moving funds out

Owner only, with the full-access key. Each call attaches exactly 1 yoctoNEAR; without it the vault
refuses with `PROBARION:RequiresOneYocto`. The money goes to the vault's owner account and nowhere else.
In the console: "Withdraw all ... to my wallet" (USDC on NEAR) and "Withdraw all ... Base USDC out of
Intents to my account". The vault's page shows both balances. Or print them (`--amount` is in USDC):

**OWNER SIGNS**

```bash
node packages/cli/dist/bin.js vault withdraw --network mainnet --vault <vault> --amount <usdc> --sign-as <owner account>
node packages/cli/dist/bin.js vault withdraw-intents --network mainnet --vault <vault> --token base --amount <usdc> --sign-as <owner account>
```

They print `withdraw` (100 Tgas) and `withdraw_intents` (150 Tgas), each with `attached-deposit '1
yoctoNEAR'`. `--token base` picks the network's own Base USDC asset. On testnet the token is
`usdc.probarion.testnet`, and `intents-stub.probarion.testnet` stands in for `intents.near`
(`packages/core/src/constants.ts`). The mainnet balances, read without signing:

```bash
near contract call-function as-read-only 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 ft_balance_of json-args '{"account_id":"<vault>"}' network-config mainnet now
near contract call-function as-read-only intents.near mt_balance_of json-args '{"account_id":"<vault>","token_id":"nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"}' network-config mainnet now
```

### Unfreezing

Unfreeze only when the cause is understood and fixed, the affected agent keys are replaced, and
`node packages/cli/dist/bin.js verify --network <mainnet|testnet> --vault <vault>` passes (for a hosted vault, add
`--ledger <file>`, its ledger downloaded from `/proof/<vault>/ledger.jsonl`, as in step 6 of
[first 15 minutes](#first-15-minutes); without it `verify` checks the chain against an empty ledger). In the console
the same button then reads "Unfreeze vault". Or print it:

**OWNER SIGNS**

```bash
node packages/cli/dist/bin.js vault unfreeze --network mainnet --vault <vault> --sign-as <owner account>
```

It prints:

**OWNER SIGNS**

```bash
near contract call-function as-transaction <vault> unfreeze file-args ./unfreeze.ca3d163bab05.args.json prepaid-gas '30.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as <owner account> network-config mainnet sign-with-keychain send
```

Then post "Resolved".

## Key rotation

| Key or secret | Where it lives | Rotate when | How |
|---|---|---|---|
| Agent key (a function-call key that can call `spend` only) | Hosted vault: sealed in the database. SDK or CLI: the operator's `PROBARION_AGENT_KEY` | Suspected leak, allowance nearly used up | Hosted: on the Keys page, "Generate agent key and add it in my wallet" (1 yoctoNEAR); create new mandates for the new key, because every mandate is bound to one agent key; then "Remove" the old key and revoke its mandates ([rotation runbook](ops/key-rotation.md#steps), step 7). SDK: `node packages/cli/dist/bin.js agent keygen --out <file>`; `agent add --pk <new pk>` (1 yoctoNEAR); for each mandate of the old key, a new one bound to the new key (`mandate create ... --agent-pk <new pk>`, with its storage deposit); then `mandate revoke --mandate <id>` for each old mandate and `agent remove --pk <old pk>` (1 yoctoNEAR each). Each call is printed for **OWNER SIGNS**; until the new mandates exist, the agent cannot pay. |
| Ledger key (a function-call key that can call `anchor` only) | Hosted vault: sealed in the database. SDK or CLI: `PROBARION_LEDGER_KEY` | Suspected leak, allowance nearly used up | Anchor first: entries after the last anchor must be signed by the new key. Hosted: "Generate ledger key and set it in my wallet" on the Keys page. SDK: `node packages/cli/dist/bin.js ledger set-key --pk <new pk> --allowance <near>` (default 0.25 NEAR), **OWNER SIGNS** with 1 yoctoNEAR, then set `PROBARION_LEDGER_KEY` and restart. The vault deletes the previous ledger key. Each anchor records its ledger key, so entries signed before the rotation keep verifying. |
| `KEY_ENCRYPTION_SECRET` (the master key that seals agent keys, the ledger key and retained invoices) | Vercel, Production (and a Preview that shares the database) | Suspected leak, or someone who knew it leaves | Follow the [rotation runbook](ops/key-rotation.md): `pnpm --filter @probarion/web rotate-keys` as a dry run, then `--apply`, then switch the variable in Vercel and redeploy. Side effects: everyone is signed out; extension connections stay (their tokens are a sha256, not sealed under the master): end them as in the Extension tokens row when the incident calls for it; the Telegram webhook secret changes, so re-run `pnpm --filter @probarion/web telegram-webhook`; the stop links in earlier alert emails stop working; Canary visitor limits start over. The invoice-number key changes (it is derived from `KEY_ENCRYPTION_SECRET`, `apps/web/src/lib/payables/pipeline.ts:111-112,126`), so a re-uploaded invoice is no longer matched by its number to invoices uploaded before the rotation; the text fingerprint (an unkeyed sha256, `pipeline.ts:263`) still catches identical text. If the master leaked, also replace every agent and ledger key (step 7 of the rotation runbook). |
| Extension tokens (`pbx_…`, one per connected browser) | The browser's extension storage; the database keeps only a sha256 (`public.extension_tokens`) | Browser lost or shared, or a token suspected leaked | The owner presses Revoke on the Browser extension page (`/extension`) of that network's address. Every token at once (OWNER, SQL editor): `update public.extension_tokens set revoked_at = now() where revoked_at is null;` then `delete from public.extension_pair_codes;`. A new `KEY_ENCRYPTION_SECRET` does not end them. |
| `TELEGRAM_BOT_TOKEN` | Vercel | Leak | @BotFather `/revoke`, the new token in Vercel (Sensitive), redeploy, then re-run `pnpm --filter @probarion/web telegram-webhook` ([alerts](ops/alerts.md#telegram-owner)). |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel, server only | Leak | The project uses Supabase's `sb_secret_...` keys, not the legacy JWT keys. Replace the secret key in the dashboard's API keys settings (check its steps on first use), set the new value in Vercel and redeploy. |
| `CRON_SECRET` | Vercel; also the Supabase Vault entry `cron_secret` when the per-minute job is on | Leak | A new value (`openssl rand -hex 32`; at least 32 characters) in Vercel, and in `cron_secret` only if the per-minute job exists ([watcher](ops/watcher.md#turn-on-the-per-minute-schedule-once)). Redeploy. |
| `BETTERSTACK_HEARTBEAT_URL` | Vercel | Leak (its path carries a token) | A new heartbeat URL in Better Stack, set in Vercel (Sensitive), redeploy. |
| `NEARAI_API_KEY` | Vercel | Leak, or spend cap reached | NEAR AI Cloud dashboard: a new key with a spend cap, set in Vercel, redeploy, then delete the old key. |
| `ONECLICK_JWT` | Vercel (one key for the project, mainnet only) | Leak | 1Click's partner portal: a new JWT, set in Vercel, redeploy, then revoke the old one. |
| `RESEND_API_KEY` | Vercel | Leak | Resend dashboard: a new key, set in Vercel, redeploy, then delete the old one. |
| RPC URLs that carry a key (`NEAR_RPC_URLS_<NET>`, `NEAR_ARCHIVAL_RPC_URLS_<NET>`, `BASE_RPC_URL`) | Vercel (Sensitive when they carry a key) | Leak | A new key from the provider, the new URLs in Vercel, redeploy. |
| `NPM_TOKEN` | Environment secret of the `npm-release` environment (GitHub Settings > Environments), used by the release workflow | Leak | Revoke it in npm's account settings, create one with the same scope, and store it as the environment secret of `npm-release`, not as a repository secret: the environment admits only `sdk-v*` tags and waits for a reviewer (`.github/workflows/release.yml`). |
| The factory owner and the team's owner accounts | The OWNER's wallet or hardware wallet | Device lost, or suspected leak | **OWNER SIGNS** adding a new full-access key from a new device, then deleting the old one. The factory owner can publish vault versions but cannot change a vault the factory created. The testnet factory owner is `probarion-owner.testnet` (`contracts/deployments/testnet.json`). |

After any rotation, check that no old value is left in Vercel. CI's gitleaks job scans the repository on
every push and pull request to `main` and `dev`.

## RPC failover

Each network has its own RPC list, in failover order: `NEAR_RPC_URLS_MAINNET` and `NEAR_RPC_URLS_TESTNET`.
The unsuffixed `NEAR_RPC_URLS` applies to the default network only, and the console refuses it while both
networks are served. Unset, a network uses its built-in list: FastNEAR then intea on mainnet, FastNEAR
alone on testnet (`packages/core/src/constants.ts`). The SDK client moves to the next URL on a timeout, a
network error, a 429, a 5xx or a refusal.

1. Find the failing provider. On the address of the network you are checking:

   ```bash
   curl -s "https://<address>/api/health/rpc?provider=<n>"
   ```

   Provider n is entry n+1 of the variable, and `providers` in the answer says how many entries there are.
   200 means the right chain and a block at most 120 s old; a 503 names the problem in `detail`, one of a
   fixed set such as `wrong chain`, `stale: block <h>, <s> s behind`, `timeout after 5000 ms` or
   `HTTP <code>` ([health routes](ops/MONITORING.md#health-routes)). The answer is cached for 30 s.
   `/status` on that address shows every provider at once.
2. One provider down while another answers (SEV3): nothing to do, the readers fail over. Post "Degraded"
   if it lasts more than 30 minutes. A dead URL still costs time: sign-in and Register ask again, each time,
   every URL that has not yet answered with its chain (up to about 10 s). Remove a URL that is gone for good.
3. Every provider of a network down (SEV2; on testnet with the built-in list that is its one provider):
   pick a working public provider from <https://docs.near.org/api/rpc/providers>, one that needs no API key
   or whose key stays a server-side secret. The **OWNER** puts it first in `NEAR_RPC_URLS_MAINNET` or
   `NEAR_RPC_URLS_TESTNET` in Vercel (Sensitive if it carries a key) and redeploys. Never use a provider
   that asks for account keys.
4. Wrong chain. A URL that answers for the other network is logged as `chain.wrong`, with the network, the
   variable and the URL's place in it (counting from 1), never the URL. Sign-in and Register then answer
   `503 wrong_chain` on that server instance until it restarts, and the health probe answers
   `wrong chain`. Fix the variable and redeploy; nothing was written.
5. Old transactions. Burns older than about 2.5 days need an archival endpoint, in
   `NEAR_ARCHIVAL_RPC_URLS_MAINNET` or `NEAR_ARCHIVAL_RPC_URLS_TESTNET`. Without one, `/proof` shows such a
   burn as "not proven", never as a pass.
6. When the original provider recovers, restore the original order and redeploy.

## Burned, awaiting bridge

Mainnet only. On testnet `intents-stub.probarion.testnet` stands in for `intents.near`, and a cross-chain
burn does not leave NEAR.

A cross-chain payout has two halves: the vault's `ft_withdraw` on NEAR burns the POA token with the memo
`WITHDRAW_TO:<address>` (spend status `burned`), then the POA bridge releases USDC on Base.

1. Find the spend with `node packages/cli/dist/bin.js verify --network mainnet --vault <vault>` (add
   `--json` for the full report), or in the console. Note the burn transaction hash, the memo and the
   amount.
2. Check the destination on the Base explorer, `https://basescan.org/address/<address>#tokentxns`, for an
   incoming USDC transfer of the amount less the POA withdrawal fee.
3. Treat 30 minutes as the limit.
   - Over 30 minutes: SEV3. Post "Degraded: a cross-chain payout is waiting for the bridge".
   - Over 2 hours: SEV2. Contact NEAR Intents support, through the channel docs.near-intents.org lists,
     with the burn transaction hash, the token (`base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near`),
     the amount and the memo. Tell the payee, with the burn transaction link.
4. **Never re-pay a burned spend.** A second payment pays twice if the bridge completes later.
5. If the bridge confirms a failure, write down what happened to the funds (back in the vault's Intents
   balance, or held by the bridge operator) in the incident note, tell the owner, and only then let the
   owner decide on a new payment under the mandate.

## Other incidents

| Incident | Severity | What to do |
|---|---|---|
| Supabase down | SEV2 | The console, Payables, the proof pages and the alerts stop. Vaults are unaffected: owners can freeze and withdraw with their own keys (near-cli-rs), and the CLI's on-chain checks still run. `/status` shows only the RPC and NEAR AI checks (it has no database check), so the sign is the console failing, and a missed heartbeat. Post "Partial outage" on X. No data repair until Supabase recovers. |
| NEAR AI Cloud down (`/api/health/nearai` answers 503) | SEV3 | Decisions fall back to the rules alone, and the ledger records `decided_by: "rules-only"`. Post "Degraded". |
| 1Click down | SEV3 | Only mainnet Intents top-ups are affected; payouts from existing Intents balances still work. |
| Intents balance low (the rule `intents.balance_low` holds a spend) | SEV4 | Tell the owner to top up on the Top-up tab ([Intents top-up](#intents-top-up)). |
| Anchoring fails (`PROBARION:BadSeq`, or the ledger key's allowance is used up) | SEV3 | `BadSeq` means two writers on one ledger: stop the second. An allowance used up means a new ledger key with a new allowance: on a hosted vault, "Generate ledger key and set it in my wallet" on the Keys page; for an SDK vault, `node packages/cli/dist/bin.js ledger set-key --vault <vault> --pk <new pk> --allowance <near>` (**OWNER SIGNS**, 1 yoctoNEAR). Spends are unaffected, and `verify` reports the entries that no anchor covers yet. |
| Agent key leaked | SEV2 | The key can only call `spend`, inside its mandates and the vault's daily backstop. **OWNER SIGNS** a freeze if any spend looks wrong, then replace the key ([key rotation](#key-rotation)), review every spend since the suspected leak, and run `verify`. |
| An owner's console session stolen (for example through an XSS in the console), or a function-call key on an owner's account leaked (for example a dapp login key) | SEV2 | The console signs nothing itself: every transaction that changes a vault opens a wallet prompt. A function-call key attaches no deposit, so it cannot approve, reject, withdraw, add or remove keys, revoke mandates or unfreeze (`PROBARION:RequiresOneYocto`), and it cannot create mandates (they need a storage deposit). On the owner's account it can only call `freeze`, which is safe. Remove a leaked key from the owner account in the wallet, check the vault's recent transactions on the explorer, and fix the web bug. Rotating `KEY_ENCRYPTION_SECRET` signs everyone out ([key rotation](#key-rotation)). A stolen session may also have minted extension tokens on `/extension`, and those outlive it: revoke them there, or all of them ([key rotation](#key-rotation)). |
| An extension token leaked | SEV3 | It reads its account's waiting invoices, held spends and active mandates on its network, and cannot pay or approve. The owner revokes it on `/extension`; the OWNER can end every token ([key rotation](#key-rotation)). A freeze is not needed. |
| A vault (the Canary or any other) pays an account no mandate names | **SEV1** | **OWNER SIGNS** a freeze of every vault Probarion runs, at once. Tell every owner ([message](#owners-vaults)), snapshot every vault ([first 15 minutes](#first-15-minutes), step 6), post on X, and publish a postmortem within 72 hours. |

### App down

SEV2 after 15 minutes. The signs are the App or API monitors ([monitors](ops/MONITORING.md#monitors)), or
`/api/health` answering 503 with `"detail":"settings"`: the deployment cannot read its settings, and the
log line `health.settings_invalid` names the variable, never its value.

1. In Vercel, open the deployment's logs and find the first error and its request id.
2. A bad deploy: the OWNER rolls back to the previous Production deployment in Vercel (Instant Rollback, or
   promoting an older deployment; check the label on first use).
3. A bad setting: the OWNER fixes it in Vercel and redeploys.
4. Owners can still freeze and withdraw with their own keys (near-cli-rs) in the meantime. Say so in the post.

### Alerts not delivered

SEV2 when alerts are late against the schedule in use ([watcher and owner alerts](#watcher-and-owner-alerts)).
A missed heartbeat does not mean this: the alert dispatch runs after the heartbeat and never changes it.

1. Read the watch run's answer and its `cron.watch` log line: `alerts` holds `sent`, `failed`, `skipped`,
   `deferred` and `error`. Look for the log lines `alerts.dispatch_failed`, `alerts.send_failed`,
   `alerts.item_failed` and `alerts.mark_failed`.
2. Run the two queries of [the alerts runbook](ops/alerts.md#check-that-it-works) in the SQL editor.
3. A failed send is tried three times in all, then stops, and an event older than 24 hours is never sent.
   There is no resend tool and no console admin: the OWNER tells the owner directly what was missed.
4. To run the watcher now, from your own terminal with `CRON_SECRET` from the password manager:
   `curl -s -H "Authorization: Bearer $CRON_SECRET" https://<address>/api/cron/watch`.
5. Telegram: after a new `KEY_ENCRYPTION_SECRET` or a new bot token, re-run
   `pnpm --filter @probarion/web telegram-webhook`. Email: Resend sends from the address in `ALERT_FROM`
   (`apps/web/src/lib/config.ts`) only once the domain's DNS records are verified
   ([email through Resend](ops/alerts.md#email-through-resend-owner)).

### Watcher unhealthy

The watch run answers 503 and sends no heartbeat when a network's tenants cannot be listed, when every
tenant it tried on a network failed, or when a network was starved (`"starved":true` in the answer).

- `watch.tenant_failed` lines name the vaults that failed; the run goes on with the others.
- `checkErrors` above 0 on every run means the allowance and low-NEAR alerts are blind
  ([what one run does](ops/watcher.md#what-one-run-does)).
- To read a vault's history again, reset its cursors ([read a vault again](ops/watcher.md#read-a-vault-again)).

### Canary levels

The Canary stops itself at these levels (`apps/web/src/lib/canary/limits.ts`). Keep it above them, with a
margin.

| Level | What happens |
|---|---|
| Agent key allowance under 0.2 NEAR | Raw mode (the on-chain attempts) stops |
| Ledger key allowance under 0.5 NEAR | The Canary does not run at all |
| 300 ledger entries | The Canary closes; the OWNER starts a new Canary vault |
| 2,000,000 model tokens in a UTC day | Attempts are refused until the next UTC day |

The watcher's alerts cover the Canary like any vault: `allowance_low` when a key has under 0.2 NEAR of
allowance left (`apps/web/src/lib/near/runway.ts`), and `near_low` when the vault has under 0.05 NEAR free.
The ledger key's 0.5 NEAR level is above that alert, so the Canary stops before `allowance_low` fires for
its ledger key: watch the allowance on the Canary's Keys page.

### Canary spam or cost spike

SEV3. The switch to flip now is `CANARY_MODE`: `replay` (the page shows recorded attempts and refuses new
ones) or `off`, set in Vercel, then a redeploy of the same commit. Tightening a rate limit or the token
budget is a code change and a deploy (`apps/web/src/lib/ratelimit.ts`, `apps/web/src/lib/canary/limits.ts`),
and every window must stay at or under a day ([rate limits](#rate-limits)). Freeze the Canary if needed
(**OWNER SIGNS**).

### Agent key's allowance nearly used up

SEV4. The sign is the `allowance_low` alert (under 0.2 NEAR, `apps/web/src/lib/near/runway.ts:38`), or the
allowance the Keys page shows. A function-call key's allowance cannot be raised, so the key is replaced.

- Hosted vault: on the Keys page, generate a new agent key, create new mandates for it (every mandate is
  bound to one agent key), then remove the old key and revoke its mandates.
- SDK vault: print the removal, then the new key, with the CLI. **OWNER SIGNS** each, with 1 yoctoNEAR
  (`packages/cli/src/commands/owner-calls.ts`, `packages/cli/src/commands/agent.ts`):

  ```bash
  node packages/cli/dist/bin.js agent remove --network mainnet --vault <vault> --pk <old pk> --sign-as <owner account>
  node packages/cli/dist/bin.js agent add --network mainnet --vault <vault> --pk <pk> --allowance <near> --sign-as <owner account>
  ```

  Once the removal has gone through, the same public key can be added again with a larger allowance, which
  keeps the mandates bound to it. A new key needs new mandates.

### Wrong tenant kind

A vault's kind (`team`, `external` or `canary`) only moves up from `external` when it is registered, so a
vault registered while a setting (`TEAM_VAULT_IDS_<NET>`, `CANARY_VAULT_ID_<NET>`) named it by mistake keeps
that kind. The OWNER fixes it by hand in the SQL editor (`vault_id` is unique across both networks):

```sql
update public.tenants set kind = '<team|external|canary>' where vault_id = '<vault>';
```

## Watcher and owner alerts

- **Schedule.** `apps/web/vercel.json` runs `/api/cron/watch` daily at 00:00 UTC and `/api/cron/metrics`
  daily at 00:10 UTC, because the Vercel Hobby plan takes daily crons only. The watcher runs every minute
  only once the OWNER turns on the Supabase job `probarion-watch`
  ([per-minute schedule](ops/watcher.md#turn-on-the-per-minute-schedule-once)); one job serves both
  networks. A Payables upload and a Canary attempt also ask the watcher to look at their own vault right
  after they answer.
- **Delay.** An alert leaves when the watcher has recorded the event and a dispatch has run after it, so
  its delay follows the schedule in use ([when a message arrives](ops/alerts.md#when-a-message-arrives)).
  Do not promise a delay the schedule does not give.
- **Heartbeat.** The watch run pings `BETTERSTACK_HEARTBEAT_URL` only when every served network's watch
  was healthy. Its expected period in Better Stack must match the schedule: a day plus grace with the daily
  cron, about 3 minutes with the per-minute job ([heartbeat](ops/MONITORING.md#heartbeat)).
- **First run after migration 0011.** Run the watcher once by hand before anyone adds the first alert;
  otherwise the first run's events count as history and are not sent
  ([apply migration 0011](ops/alerts.md#apply-migration-0011-owner)).
- **Both networks.** One Telegram bot and one heartbeat serve both networks, and every link in an alert
  points at the address of the subscription's own network.

## Intents top-up

- Mainnet only. On testnet the top-up routes answer `409 mainnet_only`; without `ONECLICK_JWT` they answer
  `503 not_configured` (`apps/web/src/lib/topup/gate.ts`).
- The routes are owner-only, `POST /api/topup/quote`, `POST /api/topup/submit` and `GET /api/topup/status`,
  and are rate-limited per account and per network.
- Before the owner signs, the server checks the quote's signature and every bound field. A quote whose
  deposit was sent, or may have been sent, is never offered for signing again.
- In an incident, never ask an owner to send a deposit again for a quote that may have been paid: check
  `/api/topup/status` first.
- On testnet an owner funds a vault with NEAR USDC (`usdc.probarion.testnet`) from their own wallet, on the
  same tab.

## Rate limits

- The limits are `LIMITS` in `apps/web/src/lib/ratelimit.ts` and the Canary's in
  `apps/web/src/lib/canary/limits.ts`. A refused request answers 429. Each counter is one row of
  `public.rate_limits`.
- The browser extension's buckets: `ext:pair:<network>:<ip>` (it holds the caller's IP address) and
  `ext:pair:<network>` for code pairing, `ext:inbox:<network>:<account>` for the inbox, and
  `ext:mint:<network>:<account>` for the tokens and codes the `/extension` page makes. Pairing codes are
  not in `rate_limits`.
- `rate_limits_prune` (migration `20261108000009_metrics.sql`) deletes the rows whose window began more
  than a day ago, once per `/api/cron/metrics` run. No window is longer than a day
  (`apps/web/src/lib/ratelimit.test.ts` holds every window to it), so nothing live is deleted. A failed
  prune is the warning `cron.rate_limits_prune_failed`, and `"ok":false` under `prune` in the run's answer. A
  deployment prunes only once it runs the daily crons and migration 0009 is applied to its database.
- To lift one bucket for a legitimate user (OWNER, SQL editor):
  `delete from public.rate_limits where bucket = '<bucket>';`.
- Do not delete `auth:nonce:` rows. Each is the single-use burn of a sign-in challenge (a 600 s window);
  deleting one inside its window would let a captured signature sign in again.

## Deploying a fix and running migrations

- Every change goes on its own branch, `feat/<name>` or `fix/<name>`, and into `dev` through a pull request
  with a merge commit. Branches are kept after the merge.
- Vercel builds Production from `main`. To promote, the OWNER makes a branch from `origin/dev` and opens a
  pull request from it into `main`, with a merge commit; `dev` itself is never the head of that pull
  request:
  `git push origin origin/dev:refs/heads/chore/promote-<yyyy-mm-dd>`.
- Migrations: the OWNER applies them right after the Production build that carries them, in filename
  order, every file in `apps/web/supabase/migrations/` not applied yet, stopping at the first error and
  never running a file twice. From `apps/web`:

  ```bash
  pnpm dlx supabase db push --db-url "<Session pooler URI from the Supabase Connect dialog>"
  ```

  The URI comes from the Supabase dashboard's Connect dialog (Session pooler) and holds the database
  password: fill it in from the password manager and never paste it into a shared place. The other ways
  are in [step 1 of the deploy runbook](runbooks/web-deploy.md#1-supabase).
- Avoid 00:00 to 00:20 UTC, when the daily crons run: a cron that runs between a deploy and its migration
  can fail and log errors.

### Cron checklist

Run it after the promotion that brings the crons to Production. Every step is the OWNER's.

1. Before you promote: `CRON_SECRET` is set in Vercel Production, at least 32 characters. The console does
   not start without it.
2. Promote, wait for the Production build, and apply the migrations it carries (above). Before anyone adds
   an alert, run the watcher once by hand (step 4).
3. Vercel, Settings, Cron Jobs lists exactly `/api/cron/watch` (`0 0 * * *`) and `/api/cron/metrics`
   (`10 0 * * *`). How late within its hour the Hobby plan runs a daily cron: check on first use.
4. From your own terminal, with `CRON_SECRET` from the password manager:

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" https://<address>/api/cron/watch     # 401
   curl -s -o /dev/null -w "%{http_code}\n" https://<address>/api/cron/metrics   # 401
   curl -s -H "Authorization: Bearer $CRON_SECRET" https://<address>/api/cron/watch     # {"ok":true,"networks":[...],"heartbeat":...}
   curl -s -H "Authorization: Bearer $CRON_SECRET" https://<address>/api/cron/metrics   # {"ok":true,"networks":[...],"prune":{"ok":true,"deleted":<n>}}
   ```

   Both answers list every served network. One address is enough: both crons cover every served network,
   whatever address they are called at.
5. In the SQL editor, `select * from public.metrics_runs;` has a row for each served network, and right
   after a metrics run `select count(*), min(window_start) from public.rate_limits;` shows a
   `min(window_start)` no older than a day.
6. Optional: the per-minute watch ([per-minute schedule](ops/watcher.md#turn-on-the-per-minute-schedule-once)).
   Then set the heartbeat's expected period to about 3 minutes; without it, a day plus grace.
7. The logs show `cron.watch` and `cron.metrics` lines, no `cron.rate_limits_prune_failed` and no
   `alerts.dispatch_failed`.
8. The alert trial, the hosted end-to-end alert test, on the team demo vault, in this order:
   1. On `/console/<demo vault>/alerts`, add an email alert and a Telegram alert and confirm both
      ([try it](ops/alerts.md#try-it-owner), steps 1 and 2).
   2. On the Payables tab, upload an invoice whose amount is above the mandate's `approval_above` (sign
      the Confirm message in the wallet if the tab asks for it), so that the agent's spend is held.
   3. The "Approval needed" alert arrives. Write down the real delay: it follows the watcher's schedule.
   4. **OWNER SIGNS** the approval from the alert's console link (1 yoctoNEAR, a wallet prompt).
   5. The "Paid" alert arrives after the next watcher run (run it by hand, step 4, if the per-minute job is
      off).
   6. `/proof/<demo vault>` shows every check passing.
   7. `/usage` shows the payment under Team after the next metrics run.

   Write the times down, never a secret's value.

## Status page posts

Until a third-party status page exists, the OWNER posts on X from [@probarionhq](https://x.com/probarionhq)
and points people at `/status` on the address of their network, which shows live checks (not incident
posts). Once the status page exists ([status page](ops/MONITORING.md#status-page)), post there and mirror
SEV1 and SEV2 posts on X. Copy a template and fill in the angle brackets.

**Investigating**

```text
We are investigating <symptom, for example "failed payouts to Base"> affecting <component>. Vaults stay under their owners' control: you can freeze and withdraw with your own keys, for example with near-cli-rs, at any time. Next update by <UTC time, at most 60 minutes away>.
```

**Identified**

```text
Cause identified: <one sentence, no blame>. Impact: <who, what, since when, UTC>. <What we are doing>. Funds: <"no funds moved outside mandates" only if verified, otherwise "we are checking every spend since <time>">. Next update by <UTC time>.
```

**Monitoring**

```text
A fix is in place: <what changed>. We are watching <signal> until <UTC time>. If you froze your vault, you can unfreeze it after <condition>.
```

**Resolved**

```text
Resolved at <UTC time>. Duration <h:mm>. Impact: <numbers>. A postmortem will be published at <link> by <date>.
```

## Postmortem template

```markdown
# Postmortem: <title> (<UTC date>, SEV<n>)

## Summary
Two or three sentences: what happened, the impact, how it ended.

## Impact
- Duration (UTC): <start> to <end>
- Network: <mainnet or testnet>
- Vaults affected: <count, and ids if the owners agreed>
- Payments affected: <count, amounts, transaction links>
- Funds moved outside a mandate: <none, or details with transaction links>

## Timeline (UTC)
| Time | Event |
|---|---|

## Root cause
What failed and why, with links to the code (file and line) and to transactions.

## What went well

## What went wrong

## Where we got lucky

## Action items
| Action | Owner | Due | Issue |
|---|---|---|---|

## Evidence
Snapshots (node packages/cli/dist/bin.js verify --snapshot), Sentry issues, request ids, ledger seqs.
```

## Links

- [Security policy](../SECURITY.md)
- [Threat model: eleven attacks, the blast radius, failure modes, known gaps](THREAT_MODEL.md)
- [Monitoring: health routes, monitors, Sentry rules](ops/MONITORING.md)
- [The watcher](ops/watcher.md)
- [Owner alerts](ops/alerts.md)
- [The usage numbers](ops/metrics.md)
- [Rotating KEY_ENCRYPTION_SECRET](ops/key-rotation.md)
- [Both networks in one project](runbooks/web-deploy.md#35-both-networks-in-one-project)
- [The vault's error codes](../contracts/vault/src/errors.rs)
