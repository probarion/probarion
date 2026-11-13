# Judging days

Judges look at the live site after the build window ends, not at the deadline. This page lists what can stop working
there with no change to the code, the read-only run that sees most of it (`scripts/smoke-live.mjs`), the checks only
the OWNER can do, and when to do each. What to do when a signal turns red is in the [incident runbook](../RUNBOOK.md).

Lane pull requests merge into dev until 09:00 UTC on 2026-11-14. The promote into main follows at about 10:00 UTC,
with 10:00 to 12:00 UTC kept for one fix-only promote, and main freezes at 12:00 UTC. After that, a fix during judging
is a setting, a redeploy of the same commit, or an owner transaction. A fix that needs a code change waits.

## Schedule

| When (UTC) | Who | What |
|---|---|---|
| After the promote of 2026-11-14 deploys | controller | `node scripts/smoke-live.mjs`, then `node scripts/smoke-live.mjs --quick --tee` once |
| 2026-11-15, morning | controller | `node scripts/smoke-live.mjs` |
| 2026-11-15, morning | OWNER | [the owner checks](#owner-checks), about 10 minutes |
| 2026-11-16, morning | controller | `node scripts/smoke-live.mjs` |
| 2026-11-16, morning | OWNER | [the owner checks](#owner-checks), about 10 minutes |
| 2026-11-17, and each morning after it until judging ends | controller | `node scripts/smoke-live.mjs` |

Run it again after any redeploy, and after any owner transaction on a vault below.

## The run

```bash
node scripts/smoke-live.mjs            # every row but the TEE check
node scripts/smoke-live.mjs --quick    # without the two npx rows
node scripts/smoke-live.mjs --tee      # also asks /api/tee/check once, from the rate limit all visitors share
node scripts/smoke-live.mjs --json     # the rows as JSON on stdout, the table on stderr
```

It needs node, git and npx on the PATH and no install (it was run with Node 24.12.0). It needs no key, and it
signs and sends nothing. It reads:

- HTTP GETs of probarion.xyz, GitHub (main's head, and whether the deployed commit holds a file) and npm (through npx);
- NEAR RPC view queries on mainnet and testnet: `call_function` on view methods and `view_access_key_list`, FastNEAR
  first and the NEAR RPC second;
- two npx runs of the published packages, `probarion@0.1.1` and `@probarion/mcp@0.1.1`, each in an empty temp folder.
  Their environment has no variable whose name looks like a secret, and the MCP demo gets an empty home, so its
  server finds no keys file.

Each row prints PASS, WARN (look at it today, or re-run it), FAIL (a judge would see it broken, or a public sentence
no longer holds) or SKIP. Exit 0 means no row failed. The script runs in no test or CI job;
`scripts/smoke-live.test.mjs` tests its rules with a fake fetch and a fake exec.

`--tee` asks the site's live TEE check once. The site asks NEAR AI Cloud's public attestation report, with no API key,
so it spends no credit. It does take one of the 30 checks a minute that all visitors share. Use it once per run day
at most.

Allowances print in NEAR to 4 decimals, rounded down, so a number here can be 0.0001 under the same key's number
elsewhere.

## Rows, and what to do on WARN or FAIL

| Row | What it reads | On WARN or FAIL |
|---|---|---|
| `health` | `/api/health` names the deployed commit; GitHub names main's head | FAIL: the promote has not deployed, or its deploy failed. The Vercel dashboard's Deployments page says which. The OWNER redeploys main ([deploying a fix](../RUNBOOK.md#deploying-a-fix-and-running-migrations)). |
| `pages` | `/`, `/proof`, the demo vault's proof page and ledger file, `/status`, `/docs`, `/llms.txt` answer 200 | FAIL: [app down](../RUNBOOK.md#app-down). |
| `samples-verify` | the three files under `/samples/mainnet/`, then `npx -y probarion@0.1.1 verify --network mainnet` on them: the no-clone check of `.github/workflows/no-clone-verify.yml` | WARN "not deployed yet": the deployed commit has no `apps/web/public/samples/mainnet` yet. Expected until the promote that ships it deploys; after it, this row must PASS. WARN "could not tell": GitHub did not answer for the deployed commit's copy; re-run it. FAIL on check c or d: the served ledger is older than the chain, after a new mainnet anchor or spend. The fix is a code change, so make no mainnet spend or anchor after the freeze. |
| `mcp-demo` | `npx -y @probarion/mcp@0.1.1 demo`: the five tools on the demo vault, keyless | WARN: the network failed, re-run it. FAIL: the README's step 5 tour does not run; read the row's detail, then the demo vault's proof page. |
| `tee-check` | with `--tee` only: `/api/tee/check` with a fresh nonce, 4 of 4 (nonce, signer, O1, O2) | WARN: a check was "unavailable" (NEAR AI, Intel or NVIDIA did not answer in time), or the rate limit answered; try later. FAIL: a check is fail, not unavailable: NEAR AI's evidence was rejected. Open the TEE card on `/proof` and read the failing check's detail. |
| `check-spend-mainnet`, `check-spend-testnet` | `check_spend` on mandate 1 of `v0.probarion.near` (1 USDC ok, 2 USDC OverPerPayment) and of `v0.probarion.testnet` (2 USDC ok, 50 USDC OverPerPayment), with the mandate's own agent key | FAIL with `Frozen`: a freeze was left on; the OWNER unfreezes ([unfreezing](../RUNBOOK.md#unfreezing)). Any other answer: the mandate changed; see the next row. |
| `mainnet-mandate-1` | `list_mandates`, `get_config` and the USDC balance of `v0.probarion.near` | FAIL: a mainnet spend or a new mandate changed what README.md and JUDGES.md (Worst case, priced) say: mandate 1 with 1 USDC and 1 payment left, the others exhausted. WARN: the vault is frozen, or holds other than 2 USDC. |
| `allowance-<vault>` | `view_access_key_list` of the mainnet vault, the demo vault, the Canary and the 402 example's vault | WARN under 0.2 NEAR (the watcher's `allowance_low` line). For the Canary's ledger key, WARN under 1 NEAR (twice its 0.5 NEAR level, the margin the RUNBOOK asks for) and FAIL under 0.5 NEAR: the Canary does not run, and `/canary` says it is not open yet. An allowance cannot be raised: the OWNER replaces the key ([allowance nearly used up](../RUNBOOK.md#agent-keys-allowance-nearly-used-up), [Canary levels](../RUNBOOK.md#canary-levels)). FAIL: a full-access key on a vault. |
| `mandate-expiry` | every active mandate on those vaults and on `v0.probarion.testnet` | WARN: one expires before 2026-11-20 (`--until` changes the day). After it expires, its spends are refused with `MandateExpired`. |
| `canary-page` | `/canary` shows its attempt form | WARN: it shows the paused or the replay banner, a `CANARY_MODE` setting the OWNER chose ([spam or cost spike](../RUNBOOK.md#canary-spam-or-cost-spike)). FAIL: it shows "not open yet" (its settings, a failed read, or its ledger key under 0.5 NEAR) or "closed: its ledger is full", or no form ([Canary levels](../RUNBOOK.md#canary-levels)). A failed read shows "not open yet" for one view, so re-run it once first. |
| `nearai` | `/api/health/nearai`: NEAR AI Cloud's public model list, read with no key | FAIL: NEAR AI Cloud does not answer. The Canary and Payables fail with it, and the TEE card shows unavailable. This row cannot see the credit: the OWNER checks it. |
| `site-rpc` | `/api/health/rpc`, one probe per RPC provider the site has for its network | WARN: one provider is down and the next answers. FAIL: none answers ([RPC failover](../RUNBOOK.md#rpc-failover)). On 2026-11-13 the site named one testnet provider, FastNEAR. |
| `rpc` | the answers this run got from the RPC hosts | WARN: a host answered HTTP 429 or failed. The site reads FastNEAR too, so watch `site-rpc` and `/status`. |

## Owner checks

Only the OWNER can see these. None of them changes anything.

- [ ] **NEAR AI credit.** At [cloud.near.ai](https://cloud.near.ai), the balance and the spend cap of the key in
      `NEARAI_API_KEY`. The Canary and Payables spend it. If it runs low, add credit or raise the cap. With none
      left, `CANARY_MODE=replay` in Vercel and a redeploy of the same commit keeps `/canary` honest: it shows the
      recorded attempts and refuses new ones.
- [ ] **Vercel usage.** The team's Usage page: function invocations, function duration and data transfer, against
      what the Pro plan includes. The Canary, the TEE check and the crons are the routes to look at first.
- [ ] **Supabase usage.** The organization's Usage page: database size, egress and monthly active users. The
      Canary's ledger and the watcher's `vault_events` are tables that grow with use.
- [ ] **Alerts.** The Telegram chat linked to vault alerts: an `allowance_low` or `near_low` message since the last
      check. Only a vault with an alert linked sends them. [Owner alerts](alerts.md) records a linked chat for
      `trial.vaults.probarion.testnet` only, so for the five vaults this run reads, its allowance rows are the signal.

## Baseline, 2026-11-13 20:45 UTC

A run against probarion.xyz serving main at `18cdf04aa086`, before the promote of 2026-11-14. The samples row warned
as expected: that deploy has no `apps/web/public/samples/mainnet` yet. The allowances are a baseline: compare each
later run with them to see how fast a key spends. An earlier run at 19:53 UTC read the same allowances.

```text
Probarion live smoke of https://probarion.xyz, 2026-11-13T20:45:12.169Z. Read-only: it signs and sends nothing.

PASS  /api/health is ok and serves the head of main
      serves 18cdf04aa086 on testnet, the head of main
PASS  the pages a judge opens first answer 200
      7 of 7 answer 200: /, /proof, /proof/demo.vaults.probarion.testnet, /proof/demo.vaults.probarion.testnet/ledger.jsonl, /status, /docs, /llms.txt
WARN  no-clone mainnet verify of the served samples: a to h pass, i skips
      not deployed yet, as expected: https://probarion.xyz/samples/mainnet/ledger.jsonl answers 404 because the deployed commit 18cdf04aa086 has no apps/web/public/samples/mainnet/ledger.jsonl. Re-run after the promote that ships it deploys; then this row must PASS
PASS  npx -y @probarion/mcp@0.1.1 demo exits 0, nothing signed
      Done: 6 steps, 5 as expected, 1 note. Nothing was signed or sent. note. No mandate can pay now (mandate 1: exhausted, 5 of 5 uses used). The dry runs below show the contract refusing, which is what a mandate is for
SKIP  /api/tee/check: 4 of 4 checks pass
      not run: it takes a place in the TEE check's rate limit, which all visitors share; run with --tee
PASS  check_spend on v0.probarion.near: 1 USDC ok, 2 USDC OverPerPayment
      mandate 1 with its own agent key: 1 USDC ok; 2 USDC OverPerPayment
PASS  check_spend on v0.probarion.testnet: 2 USDC ok, 50 USDC OverPerPayment
      mandate 1 with its own agent key: 2 USDC ok; 50 USDC OverPerPayment
PASS  mainnet mandate 1: 1 of 2 payments used, the only active mandate
      mandate 1 is active: 1 of 2 payments used, at most 1 USDC a payment to probarion-duong.near, expires 2027-01-31; the only active mandate; the vault holds 2 USDC; not frozen
PASS  gas allowance of each key on v0.probarion.near
      the mainnet vault: anchor key ed25519:RY7kjsaR... 0.2491 NEAR; spend key ed25519:GADeVCXt... 0.2462 NEAR
PASS  gas allowance of each key on demo.vaults.probarion.testnet
      the demo vault of /proof and the MCP demo: spend key ed25519:7qyNHfvN... 0.9972 NEAR; anchor key ed25519:A5uLDeBH... 0.2475 NEAR
PASS  gas allowance of each key on canary.vaults.probarion.testnet
      the Canary: spend key ed25519:2BB5XPYU... 2.9996 NEAR; anchor key ed25519:9Qrk6icE... 1.9983 NEAR
PASS  gas allowance of each key on percall.vaults.probarion.testnet
      the 402 example: spend key ed25519:4sYFZAht... 0.9847 NEAR; anchor key ed25519:9DDfsL2K... 0.2452 NEAR
PASS  no active mandate expires before the cutoff day
      4 active mandates on the 5 vaults, each expiring on or after 2026-11-20; the first, v0.probarion.testnet mandate 1, on 2026-12-01
PASS  /canary is open: its form, no paused or closed banner
      /canary shows the live attempt form, with no paused or closed banner
PASS  /api/health/nearai reaches NEAR AI Cloud
      64 model(s) listed, 5 with attestation and structured output; the public model list, read with no key: it does not show the NEAR AI credit
PASS  /api/health/rpc: the site's RPC providers answer
      testnet: rpc.testnet.fastnear.com ok (block 277560901, 2 s behind)
PASS  the RPC hosts this run read answered
      18 answers: rpc.mainnet.fastnear.com 8 ok; rpc.testnet.fastnear.com 10 ok

15 PASS, 1 WARN, 0 FAIL, 1 SKIP in 33 s. Exit 0.
```

Four keys sit close to the 0.2 NEAR line: the mainnet spend key (0.2462 NEAR), the mainnet ledger key (0.2491 NEAR)
and the ledger keys of the demo vault (0.2475 NEAR) and the 402 example (0.2452 NEAR). Each transaction a key signs
takes from its allowance, so a mainnet spend or anchor during judging brings the mainnet keys nearer the line.
