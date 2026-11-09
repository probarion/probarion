// The one place that decides how the site writes a `probarion` command (rulings W-T16-R2 and R3). Every command on
// the landing page, the proof page, /security and the console's CLI fallback is built here; the deploy runbook's smoke
// step 7 is checked against it. Flipping CLI_ON_NPM is the whole change in code (step 7 is then updated by hand).

/**
 * True since `probarion` 0.1.0 is on npm (published 2026-11-09), so the site shows `npx probarion`. Set it back to
 * false only if the package can no longer be run: the site then shows the CLI built from a clone of the public
 * repository.
 */
export const CLI_ON_NPM: boolean = true;

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

/**
 * The short line the pages show before the commands, from the engines in package.json: Node >=24 for the package
 * on npm, and also git and pnpm 10 for the repository command.
 */
export const CLI_NOTE = CLI_ON_NPM
  ? "These commands run the probarion package from npm with npx, which asks once before it downloads it. Needs Node 24 or later."
  : "These commands run from a clone of the public repository. Needs git, Node 24 or later and pnpm 10. If you cloned it before, run git pull, pnpm install and the build line again.";

/**
 * What a pre-ledger spend (mainnet v0 only) also needs: the documented Day-4 decisions and the recorded burn
 * transactions, both in the repository (docs/evidence and docs/mainnet-proof.json). With npx they are read from a
 * clone made in the folder the command runs from (EVIDENCE_CLONE), next to the downloaded ledger.
 */
export const PRE_LEDGER_FLAGS = CLI_ON_NPM
  ? "--evidence probarion/docs/evidence --proof probarion/docs/mainnet-proof.json"
  : "--evidence docs/evidence --proof docs/mainnet-proof.json";

/** The one command that puts the evidence files where a pre-ledger npx command reads them. */
export const EVIDENCE_CLONE = `git clone ${REPO_URL}`;

/** True when `command` reads the repository's evidence files from a clone the visitor makes first (npx only). */
export function needsEvidenceClone(command: string): boolean {
  return CLI_ON_NPM && command.includes(PRE_LEDGER_FLAGS);
}

/** The built CLI's bin (`packages/cli/package.json` "bin"), run from the repository folder. */
const FROM_SOURCE = "node packages/cli/dist/bin.js";

/** A `probarion` command as a visitor can run it today: `args` after the program name. */
export function cli(args: string, onNpm: boolean = CLI_ON_NPM): string {
  return `${onNpm ? "npx probarion" : FROM_SOURCE} ${args}`;
}
