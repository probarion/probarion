import type { RefColumn, RefRow, RefTable } from "./types";

/**
 * The SDK reference (`/docs/build/sdk-reference`): every export of `@probarion/sdk` and of
 * `@probarion/sdk/testing`, grouped by job, plus the public members of the classes most code calls.
 * `test/docs-ref-sdk.test.ts` compares these rows with the package's real exports, its exported types,
 * the members of each class and the fields of `ProbarionDeps`, both ways.
 */

/** What an export is. A `type` has no runtime value; the other three are checked against the import. */
type Kind = "class" | "function" | "constant" | "type";

/** One export: its name, its kind, what it does, and the docs page that shows it in use ("None"). */
type Export = readonly [name: string, kind: Kind, what: string, shown: string];

const EXPORT_COLUMNS: readonly RefColumn[] = [
  { key: "name", label: "Name" },
  { key: "kind", label: "Kind" },
  { key: "what", label: "What it does" },
  { key: "shown", label: "Shown on" },
];

/** Row ids are the export's name in lowercase after a prefix: `sdk-probarion`, `sdk-testing-fakechain`. */
function exportTable(id: string, label: string, prefix: string, rows: readonly Export[]): RefTable {
  return {
    id,
    label,
    columns: EXPORT_COLUMNS,
    rows: rows.map(([name, kind, what, shown]) => ({
      id: `${prefix}${name.toLowerCase()}`,
      cells: { name: `\`${name}\``, kind, what, shown },
    })),
  };
}

/**
 * A member row id: the class and the member path in lowercase, `sdk-vaultclient-listallspends`,
 * `sdk-probarion-mandates-list`. The constructor is `new`: `sdk-vaultclient-new`.
 */
