import Link from "next/link";
import { Card } from "@/components/ui";

export default function Home() {
  return (
    <div>
      <h1 className="mb-2 text-3xl font-semibold">Spend by mandate. Prove every payment.</h1>
      <p className="mb-8 max-w-2xl text-stone-600">
        Probarion lets an AI agent pay people on NEAR or on Base, but only inside mandates a human
        signed. The rule lives in a NEAR contract, not in a prompt. TEE protects the data. The
        contract protects the money.
      </p>
      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Owners">
          <Link className="underline" href="/console">
            Open the console
          </Link>{" "}
          to create a vault and sign mandates from your wallet.
        </Card>
        <Card title="Try to break it">
          <Link className="underline" href="/canary">
            Canary
          </Link>
          : make a gullible agent pay you. The contract decides.
        </Card>
        <Card title="Verify">
          <Link className="underline" href="/open">
            Open metrics
          </Link>{" "}
          and every vault&apos;s <code>/proof</code> page, plus{" "}
          <code>probarion verify --offline</code>.
        </Card>
      </div>
    </div>
  );
}
