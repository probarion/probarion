import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLI_NOTE, CLI_ON_NPM, CLI_SETUP, cli, REPO_URL } from "./cli";

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const read = (rel: string) => readFileSync(`${ROOT}${rel}`, "utf8");

describe("the probarion command the site shows (CLI_ON_NPM)", () => {
  it("is the repository command while the npm package is not published", () => {
    expect(CLI_ON_NPM).toBe(false);
    expect(cli("verify --offline x.json")).toBe(
      "node packages/cli/dist/bin.js verify --offline x.json",
    );
    expect(REPO_URL).toBe("https://github.com/probarion/probarion");
    expect(CLI_SETUP).toBe(
      'git clone https://github.com/probarion/probarion && cd probarion && pnpm install && pnpm --filter "{packages/cli}..." build',
    );
    expect(CLI_NOTE).toBe(
      "The probarion npm package is coming; until then, this command from the public repository works.",
    );
  });

  it("is npx probarion once the switch is on", () => {
    expect(cli("verify --offline x.json", true)).toBe("npx probarion verify --offline x.json");
  });

  it("points at the CLI's real bin, built from its own sources", () => {
    const pkg = JSON.parse(read("packages/cli/package.json")) as {
      name: string;
      bin: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(pkg.name).toBe("probarion");
    expect(pkg.bin.probarion).toBe("./dist/bin.js");
    expect(pkg.scripts.build).toContain("tsc -p tsconfig.build.json");
    const build = JSON.parse(read("packages/cli/tsconfig.build.json")) as {
      compilerOptions: { rootDir: string; outDir: string };
    };
    expect(build.compilerOptions).toMatchObject({ rootDir: "src", outDir: "dist" });
    expect(existsSync(`${ROOT}packages/cli/src/bin.ts`)).toBe(true);
    // The repository's own remote, so the clone in the setup line is this code.
    expect(read("packages/cli/package.json")).toContain("github.com/probarion/probarion");
  });

  it("is what smoke step 7 of the deploy runbook tells the owner to run", () => {
    const step7 =
      read("docs/runbooks/web-deploy.md")
        .split("\n")
        .find((l) => l.startsWith("  7. ")) ?? "";
    expect(step7).toContain(CLI_SETUP);
    expect(step7).toContain(cli("verify --offline"));
    if (!CLI_ON_NPM) expect(step7).not.toContain("npx probarion");
  });
});
