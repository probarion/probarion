/**
 * The pending mark: decoration only, as the label beside it carries the state. It takes currentColor, so it reads on
 * ink, line and red buttons and in forced colours (where its open quarter may close into a full ring). Under reduced
 * motion it is a still ring. It has no delay of its own: its container gives it the 200 ms (`.busy-now` in a busy label,
 * `animate-pending-in` on a status line). 1em plus its 0.5em gap is the room `.busy-size-spin` keeps for it.
 */
export function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="me-[0.5em] inline-block size-[1em] shrink-0 rounded-full border-2 border-current border-r-transparent motion-safe:animate-spin"
    />
  );
}
