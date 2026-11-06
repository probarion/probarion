import type { Metadata } from "next";
import Link from "next/link";
import { CanaryForm } from "@/components/canary/CanaryForm";
import { LatestAttempts, Scoreboard } from "@/components/canary/Leaderboard";
import { ReplayView } from "@/components/canary/ReplayView";
import { ByConstructionCard, SideCards } from "@/components/canary/StaticCards";
import { VaultCard } from "@/components/canary/VaultCard";
import c from "@/components/site/canary.module.css";
import s from "@/components/site/site.module.css";
import { brandCardClass, linePillClass } from "@/components/ui";
import { loadBoard, loadFeed } from "@/lib/canary/board-data";
import { CANARY_COPY, eyebrow } from "@/lib/canary/copy";
import { summarizeVault, type VaultSummary } from "@/lib/canary/vault";
import { canaryView } from "@/lib/canary/view";
import type { Network } from "@/lib/config";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import { chainConsts, getReader } from "@/lib/near/server";
import { BUILD_NETWORK } from "@/lib/site/network";

export const metadata: Metadata = {
  title: "Canary",
  description: "Try to make an AI agent pay you. Code rules and a NEAR contract decide.",
};
// The vault is read from the chain on every request; the scoreboard and the feed have their own cache (board-data.ts).
export const dynamic = "force-dynamic";

const H = CANARY_COPY.head;

/** One chain read, or null when it failed (and a warning), so that a failed read is never drawn as a zero. */
function soft<T>(what: string, read: () => Promise<T>): Promise<T | null> {
  return Promise.resolve()
    .then(read)
    .catch((error: unknown) => {
      log.warn("canary.chain_read_failed", {
        what,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
}

async function readVault(vault: string): Promise<VaultSummary> {
  const consts = chainConsts();
  const reader = getReader();
  const [usdc, base, mandates] = await Promise.all([
    soft("usdc", () => reader.ftBalance(consts.usdc, vault)),
    soft("base", () => reader.intentsBalance(consts.intents, vault, consts.allowedAssets.base)),
    soft("mandates", () => reader.listMandates(vault, 0, 10)),
  ]);
  return summarizeVault({ usdc, base, mandates });
}

/**
 * The header has no link to a proof page: the Canary's ledger is private (the database forbids making it public), so
 * `/proof/<its vault>` is "page not found" for everyone but its team.
 */
function Header({ network }: { network: Network }) {
  return (
    <header>
      <p className={s.eyebrow}>{eyebrow(network)}</p>
      <h1 className={c.title}>{H.title}</h1>
      <p className={c.lede}>{H.lede}</p>
      <div className={c.pills}>
        <Link className={linePillClass} href="/canary/rules">
          {H.rules}
        </Link>
        {network === "testnet" ? <span className={c.statePill}>{H.testnetPill}</span> : null}
      </div>
    </header>
  );
}

/**
 * The public Canary. Live (or code-only) with a vault set, it has the vault read from the chain, the form, the
 * scoreboard and the latest attempts. Otherwise, or when the environment cannot be read, it is the replay of recorded
 * attacks with a banner that says why. It never fails for want of settings, and it shows no ledger (the Canary's is private).
 */
export default async function CanaryPage() {
  const view = canaryView(getEnv, BUILD_NETWORK);
  if (view.kind === "replay") {
    return (
      <div className={`${s.site} ${s.wrap} ${c.page}`}>
        <Header network={view.network} />
        <ReplayView banner={view.banner} />
      </div>
    );
  }
  const [summary, board, feed] = await Promise.all([
    readVault(view.vault).catch((error: unknown) => {
      // The reader could not even be built: the same "could not read" as a failed read.
      log.warn("canary.chain_unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
      return summarizeVault({ usdc: null, base: null, mandates: null });
    }),
    loadBoard(),
    loadFeed(),
  ]);
  return (
    <div className={`${s.site} ${s.wrap} ${c.page}`}>
      <Header network={view.network} />
      <VaultCard network={view.network} vault={view.vault} summary={summary} />
      <ByConstructionCard />
      <section className={brandCardClass}>
        <h2 className={c.cardTitle}>{CANARY_COPY.form.title}</h2>
        <CanaryForm network={view.network} mode={view.mode} />
      </section>
      <Scoreboard board={board} />
      <LatestAttempts feed={feed} network={view.network} />
      <SideCards network={view.network} />
    </div>
  );
}
