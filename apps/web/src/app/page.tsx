import Link from "next/link";
import { RouteLink } from "@/components/RouteLink";
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
          <RouteLink className="underline" route="/canary">
            Canary
          </RouteLink>
          : make a gullible agent pay you. The contract decides.
        </Card>
        <Card title="Verify">
          <RouteLink className="underline" route="/proof">
            Proof page
          </RouteLink>
          : a vault&apos;s checks (a) to (i) with explorer links, and a snapshot you can verify
          yourself with <code>npx probarion verify --offline</code>.{" "}
          <RouteLink className="underline" route="/open">
            Open metrics
          </RouteLink>
          : public numbers anyone can check.
        </Card>
      </div>
    </div>
  );
}
