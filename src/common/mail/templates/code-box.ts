import { esc } from './parts.js';
import { brand, font } from './theme.js';

/**
 * A big, spaced-out digits block for one-time codes.
 *
 * `letter-spacing` also adds a trailing gap after the final digit, which shifts
 * the whole run left of centre — `padding-left` compensates for exactly that.
 * The tinted background is inline for light mode and re-stated in the dark
 * block of `layout.ts` via the `.email-code` class.
 */
export function codeBox(code: string): string {
  return `
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px">
                    <tr>
                      <td class="email-code" align="center" bgcolor="${brand.tint}"
                          style="padding:20px 16px;background-color:${brand.tint};border-radius:12px;text-align:center">
                        <span class="email-ink" style="display:inline-block;font-family:${font.mono};font-size:32px;line-height:1.2;font-weight:700;letter-spacing:12px;padding-left:12px;color:${brand.ink}">${esc(code)}</span>
                      </td>
                    </tr>
                  </table>`;
}
