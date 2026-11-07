# Changelog

All notable changes to this repository: the NEAR contracts in `contracts/`, the npm packages
`@probarion/core`, `@probarion/sdk` and `probarion` (the CLI), and the web console in `apps/web`.
The MCP server `@probarion/mcp` is planned and does not exist yet.

Versions follow semver. The npm packages share one version, released by the tag `sdk-v<version>`;
none is published yet. A contract crate carries its own version, and each build of it is identified
by the code hash of its reproducible build in `contracts/code-hashes.json`. The web console is not
versioned yet, and it deploys from `main` to <https://probarion.xyz>. While the version is 0.x, a minor version may change the API.
The software is an unaudited beta.

## Unreleased

### Added

- The ledger test on the landing page, each Canary answer and each proof page whose checks ran now
  end with a link to the next page. On the landing page, a run the verifier failed ends with
  "Caught." and a link to `/proof`. A Canary answer ends with "Put limits like these on your own
  agent", and a proof page with "Put your agent behind a mandate"; both link to the console. They
  ended at GitHub or an explorer.
- The console has a Top-up tab. The owner sends USDC on NEAR from their own wallet to the vault. On
  mainnet only, the owner can also ask 1Click for a quote that tops up the vault's Base USDC balance
  inside NEAR Intents, and signs the deposit in their own wallet. On testnet, which has no Intents or
  1Click, the tab says so, names the stand-in contract and the test token, and offers only the NEAR
  USDC funding.
- Before the owner is asked to sign a 1Click deposit, the server checks the quote's signature against
  1Click's key (pinned in the code and tested against the SDK's default) and that the signed request
  is the one the console sent: this vault as the recipient inside Intents, the owner as the refund
  address, the assets, the amount, the slippage and the referral, with no extra routing fields. It
  refuses a deposit address that is the vault, the owner or a token contract, and a quote that is
  stale, more than 5% above the amount, open past the deadline asked for, or with times that do not
  state their time zone. A refused quote shows its reason and offers nothing to sign.
- The Top-up tab does not offer a quote again after a deposit was sent or may have been sent, after
  1Click stopped reporting its address as waiting, past its deadline, or when the amount typed
  changed. A cancelled or failed wallet attempt does not lift those guards. A new quote request clears
  the old quote and is switched off while the wallet is open.
- A testnet faucet, so anyone can fund a testnet vault. On a testnet vault's Top-up tab, the owner
  presses "Add test USDC", and `POST /api/topup/faucet` mints 25 test USDC straight into the vault,
  not into a wallet. It works once a UTC day per vault, for 3 vaults a day per owner account and for
  50 vaults a day in all, and only at the testnet address, for a signed-in owner whose vault the chain
  agrees on; everyone else gets 404. It signs as `probarion.testnet` with `TESTNET_FAUCET_KEY`, a
  function-call key that can call only `mint` on `usdc.probarion.testnet`: before each mint the route
  reads the key from the chain and refuses a full-access key or one low on allowance, with nothing
  counted. The amount and the vault come from the server, not the request. A mint whose outcome is unknown answers with its hash and is not sent again. Without the
  key, the tab says to ask @probarionhq. The key is masked in logs, and `docs/RUNBOOK.md` has the
  steps to set it up.
- Owner-only top-up routes `POST /api/topup/quote`, `POST /api/topup/submit` and
  `GET /api/topup/status`, rate-limited per account, which answer fixed sentences rather than
  1Click's own error text.
- Public site in the light brand design, deployed at <https://probarion.xyz>: a landing page
  with real testnet transactions, the path of one payment and a list of what works and what does not;
  a beta strip on every page, a header with a phone menu that works with no JavaScript, a footer, and
  plain sign-in, not-found and error pages. Open Graph and Twitter cards, an icon, `robots.txt` and
  `sitemap.xml`.
- The site's ledger test runs the real `runChecks` from `@probarion/core` in the visitor's browser on
  a committed test fixture of five entries signed with test keys. Three edits (an amount, an erased
  refusal, a refusal turned into an approval) each show what the verifier catches when an edit was
  not re-signed.
- `/proof` with no public vault is a real page, with a form that opens `/proof/<account>`, an inline
  error for an invalid account, and the ledger test.
- Tests that hold the site's named facts to the deployment record, the README, `SECURITY.md` and the
  contract source.
- Web console deploy checks, run with its tests: every environment variable the console reads is
  listed in `.env.example` with secrets left empty, no secret can reach the browser through a
  `NEXT_PUBLIC_` name, migrations stay ordered and portable to a hosted Supabase, every scheduled job
  has a GET route that reads `CRON_SECRET`, and no browser code can import server-only code.
- `apps/web/vercel.json` and a first-deploy checklist for the owner, `docs/runbooks/web-deploy.md`
  (Supabase, secrets, Vercel settings, a smoke test).
