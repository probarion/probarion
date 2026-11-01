# @probarion/sdk

Probarion SDK: let any agent pay on NEAR only inside owner-signed mandates, with attested
decisions and a verifiable ledger.

This README is a stub; the full usage guide lands with the SDK release.

## Requirements

- Node >= 24 (`engines`).
- The optional peer dependency `@nearai/inference-sdk` (range `>=0.1.0 <1`) is only needed for
  NEAR AI inference. The NEAR AI SDK itself needs Node >= 24.22.1, so install it on that Node
  version or newer. Without it, the rest of the SDK runs on any Node >= 24.
