# Rotating KEY_ENCRYPTION_SECRET (the master key)

OWNER only. The web app seals every agent key, the ledger key and every retained invoice under one
master key, `KEY_ENCRYPTION_SECRET` (32 random bytes, base64). Rotate it after a suspected leak, or
when someone who knew it leaves.

**Read this first.** After `--apply`, the database rows open only under the NEW master. If the new
master is lost, every sealed secret is lost with it: the agent and ledger keys (the vault's funds stay
safe, but you must remove those keys from the vault and add new ones) and every retained invoice.
`scripts/rotate-keys.ts` never generates a master, for exactly this reason. Do the steps in order.

> **If the master may have leaked, rotating it is not enough: also replace every key it protected
> (step 7).** Rotation re-seals the *same* secrets under a new master. Anyone who held the old master
> and any copy of the database (a dump, a backup, a point-in-time restore) can still open the old
> ciphertexts and so still holds every agent key and the ledger key. Replace every agent key
> (Remove, then generate, then add) and the ledger key (generate, then set). Rotating the master does
> not change the keys themselves.

## What the command does

`pnpm --filter @probarion/web rotate-keys [--apply]` reads both masters from the environment and:

- **refuses** when `OLD_KEY_ENCRYPTION_SECRET` or `NEW_KEY_ENCRYPTION_SECRET` is unset, empty, not
  32 bytes of canonical base64, or when the two are the same key (exit 2, nothing read);
- **dry run (the default):** reads every sealed row and opens it by **trial decryption**, the old
  master first, then the new one. A row that opens under the old master is re-sealed under the new
  one in memory, and the new ciphertext is opened again under the new master and compared with the
  plaintext. Nothing is written. A row that already opens under the new master (sealed by the live
  app after a switch) is counted `already_new` and left alone. A row that opens under neither is
  `unreadable`; a re-sealed row that does not verify is `mismatched`;
- **`--apply`:** runs that same dry run first, in the same process, and writes only if every row was
  either verified or already new. Otherwise it is refused (exit 1) and nothing is written. The write
  is one database call (`key_rotation_apply`) that is all or nothing, and compare-and-set on each
  row's old ciphertext: a row changed since it was read fails the whole batch (`rotation_conflict`).
  Afterwards every row is read back and counted by the master that opens it (`after`).

It prints one JSON line of counts, never a key, a ciphertext or a plaintext. Exit codes:

- 0: a clean dry run, or an apply whose read-back shows every row under the new master;
- 1: not clean, refused, or failed;
- 2: bad input;
- 3: the apply **wrote but is not finished**. The read-back shows rows still under the old master (sealed
  by the live app meanwhile) or under neither, or the read-back failed. Follow step 6.

`key_version` on `agent_keys` is a **rotation counter** (1 when sealed, +1 per re-seal). It does not
say which master sealed a row: a key the live app seals under the new master starts at 1 again. That
is why the command uses trial decryption.

## Steps

1. **Generate the new master and store it in your secret manager, before anything uses it.**

   ```bash
   openssl rand -base64 32
   ```

   Paste the output into your password manager / secret manager as a new entry
   ("Probarion KEY_ENCRYPTION_SECRET, from <date>"). Check that the entry saved. Do not generate it
   inline in a command (`NEW_KEY_ENCRYPTION_SECRET=$(openssl rand …)`): that value would exist only
   in that one process.

2. **Set both variables in the shell you run the command from**, read from the secret manager, not
   typed into the command line (so they stay out of your shell history):

   ```bash
   read -rs OLD_KEY_ENCRYPTION_SECRET && export OLD_KEY_ENCRYPTION_SECRET   # the current KEY_ENCRYPTION_SECRET
   read -rs NEW_KEY_ENCRYPTION_SECRET && export NEW_KEY_ENCRYPTION_SECRET   # from step 1
   read -rs SUPABASE_SERVICE_ROLE_KEY && export SUPABASE_SERVICE_ROLE_KEY
   export SUPABASE_URL=https://<project>.supabase.co
   ```

