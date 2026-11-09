import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

// ---------- the gate scripts, pinned crosswise with scripts/ci-workflow.test.mjs (T17-R4) ----------
//
// release.yml is pinned by sha256 (in ci-workflow.test.mjs) and runs `pnpm run verify:ts` and
// `pnpm run verify:launch`, but what those commands do is in package.json scripts. So the scripts are
// pinned too, by two files that run under different gates. This file runs under verify:launch and pins
// the root scripts that verify:ts runs, among them `test`, which runs ci-workflow.test.mjs.
// ci-workflow.test.mjs runs under verify:ts and pins verify:launch and what it runs. Switching off one
// gate is refused by the test that runs under the other. The refusal of constructs that swallow a
// failure, the per-package map and the workspace pins are in both files on purpose (T17-R4).

const SELF = "scripts/test/release-manifests.test.ts";

/** The root scripts this file pins (ci-workflow.test.mjs pins verify:launch and what it runs). */
const ROOT_PINNED: Record<string, string> = {
  verify: "pnpm run verify:rust && pnpm run verify:ts && pnpm verify:launch",
  "verify:rust":
    "cargo test --manifest-path contracts/Cargo.toml --workspace --exclude integration-tests",
  "verify:ts": "pnpm run lint && pnpm run build && pnpm run typecheck && pnpm run test",
  test: 'node --test "scripts/**/*.test.mjs" && pnpm -r --if-present run test',
  lint: "biome check .",
  build: "pnpm -r --if-present run build",
  typecheck: "pnpm -r --if-present run typecheck",
};

/**
 * The pnpm that CI and Vercel install: the exact `packageManager` of the root package.json.
 * pnpm/action-setup reads it (the workflows give it no version) and Vercel does with
 * ENABLE_EXPERIMENTAL_COREPACK=1, so it is the pnpm that reads pnpm-lock.yaml in CI and on Vercel.
 * ci-workflow.test.mjs pins the major line (pnpm 10) and the workflows; this file pins the exact
 * value, so that another major needs a reviewed change in both files and a patch bump one in this file.
 */
const PACKAGE_MANAGER = "pnpm@10.34.9";
/** The pinned version with its minor raised by one: a bump of the field that nobody reviewed in this file. */
const NEXT_MINOR = PACKAGE_MANAGER.replace(
  /^pnpm@(\d+)\.(\d+)\.\d+$/,
  (_match, major: string, minor: string) => `pnpm@${major}.${Number(minor) + 1}.0`,
);

const PACKAGE_BUILD =
  "node -e \"require('fs').rmSync('dist',{recursive:true,force:true})\" && tsc -p tsconfig.build.json";
type PinnedScripts = Record<"test" | "build" | "typecheck" | "lint", string | null>;
/**
 * The test, build, typecheck and lint scripts of every workspace package, exactly; null means the
 * package has no such script. `pnpm -r --if-present` skips a package whose script is missing, so a
 * removed script is a change too. No package has a lint script: the root `biome check .` lints them all.
 */
const PACKAGE_PINNED: Record<string, PinnedScripts> = {
  "packages/cli/package.json": {
    test: "vitest run",
    build: PACKAGE_BUILD,
    typecheck: "tsc -p tsconfig.json",
    lint: null,
  },
  "packages/core/package.json": {
    test: "vitest run",
    build: PACKAGE_BUILD,
    typecheck: "tsc -p tsconfig.json",
    lint: null,
  },
  "packages/sdk/package.json": {
    test: "vitest run",
    build: PACKAGE_BUILD,
    typecheck: "tsc -p tsconfig.json",
    lint: null,
  },
  "apps/extension/package.json": {
    test: "vitest run",
    build: "node scripts/build.mjs",
    typecheck: "tsc -p tsconfig.json",
    lint: null,
  },
  "apps/web/package.json": {
    test: "vitest run",
    build: "next build",
    typecheck: "tsc --noEmit",
    lint: null,
  },
};

/** The one script allowed to use `||`: the publish guard of the three published packages, exactly. */
const PREPUBLISH_GUARD =
  "node -e \"if(process.env.CI!=='true'||process.env.GITHUB_WORKFLOW!=='release'){console.error('Refusing to publish: only the GitHub release workflow publishes. Push a tag such as sdk-v0.1.0 instead.');process.exit(1)}\"";
