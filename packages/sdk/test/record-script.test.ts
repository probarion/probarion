import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The recording script is run by the OWNER with a real NEARAI_API_KEY and never in CI. These checks read its
// source so that a later edit cannot start printing or storing the key, or bypass the env helper (R12).
const source = readFileSync(new URL("../scripts/record-nearai.ts", import.meta.url), "utf8");
const lines = source.split("\n");

describe("scripts/record-nearai.ts (OWNER-run, never executed by the tests)", () => {
  it("reads the key through envValue, so an empty NEARAI_API_KEY counts as unset (R12)", () => {
    expect(source).toContain('envValue(process.env, "NEARAI_API_KEY")');
    expect(source).not.toMatch(/process\.env\.NEARAI_API_KEY|process\.env\["NEARAI_API_KEY"\]/);
    expect(source).toContain('envValue(process.env, "NEARAI_MODEL")');
  });

  it("uses the key only as the Authorization header, in the proposer options, in the redactor and in the do-not-write guard", () => {
    const uses = lines.filter((line) => /\bapiKey\b/.test(line)).map((line) => line.trim());
    const allowed = [
      /^const apiKey = envValue\(process\.env, "NEARAI_API_KEY"\);$/,
      /^if \(apiKey === undefined\) \{$/,
      /authorization: `Bearer \$\{apiKey\}`/,
      /^const proposer = new NearAiProposer\(\{ apiKey,/,
      /^if \(recordedJson\.includes\(apiKey\)\) \{$/,
      /^const clean = \(text: string\): string => redactSecrets\(text, \[apiKey\]\);$/,
    ];
    for (const use of uses) {
      expect(
        allowed.some((pattern) => pattern.test(use)),
        `unexpected use of the API key: ${use}`,
      ).toBe(true);
    }
    expect(uses.length).toBeGreaterThanOrEqual(allowed.length);
  });

  it("never prints the key and refuses to write a recording that contains it", () => {
    for (const line of lines.filter((l) => /\bapiKey\b/.test(l))) {
      expect(line).not.toMatch(/stdout|stderr|console|writeFile|JSON\.stringify/);
    }
    expect(source).toContain("refusing to write it");
  });

  it("prints everything through the redactor, except the one message that is printed before a key exists", () => {
    const writes = source.match(/process\.(?:stdout|stderr)\.write\(/g) ?? [];
    const cleaned = source.match(/process\.(?:stdout|stderr)\.write\(\s*clean\(/g) ?? [];
    expect(writes.length).toBeGreaterThanOrEqual(3);
    expect(cleaned.length).toBe(writes.length - 1);
    expect(source).toContain("NEARAI_API_KEY is not set. This script is run by the OWNER only.");
    expect(source).not.toMatch(/console\./);
  });

  it("prints what it recorded and writes the fixture the recorded test reads", () => {
    expect(source).toMatch(/recorded \$\{evidence\.model\} chat \$\{evidence\.chat_id\}/);
    expect(source).toContain("../test/fixtures/nearai-recorded/decision.json");
    expect(source).toContain("checkRequestBinding(evidence, invoiceText, context)");
    expect(source).toContain("PROVIDER_TEE_TEXT_FORMAT");
  });

  it("asks for the signature the way the adapter does, with the model", () => {
    expect(source).toContain('url.searchParams.set("model", model)');
  });
});
