// Builds the popup's elements. Text always goes in as text nodes: no markup string is ever parsed.

type Child = Node | string | null;

export interface Props {
  class?: string;
  attrs?: Record<string, string>;
  on?: { [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void };
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  for (const [name, value] of Object.entries(props.attrs ?? {})) el.setAttribute(name, value);
  for (const [type, listener] of Object.entries(props.on ?? {})) {
    el.addEventListener(type, listener as EventListener);
  }
  for (const child of children) {
    if (child !== null)
      el.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return el;
}
