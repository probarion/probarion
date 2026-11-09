// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings quote shell and workflow source text
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_VAULT_CODE_HASHES } from "@probarion/core";
import { describe, expect, it } from "vitest";
import { TABLES } from "@/lib/docs/ref/builds";
import { type RefTable, ROW_ID } from "@/lib/docs/ref/types";
import { ROOT, readMdx } from "./docs-helpers";

// The reproducible-builds page (/docs/trust/reproducible-builds), pinned to CI and the record. This
// test reads .github/workflows/ci.yml, the crates' manifests, contracts/code-hashes.json and the
// deployment records on its own, so a recorded build, a cargo-near version, an archive sum or an
// image that changes in the code fails it until ref/builds.ts and the page follow.

const PAGE = "trust/reproducible-builds";
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const MDX = readMdx(PAGE);
const CI = read(".github/workflows/ci.yml");

interface Entry {
  crate: string;
  version: string;
  tree: string;
  workspace: string;
  lock: string;
  commit: string;
  code_hash: string;
  built_with: string;
  recorded_at: string;
}
const ENTRIES = (JSON.parse(read("contracts/code-hashes.json")) as { entries: Entry[] }).entries;
const NEWEST = ENTRIES.at(-1) as Entry;
/** The anchor the page gives an entry's row: the crate's folder and the short commit. */
const rowIdOf = (e: Entry) =>
  `builds-${e.crate.replace(/^probarion-/, "")}-${e.commit.slice(0, 7)}`;

function table(id: string): RefTable {
  const t = TABLES.find((x) => x.id === id);
  if (!t) throw new Error(`no table ${id}`);
  return t;
}

function cell(t: RefTable, rowId: string, key: string): string {
  const row = t.rows.find((r) => r.id === rowId);
  if (!row) throw new Error(`${t.id} has no row ${rowId}`);
  return row.cells[key] ?? "";
}

/** The parts of a Rich cell in backticks, in order. */
const codeParts = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");

// --- CI, read line by line -----------------------------------------------------------------------

const CI_LINES = CI.split(/\r?\n/);

/** The lines of one job of ci.yml, from its key to the next job's key. */
function jobLines(name: string): string[] {
  const start = CI_LINES.indexOf(`  ${name}:`);
  if (start < 0) throw new Error(`ci.yml has no job ${name}`);
  const end = CI_LINES.findIndex((l, at) => at > start && /^ {2}[\w-]+:\s*$/.test(l));
  return CI_LINES.slice(start, end < 0 ? undefined : end);
}

/** Every cargo-near download in ci.yml: the quoted URL on each curl line. */
const CARGO_NEAR_URLS = CI_LINES.filter((l) => l.includes("curl ") && l.includes("cargo-near"))
  .map((l) => l.split('"').find((part) => part.startsWith("https://")) ?? "")
  .filter(Boolean);
const INSTALL_STEPS = CI_LINES.filter((l) => /^\s*- name: Install cargo-near /.test(l));

const URL_PARTS =
  /^https:\/\/github\.com\/near\/cargo-near\/releases\/download\/cargo-near-v([^/]+)\/([^/]+)$/;
const CI_URL = CARGO_NEAR_URLS[0] ?? "";
const [, CI_VERSION = "", CI_ARCHIVE = ""] = URL_PARTS.exec(CI_URL) ?? [];
const CI_SHA256 =
  CI_LINES.find((l) => l.trim().startsWith("CARGO_NEAR_SHA256:"))
    ?.split(":")[1]
    ?.trim() ?? "";
const CI_RUST = [
  ...new Set(
    CI_LINES.filter((l) => l.trim().startsWith("toolchain:")).map((l) => l.split(":")[1]?.trim()),
  ),
];

/** The reproducible job's matrix legs: crate, dir and lib. */
const LEGS = jobLines("reproducible")
  .filter((l) => l.trim().startsWith("- { crate:"))
  .map((l) => {
    const fields: Record<string, string> = Object.fromEntries(
      l
        .replace(/^\s*- \{|\}\s*$/g, "")
        .split(",")
        .map((kv) => kv.split(":").map((s) => s.trim())),
    );
    return { crate: fields.crate ?? "", dir: fields.dir ?? "", lib: fields.lib ?? "" };
  });

// --- the crates' manifests -----------------------------------------------------------------------

