// Just enough of React's hooks to run a component or a hook as a plain function under Node, with no DOM: the tests
// that use it replace `react`'s hooks with these (`vi.mock("react", ...)`), `mount()` the function, and then call the
// handlers it returned, the way an event would. It keeps a hook's state between renders, runs effects after a render
// (when their dependencies changed) and their cleanups on `unmount()`, and re-renders on `flush()` after a state
// setter ran. It is not React: no batching, no refs attached to elements, no context.
type Cleanup = unknown; // what an effect returned: a cleanup function, or nothing
interface Effect {
  deps: readonly unknown[] | undefined;
  cleanup: Cleanup;
}
interface Instance {
  slots: unknown[];
  effects: Effect[];
  index: number;
  dirty: boolean;
  pending: (() => void)[];
}

let current: Instance | null = null;

function here(): Instance {
  if (!current) throw new Error("a hook ran outside mount()");
  return current;
}

function slot<T>(make: () => T): T {
  const inst = here();
  const i = inst.index++;
  if (!(i in inst.slots)) inst.slots[i] = make();
  return inst.slots[i] as T;
}

export const hooks = {
  useId: () => ":t:",
  useRef: <T>(initial: T) => slot(() => ({ current: initial })),
  useCallback: <F>(fn: F) => fn,
  useState: <S>(initial: S | (() => S)) => {
    const inst = here();
    const cell = slot(() => ({
      value: typeof initial === "function" ? (initial as () => S)() : initial,
    }));
    const set = slot(() => (next: S | ((prev: S) => S)) => {
      cell.value = typeof next === "function" ? (next as (prev: S) => S)(cell.value as S) : next;
      inst.dirty = true;
    });
    return [cell.value as S, set] as const;
  },
  useEffect: (fn: () => Cleanup, deps?: readonly unknown[]) => {
    const inst = here();
    const i = inst.index++;
    const before = inst.effects[i];
    const same =
      !!before &&
      !!deps &&
      !!before.deps &&
      deps.length === before.deps.length &&
      deps.every((d, k) => Object.is(d, before.deps?.[k]));
    if (same) return;
    inst.pending.push(() => {
      if (typeof before?.cleanup === "function") before.cleanup();
      inst.effects[i] = { deps, cleanup: fn() };
    });
  },
};

export function mount<T>(render: () => T) {
  const inst: Instance = { slots: [], effects: [], index: 0, dirty: false, pending: [] };
  let result: T;
  const run = () => {
    current = inst;
    inst.index = 0;
    inst.pending = [];
    try {
      result = render();
    } finally {
      current = null;
    }
    for (const effect of inst.pending) effect();
  };
  run();
  return {
    get result(): T {
      return result;
    },
    /** Re-renders while a state setter has asked for it, as React does once an event has been handled. */
    flush() {
      for (let n = 0; inst.dirty; n++) {
        if (n > 20) throw new Error("render loop");
        inst.dirty = false;
        run();
      }
    },
    unmount() {
      for (const e of inst.effects) if (typeof e?.cleanup === "function") e.cleanup();
    },
  };
}

/** A React element, or what a component returned, as far as these tests look at it. */
export interface El {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}

const isEl = (v: unknown): v is El =>
  typeof v === "object" && v !== null && "type" in v && "props" in v;

/** Every element in a returned tree, in document order. */
export function elements(tree: unknown): El[] {
  const out: El[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) for (const c of n) walk(c);
    else if (isEl(n)) {
      out.push(n);
      walk(n.props.children);
    }
  };
  walk(tree);
  return out;
}

/** The text an element and its children show. */
export function textOf(n: unknown): string {
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join("");
  return isEl(n) ? textOf(n.props.children) : "";
}
