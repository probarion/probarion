import { BuiltOn } from "@/components/site/BuiltOn";
import { Hero, Problem } from "@/components/site/Hero";
import { Integrate } from "@/components/site/Integrate";
import { Journey } from "@/components/site/Journey";
import { LiveCheck } from "@/components/site/LiveCheck";
import { MainnetPayout } from "@/components/site/MainnetPayout";
import { Closing } from "@/components/site/Sections";
import { StatusBoard } from "@/components/site/StatusBoard";
import s from "@/components/site/site.module.css";
import { LedgerTest } from "@/components/site/TamperPanel";

/**
 * Seven sections, in the order of the story: the promise, the problem and the payee, how a payment works with the live
 * check of its last step (#try), the use cases, real money on mainnet, the record and what is not proven, the close.
 */
export default function Home() {
  return (
    <div className={s.site}>
      <Hero />
      <Problem />
      <Journey compact>
        <LiveCheck embedded />
      </Journey>
      <Integrate />
      <MainnetPayout />
      <LedgerTest>
        <BuiltOn />
        <StatusBoard />
      </LedgerTest>
      <Closing />
    </div>
  );
}
