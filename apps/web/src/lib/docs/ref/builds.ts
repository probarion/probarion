import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RefColumn, RefRow, RefTable } from "./types";

// The tables of /docs/trust/reproducible-builds. Nothing here is written by hand: every row comes
// from the files CI and the record use, read when the site is built. Server only. The rows are read
// on first use, not on import, so a route that only loads this module (the on-demand docs 404)
// opens no file.

/** The repository root. Next builds and vitest both run from apps/web. */
const ROOT = join(process.cwd(), "..", "..");

const CI_FILE = ".github/workflows/ci.yml";
const RECORD_FILE = "contracts/code-hashes.json";
const TOOLCHAIN_FILE = "rust-toolchain.toml";
/** The crates CI's reproducible job builds, by folder under contracts/. */
const CRATE_DIRS = ["vault", "factory"] as const;
const DEPLOYMENT_FILES = [
  { file: "contracts/deployments/testnet.json", label: "Testnet" },
  { file: "contracts/deployments/mainnet.json", label: "Mainnet" },
] as const;

const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const code = (text: string) => `\`${text}\``;

/** The one value all matches of `re` capture; throws when there is none, or more than one. */
function single(text: string, re: RegExp, what: string, file: string): string {
  const found = [...new Set([...text.matchAll(re)].map((m) => m[1] ?? ""))];
  const [value] = found;
  if (found.length !== 1 || !value) {
    throw new Error(`builds: expected one ${what} in ${file}, found ${JSON.stringify(found)}`);
  }
  return value;
}

/** The strings of a TOML string or array of strings: `"a"` is [a], `[]` is none. */
const tomlStrings = (value: string) => [...value.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "");

/** `key` of each crate's [package.metadata.near.reproducible_build], as strings; all must agree. */
function reproducibleBuildList(key: string): string[] {
  const values = CRATE_DIRS.map((dir) => {
    const file = `contracts/${dir}/Cargo.toml`;
    const section =
      /^\[package\.metadata\.near\.reproducible_build\]\r?\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(
        read(file),
      )?.[1] ?? "";
    const line = new RegExp(`^${key}\\s*=\\s*(.+?)\\s*$`, "gm");
    return tomlStrings(single(section, line, key, file));
  });
  const texts = values.map((v) => JSON.stringify(v));
  if (new Set(texts).size !== 1) {
    throw new Error(`builds: the crates' ${key} differ: ${texts.join(" vs ")}`);
  }
  return values[0] ?? [];
}

/** `key` of the crates' reproducible_build as one line of text: `["a", "b"]` is a b. */
const reproducibleBuild = (key: string) => reproducibleBuildList(key).join(" ");

const TOOLCHAIN_COLUMNS: readonly RefColumn[] = [
  { key: "item", label: "What" },
  { key: "value", label: "Value" },
  { key: "source", label: "Set in" },
];

function toolchainRows(): RefRow[] {
  const ci = read(CI_FILE);
  const release = /releases\/download\/cargo-near-v(\d+\.\d+\.\d+)\//g;
  const version = single(ci, release, "cargo-near release", CI_FILE);
  const asset = /releases\/download\/cargo-near-v[\d.]+\/(cargo-near-[\w.-]+?\.tar\.gz)"/g;
  const archive = single(ci, asset, "cargo-near archive", CI_FILE);
  const sha256 = single(ci, /^\s*CARGO_NEAR_SHA256:\s*([0-9a-f]{64})\s*$/gm, "sha256", CI_FILE);
  const pinned = /^channel\s*=\s*"([^"]+)"/gm;
  const rust = single(read(TOOLCHAIN_FILE), pinned, "channel", TOOLCHAIN_FILE);
  const ciRust = single(ci, /^\s*toolchain:\s*(\S+)\s*$/gm, "Rust toolchain", CI_FILE);
  if (ciRust !== rust) {
    throw new Error(`builds: ${CI_FILE} installs Rust ${ciRust}, ${TOOLCHAIN_FILE} pins ${rust}`);
  }
  const legs = [
    ...ci.matchAll(/\{\s*crate:\s*[\w-]+,\s*dir:\s*([\w-]+),\s*lib:\s*(\w+)\s*\}/g),
  ].map((m) => `bash scripts/build-reproducible.sh ${m[1]} ${m[2]}`);
  if (legs.length === 0) throw new Error(`builds: no reproducible matrix legs in ${CI_FILE}`);
  const manifests = CRATE_DIRS.map((dir) => code(`contracts/${dir}/Cargo.toml`)).join(" and ");
  const metadata = code("[package.metadata.near.reproducible_build]");
  const passedEnv = reproducibleBuildList("passed_env");
  return [
    {
      id: "builds-cargo-near",
      cells: {
        item: "cargo-near",
        value: code(version),
        source: `The release URL in both cargo-near install steps of ${code(CI_FILE)}`,
      },
    },
    {
      id: "builds-cargo-near-archive",
      cells: {
        item: "cargo-near release archive",
        value: code(archive),
        source: `The same URL, in the release ${code(`cargo-near-v${version}`)}`,
      },
    },
    {
      id: "builds-cargo-near-sha256",
      cells: {
        item: "Archive sha256",
        value: code(sha256),
        source: `${code("CARGO_NEAR_SHA256")} in ${code(CI_FILE)}. ${code("sha256sum --check --strict")} stops the job on any other archive`,
      },
    },
    {
      id: "builds-image",
      cells: {
        item: "Docker image",
        value: code(reproducibleBuild("image")),
        source: `${code("image")} in ${metadata} of ${manifests}`,
      },
    },
    {
      id: "builds-image-digest",
      cells: {
        item: "Image digest",
        value: code(reproducibleBuild("image_digest")),
        source: `${code("image_digest")}, in the same place. Docker pulls the image by this digest`,
      },
    },
    {
      id: "builds-passed-env",
      cells: {
        item: "Environment passed in",
        value: passedEnv.length > 0 ? passedEnv.map(code).join(", ") : "None",
        source: `${code("passed_env")}, in the same place: the host environment variables the build container receives`,
      },
    },
    {
      id: "builds-container-command",
      cells: {
        item: "Build inside the image",
        value: code(reproducibleBuild("container_build_command")),
        source: `${code("container_build_command")}, in the same place`,
      },
    },
    {
      id: "builds-rust",
      cells: {
        item: "Rust",
        value: code(rust),
        source: `${code(TOOLCHAIN_FILE)}, and the ${code("toolchain")} of every Rust job in ${code(CI_FILE)}`,
      },
    },
    {
      id: "builds-command",
      cells: {
        item: "Build CI runs",
        value: legs.map(code).join(", "),
        source: `One leg per crate in the ${code("reproducible")} job of ${code(CI_FILE)}`,
      },
    },
  ];
}

