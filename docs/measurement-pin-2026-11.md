# Why the TEE measurement is not pinned yet (O1b)

Checked on 2026-11-12 against NEAR AI's public repositories and the four attested decisions of the testnet
demo vault, entries 10 to 13 of [`ledger-2026-11-12.jsonl`](evidence/demo-vault/ledger-2026-11-12.jsonl).

## The short answer

`verify --online` cannot pin the image of the model that answered, and no pin Probarion could add today
would change that. A NEAR AI Cloud TDX quote measures the confidential VM's operating system and its
management harness. The model stack (the inference engine, the weights and the proxy that signs each
answer) is started after boot by NEAR AI's `compose-manager`, from a git tag, so no measurement register
records which images it runs. The landing page row stays "Checked online on testnet, image not pinned",
`quote_verified` stays false, and Probarion says "attested and signed", not "proven to run a given model
image".

## What a ledger entry already shows

Each attested entry stores the TDX quote and its event log (`evidence.report.intel_quote` and
`evidence.report.event_log`). From these alone, a verifier can read what the TD measured:

- Replaying the event log gives the quote's RTMR0, RTMR1, RTMR2 and RTMR3, for all four entries. In RTMR3
  the digest of each event is SHA-384 of its type (u32, little-endian), `:`, its name, `:` and its payload.
- MRCONFIGID is the byte `01`, the compose hash, then zeros, so the quote binds the compose hash twice.
- After boot, services in the VM can extend RTMR3. Entries 10 and 11 hold nine such events,
  `nearai-replica-report-key-v1`, each a replica's public key: keys, not images.

| Measured value | Entries 10 and 11, `z-ai/glm-5.3-flash` | Entries 12 and 13, `Qwen/Qwen3.8-27B` |
|---|---|---|
| MRTD | `df4d77c857de652b...` | the same |
| RTMR0, RTMR1, RTMR2 | `bc122d14...`, `4ae60980...`, `bd67ab75...` | the same |
| `os-image-hash` | `91fd5d69ccee3e5ea4f2aeb8c9b632c4358c4ecfc29ba1aa6fb1e402af209829` | the same |
| `app-id` | `2c0a0c96cb6dbd659bf1446e2f3fce58172ff91b` | the same |
| `compose-hash` | `a0e3c6f4f21a60ea3f5c96bc7ef319b03a184ca2049605399275fbcea74e8c5f` | `e8416a02d6f7ce47baaa52e3925b934fd30834b04fc9086b363db9b1d12c729d` |

O1 shows that these quotes are DCAP-genuine, so these are the values the hardware measured. Two things
are missing: a trustworthy statement of what the values should be, and a measured link from them to the
model.

To check it yourself, save this as `replay.mjs` in the repository root and run `node replay.mjs`. You
should see `RTMR0-3 replay: true` and `MRCONFIGID = 01||compose-hash: true` for entries 10 to 13, and the
values in the table.

```js
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const sha384 = (...parts) => createHash("sha384").update(Buffer.concat(parts)).digest();
const lines = readFileSync("docs/evidence/demo-vault/ledger-2026-11-12.jsonl", "utf8").trim().split("\n");
for (const seq of [10, 11, 12, 13]) {
  const { model, report } = JSON.parse(lines[seq]).body.evidence;
  const body = Buffer.from(report.intel_quote, "hex").subarray(48); // TD report of a v4 quote
  const reg = (offset) => body.subarray(offset, offset + 48).toString("hex");
  const rtmr = [0, 1, 2, 3].map(() => Buffer.alloc(48));
  const ids = {};
  for (const e of report.event_log) {
    let digest = Buffer.from(e.digest, "hex");
    if (e.imr === 3) {
      const type = Buffer.alloc(4);
      type.writeUInt32LE(e.event_type);
      digest = sha384(type, Buffer.from(":"), Buffer.from(e.event), Buffer.from(":"), Buffer.from(e.event_payload, "hex"));
      ids[e.event] = e.event_payload;
    }
    rtmr[e.imr] = sha384(rtmr[e.imr], digest);
  }
  const replayed = [0, 1, 2, 3].every((i) => rtmr[i].toString("hex") === reg(328 + 48 * i));
  const configId = reg(184).startsWith(`01${ids["compose-hash"]}`);
  console.log(seq, model, "RTMR0-3 replay:", replayed, "MRCONFIGID = 01||compose-hash:", configId);
  console.log("  mrtd", reg(136).slice(0, 16), "os-image-hash", ids["os-image-hash"], "compose-hash", ids["compose-hash"]);
}
```

## What NEAR AI publishes, and what it covers

