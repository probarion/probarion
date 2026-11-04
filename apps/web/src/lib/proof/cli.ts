// The one place that decides how the site writes a `probarion` command (ruling W-T16-R2). Every command on the
// landing page and the proof page is built here; the deploy runbook's smoke step 7 is checked against it.

/**
 * True once the `probarion` package is on npm. Publishing is an OWNER action; until it happens, `npx probarion` does
 * not run, so the site shows the command that does: the CLI built from a clone of the public repository.
 */
export const CLI_ON_NPM: boolean = false;

export const REPO_URL = "https://github.com/probarion/probarion";

/**
 * Set up once, from any folder: clone the repository, install, and build the CLI with the two workspace packages it
 * needs (`{packages/cli}...` selects the CLI by folder, plus its dependencies, in build order).
 */
export const CLI_SETUP = `git clone ${REPO_URL} && cd probarion && pnpm install && pnpm --filter "{packages/cli}..." build`;

/** The short line the pages show while the package is not on npm. */
export const CLI_NOTE =
  "The probarion npm package is coming; until then, this command from the public repository works.";

/** The built CLI's bin (`packages/cli/package.json` "bin"), run from the repository folder. */
const FROM_SOURCE = "node packages/cli/dist/bin.js";

/** A `probarion` command as a visitor can run it today: `args` after the program name. */
export function cli(args: string, onNpm: boolean = CLI_ON_NPM): string {
  return `${onNpm ? "npx probarion" : FROM_SOURCE} ${args}`;
}