/** One entry of contracts/code-hashes.json, as `scripts/code-hash.mjs record` writes it. */
interface RecordEntry {
  readonly crate: string;
  readonly version: string;
  readonly commit: string;
  readonly code_hash: string;
  readonly built_with: string;
  readonly recorded_at: string;
}

const ENTRY_KEYS = ["crate", "version", "commit", "code_hash", "built_with", "recorded_at"];

function recordEntries(): RecordEntry[] {
  const entries = (JSON.parse(read(RECORD_FILE)) as { entries?: unknown }).entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`builds: ${RECORD_FILE} has no entries`);
  }
  return entries.map((e, at) => {
    const rec = (e ?? {}) as Record<string, unknown>;
    for (const key of ENTRY_KEYS) {
      if (typeof rec[key] !== "string" || rec[key] === "") {
        throw new Error(`builds: entry ${at} of ${RECORD_FILE} has no ${key}`);
      }
    }
    return rec as unknown as RecordEntry;
  });
}

/** The parts of a deployment record that name a code hash. */
interface Deployment {
  readonly accounts?: Readonly<Record<string, string>>;
  readonly vault_v0?: { readonly account_id?: string; readonly code_hash?: string | null };
  readonly factory?: {
    readonly account_id?: string;
    readonly code_hash?: string | null;
    readonly versions?: readonly { index: number; code_hash: string; mode: string }[];
    readonly smoke_vaults?: readonly { account: string; version: number }[];
  };
  /** The public demo vault, made by the factory: the vault anyone can verify on its proof page. */
  readonly demo_vault?: { readonly account?: string; readonly code_hash?: string | null };
}

/** Where a recorded hash runs, by the committed deployment records (not the chain), or "None". */
function deployedAt(hash: string): string {
  const out: string[] = [];
  for (const { file, label } of DEPLOYMENT_FILES) {
    const d = JSON.parse(read(file)) as Deployment;
    const vault = d.vault_v0?.account_id ?? d.accounts?.vault_v0;
    const factory = d.factory?.account_id ?? d.accounts?.factory;
    if (vault && d.vault_v0?.code_hash === hash) out.push(`${label}: ${code(vault)}`);
    if (factory && d.factory?.code_hash === hash) {
      out.push(`${label}: the factory ${code(factory)}`);
    }
    for (const v of d.factory?.versions ?? []) {
      if (!factory || v.code_hash !== hash) continue;
      const smoke = (d.factory?.smoke_vaults ?? []).filter((s) => s.version === v.index);
      const smokeNames = smoke.map((s) => code(s.account)).join(", ");
      const also = smoke.length > 0 ? `, and its smoke vault ${smokeNames}` : "";
      out.push(`${label}: version ${v.index} (${v.mode}) of the factory ${code(factory)}${also}`);
    }
    const demo = d.demo_vault;
    if (demo?.account && demo.code_hash === hash) {
      out.push(`${label}: the demo vault ${code(demo.account)}`);
    }
  }
  return out.length > 0 ? out.join("; ") : "None";
}

const RECORD_COLUMNS: readonly RefColumn[] = [
  { key: "crate", label: "Crate" },
  { key: "code_hash", label: "Code hash" },
  { key: "commit", label: "Commit" },
  { key: "recorded", label: "Recorded" },
  { key: "deployed", label: "Deployed" },
  { key: "built_with", label: "Built with" },
];

/** One row per entry, in record order. The anchor is the crate's folder and the short commit. */
function recordRows(): RefRow[] {
  return recordEntries().map((e) => ({
    id: `builds-${e.crate.replace(/^probarion-/, "")}-${e.commit.slice(0, 7)}`,
    cells: {
      crate: `${code(e.crate)} ${e.version}`,
      code_hash: code(e.code_hash),
      commit: code(e.commit),
      recorded: e.recorded_at,
      deployed: deployedAt(e.code_hash),
      built_with: e.built_with
        .split(",")
        .map((part) => code(part.trim()))
        .join(", "),
    },
  }));
}

/** A table whose rows are read once, on first use. */
function lazyTable(table: Omit<RefTable, "rows">, rows: () => RefRow[]): RefTable {
  let cached: readonly RefRow[] | undefined;
  return {
    ...table,
    get rows() {
      cached ??= rows();
      return cached;
    },
  };
}

/** The builds tables of the docs reference. */
export const TABLES: readonly RefTable[] = [
  lazyTable(
    {
      id: "builds-toolchain",
      label: "What the reproducible build uses",
      columns: TOOLCHAIN_COLUMNS,
    },
    toolchainRows,
  ),
  lazyTable(
    { id: "builds-recorded", label: "Recorded reproducible builds", columns: RECORD_COLUMNS },
    recordRows,
  ),
];
