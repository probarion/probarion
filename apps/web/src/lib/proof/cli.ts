// The one place that decides how the site writes a `probarion` command (rulings W-T16-R2 and R3). Every command on
// the landing page, the proof page and the console's CLI fallback is built here; the deploy runbook's smoke step 7 is
// checked against it. Flipping CLI_ON_NPM is the whole change in code (step 7 is then updated by hand).

/**
 * True once the `probarion` package is on npm. Publishing is an OWNER action; until it happens, `npx probarion` does
 * not run, so the site shows the command that does: the CLI built from a clone of the public repository.
 */
export const CLI_ON_NPM: boolean = false;

export const REPO_URL = "https://github.com/probarion/probarion";

/**
 * Set up once, one command per line so that every shell runs them (Windows PowerShell 5.1 has no `&&`): clone the
 * repository, install, and build the CLI with the two workspace packages it needs (`{packages/cli}...` selects the CLI
 * by folder, plus its dependencies, in build order).
 */
export const CLI_SETUP_LINES: readonly string[] = [
  `git clone ${REPO_URL}`,
  "cd probarion",
  "pnpm install",
  'pnpm --filter "{packages/cli}..." build',
];

/** The short line the pages show while the package is not on npm (package.json engines: Node >=24, pnpm 10). */
export const CLI_NOTE =
  "The probarion npm package is coming; until then, the commands below run from a clone of the public repository. Needs git, Node 24 or later and pnpm 10. If you cloned it before, run git pull and the build line again.";

/**
 * What a pre-ledger spend (mainnet v0 only) also needs: the documented Day-4 decisions and the recorded burn
 * transactions, both in the repository (docs/evidence and docs/mainnet-proof.json).
 */
export const PRE_LEDGER_FLAGS = CLI_ON_NPM
  ? "--evidence <a copy of the repository's docs/evidence> --proof <a copy of the repository's docs/mainnet-proof.json>"
  : "--evidence docs/evidence --proof docs/mainnet-proof.json";

/** The built CLI's bin (`packages/cli/package.json` "bin"), run from the repository folder. */
const FROM_SOURCE = "node packages/cli/dist/bin.js";

/** A `probarion` command as a visitor can run it today: `args` after the program name. */
export function cli(args: string, onNpm: boolean = CLI_ON_NPM): string {
  return `${onNpm ? "npx probarion" : FROM_SOURCE} ${args}`;
}
