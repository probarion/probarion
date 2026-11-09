import { Compare } from "@/components/site/Compare";
import { Hero, Problem } from "@/components/site/Hero";
import { InkBand } from "@/components/site/InkBand";
import { Integrate } from "@/components/site/Integrate";
import { Journey } from "@/components/site/Journey";
import { LiveCheck } from "@/components/site/LiveCheck";
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
      <LedgerTest />
      <ChainList />
      <StatusList />
      <Closing />
    </div>
  );
}
