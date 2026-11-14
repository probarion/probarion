import type { RefColumn, RefTable } from "./types";

/**
 * The tables of /docs/build/cli-reference: the program options, one table per command group of
 * `buildProgram` (packages/cli/src/program.ts), and the exit codes. test/docs-ref-cli.test.ts builds
 * the program and pins these rows to it: the command paths, each option's flags as commander spells
 * them, which options are required (marked by commander, or refused at run time), each default, who
 * signs, the gas and deposit of each printed call, the `help` command that commander adds, the exit
 * codes that `check --help`, `payee check --help`, `account audit --help`, `tx prove --help` and
 * `verify --help` list, and the number ranges and
 * caps that the "What it does" cells of `vault create`, `mandate create`, `agent add` and `check`
 * state, read from the CLI's source and the vault's constants.
 *
 * An options cell lists every option of its command as "`<flags>`", followed by "(required)" when
 * the command cannot run without it and "(default `<value>`)" when commander gives it a default.
 */

const COMMAND_COLUMNS: readonly RefColumn[] = [
  { key: "command", label: "Command" },
  { key: "options", label: "Options" },
  { key: "does", label: "What it does" },
  { key: "signs", label: "Who signs" },
];

const VAULT = "`--vault <id>`";
const SIGN_AS = "`--sign-as <account>`";
const OUT_DIR = "`--out-dir <dir>` (default `.`)";

/** The options of a printed vault call: the vault, the call's own options, the signer, the folder. */
const callOptions = (...own: string[]) => [VAULT, ...own, SIGN_AS, OUT_DIR].join(", ");