/** The lines of contracts/<dir>/Cargo.toml's reproducible_build table, blanks and comments left out. */
function sectionLines(dir: string): string[] {
  const lines = read(`contracts/${dir}/Cargo.toml`).split(/\r?\n/);
  const start = lines.indexOf("[package.metadata.near.reproducible_build]");
  if (start < 0) throw new Error(`contracts/${dir}/Cargo.toml has no reproducible_build table`);
  const end = lines.findIndex((l, at) => at > start && l.startsWith("["));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

/** The keys of contracts/<dir>/Cargo.toml's reproducible_build table, in file order. */
const manifestKeys = (dir: string) => sectionLines(dir).map((l) => l.split("=")[0]?.trim() ?? "");

/** A key of that table: the quoted strings of its value, in order. */
function manifestStrings(dir: string, key: string): string[] {
  const line = sectionLines(dir).find((l) => l.startsWith(`${key} =`)) ?? "";
  return (line.slice(line.indexOf("=") + 1).match(/"[^"]*"/g) ?? []).map((q) => q.slice(1, -1));
}

/** A key of that table, its quoted strings joined with spaces. */
const manifestValue = (dir: string, key: string) => manifestStrings(dir, key).join(" ");

const IMAGE = manifestValue("vault", "image");
const DIGEST = manifestValue("vault", "image_digest");

describe("the toolchain table", () => {
  const t = table("builds-toolchain");

  it("has one row per item, and no other", () => {
    expect(t.rows.map((r) => r.id)).toEqual([
      "builds-cargo-near",
      "builds-cargo-near-archive",
      "builds-cargo-near-sha256",
      "builds-image",
      "builds-image-digest",
      "builds-passed-env",
      "builds-container-command",
      "builds-rust",
      "builds-command",
    ]);
    for (const r of t.rows) {
      for (const c of t.columns) expect(r.cells[c.key], `${r.id} ${c.key}`).toBeTruthy();
    }
  });

  it("shows every key of the crates' reproducible_build table, and both crates set the same", () => {
    // A new key changes what the build sees: this test, the table and the page must learn it.
    const keys = ["image", "image_digest", "passed_env", "container_build_command"];
    for (const dir of ["vault", "factory"]) {
      expect([...manifestKeys(dir)].sort(), dir).toEqual([...keys].sort());
      for (const key of keys) {
        expect(manifestStrings(dir, key), `${dir} ${key}`).toEqual(manifestStrings("vault", key));
      }
    }
    const env = manifestStrings("vault", "passed_env");
    const shown = env.length > 0 ? env.map((name) => `\`${name}\``).join(", ") : "None";
    expect(cell(t, "builds-passed-env", "value")).toBe(shown);
  });

  it("shows the cargo-near version, archive and sha256 that ci.yml installs", () => {
    // Both install steps download one URL, and sha256sum checks it against CARGO_NEAR_SHA256.
    expect(INSTALL_STEPS).toHaveLength(2);
    expect(CARGO_NEAR_URLS).toHaveLength(INSTALL_STEPS.length);
    expect(new Set(CARGO_NEAR_URLS).size).toBe(1);
    for (const step of INSTALL_STEPS) expect(step).toContain(`cargo-near ${CI_VERSION} `);
    expect(CI).toContain('echo "$CARGO_NEAR_SHA256  $archive" | sha256sum --check --strict -');
    expect(CI_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(cell(t, "builds-cargo-near", "value")).toBe(`\`${CI_VERSION}\``);
    expect(cell(t, "builds-cargo-near-archive", "value")).toBe(`\`${CI_ARCHIVE}\``);
    expect(cell(t, "builds-cargo-near-sha256", "value")).toBe(`\`${CI_SHA256}\``);
  });

  it("shows the image, digest and container command both crates pin, and the Rust version", () => {
    for (const key of ["image", "image_digest", "container_build_command"]) {
      expect(manifestValue("vault", key), key).not.toBe("");
      expect(manifestValue("factory", key), key).toBe(manifestValue("vault", key));
    }
    expect(DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(cell(t, "builds-image", "value")).toBe(`\`${IMAGE}\``);
    expect(cell(t, "builds-image-digest", "value")).toBe(`\`${DIGEST}\``);
    expect(cell(t, "builds-container-command", "value")).toBe(
      `\`${manifestValue("vault", "container_build_command")}\``,
    );
    const channel = /^channel = "([^"]+)"/m.exec(read("rust-toolchain.toml"))?.[1];
    expect(CI_RUST).toEqual([channel]);
    expect(cell(t, "builds-rust", "value")).toBe(`\`${channel}\``);
  });

  it("shows the build each leg of the reproducible job runs, one per contract", () => {
    expect(LEGS.map((l) => l.dir).sort()).toEqual(["factory", "vault"]);
    expect(jobLines("reproducible").join("\n")).toContain(
      "run: bash scripts/build-reproducible.sh ${{ matrix.dir }} ${{ matrix.lib }}",
    );
    expect(codeParts(cell(t, "builds-command", "value"))).toEqual(
      LEGS.map((l) => `bash scripts/build-reproducible.sh ${l.dir} ${l.lib}`),
    );
  });

  it("agrees with the newest recorded build and with the record's BUILT_WITH", () => {
    expect(NEWEST.built_with).toBe(`cargo-near ${CI_VERSION} reproducible-wasm, ${IMAGE}`);
    expect(IMAGE).toContain(`cargo-near:${CI_VERSION}-rust-${CI_RUST[0]}`);
    const builtWith = /^const BUILT_WITH = "([^"]+)";\r?$/m.exec(read("scripts/code-hash.mjs"));
    expect(builtWith?.[1]).toBe(NEWEST.built_with);
    // `record` appends, so the newest entry is the last one.
    expect(NEWEST.recorded_at).toBe(
      ENTRIES.map((e) => e.recorded_at)
        .sort()
        .at(-1),
    );
  });
});