const GUARDED = [
  "packages/core/package.json",
  "packages/sdk/package.json",
  "packages/cli/package.json",
];

// Where a shell word starts a command: the start, after && || | & ; ( ) { !, or after then/do/else.
const COMMAND_START = String.raw`(?:^|&&|\|\||[;|&(){!]|\b(?:then|do|else)\b)\s*`;
/** Constructs that let a failing script pass. None may appear in any script of any workspace package. */
const SWALLOWS: Array<[RegExp, string]> = [
  [/\|\|/, '"||"'],
  [/\|\|\s*exit\s+0\b/, '"|| exit 0"'],
  [/;\s*true\b/, '"; true" (or ";true")'],
  [/\bexit\s+0\b/, '"exit 0"'],
  [/--passWithNoTests|--pass-with-no-tests/i, '"--passWithNoTests"'],
  [
    /--dangerouslyIgnoreUnhandledErrors|--dangerously-ignore-unhandled-errors/i,
    '"--dangerouslyIgnoreUnhandledErrors"',
  ],
  [/--bail(?:\s+|=)0\b/, '"--bail 0"'],
  [new RegExp(`${COMMAND_START}(?:true|:)(?=$|[\\s;&|)}])`), '"true" (or ":") used as a command'],
  [new RegExp(`${COMMAND_START}exit\\s*(?=$|[;&|)}])`), 'a bare "exit", which exits 0'],
];

// pnpm-workspace.yaml chooses the packages that `pnpm -r` runs and can hold settings (scriptShell).
const WORKSPACE_YAML = 'packages:\n  - "packages/*"\n  - "apps/*"\n  - "eval"\n';
// scripts/vitest.config.ts chooses which scripts/test files verify:launch runs. Update with:
// node -e 'console.log(require("crypto").createHash("sha256").update(require("fs").readFileSync("scripts/vitest.config.ts","utf8").replace(/\r\n/g,"\n")).digest("hex"))'
const SCRIPTS_VITEST_SHA256 = "b2c667b89f365ece33ad8b5fdb0024cd6ce82b64bd6916cb5b5696776e8f9b70";

type Manifest = { scripts?: Record<string, unknown>; packageManager?: unknown };
/** The workspace manifests by path, and the config files that decide how the scripts run (null: absent). */
type Repo = { manifests: Map<string, Manifest>; files: Map<string, string | null> };

const lf = (text: string) => text.replace(/\r\n/g, "\n");
const sha256 = (text: string) => createHash("sha256").update(lf(text)).digest("hex");

function loadRepo(): Repo {
  const paths = ["package.json"];
  for (const parent of ["packages", "apps"]) {
    for (const dir of readdirSync(join(root, parent)).sort()) {
      if (existsSync(join(root, parent, dir, "package.json"))) {
        paths.push(`${parent}/${dir}/package.json`);
      }
    }
  }
  if (existsSync(join(root, "eval", "package.json"))) paths.push("eval/package.json");
  const optional = (path: string) => (existsSync(join(root, path)) ? read(path) : null);
  const files = new Map<string, string | null>([
    ["pnpm-workspace.yaml", optional("pnpm-workspace.yaml")],
    ["scripts/vitest.config.ts", optional("scripts/vitest.config.ts")],
  ]);
  for (const dir of ["", ...paths.slice(1).map((p) => p.slice(0, -"package.json".length))]) {
    files.set(`${dir}.npmrc`, optional(`${dir}.npmrc`));
    for (const pnpmfile of [".pnpmfile.cjs", ".pnpmfile.mjs"]) {
      files.set(`${dir}${pnpmfile}`, optional(`${dir}${pnpmfile}`));
    }
    for (const base of ["vitest.config", "vite.config"]) {
      for (const ext of ["ts", "mts", "cts", "js", "mjs", "cjs"]) {
        const path = `${dir}${base}.${ext}`;
        if (existsSync(join(root, path))) files.set(path, read(path));
      }
    }
  }
  return { manifests: new Map(paths.map((p) => [p, json(p) as Manifest])), files };
}

