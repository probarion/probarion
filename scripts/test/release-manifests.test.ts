import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkManifest, loadRelease, PUBLISHED_DIRS } from "../release-check.js";

// The published packages as they are in this repository: the shape the release check demands of
// them, the source-map policy, the license files and the clean build.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const json = (path: string) => JSON.parse(read(path)) as Record<string, unknown>;
const existing = PUBLISHED_DIRS.filter((dir) => existsSync(join(root, dir, "package.json")));

describe("the published packages", () => {
  it("includes core, sdk and the cli", () => {
    expect(existing).toEqual(
      expect.arrayContaining(["packages/core", "packages/sdk", "packages/cli"]),
    );
  });

  it("have a manifest that passes the release check's shape rules", async () => {
    const { manifests } = await loadRelease(root);
    for (const dir of existing) {
      const manifest = manifests.get(dir);
      expect(manifest, dir).toBeDefined();
      expect(checkManifest(manifest ?? {}, dir), dir).toEqual([]);
    }
  });

  it("describe only what the package does today", () => {
    // The cli description may mention a dry run or verification only once those commands exist (Task 16).
    const commands = (name: string) => existsSync(join(root, "packages/cli/src/commands", name));
    const description = (json("packages/cli/package.json") as { description: string }).description;
    if (!commands("verify.ts")) expect(description).not.toMatch(/verif/i);
    if (!commands("check.ts")) expect(description).not.toMatch(/dry-run|dry run/i);
    expect(description).toMatch(/near-cli-rs/);
  });

  it("export ./testing from the sdk, and only that, next to the root entry", () => {
    const sdk = json("packages/sdk/package.json") as { exports: Record<string, unknown> };
    expect(Object.keys(sdk.exports)).toEqual([".", "./testing"]);
  });

  it("are built without source maps, because src/ is not part of the tarball", () => {
    for (const dir of existing) {
      const build = json(`${dir}/tsconfig.build.json`) as {
        compilerOptions: Record<string, unknown>;
      };
      expect(build.compilerOptions.sourceMap, dir).toBe(false);
      expect(build.compilerOptions.declarationMap, dir).toBe(false);
      expect(build.compilerOptions.inlineSourceMap, dir).toBeUndefined();
      const files = (json(`${dir}/package.json`) as { files: string[] }).files;
      expect(files, dir).not.toContain("src");
    }
  });

  it("build from a clean dist, and `pnpm pack` builds first", () => {
    for (const dir of existing) {
      const scripts = (json(`${dir}/package.json`) as { scripts: Record<string, string> }).scripts;
      const build = scripts.build ?? "";
      expect(build.indexOf("rmSync('dist'"), dir).toBeGreaterThan(-1);
      expect(build.indexOf("tsc -p tsconfig.build.json"), dir).toBeGreaterThan(
        build.indexOf("rmSync('dist'"),
      );
      expect(scripts.prepack, dir).toBe("pnpm run build");
    }
  });

  it("ship the root LICENSE and a README", () => {
    const license = read("LICENSE");
    for (const dir of existing) {
      expect(read(`${dir}/LICENSE`), dir).toBe(license);
      expect(read(`${dir}/README.md`).length, dir).toBeGreaterThan(200);
    }
  });

  it("state that they are an unaudited beta", () => {
    for (const dir of existing) expect(read(`${dir}/README.md`), dir).toMatch(/Unaudited beta/);
  });

  it("make no absolute claims in the READMEs or the changelog", () => {
    const docs = [...existing.map((dir) => `${dir}/README.md`), "CHANGELOG.md"];
    for (const path of docs) {
      expect(read(path), path).not.toMatch(/\bnever\b|100\s?%|unhackable|guarantee/i);
    }
  });

  it("have a root `release:check` script, which the workflow uses", () => {
    const scripts = (json("package.json") as { scripts: Record<string, string> }).scripts;
    expect(scripts["release:check"]).toBe("tsx scripts/release-check.ts");
  });
});
