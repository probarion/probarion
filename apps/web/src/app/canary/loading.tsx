import { CanarySkeleton } from "@/components/canary/CanarySkeleton";

/** Shown at once when /canary or its rules are opened, while the page reads the vault from the chain and the board. */
export default function CanaryLoading() {
  return <CanarySkeleton />;
}
