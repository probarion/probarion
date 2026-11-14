import type { Board } from "@/lib/canary/board";
import { tallyLine } from "@/lib/canary/copy";

/**
 * How many have tried so far, in one line (tallyLine in copy.ts), from the leaderboard the page already reads. A board
 * that could not be read (null) shows nothing here: the scoreboard says it is not available, and no count is guessed.
 */
export function Tally({ board, className }: { board: Board | null; className?: string }) {
  if (board === null) return null;
  return <p className={className}>{tallyLine(board)}</p>;
}
