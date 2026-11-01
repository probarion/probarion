#!/usr/bin/env node
// NEAR code hashes (base58 of the sha256 of the wasm) and the record in contracts/code-hashes.json.
//
//   node scripts/code-hash.mjs hash <wasm>
//   node scripts/code-hash.mjs info <dir> <wasm>              build-info JSON for the checkout in the cwd
//   node scripts/code-hash.mjs record <crate> <dir> <wasm>    the CI artifact of a push run; commit the JSON
//   node scripts/code-hash.mjs check <crate> <dir> <wasm>     CI; REQUIRE_RECORDED=1 on release tags
//   node scripts/code-hash.mjs recorded-commit <crate> <dir>  the commit recorded for the current source
//
// Hashes come only from the CI `reproducible` job (Docker, ubuntu). A wasm from a local build
// (Windows, `--no-abi`) is never a source of hashes.
//
// A cargo-near reproducible build embeds the git commit it was built from (NEP-330
// `source_code_snapshot`) in the wasm. So the same source tree built at two commits has two code
// hashes, and a recorded hash can only be reproduced by rebuilding the RECORDED COMMIT. Each entry
// therefore stores `commit` next to the source keys (git tree of the crate, contracts/Cargo.toml,
// contracts/Cargo.lock). The keys tell whether the current source is the recorded one; the commit
// is what CI rebuilds and compares.
//
// `scripts/build-reproducible.sh` writes `<lib>.build-info.json` beside the wasm, and the CI job
// uploads both as the artifact `<crate>-wasm` (`probarion-vault-wasm`, `probarion-factory-wasm`).
// `record` and `check` read that file to learn the commit, so they work on a downloaded artifact
// whatever commit is checked out locally.
//
// R9: any change to contracts/vault or contracts/factory (or to contracts/Cargo.toml or
// contracts/Cargo.lock, which both crates share) makes that crate's record stale. Re-record right
// after the push that changes them: take the artifact of that push run
// (never a pull_request run), run `record`, commit contracts/code-hashes.json. `record` refuses a wasm
// without its CI build-info (event `push`, a run id): a local build is never a source of hashes (R6). Until then CI warns
// "not recorded" and a `v*` tag fails. Never deploy a wasm whose hash is not in the record.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const REPO = fileURLToPath(new URL("..", import.meta.url));
const DB = fileURLToPath(new URL("../contracts/code-hashes.json", import.meta.url));
const BUILT_WITH = "cargo-near 0.22.0 reproducible-wasm, sourcescan/cargo-near:0.22.0-rust-1.99.1";
const COMMIT = /^[0-9a-f]{40}$/;
const DIR = /^[a-z0-9][a-z0-9_-]*$/;
const USAGE =
  "usage: code-hash.mjs hash <wasm> | info <dir> <wasm> | record <crate> <dir> <wasm> | check <crate> <dir> <wasm> | recorded-commit <crate> <dir>";

export function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export function codeHash(wasm) {
  return base58(createHash("sha256").update(wasm).digest());
}

export function findEntry(entries, crate, key) {
  return (
    entries.find(
      (e) =>
        e.crate === crate &&
        e.tree === key.tree &&
        e.workspace === key.workspace &&
        e.lock === key.lock,
    ) ?? null
  );
}

/** What `record` does with a build `{ hash, commit, key }`: add, noop, conflict or other-commit. */
export function planRecord(entries, crate, built) {
  const entry = findEntry(entries, crate, built.key);
  if (!entry) return { action: "add" };
  if (entry.commit !== built.commit) return { action: "other-commit", entry };
  return { action: entry.code_hash === built.hash ? "noop" : "conflict", entry };
}

/** What `check` concludes for a build: match, mismatch, other-commit or unrecorded. */
export function checkBuild(entries, crate, built) {
  const entry = findEntry(entries, crate, built.key);
  if (!entry) return { status: "unrecorded" };
  if (entry.commit !== built.commit) return { status: "other-commit", entry };
  return { status: entry.code_hash === built.hash ? "match" : "mismatch", entry };
}

