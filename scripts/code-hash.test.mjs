import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  base58,
  buildInfo,
  checkBuild,
  codeHash,
  findEntry,
  main,
  packageField,
  planRecord,
} from "./code-hash.mjs";

// --- the three tests from the plan, verbatim ---

test("base58 matches the reference vectors", () => {
  assert.equal(base58(new TextEncoder().encode("Hello World!")), "2NEpo7TZRRrLZSi2U");
  assert.equal(base58(Uint8Array.from([0x00, 0x00, 0x28, 0x7f, 0xb4, 0xcd])), "11233QC4");
  assert.equal(base58(new Uint8Array(32)), "1".repeat(32));
  assert.equal(base58(new Uint8Array(0)), "");
});

test("codeHash is base58 of sha256, the format NEAR RPC uses for code_hash", () => {
  const sha256OfEmpty = Buffer.from(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "hex",
  );
  assert.equal(codeHash(new Uint8Array(0)), base58(sha256OfEmpty));
});

test("findEntry needs the crate and all three source keys to match", () => {
  const key = { tree: "t1", workspace: "w1", lock: "l1" };
  const entries = [{ crate: "probarion-vault", ...key, code_hash: "H" }];
  assert.equal(findEntry(entries, "probarion-vault", key)?.code_hash, "H");
  assert.equal(findEntry(entries, "probarion-vault", { ...key, lock: "l2" }), null);
  assert.equal(findEntry(entries, "probarion-factory", key), null);
});

// --- the commit-aware record and check (the wasm embeds the commit it was built from) ---

test("packageField reads the [package] table and ignores dependency tables", () => {
  const toml = [
    "[package]",
    'name = "probarion-vault"',
    'version = "0.1.0"',
    "",
    "[dependencies.other]",
    'version = "9.9.9"',
    "",
  ].join("\n");
  assert.equal(packageField(toml, "name"), "probarion-vault");
  assert.equal(packageField(toml, "version"), "0.1.0");
  assert.equal(packageField('[dependencies.other]\nversion = "9.9.9"\n', "version"), undefined);
});

const key = { tree: "t1", workspace: "w1", lock: "l1" };
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const recorded = { crate: "probarion-vault", ...key, commit: C1, code_hash: "H1" };

test("planRecord adds an unrecorded source and is idempotent for the same build", () => {
  assert.equal(planRecord([], "probarion-vault", { hash: "H1", commit: C1, key }).action, "add");
  assert.equal(
    planRecord([recorded], "probarion-vault", { hash: "H1", commit: C1, key }).action,
    "noop",
  );
});

test("planRecord flags a different hash for the same commit as a reproducibility failure", () => {
  const plan = planRecord([recorded], "probarion-vault", { hash: "H9", commit: C1, key });
  assert.equal(plan.action, "conflict");
});

test("planRecord refuses a second build of an already recorded source", () => {
  const plan = planRecord([recorded], "probarion-vault", { hash: "H2", commit: C2, key });
  assert.equal(plan.action, "other-commit");
  assert.equal(plan.entry.commit, C1);
});

test("checkBuild compares hashes only for the recorded commit", () => {
  const at = (hash, commit, k = key) =>
    checkBuild([recorded], "probarion-vault", { hash, commit, key: k });
  assert.equal(at("H1", C1).status, "match");
  assert.equal(at("H9", C1).status, "mismatch");
  // Same source at a later commit: the wasm embeds the commit, so its hash differs by design.
  assert.equal(at("H2", C2).status, "other-commit");
  assert.equal(at("H1", C1, { ...key, lock: "l2" }).status, "unrecorded");
});

// --- the whole flow against a throwaway git repository and a fake "wasm" ---