// --- the record and the deployments --------------------------------------------------------------

/** Every object in the two deployment records whose code_hash is `hash`, by network and path. */
function hashSites(hash: string): { network: string; path: string }[] {
  const out: { network: string; path: string }[] = [];
  for (const network of ["testnet", "mainnet"]) {
    const walk = (node: unknown, path: string) => {
      if (Array.isArray(node)) {
        node.forEach((x, i) => {
          walk(x, `${path}[${i}]`);
        });
      } else if (typeof node === "object" && node !== null) {
        const rec = node as Record<string, unknown>;
        if (rec.code_hash === hash) out.push({ network, path });
        for (const [k, v] of Object.entries(rec)) walk(v, path ? `${path}.${k}` : k);
      }
    };
    walk(JSON.parse(read(`contracts/deployments/${network}.json`)), "");
  }
  return out;
}

interface DeploymentRecord {
  accounts?: Record<string, string>;
  vault_v0?: { account_id?: string };
  factory?: {
    account_id?: string;
    versions?: { index: number; mode: string }[];
    smoke_vaults?: { account: string; version: number }[];
  };
}
const RECORDS: Record<string, DeploymentRecord> = {
  testnet: JSON.parse(read("contracts/deployments/testnet.json")),
  mainnet: JSON.parse(read("contracts/deployments/mainnet.json")),
};
const LABELS: Record<string, string> = { testnet: "Testnet", mainnet: "Mainnet" };

/** The account a deployment record names for vault_v0 or factory; where it names two, they agree. */
function accountOf(network: string, key: "vault_v0" | "factory"): string {
  const record = RECORDS[network] ?? {};
  const own = record[key]?.account_id;
  const listed = record.accounts?.[key];
  if (own && listed && own !== listed)
    throw new Error(`${network}.json names ${own} and ${listed}`);
  const account = own ?? listed;
  if (!account) throw new Error(`${network}.json runs a recorded build at ${key} with no account`);
  return account;
}

/** The Deployed text for one place a hash appears, as the page writes it. */
function siteText(site: { network: string; path: string }): string {
  const label = LABELS[site.network] ?? site.network;
  if (site.path === "vault_v0") return `${label}: \`${accountOf(site.network, "vault_v0")}\``;
  const factory = `\`${accountOf(site.network, "factory")}\``;
  if (site.path === "factory") return `${label}: the factory ${factory}`;
  // A code hash anywhere else in a record is a deployment this test and the table must learn.
  const at = /^factory\.versions\[(\d+)\]$/.exec(site.path);
  if (!at) throw new Error(`a code hash at ${site.network} ${site.path}: teach the table`);
  const record = RECORDS[site.network]?.factory;
  const v = record?.versions?.[Number(at[1])];
  if (!v) throw new Error(`no ${site.path} in ${site.network}.json`);
  const smoke = (record?.smoke_vaults ?? [])
    .filter((s) => s.version === v.index)
    .map((s) => `\`${s.account}\``);
  const also = smoke.length > 0 ? `, and its smoke vault ${smoke.join(", ")}` : "";
  return `${label}: version ${v.index} (${v.mode}) of the factory ${factory}${also}`;
}

