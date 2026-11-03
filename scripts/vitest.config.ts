import { defineConfig } from "vitest/config";

// Only the TypeScript tests under scripts/test. The *.test.mjs files in scripts/ and
// scripts/testnet/ are node:test files, run by `node --test` (root `pnpm test`).
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
