import { BuiltOn } from "@/components/site/BuiltOn";
import { Compare } from "@/components/site/Compare";
import { ConsoleShots } from "@/components/site/ConsoleShots";
import { Hero, Problem } from "@/components/site/Hero";
import { InkBand } from "@/components/site/InkBand";
import { Integrate } from "@/components/site/Integrate";
import { Journey } from "@/components/site/Journey";
import { LiveCheck } from "@/components/site/LiveCheck";
import { MainnetPayout } from "@/components/site/MainnetPayout";
import { ChainList, Closing } from "@/components/site/Sections";
import { StatusBoard } from "@/components/site/StatusBoard";
import s from "@/components/site/site.module.css";
import { LedgerTest } from "@/components/site/TamperPanel";

export default function Home() {
  return (
    <div className={s.site}>
      <Hero />
      <Problem />
      <LiveCheck />
      {/* Real USDC right under the testnet check: the mainnet payouts and the visitor's own question to that vault. */}
      <MainnetPayout />
      <Compare />
      <Journey />
      <Integrate />
      <InkBand />
      <ConsoleShots />
      <LedgerTest />
      <ChainList />
      <StatusBoard />
      <BuiltOn />
      <Closing />
    </div>
  );
}
