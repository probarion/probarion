# Store listing

**Name:** Probarion

**Summary** (the manifest's description, 132 characters at most):
Queue invoices into Probarion and see what waits for your signature. It can't pay or approve.

**Category:** Workflow & Planning

**Language:** English

**Description:**

Probarion pays a vault's invoices on NEAR only within mandates its owner signed. Every payment can be checked on
chain. This extension brings Probarion to the place invoices arrive: the browser.

Send an invoice:
- from the PDF open in a tab;
- from a link: right-click it and choose "Send invoice to Probarion";
- from text you selected: right-click it and choose "Send selection as invoice text";
- from a PDF or a .txt file you choose or drop on the popup.

You pick the vault and the mandate. Probarion reads the invoice, checks its payee against the mandate, asks the vault
contract whether it would allow the payment, and queues it. The invoice's purpose is checked when the owner confirms.

See what waits for you: invoices waiting for your Confirm, and held payments, with a count on the toolbar icon.

What it can't do: pay, approve or sign anything. A queued invoice waits until the vault's owner confirms it in the
Probarion console with a signature from their NEAR wallet. The extension holds a revocable token that can only queue
invoices and read what waits.

Connecting: open the extension, press Connect, sign in on Probarion with your wallet, and press "Connect extension".
Or show a code on Probarion's Browser extension page and type it into the extension.

Privacy: the extension sends an invoice only when you press Send, and only to the Probarion address you connected.
It has no analytics and runs no code from elsewhere. Policy: https://probarion.xyz/privacy#browser-extension

Probarion is open source: https://github.com/probarion/probarion

**Homepage:** https://probarion.xyz

**Support:** https://github.com/probarion/probarion/issues
