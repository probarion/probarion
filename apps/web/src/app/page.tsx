import { BuiltOn } from "@/components/site/BuiltOn";
import { Compare } from "@/components/site/Compare";
import { ConsoleShots } from "@/components/site/ConsoleShots";
import { Hero, Problem } from "@/components/site/Hero";
import { InkBand } from "@/components/site/InkBand";
import { Integrate } from "@/components/site/Integrate";
import { Journey } from "@/components/site/Journey";
import { LiveCheck } from "@/components/site/LiveCheck";
import { MainnetPayout } from "@/components/site/MainnetPayout";
import { ChainList, Closing, StatusList } from "@/components/site/Sections";
import s from "@/components/site/site.module.css";
import { LedgerTest } from "@/components/site/TamperPanel";

export default function Home() {
  return (
    <div className={s.site}>
      <Hero />
      <Problem />
      <LiveCheck />
      <Compare />
      <Journey />
      <Integrate />
      <InkBand />
      <MainnetPayout />
      <ConsoleShots />
      <LedgerTest />
      <ChainList />
      <StatusList />
      <BuiltOn />
      <Closing />
    </div>
  );
}