/** Every way the workspace's scripts differ from the pinned ones; the empty list means none. */
function gateProblems(repo: Repo): string[] {
  const problems: string[] = [];
  const fail = (message: string) => problems.push(message);
  const show = (value: unknown) => (value === null ? "absent" : JSON.stringify(value));
  const pinned = (file: string, name: string, want: string | null) => {
    const got = repo.manifests.get(file)?.scripts?.[name] ?? null;
    if (got !== want) {
      fail(
        `${file}: scripts["${name}"] changed (pinned ${show(want)}, now ${show(got)}); review the change, then update the pinned value in ${SELF}`,
      );
    }
  };

  const expected = ["package.json", ...Object.keys(PACKAGE_PINNED)];
  for (const file of repo.manifests.keys()) {
    if (!expected.includes(file)) {
      fail(
        `${file}: a workspace package whose test, build, typecheck and lint scripts are not pinned; review them, then add them to the pinned value in ${SELF}`,
      );
    }
  }
  for (const file of expected) {
    if (!repo.manifests.has(file)) {
      fail(
        `${file}: a pinned workspace package is missing; review the change, then update ${SELF}`,
      );
    }
  }
  for (const [name, want] of Object.entries(ROOT_PINNED)) pinned("package.json", name, want);
  for (const [file, scripts] of Object.entries(PACKAGE_PINNED)) {
    for (const [name, want] of Object.entries(scripts)) pinned(file, name, want);
  }
  for (const file of GUARDED) pinned(file, "prepublishOnly", PREPUBLISH_GUARD);
  const packageManager = repo.manifests.get("package.json")?.packageManager;
  if (packageManager !== PACKAGE_MANAGER) {
    fail(
      `package.json: packageManager changed (pinned ${show(PACKAGE_MANAGER)}, now ${show(packageManager ?? null)}); pnpm/action-setup and Vercel install the version it names; review the change, then update the pinned value in ${SELF}`,
    );
  }

  for (const [file, manifest] of repo.manifests) {
    for (const [name, script] of Object.entries(manifest.scripts ?? {})) {
      if (typeof script !== "string") {
        fail(`${file}: scripts["${name}"] is not a string; review the change`);
        continue;
      }
      if (name === "prepublishOnly" && GUARDED.includes(file) && script === PREPUBLISH_GUARD)
        continue;
      for (const [pattern, label] of SWALLOWS) {
        if (pattern.test(script)) {
          fail(
            `${file}: scripts["${name}"] contains ${label}, which lets a failure pass; review the change (only the three pinned prepublishOnly guards may use "||")`,
          );
        }
      }
    }
  }

  if (lf(repo.files.get("pnpm-workspace.yaml") ?? "") !== WORKSPACE_YAML) {
    fail(
      `pnpm-workspace.yaml changed (it chooses the packages that pnpm -r runs, and can set scriptShell); review the change, then update the pinned value in ${SELF}`,
    );
  }
  if (sha256(repo.files.get("scripts/vitest.config.ts") ?? "") !== SCRIPTS_VITEST_SHA256) {
    fail(
      `scripts/vitest.config.ts changed (it chooses which scripts/test files verify:launch runs); review the change, then update the pinned value in ${SELF}`,
    );
  }
  for (const [path, text] of repo.files) {
    if (path.endsWith(".npmrc") && text !== null) {
      fail(
        `${path} exists (an .npmrc can replace the shell every script runs in, with script-shell); review it, then allow it in ${SELF}`,
      );
    }
    if (/(^|\/)\.pnpmfile\.[cm]js$/.test(path) && text !== null) {
      fail(
        `${path} exists (a pnpmfile runs its own code on every pnpm install and can rewrite package manifests); review it, then allow it in ${SELF}`,
      );
    }
    if (/\bvite(st)?\.config\./.test(path) && /passWithNoTests/i.test(text ?? "")) {
      fail(
        `${path} sets passWithNoTests, which lets a run with no test files pass; review the change`,
      );
    }
    if (
      /\bvite(st)?\.config\./.test(path) &&
      /dangerouslyIgnoreUnhandledErrors/i.test(text ?? "")
    ) {
      fail(
        `${path} sets dangerouslyIgnoreUnhandledErrors, which lets a run with unhandled errors pass; review the change`,
      );
    }
  }
  return problems;
}

const repo = loadRepo();

