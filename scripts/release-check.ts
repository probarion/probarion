// Release gate for the npm packages (plan 03 Task 17). It runs in CI before anything is published
// (`.github/workflows/release.yml`) and on a developer machine before a tag is pushed:
//
//   pnpm run release:check -- sdk-v0.1.0                 versions, changelog, tag, manifest shape
//   pnpm run release:check -- --pack [--out DIR] sdk-v0.1.0   the same, then `pnpm pack` every package and
//                                                       inspect the tarballs that npm would receive
//
// Publishing itself is an OWNER action and never happens here.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

/** In dependency order: a package is published after everything it depends on. */
export const PUBLISHED_DIRS = [
  "packages/near",
  "packages/core",
  "packages/sdk",
  "packages/cli",
  "packages/mcp",
] as const;

export interface PackageInfo {
  dir: string;
  name: string;
  version: string;
  private: boolean;
}

const TAG_RE = /^sdk-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

export function checkRelease(input: {
  tag: string;
  packages: readonly PackageInfo[];
  changelog: string;
  cliVersion: string | null;
}): string[] {
  const match = TAG_RE.exec(input.tag);
  if (match === null) return [`tag ${JSON.stringify(input.tag)} does not match sdk-v<semver>`];
  const version = match[1] ?? "";
  const problems: string[] = [];
  if (!input.packages.some((p) => p.name === "@probarion/core"))
    problems.push("@probarion/core is missing");
  for (const p of input.packages) {
    if (p.private) problems.push(`${p.name} (${p.dir}) is private and cannot be published`);
    if (p.version !== version) problems.push(`${p.name} is ${p.version}, the tag says ${version}`);
  }
  if (input.cliVersion !== null && input.cliVersion !== version) {
    problems.push(`packages/cli/src/version.ts says ${input.cliVersion}, the tag says ${version}`);
  }
  const heading = new RegExp(`^## \\[?${version.replace(/[.]/g, "\\.")}\\]?(\\s|$)`, "m");
  if (!heading.test(input.changelog)) problems.push(`CHANGELOG.md has no "## ${version}" section`);
  return problems;
}

// ---------- command line ----------

export interface CliArgs {
  tag: string;
  pack: boolean;
  out: string | undefined;
}

/** `[--pack] [--out DIR] [TAG]`. A leading `--` (pnpm may pass it on) is ignored; no tag means GITHUB_REF_NAME. */
export function parseCliArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv.filter((arg) => arg !== "--"),
    options: { pack: { type: "boolean" }, out: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 1) {
    throw new Error(`expected one tag, got ${positionals.length}: ${positionals.join(" ")}`);
  }
  // An empty GITHUB_REF_NAME counts as unset (R12).
  const tag = (positionals[0] ?? env.GITHUB_REF_NAME ?? "").trim();
  return { tag, pack: values.pack === true, out: values.out };
}

// ---------- manifests ----------

