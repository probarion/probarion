import { VaultSkeleton } from "@/components/console/VaultSkeleton";

/**
 * Shown at once when a vault page or one of its tabs is opened, while the page's chain and database reads run: the
 * vault's name and the tab bar with the clicked tab already open, then skeleton cards. It shows on a move to the vault
 * or between its tabs; a move inside a tab (Payables to one payable) keeps the old page until the new one lands. Next's
 * route announcer reads the page when it lands.
 *
 * The shell starts the response before the page runs, so a page's notFound() for someone who is not a member draws the
 * not-found page (noindex) under HTTP 200, a soft 404, as Next streams it. The vault is confirmed to no one either way.
 */
export default function VaultLoading() {
  return <VaultSkeleton />;
}
