/** Why the console cannot offer the factory form right now, in words. */
const REASONS = {
  unreachable: "NEAR could not be reached, so the factory's settings cannot be read",
  not_deployed: "there is no factory contract at that account on this network",
  no_version: "the factory has no vault version registered yet",
  bad_answer: "the factory answered with something the console could not read",
} as const;

export type CliFallbackReason = keyof typeof REASONS;

/**
 * Spec §17 cut line 6: if the factory cannot be used from here, create the vault white-glove with
 * the CLI (packages/cli). It prints the transaction for near-cli-rs and never signs.
 */
export function CliFallback({ factory, reason }: { factory: string; reason: CliFallbackReason }) {
  return (
    <div className="text-sm">
      <p className="mb-2">
        The console cannot create a vault through the factory (
        <span className="mono">{factory}</span>) right now: {REASONS[reason]}. Nothing was prepared
        or signed. You can create the vault with the CLI instead, then register it below:
      </p>
      <pre className="overflow-x-auto rounded-2xl bg-[#0B0B0C] p-4 text-xs text-[#F7F6F3]">
        {`npx probarion vault create --name <name> --approvers <approver.near> \\
  --daily-backstop 500 --held-ttl-hours 72 --sign-as <you.near> [--deposit <near>]
# It reads the factory's min_deposit and mode, and prints the near-cli-rs command.
# You sign it with your own key (OWNER SIGNS). --deposit is required for an embedded version.`}
      </pre>
    </div>
  );
}