export const TABLES: readonly RefTable[] = [
  {
    id: "cli-program-options",
    label: "Program options",
    columns: [
      { key: "option", label: "Option" },
      { key: "fallback", label: "When not given" },
      { key: "does", label: "What it does" },
    ],
    rows: [
      {
        id: "cli-option-network",
        cells: {
          option: "`--network <network>`",
          fallback: "`NEAR_NETWORK`, else `testnet`",
          does: "The network, `mainnet` or `testnet`. Any other value is an error. A printed call carries it as `network-config`. `agent keygen` and `ledger export` do not read it, and `verify --offline` refuses it.",
        },
      },
      {
        id: "cli-option-rpc",
        cells: {
          option: "`--rpc <urls>`",
          fallback: "`NEAR_RPC_URLS`, else the network's default RPCs",
          does: "Comma-separated NEAR RPC URLs. Only the commands that read the chain use them: `vault create`, `check`, `payee check` and `verify`. An empty list is an error, and `verify --offline` refuses it.",
        },
      },
      {
        id: "cli-option-version",
        cells: {
          option: "`-V`, `--version`",
          fallback: "None",
          does: "Prints the CLI's version, `0.1.1`, and exits 0.",
        },
      },
      {
        id: "cli-option-help",
        cells: {
          option: "`-h`, `--help`",
          fallback: "None",
          does: "Prints the help of the program, or of the command it follows, and exits 0. The help of `check`, `payee check` and `verify` also lists their exit codes.",
        },
      },
    ],
  },
  {
    id: "cli-commands-vault",
    label: "Vault commands",
    columns: COMMAND_COLUMNS,
    rows: [
      {
        id: "cli-vault-create",
        cells: {
          command: "`vault create`",
          options: [
            "`--name <name>` (required)",
            "`--approvers <list>` (required)",
            "`--daily-backstop <usdc>` (default `500`)",
            "`--held-ttl-hours <hours>` (default `72`)",
            "`--deposit <near>`",
            SIGN_AS,
            OUT_DIR,
          ].join(", "),
          does: "Reads the factory's current version and `min_deposit`, then prints the factory's `create_vault` call for the vault `<name>.<factory>`. The name is 2 to 31 characters of `a-z`, `0-9`, `_` and `-`, starts with a letter or digit, and must make `<name>.<factory>` a valid NEAR account id: at most 64 characters in all, no `-` or `_` at the end of the name, and never two of them in a row. It takes 1 to 10 distinct approvers. The daily backstop is the most the vault reserves or pays in one UTC day, and a hold lasts 1 to 720 hours. `--deposit` is required when the factory's current version is embedded. The factory is `PROBARION_FACTORY_ID`, else the network's.",
          signs:
            "The owner: the account that signs becomes the vault's owner. `300.0 Tgas`, and a deposit of `--deposit` NEAR, else the factory's `min_deposit`, which stays in the vault for storage and gas.",
        },
      },
      {
        id: "cli-vault-freeze",
        cells: {
          command: "`vault freeze`",
          options: callOptions(),
          does: "Prints the vault's `freeze` call. Until `unfreeze`, the vault refuses every new spend and every approve. `reject` and `expire_held` still work.",
          signs:
            "The owner. `30.0 Tgas` and no deposit, so a full-access key, or a function-call key of the owner's account that may call this vault, can sign it.",
        },
      },
      {
        id: "cli-vault-unfreeze",
        cells: {
          command: "`vault unfreeze`",
          options: callOptions(),
          does: "Prints the vault's `unfreeze` call, which lets spends and approvals run again.",
          signs:
            "The owner. `30.0 Tgas` and `1 yoctoNEAR`, so only a full-access key, through a wallet prompt, can sign it.",
        },
      },
      {
        id: "cli-vault-withdraw",
        cells: {
          command: "`vault withdraw`",
          options: callOptions("`--amount <usdc>` (required)"),
          does: "Prints the vault's `withdraw` call, which sends native USDC from the vault to the vault owner's account and nowhere else.",
          signs: "The owner. `100.0 Tgas` and `1 yoctoNEAR`.",
        },
      },
      {
        id: "cli-vault-withdraw-intents",
        cells: {
          command: "`vault withdraw-intents`",
          options: callOptions("`--token <token>` (required)", "`--amount <usdc>` (required)"),
          does: "Prints the vault's `withdraw_intents` call: the intents contract sends the vault's USDC balance inside NEAR Intents to the owner's account and nowhere else. `--token` is `base`, `solana` or one of the network's two allowed USDC asset ids.",
          signs: "The owner. `150.0 Tgas` and `1 yoctoNEAR`.",
        },
      },
    ],
  },
  {
    id: "cli-commands-mandate",
    label: "Mandate commands",
    columns: COMMAND_COLUMNS,
    rows: [
      {
        id: "cli-mandate-create",
        cells: {
          command: "`mandate create`",
          options: [
            VAULT,
            "`--payee <payee>` (required)",
            "`--max-per <usdc>` (required)",
            "`--max-total <usdc>` (required)",
            "`--uses <n>` (required)",
            "`--expires <date>` (required)",
            "`--approval-above <usdc>` (required)",
            "`--agent-pk <pk>` (required)",
            "`--purpose <file|hex>` (required)",
            "`--label <label>` (required)",
            "`--deposit <near>` (default `0.05`)",
            SIGN_AS,
            OUT_DIR,
          ].join(", "),
          does: "Prints the vault's `create_mandate` call. The payee is `near:<account>`, `base:<0x address>` or `solana:<address>`, never the vault itself, and it never changes. `--max-per` is above 0 and at most `--max-total`, and `--uses` is 1 to 4294967295. `--expires` is a future `YYYY-MM-DD`, meaning the end of that UTC day, or an ISO-8601 time with its zone. Spends above `--approval-above` are held for an approver. `--purpose` is a file the CLI hashes with sha256, or the 64-hex hash. `--label` is at most 64 bytes. Only the `--agent-pk` key may spend against the mandate.",
          signs:
            "The owner. `100.0 Tgas`, and a deposit of `--deposit` NEAR, of which the vault refunds the excess.",
        },
      },
      {
        id: "cli-mandate-revoke",
        cells: {
          command: "`mandate revoke`",
          options: callOptions("`--mandate <id>` (required)"),
          does: "Prints the vault's `revoke_mandate` call. Pending spends keep their reservation until they settle or fail, and `approve` then refuses them with `MandateInactive`.",
          signs: "The owner. `30.0 Tgas` and `1 yoctoNEAR`.",
        },
      },
    ],
  },
  {
    id: "cli-commands-agent",
    label: "Agent commands",
    columns: COMMAND_COLUMNS,
    rows: [
      {
        id: "cli-agent-keygen",
        cells: {
          command: "`agent keygen`",
          options: "`--json`, `--out <file>`, `--print-secret`",
          does: "Generates an ed25519 key pair on this machine. It needs `--out` or `--print-secret`, not both. `--out` saves the pair to a new file, owner-only where the system enforces file modes, and prints only the public key. It warns on Windows, and when the file is inside a git repository. `--print-secret` prints the secret key to the terminal. `--json` prints JSON.",
          signs:
            "Nothing: no transaction. Give the public key to the owner for `agent add` or `ledger set-key`.",
        },
      },
      {
        id: "cli-agent-add",
        cells: {
          command: "`agent add`",
          options: callOptions(
            "`--pk <pk>` (required)",
            "`--allowance <near>` (default `1`)",
            "`--label <label>` (default `agent`)",
          ),
          does: "Prints the vault's `add_agent` call: the vault adds a function-call key to itself that may call only `spend` and never attaches a deposit. The allowance is the key's gas allowance, above 0, and the label is at most 64 bytes. A vault holds at most 16 agent keys, and a key cannot be both an agent key and the ledger key.",
          signs: "The owner. `30.0 Tgas` and `1 yoctoNEAR`.",
        },
      },
      {
        id: "cli-agent-remove",
        cells: {
          command: "`agent remove`",
          options: callOptions("`--pk <pk>` (required)"),
          does: "Prints the vault's `remove_agent` call: the vault deletes the agent's key, so it can sign no further spends. Spends already held still wait for an approver.",
          signs: "The owner. `30.0 Tgas` and `1 yoctoNEAR`.",
        },
      },
    ],
  },
  {
    id: "cli-commands-ledger",
    label: "Ledger commands",
    columns: COMMAND_COLUMNS,
    rows: [
      {
        id: "cli-ledger-set-key",
        cells: {
          command: "`ledger set-key`",
          options: callOptions("`--pk <pk>` (required)", "`--allowance <near>` (default `0.25`)"),
          does: "Prints the vault's `set_ledger_key` call: a function-call key that may call only `anchor`. It replaces the previous ledger key, so anchor the ledger before you rotate. The key must not already be an agent key, and the allowance is above 0.",
          signs: "The owner. `30.0 Tgas` and `1 yoctoNEAR`.",
        },
      },
      {
        id: "cli-ledger-export",
        cells: {
          command: "`ledger export`",
          options: "`--out <file>` (required), `--ledger <path>`",
          does: "Copies the ledger to a new file as JSONL, one entry per line, and prints how many entries it wrote. It refuses an `--out` file that exists or is the ledger itself, and a ledger file that does not exist. `--ledger` falls back to `PROBARION_LEDGER_PATH`, else `.probarion/ledger.jsonl`.",
          signs: "Nothing: read-only. It writes only the new file.",
        },
      },
    ],
  },
  {
    id: "cli-commands-spend",
    label: "Spend commands",
    columns: COMMAND_COLUMNS,
    rows: [
      {
        id: "cli-spend-approve",
        cells: {
          command: "`spend approve`",
          options: callOptions("`--spend <id>` (required)"),
          does: "Prints the vault's `approve` call for a held spend, which pays the mandate's payee. It works until the hold expires, and the vault refuses it while frozen.",
          signs: "An approver. `150.0 Tgas` and `1 yoctoNEAR`.",
        },
      },
      {
        id: "cli-spend-reject",
        cells: {
          command: "`spend reject`",
          options: callOptions("`--spend <id>` (required)"),
          does: "Prints the vault's `reject` call for a held spend, which releases its reservation and its invoice hash. The ref stays used.",
          signs: "An approver. `30.0 Tgas` and `1 yoctoNEAR`.",
        },
      },
    ],
  },
  {
    id: "cli-commands-check",
    label: "The check command",
    columns: COMMAND_COLUMNS,
    rows: [
      {
        id: "cli-check",
        cells: {
          command: "`check`",
          options: [
            VAULT,
            "`--mandate <id>` (required)",
            "`--amount <usdc>` (required)",
            "`--invoice <file>` (required)",
            "`--ref <ref>` (required)",
            "`--agent-pk <pk>`",
            "`--json`",
          ].join(", "),
          does: "Asks the vault's free `check_spend` view whether it would accept this spend. It prints `OK: the vault would accept this spend`, with `and hold it for an approver` when the vault would hold it, or `REFUSED: PROBARION:<Code>`. The invoice is the extracted invoice text, a UTF-8 file, hashed the way the SDK hashes it. The ref is 1 to 64 bytes. It checks as `--agent-pk`, else as the public key of `PROBARION_AGENT_KEY`, else as the mandate's agent. `--json` prints the request, the signer and the verdict.",
          signs: "Nothing: read-only. A free view call: nothing is signed or sent.",
        },
      },
    ],
  },
  {
    id: "cli-commands-payee",
    label: "Payee commands",
    columns: COMMAND_COLUMNS,
    rows: [
      {
        id: "cli-payee-check",
        cells: {
          command: "`payee check <payee>`",
          options: [VAULT, "`--archival-rpc <urls>`", "`--base-rpc <url>`", "`--json`"].join(", "),
          does: "Checks a payee before a mandate names it, and prints `ALLOW`, `WARN` or `BLOCK` with one reason per check: whether the NEAR account exists, the seed blocklist, a lookalike of the vault's payees, contract code, new or code changed in about 7 days, and past payments. The payee is `near:<account>`, `base:<0x address>` or `solana:<address>`. On Base, new means nonce 0, a weaker sign. Solana is not read, and Base on testnet only with `--base-rpc`. A read it could not make warns, and so does a run with no vault: `--vault` falls back to `PROBARION_VAULT_ID`. `--archival-rpc` falls back to `NEAR_ARCHIVAL_RPC_URLS`, else FastNEAR's archival node, and `--base-rpc` to `https://mainnet.base.org` on mainnet and to none on testnet. `--json` prints the assessment and the signals it was made from. In this repository, not in npm 0.1.1.",
          signs: "Nothing: read-only. It signs and sends nothing, and changes nothing on chain.",
        },
      },
    ],
  },
  {
    id: "cli-commands-account",
    label: "Account commands",
    columns: COMMAND_COLUMNS,
    rows: [
      {
        id: "cli-account-audit",
        cells: {
          command: "`account audit <account>`",
          options: ["`--vault-policy`", "`--builds <file>`", "`--json`"].join(", "),
          does: "Audits any NEAR account at one block. It reads `view_account` at the final block and `view_access_key_list` at that block, and says what each access key can do if it leaks (full access, receiver and methods, the allowance for gas, gas keys) and what code the account runs (its own code, or a NEP-591 global contract by hash or by publisher account). A permission it cannot read counts as full access. `--vault-policy` holds the keys to a Probarion vault's (function-call keys on the account itself for `spend` or `anchor`, each with a limited allowance and no gas key) and the code to the recorded vault builds. It does not pin the anchor key to the vault's ledger key, which `verify` check f does. `--builds` names the builds the code must match: a code-hashes record such as `contracts/code-hashes.json`, or a list. `--json` prints the report, with amounts as decimal strings. It runs the account lock audit of `@probarion/near`. In this repository, not in npm 0.1.1.",
          signs: "Nothing: it reads two views, and signs and sends nothing.",
        },
      },
    ],
  },
  {
    id: "cli-commands-tx",
    label: "Transaction commands",
    columns: COMMAND_COLUMNS,
    rows: [
      {
        id: "cli-tx-prove",
        cells: {
          command: "`tx prove <tx-hash>`",
          options: [
            "`--signer <account>` (required)",
            "`--head-rpc <urls>`",
            "`--archival-rpc <urls>`",
            "`--json`",
          ].join(", "),
          does: "Proves a transaction and every receipt it led to. It reads the head block on one RPC origin and matches its hash, height and `block_merkle_root` on another, reads the transaction, fetches a `light_client_proof` for it and for each receipt, and verifies each one under that head. It prints each proven outcome (id, executor, block height, status) with the NEP-297 events it logged, and a failed receipt is proven as a failure. `--signer` is the account that signed the transaction. `--head-rpc` takes URLs on at least two origins and falls back to `--rpc`, `NEAR_RPC_URLS`, then the network defaults, which are on one origin on testnet, so give two there. `--archival-rpc` falls back to `NEAR_ARCHIVAL_RPC_URLS`, else FastNEAR's archival node. The head is trusted, not proven: validator signatures are not checked. `--json` prints the head, the origins and the proven outcomes. It runs the outcome proof verifier and the event reader of `@probarion/near`. In this repository, not in npm 0.1.1.",
          signs:
            "Nothing: it reads blocks, the transaction and its proofs, and signs and sends nothing.",
        },
      },
    ],
  },
  {
    id: "cli-commands-verify",
    label: "The verify command",
    columns: COMMAND_COLUMNS,
    rows: [
      {
        id: "cli-verify",
        cells: {
          command: "`verify`",
          options: [
            VAULT,
            "`--online`",
            "`--snapshot <out>`",
            "`--offline <file>`",
            "`--json`",
            "`--ledger <path>`",
            "`--evidence <dir>` (default `docs/evidence`)",
            "`--archival-rpc <urls>`",
            "`--burn-tx <spend_id=hash[@signer]>` (repeatable)",
            "`--proof <file>`",
            "`--invoice <file>` (repeatable)",
            "`--invoices <dir>` (repeatable)",
            "`--system-prompt <file>` (repeatable)",
          ].join(", "),
          does: "Runs checks a to i on the vault's chain state and its ledger file, and prints one row per check, the counts and a `RESULT` line, or the report as JSON with `--json`. `--offline` verifies a saved snapshot with no network, and refuses every option that would shape one. `--snapshot` saves the snapshot it verified to a new file. `--online` adds O1 and O2 and FastNEAR's tx index. `--burn-tx`, `--proof` and `--archival-rpc` help check h find a burn. `--evidence` is read for `v0.probarion.near` on mainnet only. `--invoice` and `--invoices` (every `.txt` file of a folder) add A8 to check e, live or with `--offline`: invoice texts you hold, read on your machine and matched to the ledger by sha256. A8 accepts the standard system prompt; `--system-prompt` adds another one, the prompt's exact text, for a decision made under it. Release 0.1.1 on npm does not have these three.",
          signs: "Nothing: read-only.",
        },
      },
    ],
  },
  {
    id: "cli-commands-help",
    label: "The help command",
    columns: COMMAND_COLUMNS,
    rows: [
      {
        id: "cli-help",
        cells: {
          command: "`help [command]`",
          options: "None",
          does: "Prints the help of the command it names, or of the program when it names none, as `--help` does: `help verify` prints what `verify --help` prints. Each group has its own for the commands in it: `vault help`, `mandate help`, `agent help`, `ledger help`, `spend help`, `payee help`, `account help` and `tx help`, so `vault help create` prints the help of `vault create`.",
          signs: "Nothing: no transaction.",
        },
      },
    ],
  },
  {
    id: "cli-exit-codes",
    label: "Exit codes",
    columns: [
      { key: "code", label: "Code" },
      { key: "check", label: "check" },
      { key: "payee", label: "payee check" },
      { key: "account", label: "account audit" },
      { key: "tx", label: "tx prove" },
      { key: "verify", label: "verify" },
      { key: "other", label: "Every other command" },
    ],
    rows: [
      {
        id: "cli-exit-0",
        cells: {
          code: "`0`",
          check: "The vault would accept the spend. It may hold it for an approver.",
          payee: "Allow: every check ran and passed.",
          account:
            "Locked: no key acts as full access, and the key policy and the recorded build match when given.",
          tx: "Proven: the transaction and every receipt it led to are committed under the head. A failed receipt is proven as a failure.",
          verify:
            "No check fails or is UNPROVEN. A skipped check still exits 0: check i skips a vault that names no factory.",
          other:
            "Done: the command printed its transaction, its key, its help or its version, or wrote its file.",
        },
      },
      {
        id: "cli-exit-1",
        cells: {
          code: "`1`",
          check:
            "The vault would refuse the spend, or the check could not run: `error:` on stderr.",
          payee: "Block: a reason not to pay, or the check could not run: `error:` on stderr.",
          account:
            "Not locked, a blocking finding (a key outside the policy, code that is not a recorded build), or a failed read: `error:` on stderr.",
          tx: "Not proven: a proof did not verify, the two head providers disagree, or a read failed: `error:` on stderr.",
          verify:
            "A check fails, which always wins over unproven, or verify could not run: `error:` on stderr and no `RESULT` line.",
          other:
            "An error: a bad value, a missing or unknown option, or a file the command refuses. The message is on stderr.",
        },
      },
      {
        id: "cli-exit-2",
        cells: {
          code: "`2`",
          check: "None",
          payee:
            "Warn: something to confirm with the payee first, a read it could not make, or no vault given.",
          account:
            "Locked, with a warning to read: a key that can call any method, or an unlimited allowance.",
          tx: "None",
          verify:
            "No check fails, but at least one is UNPROVEN: its row names the spends and what to supply.",
          other: "None",
        },
      },
      {
        id: "cli-exit-64",
        cells: {
          code: "`64`",
          check:
            "A usage error: a missing, malformed or conflicting flag, an `--invoice` file that is not UTF-8 text, or a `PROBARION_AGENT_KEY` that is not an ed25519 secret key.",
          payee:
            "A usage error: a missing or malformed payee, a `--vault` or `PROBARION_VAULT_ID` that is not a NEAR account id, an empty URL list, or an unknown or malformed flag.",
          account:
            "A usage error: a missing or malformed account, an unknown or malformed flag, or a `--builds` file that cannot be read.",
          tx: "A usage error: a missing or malformed hash or `--signer`, an unknown or malformed flag, or head URLs on fewer than two origins.",
          verify:
            "A usage error: a missing, malformed or conflicting flag, a `--snapshot` file that exists or is the ledger, an `--offline` snapshot whose `vault`, `network` or `taken_at` is malformed, an `--invoices` folder that cannot be read or holds no `.txt` file, or an invoice or `--system-prompt` file that cannot be read or is not UTF-8 text.",
          other: "None",
        },
      },
    ],
  },
];