function memberId(owner: string, member: string): string {
  const path = member.startsWith("new ") ? "new" : member.replace(/\(.*$/, "").replace(/\./g, "-");
  return `sdk-${owner.toLowerCase()}-${path.toLowerCase()}`;
}

// --- The client ----------------------------------------------------------------------------------

const CLIENT: readonly Export[] = [
  [
    "Probarion",
    "class",
    "The client for one vault. `process()` runs the payment cycle for an invoice, the read members read the vault, and `snapshot()` and `verify()` gather and check the proof.",
    "Let an agent pay, Developer quickstart",
  ],
  [
    "hashInvoice",
    "function",
    "The invoice hash: the sha256 of the text's UTF-8 bytes, as 64 lowercase hex. Bytes that are not UTF-8 throw `ProbarionError` with the code `InvalidInput`.",
    "Let an agent pay",
  ],
  [
    "DEFAULT_LEDGER_PATH",
    "constant",
    "`.probarion/ledger.jsonl`: the ledger file when neither the `ledger` option nor `PROBARION_LEDGER_PATH` names one.",
    "None",
  ],
  [
    "UNKNOWN_SETTLE_MS",
    "constant",
    "48 hours in milliseconds. After an unconfirmed payment, the same invoice is refused by code with `ledger.unresolved` until the chain shows its spend or this time has passed.",
    "Spend outcomes",
  ],
  [
    "ProbarionOptions",
    "type",
    "The first argument of `new Probarion()`: `network`, `vault`, `agentKey`, `ledgerKey`, `rpcUrls`, `model`, `ledger`, `confidenceFloor` and `requestId`.",
    "Let an agent pay",
  ],
  [
    "ProbarionDeps",
    "type",
    "The optional second argument of `new Probarion()`, for tests and hosts. Production code passes nothing.",
    "None",
  ],
  [
    "ProbarionLogger",
    "type",
    "Anything with `warn(message, meta?)`, which receives the instance's warnings.",
    "None",
  ],
  [
    "VerifyOptions",
    "type",
    "The options of `verify()`: `online`, `snapshot`, `invoiceTexts` and `systemPrompts`.",
    "None",
  ],
  [
    "SpendOutcome",
    "type",
    "What `process()` and `requestSpend()` return: `status`, `spendId`, `code`, `txHash`, the ledger fields and `modelUsage`.",
    "Spend outcomes",
  ],
  [
    "SpendOutcomeStatus",
    "type",
    "The eight statuses of a `SpendOutcome`. `process()` never returns `settled`.",
    "Spend outcomes",
  ],
  [
    "ModelUsage",
    "type",
    "The model id and token counts of a model step that answered.",
    "Spend outcomes",
  ],
  [
    "InvoiceFacts",
    "type",
    "The facts your agent supplies with each invoice: `invoice_hash`, `amount`, `po_ref`, `purpose_hash` and `payee_hint`. From `@probarion/core`.",
    "Let an agent pay",
  ],
  [
    "MandateView",
    "type",
    "A mandate as the vault's views return it, with its payee, limits, uses, expiry and status. From `@probarion/core`.",
    "Install the packages",
  ],
  [
    "CustomRule",
    "type",
    "A rule for `rules.add()`: an `id` that starts with `custom.` and a `check(input, mandate)` that returns a pass, a hold or a refusal. From `@probarion/core`.",
    "Let an agent pay",
  ],
  [
    "Hex32",
    "type",
    "A `string` that holds 64 lowercase hex characters, such as a sha256. The type does not check the format. From `@probarion/core`.",
    "None",
  ],
];

/** The public members of `Probarion`. The member cell names the call; `new` marks the constructor. */
const CLIENT_MEMBERS: readonly (readonly [
  member: string,
  what: string,
  signs: string,
  shown: string,
])[] = [
  [
    "new Probarion(opts, deps?)",
    "Makes the client. `opts` is a `ProbarionOptions` and `deps` a `ProbarionDeps`. A bad network, vault, key, model or `confidenceFloor` throws `ConfigError`.",
    "None",
    "Let an agent pay",
  ],
  ["network", "The network the instance was made for: `testnet` or `mainnet`.", "None", "None"],
  ["vaultId", "The vault account id.", "None", "None"],
  [
    "process(invoice)",
    "The whole cycle for one invoice `{ text, facts, ref }`: the optional model proposal, the decision, then, unless the code refuses, the free `check_spend` and at most one `spend`, and the ledger entries and the anchor. Returns a `SpendOutcome`. Calls on one instance run one at a time.",
    "The agent key signs `spend`. The ledger key signs each entry and the `anchor`.",
    "Let an agent pay, Spend outcomes",
  ],
  [
    "requestSpend(input)",
    "The same path for a decision you made yourself: `{ mandateId, amount, invoiceHash, ref }`, with the optional `proposal`, `evidence` and `skipPreflight`. It has no recipient parameter. The outcome's `modelUsage` is null.",
    "The agent key signs `spend`. The ledger key signs each entry and the `anchor`.",
    "Spend outcomes",
  ],
  [
    "checkSpend(input)",
    "The contract's free dry run of `spend` for `{ mandateId, amount, invoiceHash, ref }`, with no transaction and no ledger entry. Returns `{ ok, code, would_hold }`. Without an agent key it checks as the key the mandate names.",
    "None",
    "Install the packages, Developer quickstart",
  ],
  [
    "mandates.list()",
    "Every mandate of the vault, read from the chain.",
    "None",
    "Mandates, Install the packages, Developer quickstart",
  ],
  ["mandates.get(id)", "One mandate by its id, or null.", "None", "Mandates"],
  [
    "spends.get(id)",
    "One spend by its spend id, or null. It takes no ref: to find a spend by its ref, list the spends with `VaultClient.listAllSpends()`.",
    "None",
    "Let an agent pay",
  ],
  [
    "anchors.latest()",
    "The vault's latest ledger anchor on chain, or null.",
    "None",
    "The ledger and anchors",
  ],
  [
    "rules.add(rule)",
    "Adds a `CustomRule` to every later decision. An id that does not start with `custom.`, or a rule with no `check`, throws `ConfigError`.",
    "None",
    "Let an agent pay",
  ],
  [
    "snapshot(opts?)",
    "The chain facts the verifier needs, gathered with your ledger, as a `Snapshot`. `online: true` also looks burns up in FastNEAR's transaction index.",
    "None",
    "None",
  ],
  [
    "verify(opts?)",
    "Runs the verifier checks a to i on a fresh snapshot, or on `opts.snapshot`, and returns a `VerifyReport`. `invoiceTexts` adds A8, and `online: true` adds the online attestation checks to check e.",
    "None",
    "Verifier checks a to i",
  ],
];

/** The fields of `ProbarionDeps`, the constructor's second argument. */
const DEPS: readonly (readonly [field: string, what: string, dflt: string])[] = [
  [
    "rpc",
    "The `RpcClient` for every read, with `archivalRpc` for old burn lookups. The default senders send to its current URL, without its failover.",
    "A client over `rpcUrls`, else `NEAR_RPC_URLS`, else the network's RPC list.",
  ],
  [
    "agentSender",
    "The `TxSender` that signs `spend`. It must sign as the vault account, and with the public key of `agentKey` when both are given.",
    "A `NearApiJsSender` over `agentKey`, or none.",
  ],
  [
    "ledgerSender",
    "The `TxSender` that signs `anchor`.",
    "A `NearApiJsSender` over `ledgerKey`, or none.",
  ],
  [
    "proposer",
    "The `NearAiProposer` for the model step. `null` decides with the code rules only, even when `model` is set.",
    "One made from the `model` option, or none.",
  ],
  [
    "nearaiBaseUrl",
    "The NEAR AI Cloud base URL of the default proposer.",
    "NEAR AI Cloud's own URL.",
  ],
  ["now", "The clock: a function that returns a `Date`.", "The system clock."],
  [
    "requestId",
    "Makes each cycle's `request_id` when the `requestId` option is not set.",
    "A fresh UUID per cycle.",
  ],
  [
    "logger",
    "A `ProbarionLogger` that receives the warnings.",
    "One JSON line per warning on `console.warn`.",
  ],
  [
    "expectedCodeHashes",
    "Deprecated and ignored: a snapshot lists exactly the code hashes check f trusts.",
    "None",
  ],
  [
    "env",
    "The environment the SDK reads `NEAR_RPC_URLS`, `NEAR_ARCHIVAL_RPC_URLS`, `PROBARION_LEDGER_PATH` and `NEARAI_MODEL` from.",
    "`process.env`",
  ],
  [
    "archivalRpc",
    "The archival `RpcClient` for burn lookups older than about 2.5 days. `null` turns archival lookups off.",
    "A client over `NEAR_ARCHIVAL_RPC_URLS`, else FastNEAR's archival node.",
  ],
  [
    "preLedgerDecisionHashes",
    "The documented pre-ledger decision hashes for check d. The code applies them only to `v0.probarion.near` on mainnet, which has run there since 2026-11-11.",
    "The sha256 of each `v0-decision-*.json` file in `evidenceDir`.",
  ],
  [
    "evidenceDir",
    "The folder of those decision files, read only for that mainnet vault.",
    "`docs/evidence`",
  ],
  [
    "burnTxHints",
    "Spend ids mapped to the transactions that may hold their burn, tried first by check h.",
    "The vault's transactions in `docs/mainnet-proof.json`, or none when the file is missing.",
  ],
  [
    "onlineVerifier",
    "The `OnlineAttestationVerifier` that `verify({ online: true })` uses. `null` means unavailable.",
    "`@nearai/inference-sdk`, when it is installed.",
  ],
  [
    "txIndex",
    "The `TxIndex` used only online. `null` turns it off.",
    "FastNEAR's transactions API.",
  ],
];

// --- Chain clients and transactions --------------------------------------------------------------

const CHAIN: readonly Export[] = [
  [
    "VaultClient",
    "class",
    "Reads one vault's views, and sends `spend` and `anchor` through the senders it is given. With no senders it is read-only.",
    "Let an agent pay, Spend outcomes",
  ],
  [
    "FactoryClient",
    "class",
    "Reads the Probarion factory's views: its code versions, a vault's version, its config and its vault list. Read-only.",
    "None",
  ],
  [
    "IntentsClient",
    "class",
    "Reads the NEAR Intents verifier's views for an account: its public keys, its predecessor auth flag and a token balance. Read-only.",
    "None",
  ],
  [
    "RpcClient",
    "class",
    "A NEAR JSON-RPC client that fails over across a list of URLs, with retries and back-off.",
    "Let an agent pay",
  ],
  [
    "resolveRpcUrls",
    "function",
    "The RPC URLs for a network: the list you pass, else `NEAR_RPC_URLS`, else the network's own list.",
    "Let an agent pay",
  ],
  [
    "NearApiJsSender",
    "class",
    "A `TxSender` that signs one function call with a secret key through near-api-js and waits for the final outcome. `Probarion` makes one over the agent key and one over the ledger key, both signing as the vault account.",
    "None",
  ],
  [
    "SPEND_GAS",
    "constant",
    "200 Tgas: the gas `VaultClient.spend()` attaches, with no deposit.",
    "None",
  ],
  [
    "ANCHOR_GAS",
    "constant",
    "30 Tgas: the gas `VaultClient.anchor()` attaches, with no deposit.",
    "None",
  ],
  [
    "PAGE_SIZE",
    "constant",
    "50: the page size of `listAllMandates()`, `listAllSpends()` and `listAllAnchors()`.",
    "None",
  ],
  [
    "MAX_PAGE_LIMIT",
    "constant",
    "100: the most rows a list view returns. A larger `limit` is cut to it.",
    "None",
  ],
  [
    "pageAll",
    "function",
    "Reads a list view page by page until a short page. A page longer than asked for, a repeated page or more than 1000 pages throws `ViewError`.",
    "None",
  ],
  [
    "interpretSpend",
    "function",
    "Reads a finished `spend` transaction as a `SpendTxResult`: paid, burned or held; not paid; or unconfirmed when it may have paid.",
    "None",
  ],
  [
    "isSpendResult",
    "function",
    "True when a value is a spend result the vault returns: a numeric `spend_id` and a known spend status.",
    "None",
  ],
  [
    "parseTxOutcome",
    "function",
    "Reads a transaction result as a `TxOutcome`. A vault panic gives its code, and the chain's balance refusals give `LackBalanceForState` or `NotEnoughBalance`.",
    "None",
  ],
  [
    "firstReceiptSucceeded",
    "function",
    "Whether the first receipt of a finished transaction succeeded: `true`, `false`, or `null` when the result shows no receipts.",
    "None",
  ],
  [
    "isOutOfNearCode",
    "function",
    "True for `LackBalanceForState` and `NotEnoughBalance`: the vault needs a plain NEAR transfer.",
    "Errors",
  ],
  [
    "LACK_BALANCE_CODE",
    "constant",
    "`LackBalanceForState`: the chain refused the call because the vault would fall below the NEAR its storage needs.",
    "Errors",
  ],
  [
    "NOT_ENOUGH_BALANCE_CODE",
    "constant",
    "`NotEnoughBalance`: the vault holds less NEAR than the call must prepay for gas.",
    "Errors",
  ],
  [
    "OUT_OF_NEAR_DETAIL",
    "constant",
    "The message for `LackBalanceForState`, which says each paid spend keeps about 0.0048 NEAR of storage.",
    "Errors",
  ],
  [
    "OUT_OF_GAS_NEAR_DETAIL",
    "constant",
    "The message for `NotEnoughBalance`, which puts a spend's gas at about 0.02 NEAR for 200 Tgas.",
    "Errors",
  ],
  [
    "toAccessKeyInfo",
    "function",
    "Reads one key of a `view_access_key_list` answer. An unknown or malformed permission throws `RpcMalformedError`.",
    "None",
  ],
  [
    "codeIdentity",
    "function",
    "An account's code identity: its global contract hash when it has one (NEP-591), else its code hash.",
    "None",
  ],
  [
    "isUnknownAccountError",
    "function",
    "True when an error is the node's answer that an account does not exist, in either answer form.",
    "None",
  ],
  [
    "toTxStatusResult",
    "function",
    "Reads a `tx` RPC result as a `TxStatusResult`. A malformed answer throws `RpcMalformedError`.",
    "None",
  ],
  [
    "readPayeeSignals",
    "function",
    "Reads what `assessPayee` (`@probarion/core`) needs about one payee: a NEAR account at the final block and at a block about 7 days back, a Base address's code and nonce on mainnet, and a vault's mandates and spends when one is given. Solana is not read. Read-only; a failed read leaves its signal `unknown`. `@probarion/sdk/payee` exports it, `readKnownPayees`, the four `PAYEE_` constants and its two types on their own, without the root entry, which loads `node:fs`, so a browser page can import them. In this repository, not in npm 0.1.1.",
    "None",
  ],
  [
    "readKnownPayees",
    "function",
    "A vault's payees: each mandate's payee with its mandate ids, and how many spends to each were paid out. It throws when a read fails or a row is malformed, and when the vault has 2000 or more mandates or spends.",
    "None",
  ],
  [
    "PAYEE_ARCHIVAL_RPC_URLS",
    "constant",
    "FastNEAR's archival node per network, for the payee check's read about 7 days back.",
    "None",
  ],
  [
    "PAYEE_BASE_RPC_URLS",
    "constant",
    "Base JSON-RPC per network for the payee check: `https://mainnet.base.org` on mainnet, `null` on testnet, which leaves a Base payee unread.",
    "None",
  ],
  [
    "PAYEE_SIGNALS_TIMEOUT_MS",
    "constant",
    "3000: the milliseconds each payee-check request may take. Each endpoint gets one more try.",
    "None",
  ],
  [
    "PAYEE_SIGNALS_BUDGET_MS",
    "constant",
    "15000: the milliseconds all of a payee check's reads may take together. A read still waiting then is `unknown`.",
    "None",
  ],
  [
    "RpcClientOptions",
    "type",
    "The options of `new RpcClient()`: `urls`, `fetch`, `maxRounds` (1 to 10, default 3), `baseDelayMs`, `maxDelayMs`, `timeoutMs`, `sleep` and `remainingMs`.",
    "None",
  ],
  ["ViewAccountResult", "type", "What `RpcClient.viewAccount()` returns.", "None"],
  ["TxStatusResult", "type", "What `RpcClient.txStatus()` returns.", "None"],
  ["ExecutionOutcomeView", "type", "One execution outcome inside a `TxStatusResult`.", "None"],
  ["VaultSenders", "type", "The `agent` and `ledger` senders of a `VaultClient`.", "None"],
  [
    "SpendTxResult",
    "type",
    "What `VaultClient.spend()` and `resolveSpend()` return: `tx`, `result`, `ok` and `unconfirmed`. Read `ok` first.",
    "None",
  ],
  [
    "SpendUnconfirmed",
    "type",
    "Why a spend may have paid although the answer cannot say: `kind` and `reason`.",
    "None",
  ],
  ["SpendUnconfirmedKind", "type", "`unreadable_value`, `callback_failed` or `pending`.", "Errors"],
  [
    "TxSender",
    "type",
    "Signs and sends one function call: `accountId`, `publicKey`, `functionCall(tx)` and an optional `lookup(txHash)`.",
    "None",
  ],
  [
    "FunctionCallTx",
    "type",
    "One function call: `receiverId`, `methodName`, `args`, `gas` and `deposit`.",
    "None",
  ],
  [
    "TxOutcome",
    "type",
    "What a sender returns: `txHash`, `ok`, `value`, `code`, `failure` and `raw`.",
    "None",
  ],
  [
    "TxFailureCode",
    "type",
    "A vault panic code, `LackBalanceForState` or `NotEnoughBalance`.",
    "Errors",
  ],
  [
    "NearApiJsSenderOptions",
    "type",
    "The options of `new NearApiJsSender()`: `accountId`, `secretKey`, `rpcUrl`, `createProvider` and `sendTimeoutMs`, 90 s per step by default.",
    "None",
  ],
  [
    "ReadPayeeSignalsInput",
    "type",
    "The first argument of `readPayeeSignals()`: `network`, `payee` and an optional `vault`.",
    "None",
  ],
  [
    "ReadPayeeSignalsOptions",
    "type",
    "The options of `readPayeeSignals()`: `rpcUrls`, `archivalRpcUrls`, `baseRpcUrl`, `fetch`, `timeoutMs`, `budgetMs` and `now`.",
    "None",
  ],
];

/** The public members of the chain clients and the sender, by class. */
const CHAIN_MEMBERS: readonly (readonly [
  owner: string,
  member: string,
  what: string,
  signs: string,
])[] = [
  [
    "VaultClient",
    "new VaultClient(vaultId, rpc, senders?)",
    "Makes a client for one vault. `senders` holds the agent and ledger `TxSender`. Each must sign as the vault account, or the call that needs it throws `ConfigError`.",
    "None",
  ],
  ["VaultClient", "vaultId", "The vault account id.", "None"],
  ["VaultClient", "canSpend", "True when an agent sender was given.", "None"],
  ["VaultClient", "canAnchor", "True when a ledger sender was given.", "None"],
  ["VaultClient", "getConfig()", "The vault's config, from `get_config`.", "None"],
  ["VaultClient", "getMandate(mandateId)", "One mandate, or null, from `get_mandate`.", "None"],
  [
    "VaultClient",
    "listMandates(fromIndex, limit)",
    "One page of mandates from `list_mandates`. `fromIndex` is a 0-based position, and `limit` is cut to 1 to 100.",
    "None",
  ],
  ["VaultClient", "listAllMandates()", "Every mandate, page by page.", "None"],
  ["VaultClient", "getSpend(spendId)", "One spend by its id, or null, from `get_spend`.", "None"],
  ["VaultClient", "listSpends(fromIndex, limit)", "One page of spends from `list_spends`.", "None"],
  [
    "VaultClient",
    "listAllSpends()",
    "Every spend, page by page. Use it to find a spend by its ref.",
    "None",
  ],
  [
    "VaultClient",
    "listAnchors(fromIndex, limit)",
    "One page of anchors from `list_anchors`.",
    "None",
  ],
  ["VaultClient", "listAllAnchors()", "Every anchor, page by page.", "None"],
  ["VaultClient", "listAgents()", "The vault's agent keys, from `list_agents`.", "None"],
  [
    "VaultClient",
    "checkSpend(request, signerPk)",
    "The contract's free `check_spend` view for that public key. The code comes back without its `PROBARION:` prefix.",
    "None",
  ],
  [
    "VaultClient",
    "spend(request)",
    "Sends `spend` with 200 Tgas and no deposit, and returns a `SpendTxResult`. A vault refusal comes back with `ok: false`. A node refusal throws `TxRejectedError`, and a lost answer throws `TxOutcomeUnknownError`.",
    "The agent key",
  ],
  [
    "VaultClient",
    "resolveSpend(txHash)",
    "Reads the final outcome of a spend whose outcome was unknown, through the agent sender's `lookup`, and gives it the same verdict as `spend`.",
    "None: it signs nothing",
  ],
  [
    "VaultClient",
    "anchor(seq, root, count)",
    "Sends `anchor` with 30 Tgas and no deposit, and returns the `TxOutcome`. A missing ledger sender, a `seq` or `count` below 1, or a `root` that is not 64 lowercase hex throws `ConfigError`. A failure on chain throws `ContractError`, a node refusal `TxRejectedError` and a lost answer `TxOutcomeUnknownError`.",
    "The ledger key",
  ],
  [
    "FactoryClient",
    "new FactoryClient(factoryId, rpc)",
    "Makes a read-only client for one factory.",
    "None",
  ],
  ["FactoryClient", "factoryId", "The factory account id.", "None"],
  [
    "FactoryClient",
    "versions()",
    "The vault code versions the factory lists, from `versions`.",
    "None",
  ],
  [
    "FactoryClient",
    "vaultVersion(accountId)",
    "The version the factory records for that vault, or null, from `vault_version`.",
    "None",
  ],
  ["FactoryClient", "getConfig()", "The factory's config, from `get_config`.", "None"],
  [
    "FactoryClient",
    "listVaults(fromIndex, limit)",
    "One page of the factory's vault records, from `list_vaults`.",
    "None",
  ],
  [
    "IntentsClient",
    "new IntentsClient(intentsId, rpc)",
    "Makes a read-only client for the NEAR Intents verifier: `intents.near`, or the stand-in on testnet.",
    "None",
  ],
  ["IntentsClient", "intentsId", "The verifier's account id.", "None"],
  [
    "IntentsClient",
    "publicKeysOf(accountId)",
    "The public keys registered for the account on NEAR Intents. A vault must have none.",
    "None",
  ],
  [
    "IntentsClient",
    "isAuthByPredecessorIdEnabled(accountId)",
    "Whether auth by predecessor id is on for the account.",
    "None",
  ],
  [
    "IntentsClient",
    "poaBalance(accountId, asset)",
    "The account's balance of the token `nep141:<asset>` inside NEAR Intents, as a `bigint`. An answer that is not a balance throws `ViewError`.",
    "None",
  ],
  [
    "RpcClient",
    "new RpcClient(opts)",
    "Makes a client from `RpcClientOptions`. An empty URL list throws `ConfigError`.",
    "None",
  ],
  ["RpcClient", "currentUrl", "The URL the client tries first now.", "None"],
  [
    "RpcClient",
    "call(method, params)",
    "Sends one JSON-RPC request, failing over across the URLs. It is safe only for reads and signed payloads, because a retry sends the same params again.",
    "None",
  ],
  [
    "RpcClient",
    "viewFunction(contractId, methodName, args?)",
    "Calls a contract view at final finality and parses its JSON answer. A failed view throws `ViewError`.",
    "None",
  ],
  [
    "RpcClient",
    "viewAccessKeyList(accountId)",
    "The account's access keys. An unknown permission throws.",
    "None",
  ],
  [
    "RpcClient",
    "viewAccessKey(accountId, publicKey)",
    "One access key, or null when the key or its account is not there.",
    "None",
  ],
  [
    "RpcClient",
    "viewAccount(accountId, blockId?)",
    "The account's balance, locked balance, code hash, global contract hash and storage use, at the final block or, on an archival node, at `blockId`.",
    "None",
  ],
  [
    "RpcClient",
    "txStatus(txHash, senderAccountId)",
    "A transaction's status once it is final, as a `TxStatusResult`.",
    "None",
  ],
  [
    "NearApiJsSender",
    "new NearApiJsSender(opts)",
    "Makes a sender from `NearApiJsSenderOptions`. A key that does not parse throws `ConfigError`, whose message names the account and never the key.",
    "None",
  ],
  [
    "NearApiJsSender",
    "accountId",
    "The account the key lives on. For the agent key and the ledger key, that is the vault.",
    "None",
  ],
  ["NearApiJsSender", "publicKey", "The public key of the secret key.", "None"],
  [
    "NearApiJsSender",
    "functionCall(tx)",
    "Signs one `FunctionCallTx`, computes its hash before it sends anything, and waits for the final outcome, a `TxOutcome`.",
    "The secret key it was made with",
  ],
  [
    "NearApiJsSender",
    "lookup(txHash)",
    "Reads the final outcome of a transaction this sender signed. It throws `TxOutcomeUnknownError` when the node cannot say.",
    "None",
  ],
];

// --- Ledger stores -------------------------------------------------------------------------------

const LEDGER: readonly Export[] = [
  [
    "FileLedgerStore",
    "class",
    "The default `LedgerStore`: a JSONL file with one entry per line. Each append takes a lock file beside it and is synced to disk.",
    "The ledger and anchors, Let an agent pay",
  ],
  [
    "InMemoryLedgerStore",
    "class",
    "A `LedgerStore` in memory, for tests.",
    "The ledger and anchors",
  ],
  [
    "ledgerPathFromEnv",
    "function",
    "The ledger path from `PROBARION_LEDGER_PATH`, where a blank value counts as unset, else the fallback you pass.",
    "None",
  ],
  [
    "composeBody",
    "function",
    "Builds an entry body from its parts with exactly the body's keys in a fixed order, so nothing else reaches the hash.",
    "None",
  ],
  [
    "LedgerStore",
    "type",
    "What a ledger store provides: `head()`, `append(body, sign, opts?)` and `all()`. A store of your own must honour `opts.expect`.",
    "Let an agent pay",
  ],
  [
    "FileLedgerStoreOptions",
    "type",
    "`lockTimeoutMs`: how long an append waits for another writer, 10 s by default.",
    "None",
  ],
  [
    "LedgerAppendBody",
    "type",
    "An entry body without `seq` and `prev_link`, which the store fills in.",
    "None",
  ],
  ["LedgerAppendOptions", "type", "`expect`: the position an append must write at.", "None"],
  ["AppendExpectation", "type", "A ledger position: `seq` and `prev_link`.", "None"],
];

/** The public members of the two ledger stores. */
const LEDGER_MEMBERS: readonly (readonly [owner: string, member: string, what: string])[] = [
  [
    "FileLedgerStore",
    "new FileLedgerStore(path?, options?)",
    "Opens the file store. `path` defaults to `.probarion/ledger.jsonl`, and a blank one counts as unset. A missing file is an empty ledger.",
  ],
  ["FileLedgerStore", "path", "The ledger file's path."],
  [
    "FileLedgerStore",
    "all()",
    "Every entry, in order. It does not check the chain, which is the verifier's job. A torn last line throws `LedgerError` naming the line, and nothing is repaired.",
  ],
  ["FileLedgerStore", "head()", "The last entry, or null for an empty ledger."],
  [
    "FileLedgerStore",
    "append(body, sign, opts?)",
    "Under the lock file, checks that the entry chains onto the head, signs it with `sign` and writes it. With `opts.expect` it writes only at that position, and otherwise throws `LedgerConflictError` and writes nothing.",
  ],
  [
    "InMemoryLedgerStore",
    "new InMemoryLedgerStore(initial?)",
    "Starts from a copy of `initial`, or empty.",
  ],
  ["InMemoryLedgerStore", "all()", "Copies of every entry, in order."],
  ["InMemoryLedgerStore", "head()", "A copy of the last entry, or null."],
  [
    "InMemoryLedgerStore",
    "append(body, sign, opts?)",
    "The same chain check and compare-and-append as the file store, under one lock inside the process.",
  ],
];

// --- Model advice and attestation ----------------------------------------------------------------

const MODEL: readonly Export[] = [
  [
    "NearAiProposer",
    "class",
    "The NEAR AI Cloud adapter: asks a private model in a TEE for one structured proposal and captures its attestation evidence. `propose(input)` returns a `ProposeResult`. A missing API key throws `NearAiError`.",
    "Let an agent pay",
  ],
  [
    "PREFERRED_PRIVATE_MODELS",
    "constant",
    "The private TEE model ids tried first when the catalog lists them as eligible.",
    "None",
  ],
  ["CATALOG_PAGE_SIZE", "constant", "100: the page size for reading the model catalog.", "None"],
  [
    "MAX_RESPONSE_BODY_BYTES",
    "constant",
    "64 KiB. A model answer larger than this is not used, and the decision is made by the code rules only.",
    "None",
  ],
  [
    "DEFAULT_NEARAI_TIMEOUTS_MS",
    "constant",
    "The timeout of each kind of call: catalog 10 s, report 15 s, chat 90 s and signature 15 s.",
    "None",
  ],
  [
    "redactSecrets",
    "function",
    "Removes anything that looks like a credential from text before it reaches a log: the secrets you pass, `Bearer` tokens, API key fields and `sk-` keys.",
    "None",
  ],
  [
    "parseModelCatalogPage",
    "function",
    "Reads one page of the public model catalog, `GET /v1/model/list`.",
    "None",
  ],
  [
    "isAttestedStructuredModel",
    "function",
    "True for a catalog model that runs on vLLM with attestation, is verifiable and supports structured outputs.",
    "None",
  ],
  [
    "parseModelReports",
    "function",
    "Reads a model's attestation reports, and drops any without an ECDSA signer, a quote or a 64-hex request nonce.",
    "None",
  ],
  [
    "selectReport",
    "function",
    "Picks the one report whose signer signed this response. None, or more than one, gives null, which leaves the decision unattested.",
    "None",
  ],
  [
    "buildProposalRequest",
    "function",
    "Builds the exact chat request body as canonical JSON, so the same inputs always give the same bytes. From `@probarion/core`.",
    "None",
  ],
  [
    "PROPOSAL_REQUEST_TEMPLATE",
    "constant",
    "`probarion-proposal/v1`: the template id recorded with each request. From `@probarion/core`.",
    "None",
  ],
  [
    "PROPOSAL_SYSTEM_PROMPT",
    "constant",
    "The default system message of the proposal request. From `@probarion/core`.",
    "None",
  ],
  [
    "ACCEPTED_TCB_STATUSES",
    "constant",
    "The TCB statuses the online quote check accepts: `UpToDate`, `OutOfDate` and `TDRelaunchAdvised`.",
    "None",
  ],
  [
    "O1_MEASUREMENT_PINNED",
    "constant",
    "`false`: the TEE measurement is not pinned yet, so `quote_verified` stays false whatever the online quote check says.",
    "None",
  ],
  [
    "o1PolicyProblem",
    "function",
    "Why a DCAP-verified quote fails the online check's policy for this evidence, or null when it passes.",
    "None",
  ],
  [
    "nvidiaPayloadNonce",
    "function",
    "The nonce inside an NVIDIA GPU payload, as 64 lowercase hex, or null.",
    "None",
  ],
  [
    "loadDefaultOnlineVerifier",
    "function",
    "Loads the online verifier from the optional peer dependency `@nearai/inference-sdk`, or gives null when it cannot be loaded.",
    "None",
  ],
  [
    "applyOnlineChecks",
    "function",
    "Folds the online quote and GPU checks into check e of a `VerifyReport`. An offline failure stays a failure.",
    "None",
  ],
  [
    "NearAiProposerOptions",
    "type",
    "The options of `new NearAiProposer()`, from `apiKey` and `model` to the timeouts.",
    "None",
  ],
  [
    "NearAiPhase",
    "type",
    "The four kinds of call: `catalog`, `report`, `chat` and `signature`.",
    "None",
  ],
  [
    "CatalogModel",
    "type",
    "One model of the catalog, with the flags that make it eligible.",
    "None",
  ],
  [
    "ProposeInput",
    "type",
    "What `propose()` takes: the invoice text, the mandates, the nonce and the facts.",
    "None",
  ],
  [
    "ProposeResult",
    "type",
    "What `propose()` returns: the proposal, its evidence and the token usage.",
    "None",
  ],
  [
    "RawModelReport",
    "type",
    "One attestation report from the model, before one is selected.",
    "None",
  ],
  [
    "ModelProposal",
    "type",
    "A model's proposal: `action`, `mandate_id`, `amount`, `payee_hint`, `reasoning` and `confidence`. From `@probarion/core`.",
    "Why spend has no payee",
  ],
  [
    "AttestationEvidence",
    "type",
    "The evidence a ledger entry carries with a model proposal, from the request hash to the signature. From `@probarion/core`.",
    "None",
  ],
  [
    "OnlineAttestationVerifier",
    "type",
    "The online checks: DCAP verification of the TDX quote, and NVIDIA's verification of the GPU payload.",
    "None",
  ],
  ["VerifiedTdxQuote", "type", "What DCAP verification says about a TDX quote.", "None"],
];

// --- Proof ---------------------------------------------------------------------------------------

const PROOF: readonly Export[] = [
  [
    "gatherSnapshot",
    "function",
    "Reads every chain fact the verifier needs for one vault and returns a `Snapshot`. `Probarion.snapshot()` calls it.",
    "None",
  ],
  [
    "collectBurns",
    "function",
    "Finds the burn pair of every burned spend: in the hinted transactions, then the ones the ledger records, then, online, the account's transactions in the index.",
    "None",
  ],
  [
    "findBurnPair",
    "function",
    "Finds the POA token's `ft_burn` and NEAR Intents' `mt_burn` in one transaction.",
    "None",
  ],
  [
    "expectedCodeHashes",
    "function",
    "The code hashes a snapshot lists: the known vault hashes, plus the canonical factory's versions when the vault names that factory.",
    "None",
  ],
  [
    "fastnearTxIndex",
    "function",
    "A `TxIndex` over FastNEAR's transactions API, used only online.",
    "None",
  ],
  [
    "resolveArchivalRpcUrls",
    "function",
    "The archival RPC URLs: `NEAR_ARCHIVAL_RPC_URLS`, else FastNEAR's archival node for the network.",
    "None",
  ],
  [
    "DEFAULT_ARCHIVAL_RPC_URLS",
    "constant",
    "FastNEAR's archival RPC, for mainnet and for testnet.",
    "None",
  ],
  [
    "ARCHIVAL_AFTER_NS",
    "constant",
    "About 2.5 days in nanoseconds. A transaction older than this is looked up on the archival node first.",
    "None",
  ],
  [
    "PRE_LEDGER_VAULTS",
    "constant",
    "The only vault the code exempts as pre-ledger: `v0.probarion.near` on mainnet, whose spend 1 of 2026-11-11 came before its ledger. Testnet has none.",
    "None",
  ],
  ["isPreLedgerVault", "function", "True for a vault in `PRE_LEDGER_VAULTS`.", "None"],
  [
    "readPreLedgerDecisionHashes",
    "function",
    "The sha256 of each `v0-decision-*.json` file in a folder, in name order. A missing folder gives none.",
    "None",
  ],
  [
    "PRE_LEDGER_DECISION_FILE",
    "constant",
    "`v0-decision-*.json`: the file name pattern of those decision records, as a regular expression.",
    "None",
  ],
  ["DEFAULT_EVIDENCE_DIR", "constant", "`docs/evidence`, relative to the working folder.", "None"],
  [
    "DEFAULT_PROOF_FILE",
    "constant",
    "`docs/mainnet-proof.json`: the evidence file the burn hints are read from.",
    "None",
  ],
  [
    "loadBurnTxHints",
    "function",
    "Reads one vault's burn transaction hints from that evidence file. A missing file gives none.",
    "None",
  ],
  [
    "Snapshot",
    "type",
    "The chain facts and the ledger that the verifier checks. From `@probarion/core`.",
    "Verify a vault yourself",
  ],
  [
    "VerifyReport",
    "type",
    "The verifier's result: `ok`, one result per check a to i, and the burns it could not prove. From `@probarion/core`.",
    "Verifier checks a to i",
  ],
  ["SnapshotNotes", "type", "What a gathered snapshot could not establish, by check.", "None"],
  ["GatherSnapshotArgs", "type", "The arguments of `gatherSnapshot()`.", "None"],
  ["CollectBurnsArgs", "type", "The arguments of `collectBurns()`.", "None"],
  [
    "BurnPair",
    "type",
    "What `findBurnPair()` found in a transaction: the memo, the NEAR Intents owner and the amount of the burn.",
    "None",
  ],
  [
    "BurnTxHint",
    "type",
    "A transaction that may hold a burn: its hash, with its signer when known.",
    "None",
  ],
  ["BurnTxHints", "type", "Spend ids mapped to their burn hints.", "None"],
  ["TxIndex", "type", "A transactions-by-account index, used only online.", "None"],
  ["TxIndexEntry", "type", "One transaction an index lists.", "None"],
];

// --- Errors --------------------------------------------------------------------------------------

const ERRORS: readonly Export[] = [
  [
    "ProbarionError",
    "class",
    "The base class of every SDK error. `.code` names the case.",
    "Errors",
  ],
  [
    "RpcError",
    "class",
    "Every RPC URL failed, a node answered with an error, or the time ran out.",
    "Errors",
  ],
  ["RpcMalformedError", "class", "A node answered in a shape the client cannot read.", "Errors"],
  ["ViewError", "class", "A view call failed or returned something unexpected.", "Errors"],
  [
    "ContractError",
    "class",
    "A transaction the SDK sent failed on chain, such as a refused `anchor`.",
    "Errors",
  ],
  [
    "TxOutcomeUnknownError",
    "class",
    "A transaction was sent and its outcome is not known.",
    "Errors",
  ],
  ["TxRejectedError", "class", "The node refused the signed transaction before it ran.", "Errors"],
  ["ConfigError", "class", "An option or a key is missing or malformed.", "Errors"],
  ["NearAiError", "class", "The model step failed.", "Errors"],
  ["NearAiResponseTooLargeError", "class", "The model's answer is larger than 64 KiB.", "Errors"],
  ["LedgerError", "class", "The ledger store failed.", "Errors"],
  [
    "LedgerConflictError",
    "class",
    "Another writer moved the ledger first, so nothing was written.",
    "Errors",
  ],
  [
    "extractProbarionCode",
    "function",
    "Pulls a known `PROBARION:<Code>` out of a string, an error or a nested RPC failure, or gives null.",
    "Errors",
  ],
  [
    "isVaultErrorCode",
    "function",
    "True when a value is one of the vault's panic codes.",
    "Errors",
  ],
  [
    "normalizeVaultCode",
    "function",
    "Strips the `PROBARION:` prefix from a code. The result may still be a code the SDK does not know.",
    "Errors",
  ],
  [
    "RpcAttempt",
    "type",
    "One failed try in an `RpcError`'s attempt log: the URL's origin and the error.",
    "None",
  ],
  [
    "ViewErrorContext",
    "type",
    "The attempts, RPC error and cause a `ViewError` carries over.",
    "None",
  ],
];

// --- Helpers -------------------------------------------------------------------------------------

const HELPERS: readonly Export[] = [
  [
    "envValue",
    "function",
    "Reads an environment variable, treating an empty or blank value as unset, and trims a set one.",
    "None",
  ],
  [
    "Mutex",
    "class",
    "Runs tasks one at a time, in call order, with `run(task)`. A failed task does not block the next one.",
    "None",
  ],
  [
    "spentToday",
    "function",
    "The total of live spends created on the UTC day of `now`, counted the way the contract counts its daily backstop. The contract is authoritative.",
    "None",
  ],
  [
    "liveInvoiceHashes",
    "function",
    "The invoice hashes of the spends that are held, pending, paid or burned.",
    "None",
  ],
  ["usedRefs", "function", "Every ref the vault has used, released spends included.", "None"],
  [
    "ChainContext",
    "type",
    "The vault's config, mandates and spends that one decision is made from.",
    "None",
  ],
];

// --- Testing -------------------------------------------------------------------------------------

const TESTING: readonly Export[] = [
  [
    "FakeChain",
    "class",
    "A test double of the vault, NEAR Intents and factory views, with spends, payouts and anchors. It does not model owner calls, NEAR balances or gas use.",
    "None",
  ],
  [
    "createScenarioChain",
    "function",
    "A ready `FakeChain`: the factory vault `acme.vaults.probarion.testnet` with mandate 1, which pays a NEAR account, and mandate 2, which pays a Base address.",
    "None",
  ],
  [
    "startFakeRpcServer",
    "function",
    "Serves a `FakeChain` as a NEAR JSON-RPC server on `127.0.0.1`, so the SDK's real clients and senders run against it. Returns a `FakeRpcServer`.",
    "None",
  ],
  [
    "createFakeNearAi",
    "function",
    "A fake NEAR AI Cloud: a `fetch` to hand the proposer, with a model catalog, attestation reports and signed answers, and the calls it received.",
    "None",
  ],
  ["FakePanic", "class", "A contract panic with a `PROBARION:<Code>` message.", "None"],
  [
    "FakeRawPanic",
    "class",
    "A panic that is not a `PROBARION:` code, such as near-sdk's own messages. Its `code` is empty.",
    "None",
  ],
  [
    "FakeVmError",
    "class",
    "A VM failure that is not a panic, such as `Exceeded the prepaid gas.`",
    "None",
  ],
  [
    "FakeRpcFault",
    "class",
    "A JSON-RPC refusal: the node answers with an error object instead of running the call.",
    "None",
  ],
  [
    "TEST_KEYS",
    "constant",
    "Key pairs for the agent, the ledger, another key and the approver, derived from fixed public strings. Never let them hold funds.",
    "None",
  ],
  ["SCENARIO_VAULT", "constant", "`acme.vaults.probarion.testnet`: the scenario's vault.", "None"],
  ["SCENARIO_APPROVER", "constant", "`approver.testnet`: the scenario's approver.", "None"],
  [
    "SCENARIO_CODE_HASH",
    "constant",
    "The scenario vault's code hash, derived from a fixed string.",
    "None",
  ],
  [
    "SCENARIO_PURPOSE_NEAR",
    "constant",
    "The purpose hash of mandate 1, which pays a NEAR account.",
    "Let an agent pay",
  ],
  [
    "SCENARIO_PURPOSE_BASE",
    "constant",
    "The purpose hash of mandate 2, which pays a Base address.",
    "None",
  ],
  [
    "SCENARIO_NEAR_PAYEE",
    "constant",
    "`vendor.testnet`: the payee of mandate 1.",
    "Let an agent pay",
  ],
  ["SCENARIO_BASE_ADDRESS", "constant", "The Base address mandate 2 pays.", "None"],
  ["SCENARIO_NOW", "constant", "The scenario's time in nanoseconds: 2026-11-05T12:00:00Z.", "None"],
  [
    "ZERO_CODE_HASH",
    "constant",
    "`11111111111111111111111111111111`: the code hash a NEAR account without contract code reports.",
    "None",
  ],
  [
    "GAS_FLOOR_NEAR_PAYOUT",
    "constant",
    "30 Tgas: below this prepaid gas, the fake fails a NEAR payout with `Exceeded the prepaid gas.`",
    "None",
  ],
  [
    "GAS_FLOOR_INTENTS_PAYOUT",
    "constant",
    "115 Tgas: the same floor for a NEAR Intents payout.",
    "None",
  ],
  [
    "FAKE_NEARAI_BASE_URL",
    "constant",
    "The fake NEAR AI Cloud's base URL, on a `.test` host.",
    "None",
  ],
  [
    "FAKE_PRIVATE_MODEL",
    "constant",
    "A catalog model that is attested, verifiable and has structured outputs.",
    "None",
  ],
  ["FAKE_INCOGNITO_MODEL", "constant", "A catalog model with no attestation.", "None"],
  [
    "FAKE_NO_JSON_MODEL",
    "constant",
    "An attested catalog model without structured outputs.",
    "None",
  ],
  [
    "TEST_DOUBLE_TEE_PRIVATE_KEY",
    "constant",
    "The fake TEE's signing key, derived from a fixed public string.",
    "None",
  ],
  ["FakeChainInit", "type", "The state a `new FakeChain()` starts from.", "None"],
  [
    "FakeCall",
    "type",
    "One call the fake runs: signer, receiver, method, args, deposit and gas.",
    "None",
  ],
  [
    "FakeCallResult",
    "type",
    "What a call returns: the value, the vault's logs and the later receipts.",
    "None",
  ],
  ["FakeReceipt", "type", "One receipt after the vault's own.", "None"],
  [
    "FakeFactory",
    "type",
    "The factory the fake serves: its versions, the vault's version and its config.",
    "None",
  ],
  ["FakeKeyState", "type", "An access key and its nonce.", "None"],
  [
    "BurnShape",
    "type",
    "How the burn logs look: `mainnet`, or `stub` for the testnet stand-in.",
    "None",
  ],
  ["CodeMode", "type", "`local` code on the vault account, or `global` code (NEP-591).", "None"],
  [
    "PayoutFailure",
    "type",
    "Which step of the next payout fails: `ft_transfer_failed`, `ft_withdraw_failed` or `ft_withdraw_refunded`.",
    "None",
  ],
  ["ScenarioOptions", "type", "The options of `createScenarioChain()`.", "None"],
  [
    "FakeRpcServer",
    "type",
    "The running server: its `url` and `chain`, the methods it received, and `failNext`, `dropNextResponses` and `close`.",
    "None",
  ],
  [
    "FakeRpcServerOptions",
    "type",
    "How the server answers a missing access key or account: `legacy` or `structured`.",
    "None",
  ],
  [
    "FakeNearAiOptions",
    "type",
    "The options of `createFakeNearAi()`, from the model's answer to injected failures.",
    "None",
  ],
  ["FakeNearAi", "type", "The fake's `fetch`, and the calls it received.", "None"],
  ["FakeCatalogModel", "type", "One model in the fake's catalog.", "None"],
  ["FakeChatRequest", "type", "A chat request as the fake received it.", "None"],
  [
    "FakeSignatureStyle",
    "type",
    "How the fake encodes its signature: `canonical`, `raw-recovery-id`, `high-s` or `high-s-raw-recovery-id`.",
    "None",
  ],
];

// --- The tables ----------------------------------------------------------------------------------

const memberRows = (
  rows: readonly (readonly [owner: string, member: string, ...cells: string[]])[],
  keys: readonly string[],
): RefRow[] =>
  rows.map(([owner, member, ...cells]) => ({
    id: memberId(owner, member),
    cells: Object.fromEntries<string>([
      ["class", `\`${owner}\``],
      ["member", `\`${member}\``],
      ...keys.map((k, at): [string, string] => [k, cells[at] ?? ""]),
    ]),
  }));

export const TABLES: readonly RefTable[] = [
  exportTable("sdk-client", "The client", "sdk-", CLIENT),
  {
    id: "sdk-client-members",
    label: "Probarion members",
    columns: [
      { key: "member", label: "Member" },
      { key: "what", label: "What it does" },
      { key: "signs", label: "Signed by" },
      { key: "shown", label: "Shown on" },
    ],
    rows: CLIENT_MEMBERS.map(([member, what, signs, shown]) => ({
      id: memberId("Probarion", member),
      cells: { member: `\`${member}\``, what, signs, shown },
    })),
  },
  {
    id: "sdk-deps",
    label: "ProbarionDeps fields",
    columns: [
      { key: "field", label: "Field" },
      { key: "what", label: "What it sets" },
      { key: "dflt", label: "Default" },
    ],
    rows: DEPS.map(([field, what, dflt]) => ({
      id: `sdk-deps-${field.toLowerCase()}`,
      cells: { field: `\`${field}\``, what, dflt },
    })),
  },
  exportTable("sdk-chain", "Chain clients and transactions", "sdk-", CHAIN),
  {
    id: "sdk-chain-members",
    label: "Chain client members",
    columns: [
      { key: "class", label: "Class" },
      { key: "member", label: "Member" },
      { key: "what", label: "What it does" },
      { key: "signs", label: "Signed by" },
    ],
    rows: memberRows(CHAIN_MEMBERS, ["what", "signs"]),
  },
  exportTable("sdk-ledger", "Ledger stores", "sdk-", LEDGER),
  {
    id: "sdk-ledger-members",
    label: "Ledger store members",
    columns: [
      { key: "class", label: "Class" },
      { key: "member", label: "Member" },
      { key: "what", label: "What it does" },
    ],
    rows: memberRows(LEDGER_MEMBERS, ["what"]),
  },
  exportTable("sdk-model", "Model advice and attestation", "sdk-", MODEL),
  exportTable("sdk-proof", "Snapshot and proof", "sdk-", PROOF),
  exportTable("sdk-errors", "Errors", "sdk-", ERRORS),
  exportTable("sdk-helpers", "Helpers", "sdk-", HELPERS),
  exportTable("sdk-testing", "Test doubles", "sdk-testing-", TESTING),
];
