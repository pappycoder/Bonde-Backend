/**
 * Small building blocks shared by the email templates. Everything rendered
 * into HTML passes through `esc()` so dynamic values (names, codes, account
 * numbers, merchant names) can never break out of the markup.
 *
 * Renderers should pass *raw* text to `emailLayout` and let it escape once —
 * pre-escaping here would double-encode anything containing `&` or an apostrophe.
 */
export function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
