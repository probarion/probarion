# Manual checklist

Run it before each store upload. Write the date, the Chrome version and each result in the PR. The commands are for
Windows PowerShell 5.1, one per line; run `pnpm` ones from the repository root.

## Setup

- [ ] The database `next dev` uses has every migration through `20261108000015_extension_queue.sql` (the OWNER runs
      them). One database serves both networks, so this checklist writes real rows: use a testnet vault.
- [ ] `pnpm --filter @probarion/web dev` runs on http://localhost:3000, and you are signed in with a testnet wallet
      that owns a vault. The server's environment has `TESTNET_FAUCET_KEY`: without it the Top-up tab shows "Need test
      USDC? Send @probarionhq a direct message on X ..." instead of the "Add test USDC" button, and you fund the vault
      another way.
- [ ] The vault has active keys (Keys tab), a mandate made from the sample purchase order (the mandate form offers
      it), and test USDC (Top-up tab, "Add test USDC"). The vault's "Your first agent payment" card lists these steps.
- [ ] Test files, in a scratch folder: a copy of `apps/web/public/samples/probarion-sample-invoice.txt` with
      `INV-1001` changed to a number not used before (a fresh one each run); a second copy with the line
      `Pay to: other-payee.testnet` added; a third copy with another new number (for the optional approver step); a PDF
      of the first copy (open it in a Chrome tab, press Ctrl+P, choose Save as PDF); a `.docx` (any file with that
      extension); and a 5 MiB file named `big.pdf` (the popup refuses it by its size alone). In PowerShell, from the
      scratch folder:

      ```powershell
      [IO.File]::WriteAllBytes("$PWD\big.pdf", (New-Object byte[] 5242880))
      Set-Content -Path other.docx -Value "not an invoice"
      ```

- [ ] `pnpm --filter @probarion/extension build:dev`, then Load unpacked `apps/extension/dist`. The toolbar shows the
      Probarion icon, and `chrome://extensions` shows no errors.

## Connect

- [ ] Popup → **Probarion address** → `localhost:3000` → **Connect**. `/extension?nonce=…` opens. Sign in with the wallet
      → **Connect extension** → the page says "Connected. You can close this tab."
- [ ] The popup shows the Testnet pill, your account, and "Waiting for you".
- [ ] Open `/extension?nonce=AAAAAAAAAAAAAAAAAAAAAA` (a nonce you made up) and press **Connect extension**. The page
      says "The extension didn't take it", and the popup keeps its connection. Revoke that unused connection under
      Connected browsers.
- [ ] **Disconnect.** On `/extension` press **Show a code instead**. Then in the popup: **Probarion address** →
      `localhost:3000`, type the code → **Use code**. (The popup starts on `probarion.xyz` each time it opens. A code
      sent there is refused, or connects the popup to probarion.xyz instead of localhost, so check the address
      first.) It connects. **Disconnect**, then **Probarion address** → `localhost:3000` again and type the same code
      again: "This code is wrong, used or expired. Show a new one on the Browser extension page."
- [ ] In the popup, **Probarion address** → `localhost:3000`, then **Connect** again, so the rest of the checklist
      has a connection.

## Capture (a release-style test: not localhost)

The dev build may read localhost by its host permission, so these steps use public https sites, where only the
click's `activeTab` grant lets the extension read.

- [ ] Open https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf → popup → **Use the PDF in this
      tab**. The popup shows `dummy.pdf` with its size (about 13 KB). Press **Clear** (it is not an invoice).
- [ ] Open https://www.irs.gov/forms-pubs/about-form-1040 and right-click the link to `f1040.pdf` (its address is on
      www.irs.gov) → **Send invoice to Probarion**. The popup opens with `f1040.pdf`, or the badge shows `+` until you
      click the icon. Press **Clear**.
- [ ] Open https://en.wikipedia.org/wiki/Portable_Document_Format and right-click the reference link to
      `warnock_camelot.pdf` (a PDF on another site, pdfa.org) → **Send invoice to Probarion**: "Couldn't read this
      link. Download it and drag the file here."
- [ ] A PDF behind a sign-in on a site you use (same site as the page): right-click its link. Write down whether it
      is read or refused. If it is refused, tell Claude: the README then says files behind a sign-in need Download
      and drag.
- [ ] Open the PDF from the first step in Chrome's PDF viewer, select some text, right-click. Write down whether
      **Send selection as invoice text** appears and carries the text.

