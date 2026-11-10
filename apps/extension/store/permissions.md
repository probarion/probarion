# Permission justifications

**storage:** Keeps the connection to Probarion (a revocable token, the account name and the network) in
chrome.storage.local, and keeps the invoice the user captured in chrome.storage.session until they send it.

**contextMenus:** Adds two right-click items: "Send invoice to Probarion" on a link, and "Send selection as invoice
text" on selected text. Nothing is read until the user picks one. The two items appear on every site because invoices
arrive anywhere; they act only when the user picks one.

**activeTab:** Chrome grants it for one tab when the user clicks the toolbar icon or picks one of those menu items.
When the popup opens, the extension reads only that tab's address, to see whether it is a PDF. It fetches a file only
after the user presses "Use the PDF in this tab" in the popup, or picks "Send invoice to Probarion" on a link to a file
on the same site. That file is requested from the site the way the tab loaded it, with the user's own session for that
site, and a linked plain-text file is read the same way. It is sent to Probarion only if the user presses Send, and the
user can drop it with Clear. The extension reads no other tab, and no page without one of those actions.

**alarms:** Asks Probarion every 5 minutes how many items wait for the user, for the count on the toolbar icon. The
alarm stops when the user disconnects or the connection ends.

**Host permissions** (`https://probarion.vercel.app/*`, `https://probarion.xyz/*`, `https://testnet.probarion.xyz/*`):
The extension calls Probarion's API at these addresses only, and runs its one content script only on their
`/extension` page, where the user connects the extension. Probarion's extension API reads a Bearer token (or, to connect,
a one-time code) and no cookies, and sends no CORS headers, so the extension needs these hosts to call it. `testnet.probarion.xyz` is the address
Probarion's testnet moves to when its mainnet opens; it is requested now so that the move needs no new permission, and
the extension does not offer it until it serves Probarion.

**Remote code:** No. All of the extension's code is in the package. It loads no script from anywhere and runs no
string as code.
