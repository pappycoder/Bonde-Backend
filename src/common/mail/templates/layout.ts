import { mailAssets } from './assets/index.js';
import { emailFooter } from './footer.js';
import { esc } from './parts.js';
import { renderSections, type EmailSection } from './sections.js';
import { brand, brandDark, CARD_WIDTH, font, header } from './theme.js';

export interface LayoutOptions {
  /** Hidden preview text shown in the inbox list. */
  preheader: string;
  /** Hero heading shown under the header banner. */
  headline: string;
  /** The email body, described as a list of blocks. */
  sections: EmailSection[];
  /** Optional friendly sender line above the headline. */
  eyebrow?: string;
}

/**
 * Dark-mode overrides. Two audiences, two syntaxes:
 *
 * - Apple Mail, iOS Mail, Outlook for Mac and Yahoo honour the media query.
 * - Outlook.com ignores `prefers-color-scheme` and instead rewrites colours,
 *   tagging every element it touched with `data-ogsc` / `data-ogsb`. Those
 *   attribute selectors are the only way to reach it.
 *
 * Gmail honours neither. It applies its own forced-dark transform, which is
 * why every light value is inlined on the elements themselves below — with the
 * near-black header and warm tint, its inversion lands close enough to the
 * intent that nothing is lost.
 *
 * `!important` is required: it is the only way these rules beat Gmail's
 * injected ones.
 */
const DARK_MODE_CSS = `
    @media (prefers-color-scheme: dark) {
      .email-body { background-color:${brandDark.body} !important; }
      .email-card { background-color:${brandDark.card} !important; }
      .email-title { color:${brandDark.title} !important; }
      .email-ink { color:${brandDark.title} !important; }
      .email-muted { color:${brandDark.text} !important; }
      .email-code { background-color:${brandDark.code} !important; }
      .email-footer { background-color:${brandDark.footer} !important; }
      .email-divider { background-color:#333333 !important; }
    }
    [data-ogsc] .email-body { background-color:${brandDark.body} !important; }
    [data-ogsc] .email-card { background-color:${brandDark.card} !important; }
    [data-ogsc] .email-title { color:${brandDark.title} !important; }
    [data-ogsc] .email-ink { color:${brandDark.title} !important; }
    [data-ogsc] .email-muted { color:${brandDark.text} !important; }
    [data-ogsc] .email-code { background-color:${brandDark.code} !important; }
    [data-ogsc] .email-footer { background-color:${brandDark.footer} !important; }
    [data-ogsc] .email-divider { background-color:#333333 !important; }`;

/**
 * Shared frame for every Bonde transactional email.
 *
 * Table-based with inline CSS throughout, because that is still the only thing
 * Outlook, Gmail and Apple Mail all agree on. `border-collapse: separate` plus
 * `overflow: hidden` gives the card its 16px radius and lets the black header
 * sit flush against it (Outlook drops `border-radius`, so its corners go square
 * — an accepted degradation, not a bug).
 */
export function emailLayout(options: LayoutOptions): string {
  const eyebrow = options.eyebrow
    ? `<div style="margin:0 0 10px;font-size:12px;line-height:1.4;font-weight:600;letter-spacing:1px;text-transform:uppercase;font-family:${font.sans};color:${brand.orange}">${esc(options.eyebrow)}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <!-- Without these, iOS Mail and Outlook.com recolour the whole message on
         their own and the warm tint turns muddy grey. -->
    <meta name="color-scheme" content="light dark" />
    <meta name="supported-color-schemes" content="light dark" />
    <title>${esc(options.preheader)}</title>
    <style>
      :root { color-scheme: light dark; supported-color-schemes: light dark; }
${DARK_MODE_CSS}
    </style>
  </head>
  <body class="email-body" bgcolor="${brand.body}" style="margin:0;padding:0;background-color:${brand.body};color:${brand.ink};font-family:${font.sans};-webkit-font-smoothing:antialiased;word-break:break-word;overflow-wrap:break-word">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${esc(options.preheader)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${brand.body}" style="background-color:${brand.body}">
      <tr>
        <td align="center" style="padding:40px 12px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                 class="email-card" bgcolor="${brand.card}"
                 style="width:100%;max-width:${CARD_WIDTH}px;background-color:${brand.card};border-radius:16px;overflow:hidden;border-collapse:separate;border-spacing:0">

            <tr>
              <td align="center" bgcolor="${header.solid}"
                  style="padding:40px 24px;background-color:${header.solid};background-image:linear-gradient(180deg,${header.top} 0%,${header.bottom} 100%);text-align:center">
                <img src="${mailAssets.logo.dataUri}" alt="Bonde" width="132" height="41"
                     style="display:block;width:132px;height:41px;margin:0 auto;border:0;outline:none;text-decoration:none" />
              </td>
            </tr>

            <tr>
              <td class="email-card" bgcolor="${brand.card}"
                  style="padding:36px 32px 32px;background-color:${brand.card};text-align:center">
                <h1 class="email-title" style="margin:0 0 12px;font-size:24px;line-height:1.3;font-weight:700;font-family:${font.sans};color:${brand.ink}">${esc(options.headline)}</h1>
                ${eyebrow}
                <div class="email-muted" style="font-family:${font.sans};color:${brand.muted}">
                  ${renderSections(options.sections)}
                </div>
              </td>
            </tr>

            ${emailFooter()}

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
