import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Array form, exact matches first: tests read the workspace packages' source. The exceptions are the
    // tests that run the built CLI as a child process, the way the proof page tells a visitor to
    // (test/fixtures/cli-bin.ts): they need `packages/{core,sdk,cli}/dist` built and not older than
    // their sources, and say so when it is not. CI builds first (`pnpm build` in `verify:ts`).
    alias: [
      { find: /^@probarion\/core$/, replacement: at("../../packages/core/src/index.ts") },
      { find: /^@probarion\/sdk$/, replacement: at("../../packages/sdk/src/index.ts") },
      {
        find: /^@probarion\/sdk\/testing$/,
        replacement: at("../../packages/sdk/src/testing/index.ts"),
      },
      { find: /^@\//, replacement: `${at("./src")}/` },
      { find: /^server-only$/, replacement: at("./test/empty.ts") },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    pool: "forks",
    // R20: unit tests never touch the network.
    setupFiles: ["test/setup/no-network.ts"],
  },
});
