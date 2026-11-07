import { type ComponentProps, isValidElement, type ReactNode } from "react";
import { nodeText } from "@/lib/docs/node-text";
import { CopyButton } from "./CopyButton";
import d from "./docs.module.css";

const LANG_LABELS: Readonly<Record<string, string>> = {
  bash: "Shell",
  sh: "Shell",
  ts: "TypeScript",
  tsx: "TSX",
  js: "JavaScript",
  json: "JSON",
  rust: "Rust",
  toml: "TOML",
  md: "Markdown",
  text: "Text",
};

function languageOf(children: ReactNode): string {
  if (!isValidElement<{ className?: string }>(children)) return "text";
  return /\blanguage-([\w-]+)/.exec(children.props.className ?? "")?.[1] ?? "text";
}

/**
 * The `pre` of every fenced block, as @shikijs/rehype emits it. Shiki's inline background is
 * dropped: the frame is the ink token in both themes, and the token colours are tested against it
 * (test/docs-ui.test.ts).
 */
export function CodeFrame({
  children,
  className,
  style: _shikiStyle,
  ...rest
}: ComponentProps<"pre">) {
  const lang = languageOf(children);
  return (
    <figure className={d.code}>
      <figcaption className={d.codeHead}>
        <span className={d.codeLang}>{LANG_LABELS[lang] ?? lang}</span>
        <CopyButton text={nodeText(children).replace(/\n$/, "")} className={d.copy} />
      </figcaption>
      <pre className={`${className ?? ""} ${d.pre}`} {...rest}>
        {children}
      </pre>
    </figure>
  );
}
