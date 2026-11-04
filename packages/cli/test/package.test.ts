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

  it("installs @nearai/inference-sdk as an optional dependency, in the SDK's peer range, so verify --online can load it", async () => {
    const read = async (path: string) =>
      JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")) as {
        optionalDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        peerDependenciesMeta?: Record<string, { optional?: boolean }>;
      };
    const cli = await read("../package.json");
    const sdk = await read("../../sdk/package.json");
    expect(cli.optionalDependencies).toEqual({
      "@nearai/inference-sdk": sdk.peerDependencies?.["@nearai/inference-sdk"],
    });
    expect(cli.optionalDependencies?.["@nearai/inference-sdk"]).toBe(">=0.1.0 <1");
    expect(sdk.peerDependenciesMeta?.["@nearai/inference-sdk"]?.optional).toBe(true);
  });
});
