import type { Metadata } from "next";
import { SignInButton } from "@/components/wallet/SignInButton";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const safeNext = typeof next === "string" && next.startsWith("/console") ? next : "/console"; // no open redirect
  return (
    <div className="max-w-md">
      <h1 className="mb-2 text-2xl font-semibold">Sign in with your NEAR wallet</h1>
      <p className="mb-6 text-sm text-stone-600">
        Your wallet signs a message (NEP-413). This is not a transaction: it moves no funds and adds
        no keys. HOT, Meteor, Intear and the other near-connect wallets work.
      </p>
      <SignInButton next={safeNext} />
    </div>
  );
}
