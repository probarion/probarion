# @probarion/near

Building blocks for NEAR apps, from [Probarion](https://github.com/probarion/probarion), a mandate layer
for AI agents on NEAR.

**Unaudited beta.** Versions 0.x may change the API in a minor release. MIT licensed. This package is in
the repository and is not on npm yet; it reaches npm with the next release.

The pure functions use no network, no filesystem and no Node built-in, so they run the same in Node and in a
browser. The online helpers take any JSON-RPC client (an object with `call(method, params)`) and sign
nothing. Dependencies: `@noble/hashes` and `bs58`.

This page is a stub while the modules are being built; it lists what landed, with its tests, when they do.