- **The OS image.** `nearai/dstack-images` serves measurement tarballs (firmware, kernel, initramfs and
  kernel command line) as assets of its release `os-image-mr`, and one of them is for `91fd5d69...`. That
  tarball was uploaded on 2026-10-20. It is not signed, the `SHA256SUMS` committed in git (2026-08-28) does
  not list it, and the README's provenance table covers 55 of the 57 tarballs, not this one. The expected
  MRTD and RTMR0 to RTMR2 have to be computed from it with dstack's `dstack-mr` and the VM's shape
  (`vm_config`), which the ledger does not hold.
- **The harness.** The compose hash is the SHA-256 of the dstack `app_compose` document. NEAR AI returns
  that document inside its attestation report, which needs an API key (`info.tcb_info.app_compose`).
  The `nearai/cvm-compose-files` README says the hash "is registered with the KMS contract", but no
  public contract or list of known-good compose hashes was found, and the scripts in `nearai/near-kms`
  name placeholder accounts. Probarion's SDK does not store `info`. A
  third-party review, `teemoonai/audits` (`manifests/measured`), describes the document behind
  `a0e3c6f4...` as the management harness (an OpenTelemetry collector, certbot, compose-manager and its
  launcher), not the model stack. It is untrusted, but such a document can be checked against the hash.
- **The model stack.** The `nearai/cvm-compose-files` README says that compose-manager, running inside
  each inference CVM, checks out a tag of that repository and runs `docker compose up` on one of its
  files. Its prod-ready checklist requires images pinned by digest, and the images NEAR AI builds carry
  signed build provenance (cosign and GitHub attestations). compose-manager keeps a log of what it
  deployed (tag, commit, file, `file_sha256`) and attests it in a second TDX quote, whose report data is
  the SHA-256 of the log and a nonce. NEAR AI returns it as `compose_manager_attestation`. NEAR AI's own
  verifier checks the log's hash against that quote's report data but does not verify the quote, and says
  so. Probarion's SDK does not store it.

Even with all of that stored, two gaps in `nearai/compose-manager` would stay open, and only NEAR AI can
close them:

- The environment map sent with each `/compose/up` is not in the log, and the compose files read settings
  from it.
- The launcher takes the compose-manager image from `COMPOSE_MANAGER_IMAGE`, which it rewrites itself.
  By default it polls its registry tag every 300 seconds, swaps in a new digest after a cosign check that
  a setting can skip, and keeps the swap across reboots. So the measured harness does not fix which
  compose-manager runs, and that compose-manager writes the log itself.

## What O1b would need

1. The SDK stores, with each attested entry, `info.tcb_info.app_compose`, `vm_config` and
   `compose_manager_attestation`, three fields the evidence does not have today.
2. `verify --online` replays RTMR0 to RTMR3 from the event log and checks MRCONFIGID and the SHA-256 of
   `app_compose`. It computes the expected MRTD and RTMR0 to RTMR2 from a published OS image, and verifies
   the compose-manager quote: the same TD, the log's hash and a fresh nonce. It fetches the last deployed
   compose file at its commit, checks its `file_sha256`, and checks the signed provenance of each image
   digest in it.
3. NEAR AI attests the environment map and the compose-manager image that runs, and publishes the compose
   hashes it approves where anyone can read them.

## Sources

Read on 2026-11-12, public material only:

- NEAR AI's verifier, <https://github.com/nearai/nearai-cloud-verifier>: `py/model_verifier.py` checks the
  compose hash against `mr_config`, links image digests to Sigstore and checks the compose-manager log hash.
- The model stacks, <https://github.com/nearai/cvm-compose-files>: its README.
- compose-manager, <https://github.com/nearai/compose-manager>: its README, `src/main.rs`
  (`DeploymentAction`, `attestation_report`) and `launcher/launcher.sh`.
- The OS image tarballs, <https://github.com/nearai/dstack-images>: its README, `SHA256SUMS` and the
  release `os-image-mr`.
- The KMS contracts, <https://github.com/nearai/near-kms>.
- The third-party review, <https://github.com/teemoonai/audits/tree/main/manifests/measured>.

## Update, 2026-11-13: the landing row's new words

Since the landing change of 2026-11-13 (CHANGELOG, Unreleased), the landing page row reads "Checked online on
testnet and mainnet, image not pinned". It names mainnet because, at 17:52 UTC that day, a read-only
`verify --online` passed O1 and O2 on the 3 attested decisions of `v0.probarion.near`
([output](evidence/mainnet-v0/s2-2026-11-13/verify-online-2026-11-13.txt)). The finding above is unchanged: no
measurement register records the model's images, so this does not show which model image ran. The row's words are
live on probarion.xyz only after the next deploy.
