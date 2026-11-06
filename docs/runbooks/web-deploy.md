# Web console: first deploy to Vercel and Supabase

**OWNER** does every step on this page, in a browser or a terminal on your own machine. Claude prepares the code and checks it, but never creates a project, never deploys and never calls the Vercel or Supabase APIs. Nothing here sends a NEAR transaction: the sign-in in the smoke test is a message signature.

Plan for about an hour. Do the steps in order: the Vercel build does not need the Supabase values, but the running console does. The build does need one Vercel setting, the pnpm switch in step 3.2, which is why step 4 checks a build made after it.

Where things are defined (you do not edit these to deploy):

- `package.json` (repo root): `packageManager` is `pnpm@10.34.9`. CI and Vercel install exactly that pnpm (step 3.2 switches Vercel to it), and `engines.pnpm` stays `>=10 <11`.
- `apps/web/vercel.json`: framework, region `iad1` (Washington DC, next to Supabase `us-east-1`), and the build command.
- `.env.example` (repo root): every variable the console reads. `docs/specs/2026-10-21-probarion-interfaces.md` section 14 lists the same names.
- `apps/web/next.config.ts`: the security headers. They are not repeated in `vercel.json`.
- `apps/web/supabase/migrations/*.sql`: the database schema, in filename order.
- `apps/web/test/deploy.test.ts`: the guardrails that keep this page true. `pnpm --filter @probarion/web test` runs them.

## 0. Before you start

- [ ] **OWNER:** make sure this work is on `main`. Vercel builds the Production Branch (`main`) and reads `apps/web/vercel.json` from the branch it builds; the guardrail tests and this page live on the development branch until they are merged. Merge `dev` into `main` first (the controller does that through a pull request), then check the file is there:
  ```bash
  git fetch origin
  git ls-tree origin/main apps/web/vercel.json
  ```
  It must print one line. If it prints nothing, stop: without `vercel.json` the first build has no `buildCommand`, cannot find `@probarion/core` and `@probarion/sdk` (they are loaded from `dist`), and fails. A Preview deployment of another branch is not a substitute for this check.
  Then check that the pnpm pin is on `main` as well (the pattern includes the version, so it fails on any other):
  ```bash
  git show origin/main:package.json | grep '"packageManager": "pnpm@10.34.9"'
  ```
  It must print one line. If it prints nothing, stop: Vercel would build a commit with no root `packageManager`. Merge the pin into `main` first.
- [ ] **OWNER:** decide the default network. Read `contracts/deployments/mainnet.json`. While its `factory.deploy_tx` is `null`, the mainnet factory `vaults.probarion.near` is not deployed, so the console cannot create or register a mainnet vault. Deploy with **testnet** as the default (`NEAR_NETWORK=testnet`) and flip the default to mainnet when the factory is live (`docs/runbooks/factory.md`). One project can serve both networks, each at its own address: section 3.5.
- [ ] **OWNER:** check the testnet factory `vaults.probarion.testnet` is deployed (`docs/runbooks/factory.md`). Without it the console shows the Create vault panel as unavailable. Registering an existing vault still works.

## 1. Supabase

- [ ] **OWNER:** create the project `probarion`, region **us-east-1** (N. Virginia). Save the database password in your password manager. If you want Preview deployments to keep their own data (recommended, see step 3.4), create a second project, for example `probarion-preview`, in the same region.
- [ ] **OWNER:** copy three values from the project's API settings. Projects created in 2026 issue the new key names, and the console keeps the old variable names for them:

  | Value | Looks like | Goes into |
  |---|---|---|
  | Project URL | `https://<ref>.supabase.co` | `SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL` |
  | Publishable key | `sb_publishable_...` | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
  | Secret key | `sb_secret_...` | `SUPABASE_SERVICE_ROLE_KEY` (server only) |

  The secret key bypasses row-level security. It goes into one variable, as Sensitive, and nowhere else: not in git, not in chat, not behind a `NEXT_PUBLIC_` prefix.