describe("the recorded builds table", () => {
  const t = table("builds-recorded");

  it("has one row per entry of contracts/code-hashes.json, in record order, and no other", () => {
    expect(ENTRIES.length).toBeGreaterThan(0);
    expect(t.rows).toHaveLength(ENTRIES.length);
    ENTRIES.forEach((e, at) => {
      const row = t.rows[at];
      expect(row?.id, `entry ${at}`).toBe(rowIdOf(e));
      expect(row?.id).toMatch(ROW_ID);
      expect(row?.cells.crate).toBe(`\`${e.crate}\` ${e.version}`);
      expect(row?.cells.code_hash).toBe(`\`${e.code_hash}\``);
      expect(row?.cells.commit).toBe(`\`${e.commit}\``);
      expect(row?.cells.recorded).toBe(e.recorded_at);
      expect(codeParts(row?.cells.built_with ?? "").join(", ")).toBe(e.built_with);
    });
  });

  it("names exactly where each build runs, from the deployment records, and None elsewhere", () => {
    for (const e of ENTRIES) {
      const deployed = cell(t, rowIdOf(e), "deployed");
      const expected = hashSites(e.code_hash).map(siteText);
      if (expected.length === 0) {
        expect(deployed, e.code_hash).toBe("None");
        continue;
      }
      // Each site once, and nothing else: no extra, missing or misnamed deployment.
      expect(deployed.split("; ").sort(), e.code_hash).toEqual([...expected].sort());
    }
  });

  it("holds the vault builds the verifier trusts, and only those", () => {
    const vaults = ENTRIES.filter((e) => e.crate === "probarion-vault").map((e) => e.code_hash);
    expect([...KNOWN_VAULT_CODE_HASHES]).toEqual([...new Set(vaults)]);
  });

  it("starts with two vault rows of one crate tree but two sources, as the page says", () => {
    // A source is the crate's tree with contracts/Cargo.toml and contracts/Cargo.lock
    // (findEntry in scripts/code-hash.mjs), so these two rows are two sources.
    const [a, b] = ENTRIES.filter((e) => e.crate === "probarion-vault");
    expect(a?.tree).toBe(b?.tree);
    expect(a?.workspace).not.toBe(b?.workspace);
    expect(a?.lock).not.toBe(b?.lock);
    expect(a?.commit).not.toBe(b?.commit);
    expect(a?.code_hash).not.toBe(b?.code_hash);
    expect(read("scripts/code-hash.mjs")).toMatch(
      /e\.tree === key\.tree &&\s+e\.workspace === key\.workspace &&\s+e\.lock === key\.lock,/,
    );
    expect(MDX).toContain(
      "The first two vault rows share the crate's source tree but not `contracts/Cargo.toml` or `contracts/Cargo.lock`, so the record counts them as two sources.",
    );
  });
});

// --- the page ------------------------------------------------------------------------------------

/** The lines of the page's bash fences, each trimmed. */
const BASH = [...MDX.matchAll(/```bash\r?\n([\s\S]*?)```/g)].flatMap((m) =>
  (m[1] ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean),
);

