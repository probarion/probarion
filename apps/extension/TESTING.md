# Manual checklist

Run it before each store upload. Write the date, the Chrome version and each result in the PR.

## Setup

- [ ] The database `next dev` uses has every migration through `20261108000015_extension_queue.sql` (the OWNER runs
      them). One database serves both networks, so this checklist writes real rows: use a testnet vault.
- [ ] `pnpm --filter @probarion/web dev` runs on http://localhost:3000, and you are signed in with a testnet wallet
      that owns a vault.
- [ ] The vault has active keys (Keys tab), a mandate made from the sample purchase order (the mandate form offers
      it), and test USDC (Top-up tab, "Add test USDC").
- [ ] Test files: a copy of `apps/web/public/samples/probarion-sample-invoice.txt` with `INV-1001` changed to a number
      not used before (a fresh one each run); a second copy with the line `Pay to: other-payee.testnet` added; a PDF
      of the first copy (print it to PDF from Chrome); a `.docx`; a PDF over 4 MiB.
- [ ] `pnpm --filter @probarion/extension build:dev`, then Load unpacked `apps/extension/dist`. The toolbar shows the
      Probarion icon, and `chrome://extensions` shows no errors.

## Connect

- [ ] Popup → **Probarion address** → `localhost:3000` → **Connect**. `/extension?nonce=…` opens. Sign in with the wallet → **Connect
      extension** → the page says "Connected. You can close this tab."
- [ ] The popup shows the Testnet pill, your account, and "Waiting for you".
- [ ] Open `/extension?nonce=AAAAAAAAAAAAAAAAAAAAAA` (a nonce you made up) and press **Connect extension**. The page
      says "The extension didn't take it", and the popup keeps its connection. Revoke that unused connection under
      Connected browsers.
- [ ] **Disconnect.** On `/extension` press **Show a code instead**. Then in the popup: **Probarion address** →
      `localhost:3000`, type the code → **Use code**. (The popup starts on `probarion.xyz` each time it opens, and
      the code exists only on your local database, so a code sent there is refused.) It connects. **Disconnect**,
      then **Probarion address** → `localhost:3000` again and type the same code again: "This code is wrong, used or
      expired. Show a new one on the Browser extension page."

## Capture (a release-style test: not localhost)

The dev build may read localhost by its host permission, so these steps use public https sites, where only the
click's `activeTab` grant lets the extension read.

- [ ] Open a PDF on a public https site (for example
      https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf) → popup → **Use the PDF in this tab**.
      The popup shows `dummy.pdf · 13 KB`. Press **Clear** (it is not an invoice).
- [ ] On a public https page that links to a PDF on its own site, right-click the link → **Send invoice to Probarion**.
      The popup opens with the file, or the badge shows `+` until you open it. Clear it.
- [ ] Right-click a link to a PDF on another site: "Couldn't read this link. Download it and drag the file here."
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
- [ ] **Choose file** with the same `.txt` → **Send to Probarion**: "Already queued. It waits for your confirmation."
- [ ] **Open in a tab**, then drop the invoice PDF from the desktop onto the drop area. It is taken.
- [ ] Drop the `.docx` onto the popup, then choose the PDF over 4 MiB: each is refused with its sentence, and nothing
      is sent.
- [ ] Send the copy with `Pay to: other-payee.testnet`: "Probarion's rules refused it: invoice names NEAR account
      other-payee.testnet; …", and the console's Payables list does not change.
- [ ] Optional, with a second wallet that is an approver of the vault: connect it and send another fresh invoice:
      "Queued. It waits for the owner's confirmation."

## Confirm and the badge

- [ ] In the console, **Confirm** the queued invoice with the wallet. It is paid on testnet. The extension paid
      nothing. The badge drops at the next read (open the popup).
- [ ] Send the same `.txt` again: "Probarion's rules refused it: the vault already has a payment for this invoice."
- [ ] The badge shows the number of waiting items. It updates within 5 minutes, or at once when the popup opens.
- [ ] On `/extension` press **Revoke** for this browser. Open the popup: "Your connection expired", the badge shows
      `!`, and Reconnect works.
- [ ] In the service worker's DevTools console (`chrome://extensions` → Inspect views: service worker), set the
      connection's `expires_at` in the past:
      `chrome.storage.local.get("connections").then(({connections}) => { for (const c of Object.values(connections)) c.expires_at = "2020-01-01T00:00:00.000Z"; return chrome.storage.local.set({connections}); })`.
      Open the popup: "Your connection expired" and `!`. Right-click the popup → Inspect: its Network panel shows no
      request to `/api/ext/inbox` when you open it again.
- [ ] Stop `next dev`, then open the popup: "Couldn't reach Probarion. Retry". Start it again → **Retry** works.
