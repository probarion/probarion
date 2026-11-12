/**
 * The mark from brand v2: the coin over its bar. The bar takes the colour of the text around it. The header's mark
 * keeps the gradient id "probarion-coin" (lib/docs/headings.ts reserves it); a second mark on the same page passes
 * its own `gradientId`, so that no two elements share an id.
 */
export function BrandMark({ gradientId = "probarion-coin" }: { gradientId?: string }) {
  return (
    <svg viewBox="0 0 144 122" aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--color-gold-deep)" />
          <stop offset=".28" stopColor="var(--color-gold-bright)" />
          <stop offset=".42" stopColor="var(--color-gold-pale)" />
          <stop offset=".56" stopColor="var(--color-gold-mid)" />
          <stop offset=".8" stopColor="var(--color-gold-deep)" />
          <stop offset="1" stopColor="var(--color-gold-ink)" />
        </linearGradient>
      </defs>
      <circle cx="72" cy="50" r="50" fill={`url(#${gradientId})`} />
      <rect x="0" y="106" width="144" height="16" rx="2" fill="currentColor" />
    </svg>
  );
}
