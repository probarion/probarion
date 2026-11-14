import type { MandateView } from "@probarion/core";
import type { Metadata } from "next";
import Link from "next/link";
import { CanaryForm } from "@/components/canary/CanaryForm";
import { LatestAttempts, Scoreboard } from "@/components/canary/Leaderboard";
import { RehearsalCard } from "@/components/canary/RehearsalCard";
import { ReplayView } from "@/components/canary/ReplayView";
import { ByConstructionCard, ReplayCards, SideCards } from "@/components/canary/StaticCards";
import { VaultCard } from "@/components/canary/VaultCard";
import c from "@/components/site/canary.module.css";
import s from "@/components/site/site.module.css";
import { brandCardClass, linePillClass } from "@/components/ui";
import { loadBoard, loadFeed } from "@/lib/canary/board-data";
import { CANARY_COPY, eyebrow, tallyLine } from "@/lib/canary/copy";
import { loadReadiness } from "@/lib/canary/ready";
import { summarizeVault, type VaultSummary } from "@/lib/canary/vault";
import { type CanaryVia, parseVia, withVia } from "@/lib/canary/via";
import { type Banner, canaryView } from "@/lib/canary/view";
import type { Network } from "@/lib/config";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import { chainConsts, getReader } from "@/lib/near/server";
import { canonicalUrl, softRequestNetwork } from "@/lib/network";

/** The canonical drops `?via=`, and names the address of the request's own network (lib/network canonicalUrl). */
export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "Canary",
    description: "Try to make an AI agent pay you. Code rules and a NEAR contract decide.",
    alternates: { canonical: await canonicalUrl("/canary") },
  };
}
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

/** The vault card's reads, and its mandates as read (null when the read failed). */
async function readVault(
  network: Network,
  vault: string,
): Promise<{ summary: VaultSummary; mandates: MandateView[] | null }> {
  const consts = chainConsts(network);
  const reader = getReader(network);
  const [usdc, base, mandates, config] = await Promise.all([
    soft("usdc", () => reader.ftBalance(consts.usdc, vault)),
    soft("base", () => reader.intentsBalance(consts.intents, vault, consts.allowedAssets.base)),
    soft("mandates", () => reader.listMandates(vault, 0, 10)),
    soft("config", () => reader.getConfig(vault)),
  ]);
  return {
    summary: summarizeVault({ usdc, base, mandates, frozen: config?.frozen ?? null }),
    mandates,
  };
}

/**
 * The header has no link to a proof page: the Canary's ledger is private (the database forbids making it public), so
 * `/proof/<its vault>` is "page not found" for everyone but its team. In code-only mode nothing a visitor writes
 * reaches the contract, so the title says the code; the replay, and the live page in raw mode, keep the contract.
 */
function Header({
  network,
  via,
  mode = "live",
}: {
  network: Network;
  via: CanaryVia | null;
  mode?: "live" | "code-only";
}) {
  return (
    <header>
      <p className={s.eyebrow}>{eyebrow(network)}</p>
      <h1 className={c.title}>{mode === "code-only" ? H.titleCodeOnly : H.title}</h1>
      <p className={c.lede}>{H.lede}</p>
      <div className={c.pills}>
        <Link className={linePillClass} href={withVia("/canary/rules", via)}>
          {H.rules}
        </Link>
        {network === "testnet" ? <span className={c.statePill}>{H.testnetPill}</span> : null}
      </div>
    </header>
  );
}

/**
 * The replay: the banner that says why, what a visitor can do instead, the team's recorded attacks, the replay of the
 * team's attempt of 2026-11-10 and two cards.
 */
function Replay({
  network,
  banner,
  via,
}: {
  network: Network;
  banner: Banner;
  via: CanaryVia | null;
}) {
  return (
    <div className={`${s.site} ${s.wrap} ${c.page}`}>
      <Header network={network} via={via} />
      <ReplayView banner={banner} />
      <RehearsalCard />
      <ReplayCards />
    </div>
  );
}

/**
 * The public Canary. Live (or code-only) with a vault and the model key set, it has the vault read from the chain, the
 * form, the scoreboard and the latest attempts, once the database and the chain agree: a private Canary tenant on this
 * network with room in its ledger, a ledger key with gas for its anchors, and a vault that holds a mandate. Otherwise,
 * or when the environment cannot be read, it is the replay with a banner that says why, so the page does not show a
 * form that those checks would refuse. It never fails for want of settings, and it shows no ledger (the Canary's is
 * private). It is the Canary of the network of the address it
 * was opened at: that network's vault, chain and board. A link of ours names its source in the address (`?via=x`), and
 * the form sends it with each attempt; any other value is no source. Both the live page and the replay show the replay
 * of the team's attempt on testnet of 2026-11-10 (RehearsalCard): under the vault, or under the recorded attacks.
 */
export default async function CanaryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const via = parseVia((await searchParams).via);
  const view = canaryView(getEnv, await softRequestNetwork());
  if (view.kind === "replay")
    return <Replay network={view.network} banner={view.banner} via={via} />;
  const readiness = await loadReadiness(view.network, view.vault);
  if (readiness !== "ready") return <Replay network={view.network} banner={readiness} via={via} />;
  const [vault, board, feed] = await Promise.all([
    readVault(view.network, view.vault).catch((error: unknown) => {
      // The reader could not even be built: the same "could not read" as a failed read.
      log.warn("canary.chain_unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        summary: summarizeVault({ usdc: null, base: null, mandates: null, frozen: null }),
        mandates: null,
      };
    }),
    loadBoard(view.network),
    loadFeed(view.network),
  ]);
  // A vault with no mandate answers every attempt "not ready". Mandates that could not be read are said so on the card.
  if (vault.mandates?.length === 0)
    return <Replay network={view.network} banner="closed" via={via} />;
  const { summary } = vault;
  // The attempt comes first, right under the title, with the one line of how many have tried (none when the board could
  // not be read; the form drops it once the visitor's own attempt is in); the vault it attacks and why an address
  // cannot work come next.
  return (
    <div className={`${s.site} ${s.wrap} ${c.page}`}>
      <Header network={view.network} via={via} mode={view.mode} />
      <section className={brandCardClass}>
        <h2 className={c.cardTitle}>{CANARY_COPY.form.title}</h2>
        <CanaryForm
          network={view.network}
          mode={view.mode}
          via={via}
          tally={board === null ? null : tallyLine(board)}
        />
      </section>
      <VaultCard network={view.network} vault={view.vault} summary={summary} />
      <ByConstructionCard />
      <RehearsalCard />
      <Scoreboard board={board} />
      <LatestAttempts feed={feed} network={view.network} />
      <SideCards network={view.network} />
    </div>
  );
}