- [ ] **OWNER:** apply the migrations **in filename order**: every file in `apps/web/supabase/migrations/`, from `20261108000001_core.sql` on, that you have not applied yet (the sequence number in the name is the order, with no gaps). Either way, stop at the first error and do not run a file twice:
  - **With the Supabase CLI**, from `apps/web`:
    ```bash
    cd apps/web
    pnpm dlx supabase login
    pnpm dlx supabase link --project-ref <project-ref>
    pnpm dlx supabase db push
    ```
    If the CLI refuses because `supabase/config.toml` is missing, use the SQL editor below and tell the controller. Never run `supabase db reset` against the hosted project. The CLI writes your project reference into `apps/web/supabase/.temp/`; that folder is git-ignored, so leave it out of every commit.

    Without `login` and `link`, the CLI can also push straight to the database through its Session pooler, from `apps/web`:
    ```bash
    pnpm dlx supabase db push --db-url "<Session pooler URI from the Supabase Connect dialog>"
    ```
    The URI is in the dashboard's Connect dialog (Session pooler) and holds the database password: fill it in from your password manager, and never paste it into a shared place.
  - **Or in the dashboard**: SQL Editor, paste each file in order, Run.
- [ ] **OWNER:** check the result. In the SQL Editor:
  ```sql
  select c.relname, c.relrowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
  order by 1;
  ```
  Every table in the list must show `relrowsecurity = true`, and the list must not be empty. Any `false` is a stop: do not deploy, send the controller the table name. (Do not compare with a table count from this page: later migrations add tables.)
- [ ] **OWNER, optional:** paste `apps/web/test/db/rls-assert.sql` into the SQL Editor and run it. It raises an error naming the problem and prints nothing otherwise. It passes on the local test database; it has not been run against a hosted project yet, so if it raises, send the controller the message.
- [ ] **OWNER, optional hardening:** sign-in to the console is a NEAR signature, not Supabase Auth. In the dashboard's Authentication settings, turn off new user sign-ups. (Menu names change; the setting is called "allow new users to sign up".)

## 2. Secrets (offline)

- [ ] **OWNER:** generate both on your own machine (Git Bash on Windows has `openssl`) and save each in your password manager **before** you use it:
  ```bash
  openssl rand -base64 32   # KEY_ENCRYPTION_SECRET: 32 random bytes, base64 (44 characters, ends in "=")
  openssl rand -hex 32      # CRON_SECRET: 64 hex characters (the app requires at least 32)
  ```
  Paste each output into the password manager first, then into Vercel. Do not generate one inside a command that sets it.
- [ ] **OWNER:** understand what `KEY_ENCRYPTION_SECRET` protects. The console seals every agent key, the ledger key and every retained invoice under it. If you lose it, every sealed secret is lost with it; if it leaks, follow `docs/ops/key-rotation.md`. Production and a Preview that uses the **same Supabase project** must share one value (a row sealed under one master cannot be opened under another); see step 3.4.

## 3. Vercel

### 3.1 Import the repository

- [ ] **OWNER:** Vercel dashboard, Add New, Project, import `probarion/probarion` from GitHub.
- [ ] **OWNER:** on the configure screen set:
  - **Framework Preset:** Next.js (detected).
  - **Root Directory:** `apps/web`.
  - **Include source files outside of the Root Directory in the Build Step:** on (the default). The build needs `packages/core` and `packages/sdk`.
  - **Environment Variables:** if the configure screen has this section, add `ENABLE_EXPERIMENTAL_COREPACK` = `1` here, before you click Deploy (step 3.2 says what it is). If it has not, add it in step 3.2 and check a build made after it (step 4).
  - **Build, Install and Output commands:** leave them on their defaults and leave every Override toggle **off**. The build command comes from `apps/web/vercel.json`: it builds `@probarion/core` and `@probarion/sdk` (the app loads both from their `dist` folders), then runs `next build`. Do not override the install command: with an override such as `pnpm install`, Vercel uses the oldest pnpm in its image, and the lockfile needs pnpm 10. Which pnpm 10 it runs comes from `packageManager` in the root `package.json`, once step 3.2 has set the Corepack switch.
- [ ] **OWNER:** after the project exists, Settings, General: **Node.js Version 24.x**. Keep 24.x while `ENABLE_EXPERIMENTAL_COREPACK` is set: Node.js 25 and later no longer bundle Corepack. Before you move to 26.x, check the Corepack line in a Preview build log (step 4). Settings, Git: **Production Branch `main`**. Leave "Automatically expose System Environment Variables" on. Do not set `NODE_ENV` yourself; the build needs the dev dependencies.
- [ ] **OWNER:** leave the Git integration as it is. Vercel then makes a Preview deployment for every pull request and a Production deployment for every push to `main`.

### 3.2 Environment variables