export interface PackageManifest {
  name?: string;
  version?: string;
  private?: boolean;
  /** The server's name in the official MCP registry, which compares it with server.json's `name`. */
  mcpName?: string;
  main?: string;
  types?: string;
  typings?: string;
  module?: string;
  bin?: string | Record<string, string>;
  exports?: unknown;
  files?: readonly string[];
  publishConfig?: { access?: string };
  repository?: { type?: string; url?: string; directory?: string };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every `exports` target with the subpath that names it. `null` (a blocked subpath) has no target. */
function exportEntries(exportsField: unknown): { subpath: string; target: string }[] {
  const out: { subpath: string; target: string }[] = [];
  const walk = (subpath: string, value: unknown): void => {
    if (typeof value === "string") out.push({ subpath, target: value });
    else if (Array.isArray(value)) for (const item of value) walk(subpath, item);
    else if (isRecord(value)) for (const item of Object.values(value)) walk(subpath, item);
  };
  if (isRecord(exportsField) && Object.keys(exportsField).some((key) => key.startsWith("."))) {
    for (const [subpath, value] of Object.entries(exportsField)) walk(subpath, value);
  } else {
    walk(".", exportsField);
  }
  return out;
}

/** Every string leaf of an `exports` field: the files a consumer can be sent to. */
export function exportTargets(exportsField: unknown): string[] {
  return exportEntries(exportsField).map((entry) => entry.target);
}

export const REPOSITORY_URL = "git+https://github.com/probarion/probarion.git";

/**
 * The shape every published manifest must have, checked on the files in the repository:
 * - `main` and `types` at the top level, for tools that do not read `exports`;
 * - every `exports` subpath names `types`, `import` and `default`, `types` first (TypeScript and Node use
 *   the first condition that matches), so a CommonJS or bundler consumer is not told "not exported";
 * - `files` ships `dist` and `README.md`; a scoped package needs `publishConfig.access: "public"`;
 * - `repository` names this repository and, when `dir` is given, the package's directory (npm provenance
 *   compares the repository with the one the workflow ran in);
 * - `scripts.prepublishOnly` is set, so a `npm publish` from a developer machine is refused.
 */
export function checkManifest(manifest: PackageManifest, dir?: string): string[] {
  const problems: string[] = [];
  if (typeof manifest.main !== "string") problems.push('"main" is missing');
  if (typeof manifest.types !== "string") problems.push('"types" is missing');
  const field = manifest.exports;
  if (field === undefined || field === null) {
    problems.push('"exports" is missing');
  } else {
    const subpaths: [string, unknown][] =
      isRecord(field) && Object.keys(field).some((key) => key.startsWith("."))
        ? Object.entries(field)
        : [[".", field]];
    for (const [subpath, value] of subpaths) {
      if (value === null) continue;
      if (!isRecord(value)) {
        problems.push(
          `exports ${JSON.stringify(subpath)} must be an object with types, import and default`,
        );
        continue;
      }
      for (const condition of ["types", "import", "default"]) {
        if (typeof value[condition] !== "string") {
          problems.push(`exports ${JSON.stringify(subpath)} has no "${condition}" condition`);
        }
      }
      if (typeof value.types === "string" && Object.keys(value)[0] !== "types") {
        problems.push(
          `exports ${JSON.stringify(subpath)}: "types" must come first (the first matching condition wins)`,
        );
      }
    }
  }
  for (const entry of ["dist", "README.md"]) {
    if (!manifest.files?.includes(entry)) problems.push(`"files" must include "${entry}"`);
  }
  if (manifest.publishConfig?.access !== "public") {
    problems.push(
      'publishConfig.access must be "public" (a scoped package is otherwise restricted)',
    );
  }
  if (manifest.repository?.url !== REPOSITORY_URL) {
    problems.push(`repository.url must be ${REPOSITORY_URL}`);
  }
  if (dir !== undefined && manifest.repository?.directory !== dir) {
    problems.push(`repository.directory must be ${dir}`);
  }
  if (typeof manifest.scripts?.prepublishOnly !== "string") {
    problems.push(
      "scripts.prepublishOnly is missing (a publish from a developer machine must be refused)",
    );
  }
  return problems;
}

export interface Release {
  packages: PackageInfo[];
  manifests: Map<string, PackageManifest>;
  changelog: string;
  cliVersion: string | null;
  /** Set when `version.ts` exists but holds no `CLI_VERSION = "…"`: the version check must not be skipped silently. */
  cliVersionProblem: string | null;
  /** CHANGELOG.md and the README.md of every published package, by path relative to the root. */
  docs: Map<string, string>;
  /** `packages/mcp/server.json`: null when there is none, `invalid` when it is not JSON. */
  serverJson: { parsed: unknown } | { invalid: string } | null;
}

/**
 * A note in a README or the changelog that says the text is not final, written as an HTML comment so it
 * stays out of the rendered page: `<!-- TODO(release): ... -->`. A release cannot be cut while one is left.
 */
export const RELEASE_NOTE = "TODO(release)";

export function checkDocs(docs: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  for (const [path, text] of docs) {
    for (const line of text.split(/\r?\n/)) {
      if (line.includes(RELEASE_NOTE)) {
        problems.push(`${path} still has an open release note: ${line.trim().slice(0, 160)}`);
      }
    }
  }
  return problems;
}

// ---------- the MCP registry entry ----------

/**
 * The entry `mcp-publisher publish` sends to the official MCP registry. The OWNER runs it in packages/mcp once npm
 * has the release, so it is read from the repository: it is not in the tarball, which holds only dist/, README.md,
 * LICENSE and package.json (checkTarball).
 */
export const SERVER_JSON = "packages/mcp/server.json";

/** The registry schema the entry follows, as its `$schema` names it. */
export const SERVER_SCHEMA =
  "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";

/**
 * What a release changes in `packages/mcp/server.json`, checked against the package's manifest and the tag's version.
 * The registry lists an npm package only when the package's `mcpName` is the entry's `name`, keeps a version as it
 * was first published, and takes a description of at most 100 characters. So the entry names the schema, the
 * package's `mcpName`, this release's version (at the top and on its one npm package) and the package itself.
 * scripts/test/release-manifests.test.ts pins the rest of the entry to the code (its environment variables).
 */
export function checkServerJson(
  server: unknown,
  manifest: PackageManifest,
  version: string,
): string[] {
  if (!isRecord(server)) return ["is not a JSON object"];
  const problems: string[] = [];
  if (server.$schema !== SERVER_SCHEMA) problems.push(`$schema must be ${SERVER_SCHEMA}`);
  if (typeof manifest.mcpName !== "string" || manifest.mcpName === "") {
    problems.push(`${manifest.name} has no "mcpName" in package.json, which the registry checks`);
  } else if (server.name !== manifest.mcpName) {
    problems.push(
      `name is ${JSON.stringify(server.name)}, but the "mcpName" of ${manifest.name} is ${JSON.stringify(manifest.mcpName)}`,
    );
  }
  const description = server.description;
  if (typeof description !== "string" || description.length === 0 || description.length > 100) {
    problems.push(
      `description must be 1 to 100 characters, the registry's limit (it is ${typeof description === "string" ? `${description.length} characters` : "missing"})`,
    );
  }
  if (server.version !== version) {
    problems.push(`version is ${JSON.stringify(server.version)}, the tag says ${version}`);
  }
  const npm = (Array.isArray(server.packages) ? server.packages : []).filter(
    (p): p is Record<string, unknown> => isRecord(p) && p.registryType === "npm",
  );
  if (npm.length !== 1) {
    problems.push(`packages must hold one npm package, it holds ${npm.length}`);
  }
  for (const p of npm) {
    if (p.identifier !== manifest.name) {
      problems.push(
        `the npm package is ${JSON.stringify(p.identifier)}, expected ${JSON.stringify(manifest.name)}`,
      );
    }
    if (p.version !== version) {
      problems.push(
        `the npm package's version is ${JSON.stringify(p.version)}, the tag says ${version}`,
      );
    }
  }
  return problems;
}

/** The published packages that exist under `root` (a missing `packages/mcp` is skipped), the changelog and the cli version. */
export async function loadRelease(root: string): Promise<Release> {
  const packages: PackageInfo[] = [];
  const manifests = new Map<string, PackageManifest>();
  const docs = new Map<string, string>();
  for (const dir of PUBLISHED_DIRS) {
    const file = join(root, dir, "package.json");
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(await readFile(file, "utf8")) as PackageManifest;
    manifests.set(dir, manifest);
    const readme = join(root, dir, "README.md");
    if (existsSync(readme)) docs.set(`${dir}/README.md`, await readFile(readme, "utf8"));
    packages.push({
      dir,
      name: manifest.name ?? "",
      version: manifest.version ?? "",
      private: manifest.private === true,
    });
  }
  const changelogFile = join(root, "CHANGELOG.md");
  const changelog = existsSync(changelogFile) ? await readFile(changelogFile, "utf8") : "";
  docs.set("CHANGELOG.md", changelog);
  const versionFile = join(root, "packages/cli/src/version.ts");
  const cliSource = existsSync(versionFile) ? await readFile(versionFile, "utf8") : null;
  const cliVersion =
    cliSource === null ? null : (/CLI_VERSION = "([^"]+)"/.exec(cliSource)?.[1] ?? null);
  const cliVersionProblem =
    cliSource !== null && cliVersion === null
      ? 'packages/cli/src/version.ts exists but has no CLI_VERSION = "<version>", so the cli version cannot be checked against the tag'
      : null;
  const serverFile = join(root, SERVER_JSON);
  let serverJson: Release["serverJson"] = null;
  if (existsSync(serverFile)) {
    try {
      serverJson = { parsed: JSON.parse(await readFile(serverFile, "utf8")) as unknown };
    } catch (error) {
      serverJson = { invalid: error instanceof Error ? error.message : String(error) };
    }
  }
  return { packages, manifests, changelog, cliVersion, cliVersionProblem, docs, serverJson };
}