- Community files: a pull request template with Safety and Review sections, bug and feature issue
  forms (blank issues are off; vulnerabilities go to the private channel SECURITY.md names),
  `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1).
- CI: one `verify` check that needs every other job and passes only when each one succeeded (a
  skipped or cancelled job fails it), for branch rules to require. When a gate in the TypeScript,
  Rust unit or sandbox job fails, the job posts the last 60 lines of that gate's log as one annotation
  and in the job summary.
- A 1280×640 social preview image for the repository page, rendered from the brand by a script that
  refuses any other size.
- Vault contract (`probarion-vault` 0.1.0). The owner creates mandates, each with a payee fixed at
  creation (a NEAR account, or a Base or Solana address paid out through NEAR Intents), a limit per
  payment, a total, a number of uses, an expiry and an amount above which an approver must confirm.
  The agent's function-call key can call only `spend`, which has no recipient argument. The vault
  also has held spends with `approve`, `reject` and `expire_held`; a daily backstop per UTC day;
  `freeze`, `unfreeze`, `withdraw` and `withdraw_intents` for the owner; ledger anchors whose
  sequence goes up by exactly one; the free `check_spend` dry run; NEP-297 events; and 24 readable
  `PROBARION:<Code>` errors. Every owner and approver method that moves value or changes authority
  takes exactly 1 yoctoNEAR, which only a full-access key can attach; `freeze` takes none.
- Factory contract (`probarion-factory` 0.1.0). It creates `<name>.<factory>` vaults with no access
  keys, from vault code published as a global contract and referenced by hash, or from wasm it stores,
  keeps a registry of versions, and refunds the deposit when a vault cannot be created. It is not
  deployed on any network yet.
- Test contracts for the sandbox and testnet: `intents-stub` stands in for `intents.near`, and
  `test-ft` for USDC and the POA tokens. Neither is meant for mainnet.
- Contract tests: a unit test for every error code, property tests of the accounting invariants
  (spent plus reserved stays within the total; an invoice is paid at most once), and near-workspaces
  sandbox tests of the key limits, holds, payouts and the factory, which run in CI on Linux.
- Reproducible contract builds in CI (cargo-near 0.22.0 in Docker, pinned by digest), with each
  recorded build's code hash in `contracts/code-hashes.json` and compared on every pull request
  into `dev` or `main` and every push to them.
- Testnet deployment on 2026-11-01: the test tokens, the intents stub and the vault
  `v0.probarion.testnet`, which has no full-access key and runs the recorded reproducible build.
  Its smoke run paid 1 test USDC to a NEAR account, burned 1 test USDC with a `WITHDRAW_TO:` memo for
  a Base address, and was refused with `NoMandate`. The transactions are in
  `contracts/deployments/testnet.json`.
- Deploy and smoke scripts for testnet, runbooks for testnet, the factory and the planned mainnet
  vault (each signing step is the owner's), and `pnpm proof` for the mainnet evidence file.
- Web console, in progress: wallet sign-in with near-connect and NEP-413, checked on
  the server, with a signed session cookie; a Supabase schema with row-level security on every table,
  tested in PGlite; vault creation through the factory, with the CLI as a fallback; a vault overview
  with balances, NEAR runway, freeze and the held spends to approve; a keys page where the owner adds
  the agent and ledger keys from their wallet with the public key only; mandate creation for a NEAR
  or Base payee, with the same validation in the browser and on the server, and revocation; and a
  Postgres ledger store whose entries core's `runChecks` verifies.
- Web console, the public proof page (built and tested): `/proof/<vault>` shows a vault
  whose owner made its proof public. The result comes first: "All offline checks pass" (green), "Not
  proven yet" (amber) or "A check failed" (red). Then come checks (a) to (i), each with explorer links
  on the vault's own network, and the vault's cross-chain burns. When a burn is not proven, the page
  names the spend and the reason and gives the command that proves it. A private vault's page is
  shown only to its members, and anyone else gets a 404. `/proof` opens the demo vault set in
  `PROBARION_VAULT_ID` when its page is public. `NEAR_ARCHIVAL_RPC_URLS`, which is optional, lets the
  page read older burn transactions.
- Proof page downloads: `snapshot.json` (the ledger and chain data the checks ran on, for
  `probarion verify --offline`) and the vault's signed ledger as `probarion-<vault>-ledger.jsonl`
  (for `probarion verify --ledger`). Both have the page's access rules and rate limit, and a
  browser does not reuse an old copy. The page shows its snapshot's `taken_at` exactly as the verifier
  prints it, so a reader can tell when a download is the very snapshot the page checked. Until the
  `probarion` package is on npm, every command on the site and in the deploy runbook is shown as run
  from a clone of this repository (four set-up commands, then `node packages/cli/dist/bin.js`), and
  the tests run those commands as shown.
- Web console, Payables pipeline (built and tested): `POST /api/console/[vault]/invoices` takes an invoice (a PDF, a text
  file or pasted text) together with the purchase-order document hashed into a mandate, and runs
  the reference agent. Code rules decide, the vault contract pays the mandate's payee, and each
  payment is signed with the agent key its mandate is bound to.
- Payables pays an invoice by itself only when an attested private model on NEAR AI Cloud confirms
  the amount the code read. Without such a model (rules-only), nothing is sent: the invoice waits for
  the owner with the amount the code suggests. The model is shown the code's amount, so it confirms
  that amount rather than reading the invoice independently. A later SDK change will hide the
  amount from the model.
- Payables amount reader: it reads an amount only from a document that names itself an invoice, and
  only from a plainly written final total line in USD or USDC. It refuses everything else with a
  reason the console shows (`not_found`, `ambiguous`, `unreadable`, `currency`, `truncated`, `zero`
  or `not_payable`). That covers receipts, quotes, statements, credit notes, purchase orders, paid,
  void or test stamps, other currencies, totals in columns or split across lines, amounts after the
  total, and look-alike or hidden characters. Its tests hold 1,670 adversarial inputs, a ReDoS
  sweep of every pattern it uses, and three corpora of realistic invoices, with no wrong amount. On
  realistic invoices it reads about half and refuses the rest with the reason.
- Payables storage and duplicates: an invoice is stored sealed with a per-vault key, or as hashes
  only in zero-retention mode. A payment whose confirmation is pending is not sent again. A
  re-upload of a paid or pending invoice is answered as a duplicate when its normalised text, or
  its invoice number for the same payee (kept as a keyed HMAC), matches. Uploads are limited to
  4 MiB per file and 4 MiB + 64 KiB per request. The migration
  `apps/web/supabase/migrations/20261108000006_invoices.sql` adds the invoice tables.
- Web console, Payables pages (built and tested against a fake chain, not yet tried with a real
  wallet): upload an invoice with its purpose document, see every invoice with its status in
  plain words, and open each one to see what the model wanted, what the code allowed and what the
  contract did, with explorer links for the payment and the ledger anchor. Zero-retention can be
  switched on there, and the page says what is kept. The migration
  `apps/web/supabase/migrations/20261108000007_invoice_confirm.sql` adds what these pages need.
- An invoice that waits for the owner shows, before any button, the amount, why it waits, the mandate
  as the chain shows it, the invoice line the amount was read from, who uploaded it, and every invoice
  of the same payee from the last 90 days with equal and near amounts marked. Confirm is not offered
  when that list cannot be read, when the payee is unknown, or when the retained text cannot be read
  or does not hash to the hash the owner signs. Reject stays available, and the page names the cause.
- The owner can pay a waiting invoice with a wallet signature: the server builds the message from
  database and chain values only, checks it against a full-access key of the vault's on-chain owner
  at a final block, and pays exactly the amount shown, once, even after a double click. A confirmation
  is single-use, expires after 5 minutes, and a new one ends the earlier unused one.
- Each owner confirmation is kept in the signed ledger with its signature, key, nonce and message, so
  the signature can be re-checked from the ledger entry against the decision it sits in. The block of
  the key check is the server's record: whether the key was the owner's at that block takes an archival
  node, and `probarion verify` does not check the confirmation yet.
- The owner can reject a waiting invoice; nothing is paid. The same text then comes back as a
  duplicate, and a corrected invoice counts as new.
- If the server does not answer after the owner signed, the page says the payment may have gone out
  and not to pay again; only a failure before that says nothing was sent. A row whose cycle is not
  recorded shows "not recorded yet, do not resend" and names the ref to read on chain. Such a row stays
  in that state until the reconcile job is built.
- The invoice reader accepts invoice numbers whose only digit is a 0 or 1 beside a letter, such as
  INV-C1. After the invoice word on a title line it refuses a status or document word in any token,
  such as `Invoice PAID1001`, `Invoice DEM01` and `Invoice void-2`, and a vendor named Test24 Labs
  before that word still reads. A Title-case word with a look-alike digit is not an invoice id, and an
  invoice-to or invoice-from label is not a title. Read rates on the realistic corpora did not change.
- The Canary challenge has its backend, `POST /api/canary/attempt`: anyone can send text to a
  deliberately gullible AI accounts-payable agent and try to talk it into paying. The Canary does not
  pay from its own cycle: a code rule refuses every attempt, and the answer shows which rule refused
  and why. Its page, feed and scoreboard are described below.
- In live mode, a "pay" the code refused is also sent to the contract unfiltered, but only when the
  contract's own free dry run says it would refuse it, so visitors can watch the contract's refusal
  (for example `OverPerPayment`); the dry run makes sure such a spend pays nothing. This is limited to one on-chain
  attempt per visitor every 10 minutes and 30 an hour in total, stops by itself when the agent key's
  allowance drops below 0.2 NEAR, and is not started with less than 15 seconds left.
- Nothing the Canary puts on chain is derived from the visitor's text alone: the transaction carries
  a salted hash, fresh for every attempt and not stored, so nobody can confirm a guessed text from a
  public explorer.
- The Canary's ledger cannot be made public: a model can quote what visitors type, and a public
  append-only ledger could not take it back, so the database refuses it on every path, the console
  included. Attempts are stored as hashes and labels only. The public feed shows labels, outcomes and
  transaction hashes, with no visitor or IP identifiers; an attempt still running is left out until it
  is 90 seconds old, then shown as killed. The leaderboard is read on the server only.
- One Canary attempt is bounded at 50 seconds: the model calls share 30 seconds, a chain step takes
  at most 8 seconds, and an attempt that runs out of time ends as failed (or "unconfirmed" for a
  transaction) and is not retried. An attempt that gives up on a step still running keeps the
  Canary busy for 90 seconds instead of starting another cycle beside it.
- The Canary has a public page at `/canary` and its rules at `/canary/rules`. A visitor writes a
  message to a deliberately gullible model and sees what the model wanted, what the code rules decided
  and what the contract did. The vault's balance and mandate are read from the chain, and the
  scoreboard and the latest attempts come from the database behind a short cache. When the live
  Canary is paused, a replay is chosen, or no vault is set, the page shows the recorded attacks
  instead. The page is not open yet: it waits for the Canary vault and `NEARAI_API_KEY`.
- The Canary closes itself instead of running dry: it does not run while its ledger key holds under
  0.5 NEAR; it answers 429 with `Retry-After` over 6 attempts an hour from one address (an IPv6
  address counts by its /64), 60 an hour or 600 a day in total; it closes when its ledger holds 300
  entries; and its model calls share a daily token budget that counts an attempt from the moment it
  starts.
- The site has a public Usage page at `/usage` that counts team vaults, external owners and Canary
  participants apart, for the network the app runs on. It shows counts and not dollar volumes, with
  the last 7 days beside each total, the model tokens a decision uses, and how each number is
  counted; a price in dollars appears only once one is set from NEAR AI's price list. A daily job
  computes the numbers, and the page refreshes them when they are an hour old. The Canary rules link
  to it.
- Each Canary attempt is recorded with the network of the Canary vault it was made on, so a mainnet
  Canary and a testnet Canary keep separate numbers on the Usage page.
- The daily usage job also deletes the rate limiter's rows older than a day, so that table no longer
  grows without limit. Applying the database update computes the usage numbers of the existing
  history.
- The watcher, `GET /api/cron/watch`, reads every vault's spends, mandates, anchors, refusals by the
  contract, low agent and ledger key allowances and low NEAR, and records each once in
  `vault_events`. It runs daily on Vercel, every minute once the owner turns on the Supabase Cron
  job in `docs/ops/watcher.md`, and right after an invoice upload or a Canary attempt for that
  vault.
- Owner alerts: an owner or approver can get a Telegram message or an email when a spend is held
  for approval, the contract refuses a spend, a spend is paid or paid out to Base, a payout fails,
  an agent or ledger key's gas allowance runs low, or the vault runs low on NEAR. Each goes out
  once per alert and event, not for a vault's old history, and a viewer sees addresses and chat
  ids masked. Every message says how to stop: the email's own stop link (and a mail client's
  one-click unsubscribe), the bot's `/stop`, or Remove on the new Alerts tab
  (`/console/<vault>/alerts`). The channels switch on once the owner sets `TELEGRAM_BOT_TOKEN` and
  `RESEND_API_KEY` (`docs/ops/alerts.md`).
- The web console serves testnet and mainnet from one deployment. The network of a request is the
  address it was opened at (`APP_ORIGIN_MAINNET`, `APP_ORIGIN_TESTNET`), with a Testnet | Mainnet
  switch in the header once both are served. Sessions, vault pages, the watcher and metrics jobs,
  alerts, the Canary board and `/usage` are per network, and a vault of the other network shows a
  card with a link to its own address. The per-network settings (`NEAR_RPC_URLS`,
  `PROBARION_FACTORY_ID` and four more) each have a `_MAINNET` and a `_TESTNET` form
  (`docs/runbooks/web-deploy.md`, section 3.5).
- The SDK takes a deadline: `RpcClient` `remainingMs`, `NearApiJsSender` `sendTimeoutMs` as a
  function, and `NearAiProposer` `remainingMs` and `knownModel`. All are optional, and the
  defaults are unchanged.

- Uptime monitors can check each address of the site: `GET /api/health` answers 200 when the
  deployment can read its settings and 503 when it cannot; `GET /api/health/rpc?provider=<n>` checks
  one NEAR RPC provider of that address's network (the right chain, and a block under two minutes
  old); `GET /api/health/nearai` checks that NEAR AI Cloud's public model list answers. Answers are
  cached for 30 seconds and do not include a key or a configured URL.
- A `/status` page on each address shows the live checks for that address's network, links to the
  other network's status page when that address is served, and says that funds stay in your own
  vault, under your own keys, if the service is down. The header's Status link opens it.
- Errors reach Sentry once `SENTRY_DSN` is set; until then the SDK is off. Each logged error becomes
  one issue per log key, tagged with its component. The Payables upload, the Canary attempt and both
  cron routes also tag the request id of their log lines, so one error can be matched to its logs. A
  failure of the root layout shows a plain "Something went wrong" page with a reference id.
- `docs/RUNBOOK.md`, an incident runbook for both networks: severity levels, the first 15 minutes,
  what a vault owner can do alone, freezing, withdrawing and unfreezing with the CLI printers (the
  owner signs every transaction), key rotation, RPC failover, burned cross-chain payouts, alerts,
  top-up, rate limits, deploys and migrations, status posts and a postmortem template. The runbook
  lint now checks it too: **OWNER SIGNS** above every mainnet send, and 1 yoctoNEAR on every one-yocto
  call.
- `docs/ops/MONITORING.md`: the health routes, the uptime monitors before and after each network gets
  its own address, the watcher heartbeat, the status page to create, and what Sentry receives, with
  its tags, alert rules and data scrubber fields.
- `/.well-known/security.txt` (RFC 9116) on every address, with the X account as the contact, a fixed
  expiry, one canonical URL per address, and links to the policy and its acknowledgments.
- `docs/THREAT_MODEL.md`: eleven attacks, each with the test, code path or testnet transaction that
  backs it; the hosted service's own surfaces; what a full breach of Probarion's servers could and
  could not do; failure modes, trust assumptions, known gaps; and the first security review's log. A
  test fails if it cites a safety claim that has no marker in the code.
- `/security`, `/terms` and `/privacy` pages. Every link on the site now opens a real page; nothing
  reads "coming soon" any more. Security sits in the footer beside Terms and Privacy.
- A browser smoke test of the built site runs locally with `pnpm --filter @probarion/web test:e2e`,
  after `pnpm build`. It builds with test settings only, and needs no wallet, database or chain. It
  serves both networks, testnet at `localhost:3100` and mainnet at `127.0.0.1:3100`, and checks that
  the header fits on each address at 375, 1120, 1280 and 1440 px. It is not in CI.

- A signed-in Browser extension page, `/extension`, connects the Probarion browser extension to
  your account on one network. Connect makes a 30-day connection and hands it only to the page
  itself, for the extension to take; "Show a code instead" shows a one-time pairing code that works
  for ten minutes, and warns that whoever enters it first gets the connection. Connected browsers
  lists each connection by its last four characters and its times, and Revoke ends it. The page
  says the extension is not released yet. The console header links it.
- The extension's server side, at the address of each network: `POST /api/ext/pair` exchanges a
  pairing code once for a connection token; `GET /api/ext/inbox` lets a token read what waits for
  you on its network: invoices waiting for the owner, held payments an approver can still approve,
  and the mandates an invoice can still be sent under; `POST /api/ext/revoke` ends the caller's own
  connection. Pairing is rate-limited per IP address and for the whole network, the inbox per account
  and network, and Connect and Show a code share one limit per account and network. An account keeps
  at most 5 connections per network: a sixth ends the oldest.
- Migration `20261108000013_extension_tokens.sql` stores the connections and pairing codes.

### Changed

- The ledger test gives its verdict in one plain sentence beside PASS or FAIL, read from the
  verifier's result, such as "Entry 2 was changed after it was signed, so its signature no longer
  matches." It names a cause and an entry only when the verifier's own words name them, and
  otherwise gives the counts. The counts and the verifier's words on each check that did not pass sit behind "Verifier
  detail". The test printed the counts as its verdict and the verifier's words under each failed
  check.
- Sessions name their network and belong to one address, so a person signs in at each network's
  address with a wallet of that network. After this change everyone signs in once more. A vault's
  routes and actions answer `409 wrong_network` at the other network's address, and a registered
  vault keeps its network: Register at the other address cannot move it (`network_mismatch`).
  Per-account rate limits are counted per network, and Register has its own.
- The console asks for confirmation in its own dialog instead of the browser's confirm box. The
  dialog is titled with the action, shows the same question as before, and says that the wallet asks
  for the signature next and that nothing is sent until then. Revoking a mandate, removing an agent
  key, and rejecting a spend or an invoice get a red dialog with a "Cannot be undone" line. Esc, a
  click outside the dialog and Cancel all cancel; the focus starts on Cancel and goes back to the
  button that was clicked, and the action button is held back for a moment after the dialog opens, so
  a double click on the opener does not confirm it.
- The site and console are served at <https://probarion.xyz>; `www.probarion.xyz` redirects there,
  and <https://probarion.vercel.app> still answers.
- The vault factory is deployed on NEAR testnet as `vaults.probarion.testnet` (code hash
  `FK6mMqUd…`). It serves the vault build with the `set_ledger_key` fix (code hash `3cQXYDvf…`) as an
  embedded version, so each new vault stores its own copy of the code and needs about 3 test NEAR.
  The console's Create a vault and the CLI's `vault create` use it. A smoke vault,
  `smoke-embedded.vaults.probarion.testnet`, has no access keys. The README, the site's status list
  and `contracts/deployments/testnet.json` record it; `v0.probarion.testnet` still runs the earlier
  build.
- The README, `SECURITY.md` and the site say what an offline check shows: `verify --offline` checks a
  snapshot against itself, so a forged snapshot with re-signed entries passes, and only `verify --vault`
  reads the chain. They also say that `verify --vault v0.probarion.testnet` fails checks d and h today,
  because the smoke run sent its spends without a ledger.
- The wallet provider moved to `/console` and `/login`, with one connector per network. First-load JS
  of `/` went from 148.5 KiB to 139.5 KiB gzip.
- The web build downloads Hanken Grotesk and IBM Plex Mono from Google Fonts and serves them itself, so
  `pnpm verify` reaches the network for that step.
- The repository pins pnpm 10.34.9 through `packageManager` in the root `package.json`. CI, the
  release job and Vercel builds run exactly that version, which is patched against the pnpm advisories
  GHSA-vq4v-j7r6-jq4m, GHSA-c59q-g84q-2gj5 and GHSA-vx52-2968-3vc6. The pinned tests refuse a
  workflow that names its own pnpm version, and they refuse a pin outside pnpm 10. The web deploy
  runbook sets `ENABLE_EXPERIMENTAL_COREPACK=1` on Vercel and checks the build log for that version.
- `verify`: check h reports a burn it cannot prove as `unproven`, lists it in `VerifyReport.unproven`,
  and `VerifyReport.ok` is false while any check fails or is unproven. A burn transaction that cannot
  be read right now is unproven (`tx_unavailable`). A burn record that names a transaction holding no
  burn pair, a transaction the node does not know, or a hash that is not a NEAR transaction hash
  fails h.
- `verify`: checks g and h trust only the network's own intents contract and POA assets. The online
  check O1 holds the TDX quote to the DCAP policy and to its report data, and O2 binds the NVIDIA
  payload to the request's nonce. Measurement pinning (O1b) is deferred, so `quote_verified` stays
  false.

- `SECURITY.md` now gives response targets (acknowledge within 72 hours, a severity within 7 days,
  a SEV2 fix within 14 days, disclosure once fixed or after 90 days), a safe harbor for good-faith
  research that covers the Canary under its rules, the Canary as a public testnet challenge with no
  reward, the practices CI runs, and acknowledgments.
- The deploy runbook's smoke test checks the health routes and security.txt. The key rotation
  runbook says that a new master key also resets duplicate matching by invoice number.

- Signing in from the Browser extension page brings you back to it, with the extension's request
  kept. Every other sign-in still returns to the console.
- `/privacy` has a new last section, "Browser extension". For each connected browser it says what
  Probarion keeps: a sha256 of the connection token, its last four characters, a browser name and
  its times, kept after the connection ends. For a pairing code it keeps a sha256, your account, the
  network and the times, and deletes the record, once the code is used or expired, the next time a
  code is made. A connection cannot pay, approve or confirm a payment. It ends after 30 days, when a
  sixth connection on the same network replaces it, or sooner with Revoke. The rate-limit sentence
  names code pairing, counted per IP address like sign-in.
- The threat model, the incident runbook, the key-rotation runbook, the monitoring guide and the
  security policy cover the extension's connections: what a token can read, that it cannot pay,
  approve or confirm, how to end one or all of them, and that a new master key does not end them.
  The runbook has a new entry, "An extension token leaked" (SEV3). Ending every token deletes the
  pairing codes first, in one transaction. For a stolen session it ends the sessions first, then
  either ends every token with that SQL or waits out the session's pairing codes (10 minutes) before
  revoking its tokens at that network's address. The threat model lists, as a known gap, that a few dozen
  addresses can hold code pairing at its network-wide limit while Connect keeps working.

### Fixed

- The Canary page shows its form only when the Canary vault and `NEARAI_API_KEY` are set, the
  database holds a private Canary tenant for that vault on the page's network, its ledger has room,
  its ledger key has gas for anchors, and the vault holds a mandate. It went live as soon as the vault
  was set, with a form that could only answer "not ready" when the key, the tenant or the mandate was
  missing. The page asks once a minute, with the same tenant and ledger key checks the attempt route
  makes; otherwise it shows the replay.
- Once the Canary's ledger is full, the page says the live Canary is closed instead of showing the
  form.
- The Canary replay shows attacks from the team's own tests, starting with the smoke run's refusal on
  testnet: the agent key cited mandate 999 and the contract answered `NoMandate`. A test holds every
  transaction in the list to a deployment record. The list was empty. Under the banner the page
  offers the ledger test, which needs no wallet, and @probarionhq on X, and it shows the "paid to an
  attacker" and Freysa cards, which hold whether or not the Canary is live.
- The live Canary page says why it shows no ledger: the model's answers in it can quote what visitors
  wrote, so it stays private.
- Sign-in explains two more answers of the server in words: `unavailable` (sign-in could not finish,
  so you were not signed in) and `payload_too_large` (the wallet's answer was too large to be a
  sign-in). The page showed the bare code before.
- The mandate form refuses a purpose document over 4 MiB. It took 25 MB, but the Payables upload
  takes the invoice and its purpose document together in 4 MiB, so a mandate made from a larger
  document could not be paid through Payables. The form still only hashes the file, in the browser.
- The `near_low` alert links to "Send NEAR to this vault" on the vault's Overview. It linked to
  Top-up, which funds USDC only.
- The Canary rules ask for a report the way SECURITY.md does, with a direct message to @probarionhq on
  X. They named an email address that does not exist.
- The package READMEs build the packages from a clone, as none is on npm yet; they showed
  `npm install`. The SDK quick start no longer passes an empty `NEARAI_API_KEY`, which throws a
  `ConfigError`. The SDK README says that a code hold has no approval to give, and that an
  unconfirmed spend is found by listing the vault's spends and matching `ref`: `spends.get` takes a
  spend id, and the contract has no lookup by ref.
- `freeze` takes no deposit, but a function-call key can sign it only when it may call the vault. The
  CLI's `vault freeze` help, SECURITY.md and the README said any owner key could freeze. The CLI's
  note also says that `reject` and `expire_held` still work while the vault is frozen.
- THREAT_MODEL: the SDK and the CLI read the bare `NEAR_RPC_URLS`, and only the web app reads the
  per-network names; the SDK already marks a ledger fork risk (`LEDGER_FORK_RISK`); and CI runs on
  pull requests into `dev` and `main` and on pushes to them. The README and this changelog said CI
  runs on every push.
- This changelog no longer contradicts itself about the Canary page, the pages that once read
  "coming soon" and the factory's fixed vault build, and the 0.1.0 heading says it is not released
  yet.
- With both networks served, the site header no longer runs past the window between 1101 and 1360 px
  wide, where the network switch left no room for the links. At those widths the links move into the
  menu, as they do below 1101 px. With one network the header is unchanged.
- The browser-tab icon has a clear background instead of a white square, and its mark is larger. The
  bar under the coin is ink in a light browser theme and paper in a dark one.
- Signing in now lands on the console. A prefetched redirect could leave the visitor on `/login` with
  no error.
- `/proof/<vault>` says the checks did not run, and its `snapshot.json` and `ledger.jsonl` downloads
  answer 503, when the database or the server's environment fails. They answered 500 before.
- A failed sign-in challenge says sign-in is unavailable and nothing was signed. The sign-in page no
  longer names wallets the picker may not offer.
- Web console: no link answers 404. While the Canary, the open metrics (now `/usage`), Payables,
  Top-up, Alerts, Security, Status, Terms and Privacy pages were being built, a link to one showed as
  "coming soon" and the landing page did not present it as available. Each is now a real page.
- Proof page: text from a ledger or the chain cannot disguise a result. Bidi and control characters
  are replaced, long values are cut, and only well-formed transaction hashes and account ids become
  links. A database or chain failure shows "No result" with the reason, and it is not shown as a pass.
- SDK: a Next.js app that uses `@probarion/sdk` keeps its own source tree out of its server
  functions. The file ledger store's dynamic path carries a `turbopackIgnore` hint. With it, the proof
  page's server functions trace a few dozen files instead of the whole app (about 225 files before).
- Vault: `set_ledger_key` deletes the old ledger key and adds the new one in two separate receipts,
  the delete first. A failed delete no longer rolls back the new key and leaves the vault unable to
  anchor, and a rotation fits on a vault with no spare NEAR. `v0.probarion.testnet` runs the build
  from before this fix. The fixed build (code hash `3cQXYDvf…`) is version 1 of the testnet factory
  `vaults.probarion.testnet`, so every vault the factory creates runs it.
- Web console: a payment is signed with the key its mandate is bound to; a key made active again keeps
  its first activation date; and a discarded key that shows up on chain is reported, for the owner to
  keep or remove.
- Web console, keys: only the ledger key can be loaded as "the active key"; every payment loads the
  agent key named by its mandate, not the ledger key. A ledger key that is
  stuck now says what to do for this vault's code: a vault built before the `set_ledger_key` fix needs
  a new vault, and a vault on the fixed code can set a new ledger key. A `set_ledger_key` that
  recovers a stuck key, whose only failed receipt is the delete of the missing old key, is shown as
  done, after the page checks that the new anchor-only key is on the vault.
- Web console, mandates: an expired mandate that still has payments waiting for approval shows
  Revoke, because the contract can still approve them. The "Sign mandate" button stays locked after
  a reload or an edit while an earlier create may have landed, so a mandate cannot be created twice
  by accident. The form refuses an expiry less than an hour away and a payee that is the vault's own
  USDC, Intents or asset contract; it warns when a 0x address is typed as a NEAR account (that is
  not a Base payout) or when the NEAR account does not exist; and it says plainly when the vault does
  not allow Base payouts. Revoke and the form appear only when your account is the vault's owner on
  chain.
- The SDK's chain reads fail closed: a malformed node answer is an error, and a node's own error is
  kept after the read fails over to another endpoint rather than reported as an outage.

- A database test of the alert list could fail when two subscriptions were created in the same
  instant and tied on their creation time.

- A canary test could fail about once in 58 runs, when the agent key it changed already ended in
  the character it wrote, so the key it called inactive was the active one.

### Security

- Key sealing: the web console generates agent and ledger keys on the server and seals them at rest
  with libsodium secretbox, under subkeys of one master key, `KEY_ENCRYPTION_SECRET`. A key becomes
  active only when the chain shows that exact function-call key on the vault, limited to `spend` or
  to `anchor`.
- Key rotation: `pnpm --filter @probarion/web rotate-keys` dry-runs by default, re-seals under the new
  master only after every row verifies, writes all rows in one compare-and-set call, prints counts
  only, and does not generate a master. The steps, including what to do after a leak, are in
  `docs/ops/key-rotation.md`.
- Release pipeline: `release.yml` publishes only from a `sdk-v*` tag on `main`, through the protected
  `npm-release` environment, with npm provenance, and the job that publishes runs no repository code.
  The release check gates the versions, this changelog, open `TODO(release)` notes and the packed
  tarballs. A version already on npm is skipped only when npm holds the same bytes. `release.yml` is
  pinned by sha256, every step runs with `pipefail`, and a test refuses any step that would swallow a
  failure. Third-party actions are pinned by commit SHA, and the cargo-near download is checked by
  sha256.
- CI scans the whole git history for secrets with gitleaks.
- The console refuses, at start, settings that could point a network at the other chain: an
  unsuffixed per-network setting while both networks are served, a mainnet account id ending in
  `.testnet` or a testnet one ending in `.near`, and an RPC host named after the other network. The
  error names the variable, not its value. Sign-in, Register and the approvers re-sync read the chain
  only through RPC URLs that answered the JSON-RPC `status` call with that network's `chain_id`, and
  answer `503 wrong_chain` once any URL has answered with the other chain.

- Before an error report leaves for Sentry, the user, cookies, headers, request bodies and query
  strings are removed, console breadcrumbs are dropped, a request breadcrumb keeps only the origin of
  another host, and every known secret value and secret shape is masked. Tracing and browser sessions
  are off. The request that starts a server instance is left untagged, so its tags cannot reach other
  requests' reports.

- An extension connection token is stored only as a sha256 and its last four characters, and a
  pairing code only as a sha256. Logs and error reports mask any connection token they contain, and
  tag the extension's errors as their own component.
- A connection token cannot pay, approve or confirm a payment. `apps/web/test/ext-structure.test.ts`
  reads, with the TypeScript parser, every app module the extension's server code can load, and fails
  if one imports a module or function that pays, signs or opens a sealed key, imports anything from
  near-api-js, names an RPC method that sends a transaction or a database function or column that
  returns a sealed agent key, builds its own database client, asks for a subkey other than the
  session's, loads a raw crypto package outside lib/crypto, uses the cookie session, or loads code
  dynamically. It reads imports and names: it catches a plain import, not code written to get around
  it, so review of every change to that code is the other control.

## 0.1.0 - not released yet

### Added

- `@probarion/core`: TypeScript mirrors of the vault and factory contract views; RFC 8785 canonical hashing; ed25519 keys; the signed, hash-chained ledger with the ledger-derived attestation nonce (bound to the vault account); the deterministic policy engine `decide()` with its built-in rules and custom rules; the model proposal parser; offline attestation checks A1 to A7, and the request-binding check A8 for auditors; and the snapshot verifier `runChecks` with checks a to i.
- `@probarion/sdk`: a NEAR JSON-RPC client with failover and backoff; vault, intents and factory clients; function-call key signing through near-api-js 7; the NEAR AI Cloud adapter (private TEE models, a nonce-bound attestation report, the `provider_tee` signature); the JSONL file ledger store (locked, which needs a local file system with hard links) and the in-memory store; the `Probarion` class with `process`, `requestSpend`, `checkSpend`, `mandates`, `spends`, `anchors`, `rules`, `snapshot` and `verify` (with optional online TEE quote checks through `@nearai/inference-sdk`); and `@probarion/sdk/testing` test doubles (fake chain, fake NEAR JSON-RPC server, fake NEAR AI Cloud).
- `probarion` CLI: `vault create`, `mandate create`, `mandate revoke`, `agent add`, `agent remove`, `ledger set-key`, `spend approve`, `spend reject`, `vault freeze`, `vault unfreeze`, `vault withdraw` and `vault withdraw-intents` check their input against the contract and print the transaction for the owner or approver to sign with `near-cli-rs` (1 yoctoNEAR where the contract requires it); the CLI does not sign. `agent keygen` makes an ed25519 key pair (`--out <file>` or `--print-secret`). `check` dry-runs a spend against the contract; `verify` runs checks a to i on a live vault or, with `--offline`, on a saved snapshot, prints a table or `--json`, and exits 0 (pass), 1 (a check fails or verify cannot run), 2 (a burn is unproven) or 64 (usage); `--online` adds the TEE quote checks O1 and O2 when `@nearai/inference-sdk` is installed and says when they did not run. `ledger export` copies the ledger to a new file.
- Packaging: ESM only, Node 24 or newer. Each tarball holds `dist/` (without source maps), `README.md` and `LICENSE`, and is published from CI with npm provenance when the repository is public.
<!-- TODO(release): replace "not released yet" above with the day the tag is pushed -->