function git(repo, ...args) {
  return execFileSync(
    "git",
    [
      "-C",
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { encoding: "utf8" },
  ).trim();
}

function put(repo, rel, text) {
  const path = join(repo, ...rel.split("/"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "code-hash-"));
  git(repo, "init", "-q");
  git(repo, "config", "core.autocrlf", "false");
  put(
    repo,
    "contracts/vault/Cargo.toml",
    '[package]\nname = "probarion-vault"\nversion = "0.1.0"\n',
  );
  put(repo, "contracts/vault/src/lib.rs", "// v1\n");
  put(repo, "contracts/Cargo.toml", "[workspace]\n");
  put(repo, "contracts/Cargo.lock", "# lock 1\n");
  put(repo, "contracts/code-hashes.json", '{\n  "entries": []\n}\n');
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "c1");
  return { repo, db: join(repo, "contracts", "code-hashes.json") };
}

function commitAll(repo, msg) {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", msg);
  return git(repo, "rev-parse", "HEAD");
}

/** What build-reproducible.sh leaves behind: the wasm and its build-info, built at the repo's HEAD. */
function fakeBuild(repo, bytes, env = {}) {
  const out = mkdtempSync(join(tmpdir(), "code-hash-out-"));
  const wasm = join(out, "probarion_vault.wasm");
  writeFileSync(wasm, bytes);
  const info = buildInfo(repo, "vault", bytes, env);
  writeFileSync(join(out, "probarion_vault.build-info.json"), `${JSON.stringify(info, null, 2)}\n`);
  return { wasm, info, out };
}

function run(f, argv, env = {}) {
  const lines = [];
  const log = (s) => lines.push(String(s));
  const code = main(argv, { repo: f.repo, db: f.db, cwd: f.repo, env, log, err: log });
  return { code, text: lines.join("\n") };
}

function entriesOf(f) {
  return JSON.parse(readFileSync(f.db, "utf8")).entries;
}

