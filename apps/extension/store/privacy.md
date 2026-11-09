# Privacy policy

**URL:** https://probarion.xyz/privacy#browser-extension

The "Browser extension" section of that page covers the words in `EXTENSION_PRIVACY`
(`apps/web/src/lib/site/ops-copy.ts`), rendered by `apps/web/src/components/site/ExtensionPrivacy.tsx`:
- what is sent, and when: only the invoice the user chooses, only to the connected Probarion address;
- what is kept in the browser: the token, the account and network, and the captured invoice until it is sent or Chrome
  closes;
- what is read: no page's content except the invoice being sent and Probarion's own connect page, and the active tab's
  address when the popup opens. A file from a tab or a link is fetched with the user's own session for that site, and is
  sent only when the user presses Send;
- that there are no analytics and no remote code;
- how a connection ends: after 30 days, with Disconnect, or with Revoke on the Browser extension page.
