// Vitest serves a CSS module as a proxy that names any key, so a render test never notices a class its module does not
// define (journey's .evCell rendered with no class for a week). This reads every component's imports of a CSS module
// and holds each `alias.member` it uses to a class that module's stylesheet defines.
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toPosix, walk } from "./deploy-scan";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(WEB, "src");

/** The class names a stylesheet defines, comments dropped. */
function classesOf(css: string): Set<string> {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return new Set([...bare.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((m) => m[1] ?? ""));
}

/** The CSS modules a source file imports, by local name, resolved to their files. */
function modulesOf(file: string, src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/^import\s+(\w+)\s+from\s+"([^"]+\.module\.css)";/gm)) {
    const [, alias = "", spec = ""] = m;
    const path = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : resolve(dirname(file), spec);
    out.set(alias, path);
  }
  return out;
}

describe("CSS module classes", () => {
  it("uses no class that its module does not define", () => {
    const files = walk(SRC).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
    let checked = 0;
    const missing: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const [alias, path] of modulesOf(file, src)) {
        const defined = classesOf(readFileSync(path, "utf8"));
        // `alias.member`, not a property of something else that happens to end in the alias's name.
        for (const m of src.matchAll(new RegExp(`(?<![\\w.$])${alias}\\.([A-Za-z_]\\w*)`, "g"))) {
          checked += 1;
          const member = m[1] ?? "";
          if (!defined.has(member))
            missing.push(
              `${toPosix(relative(WEB, file))}: ${alias}.${member} (${toPosix(relative(WEB, path))})`,
            );
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
    expect([...new Set(missing)]).toEqual([]);
  });
});
