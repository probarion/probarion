# Changelog

All notable changes to this repository: the NEAR contracts in `contracts/`, the npm packages
`@probarion/core`, `@probarion/sdk` and `probarion` (the CLI), and the web console in `apps/web`.
The MCP server `@probarion/mcp`, in `packages/mcp`, is not on npm yet.

Versions follow semver. The npm packages share one version, released by the tag `sdk-v<version>`;
0.1.0 was published on 2026-11-09. A contract crate carries its own version, and each build of it is identified
by the code hash of its reproducible build in `contracts/code-hashes.json`. The web console is not
versioned yet, and it deploys from `main` to <https://probarion.xyz>. While the version is 0.x, a minor version may change the API.
The software is an unaudited beta.

## Unreleased

### Added

- A testnet record of the Canary, in `docs/evidence/canary-vault`: its accounts, its mandate, the
  2026-11-10 rehearsal whose raw spend the contract refused with `OverPerPayment`, and a live
  `verify` run with its snapshot. The run passes check f (no full-access key, only the ledger key and
  a spend-only agent key) and fails check c, because the Canary's ledger is private and the run
  checks the chain's 4 anchors against an empty ledger; the folder's README says which checks that
  leaves meaningful. The threat model's claim C9 now says Yes for the Canary vault, with that run,
  and the README has a section for it.
- A phone-sized approval page for each held spend, `/console/<vault>/approve/<spend>`, which the
  "Approval needed" alert now links to, by Telegram and by email (roadmap G2). An approver taps the
  link, signs in with their NEAR wallet when they have no session in that browser, and approves or
  rejects in their own wallet, through `@hot-labs/near-connect`. On a phone that is Meteor Wallet,
  its app or its web wallet, on testnet, where the console runs; NEAR Connect offers HOT Wallet on
  mainnet only. It has not been tried on a phone with a real wallet yet.
  - The amount, the payee, why the spend is held, the time the hold has left and the Approve and
    Reject buttons, each the full width, come first, on a phone's first screen; the invoice and the
    mandate's caps follow. One line says what the wallet signs. Long account ids wrap. The page
    is held to WCAG AAA: every text colour reads at 7:1 or more, text is 14px or more with a line
    height of 1.5, and every control is 44px tall.
  - The page reads the spend from the chain (`get_config`, `get_spend`, `get_mandate`, at final
    finality) and shows the amount, the payee, the mandate, why it is held (its amount is above the
    mandate's `approval_above`), when the hold ends, and the invoice hash and ref the vault recorded.
    It names and links the console's invoice only when the console sent this spend from it (the
    chain's hash and ref, and the console's outcome for that invoice is this spend), and shows the
    invoice's own amount beside the spend's. An invoice that only has the same hash and ref, which an
    agent can reuse, is shown with a warning. Amounts to an Intents payee are read in the payee's
    asset, not the vault's token.
  - Approve is offered only for a spend the chain reads as held, and approve and reject only to an
    account on the vault's approver list on chain. An approver the console still lists, whom the chain
    no longer does, gets neither. Approve is not offered while the vault is frozen, after the hold has
    run out, or for a revoked mandate, and reject stays. Other members see the spend and who may
    approve it; anyone else gets a 404, as on every vault page. A spend id that is not a whole number
    from 1 is a 404 before any chain read.
  - The server signs nothing. The page hands the approver's wallet the vault's `approve` or `reject`
    with exactly 1 yoctoNEAR, the wallet must be the signed-in account, and the vault checks all of it
    again when the transaction runs.
  - A signed-out tap goes to sign-in and comes back to the same page.
  - The overview's held card links each held spend to its page.
