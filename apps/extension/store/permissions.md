# Permission justifications

**storage:** Keeps the connection to Probarion (a revocable token, the account name and the network) in
chrome.storage.local, and keeps the invoice the user captured in chrome.storage.session until they send it.

**contextMenus:** Adds two right-click items: "Send invoice to Probarion" on a link, and "Send selection as invoice
text" on selected text. Nothing is read until the user picks one. The two items appear on every site because invoices
arrive anywhere; they act only when the user picks one.

**activeTab:** When the user opens the popup or picks one of those menu items, the extension reads that tab's PDF, or
the linked PDF on the same site, to send it as the invoice. It reads no other tab and no page without that click. It
also reads that tab's address, to see whether it is a PDF.

**alarms:** Asks Probarion every 5 minutes how many items wait for the user, for the count on the toolbar icon. The
alarm stops when the user disconnects or the connection ends.

**Host permissions** (`https://probarion.vercel.app/*`, `https://probarion.xyz/*`, `https://testnet.probarion.xyz/*`):
The extension calls Probarion's API at these addresses only, and runs its one content script only on their
`/extension` page, where the user connects the extension. Probarion's API takes a Bearer token, never cookies, and
sends no CORS headers, so the extension needs these hosts to call it. `testnet.probarion.xyz` is the address
Probarion's testnet moves to when its mainnet opens; it is requested now so that the move needs no new permission, and
the extension does not offer it until it serves Probarion.

**Remote code:** No. All of the extension's code is in the package. It loads no script from anywhere and runs no
string as code.
