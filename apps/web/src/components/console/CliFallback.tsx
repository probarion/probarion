import { NETWORKS } from "@probarion/core";
import type { Network } from "@/lib/config";
import { CLI_NOTE, CLI_ON_NPM, CLI_SETUP_LINES, cli } from "@/lib/proof/cli";

/** Why the console cannot offer the factory form right now, in words. */
const REASONS = {
  unreachable: "NEAR could not be reached, so the factory's settings cannot be read",
  not_deployed: "there is no factory contract at that account on this network",
  no_version: "the factory has no vault version registered yet",
  bad_answer: "the factory answered with something the console could not read",
} as const;

export type CliFallbackReason = keyof typeof REASONS;

/**
 * The lines to show, for bash and Windows PowerShell 5.1 (`#` is a comment in both; there is no `VAR=value` prefix
 * and no `\` line continuation). What the CLI needs comes first as a comment line; while the CLI is not on npm, the
 * repository setup also comes first as comment lines: run each command after its `#` once, in either shell. Only for a
 * factory other than the network's own come the two labelled lines that set it, one per shell (the `export` line for
 * bash, the `$env:` line for PowerShell; the CLI has no flag for the factory, it reads PROBARION_FACTORY_ID, else the
 * network's factory). The command line then runs as it is in both shells once its `<…>` placeholders (the name, the
 * approver and the signing account) are filled in.
 */
export function cliFallbackLines(factory: string, network: Network): string[] {
  const lines: string[] = [];
  if (CLI_ON_NPM) {
    lines.push(`# ${CLI_NOTE}`);
  } else {
    lines.push(
      "# From a clone of the repository, set up once:",
      ...CLI_SETUP_LINES.map((l) => `#   ${l}`),
      "# then, from that folder:",
    );
  }
  if (factory !== NETWORKS[network].factory) {
    lines.push(
      `# This console uses the factory ${factory}. Set it first, with the line for your shell:`,
      "# bash:",
      `export PROBARION_FACTORY_ID=${factory}`,
      "# Windows PowerShell:",
      `$env:PROBARION_FACTORY_ID = "${factory}"`,
    );
  }
  lines.push(
    cli(
      `--network ${network} vault create --name <name> --approvers <approver.near> --daily-backstop 500 --held-ttl-hours 72 --sign-as <you.near>`,
    ),
    "# Add --deposit <near> for an embedded factory version.",
    "# It reads the factory's min_deposit and mode, and prints the near-cli-rs command.",
    "# You sign it with your own key (OWNER SIGNS).",
  );
  return lines;
}

/**
 * Spec §17 cut line 6: if the factory cannot be used from here, create the vault white-glove with
 * the CLI (packages/cli). It prints the transaction for near-cli-rs and never signs.
 */
export function CliFallback({
  factory,
  network,
  reason,
}: {
  factory: string;
  network: Network;
  reason: CliFallbackReason;
}) {
  return (
    <div className="text-sm">
      <p className="mb-2">
        The console cannot create a vault through the factory (
        <span className="mono">{factory}</span>) right now: {REASONS[reason]}. Nothing was prepared
        or signed. You can create the vault with the CLI instead, then register it below:
      </p>
      <pre className="overflow-x-auto rounded-2xl bg-ink p-4 text-xs text-paper">
        {cliFallbackLines(factory, network).join("\n")}
      </pre>
    </div>
  );
}