describe("the page", () => {
  it("shows both tables", () => {
    for (const t of TABLES) expect(MDX).toContain(`<RefTable id="${t.id}" />`);
  });

  it("is a how-to: what you need, the steps, then common mistakes and related pages last", () => {
    const h2 = MDX.split(/\r?\n/)
      .filter((l) => l.startsWith("## "))
      .map((l) => l.slice(3));
    expect(h2.slice(0, 2)).toEqual(["What you need", "Rebuild a recorded build"]);
    expect(h2.slice(-2)).toEqual(["Common mistakes", "Related pages"]);
    expect(MDX.match(/<Steps>/g)).toHaveLength(1);
  });

  it("says what CI builds and what record refuses as the scripts do", () => {
    // Without a recorded commit the leg builds the checkout's HEAD: a pull request's merge commit.
    expect(CI).toContain('is not recorded for this source: building HEAD"');
    expect(MDX).toContain(
      "the leg builds the checked-out commit (in a pull request, GitHub's temporary merge commit)",
    );
    // `record` reads the build info only: a push event and a run id, which guards against mistakes.
    const script = read("scripts/code-hash.mjs");
    expect(script).toContain('if (event !== "push") {');
    expect(script).toContain("if (!built.info.github_run_id) {");
    expect(script).toMatch(
      /this guards against a mistake[\s\S]{0,80}not against someone who writes/,
    );
    expect(MDX).toContain(
      "This guards against mistakes, not against a build info written by hand or a hand edit of `contracts/code-hashes.json`.",
    );
    // view_account's code_hash is the build's hash only for an account with its own code.
    expect(read("packages/sdk/src/rpc.ts")).toContain("global_contract_hash: string | null;");
    expect(MDX).toContain(
      "for an account that deploys the build as its own code, and what step 4 prints. An account on a global contract reports it as `global_contract_hash` instead.",
    );
  });

  it("names only the versions, image, sums, commits and hashes CI and the record use", () => {
    for (const m of MDX.matchAll(/cargo-near[ -]v?(\d+\.\d+\.\d+)/g)) {
      expect(m[1]).toBe(CI_VERSION);
    }
    for (const m of MDX.matchAll(/sourcescan\/cargo-near:[\w.-]+/g)) expect(m[0]).toBe(IMAGE);
    for (const m of MDX.matchAll(/\b[0-9a-f]{64}\b/g)) {
      expect([CI_SHA256, DIGEST.replace(/^sha256:/, "")]).toContain(m[0]);
    }
    const commits = ENTRIES.map((e) => e.commit);
    for (const m of MDX.matchAll(/\b[0-9a-f]{40}\b/g)) expect(commits).toContain(m[0]);
    const hashes = ENTRIES.map((e) => e.code_hash);
    for (const m of MDX.matchAll(/\b[1-9A-HJ-NP-Za-km-z]{43,44}\b/g)) {
      expect(hashes).toContain(m[0]);
    }
    expect(MDX).toContain("on every pull request into `dev` or `main`");
    expect(CI).toMatch(/^ {2}pull_request:\r?\n {4}branches: \[main, dev\]/m);
  });

  it("downloads the archive CI downloads", () => {
    const curl = BASH.filter((l) => l.startsWith("curl "));
    expect(curl).toHaveLength(1);
    expect(curl[0]).toContain(` -o cargo-near.tar.gz ${CI_URL}`);
  });

  it("rebuilds, checks and prints one recorded entry the way the scripts do", () => {
    const checkout = BASH.find((l) => l.includes(" checkout --quiet --detach "));
    const entry = ENTRIES.find((e) => e.commit === checkout?.split(" ").at(-1));
    expect(entry, "the example commit is recorded").toBeDefined();
    const leg = LEGS.find((l) => l.crate === entry?.crate);
    expect(leg, "the example crate has a CI leg").toBeDefined();
    const out = `../probarion-recorded/contracts/target/reproducible/${leg?.dir}`;
    expect(BASH).toContain(`bash scripts/build-reproducible.sh ${leg?.dir} ${leg?.lib}`);
    expect(BASH).toContain(
      `node scripts/code-hash.mjs check ${leg?.crate} ${leg?.dir} ${out}/${leg?.lib}.wasm`,
    );
    // The expected output is the line `check` logs on a match, for that entry.
    const logged =
      "${crate}: code_hash ${built.hash} matches the recorded build (commit ${built.commit})";
    expect(read("scripts/code-hash.mjs")).toContain(`c.log(\`${logged}\`);`);
    const printed = `${entry?.crate}: code_hash ${entry?.code_hash} matches the recorded build`;
    expect(MDX).toContain(`${printed} (commit ${entry?.commit})`);
    // SRC_DIR is the checkout the script builds, and it writes the wasm where check reads it.
    const script = read("scripts/build-reproducible.sh");
    expect(script).toContain('cd "${SRC_DIR:-$here/..}"');
    expect(script).toContain('out="contracts/target/reproducible/$dir"');
    expect(script).toContain('cp "$p" "$out/$lib.wasm"');
    expect(BASH).toContain("export SRC_DIR=../probarion-recorded");
  });

  it("quotes the script's refusal, and reads the chain with a real helper and account", () => {
    const refusal = "commit contracts/ first: the reproducible build uses the committed source";
    expect(MDX).toContain(`\`${refusal}\``);
    expect(read("scripts/build-reproducible.sh")).toContain(refusal);
    const chain = read("scripts/testnet/chain.mjs");
    expect(chain).toContain('case "code-hash":');
    expect(chain).toContain("return { out: account.code_hash, code: 0 };");
    const testnet = read("contracts/deployments/testnet.json");
    const reads = BASH.filter((l) => l.startsWith("node scripts/testnet/chain.mjs code-hash "));
    expect(reads.length).toBeGreaterThan(0);
    for (const l of reads) expect(testnet).toContain(`"${l.split(" ").at(-1)}"`);
    for (const f of ["scripts/build-reproducible.sh", "scripts/code-hash.mjs"]) {
      expect(existsSync(join(ROOT, f)), f).toBe(true);
    }
  });
});