/** A string field of the [package] table (not of a dependency table). */
export function packageField(toml, field) {
  const section = /^\[package\]\r?\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(toml)?.[1] ?? "";
  return new RegExp(`^${field}\\s*=\\s*"([^"]+)"`, "m").exec(section)?.[1];
}

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Git object ids of everything that determines the build of contracts/<dir> at a commit. */
function sourceKey(repo, dir, commit) {
  return {
    tree: git(repo, "rev-parse", `${commit}:contracts/${dir}`),
    workspace: git(repo, "rev-parse", `${commit}:contracts/Cargo.toml`),
    lock: git(repo, "rev-parse", `${commit}:contracts/Cargo.lock`),
  };
}

function manifestAt(repo, commit, dir) {
  return git(repo, "show", `${commit}:contracts/${dir}/Cargo.toml`);
}

function assertDir(dir) {
  if (!DIR.test(dir ?? "")) throw new Error(`bad crate directory name: ${dir}`);
}

/** The build-info that build-reproducible.sh writes beside the wasm: what was built, and from where. */
export function buildInfo(repo, dir, wasm, env = process.env) {
  assertDir(dir);
  const commit = git(repo, "rev-parse", "HEAD");
  return {
    crate: packageField(manifestAt(repo, commit, dir), "name"),
    dir,
    commit,
    ...sourceKey(repo, dir, commit),
    code_hash: codeHash(wasm),
    sha256: createHash("sha256").update(wasm).digest("hex"),
    bytes: wasm.length,
    github_event: env.GITHUB_EVENT_NAME ?? null,
    github_run_id: env.GITHUB_RUN_ID ?? null,
  };
}

function sidecarPath(wasmPath) {
  return `${wasmPath.replace(/\.wasm$/, "")}.build-info.json`;
}

/**
 * The hash, build commit and source keys of a wasm, from its build-info. Without a build-info,
 * `check` assumes the wasm was built at HEAD; `record` (requireSidecar) refuses, because a wasm with
 * no CI build-info is a local build, and a local build is never a source of hashes (R6).
 */
function builtFrom(repo, crate, dir, wasmPath, log, { requireSidecar = false } = {}) {
  const hash = codeHash(readFileSync(wasmPath));
  const sidecar = sidecarPath(wasmPath);
  let info = null;
  let commit;
  if (existsSync(sidecar)) {
    info = JSON.parse(readFileSync(sidecar, "utf8"));
    if (info.crate !== crate || info.dir !== dir) {
      throw new Error(`${sidecar} describes ${info.crate} (${info.dir}), not ${crate} (${dir})`);
    }
    if (info.code_hash !== hash) {
      throw new Error(
        `${wasmPath} does not match its build-info: the file hashes to ${hash}, the build-info says ${info.code_hash}`,
      );
    }
    if (!COMMIT.test(info.commit ?? "")) throw new Error(`${sidecar} has no valid commit`);
    commit = info.commit;
  } else {
    if (requireSidecar) {
      throw new Error(
        `no ${sidecar}: record takes only the CI artifact (the wasm with its build-info.json) of a push run; a local build is never a source of hashes`,
      );
    }
    commit = git(repo, "rev-parse", "HEAD");
    log(`no ${sidecar}: assuming the wasm was built at HEAD (${commit})`);
  }
  try {
    git(repo, "cat-file", "-e", `${commit}^{commit}`);
  } catch {
    throw new Error(`commit ${commit} is not in this clone; run git fetch first`);
  }
  return { hash, commit, key: sourceKey(repo, dir, commit), info };
}

function readDb(path) {
  const db = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(db.entries)) throw new Error(`${path} has no "entries" array`);
  return db;
}

function run(cmd, rest, c) {
  if (cmd === "hash" && rest.length === 1) {
    c.log(codeHash(readFileSync(rest[0])));
    return 0;
  }
  if (cmd === "info" && rest.length === 2) {
    const [dir, wasmPath] = rest;
    c.log(JSON.stringify(buildInfo(c.cwd, dir, readFileSync(wasmPath), c.env), null, 2));
    return 0;
  }
  if (cmd === "recorded-commit" && rest.length === 2) {
    const [crate, dir] = rest;
    assertDir(dir);
    const head = git(c.repo, "rev-parse", "HEAD");
    const entry = findEntry(readDb(c.db).entries, crate, sourceKey(c.repo, dir, head));
    if (entry) {
      if (!COMMIT.test(entry.commit ?? "")) {
        throw new Error(
          `${crate} is recorded in ${c.db} with no valid commit${entry.commit ? ` (found "${entry.commit}")` : ""}; record it again from a CI push artifact`,
        );
      }
      c.log(entry.commit);
    }
    return 0;
  }
  if ((cmd === "record" || cmd === "check") && rest.length === 3) {
    const [crate, dir, wasmPath] = rest;
    assertDir(dir);
    const built = builtFrom(c.repo, crate, dir, wasmPath, c.log, {
      requireSidecar: cmd === "record",
    });
    const db = readDb(c.db);
    if (cmd === "record") return record(c, db, crate, dir, built);
    return check(c, db, crate, built);
  }
  c.err(USAGE);
  return 2;
}

