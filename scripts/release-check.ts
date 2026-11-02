// Release gate for the npm packages (plan 03 Task 17). It runs in CI before anything is published
// (`.github/workflows/release.yml`) and on a developer machine before a tag is pushed:
//
//   pnpm run release:check -- sdk-v0.1.0                 versions, changelog, tag, manifest shape
//   pnpm run release:check -- --pack [--out DIR] sdk-v0.1.0   the same, then `pnpm pack` every package and
//                                                       inspect the tarballs that npm would receive
//
// Publishing itself is an OWNER action and never happens here.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

/** In dependency order: a package is published after everything it depends on. */
export const PUBLISHED_DIRS = [
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
  main?: string;
  types?: string;
  typings?: string;
  module?: string;
  bin?: string | Record<string, string>;
  exports?: unknown;
  files?: readonly string[];
  publishConfig?: { access?: string };
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

/**
 * The shape every published manifest must have, checked on the files in the repository:
 * - `main` and `types` at the top level, for tools that do not read `exports`;
 * - every `exports` subpath names `types`, `import` and `default`, `types` first (TypeScript and Node use
 *   the first condition that matches), so a CommonJS or bundler consumer is not told "not exported";
 * - `files` ships `dist` and `README.md`; a scoped package needs `publishConfig.access: "public"`.
 */
export function checkManifest(manifest: PackageManifest): string[] {
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
  return problems;
}

export interface Release {
  packages: PackageInfo[];
  manifests: Map<string, PackageManifest>;
  changelog: string;
  cliVersion: string | null;
  /** CHANGELOG.md and the README.md of every published package, by path relative to the root. */
  docs: Map<string, string>;
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
  return { packages, manifests, changelog, cliVersion, docs };
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
 * this release.
 */
export function checkTarball(input: {
  info: PackageInfo;
  files: ReadonlyMap<string, Uint8Array>;
  internal: ReadonlyMap<string, string>;
}): string[] {
  const { info, files, internal } = input;
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

/** Reads the tarball of every package from `outDir` and checks it. `entries` is the publish list, in order. */
export function inspectTarballs(
  packages: readonly PackageInfo[],
  outDir: string,
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
    problems.push(...checkTarball({ info, files, internal }));
  }
  return { problems, entries };
}

/**
 * `pnpm pack` rewrites `workspace:*` to the real version, which `npm pack` does not. Run through
 * `pnpm run` the script has `npm_execpath`, so pnpm's own entry point is started with this node
 * (no .cmd shim, which Node on Windows refuses to spawn without a shell).
 */
function pnpmCommand(env: Readonly<Record<string, string | undefined>>): {
  command: string;
  args: string[];
  shell: boolean;
} {
  const execPath = env.npm_execpath;
  if (execPath !== undefined && /pnpm/i.test(execPath) && /\.[cm]?js$/.test(execPath)) {
    return { command: process.execPath, args: [execPath], shell: false };
  }
  return { command: "pnpm", args: [], shell: process.platform === "win32" };
}

function packPackages(
  packages: readonly PackageInfo[],
  outDir: string,
  root: string,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const problems: string[] = [];
  const pnpm = pnpmCommand(env);
  for (const info of packages) {
    const result = spawnSync(
      pnpm.command,
      [...pnpm.args, "pack", "--pack-destination", resolve(outDir)],
      {
        cwd: join(root, info.dir),
        stdio: "inherit",
        shell: pnpm.shell,
        env: { ...process.env, ...env },
      },
    );
    if (result.status !== 0) {
      problems.push(
        `${info.name}: pnpm pack failed (${result.error?.message ?? `exit ${result.status}`})`,
      );
    }
  }
  return problems;
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
  for (const info of release.packages) {
    const manifest = release.manifests.get(info.dir);
    if (manifest !== undefined)
      problems.push(...checkManifest(manifest).map((p) => `${info.name}: ${p}`));
  }
  problems.push(...checkDocs(release.docs));
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
      const inspected = inspectTarballs(release.packages, outDir);
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

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
