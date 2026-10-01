/**
 * Design tokens for every transactional email.
 *
 * Light values are the source of truth and are written **inline** on each
 * element, because Gmail strips nothing but does ignore `prefers-color-scheme`
 * media queries outright. The `<style>` block in `layout.ts` only ever *adds*
 * the dark palette on top of those inline values, so a client that ignores the
 * block still renders the intended light email.
 */

/** Sampled from the logo: the wordmark is exactly rgb(255, 75, 0). */
export const brand = {
  orange: '#FF4B00',
  ink: '#101828',
  muted: '#667085',
  /** Page background behind the card. */
  body: '#F4F4F5',
  card: '#FFFFFF',
  border: '#E8EAEF',
  /** Warm tint used for the code box and the footer band. */
  tint: '#FFF1EC',
} as const;

/**
 * Dark-mode counterparts. Applied through `@media (prefers-color-scheme: dark)`
 * and the Outlook.com `[data-ogsc]` attribute selectors.
 */
export const brandDark = {
  body: '#0D0D0D',
  card: '#1A1A1A',
  title: '#FFFFFF',
  text: '#9CA3AF',
  code: '#2E211E',
  footer: '#241D1B',
} as const;

/**
 * The header is a near-black gradient banner in both themes, so it only needs
 * one dark value — and the solid `background-color` is what Outlook's Word
 * engine falls back to, since it drops the `background` shorthand entirely.
 */
export const header = {
  top: '#000000',
  bottom: '#111111',
  /** Fallback emitted before the gradient. */
  solid: '#0B0B0C',
} as const;

/** Outer card width. Fixed rather than fluid so Outlook honours it. */
export const CARD_WIDTH = 560;

/** Font stacks. Webfonts are blocked in most clients, so these are system-only. */
export const font = {
  sans: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  mono: "'SF Mono',ui-monospace,Menlo,Consolas,monospace",
} as const;
