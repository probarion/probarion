# Notes for the Chrome Web Store reviewer

Paste this into the item's test instructions.

There is no password: Probarion signs people in with a NEAR wallet. To try the extension:

1. Click the Probarion icon, then **Connect**. A page opens at `https://probarion.xyz/extension?nonce=...`.
2. Sign in there with any NEAR testnet wallet, then press **Connect extension**. The page says "Connected. You can
   close this tab." The popup now shows the account and "Nothing waits for you".
3. To queue an invoice the account needs a vault and a mandate. The console's first-run checklist makes both on
   NEAR testnet, with test USDC that has no value. Then open
   `https://probarion.xyz/samples/probarion-sample-invoice.txt`, select its text, right-click and choose
   **Send selection as invoice text**, pick the vault and the mandate, and press **Send to Probarion**. The popup
   says "Queued. It waits for your confirmation."

The extension cannot pay, approve or sign. A queued invoice is paid only when the vault's owner confirms it in the
Probarion console with their wallet.
