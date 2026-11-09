import { Hero, Numbers, Thesis } from "@/components/site/Hero";
import { InkBand } from "@/components/site/InkBand";
import { Journey } from "@/components/site/Journey";
import { LiveCheck } from "@/components/site/LiveCheck";
import { ChainList, Closing, StatusList } from "@/components/site/Sections";
import s from "@/components/site/site.module.css";
import { LedgerTest } from "@/components/site/TamperPanel";

export default function Home() {
  return (
    <div className={s.site}>
      <Hero />
      <Thesis />
      <Numbers />
      <LiveCheck />
      <Journey />
      <InkBand />
      <LedgerTest />
      <ChainList />
      <StatusList />
      <Closing />
    </div>
  );
}
