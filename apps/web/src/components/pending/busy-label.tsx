import type { ReactElement } from "react";
import { Spinner } from "./Spinner";

/**
 * A button's label that turns into its busy label without moving anything. Every label shares one grid cell
 * (globals.css `.busy-label`), so the button is always as wide as the widest of: the idle label, and the spinner plus
 * each busy label. `sizes` lists every other label the button can show (each phase), so a phase change moves nothing;
 * a button that is not ready yet lists its phase labels too, so it does not narrow when it becomes ready.
 *
 * The text, the accessible name and what a test reads change at once. Only the look waits: the old label stays on
 * screen for 200 ms (`.busy-echo`), then the spinner and the busy label fade in, so work that ends sooner shows nothing.
 * The sizers and the echo are aria-hidden and hold no text of their own; theirs comes from CSS `attr(data-label)`.
 *
 * Call it as a function, not as `<BusyLabel/>`: the label must stay a host child of the button, for its accessible name
 * and for the tests that run a component as a plain function (test/fixtures/mini-react.ts).
 */
export function busyLabel(
  idle: string,
  busy: string,
  on: boolean,
  sizes: readonly string[] = [],
): ReactElement {
  return (
    <span className="busy-label" data-busy={on ? "" : undefined}>
      <span aria-hidden="true" className="busy-size" data-label={idle} />
      {[...new Set([busy, ...sizes])].map((label) => (
        <span
          key={label}
          aria-hidden="true"
          className="busy-size busy-size-spin"
          data-label={label}
        />
      ))}
      {on ? <span aria-hidden="true" className="busy-echo" data-label={idle} /> : null}
      <span className="busy-now">
        {on ? <Spinner /> : null}
        {on ? busy : idle}
      </span>
    </span>
  );
}
