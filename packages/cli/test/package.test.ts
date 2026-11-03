import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("package.json", () => {
  it("builds from a clean dist, so a source file that was removed leaves no stale output behind", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    };
    const build = pkg.scripts.build ?? "";
    // The clean step runs first, in node itself (no dependency such as rimraf), and gates tsc.
    const clean = build.indexOf("rmSync('dist'");
    const compile = build.indexOf("tsc -p tsconfig.build.json");
    expect(clean).toBeGreaterThan(-1);
    expect(compile).toBeGreaterThan(clean);
    expect(build).toMatch(/recursive:\s*true/);
    expect(build.slice(clean, compile)).toContain("&&");
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      "@probarion/core",
      "@probarion/sdk",
      "commander",
    ]);
  });
});
