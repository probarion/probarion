import { Fragment } from "react";
import { TxLink } from "@/components/ui";
import type { RichPart } from "@/lib/canary/copy";

/** A sentence that names code (copy.ts): its text as text, an id or a code in mono, a transaction as an explorer link. */
export function Rich({ parts }: { parts: readonly RichPart[] }) {
  return (
    <>
      {parts.map((part, i) => {
        if (typeof part === "string") {
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed sentence, never reordered; a piece of text can repeat.
          return <Fragment key={i}>{part}</Fragment>;
        }
        if ("code" in part) {
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed sentence, never reordered.
          return <code key={i}>{part.code}</code>;
        }
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed sentence, never reordered.
        return <TxLink key={i} network={part.network} hash={part.tx} />;
      })}
    </>
  );
}