3. **Dry run.**

   ```bash
   pnpm --filter @probarion/web rotate-keys
   ```

   Expect `"ok":true`, with `unreadable` and `mismatched` at 0 in both `agent_keys` and `invoices`.
   If a row is unreadable, stop: it was sealed under a third master (or is damaged). Find out which
   before you go on; `--apply` will refuse anyway.

4. **Apply.**

   ```bash
   pnpm --filter @probarion/web rotate-keys --apply
   ```

   Expect `"mode":"apply","ok":true`, `written` equal to the dry run's `rotate` counts, and in
   `after` every row under `new` (exit 0). Exit 3 means it wrote but rows remain under the old master or
   the read-back failed: go on with step 5, then step 6. From this moment the running app (still on the old master) cannot
   open the rotated rows: the Payables and Canary cycles fail closed with `decrypt_failed` until
   step 5. Do steps 4 and 5 back to back.

5. **Switch `KEY_ENCRYPTION_SECRET` to the new master** in Vercel (Production, and Preview if it
   shares the database) and redeploy. Side effects of a new master: every session is signed out (the
   session and sign-in challenge subkeys change), the Telegram webhook secret changes (re-run
   `pnpm --filter @probarion/web telegram-webhook`; `docs/ops/alerts.md`), the stop links in earlier alert
   emails stop working (the Remove button on the Alerts tab and Telegram's `/stop` still do, and later emails have
   working links), and visitor hashes change (Canary per-visitor
   limits start over). The invoice-number key changes (it is derived from `KEY_ENCRYPTION_SECRET`,
   `apps/web/src/lib/payables/pipeline.ts:111-112,126`), so a re-uploaded invoice is no longer matched by its number
   to invoices uploaded before the rotation; the text fingerprint (an unkeyed sha256, `pipeline.ts:263`) still catches
   identical text.

6. **Keep the OLD master until a later dry run shows every row opens under the NEW one.** Rows the app
   sealed between step 4 and step 5 are still under the old master. After the redeploy, run the dry run
   again with the same two variables:

   ```bash
   pnpm --filter @probarion/web rotate-keys
   ```

   If `rotate` is above 0, run `--apply` once more (it re-seals only those rows). When a dry run shows
   `rotate: 0`, `unreadable: 0` and `mismatched: 0` for both tables, every row of the **live** database
   opens under the new master, and you can `unset` the variables.

   **Backups still need the OLD master.** Every backup and point-in-time restore taken before the
   apply holds rows sealed under the old master, and deleting it makes them unreadable. Keep the old
   master in the secret manager (marked "retired, for backups before <date>") for as long as those
   backups are retained (your Supabase plan's backup / PITR window), then delete it. If you delete it
   sooner, write down that you accept losing the sealed content of those backups. If the old master
   leaked, keeping it adds no exposure the leak has not already caused, but step 7 is then required.

7. **If the master may have leaked: replace every key it protected** (see the box at the top). On the
   console Keys page, for each agent key: Remove (sign in your wallet), then generate a new agent key
   and add it. For the ledger key: generate a new ledger key and set it (this removes the old one from
   the vault). Then re-check that no old key is still `active`. Do this after step 5, so the new keys
   are sealed under the new master. **Then create new mandates for the new agent key:** every mandate
   is bound to one agent key (`agent_pk`), and the old ones are bound to the key you removed, so the
   vault refuses every spend under them. Revoke the old mandates once the new ones are in place.

## If something goes wrong

- **`rotation_conflict` on apply:** a row changed between the dry run and the write (another rotation,
  or the app re-sealing). Nothing was written. Run the dry run again, then `--apply`.
- **The command failed after "apply" started and printed no report:** the write is all or nothing.
  Run the dry run: `rotate` > 0 means nothing was written; `already_new` for every row means it was.
- **The new master was lost after `--apply`:** the rotated rows cannot be opened. Remove the agent keys
  from the vault in your wallet (Keys page, Remove), set a new ledger key, and generate new keys under a
  master you have stored. Retained invoice content is gone.
