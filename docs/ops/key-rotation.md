# Rotating KEY_ENCRYPTION_SECRET (the master key)

OWNER only. The web app seals every agent key, the ledger key and every retained invoice under one
master key, `KEY_ENCRYPTION_SECRET` (32 random bytes, base64). Rotate it after a suspected leak, or
when someone who knew it leaves.

**Read this first.** After `--apply`, the database rows open only under the NEW master. If the new
master is lost, every sealed secret is lost with it: the agent and ledger keys (the vault's funds stay
safe, but you must remove those keys from the vault and add new ones) and every retained invoice.
`scripts/rotate-keys.ts` never generates a master, for exactly this reason. Do the steps in order.

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

It prints one JSON line of counts, never a key, a ciphertext or a plaintext. Exit codes: 0 done,
1 not clean / refused / failed, 2 bad input.

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
   `after` every row under `new`. From this moment the running app (still on the old master) cannot
   open the rotated rows: the Payables and Canary cycles fail closed with `decrypt_failed` until
   step 5. Do steps 4 and 5 back to back.

5. **Switch `KEY_ENCRYPTION_SECRET` to the new master** in Vercel (Production, and Preview if it
   shares the database) and redeploy. Side effects of a new master: every session is signed out (the
   session and sign-in challenge subkeys change), the Telegram webhook secret changes (re-run
   `pnpm --filter @probarion/web telegram-webhook`), and visitor hashes change (Canary per-visitor
   limits start over).

6. **Keep the OLD master until a later dry run shows every row opens under the NEW one.** Rows the app
   sealed between step 4 and step 5 are still under the old master. After the redeploy, run the dry run
   again with the same two variables:

   ```bash
   pnpm --filter @probarion/web rotate-keys
   ```

   If `rotate` is above 0, run `--apply` once more (it re-seals only those rows). When a dry run shows
   `rotate: 0`, `unreadable: 0` and `mismatched: 0` for both tables, every row opens under the new
   master: delete the old master from the secret manager and `unset` the variables.

## If something goes wrong

- **`rotation_conflict` on apply:** a row changed between the dry run and the write (another rotation,
  or the app re-sealing). Nothing was written. Run the dry run again, then `--apply`.
- **The command failed after "apply" started and printed no report:** the write is all or nothing.
  Run the dry run: `rotate` > 0 means nothing was written; `already_new` for every row means it was.
- **The new master was lost after `--apply`:** the rotated rows cannot be opened. Remove the agent keys
  from the vault in your wallet (Keys page, Remove), set a new ledger key, and generate new keys under a
  master you have stored. Retained invoice content is gone.
