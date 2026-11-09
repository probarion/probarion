import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLI_NOTE, CLI_ON_NPM, CLI_SETUP_LINES, cli, PRE_LEDGER_FLAGS, REPO_URL } from "./cli";

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const read = (rel: string) => readFileSync(`${ROOT}${rel}`, "utf8");

// These tests hold whichever way CLI_ON_NPM is set: flipping it changes the constant and smoke step 7.
describe("the probarion command the site shows (CLI_ON_NPM)", () => {
  it("is the repository command when the switch is off, and npx probarion when it is on", () => {
    expect(cli("verify --offline x.json", false)).toBe(
      "node packages/cli/dist/bin.js verify --offline x.json",
    );
    expect(cli("verify --offline x.json", true)).toBe("npx probarion verify --offline x.json");
    expect(cli("verify --offline x.json")).toBe(cli("verify --offline x.json", CLI_ON_NPM));
  });

  it("sets the repository up in four commands, one per line, so every shell runs them", () => {
    expect(REPO_URL).toBe("https://github.com/probarion/probarion");
    expect(CLI_SETUP_LINES).toEqual([
      "git clone https://github.com/probarion/probarion",
      "cd probarion",
      "pnpm install",
      'pnpm --filter "{packages/cli}..." build',
    ]);
    for (const line of CLI_SETUP_LINES) expect(line).not.toMatch(/&&|;|\|/);
  });

  it("says what the commands need: Node 24 for npx, or git, Node 24 and pnpm 10 for the repository", () => {
    expect(CLI_NOTE).toBe(
      CLI_ON_NPM
        ? "These commands run the probarion package from npm with npx, which downloads it the first time. Needs Node 24 or later."
        : "The probarion npm package is coming; until then, the commands below run from a clone of the public repository. Needs git, Node 24 or later and pnpm 10. If you cloned it before, run git pull, pnpm install and the build line again.",
    );
    const engines = (JSON.parse(read("package.json")) as { engines: Record<string, string> })
      .engines;
    expect(engines).toEqual({ node: ">=24", pnpm: ">=10 <11" });
    const cliEngines = (
      JSON.parse(read("packages/cli/package.json")) as { engines: Record<string, string> }
    ).engines;
    expect(cliEngines).toEqual({ node: ">=24" });
  });

  it("runs as npx probarion at the root of a clone too: the root package is not also named probarion", () => {
    // npx resolves a name that matches the current project to that project, and the root has no bin, so with the
    // same name `npx probarion` fails there with "could not determine executable to run".
    const root = JSON.parse(read("package.json")) as {
      name: string;
      private: boolean;
      bin?: unknown;
    };
    expect(root.private).toBe(true);
    expect(root.name).not.toBe("probarion");
    expect(root.bin).toBeUndefined();
  });

  it("names the repository's evidence files for a pre-ledger spend", () => {
    expect(PRE_LEDGER_FLAGS).toBe(
      CLI_ON_NPM
        ? "--evidence <a copy of the repository's docs/evidence> --proof <a copy of the repository's docs/mainnet-proof.json>"
        : "--evidence docs/evidence --proof docs/mainnet-proof.json",
    );
    expect(existsSync(`${ROOT}docs/evidence`)).toBe(true);
    expect(existsSync(`${ROOT}docs/mainnet-proof.json`)).toBe(true);
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
    expect(read("packages/cli/package.json")).toContain("github.com/probarion/probarion");
  });

  it("is what smoke step 7 of the deploy runbook tells the owner, with no promise about the file's age", () => {
    const step7 =
      read("docs/runbooks/web-deploy.md")
        .split("\n")
        .find((l) => l.startsWith("  7. ")) ?? "";
    expect(step7).toContain("taken when you click or shortly before");
    // The only claim: the same snapshot gives the same result with a current verifier; another one can differ.
    expect(step7).toContain(
      "it is the very snapshot the page checked, and a verifier built from the current repository gives the same result",
    );
    expect(step7).toContain("its result can differ from the page");
    expect(step7).not.toMatch(
      /up to a minute|newer one|matches this page unless|unless the vault changed/,
    );
    // Step 7 shows the command the pages show. Flipping CLI_ON_NPM means updating it by hand.
    expect(step7).toContain(`\`${cli("verify --offline <the downloaded file>")}\``);
    if (CLI_ON_NPM) {
      expect(step7).toContain("Node 24 or later");
      expect(step7).not.toContain("packages/cli/dist/bin.js");
      for (const line of CLI_SETUP_LINES) expect(step7).not.toContain(line);
    } else {
      for (const line of CLI_SETUP_LINES) expect(step7).toContain(`\`${line}\``);
      // pnpm 10 does not install before a script runs, so an older clone needs pnpm install before the build.
      expect(step7).toContain(
        "if you cloned it before, run `git pull`, `pnpm install` and the build line again",
      );
      expect(step7).not.toContain("npx probarion");
    }
  });

  it("lists every proof route in the deploy runbook's build check", () => {
    const routes =
      read("docs/runbooks/web-deploy.md")
        .split("\n")
        .find((l) => l.includes("`next build` finishes and lists the routes")) ?? "";
    for (const route of [
      "/proof",
      "/proof/[vault]",
      "/proof/[vault]/snapshot.json",
      "/proof/[vault]/ledger.jsonl",
    ]) {
      expect(routes, route).toContain(`\`${route}\``);
    }
  });
});
