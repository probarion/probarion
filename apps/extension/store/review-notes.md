# Notes for the Chrome Web Store reviewer

Paste this into the item's test instructions.

There is no password: Probarion signs people in with a NEAR wallet. To try the extension:

1. Click the Probarion icon. Set **Probarion address** to `probarion.vercel.app`, then press **Connect**. A page
   opens at `https://probarion.vercel.app/extension?nonce=...`.
2. Sign in there with any NEAR testnet wallet, then press **Connect extension**. The page says "Connected. You can
   close this tab." The popup now shows the account and "Nothing waits for you".
3. To queue an invoice the account needs a vault and a mandate. The console's first-run checklist makes both on
   NEAR testnet, with test USDC that has no value. Then open
   `https://probarion.vercel.app/samples/probarion-sample-invoice.txt`, select its text, right-click and choose
   **Send selection as invoice text**, pick the vault and the mandate, and press **Send to Probarion**. The popup
   says "Queued. It waits for your confirmation."

Use `probarion.vercel.app` for this test, as steps 1 and 3 say. It serves NEAR testnet, where the USDC has no
value. `probarion.xyz` is Probarion's main address and will serve NEAR mainnet, which uses real money, once mainnet
opens. If a page asks for a mainnet wallet, close it and choose `probarion.vercel.app` in the popup.

The extension cannot pay, approve or sign. A queued invoice is paid only when the vault's owner confirms it in the
Probarion console with their wallet.