- [ ] **OWNER:** Settings, Environment Variables. First add the one **build setting**: `ENABLE_EXPERIMENTAL_COREPACK` = `1`, for **Production** and **Preview**, Type **Config** (not Secret).
  - Why it has its own line: it is a switch for Vercel's build, not a variable the console reads. So it is not in `.env.example` (which lists what the console reads; `deploy.test.ts` keeps it out) and not in the tables below.
  - What it does: it makes Vercel install the pnpm that `packageManager` in the root `package.json` names (`pnpm@10.34.9`), through Corepack. Vercel's documentation calls Corepack experimental and gives this variable as the way to turn it on (<https://vercel.com/docs/builds/configure-a-build#corepack>).
  - Why you set it: without it, current Vercel builders still pick a pnpm 10 for this project (from the `packageManager` pin, or from the project's creation date), but that is not documented behaviour. The variable keeps the build on the documented path, at exactly the pinned pnpm. Vercel's own rule for a `lockfileVersion: 9.0` lockfile is "pnpm 9 or 10" (<https://vercel.com/docs/package-managers>), and a pnpm 9 would fail the install with `ERR_PNPM_UNSUPPORTED_ENGINE`, because `engines.pnpm` is `>=10 <11`.
- [ ] **OWNER:** Then add each row below for **Production** and **Preview** separately (use the Environment checkboxes). Tick **Sensitive** where the table says so: Sensitive values cannot be read back after saving.

  Required for the console to start. With one missing or malformed, the sign-in routes answer a bare 503 `unavailable` and the console pages show an error page; the cause is in Vercel, Logs, where the message names the variable (never its value):

  | Variable | Production | Preview | Sensitive |
  |---|---|---|---|
  | `NEAR_NETWORK` | the **default network**: `testnet` now, `mainnet` when step 0 allows. It is the network of any address that is neither of the two in 3.5 (a preview, a `*.vercel.app` URL), and the one the unsuffixed variables below apply to | `testnet` | no |
  | `NEAR_RPC_URLS` | leave unset for the network default, or a comma list in failover order (the default network's; 3.5 has the per-network form) | unset | no |
  | `PROBARION_FACTORY_ID` | unset for the default (`vaults.probarion.testnet` or `vaults.probarion.near`; the default network's) | unset | no |
  | `SUPABASE_URL` | project URL | the Preview project's URL, or the Production URL if Preview shares that project | no |
  | `NEXT_PUBLIC_SUPABASE_URL` | the same URL | the same URL as `SUPABASE_URL` in Preview | no |
  | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | publishable key | the publishable key of the project Preview uses | no (public by design) |
  | `SUPABASE_SERVICE_ROLE_KEY` | secret key | the secret key of the project Preview uses | **yes** |
  | `KEY_ENCRYPTION_SECRET` | from step 2 | **Preview has its own Supabase project:** its own new value. **Preview shares Production's project:** exactly the Production value (see 3.4) | **yes** |
  | `CRON_SECRET` | from step 2 (the daily usage cron sends it as a bearer token, and the app requires one) | its own value (it is never stored in the database, so it may differ from Production either way) | **yes** |

  Optional today, set when you need the feature:

  | Variable | Notes | Sensitive |
  |---|---|---|
  | `APP_ORIGIN_MAINNET`, `APP_ORIGIN_TESTNET` | the address each network is served at, `https://host` with no path (3.5). Setting one turns that network on. The default network falls back to the production address when its own is unset | no |
  | `TEAM_VAULT_IDS` | comma-separated vault accounts the team runs; they register as tenant kind `team` (step 5) | no |
  | `PROBARION_VAULT_ID` | the demo vault `/proof` opens. Use a public team vault created through the factory, with a signed, anchored ledger and "Public proof page" on (step 5). **Not** `v0.probarion.testnet`: it fails check (d) by design (its smoke spends predate the ledger), so `/proof` would show it in red. A vault whose proof page is not public is not opened: `/proof` then says how to open a vault | no |
  | `NEAR_ARCHIVAL_RPC_URLS` | comma-separated archival NEAR RPCs, in failover order, for example `https://archival-rpc.testnet.fastnear.com`. `/proof` reads burn transactions older than about 2.5 days through them. Unset: no archival lookup, and such a burn shows as "not proven" (`tx_unavailable`), never as a pass | no (yes if a URL carries an API key) |
  | `NEARAI_API_KEY` | NEAR AI Cloud key; set a spend cap in the NEAR AI dashboard first | **yes** |
  | `NEARAI_MODEL` | leave unset: the SDK resolves a default | no |
  | `ONECLICK_JWT` | 1Click top-up quotes (mainnet only): one key for the whole project, used for mainnet vaults; a testnet vault is refused | **yes** |
  | `CANARY_VAULT_ID`, `CANARY_MODE` | leave `CANARY_MODE` unset (it defaults to `code-only`); set the vault when the Canary is built. The vault is a network's own (3.5); `CANARY_MODE` is one switch for both | no |
  | `BASE_RPC_URL` | public Base RPC for settlement lookups, for example `https://mainnet.base.org` | no |
  | `SENTRY_DSN` | https DSN of a Sentry project | no |
  | `TELEGRAM_BOT_TOKEN`, `RESEND_API_KEY` | alert channels; `docs/ops/alerts.md` has the BotFather, webhook and Resend steps | **yes** |
  | `BETTERSTACK_HEARTBEAT_URL` | https; its path carries a token | **yes** |

  Do **not** set these on Vercel:

  - `PROBARION_AGENT_KEY`, `PROBARION_LEDGER_KEY`: the console keeps each vault's keys sealed in the database. These two are for the SDK and CLI on a developer machine.
  - `PROBARION_LEDGER_PATH`: for the SDK, CLI and verifier; the console does not read it.
  - `OLD_KEY_ENCRYPTION_SECRET`, `NEW_KEY_ENCRYPTION_SECRET`: inputs of the one-off rotation command, never stored.
  - Any variable with a `NEXT_PUBLIC_` prefix beyond the two in the table. The prefix publishes the value to every visitor's browser. `next.config.ts` derives the ones it needs from other settings: `NEXT_PUBLIC_SENTRY_DSN` from `SENTRY_DSN`, and `NEXT_PUBLIC_DEFAULT_NETWORK`, `NEXT_PUBLIC_ORIGIN_MAINNET` and `NEXT_PUBLIC_ORIGIN_TESTNET` (which address is which network: addresses and a network name, nothing secret) from `NEAR_NETWORK`, `APP_ORIGIN_MAINNET` and `APP_ORIGIN_TESTNET`.

  The `NEXT_PUBLIC_` values, `NEAR_NETWORK` and the two `APP_ORIGIN_*` are fixed into the build. After changing one, redeploy (a new build), not just restart.

### 3.3 Domain (only if you have one)

- [ ] **OWNER:** Settings, Domains, add `probarion.xyz` (or yours) and create the DNS records Vercel shows. Wait until Vercel marks the domain valid. The wallet sign-in message is addressed to the fixed recipient `probarion.xyz` (`AUTH_RECIPIENT` in `apps/web/src/lib/config.ts`), so sign-in also works on the `*.vercel.app` address before the domain is ready.

### 3.4 Preview versus Production data (advice)

This is advice, not a rule of the code. The code does not stop you from pointing Preview and Production at one Supabase project; it only requires that every row can be opened. Rows are sealed under `KEY_ENCRYPTION_SECRET`, so a project shared by two environments needs the same value in both, and then a leaked Preview value is a leaked Production value. Two Supabase projects, each with its own value, keep a throwaway Preview from touching real tenants. If you share one project, use one `KEY_ENCRYPTION_SECRET` and one network in both environments.

### 3.5 Both networks in one project

One Vercel project, one deployment, one Supabase database, one cron set, one Telegram bot and one heartbeat serve testnet and mainnet at once. **The network of a request is the address it was opened at**, and nothing else: not a query parameter, not a cookie. With none of the settings below the project behaves as it did before: one network, `NEAR_NETWORK`'s.

- [ ] **OWNER:** add the second address to the **same** Vercel project (Settings, Domains; a domain on an existing project is free, it is not a second project). Wait until Vercel marks it valid. Keep the first address as it is.
- [ ] **OWNER:** set the two origins, for Production (and Preview if you want the switch there), each `https://<host>` with no path, no query and no fragment (`http://localhost:<port>` is allowed for development). Two networks cannot share one host, and a refused value stops the console from starting with a message that names the variable and never its value:
  - `APP_ORIGIN_MAINNET`
  - `APP_ORIGIN_TESTNET`

  A network is **served** when it is the default network (`NEAR_NETWORK`) or its origin is set. The default network's origin falls back to the production address Vercel gives the build when its own is unset. Any other address (a preview, a `*.vercel.app` deployment URL, `localhost`) is the default network.
- [ ] **OWNER:** give each network its own settings. These six variables each have a mainnet form and a testnet form:

  | Setting | Mainnet | Testnet |
  |---|---|---|
  | RPC URLs, in failover order | `NEAR_RPC_URLS_MAINNET` | `NEAR_RPC_URLS_TESTNET` |
  | Archival RPC URLs (`/proof`) | `NEAR_ARCHIVAL_RPC_URLS_MAINNET` | `NEAR_ARCHIVAL_RPC_URLS_TESTNET` |
  | Factory | `PROBARION_FACTORY_ID_MAINNET` | `PROBARION_FACTORY_ID_TESTNET` |
  | Demo vault of `/proof` | `PROBARION_VAULT_ID_MAINNET` | `PROBARION_VAULT_ID_TESTNET` |
  | Canary vault | `CANARY_VAULT_ID_MAINNET` | `CANARY_VAULT_ID_TESTNET` |
  | Team vaults | `TEAM_VAULT_IDS_MAINNET` | `TEAM_VAULT_IDS_TESTNET` |

  The RPC URL lists can carry an API key: tick **Sensitive** for them. A network's value is its suffixed variable; else, for the **default network only**, the unsuffixed variable; else the built-in default (the network's public RPCs and its factory from the contracts' deployments, otherwise empty). **An unsuffixed variable never applies to the other network**: testnet RPCs never serve mainnet. **While both networks are served, an unsuffixed per-network variable is refused**: the console does not start, and the error names the variable and says to set its `_MAINNET` or `_TESTNET` form (never the value). Otherwise changing the default network would hand testnet's settings to mainnet. The console also refuses, at start, a mainnet account id that ends in `.testnet`, a testnet one that ends in `.near`, and an RPC URL whose host has the other network's name as a part (`rpc.testnet.fastnear.com` for mainnet); a 64-hex or `0x` id belongs to a key and passes on both.
- Everything else stays one variable for the whole project: `ONECLICK_JWT` (1Click is mainnet only), `BASE_RPC_URL`, `CANARY_MODE`, `BETTERSTACK_HEARTBEAT_URL`, `TELEGRAM_BOT_TOKEN`, `RESEND_API_KEY`, `NEARAI_API_KEY`, `NEARAI_MODEL`, `SENTRY_DSN`, `CRON_SECRET`, `KEY_ENCRYPTION_SECRET` and the Supabase keys. The Canary's daily model-token budget is shared by the two networks on purpose (a token costs the same on both).
- [ ] **OWNER:** a change to `NEAR_NETWORK`, `APP_ORIGIN_MAINNET` or `APP_ORIGIN_TESTNET` needs a **redeploy**: the browser's copy of the address map is built into the pages, and the header's Testnet | Mainnet switch and the beta strip read it. The switch shows only when the other network is served; with no `APP_ORIGIN_*` it never shows.
- [ ] **OWNER:** run the migration once. `20261108000012_networks.sql` is for the whole project, not for one network: apply it once, in order, as in step 1. Deploy the code first and apply it right after: the new code works with the old functions (the Canary board then counts both networks until the migration lands), while the new functions refuse a request that does not name a network, which the old code never does.
- The main address stays **testnet** until the mainnet factory is live (`contracts/deployments/mainnet.json`). Which network an address serves is set by the two origins alone; `NEAR_NETWORK` decides only what an address that is neither origin shows (a preview, a `*.vercel.app` URL, `localhost`). Do the settings in this order, one redeploy and one check after each step, and do not skip ahead:
  0. [ ] **OWNER:** before you deploy this change, read the Production values of the per-network settings in Vercel. From this change on, the console refuses at start, for both networks and even with one network served, a testnet account id that ends in `.near`, a mainnet one that ends in `.testnet`, and an RPC URL whose host has the other network's name as a part. Fix any value that would be refused first; otherwise the console does not start after the deploy (the error names the variable).
  1. [ ] **OWNER:** rename every unsuffixed per-network variable you have to the **default network's** suffixed form (with a testnet default: `NEAR_RPC_URLS` to `NEAR_RPC_URLS_TESTNET`, `PROBARION_FACTORY_ID` to `PROBARION_FACTORY_ID_TESTNET`, and so on), delete the unsuffixed ones, redeploy, and check that the console starts and `/console` loads. With one network served the suffixed form of the default network is accepted, so this changes nothing a visitor sees.
  2. [ ] **OWNER:** once the mainnet factory is live, add the testnet address (for example `testnet.probarion.xyz`) to the same project, and set **both** origins explicitly: `APP_ORIGIN_MAINNET=https://probarion.xyz` and `APP_ORIGIN_TESTNET=https://testnet.probarion.xyz`. Set both even though one of them is the production address: the production-address fallback belongs to the default network, and the main address is about to serve the other one. Add the mainnet suffixed settings (`NEAR_RPC_URLS_MAINNET`, `PROBARION_FACTORY_ID_MAINNET`, and so on) in the same step. Redeploy and check both addresses. From this deploy the main address serves mainnet and the testnet console lives at its own address; testnet sessions on the main address end, and people sign in again at the testnet address.
  3. [ ] **OWNER (optional):** flip `NEAR_NETWORK` to `mainnet`, only while both origins are set, and redeploy. It changes only what a preview, a `*.vercel.app` URL or `localhost` shows, because every network's settings are suffixed. If an unsuffixed variable is still set the console refuses to start and names it; fix it and redeploy.
- The network comes from the `Host` header as the platform passes it to the app (the first `X-Forwarded-Host` value when there is one, as the CSRF check reads it, else `Host`): behind another proxy, make sure it passes the address the visitor opened.
- The console also asks each network's RPC which chain it serves, and refuses to work with one that serves the other. Before it creates lasting state (sign-in, Register and the approvers re-sync), it sends the JSON-RPC `status` call to **each** URL of that network's RPC list on its own and compares `chain_id` with the network (`mainnet` or `testnet`). Those three then read the chain only through the URLs that answered right, in list order. A URL that answers with the other chain is remembered until the next start: from then on sign-in and Register answer 503 `wrong_chain` (the page says the site is connected to the wrong NEAR network), mint no session and register nothing, and the log has `chain.wrong` with the network, the variable and the URL's place in it (counting from 1), never the URL. **OWNER:** if you see `chain.wrong`, correct that variable and redeploy; nothing was written. A URL that has not answered yet does not stop sign-in while another URL has answered right, but it is asked again on each sign-in and Register, which adds up to about 10 s when it times out: remove a URL that is gone for good. When no URL has answered right, the answer is the usual 503 `unavailable`.
- Sessions are per address. Signing in at one address does not sign in at the other (the cookie belongs to its host and names its network), so a person signs in on each, with a wallet of that network. After this change everyone signs in once more: the old cookie is not accepted (it lasts 12 hours anyway).
- One Telegram bot serves both networks (`docs/ops/alerts.md`). Its webhook does not move when the addresses change in step 2: the route links and stops subscriptions of either network at whatever address it is called. Each alert links to the console of its own vault's network.
- Check it: open each address; the header shows Testnet | Mainnet with the current one filled, and the other a link to the other address; sign in at each; open a vault of the other network and read "This vault is on NEAR <network>" with a button to its address.

## 4. First deploy and smoke test

Once the deployment is live, the [incident runbook](../RUNBOOK.md) says what to do when something goes wrong, and the [monitoring guide](../ops/MONITORING.md) sets up the uptime monitors, the heartbeat and Sentry.

- [ ] **OWNER:** make a build that starts after step 3.2: Deployments, the latest Production deployment, Redeploy (the import build ran before the variables existed and does not count), or push to `main`. Open that build's log and check, in order:
  - the log shows `Detected ENABLE_EXPERIMENTAL_COREPACK=1 and "pnpm@10.34.9" in package.json`, and the install then ends with `Done in ... using pnpm v10.34.9`: the install step uses pnpm 10.34.9, from `packageManager`. If it does not:
    - `Could not enable corepack because package.json is missing "packageManager" property`, or `Using pnpm@9.x based on project creation date`: the commit that was built has no pin. Merge it (step 0), then redeploy.
    - No Corepack line at all: the variable is missing for that environment. Add it (step 3.2), then redeploy; a changed variable applies to the next build only.
    - The Corepack line is there but the install fails: remove the variable, redeploy, and tell the controller. Without Corepack, current builders still follow the pin, and pnpm switches to the pinned version by itself.
    - It still prints 9.x and fails with `ERR_PNPM_UNSUPPORTED_ENGINE`: stop and tell the controller: that is a repository change;
  - `packages/core build` and `packages/sdk build` finish with "Done";
  - `next build` finishes and lists the routes `/`, `/login`, `/console`, `/console/[vault]`, `/console/[vault]/keys`, `/console/[vault]/mandates`, `/proof`, `/proof/[vault]`, `/proof/[vault]/snapshot.json`, `/proof/[vault]/ledger.jsonl` and `/api/auth/*`.
- [ ] **OWNER:** smoke test, on the deployment URL:
  1. `/` loads with the amber "Unaudited beta" banner and three cards. The Canary, Usage and Status entries are links; until Task 22's other pages are built, Security, Terms and Privacy read "(coming soon)" and are not links; no link on the page, in the menu or in the footer leads to a 404.
  2. `/console` while signed out sends you to `/login?next=%2Fconsole`.
  3. `/login`: Sign in with your NEAR wallet. The wallet asks for a **message signature**, not a transaction. You land on `/console`.
  4. `/console`: register a vault you own, signed in as its on-chain owner. On testnet that is `v0.probarion.testnet` (`contracts/deployments/testnet.json`). The vault page opens with Overview, Mandates and Keys tabs.
  5. Security headers: `curl -sI https://<deployment-url>/` shows `x-content-type-options`, `referrer-policy`, `x-frame-options`, `permissions-policy` and `cross-origin-opener-policy`.
  6. Health checks, for the deployment's network: `curl -s https://<deployment-url>/api/health` gives `{"ok":true,"service":"probarion-web","network":"<network>",...}`; `curl -s -o /dev/null -w "%{http_code}\n" "https://<deployment-url>/api/health/rpc?provider=0"` gives 200, and the same for `https://<deployment-url>/api/health/nearai` gives 200; `curl -sI https://<deployment-url>/.well-known/security.txt` gives 200. A 503 names the problem in `detail` ([health routes](../ops/MONITORING.md#health-routes)).
  7. `/proof/<vault>` for a vault whose "Public proof page" is on (step 5), ideally the `PROBARION_VAULT_ID` demo vault (a factory team vault, never `v0.probarion.testnet`, which is red by design): the result comes first ("All offline checks pass", "Not proven yet" or "A check failed"), then checks (a) to (i) with explorer links. `/proof` alone redirects to `PROBARION_VAULT_ID` when that vault's proof page is public on this network, and otherwise says how to open a vault. Download `snapshot.json` from the page. On another machine, set the CLI up from the public repository (the `probarion` npm package is not published yet; needs git, Node 24 or later and pnpm 10; if you cloned it before, run `git pull`, `pnpm install` and the build line again), one command per line: `git clone https://github.com/probarion/probarion`, then `cd probarion`, then `pnpm install`, then `pnpm --filter "{packages/cli}..." build`. Put the downloaded file in that folder and run `node packages/cli/dist/bin.js verify --offline <the downloaded file>`. The download is a snapshot of the vault taken when you click or shortly before, not necessarily the page's own: the verifier prints its `taken_at`. When that is the `taken_at` the page shows, it is the very snapshot the page checked, and a verifier built from the current repository gives the same result; otherwise it is another snapshot of the vault, and its result can differ from the page's (a transaction that could not be read during one of the two reads is enough). The page's `probarion-<vault>-ledger.jsonl` link downloads the ledger its prove-it commands pass as `--ledger`; download it just before running them, replacing any earlier copy. A vault id that is not a NEAR account, and a vault whose page is private, answer 404.
- [ ] If sign-in answers 503 or `/console` shows an error page: Vercel, Logs. The message names the variable that is missing or malformed (for example "KEY_ENCRYPTION_SECRET must be 32 bytes encoded as base64"), never its value. Fix the variable, then redeploy.

## 5. Team vaults

The earlier plan set `kind = 'team'` with a SQL update. The console now does it from configuration, so there is no SQL step.

- [ ] **OWNER:** set `TEAM_VAULT_IDS` to the comma-separated vault accounts the team runs (for example the demo vault) and redeploy.
- [ ] **OWNER:** register each of those vaults as its on-chain owner (step 4.4). Registering a vault that is already registered as external upgrades it to `team`; it never goes back.
- [ ] **OWNER:** if a vault's `/proof` page should be public, tick "Public proof page" in that vault's settings in the console. It is off by default.

## 6. Repository homepage

- [ ] **OWNER:** once the production URL answers, GitHub, the repository's About panel (gear icon), Website: the production URL. Or, from a terminal logged in with `gh auth login`:
  ```bash
  gh repo edit probarion/probarion --homepage https://<production-url>
  ```
  This edits public repository metadata, so it is yours to do.

## 7. Later: record the mainnet firsts as evidence

Do this only after the transaction exists, once per transaction, each in its own commit. **OWNER SIGNS** every transaction. Recording one only writes `docs/mainnet-proof.json`: use the `add-tx` subcommand of the proof CLI (`pnpm proof` prints its usage; `docs/runbooks/mainnet-v0.md` shows the full command and the `H` variable it takes the hash from). Copy the hash from the console's "Done" or "Contract did" link.

| `--id` | `--kind` | `--signer` | `--receiver` | `--signed-by` | Happens when |
|---|---|---|---|---|---|
| `first_console_vault` | `vault_created` | the owner account | `vaults.probarion.near` | `owner` | the owner signs `create_vault` at `/console` |
| `first_console_agent_key` | `agent_added` | the owner account | the vault | `owner` | the owner signs `add_agent` at `/console/<vault>/keys` |
| `first_console_mandate` | `mandate_created` | the owner account | the vault | `owner` | the owner signs the mandate at `/console/<vault>/mandates` |
| `first_payables_payout` | `near_payment` (for a Base payee: `base_payout`, plus `--base-tx` once the Base transfer is visible) | the vault | the vault | `agent_key` (add `--spend-id` and `--amount`) | the Payables agent pays an invoice at `/console/<vault>/payables` (an owner-confirmed invoice is still signed by the agent key) |

Give each one a `--what` line in plain words, for example "First vault created through the console (factory create_vault)".

## 8. Later: the proof page's evidence file, after mainnet v0

`/proof` reads no file at runtime (Vercel has no `docs/` then). What the CLI takes from `docs/evidence` and `docs/mainnet-proof.json` comes instead from one committed file, `apps/web/content/proof-evidence.json`. It ships as `{}`: there is no mainnet v0 yet. A malformed file is never ignored: every proof page then shows "No result: the checks did not run" until it is fixed (`apps/web/src/lib/proof/evidence.test.ts` checks the committed file).

Shape, one entry per vault, keyed by `"<network>:<vault>"`; both fields are optional:

```json
{
  "mainnet:v0.probarion.near": {
    "preLedgerDecisionHashes": ["<64 lowercase hex>"],
    "burnTxHints": { "<spend id>": ["<tx hash>", { "hash": "<tx hash>", "signer": "<account>" }] }
  }
}
```

- [ ] **OWNER** (after the mainnet v0 Day-4 spends are recorded): fill the `mainnet:v0.probarion.near` entry, in its own commit.
  - `preLedgerDecisionHashes`: from the repository root, after `pnpm install && pnpm build`, run `node packages/cli/dist/bin.js verify --network mainnet --vault v0.probarion.near --evidence docs/evidence --snapshot v0-snapshot.json` and copy the snapshot's `pre_ledger_decision_hashes` list. These are the sha256 of the `docs/evidence/v0-decision-*.json` files. The SDK applies them to `v0.probarion.near` on mainnet only; an entry for any other vault has no effect on check (d).
  - `burnTxHints`: from `docs/mainnet-proof.json`, every entry in `txs` with `network` `mainnet`, `receiver_id` the vault, a `spend_id`, and an `expect` other than `failure`. Add `{ "hash": <its hash>, "signer": <its signer_id> }` under its `spend_id`. This is the list the CLI builds from `--proof docs/mainnet-proof.json`.
  - Then run `pnpm --filter @probarion/web test src/lib/proof` and deploy. The page's checks (d) and (h) should then match what `node packages/cli/dist/bin.js verify --network mainnet --vault v0.probarion.near --evidence docs/evidence --proof docs/mainnet-proof.json --ledger <the vault's ledger as JSONL>` reports (`npx probarion …` once the package is on npm).

## When a later task changes this page

- A new pnpm version: change `packageManager` in the root `package.json` (CI and Vercel both follow it), the pinned value in `scripts/test/release-manifests.test.ts`, and every pnpm version named on this page (`deploy.test.ts` fails on any that differs from `packageManager`). The script tests fail until the first two agree. The workflows carry no version of their own.
- A new environment variable: it goes into `.env.example` first (`deploy.test.ts` fails otherwise), then into the tables in 3.2. A setting that differs by network takes the `_MAINNET` and `_TESTNET` forms of 3.5.
- A new Vercel cron: add it to `apps/web/vercel.json`. `deploy.test.ts` requires a `GET` route at that path that checks `CRON_SECRET`. Per-minute and hourly schedules need Vercel Pro; the Hobby plan rejects them at deploy time (the usage cron is daily for that reason: `docs/ops/metrics.md` says how to run it hourly). The watcher's cron is daily for the same reason, and `docs/ops/watcher.md` says how to run it every minute.
- A new migration: one new file, next sequence number, no gaps. The test applies the folder to a fresh database and refuses extensions, role changes, owners and Supabase-only features.
- A page that was "coming soon": delete its line from `PLANNED_ROUTES` in `apps/web/src/lib/routes.ts`, and its link goes live.
