# Writing a docs page

Each file here is one page of `/docs`. The page's metadata lives in the registry (`src/lib/docs/pages/<section>.ts`), not in frontmatter. The tests in `test/docs-*.test.ts` enforce most rules below.

## The page

- No H1: the page head shows the title. Use `##` and `###` only, and no two headings with the same text.
- The registry entry holds the title, a 50 to 160 character description, a one or two sentence lede, the type, the audiences, the status, the network and the source files you checked.
- Tutorial: say the outcome, the time and what you need in the first sentence. Use one `<Steps>` list of at most 7 steps. Show the expected output verbatim. End with "Next steps".
- How-to: the goal, what you need, the steps, common mistakes, related pages.
- Explanation: the answer first. The last H2 is exactly "What this does not do". Put "Where to go next" and similar sections above it.
- Reference: tables, exact names, one anchor per item.

## Truth

- Every claim traces to a file on `dev`. Where a brief and the code disagree, the code wins.
- An edit that re-checks a page against the code sets the entry's `reviewed` to that day and adds every file it read to `sources`.
- Status words are Live (works in this deployment), Preview (built, not yet run end to end with real wallets, or not open yet) and Planned (not built). Nothing else.
- NEAR testnet is live. On mainnet one small vault is live, `v0.probarion.near`, since 2026-11-11: no mainnet factory is deployed, and on 2026-11-13 it made one Base payout, a 1.00 USDC test to the owner's own Base address, decided by code rules alone.
- The packages are on npm at 0.1.1: `@probarion/core`, `@probarion/sdk`, `probarion` and `@probarion/mcp`. An install line names only them: `npm install @probarion/core`, `npm install @probarion/sdk @probarion/core` or `npm install -g probarion`. The MCP server runs as `npx -y @probarion/mcp@0.1.1`.
- A page that runs the repository's fixtures, scripts or tests builds from a clone. Show the clone and build steps exactly as `CLI_SETUP_LINES` in `src/lib/proof/cli.ts` writes them, and run the CLI there as `node packages/cli/dist/bin.js <command>`.
- Program options may come before the command, as the site writes them: `node packages/cli/dist/bin.js --network testnet vault create ...`.
- No secrets in examples. Use placeholders such as `ed25519:...`.

## Components