function record(c, db, crate, dir, built) {
  // The build-info comes from CI, so this guards against a mistake (a local or pull_request build),
  // not against someone who writes a build-info by hand. The next CI run rebuilds the recorded
  // commit, so a wrong record fails loudly.
  const event = built.info?.github_event ?? null;
  if (event !== "push") {
    c.err(
      `::error::${crate}: refusing to record a build whose github_event is ${event}: only the artifact of a CI push run is a source of hashes (a pull_request commit is a temporary merge commit that will not exist after the merge)`,
    );
    return 1;
  }
  if (!built.info.github_run_id) {
    c.err(`::error::${crate}: refusing to record a build-info with no GitHub run id`);
    return 1;
  }
  const plan = planRecord(db.entries, crate, built);
  if (plan.action === "conflict") {
    c.err(
      `::error::${crate}: commit ${built.commit} is recorded as ${plan.entry.code_hash} but this build is ${built.hash}: the build is not reproducible`,
    );
    return 1;
  }
  if (plan.action === "other-commit") {
    c.err(
      `::error::${crate}: this source is already recorded at ${plan.entry.commit} (${plan.entry.code_hash}). The wasm embeds its build commit, so a build at ${built.commit} has another code_hash by design. Deploy the recorded build, or change the source and record the new one.`,
    );
    return 1;
  }
  if (plan.action === "add") {
    db.entries.push({
      crate,
      version: packageField(manifestAt(c.repo, built.commit, dir), "version") ?? "unknown",
      ...built.key,
      commit: built.commit,
      code_hash: built.hash,
      built_with: BUILT_WITH,
      recorded_at: new Date().toISOString().slice(0, 10),
    });
    writeFileSync(c.db, `${JSON.stringify(db, null, 2)}\n`);
    c.log(`${crate} ${built.hash} recorded (built at ${built.commit})`);
    return 0;
  }
  c.log(`${crate} ${built.hash} is already recorded (built at ${built.commit})`);
  return 0;
}

function check(c, db, crate, built) {
  const verdict = checkBuild(db.entries, crate, built);
  if (verdict.status === "unrecorded") {
    if (c.env.REQUIRE_RECORDED === "1") {
      c.err(
        `::error::${crate}: this source is not recorded in contracts/code-hashes.json (built at ${built.commit}, code_hash ${built.hash}); record it before tagging`,
      );
      return 1;
    }
    c.log(
      `::warning::${crate}: this source is not recorded in contracts/code-hashes.json yet; built at ${built.commit}, code_hash ${built.hash}. Record it from this run's artifact (R9).`,
    );
    return 0;
  }
  if (verdict.status === "other-commit") {
    c.err(
      `::error::${crate}: this source is recorded at ${verdict.entry.commit}, but this wasm was built at ${built.commit}. The wasm embeds its build commit, so it cannot be compared; rebuild ${verdict.entry.commit}.`,
    );
    return 1;
  }
  if (verdict.status === "mismatch") {
    c.err(
      `::error::${crate}: code_hash mismatch at ${built.commit}: recorded ${verdict.entry.code_hash}, built ${built.hash}`,
    );
    return 1;
  }
  c.log(`${crate}: code_hash ${built.hash} matches the recorded build (commit ${built.commit})`);
  return 0;
}

/** `ctx` overrides the repo, database, cwd, env and loggers; the tests use it. */
export function main([cmd, ...rest] = [], ctx = {}) {
  const c = {
    repo: REPO,
    db: DB,
    cwd: process.cwd(),
    env: process.env,
    log: console.log,
    err: console.error,
    ...ctx,
  };
  try {
    return run(cmd, rest, c);
  } catch (e) {
    c.err(`code-hash: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