// ---------- tarballs ----------

function cString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
}

function pathsFromPax(body: Uint8Array): string | undefined {
  // Records are "<length> <key>=<value>\n", the length counting the whole record.
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(new TextDecoder().decode(body.subarray(offset, space)), 10);
    if (!(length > 0)) break;
    const record = new TextDecoder().decode(body.subarray(space + 1, offset + length - 1));
    const eq = record.indexOf("=");
    if (eq !== -1 && record.slice(0, eq) === "path") return record.slice(eq + 1);
    offset += length;
  }
  return undefined;
}

/**
 * The regular files of a gzip-compressed tar archive, by path with the leading `package/` removed. Plain
 * Node, no `tar` binary: that one differs between Git Bash (GNU tar reads `C:\…` as a remote host) and CI.
 * Handles ustar, the ustar prefix field, PAX `path` and GNU long names, which is what npm and pnpm write.
 */
export function readTarball(gz: Uint8Array): Map<string, Uint8Array> {
  const tar = gunzipSync(gz);
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  let nextPath: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(cString(header.subarray(124, 136)).trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      nextPath = pathsFromPax(body) ?? nextPath;
      continue;
    }
    if (type === "L") {
      nextPath = cString(body);
      continue;
    }
    if (type === "g") continue;
    const name = cString(header.subarray(0, 100));
    // The prefix field exists only in POSIX ustar ("ustar\0"); in GNU format ("ustar  ") it holds other data.
    const posix = cString(header.subarray(257, 263)) === "ustar" && header[262] === 0;
    const prefix = posix ? cString(header.subarray(345, 500)) : "";
    const path = nextPath ?? (prefix === "" ? name : `${prefix}/${name}`);
    nextPath = undefined;
    if (type === "1" || type === "2") throw new Error(`the tarball holds a link (${path})`);
    if (type !== "0" && type !== "\0") continue;
    const slash = path.indexOf("/");
    files.set(slash === -1 ? path : path.slice(slash + 1), Uint8Array.from(body));
  }
  return files;
}