## Queue

- [ ] Open your fresh invoice `.txt` in a tab, select its text → right-click → **Send selection as invoice text** →
      choose the vault and the mandate → **Send to Probarion** → "Queued. It waits for your confirmation." **Open**
      opens the invoice in the console at localhost: the header ends " · sent from the browser extension", and the
      page has the card "Sent from the browser extension" with its checks.
- [ ] The toolbar badge shows the number of waiting items (`1` for this invoice). It updates within 5 minutes, or at
      once when you open the popup, which lists the invoice under "Waiting for you".
- [ ] **Choose file** with the same `.txt` → **Send to Probarion**: "Already queued. It waits for your confirmation."
- [ ] **Open in a tab**, then drop the invoice PDF from the desktop onto the drop area. It is taken. Press **Clear**.
- [ ] Drop `other.docx` onto the popup tab: "Send a PDF or a plain text (.txt) file." Then choose `big.pdf`: "The
      invoice must be 4 MiB at most." Nothing is sent.
- [ ] Send the copy with `Pay to: other-payee.testnet`: "Probarion's rules refused it: invoice names NEAR account
      other-payee.testnet; …", and the console's Payables list does not change.
- [ ] Optional, with a second wallet that is an approver of the vault: press **Disconnect** in the popup (it ends the
      owner's token), sign in at localhost:3000 with the approver's wallet, then in the popup **Probarion address** → `localhost:3000`
      → **Connect**, and send the third copy:
      "Queued. It waits for the owner's confirmation." Then press **Disconnect**, sign in again with the owner's
      wallet, and in the popup **Probarion address** → `localhost:3000` → **Connect** again. The steps below need the owner's connection.

## Confirm, the mandate and the connection

- [ ] In the console, **Confirm** the first queued invoice (the one you sent as the owner) with the wallet. The vault
      pays it on testnet; the extension paid nothing. Open the popup: that invoice is gone from "Waiting for you",
      and the badge drops.
- [ ] Send the same `.txt` again: "Probarion's rules refused it: the vault already paid this invoice or is holding a
      payment for it."
- [ ] **Open in a tab** in the popup, then **Choose file** with the same `.txt`. In the console's Mandates tab revoke
      the mandate (a wallet signature). Back in the popup tab press **Send to Probarion**: "This mandate can't take
      invoices now: mandate N is revoked." (N is the mandate's number. The tab keeps the list it read before, which
      is why a revoked mandate can still be chosen.)
- [ ] Stop `next dev`, then open the popup: "Couldn't reach Probarion. Try again." Start it again → **Retry** works.
- [ ] Stop `next dev` again. Select some text on a page → right-click → **Send selection as invoice text**. The popup
      opens on "Couldn't reach Probarion. Try again." without the text, and the badge shows `+`. Start `next dev`
      again and open the popup: it shows the text, and the badge drops its `+`. Press **Clear**.
- [ ] On `/extension` press **Revoke** on this browser's row (the newest "Chrome on ..." row). Open the popup: "Your
      connection expired", the badge shows `!`, and **Reconnect** (with `next dev` running) works.
- [ ] In the service worker's DevTools console (`chrome://extensions` → Inspect views: service worker), set the
      connection's `expires_at` in the past. If Chrome asks, type `allow pasting` and press Enter first, then paste:
      `chrome.storage.local.get("connections").then(({connections}) => { for (const c of Object.values(connections)) c.expires_at = "2020-01-01T00:00:00.000Z"; return chrome.storage.local.set({connections}); })`.
      Open `chrome-extension://<the extension's ID, shown on chrome://extensions>/popup.html?view=tab` in a tab, press
      F12, choose the Network tab, and press Ctrl+R. The page says "Your connection expired", the badge shows `!`, and
      the Network list has no request to `/api/ext/inbox`. Then reload `/extension` and write down the Connected time
      of this browser's row (the newest "Chrome on ..." row).
- [ ] Press **Reconnect** and connect again. Back in the popup tab, it shows "Waiting for you" without a reload.
      The old token was still live on Probarion, and the extension ends it.
      Reload `/extension`: the row with the Connected time you wrote down is gone, and a row with a newer Connected
      time is listed. Write down that newer time.
- [ ] Press **Disconnect**. The popup shows Connect. Reload `/extension`: the row with the Connected time you just wrote
      down is gone from Connected browsers. Disconnect ended that token on Probarion.
