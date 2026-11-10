# Chrome Web Store: the OWNER's steps

Claude prepared everything in this folder. Claude does not pay, upload or publish. These steps are the OWNER's.

0. Before you upload: `dev` is promoted to `main` and deployed, you have run migration
   `20261108000015_extension_queue.sql` (the Session pooler one-liner), and
   `curl.exe -i -X POST https://probarion.xyz/api/ext/invoices` answers `401` with `bad_token` (a `404` means the
   queue is not deployed yet). Until then a reviewer who connects cannot queue an invoice. Also check the network each
   address serves: `curl.exe -s https://probarion.vercel.app/api/health` must show `"network":"testnet"`, because
   `review-notes.md` sends the reviewer there with a testnet wallet. (`probarion.xyz` serves mainnet once mainnet
   opens.) If `probarion.vercel.app` ever shows mainnet, change the address in `review-notes.md` to one that serves
   testnet before you upload.
1. Register a Chrome Web Store developer account at https://chrome.google.com/webstore/devconsole. It is a one-time
   US$5 fee, and the Google account needs 2-step verification.
2. Build the zip from a clean checkout of `main`. Run the two commands one after the other (Windows PowerShell 5.1
   has no `&&`):

       pnpm install --frozen-lockfile
       pnpm --filter @probarion/extension zip

   This writes `apps/extension/probarion-extension-0.1.0.zip`. It is a release build: it trusts only the three
   Probarion addresses and has no localhost in it.
3. In the developer console choose **New item** and upload the zip.
4. Fill in the listing from these files:
   - **Store listing:** `listing.md`. The images are in `screenshots/`: `popup.jpg`, `menu.jpg` and `connect.jpg` as
     screenshots, `tile.jpg` (440 x 280) as the small promo tile and `marquee.jpg` (1400 x 560) as the marquee promo
     tile. The store icon is `../static/icons/128.png`.
   - **Category:** `listing.md` says Workflow & Planning. Pick Productivity > Workflow & Planning if the dashboard
     nests it there, otherwise the closest Productivity entry.
   - **Privacy:** `single-purpose.md`, `permissions.md`, `data-use.md`; the privacy policy URL is in `privacy.md`.
   - **Test instructions** (for the reviewer): the dashboard's field takes 500 characters, so paste the short version
     at the end of `review-notes.md`; leave the user name and password empty. A reviewer cannot be expected to fund a vault,
     so record a 60-90 s demo video of connect, send and the console Confirm, and paste its URL into the dashboard's
     video field. Put no password, seed phrase or key in this repo. If the reviewer ever needs credentials, they go
     only in the dashboard's private test-instructions field.
   - **Distribution:** Public, all regions.
5. Submit for review. It can take from a day to a few weeks.
6. Send Claude the item ID (the 32 letters in the item's URL). Until you do, no README mentions the store. After you
   submit, the README says `pending Chrome Web Store review`; once the store publishes it, the README links the page.

Submitted on 2026-11-10 as item `hhadnmnjdlamihjjoejphkimnbcfidmn`. Once published, its page is
https://chromewebstore.google.com/detail/hhadnmnjdlamihjjoejphkimnbcfidmn.