/** The file name `pnpm pack` gives a package: `@probarion/core` 0.1.0 → `probarion-core-0.1.0.tgz`. */
export function expectedTarballName(name: string, version: string): string {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

const DEPENDENCY_BLOCKS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "devDependencies",
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * What npm would publish, checked on the packed tarball and its own `package.json`:
 * every file that `exports`, `main`, `types` and `bin` name is in it (a target built into `dist/testing`
 * that did not get packed is the typical break); the files are `dist/`, README.md, LICENSE and
 * package.json and nothing else; no source maps (they would name a `src/` that is not shipped); a
 * bin script has its shebang; no `workspace:` specifier is left and a sibling package is pinned to
 * this release. server.json, the MCP registry entry, is one of the files refused: the registry reads it from the
 * repository (SERVER_JSON).
 * When `mcpName` is given (the `name` of server.json, for the package the entry lists), the packed manifest must hold
 * that `mcpName`: the registry reads the field from the version document npm serves, which is this package.json, not
 * the repository's. An npm version cannot be published twice, so a tarball that lost the field would burn the version.
 */
export function checkTarball(input: {
  info: PackageInfo;
  files: ReadonlyMap<string, Uint8Array>;
  internal: ReadonlyMap<string, string>;
  mcpName?: string;
}): string[] {
  const { info, files, internal, mcpName } = input;
  const problems: string[] = [];
  const fail = (message: string): void => {
    problems.push(`${info.name}: ${message}`);
  };

  const packed = files.get("package.json");
  let manifest: PackageManifest;
  try {
    if (packed === undefined) throw new Error("missing");
    manifest = JSON.parse(new TextDecoder().decode(packed)) as PackageManifest;
  } catch (error) {
    fail(
      `package.json ${error instanceof Error && error.message === "missing" ? "is not in the tarball" : "in the tarball is not valid JSON"}`,
    );
    return problems;
  }
  if (manifest.name !== info.name || manifest.version !== info.version) {
    fail(
      `the tarball's package.json is ${manifest.name}@${manifest.version}, expected ${info.name}@${info.version}`,
    );
  }
  if (mcpName !== undefined && manifest.mcpName !== mcpName) {
    fail(
      typeof manifest.mcpName === "string"
        ? `the tarball's package.json has "mcpName" ${JSON.stringify(manifest.mcpName)}, but ${SERVER_JSON} names ${JSON.stringify(mcpName)}; the MCP registry compares the two`
        : `the tarball's package.json has no "mcpName", which the MCP registry reads from npm before it lists ${JSON.stringify(mcpName)}`,
    );
  }

  const present = (target: string): boolean => {
    const rel = target.replace(/^\.\//, "");
    if (!rel.includes("*")) return files.has(rel);
    const pattern = new RegExp(`^${escapeRegExp(rel).replace(/\\\*/g, ".*")}$`);
    return [...files.keys()].some((path) => pattern.test(path));
  };
  const needs = (label: string, target: string): void => {
    const rel = target.replace(/^\.\//, "");
    if (rel.startsWith("../") || rel.startsWith("/")) {
      fail(`${label} → ${target} points outside the package`);
    } else if (!present(target)) {
      fail(`${label} → ${target} is not in the tarball`);
    }
  };
  for (const { subpath, target } of exportEntries(manifest.exports)) {
    if (!target.startsWith("./"))
      fail(`exports ${JSON.stringify(subpath)}: ${target} must start with "./"`);
    needs(`exports ${JSON.stringify(subpath)}`, target);
  }
  for (const field of ["main", "types", "typings", "module"] as const) {
    const target = manifest[field];
    if (typeof target === "string") needs(`"${field}"`, target);
  }
  const bins =
    typeof manifest.bin === "string" ? { [info.name]: manifest.bin } : (manifest.bin ?? {});
  for (const [command, target] of Object.entries(bins)) {
    needs(`"bin" ${command}`, target);
    const script = files.get(target.replace(/^\.\//, ""));
    if (script !== undefined && !(script[0] === 0x23 && script[1] === 0x21)) {
      fail(`"bin" ${command} → ${target} does not start with a #! line`);
    }
  }

  for (const path of [...files.keys()].sort()) {
    if (path.endsWith(".map")) {
      fail(
        `source map ${path} is in the tarball, but the sources it names are not shipped (the build sets sourceMap and declarationMap to false)`,
      );
    } else if (
      !(path.startsWith("dist/") || ["README.md", "LICENSE", "package.json"].includes(path))
    ) {
      fail(`unexpected file in the tarball: ${path}`);
    }
  }
  for (const required of ["README.md", "LICENSE"]) {
    if (!files.has(required)) fail(`${required} is not in the tarball`);
  }

  for (const block of DEPENDENCY_BLOCKS) {
    for (const [dependency, spec] of Object.entries(manifest[block] ?? {})) {
      if (/^(workspace|link|file):/.test(spec)) {
        fail(
          `${block}[${JSON.stringify(dependency)}] is ${JSON.stringify(spec)}, which npm cannot install`,
        );
        continue;
      }
      const sibling = internal.get(dependency);
      if (sibling !== undefined && spec.replace(/^[\^~]/, "") !== sibling) {
        fail(
          `${block}[${JSON.stringify(dependency)}] is ${JSON.stringify(spec)}, but this release publishes ${dependency}@${sibling}`,
        );
      }
    }
  }
  return problems;
}

export interface PackedEntry {
  name: string;
  version: string;
  file: string;
}

/**
 * Reads the tarball of every package from `outDir` and checks it. `entries` is the publish list, in order.
 * `mcpNames` maps a package name to the `mcpName` its packed manifest must hold (checkTarball).
 */
export function inspectTarballs(
  packages: readonly PackageInfo[],
  outDir: string,
  mcpNames: ReadonlyMap<string, string> = new Map(),
): { problems: string[]; entries: PackedEntry[] } {
  const problems: string[] = [];
  const entries: PackedEntry[] = [];
  const internal = new Map(packages.map((p) => [p.name, p.version]));
  for (const info of packages) {
    const file = expectedTarballName(info.name, info.version);
    const path = join(outDir, file);
    if (!existsSync(path)) {
      problems.push(`${info.name}: ${file} was not produced`);
      continue;
    }
    entries.push({ name: info.name, version: info.version, file });
    let files: Map<string, Uint8Array>;
    try {
      files = readTarball(readFileSync(path));
    } catch (error) {
      problems.push(
        `${info.name}: ${file} cannot be read (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }
    const mcpName = mcpNames.get(info.name);
    problems.push(
      ...checkTarball({ info, files, internal, ...(mcpName === undefined ? {} : { mcpName }) }),
    );
  }
  return { problems, entries };
}

export interface PackInvocation {
  command: string;
  args: string[];
  shell: boolean;
  /** True when pnpm writes the tarball into the package directory, from where it is moved to `outDir`. */
  inPlace: boolean;
}

/**
 * How to run `pnpm pack`. `pnpm pack` rewrites `workspace:*` to the real version, which `npm pack` does not.
 * - Started through `pnpm run` the script has `npm_execpath`, so pnpm's own entry point runs under this
 *   node with `--pack-destination`: no shell, no quoting, a folder with spaces is one argument.
 * - Otherwise on Windows pnpm is a .cmd shim, which Node refuses to start without a shell. A shell takes
 *   one command string, so the string is the constant `pnpm pack` with no path in it (pnpm does not read
 *   the destination from the environment, and an argument list next to `shell: true` is deprecated,
 *   DEP0190, and not quoted). The tarball lands in the package directory and `takeTarball` moves it.
 * - Otherwise `pnpm` is started directly.
 */
export function pnpmPackInvocation(
  env: Readonly<Record<string, string | undefined>>,
  outDir: string,
  platform: NodeJS.Platform = process.platform,
): PackInvocation {
  const dest = resolve(outDir);
  const execPath = env.npm_execpath;
  if (execPath !== undefined && /pnpm/i.test(execPath) && /\.[cm]?js$/.test(execPath)) {
    return {
      command: process.execPath,
      args: [execPath, "pack", "--pack-destination", dest],
      shell: false,
      inPlace: false,
    };
  }
  if (platform === "win32") {
    return { command: "pnpm pack", args: [], shell: true, inPlace: true };
  }
  return {
    command: "pnpm",
    args: ["pack", "--pack-destination", dest],
    shell: false,
    inPlace: false,
  };
}

/** Moves the tarball that `pnpm pack` wrote into the package directory to `outDir`. Returns a problem, or null. */
export function takeTarball(info: PackageInfo, packageDir: string, outDir: string): string | null {
  const file = expectedTarballName(info.name, info.version);
  const from = join(packageDir, file);
  if (!existsSync(from)) return `${info.name}: pnpm pack did not write ${file} into ${packageDir}`;
  try {
    // Copy and delete, not rename: the out directory may be on another drive.
    copyFileSync(from, join(outDir, file));
    rmSync(from, { force: true });
  } catch (error) {
    return `${info.name}: cannot move ${file} to ${outDir} (${error instanceof Error ? error.message : String(error)})`;
  }
  return null;
}

function packPackages(
  packages: readonly PackageInfo[],
  outDir: string,
  root: string,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const problems: string[] = [];
  const pack = pnpmPackInvocation(env, outDir);
  for (const info of packages) {
    const packageDir = join(root, info.dir);
    const result = spawnSync(pack.command, pack.args, {
      cwd: packageDir,
      stdio: "inherit",
      shell: pack.shell,
      env: { ...process.env, ...env },
    });
    if (result.status !== 0) {
      problems.push(
        `${info.name}: pnpm pack failed (${result.error?.message ?? `exit ${result.status}`})`,
      );
    } else if (pack.inPlace) {
      const problem = takeTarball(info, packageDir, outDir);
      if (problem !== null) problems.push(problem);
    }
  }
  return problems;
}

/**
 * Whether this module was started as the script (`main`), is being imported (`imported`), or was started
 * under its own name from a path that does not resolve to this file (`mismatch`). The last one must not
 * be mistaken for an import: that would end the process with exit code 0 having checked nothing.
 */
export function entryPointState(
  argv1: string | undefined,
  moduleUrl: string,
  platform: NodeJS.Platform = process.platform,
): "main" | "imported" | "mismatch" {
  if (argv1 === undefined) return "imported";
  const canonical = (path: string): string => {
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      real = resolve(path);
    }
    return platform === "win32" ? real.toLowerCase() : real;
  };
  if (canonical(argv1) === canonical(fileURLToPath(moduleUrl))) return "main";
  return /^release-check.[cm]?[jt]s$/.test(basename(argv1)) ? "mismatch" : "imported";
}

/**
 * The `mcpName` each packed manifest must hold: server.json's `name`, for the package in packages/mcp. Empty when
 * there is no server.json, or it has no string `name` (checkServerJson reports that one).
 */
export function packedMcpNames(
  release: Pick<Release, "manifests" | "serverJson">,
): Map<string, string> {
  const names = new Map<string, string>();
  const mcp = release.manifests.get("packages/mcp");
  const server =
    release.serverJson !== null && "parsed" in release.serverJson
      ? release.serverJson.parsed
      : null;
  if (mcp?.name !== undefined && isRecord(server) && typeof server.name === "string") {
    names.set(mcp.name, server.name);
  }
  return names;
}

// ---------- main ----------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  root: string = REPO_ROOT,
): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv, env);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\nusage: release-check [--pack] [--out DIR] sdk-v<version>\n`,
    );
    return 2;
  }
  const release = await loadRelease(root);
  const problems = checkRelease({ ...release, tag: args.tag });
  if (release.cliVersionProblem !== null) problems.push(release.cliVersionProblem);
  for (const info of release.packages) {
    const manifest = release.manifests.get(info.dir);
    if (manifest !== undefined)
      problems.push(...checkManifest(manifest, info.dir).map((p) => `${info.name}: ${p}`));
  }
  problems.push(...checkDocs(release.docs));
  const tagVersion = TAG_RE.exec(args.tag)?.[1];
  // A tag that is not sdk-v<semver> is reported by checkRelease; the entry's version is checked against a good one.
  if (release.serverJson !== null && tagVersion !== undefined) {
    const mcp = release.manifests.get("packages/mcp");
    if ("invalid" in release.serverJson) {
      problems.push(`${SERVER_JSON} is not valid JSON (${release.serverJson.invalid})`);
    } else if (mcp === undefined) {
      problems.push(`${SERVER_JSON} exists, but packages/mcp/package.json does not`);
    } else {
      problems.push(
        ...checkServerJson(release.serverJson.parsed, mcp, tagVersion).map(
          (p) => `${SERVER_JSON}: ${p}`,
        ),
      );
    }
  }
  let packed = "";
  if (args.pack) {
    // Packing does not depend on the tag, so a version or changelog problem is reported together with the tarball ones.
    const outDir =
      args.out === undefined
        ? mkdtempSync(join(tmpdir(), "probarion-release-"))
        : resolve(args.out);
    mkdirSync(outDir, { recursive: true });
    // A manifest left over from an earlier run must not be taken for this run's.
    rmSync(join(outDir, "packages.json"), { force: true });
    const packProblems = packPackages(release.packages, outDir, root, env);
    problems.push(...packProblems);
    if (packProblems.length === 0) {
      const inspected = inspectTarballs(release.packages, outDir, packedMcpNames(release));
      problems.push(...inspected.problems);
      if (problems.length === 0) {
        writeFileSync(
          join(outDir, "packages.json"),
          `${JSON.stringify({ tag: args.tag, packages: inspected.entries }, null, 2)}
`,
        );
        packed = `; ${inspected.entries.length} tarballs checked${args.out === undefined ? "" : ` in ${outDir}`}`;
      }
    }
    if (args.out === undefined) rmSync(outDir, { recursive: true, force: true });
  }
  if (problems.length > 0) {
    process.stderr.write(`release check failed:\n${problems.map((p) => `- ${p}`).join("\n")}\n`);
    return 1;
  }
  process.stdout.write(
    `release check ok: ${release.packages.map((p) => `${p.name}@${p.version}`).join(", ")}${packed}\n`,
  );
  return 0;
}

const entry = entryPointState(process.argv[1], import.meta.url);
if (entry === "main") {
  process.exitCode = await main(process.argv.slice(2));
} else if (entry === "mismatch") {
  process.stderr.write(
    `release-check: started as ${process.argv[1]}, which does not resolve to ${fileURLToPath(import.meta.url)}; nothing was checked
`,
  );
  process.exitCode = 1;
}