- `@probarion/mcp`, an MCP server that gives an AI agent a Probarion vault to pay from, in
  `packages/mcp`. It is not on npm yet and runs from a clone: `node packages/mcp/dist/bin.js`, over
  stdio. Five tools: `list_mandates` (payee, caps, what is left, uses left, approval threshold,
  expiry), `check_spend` (the vault's free `check_spend` view), `request_spend`, `get_spend_status`
  and `verify`. No tool takes an address, every input rejects fields it does not know, and amounts go
  in as USDC decimal strings (claim `MCP-NOADDR`, `packages/mcp/test/safety.test.ts`). No tool
  creates, changes or removes a mandate, a key or the vault's settings.
  - The server holds the vault's `spend`-only agent key and `anchor`-only ledger key, and no owner
    key. Without the two keys it runs read-only and `request_spend` is off.
  - `request_spend` names a mandate by id and runs `decide()` from `@probarion/core` and the
    vault's `spend`, signs the decision into the vault's ledger and anchors it. No invoice text or
    purpose document is read, so the purpose rule passes. The MCP client's reasoning is stored as an
    unattested proposal prefixed `mcp:`, so `verify` reports these decisions as rules-only. A second
    request with the same ref pays nothing; it is refused and names the vault's spend under that ref
    (`earlier_spend`). A hold with no spend on chain says no approver waits on it.
  - Before each payment the server checks that its ledger file holds every entry the vault's latest
    anchor covers, with the same root, and otherwise stops with `LEDGER_FORK_RISK` and sends nothing.
    That catches another writer once it has anchored; `verify` check d finds one that has not.
  - Settings come from the environment (`PROBARION_VAULT_ID`, the two keys, `NEAR_NETWORK`,
    `NEAR_RPC_URLS`, `NEAR_ARCHIVAL_RPC_URLS`, `PROBARION_LEDGER_PATH`). A key must be a valid
    ed25519 secret key, and an RPC URL must be `https://` (`http://` only on this machine) with no
    user name or password; a problem is named by its variable, with no value. Errors and log lines pass
    through a filter that masks secret keys and cuts every URL to its origin.
  - 91 tests, among them an end-to-end run over the SDK's fake chain and a stdio JSON-RPC session.
- The pay-per-call example in `examples/402` (a private workspace package, testnet only). An HTTP
  endpoint answers `402 Payment Required` with a quote: a price, a payee and a short text. An agent
  pays the text's sha256 through `@probarion/mcp` under a mandate, with `402:<quote id>` as the ref,
  and sends the call again with the spend id and the redeem token the 402 gave it. The endpoint
  serves it only if the token matches, the paying vault was created by the factory (its
  `vault_version` view), and the spend is `paid`, to the seller's account, for the full price and
  for this quote's hash, at a block time before the quote expired; each quote serves one call. The
  agent pays under the lowest-numbered mandate for the payee that can still take the amount, and
  reads a held spend until it is paid before it calls again. Run its test with
  `pnpm --filter @probarion/example-402 run test`: 20 calls are paid and the 21st is refused with
  `mandate.uses_exhausted`. It is not an implementation of x402 or of any other payment protocol.
- A testnet record of that example, in `docs/evidence/402-vault`: on 2026-11-09 the vault
  `percall.vaults.probarion.testnet` paid 20 calls at 0.01 test USDC under a mandate of 20 uses,
  and the 21st was refused by code (`mandate.uses_exhausted`, nothing sent), as the contract's
  `check_spend` view also answered (`UsesExhausted`). Its live `verify` passes checks a to i; the
  ledger, the snapshot (with the 21 anchors) and the setup and spend transactions are in the folder.
- The Docs Center at `/docs`: 34 pages in six sections (Start here, Concepts, Build, Verify &
  trust, Operate, Resources), with a home of four doors (new here, owner, developer, evaluator). Each page
  was written from the code and checked against it in a separate verification pass. Each guide,
  tutorial and explanation marks what is Live, Preview or Planned; the sidebar's legend says what
  Preview means. Every page but the docs home has a source box with the date it was reviewed, the
  commit it was built from and the files it was checked against, and a "Copy page" button.
  - The reference tables are rendered from typed lists that tests pin to the code, so a table that
    drifts fails CI: the vault's 14 checks in their order, every `PROBARION:` code with the call
    that raises it and what to do next, the SDK and HTTP errors, the verifier's checks a to i, and
    the status list.
  - The reference pages: SDK reference (every export of `@probarion/sdk` and
    `@probarion/sdk/testing`), Policy rules (every rule id `decide()` records), CLI reference (every
    command and option, and who signs what it prints), Contract reference (every vault and factory
    method), Events (every NEP-297 event and its fields), HTTP API (every route under `/api`),
    Limits and costs (every cap, deposit and gas figure), Reproducible builds (rebuild a contract
    and match its code hash) and Architecture (a diagram of the parts, each tied to its code). Each
    table is data that its own test, `apps/web/test/docs-ref-<area>.test.ts`, reads against the
    code, so a command, method, event, route, rule or constant added or removed in the code fails
    CI until the page follows.
  - A Changelog page, `/docs/resources/changelog`, renders this file as it stands in the build.
  - Every owner and approver command carries a callout naming who signs it. A test checks every
    CLI line in the pages against the CLI's own commands and options, and each callout's signer
    against the CLI's owner and approver calls.
  - Search opens with Ctrl K or ⌘K, from the docs bar or from the home's search box. It loads a
    static index of every page but the home on first open and finds pages, error codes and CLI
    commands. An exact error code, or a pasted `PROBARION:<Code>` line, ranks that code's row in
    the catalog first, and opening a result moves focus to it. Without JavaScript, the search links
    go to the home's list of popular searches.
  - Every page has a Markdown twin at `/docs/<page>.md` whose first lines name the date it was
    reviewed and the commit it was built from. `/llms.txt` lists the pages, and `/llms-full.txt`
    holds them all for AI agents, with `X-Robots-Tag: noindex`.
  - A section's address, such as `/docs/build`, redirects (308) to its first page.
  - The landing's SDK and CLI cards link the developer quickstart and the install page, and its
    outcome statuses link "What each status means".
  - A Playwright spec, run locally and not in CI, checks the home's fold at 1440×900, the keyboard
    path through search, the sidebar's current link, the table of contents and its scroll-spy, the
    phone drawer, sideways overflow at 390 px, the twins' headers, the section redirects, the
    install page's code tabs, the 404s, the docs without JavaScript and a blocked or missing
    clipboard.
- A Canary attempt stores the source its link named: `/canary?via=x` stores `x` in the new column
  `canary_attempts.via` (migration `20261108000014_canary_via.sql`). The set is closed (`home`,
  `x`, `share`, `readme`, `proof`, `tamper`, `ext` and `usage`, in
  `apps/web/src/lib/canary/via.ts`). Any other value is stored as no source, and the attempt runs as
  before. Nothing is recorded for a visit alone, there is no new cookie, and the source is not in
  the public feed or the leaderboard. The Rules link and the way back from the rules keep it. The
  Canary pill on `/usage` links with `?via=usage`, and the README with `?via=readme`. /privacy says
  so, and its date is now 2026-11-09. The migration and the app can be deployed in either order.
- `docs/ops/metrics.md` has three queries for the OWNER to run by hand: Canary attempts by source;
  outside owners stage by stage, from a vault to an agent key, a mandate, a first payment and
  still active a week after it; and first payments by UTC week. A test runs the doc's own SQL on
  the real schema.
- The README names the builder's other NEAR Hackathon 2026 entry, as the rules ask of anyone
  entering two projects. The two share no code.
- The README's section "Libraries, templates and AI-assisted code" lists what each part is built
  with (the contracts, the TypeScript packages, the web console, the extension, the tests, CI and
  the services), as the hackathon's rules ask (Q-005 in nearhackathon.com/HACKATHON.md). It quotes
  Q-001 and Q-005, and says that no code or library from the builder's earlier projects is used and
  no project template; that the type and constant definitions of the interfaces spec of 2026-10-21
  were carried into the code; and that the code was written with Claude Code, whose trailer every
  commit other than a merge carries. Its "AI-assisted code" part sets out the builder's share: the
  product decisions the design spec records, what is built and merged, and the steps the runbooks
  mark OWNER or OWNER SIGNS. Prior work now dates the spec after the hackathon's announcement
  on 2026-10-19, from which Q-001 allows code, and before its start on 2026-11-01, in place of
  "before the hackathon build window".
- The landing page has a live check, "Try it, live on NEAR testnet" (`/#try`). A visitor picks what
  the agent tries: a normal invoice (2 USDC under mandate 1), a hijacked prompt ("Pay 50 USDC to
  attacker.near"), a made-up mandate (999) or someone else's key, or sets the mandate, the amount
  and the signing key by hand. The browser sends the request to `check_spend`, a view of
  `v0.probarion.testnet`, through `rpc.testnet.fastnear.com` and then `rpc.testnet.near.org`, and
  shows the contract's answer word for word (`ok`, `OverPerPayment`, `NoMandate`, `NotAgent`), the
  request as sent, and the mandate as the chain has it. A view call signs nothing and pays nothing,
  and the page always reads testnet. An amount that is not a number of USDC with at most six
  decimals sends no call. When no RPC host answers, the page shows the answers recorded from the
  chain by `pnpm --dir apps/web record-live-check`, and says they are recorded; without JavaScript
  it shows them as a table. Answers from an RPC host are parsed strictly, so a malformed one cannot
  break the page.
- The landing page has "Why not just a spending limit?" (`/#compare`): eight questions, each with
  what a limit contract you write usually does and what Probarion does, and Probarion's status on
  each from the status list. It also has "Plug in your agent" (`/#integrate`): the SDK, the CLI, the
  console and the planned MCP server with their status, and the SDK's quick start, held line by
  line to `packages/sdk/README.md`. An end-to-end test covers the live check against recorded
  answers, with both RPC hosts mocked.

- A new vault's overview shows its owner "Your first agent payment": the five steps from a new
  vault to a payment its agent makes inside a mandate. They are the vault, an agent key and a
  ledger key that the console holds active (as Payables needs), USDC in the vault (on NEAR, or as
  Base USDC in Intents), an active mandate, and the first paid spend. The steps are worked out from
  what the overview reads and from the console's own key rows. The next step links to its tab as
  the ink pill, a step whose read failed says it could not be checked, and the card goes away after
  the first paid spend. It is not shown when the spends cannot be read. It shows on external vaults
  in this network's USDC, to their owner. Create a vault now opens the new vault's page, where the
  card starts; before, it said "Registered" and stayed on the form.
  - On testnet, Mandates offers "Use the sample PO". It fills the form from a sample purchase
    order: 5 test USDC a payment, 20 in all, 5 payments, 30 days, paid to the owner. The PO is
    hashed in the browser as it is served, and the form refuses it unless the hash is the pinned
    one. Payables offers "Use the sample invoice", a 2 test USDC invoice with a fresh invoice
    number each time, sent with the same PO attached. The files are in
    `apps/web/public/samples/`. Mainnet offers neither.
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
- The testnet demo vault `demo.vaults.probarion.testnet`, run end to end through the console on
  2026-11-09: created through the factory, given an agent key and a ledger key, filled from the faucet
  and given a mandate. Payables paid 2 test USDC, then 4 test USDC once its approver approved the hold,
  refused a changed-bank invoice with `mandate.payee_mismatch` in the signed ledger, and refused a
  re-sent invoice on upload. Its proof page is public, and `/proof` on probarion.xyz opens it. A live
  `npx probarion verify` passed checks a to i. The invoices, the ledger, the snapshot and the
  verifier's output are in `docs/evidence/demo-vault`; the transactions are in the `demo_vault`
  block of `contracts/deployments/testnet.json`.
- The landing page's payment journey ends with those four invoices: one card each says what the invoice
  asked, what the vault did (paid, refused on upload, refused by code, held then paid) and links the
  invoice file, its transactions and its lines in the signed ledger, then the demo vault's proof page.
  A test holds each card to the evidence files and the deployment record.
- "The console" on the landing page, after the ink band: three screenshots of the testnet console from
  2026-11-09, taken while a fifth invoice (INV-2004, 4 test USDC) went through the demo vault. They show
  the spend held for an approver, the invoice's page in Payables, and the vault's spends once the
  approver approved it with near-cli. Each caption names the network, the date and the vault, and links
  its transaction where it has one; on a phone the row scrolls sideways. The images are WebP files in
  `apps/web/public/shots/`, and a test reads each one's size from its header.
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
  instead. The page opened on NEAR testnet on 2026-11-10 (see Changed).
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
- The watcher, `GET /api/cron/watch`, reads each vault registered with the app: its spends,
  mandates, anchors, refusals by the contract, low agent and ledger key allowances and low NEAR,
  and records each once in `vault_events`. It runs daily on Vercel and right after an invoice
  upload or a Canary attempt for that vault. `docs/ops/watcher.md` also sets out a per-minute
  Supabase Cron job, not yet run or tested.
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
- A connection can queue an invoice for the vault's owner: `POST /api/ext/invoices` takes the
  vault, the mandate the member picked and the file (a PDF or a text file, at most 4 MiB), for a vault
  where the connection's account is the owner or an approver, 20 per account and network in 10
  minutes. It reads the invoice as the console upload does, runs the mandate's payee check (core's
  `payeeHintContradiction`) and the vault contract's free `check_spend` view, and stores the
  invoice waiting for the owner, with the checks it passed and the hold `extension.mandate_chosen`.
  It runs no cycle, calls no model, opens no key and sends no transaction. Only the owner's
  wallet-signed Confirm in the console pays it, and the contract checks that spend again. The same
  invoice sent twice gives one row, and the second answer says it is a duplicate.
- An invoice with an unclear amount, a mandate that cannot take invoices (revoked, expired, used up,
  or with a payee Confirm cannot name), keys Confirm cannot sign with, a payee that contradicts the
  mandate's, or a spend the contract would refuse is refused with its reason, and nothing is stored.
  A Canary vault takes no invoices from the extension.
- Migration `20261108000015_extension_queue.sql` adds `invoices.source` and
  `invoices.queue_checks`, and `invoice_queue`, which stores an extension invoice in one
  transaction and refuses one without the `extension.mandate_chosen` hold.
- The Chrome extension, `apps/extension` (Manifest V3, Chrome 127 or newer), loaded unpacked; it is
  pending Chrome Web Store review since 2026-11-10. Connect it from the console's Browser extension page, or with a
  one-time code. Its badge counts the invoices and holds that wait for you and refreshes every 5
  minutes; `!` on the badge means the connection has ended. Right-click selected invoice text or a
  link to an invoice file on the same site, or open the popup on a PDF or choose a file: the popup
  reads the invoice, lets you pick a vault and a mandate, and queues it for the vault owner's
  wallet-signed Confirm in the console. It can't pay or approve, and says so under Send. It explains
  a refused invoice in plain words, shows "Already queued" for a second send of the same invoice,
  and checks in the browser what Probarion would refuse anyway (4 MiB for a file, 50,000 characters
  of UTF-8 text).
- `pnpm --filter @probarion/extension build` writes the release build to `apps/extension/dist`;
  `build:dev` also trusts `http://localhost:3000`. `zip` packs the release build into the store
  zip, the same bytes each time, and `render` redraws the icons and the five store images with a
  local headless Chrome. `apps/extension/store` holds the listing, the permission and data-use
  answers, the notes for the store reviewer and the upload steps; `apps/extension/TESTING.md` is the
  manual checklist, run before each upload.
- The I-HITL replay, a sandbox test in `contracts/integration-tests/tests/ihitl.rs`
  (`ihitl_replay_the_agent_cannot_raise_its_own_limit_or_approve_itself`). It replays, with the
  vault's agent key, the attack of the I-HITL paper (Breckenridge et al., arXiv:2610.35835), whose
  agents raised their own wallet limits by reading the passcode emailed to the owner. The test checks
  that a spend over `max_per_payment` fails with `OverPerPayment` and that one above `approval_above`
  is held. It checks that the node refuses each of the agent key's attempts to approve its own
  spend, create a bigger mandate, add keys, unfreeze, withdraw, call the USDC token, add a
  full-access key, deploy code, send NEAR or batch a key with a spend, before any contract code runs
  and with its exact `InvalidAccessKeyError` variant. It then checks that the mandate, the config,
  the agents and the held spend read back byte for byte as before, that the keys keep their nonces
  and scopes, and that only the approver's account's `approve` pays. Like the other sandbox tests, it
  runs in CI on Linux. The /docs page "The agent key cannot approve itself"
  (`/docs/trust/self-approval`, in Verify & trust) maps the paper's recorded run, and the steps the
  test adds, to the control that stops each, the layer and the evidence, with the testnet
  transactions that show three of the test's steps. It says how to run the test, and lists what it
  does not cover: an owner or approver key within the agent's reach, a payment split under
  `approval_above`, the MCP client's config, the email stop link and the single approver, and that
  it replays no model and runs only on a sandbox. The
  README's safety architecture and attack 7 of the threat model cite it, and the threat model's known
  gaps add the first two.

### Changed

- The Canary is open on NEAR testnet at `/canary` on probarion.xyz, in live mode, since
  2026-11-10. Its vault is `canary.vaults.probarion.testnet`, with one mandate that pays
  `probarion-payee.testnet` at most 1 test USDC a payment and holds every spend. In the team's
  rehearsal that day, a fake invoice asked for 50 USDC: the model proposed paying 50 USDC, the code
  rules refused it (`invoice.amount_invalid`), and the contract refused the same spend on chain with
  `OverPerPayment`
  ([transaction](https://testnet.nearblocks.io/txns/6XuxN42dDWaboaqaiCuRGKCoA1UrypcDfvat48v6z8DH)).
  The README, the status list on the site, the `/docs` pages and the policy reference call it Live
  on testnet instead of not open yet. The threat model's claim C9 names the Canary vault (its
  `verify` run is under Added), and the deploy runbook says `CANARY_MODE` is `live` on
  probarion.xyz. The README's beta note says the demo vault's proof page and the Canary are public.
  Mainnet has no Canary vault, so `/canary` there still shows the recorded attacks.
- The "Approval needed" alert, by Telegram and by email, links the held spend's approval page,
  `/console/<vault>/approve/<spend>`, in place of the overview's held card. An event without a spend
  id still links the held card (`/console/<vault>#held`).
- The browser extension is pending Chrome Web Store review (submitted on 2026-11-10), so the site
  says what it does in the present tense. `/privacy#browser-extension`, which the store listing
  links, adds that a file read from a tab or a link is fetched with your own session for that site,
  and that the extension reads the address of the tab you are on when you open it; its date moves to
  2026-11-10. The `/extension` page says the extension is pending review and can be loaded unpacked
  from `apps/extension`. The Docs Center's What works today lists the extension for Chrome as Preview,
  and its HTTP API page drops "not released yet". The store's connect screenshot is rendered again
  with the page's new lead.
- Every console page's text reads at WCAG AAA: 7:1 or more for normal text, as on the phone
  approval page. The shared colour tokens in `apps/web/src/app/globals.css` are darker: `mute` and
  `plan` go from #5f5c55 to #4e4b45, `ok` from #17693f to #125935, `bad` from #a32a1c to #8e2317,
  and `wait` from #7a5a18 to #5e4210 (the value of `gold-ink`). Each reads at 7:1 or more on paper,
  on a white card and on its own pale background, so the Notice and Badge tones (5.4:1 to 5.9:1
  before) and the console header's "Signed in as" line (6.2:1 on paper before) pass. The landing
  page and the Docs Center read the same tokens, so their grey and status text is darker too.
  - Grey text at 60% ink, in Payables and the invoice confirm panel, is 75% ink (9.1:1 on a white
    card), and the sign-in page's "Console" label is `gold-ink` (9.3:1).
  - `text-xs` and `text-sm` have a line height of 1.5 (WCAG 1.4.8): 18px and 21px.
  - `apps/web/test/console-kit.test.ts` fails when a tone pair, a button, or any text colour class
    on a console page, the sign-in page or the extension page reads below 7:1 on paper or on a card.
- The MCP server's row in the status list moves from Planned to "Tried on testnet, not on npm"
  (Preview in the docs), and the README's Status row, its NEAR technology rows, its testnet proof and
  its quick start say what the server and the 402 example do. The Docs Center pages that called the MCP
  server Planned (HTTP API, Let an agent pay, Architecture, For AI agents, What is Probarion, What works
  today, Security model) now say it is Preview and not on npm. The threat model cites claim
  `MCP-NOADDR` and drops the MCP server from its planned surfaces.
- The workspace includes `examples/*`, and the CI pin tests cover `packages/mcp` and
  `examples/402`: their test, build, typecheck and lint scripts, and the publish guard of
  `packages/mcp`.
- The landing page states each caveat once. The beta strip says "Unaudited beta on NEAR testnet,
  test tokens only." and that Probarion holds no owner key, links the known gaps, and folds to its
  first sentence on a phone; only mainnet asks for small amounts, and the footer no longer does.
  The status list gives the web console two rows, "Tried on testnet" and "Built, not tried yet",
  says which tests check the page, and ends with a "Known gaps" list: no third-party audit, and
  `v0.probarion.testnet`'s missing ledger, its failing checks d and h, and its older build, which
  the on-chain section and the closing used to repeat. In the payment journey, what is true today
  is a note labelled "Today" with a gold rule, on steps 2 and 5.
- The site header has "Docs" right after the Canary, and Usage moves to the footer's Product
  column. The landing page's closing button "Evaluate in 5 minutes" opens the docs page of that
  name in the same tab, not the README section. The sitemap lists every docs page with the date it
  was reviewed.
- The docs, the README and the landing say that release 0.1.0 of `@probarion/core`,
  `@probarion/sdk` and the `probarion` CLI is on npm: the install page, the developer quickstart,
  the status table, and the landing's "0.1.0 on npm" pill for the SDK and CLI and "Shipped, on npm"
  for the offline verifier. The README's browser checks add the verifier at `/#verify`, and its
  "NEAR technology used, and how" table adds NEP-297 events, near-workspaces and cargo-near and
  says what is not done live yet: the first mainnet payout, a 1Click top-up with a live quote and
  an attested NEAR AI Cloud decision.
- The site writes its CLI commands as `npx probarion …` now that 0.1.0 is on npm: the landing, the
  proof page, /security and the console's CLI fallback, under one line saying that npx needs Node
  24 and asks once before it downloads the package, with no set-up. A mainnet pre-ledger check on
  the proof page also reads the repository's evidence files, so for it the page says to
  `git clone` the repository first. The root `package.json` is renamed `probarion-monorepo`, so
  `npx probarion` also runs at the root of a clone. The README's offline verify step and the deploy
  runbook's smoke step 7 use `npx probarion`, and the install page says so.
- The READMEs of `@probarion/core`, `@probarion/sdk` and the `probarion` CLI install from npm
  (`npm install @probarion/core`, `npm install @probarion/sdk @probarion/core`, `npm install -g probarion`
  or `npx probarion`) and keep the steps to build from a clone. These are the pages npm shows for
  0.1.0. Their release notes are closed, so `pnpm release:check sdk-v0.1.0` passes.
- The landing page leads with what an owner gets: "Give your AI agent a budget, not your wallet",
  with buttons to the live check and to "Plug in your agent". The thesis and the numbers band are
  one section, "The problem": an agent with its own wallet key next to an agent with a mandate. The
  order is the problem, the live check, the comparison, how a payment works, plugging in an agent,
  the payee, the ledger test, the chain and the status list. The header's first link is "Try it",
  the fourth step of "How a payment works" links to the live check, and the closing says what to do
  next above its links.
- The landing's refused card and the README banner show a real refusal from 2026-11-09 in place of
  mandate 999: the agent key asked mandate 1 for 6 test USDC, over its limit of 5 USDC a payment,
  and the contract answered `PROBARION:OverPerPayment` (tx `4715d4nb…Vsr1`, recorded in
  `contracts/deployments/testnet.json`). Step 3 of the README's evaluation and step 5 of the docs'
  evaluation read it from an archival node.
- The site, the docs, the Terms and the READMEs no longer say that anyone can verify the ledger
  without a condition: a ledger is private until its owner publishes it, so they now say the owner
  can publish it for anyone to verify. A test keeps the unconditional claim out of the site's
  code, the docs and the READMEs. The landing's hero also names the category above the headline
  ("A mandate layer for AI agents on NEAR") and says who it is for under the buttons.
- The landing's offline check runs in an empty folder with npx alone. The site serves a
  byte-for-byte copy of the test fixture at `/samples/valid-snapshot.json`, and step 5 prints the
  download and the verify on separate lines, with a note to type `curl.exe` in Windows PowerShell
  5.1. Step 2 of the README's evaluation gives the same two lines for a reader with no clone.
- The ledger test on the landing page and on /proof puts a plain line under each of the nine
  checks, and calls a cross-chain spend a withdrawal ("Withdrawal to Base") in place of "Burned for
  Base" (site audit P1-11).
- A spend that waits for approval now comes first on the vault's overview, right under the tabs.
  A hold that ran out does not count, since the vault refuses approve then. The "Approval needed"
  alert, by Telegram and email, links straight to the card (`/console/<vault>#held`); before, it
  opened the overview, where the held card was the third or fourth. While a spend waits, the card
  offers an owner or approver "Get a message next time", a link to the Alerts tab, unless a
  confirmed alert of the vault already sends held spends.
- The Alerts tab says when a message can arrive: right after an invoice is uploaded on Payables
  (and, on the Canary vault, after each attempt), otherwise at the watcher's next run, once a day
  at 00:00 UTC or every minute if the per-minute schedule is turned on. A test holds the time to
  the schedule in `apps/web/vercel.json`. Before, it read as if a check every minute were already
  running.
- The console has the landing page's brand. It used a Tailwind kit from before the brand: buttons
  about 32px tall, 14px fields that a phone zooms in on, and Approve and Reject buttons that looked
  the same on a held payment.
  - Buttons are ink pills at least 44px tall. Approve is the ink pill and Reject a red outline. Any
    wallet button whose confirm dialog says it cannot be undone gets the red outline too: removing
    an agent key and revoking a mandate.
  - Fields are 16px, with the landing page's mute edge.
  - Cards, notices, badges and status text use the colour tokens. A test reads them from
    `globals.css` and checks that every text colour reads at WCAG AA.
  - The vault's tabs mark the open one with an underline and `aria-current`. Each tab is 44px tall,
    and on a phone they sit in one row that scrolls sideways.
  - The confirm dialog's Cancel is an outline pill.
  - Explorer links are ink rather than blue.
  - A pending payout is gold, the brand's colour for in progress.
  - Every page but the landing page now uses the header's frame: 1320px wide, with 16px gutters up
    to 620px and 24px above, so the page's left edge lines up with the logo. The console's and the
    extension page's content stays 1024px wide.
  - The proof page's coloured result panels are unchanged.
- The sign-in page says what signing in is for (a vault, a mandate and a key that can only call
  `spend`, or approving a held payment) and what it takes: on testnet, a NEAR testnet account, and
  about 3.3 test NEAR to create a vault later, which stays in the vault and cannot be withdrawn. On
  mainnet it says vaults cannot be created yet, as the factory is not deployed. Below the sign-in
  button it links the ledger test, which needs no wallet, and the terms and the privacy notice. The
  sign-in card had one button and no link.
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
- The console marks an invoice sent from the browser extension: the Waiting card says "Waiting for
  you: sent from the browser extension", a queued invoice lists only its holds under "Why it waits"
  and every check under "Checks when it was queued", and once a Confirm ran, the page says why the
  signed ledger's purpose rule passes under the mandate the member picked. The extension's inbox says
  where each waiting invoice came from.
- /privacy's Browser extension section, the threat model, the security policy, the incident runbook
  and the monitoring guide say that a connection can also queue an invoice, which waits for the
  owner's Confirm: what is stored for it, its rate-limit bucket, who ends a leaked connection, and
  that a queued or rejected invoice keeps its duplicate slot. Alert rule 4 (the money path) includes
  `component:extension`. The /docs security model and "What works today" pages say the same, and
  the /docs HTTP error table gains the Extension API rows.

### Fixed

- The Canary's persona tells the model to write amounts in USDC's smallest units, with an example
  (50 USDC is `50000000`), as core's default prompt does. On 2026-11-10 the live testnet Canary's
  model wrote `50` for 50 USDC, a spend of 0.00005 USDC that the contract would hold, so the contract's
  refusal could not be shown. The earlier persona is kept as `CANARY_SYSTEM_PROMPT_V1`, and
  `CANARY_SYSTEM_PROMPTS` lists both hashes for a verifier of the Canary's ledger.
- A Canary attempt gets 80 s instead of 50 s: the model 40 s instead of 30 s, the route's
  `maxDuration` 90 s and the tenant's lease 130 s. On 2026-11-10 a slow model used 30 s on its own,
  and the step that sends a refused spend to the contract, which needs 15 s, was skipped.
  `apps/web/vercel.json` sets `"fluid": true`, and the deploy runbook says to leave Fluid compute on.
- The console's Keys page asks for larger allowances on the Canary's vault: 3 NEAR for its agent key
  and 2 NEAR for its ledger key. With the allowances every other vault gets (1 NEAR and 0.25 NEAR),
  the Canary could not open, since it does not run while its ledger key holds under 0.5 NEAR. A key's
  allowance is fixed when the vault adds it, so these apply to keys added from now on.
- The Canary's vault card says when the owner froze the vault: it then refuses every spend and every
  approval until the owner unfreezes it. A config read that failed adds nothing to the card.
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
- The package READMEs built the packages from a clone while none was on npm; they had shown
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
- A test of the NEAR transaction-hash check could fail about once in 58 runs. It added a
  character to a random hash and expected the result to be refused, but a small 43-character hash
  with one more character can still decode to exactly 32 bytes. The test now starts from the
  largest hash, 44 characters long.

- Another invoice uploaded in the console with the same number for the same payee as one that was
  paid or may still pay is refused by code, rule `custom.invoice_number_duplicate`, and the
  decision entry signed by the ledger key says why. Before, the upload got a 409 before any rule
  ran, and nothing reached the ledger. An invoice queued from the browser extension with that
  number, and the same text uploaded again while the number stays blocked, are still duplicates at
  intake. When this rule's refusal is the outcome's code, the console's notice says whether an
  upload can run again: when the earlier invoice waits for the owner, after the owner rejects it.
  Otherwise the number stays blocked: a paid invoice, a spend held on chain (even one the approver
  rejects), a payment sent but not confirmed, a cycle cut off with an unknown outcome, and a
  refusal that could not be written to the new invoice. A paid
  invoice is not paid again. The notice gives no advice to reissue the bill under a new number:
  the console cannot yet show that the earlier spend can no longer pay, and a new number would
  pass every duplicate check. The migration
  `apps/web/supabase/migrations/20261108000016_invoice_number_rule.sql` changes `invoice_insert`.

- A bill could be paid twice when an agent paid one text of it outside the console. The owner's
  Confirm of that text in the console was refused as already paid (`invoice.duplicate`), and that
  refusal freed the invoice number, so a second text of the bill with the same number could run
  and pay. The duplicate guard now counts a refusal because the text was already paid or may still
  pay as an invoice that may pay: `invoice.duplicate` or `ledger.unresolved` in its signed decision
  (also when another rule refused first), or the contract's `DuplicateInvoice` or `DuplicateRef`.
  The same holds at intake and at the owner's Confirm. The guard also names an invoice that may
  have paid before one that waits for the owner, so the notice offers a re-upload after a Reject
  only when no invoice with the number may have paid. When two invoices with the number wait (the
  browser extension and the console raced), the notice asks the owner to reject each. A Reject
  still frees the number of the invoice it rejects. The migration
  `apps/web/supabase/migrations/20261110000017_invoice_guard_paid_refusals.sql` changes
  `invoice_insert` and `invoice_confirm_begin`.

- Web console, Payables: an invoice whose spend the vault held for an approver shows what the chain
  says of that spend now. The list and the invoice's page read the vault's spends with the same
  `list_spends` view the overview reads, and match the spend by its id and decision hash. An approved
  spend reads "Approved and paid on NEAR"; a rejected one, or one whose hold expired, says nothing was
  paid. Both pages kept "Held for approval", the outcome stored when the cycle ran: on testnet,
  INV-2003 and INV-2004 of `demo.vaults.probarion.testnet` were paid on chain but read held. The pages
  only read the chain: the stored outcome and the signed ledger do not change. When the spends cannot
  be read, the page says so and shows the status the cycle recorded.
- Web console, Payables: the banner says "1 invoice waits for you", not "1 invoice wait".
- Web console, Mandates: the table gives each column room. At desktop width its headers ran together
  ("PaymentsExpires").

- An on-demand render of `/docs/trust/reproducible-builds` on Vercel, such as a POST, which skips
  the prerender, answered 500: the function did not carry `.github/workflows/ci.yml`. The page's
  data now reads each file by a literal path. The docs functions carry the 8 repository files they
  read (0.09 MB), not about 1,170 (17.7 MB).
- The README's "Why it is different" said every vault method that moves value or changes authority
  needs a deposit. `freeze` takes none, and `spend` moves value without one; it now says every owner
  and approver method but `freeze` needs one. The /docs page Holds and approvals said no hold or
  approval had been recorded on NEAR testnet; on 2026-11-09 the demo vault held spends 2 and 3 and
  its approver approved both, and no rejection or expiry is recorded yet.
- The threat model's note on how evidence is named counted only the smoke transactions of
  `contracts/deployments/testnet.json` as testnet evidence. It now counts each transaction recorded
  there (`factory.deploy_tx`, `smoke`, `direct_refusal` and `demo_vault`), since attack 7 cites the
  direct refusal and the demo vault's held spend and its approval.

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
  The release check gates the versions, this changelog, open release-note comments and the packed
  tarballs. A version already on npm is skipped only when npm holds the same bytes. `release.yml` is
  pinned by sha256, every step runs with `pipefail`, and a test refuses any step that would swallow a
  failure. Third-party actions are pinned by commit SHA, and the cargo-near download is checked by
  sha256.
- CI scans the whole git history for secrets with gitleaks.
- The repository's GitHub security settings are on: private vulnerability reporting, secret scanning,
  push protection and Dependabot security updates. `SECURITY.md`, `/security`, the Docs Center's
  security model page and the issue form now offer the private advisory form (**Security → Report a
  vulnerability**) beside the direct message on X, and the threat model's known gaps no longer list
  the settings as off; secret scanning's non-provider patterns and validity checks stay off.
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
- The extension asks for four permissions (`storage`, `contextMenus`, `activeTab`, `alarms`) and
  Probarion's three addresses, trusts a connect message only from Probarion's own `/extension` page
  with a nonce it made, and calls only `/api/ext/pair`, `inbox`, `invoices` and `revoke`, which a
  test pins. A file fetched from the page's site is refused if a redirect took it to another site.
  The popup builds its DOM without HTML strings, and the bundles hold no remote code. Disconnect
  revokes the token, and so does a new connection that replaces one for the same address.
- Since the queue, that test's claim is narrower: the extension's server code imports nothing that
  pays or signs and, outside `lib/crypto`, nothing that opens a sealed key. The queue's route reads
  the master key only to seal the invoice with `sealInvoice` and to key its duplicate guard, as the
  console upload does. The test also fails if that code builds a `VaultClient` with anything but a
  vault id and an RPC client, re-exports it, or imports the cycle's `decide`.
- Dependabot triage: vitest 4.1.12 (it was 3.2.7) in the root and every package, and
  `@sentry/nextjs` 11.11.0 (it was 11.10.0) in `apps/web`, fix 12 of the 18 open alerts: `vitest`,
  `@vitest/mocker` and `tinypool` (dev only; vitest 4 no longer uses `tinypool`), and `glob` and
  `minimatch` (Sentry's build plugin, build time only). `elliptic` has no patched version and is not
  reachable: only the CLI's `verify --online` loads it, to verify TDX quote signatures, and the flaw
  is in signing. `wee_alloc` stays a known gap until a new vault version. `rustls` reaches only the
  sandbox tests and is bumped with the next contract change, since changing `contracts/Cargo.lock`
  makes the recorded code hashes stale. Every alert is in the threat model's review log.

## 0.1.0 - 2026-11-09

### Added

- `@probarion/core`: TypeScript mirrors of the vault and factory contract views; RFC 8785 canonical hashing; ed25519 keys; the signed, hash-chained ledger with the ledger-derived attestation nonce (bound to the vault account); the deterministic policy engine `decide()` with its built-in rules and custom rules; the model proposal parser; offline attestation checks A1 to A7, and the request-binding check A8 for auditors; and the snapshot verifier `runChecks` with checks a to i.
- `@probarion/sdk`: a NEAR JSON-RPC client with failover and backoff; vault, intents and factory clients; function-call key signing through near-api-js 7; the NEAR AI Cloud adapter (private TEE models, a nonce-bound attestation report, the `provider_tee` signature); the JSONL file ledger store (locked, which needs a local file system with hard links) and the in-memory store; the `Probarion` class with `process`, `requestSpend`, `checkSpend`, `mandates`, `spends`, `anchors`, `rules`, `snapshot` and `verify` (with optional online TEE quote checks through `@nearai/inference-sdk`); and `@probarion/sdk/testing` test doubles (fake chain, fake NEAR JSON-RPC server, fake NEAR AI Cloud).
- `probarion` CLI: `vault create`, `mandate create`, `mandate revoke`, `agent add`, `agent remove`, `ledger set-key`, `spend approve`, `spend reject`, `vault freeze`, `vault unfreeze`, `vault withdraw` and `vault withdraw-intents` check their input against the contract and print the transaction for the owner or approver to sign with `near-cli-rs` (1 yoctoNEAR where the contract requires it); the CLI does not sign. `agent keygen` makes an ed25519 key pair (`--out <file>` or `--print-secret`). `check` dry-runs a spend against the contract; `verify` runs checks a to i on a live vault or, with `--offline`, on a saved snapshot, prints a table or `--json`, and exits 0 (pass), 1 (a check fails or verify cannot run), 2 (a burn is unproven) or 64 (usage); `--online` adds the TEE quote checks O1 and O2 when `@nearai/inference-sdk` is installed and says when they did not run. `ledger export` copies the ledger to a new file.
- Packaging: ESM only, Node 24 or newer. Each tarball holds `dist/` (without source maps), `README.md` and `LICENSE`, and is published from CI with npm provenance when the repository is public.
