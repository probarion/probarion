# Probarion for Chrome

A Manifest V3 extension that queues invoices from the browser into a Probarion vault, and shows what waits for your
confirmation. It can't pay or approve: a queued invoice waits until the vault's owner confirms it in the console with
a wallet signature.

## Load it unpacked

It needs Chrome 127 or newer, Node 24 or newer and pnpm 10. `pnpm install --filter @probarion/extension...` installs
only what the extension needs.

    pnpm install --filter @probarion/extension...
    pnpm --filter @probarion/extension build

Then open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and pick `apps/extension/dist`.

For a local `next dev` on `http://localhost:3000`, build with `pnpm --filter @probarion/extension build:dev`. That
build also trusts localhost, so do not upload it.

## Try it

It needs a vault and a mandate on NEAR testnet; the console's first-run checklist makes both, with test USDC that
has no value.

1. Click the Probarion icon, set **Probarion address** to `probarion.vercel.app`, then press **Connect**. Sign in on
   the page that opens with a NEAR testnet wallet, and press **Connect extension**. The page says "Connected. You
   can close this tab." (These steps use `probarion.vercel.app` because it serves NEAR testnet. `probarion.xyz` is
   the main address and will serve NEAR mainnet once mainnet opens.)
2. Open https://probarion.vercel.app/samples/probarion-sample-invoice.txt, select its text, right-click, and choose
   **Send selection as invoice text**. The popup opens with the text.
3. Choose the vault and the mandate and press **Send to Probarion**. You see "Queued. It waits for your
   confirmation." (A second send of the same text says it is already queued.)
4. Press **Open**: the invoice waits in the console for your wallet-signed **Confirm**. The extension can't pay.

An invoice sent from the browser comes with no purpose document, so it carries the hold
`extension.mandate_chosen`: only the owner's signed Confirm, which names the mandate, the amount and the invoice
hash, pays it.

## Scripts

| Script | What it does |
|---|---|
| `build` | Release build into `dist/` |
| `build:dev` | The same, also trusting `http://localhost:3000` |
| `zip` | Release build, then `probarion-extension-<version>.zip` for the Chrome Web Store |
| `render` | Renders the icons and the store images with a local headless Chrome; commit the results |
| `test` | The unit tests, on a fake `chrome` and a fake `fetch` |
| `typecheck` | `tsc` over the source, the tests and the scripts |

## How it works

- `src/worker.ts`: the service worker. It holds the right-click menus, the badge and its 5-minute alarm, and receives
  the connect message. The jobs themselves are in `src/background.ts`.
- `src/content.ts`: runs only on Probarion's `/extension` page. It passes the connect message to the worker.
- `src/popup/`: the popup.
- `src/api.ts`: the client of `/api/ext/*`. It sends a Bearer token and no cookies.
- `scripts/manifest.mjs`: the manifest, and the one list of Probarion origins the code trusts.

The extension asks for `storage`, `contextMenus`, `activeTab` and `alarms`, plus host access to the three Probarion
addresses. Why each is needed: `store/permissions.md`.

Manual checks before a release: `TESTING.md`.
