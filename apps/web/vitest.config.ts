import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Array form, exact matches first: tests read the workspace packages' source, so they do not
    // need `dist`. CI still builds first (`pnpm build`), which is what `next build` consumes.
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