test("buildInfo describes the commit that was built and the NEAR code_hash of the bytes", () => {
  const f = fixture();
  try {
    const bytes = Buffer.from("fake wasm one");
    const info = buildInfo(f.repo, "vault", bytes, {
      GITHUB_EVENT_NAME: "push",
      GITHUB_RUN_ID: "42",
    });
    assert.equal(info.crate, "probarion-vault");
    assert.equal(info.dir, "vault");
    assert.equal(info.commit, git(f.repo, "rev-parse", "HEAD"));
    assert.equal(info.code_hash, codeHash(bytes));
    assert.equal(info.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(info.bytes, bytes.length);
    assert.equal(info.github_event, "push");
    assert.equal(info.github_run_id, "42");
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
  }
});

test("record then check: the recorded commit reproduces, a later commit is refused, a changed source is unrecorded", () => {
  const f = fixture();
  try {
    const build1 = fakeBuild(f.repo, Buffer.from("wasm built at c1"));
    const c1 = build1.info.commit;

    // bootstrapping: nothing recorded yet. Non-tag runs pass; v* tags (REQUIRE_RECORDED) fail.
    assert.equal(run(f, ["check", "probarion-vault", "vault", build1.wasm]).code, 0);
    assert.equal(
      run(f, ["check", "probarion-vault", "vault", build1.wasm], { REQUIRE_RECORDED: "1" }).code,
      1,
    );
    assert.equal(run(f, ["recorded-commit", "probarion-vault", "vault"]).text, "");

    // record from the artifact
    const rec = run(f, ["record", "probarion-vault", "vault", build1.wasm]);
    assert.equal(rec.code, 0, rec.text);
    const [entry] = entriesOf(f);
    assert.equal(entry.crate, "probarion-vault");
    assert.equal(entry.version, "0.1.0");
    assert.equal(entry.commit, c1);
    assert.equal(entry.code_hash, build1.info.code_hash);
    assert.equal(entry.tree, git(f.repo, "rev-parse", `${c1}:contracts/vault`));
    assert.match(entry.recorded_at, /^\d{4}-\d{2}-\d{2}$/);

    // recording again is a no-op
    assert.equal(run(f, ["record", "probarion-vault", "vault", build1.wasm]).code, 0);
    assert.equal(entriesOf(f).length, 1);

    // the record commit itself changes contracts/code-hashes.json only: same source, new commit
    const c2 = commitAll(f.repo, "chore: record");
    assert.notEqual(c1, c2);
    assert.equal(run(f, ["recorded-commit", "probarion-vault", "vault"]).text, c1);

    // rebuilding the recorded commit reproduces the recorded hash (same bytes)
    assert.equal(run(f, ["check", "probarion-vault", "vault", build1.wasm]).code, 0);

    // the same build with different bytes under the recorded commit is a mismatch
    const bad = fakeBuild(f.repo, Buffer.from("tampered"));
    writeFileSync(
      join(bad.out, "probarion_vault.build-info.json"),
      `${JSON.stringify({ ...bad.info, commit: c1 }, null, 2)}\n`,
    );
    const mismatch = run(f, ["check", "probarion-vault", "vault", bad.wasm]);
    assert.equal(mismatch.code, 1);
    assert.match(mismatch.text, /mismatch/);

    // a wasm built at the later commit cannot be compared with the hash recorded for c1
    const build2 = fakeBuild(f.repo, Buffer.from("wasm built at c2"));
    const other = run(f, ["check", "probarion-vault", "vault", build2.wasm]);
    assert.equal(other.code, 1);
    assert.match(other.text, /recorded at/);

    // changing Cargo.lock makes the record stale: unrecorded again, and v* tags fail
    put(f.repo, "contracts/Cargo.lock", "# lock 2\n");
    commitAll(f.repo, "chore: bump lock");
    assert.equal(run(f, ["recorded-commit", "probarion-vault", "vault"]).text, "");
    const build3 = fakeBuild(f.repo, Buffer.from("wasm built at c3"));
    assert.equal(run(f, ["check", "probarion-vault", "vault", build3.wasm]).code, 0);
    assert.equal(
      run(f, ["check", "probarion-vault", "vault", build3.wasm], { REQUIRE_RECORDED: "1" }).code,
      1,
    );
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
  }
});

test("record refuses a wasm that does not match its build-info, and pull_request builds", () => {
  const f = fixture();
  try {
    const build = fakeBuild(f.repo, Buffer.from("wasm"));
    writeFileSync(build.wasm, "swapped after the build");
    const swapped = run(f, ["record", "probarion-vault", "vault", build.wasm]);
    assert.equal(swapped.code, 1);
    assert.match(swapped.text, /build-info/);

    const pr = fakeBuild(f.repo, Buffer.from("pr wasm"), { GITHUB_EVENT_NAME: "pull_request" });
    const refused = run(f, ["record", "probarion-vault", "vault", pr.wasm]);
    assert.equal(refused.code, 1);
    assert.match(refused.text, /pull_request/);
    assert.equal(entriesOf(f).length, 0);
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
  }
});

test("record refuses a different hash for an already recorded commit", () => {
  const f = fixture();
  try {
    const a = fakeBuild(f.repo, Buffer.from("first"));
    assert.equal(run(f, ["record", "probarion-vault", "vault", a.wasm]).code, 0);
    const b = fakeBuild(f.repo, Buffer.from("second"));
    const conflict = run(f, ["record", "probarion-vault", "vault", b.wasm]);
    assert.equal(conflict.code, 1);
    assert.match(conflict.text, /not reproducible/);
    assert.equal(entriesOf(f).length, 1);
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
  }
});

test("main prints the code hash of a file and rejects bad usage", () => {
  const f = fixture();
  try {
    const { wasm, info } = fakeBuild(f.repo, Buffer.from("abc"));
    assert.equal(run(f, ["hash", wasm]).text, info.code_hash);
    assert.equal(run(f, []).code, 2);
    assert.equal(run(f, ["record", "probarion-vault"]).code, 2);
  } finally {
    rmSync(f.repo, { recursive: true, force: true });
  }
});