const clone = (from: Repo): Repo => ({
  manifests: new Map([...from.manifests].map(([file, m]) => [file, structuredClone(m)])),
  files: new Map(from.files),
});
const scriptsIn = (of: Repo, file: string): Record<string, unknown> => {
  const scripts = of.manifests.get(file)?.scripts;
  if (!scripts) throw new Error(`${file} has no scripts`);
  return scripts;
};
const rootManifest = (of: Repo): Manifest => {
  const manifest = of.manifests.get("package.json");
  if (!manifest) throw new Error("package.json is not read");
  return manifest;
};
const append = (of: Repo, file: string, name: string, tail: string) => {
  const scripts = scriptsIn(of, file);
  scripts[name] = `${String(scripts[name])}${tail}`;
};

// Each is an edit of an in-memory copy of the parsed manifests (or of a config file). Every one must be
// refused, and for each listed reason. The first four are the ruling's (T17-R4 item 5).
const GATE_MUTATIONS: Array<[string, (r: Repo) => void, string[]]> = [
  [
    '"|| true" on verify:ts',
    (r) => append(r, "package.json", "verify:ts", " || true"),
    ['package.json: scripts["verify:ts"] changed', 'scripts["verify:ts"] contains "||"'],
  ],
  [
    "verify:launch replaced with true",
    (r) => {
      scriptsIn(r, "package.json")["verify:launch"] = "true";
    },
    ['package.json: scripts["verify:launch"] contains "true" (or ":") used as a command'],
  ],
  [
    "a package's test replaced with echo ok",
    (r) => {
      scriptsIn(r, "packages/core/package.json").test = "echo ok";
    },
    ['packages/core/package.json: scripts["test"] changed (pinned "vitest run", now "echo ok")'],
  ],
  [
    "--passWithNoTests added to a package's test",
    (r) => append(r, "packages/sdk/package.json", "test", " --passWithNoTests"),
    [
      'packages/sdk/package.json: scripts["test"] changed',
      'packages/sdk/package.json: scripts["test"] contains "--passWithNoTests"',
    ],
  ],
  // The other constructs, on scripts no exact pin covers, so only the scan can refuse them.
  [
    '"; true" on a root script',
    (r) => append(r, "package.json", "proof", "; true"),
    ['package.json: scripts["proof"] contains "; true"'],
  ],
  [
    '";true" on an app script',
    (r) => append(r, "apps/web/package.json", "test:e2e", ";true"),
    ['apps/web/package.json: scripts["test:e2e"] contains "; true"'],
  ],
  [
    '"exit 0" in an app script',
    (r) => append(r, "apps/web/package.json", "dev", " && exit 0"),
    ['apps/web/package.json: scripts["dev"] contains "exit 0"'],
  ],
  [
    '"|| exit 0" in a package script',
    (r) => append(r, "packages/core/package.json", "fixtures", " || exit 0"),
    ['packages/core/package.json: scripts["fixtures"] contains "|| exit 0"'],
  ],
  [
    '"--bail 0" on the web tests',
    (r) => append(r, "apps/web/package.json", "test", " --bail 0"),
    [
      'apps/web/package.json: scripts["test"] changed',
      'apps/web/package.json: scripts["test"] contains "--bail 0"',
    ],
  ],
  [
    '" true" used as a command',
    (r) => {
      scriptsIn(r, "package.json")["verify:full"] = "pnpm run verify; true";
    },
    ['scripts["verify:full"] contains "; true"', 'scripts["verify:full"] contains "true" (or ":")'],
  ],
  [
    "true as the whole script",
    (r) => {
      scriptsIn(r, "package.json")["test:sandbox"] = " true";
    },
    ['scripts["test:sandbox"] contains "true" (or ":") used as a command'],
  ],
  [
    "a bare exit",
    (r) => {
      scriptsIn(r, "package.json")["contracts:build"] = "exit";
    },
    ['scripts["contracts:build"] contains a bare "exit"'],
  ],
  [
    '":" as a command',
    (r) => {
      scriptsIn(r, "packages/sdk/package.json")["record:nearai"] = ":";
    },
    ['scripts["record:nearai"] contains "true" (or ":") used as a command'],
  ],
  // Pins this file holds
  [
    "the node:test run dropped from the root test (it runs ci-workflow.test.mjs)",
    (r) => {
      scriptsIn(r, "package.json").test = "pnpm -r --if-present run test";
    },
    ['package.json: scripts["test"] changed'],
  ],
  [
    "lint, build and typecheck dropped from verify:ts",
    (r) => {
      scriptsIn(r, "package.json")["verify:ts"] = "pnpm run test";
    },
    ['package.json: scripts["verify:ts"] changed'],
  ],
  [
    "verify:rust weakened to echo",
    (r) => {
      scriptsIn(r, "package.json")["verify:rust"] = "echo skipped";
    },
    ['package.json: scripts["verify:rust"] changed'],
  ],
  [
    "a package's test script removed (pnpm -r --if-present would skip it)",
    (r) => {
      delete scriptsIn(r, "packages/cli/package.json").test;
    },
    ['packages/cli/package.json: scripts["test"] changed (pinned "vitest run", now absent)'],
  ],
  [
    "a package's typecheck weakened",
    (r) => {
      scriptsIn(r, "apps/web/package.json").typecheck = "echo ok";
    },
    ['apps/web/package.json: scripts["typecheck"] changed'],
  ],
  [
    "a package lint script added",
    (r) => {
      scriptsIn(r, "packages/core/package.json").lint = "echo ok";
    },
    ['packages/core/package.json: scripts["lint"] changed (pinned absent, now "echo ok")'],
  ],
  [
    "a package build that no longer cleans dist",
    (r) => {
      scriptsIn(r, "packages/sdk/package.json").build = "tsc -p tsconfig.build.json";
    },
    ['packages/sdk/package.json: scripts["build"] changed'],
  ],
  [
    "a prepublishOnly guard that exits 0",
    (r) => {
      const scripts = scriptsIn(r, "packages/cli/package.json");
      scripts.prepublishOnly = String(scripts.prepublishOnly).replace("exit(1)", "exit(0)");
    },
    [
      'packages/cli/package.json: scripts["prepublishOnly"] changed',
      'packages/cli/package.json: scripts["prepublishOnly"] contains "||"',
    ],
  ],
  [
    "the guard copied into a package that is not one of the three",
    (r) => {
      scriptsIn(r, "apps/web/package.json").prepublishOnly = PREPUBLISH_GUARD;
    },
    ['apps/web/package.json: scripts["prepublishOnly"] contains "||"'],
  ],
  [
    "a new workspace package that nothing pins",
    (r) => {
      r.manifests.set("packages/mcp/package.json", { scripts: { test: "echo ok" } });
    },
    ["packages/mcp/package.json: a workspace package whose test, build, typecheck and lint"],
  ],
  // The files that decide how every script runs
  [
    "an .npmrc that replaces the script shell",
    (r) => {
      r.files.set(".npmrc", "script-shell=/bin/true\n");
    },
    [".npmrc exists"],
  ],
  [
    "a scriptShell setting in pnpm-workspace.yaml",
    (r) => {
      r.files.set("pnpm-workspace.yaml", `${WORKSPACE_YAML}scriptShell: ./sh\n`);
    },
    ["pnpm-workspace.yaml changed"],
  ],
  [
    "a package dropped from the pnpm workspace",
    (r) => {
      r.files.set("pnpm-workspace.yaml", 'packages:\n  - "apps/*"\n');
    },
    ["pnpm-workspace.yaml changed"],
  ],
  [
    "a scripts/vitest.config.ts that skips this file",
    (r) => {
      const config = r.files.get("scripts/vitest.config.ts") ?? "";
      r.files.set(
        "scripts/vitest.config.ts",
        config.replace(
          'include: ["test/**/*.test.ts"]',
          'include: ["test/**/*.test.ts"], exclude: ["test/release-manifests.test.ts"]',
        ),
      );
    },
    ["scripts/vitest.config.ts changed"],
  ],
  [
    "passWithNoTests in a package's vitest config",
    (r) => {
      const config = r.files.get("packages/core/vitest.config.ts") ?? "";
      r.files.set(
        "packages/core/vitest.config.ts",
        config.replace("  test: {\n", "  test: {\n    passWithNoTests: true,\n"),
      );
    },
    ["packages/core/vitest.config.ts sets passWithNoTests"],
  ],
  [
    "a .pnpmfile.cjs at the root",
    (r) => {
      r.files.set(".pnpmfile.cjs", "module.exports = { hooks: { readPackage: (p) => p } };\n");
    },
    [".pnpmfile.cjs exists (a pnpmfile runs its own code"],
  ],
  [
    "a .pnpmfile.cjs in a workspace package",
    (r) => {
      r.files.set("packages/core/.pnpmfile.cjs", "module.exports = {};\n");
    },
    ["packages/core/.pnpmfile.cjs exists"],
  ],
  [
    "dangerouslyIgnoreUnhandledErrors in a package's vitest config",
    (r) => {
      const config = r.files.get("apps/web/vitest.config.ts") ?? "";
      r.files.set(
        "apps/web/vitest.config.ts",
        config.replace("  test: {\n", "  test: {\n    dangerouslyIgnoreUnhandledErrors: true,\n"),
      );
    },
    ["apps/web/vitest.config.ts sets dangerouslyIgnoreUnhandledErrors"],
  ],
  [
    "--dangerouslyIgnoreUnhandledErrors on a package's test",
    (r) => append(r, "packages/cli/package.json", "test", " --dangerouslyIgnoreUnhandledErrors"),
    [
      'packages/cli/package.json: scripts["test"] changed',
      'packages/cli/package.json: scripts["test"] contains "--dangerouslyIgnoreUnhandledErrors"',
    ],
  ],
  // packageManager is what pnpm/action-setup and Vercel install
  [
    "packageManager set to pnpm 9",
    (r) => {
      rootManifest(r).packageManager = "pnpm@9.15.9";
    },
    ["package.json: packageManager changed", 'now "pnpm@9.15.9"'],
  ],
  [
    "packageManager set to npm",
    (r) => {
      rootManifest(r).packageManager = "npm@10.9.0";
    },
    ["package.json: packageManager changed", 'now "npm@10.9.0"'],
  ],
  [
    "packageManager set to yarn",
    (r) => {
      rootManifest(r).packageManager = "yarn@4.5.0";
    },
    ["package.json: packageManager changed", 'now "yarn@4.5.0"'],
  ],
  [
    "packageManager moved to another pnpm 10 version without reviewing the pin",
    (r) => {
      rootManifest(r).packageManager = NEXT_MINOR;
    },
    ["package.json: packageManager changed", `now "${NEXT_MINOR}"`],
  ],
  [
    "packageManager removed",
    (r) => {
      delete rootManifest(r).packageManager;
    },
    ["package.json: packageManager changed", "now absent"],
  ],
];

