// Tests for the lines scripts/check-claims.mjs shows while it runs: one when it has listed the files,
// then one each 500 files read, all on stderr, so that stdout stays the problems and the summary line.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkClaims } from "./check-claims.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-claims.mjs");
const START = "the first run on a fresh Windows clone can take a few minutes";
let root;

before(() => {
  root = mkdtempSync(join(tmpdir(), "check-claims-progress-"));
  writeFileSync(join(root, "README.md"), "# Demo\n\nHello.\n");
});
after(() => rmSync(root, { recursive: true, force: true }));

test("says how many files it lists before it reads them, then counts every 500 files read", async () => {
  // 1,000 evidence notes in memory: the link check reads each one, and README.md makes 1,001.
  const overrides = {};
  for (let i = 0; i < 1000; i++) overrides[`docs/evidence/note-${i}.md`] = `# Note ${i}\n`;
  const lines = [];
  await checkClaims({ root, overrides, progress: (line) => lines.push(line) });
  assert.deepEqual(lines, [
    `reading up to 1001 files; ${START}`,
    "500 files read",
    "1000 files read",
  ]);
});

test("without a progress function it prints nothing of its own", async () => {
  const error = console.error;
  const log = console.log;
  const printed = [];
  console.error = (s) => printed.push(String(s));
  console.log = (s) => printed.push(String(s));
  try {
    await checkClaims({ root });
  } finally {
    console.error = error;
    console.log = log;
  }
  assert.deepEqual(printed, []);
});

test("the script prints the start line first, on stderr, and stdout keeps only the report", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });
  const err = r.stderr.split("\n").filter(Boolean);
  const out = r.stdout.split("\n").filter(Boolean);
  assert.equal(err[0], `check-claims: reading up to 1 files; ${START}`, r.stderr);
  assert.equal(err.length, 1, r.stderr);
  // The fixture has no Status section, so the report is that one problem and the summary line.
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(out[0], /^README\.md:1 \[status\] /);
  assert.match(out.at(-1), /^check-claims: 1 claim\(s\) do not match /);
  assert.ok(!out.some((l) => l.includes(START)));
});