| Component | Use |
|---|---|
| `<Callout kind="note">`, `"warning"`, `"key"` | A boxed note; `key` is an ink card for a core idea. Optional `title="..."`. |
| `<Callout kind="owner-signs">` | Required on any page that shows a call the owner signs (vault create, freeze, unfreeze, withdraw, withdraw-intents; mandate create, revoke; agent add, remove; ledger set-key). It adds "Probarion never signs it." |
| `<Callout kind="approver-signs">` | Required on any page that shows `spend approve` or `spend reject`. |
| `<Steps>` | Wraps one numbered list. |
| `<Flow>` | Wraps one numbered list whose items start with a bold title: a step strip. |
| `<CodeTabs labels="Shell, Text">` | Two or more fenced blocks, one per label. |
| `<CodeBlock title="file.ts">` | One fenced block with a file name. |
| `<ErrorCatalog kind="vault" />`, `"sdk"`, `"http"` | The generated error tables. Each row is an anchor (`#NoMandate`, `#RpcError`, `#http-404-not_found`: an HTTP row's anchor is `http-<status>-<code>`). |
| `<SpendChecks />` | The 14 spend checks, in contract order. |
| `<VerifierChecks />`, `<VerifierChecks only="a, c" />` | The verifier checks, each anchored at `#check-a` ... `#check-i`. |
| `<StatusTable />` | The landing's status rows, each anchored by its id. |
| `<AgentRules />` | The rules for agents (the same text as `/llms.txt`). |
| `<RefTable id="sdk-client" />` | A reference table from `src/lib/docs/ref/`. The rows are data there, pinned to the code by `test/docs-ref-<area>.test.ts`; the page explains how to read them and never repeats them. Each row with an id is an anchor. |
| `<Changelog />` | The repository `CHANGELOG.md`, on `resources/changelog` only. Each heading is an anchor: a version's is the slug of its text, and a section's starts with its version's, such as `#unreleased-added`. A relative link opens the file on GitHub, and a link to `https://probarion.xyz` or its `www` host becomes a site path. Then every link meets the link rules below, and a GitHub link points at `github.com/probarion/`. The copy rules hold in its text too, except the bare `npm install` it quotes. A table, an image, a reference-style link or raw HTML in `CHANGELOG.md` fails the build. Its text names CLI commands but shows no call, so the page needs no signing callout. |
| `<ArchitectureDiagram />` | The diagram in `src/lib/docs/architecture.ts`, on `operate/architecture` only. |
| `<HubSearch>`, `<HubDoors>`, `<Door who title href go also? alsoHref? ink?>`, `<HubCards>`, `<Card title href tag?>`, `<HubAgents example="<page path>" />` | The docs home only. `?` marks an optional prop. Every door needs `go`, and `also` and `alsoHref` go together: one without the other fails the build. Write `ink` bare, for the ink door. `index.mdx` must contain `<HubSearch>`, which wraps the list of popular searches (`#popular`), and must not write a "Choose a path" heading: `<HubDoors>` renders it. A door's `href` and `alsoHref` and a card's `href` point at a docs page, never at a `.md` twin or an llms file: `<HubAgents>` links those. |

Write a component's children on their own lines, with a blank line around fenced blocks. Props are plain strings (`kind="note"`) or a bare name (`ink`), never expressions. No `import`, no `export`, no `{...}` expressions: the build fails on them. In prose, put `<` and `{` in inline code or escape them as `\<` and `\{`.

### Who signs

The signing check reads every fenced block on the page, in any language, and joins a line that ends in `\` with the next one.

- A CLI line for vault create, freeze, unfreeze, withdraw or withdraw-intents, mandate create or revoke, agent add or remove, or ledger set-key needs `<Callout kind="owner-signs">` on the page.
- A `near ... call-function` line naming `create_vault`, `create_mandate`, `revoke_mandate`, `add_agent`, `remove_agent`, `set_ledger_key`, `freeze`, `unfreeze`, `withdraw` or `withdraw_intents` needs it too.
- `spend approve`, `spend reject` and the `approve` and `reject` contract calls need `<Callout kind="approver-signs">`, never `owner-signs`.

Put the callout next to the command it covers.

## Links

- Internal links start with `/`: `/docs/build/errors#NoMandate`. Every page and anchor must exist. Never a relative link, never `http:`, never `mailto:`.
- A link to a page of this site is a site path, never `https://probarion.xyz/...` or the `www` host.
- `/docs/<page>.md` links the page's Markdown twin; the page must exist. A link to another site path must be a route or a public file.
- The phase-1 docs do not link `/canary` or `/extension`.
- Repository files: `https://github.com/probarion/probarion/blob/main/<path>` (or `tree`, or `dev`). The path must exist.
- Image URLs follow the same rules.
- A page planned for a later phase is named in plain text, not linked.

## Code fences

Name the language: `bash`, `text`, `ts`, `tsx`, `js`, `json`, `rust`, `md` or `toml`. Commands go in `bash` fences, one per line, with no `$` prompt. A long command may end a line in `\` and go on in the next one. Output goes in `text` fences.

In a `bash` fence:

- A line that runs the CLI starts with `node packages/cli/dist/bin.js`, or, only in a step that runs in the reader's own project folder, with `probarion` or `npx probarion` for the CLI from npm. A clone's steps use the CLI it builds, since `npx probarion` downloads release 0.1.1 from npm and a step that promises to run offline cannot. Never an env prefix, `cd ... &&` or `./`. A line that names `bin.js` anywhere but at its start fails, unless the line is a `#` comment.
- Only `--network <name>` and `--rpc <url>` come before the command, each with a space (not `=`). After them comes a real command, `--help` or `--version`.
- The commands are the CLI's own: vault (create, freeze, unfreeze, withdraw, withdraw-intents), mandate (create, revoke), agent (keygen, add, remove), ledger (set-key, export), spend (approve, reject), check and verify. Every `--flag` after the command words is an option the CLI defines.

A fence that contains `git clone` contains the lines of `CLI_SETUP_LINES` too, one after another, in order. Only that setup block clones the repository.

## Copy

These rules hold in the raw MDX, fenced blocks included, and in the page's Markdown twin. The changelog's twin may quote a bare `npm install` from `CHANGELOG.md`; every other rule holds there too.

- No em dash, no "please".
- No exclamation mark in prose. This also holds in a string prop (a callout, door or card title, a door's `go`) and in the registry title, nav, description and lede. Inline code and fenced blocks may contain one.
- Never "guarantee", "100%" or "unhackable".
- Install the packages with npm, and only the three published ones. No `pnpm add` or `yarn add` of them.
- No `security@` or `support@` mailbox, and no `status.probarion.xyz`.
- Name only Probarion and its dependencies. Never name another project of the author.