describe("the gate scripts that release.yml runs (T17-R4)", () => {
  it("are the pinned ones, in the pinned workspace, and none can swallow a failure", () => {
    expect(gateProblems(repo)).toEqual([]);
  });

  it("are read from every workspace package and every config file that changes how they run", () => {
    expect([...repo.manifests.keys()].sort()).toEqual(
      ["package.json", ...Object.keys(PACKAGE_PINNED)].sort(),
    );
    expect([...repo.files.keys()]).toEqual(
      expect.arrayContaining([
        "pnpm-workspace.yaml",
        "scripts/vitest.config.ts",
        ".npmrc",
        "apps/web/.npmrc",
        ".pnpmfile.cjs",
        "apps/web/.pnpmfile.cjs",
        "packages/core/vitest.config.ts",
        "apps/web/vitest.config.ts",
      ]),
    );
  });

  for (const [name, edit, reasons] of GATE_MUTATIONS) {
    it(`refuses ${name}`, () => {
      const mutated = clone(repo);
      edit(mutated);
      const before = JSON.stringify([...repo.manifests, ...repo.files]);
      expect(JSON.stringify([...mutated.manifests, ...mutated.files]), "changed nothing").not.toBe(
        before,
      );
      const problems = gateProblems(mutated);
      for (const reason of reasons) {
        expect(
          problems.some((p) => p.includes(reason)),
          `not refused for "${reason}": ${problems.join(" | ")}`,
        ).toBe(true);
      }
      // The edit was made on a copy: the manifests as read are untouched.
      expect(JSON.stringify([...repo.manifests, ...repo.files])).toBe(before);
    });
  }
});
