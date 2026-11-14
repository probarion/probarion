import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The package runs in Node and in a browser: nothing under src may import a Node built-in or reach for Node's
// globals. Tests, scripts and examples may.
const SRC = new URL("../src/", import.meta.url);

function sourceFiles(dir: URL, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      files.push(...sourceFiles(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`));
    } else if (entry.name.endsWith(".ts")) {
      files.push(`${prefix}${entry.name}`);
    }
  }
  return files.sort();
}

const files = sourceFiles(SRC);

describe("browser-safe sources", () => {
  it("finds the package's modules", () => {
    expect(files).toEqual(
      expect.arrayContaining(["encoding.ts", "index.ts", "rpc.ts", "types.ts"]),
    );
  });

  it.each(files)("%s imports no Node built-in and uses no Buffer or process", (file) => {
    const text = readFileSync(new URL(file, SRC), "utf8");
    expect(text).not.toMatch(/from\s+["']node:/);
    expect(text).not.toMatch(/import\(\s*["']node:/);
    expect(text).not.toMatch(
      /from\s+["'](fs|path|crypto|os|url|util|buffer|stream|http|https|net|zlib|child_process)(\/[^"']*)?["']/,
    );
    expect(text).not.toMatch(/require\(/);
    expect(text).not.toMatch(/\bBuffer\b/);
    expect(text).not.toMatch(/\bprocess\./);
  });
});
