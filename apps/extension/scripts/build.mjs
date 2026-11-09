import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { manifestFor, offeredFor, originsFor } from "./manifest.mjs";

// Builds the extension into dist/: three self-contained scripts (not minified, so a store reviewer can read them),
// the popup page, the icons and the manifest. `--dev` adds a local `next dev` (scripts/manifest.mjs DEV_ORIGINS).

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DIST = join(ROOT, "dist");

export async function build({ dev = false } = {}) {
  const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });
  await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: { worker: "src/worker.ts", content: "src/content.ts", popup: "src/popup/main.ts" },
    outdir: "dist",
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome127",
    charset: "utf8",
    legalComments: "none",
    logLevel: "warning",
    define: {
      __ORIGINS__: JSON.stringify(originsFor(dev)),
      __OFFERED__: JSON.stringify(offeredFor(dev)),
    },
  });
  cpSync(join(ROOT, "static"), DIST, { recursive: true });
  writeFileSync(
    join(DIST, "manifest.json"),
    `${JSON.stringify(manifestFor({ version, dev }), null, 2)}\n`,
  );
  return { version };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dev = process.argv.includes("--dev");
  const { version } = await build({ dev });
  console.log(
    `Built Probarion ${version}${dev ? " (dev: also trusts http://localhost:3000)" : ""} into dist/`,
  );
}
