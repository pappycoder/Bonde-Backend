import { mailAssets } from './assets/index.js';
import { brandLinks } from './links.js';
import { esc } from './parts.js';
import { brand, font } from './theme.js';

/**
 * Footer band: wordmark, legal line, social icons, and a support link.
 *
 * Rendered on every email and driven entirely by `links.ts`, so no template
 * has to pass footer data. The orange disc behind each glyph is a table cell
 * rather than a `border-radius`, because Outlook's Word engine ignores
 * `border-radius` entirely and would otherwise render a bare glyph.
 */
export function emailFooter(): string {
  const socialIcon = (href: string, asset: string, alt: string): string => `
                    <td style="padding:0 4px">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                        <tr>
                          <td align="center" bgcolor="${brand.orange}"
                              width="28" height="28"
                              style="width:28px;height:28px;background-color:${brand.orange};border-radius:50%;text-align:center">
                            <a href="${esc(href)}" target="_blank"
                               style="display:block;width:28px;height:28px;text-decoration:none">
                              <img src="${asset}" alt="${esc(alt)}" width="14" height="14"
                                   style="display:block;width:14px;height:14px;margin:7px auto 0;border:0;outline:none;text-decoration:none" />
                            </a>
                          </td>
                        </tr>
                      </table>
                    </td>`;

  return `
            <tr>
              <td class="email-footer" align="center" bgcolor="${brand.tint}"
                  style="padding:28px 24px;background-color:${brand.tint};text-align:center">
                <img src="${mailAssets.logo.dataUri}" alt="Bonde" width="104" height="33"
                     style="display:block;width:104px;height:33px;margin:0 auto 16px;border:0;outline:none;text-decoration:none" />
                <p class="email-muted" style="margin:0 0 18px;font-size:11px;line-height:1.6;font-family:${font.sans};color:${brand.muted}">
                  &copy; ${brandLinks.copyrightYear} ${esc(brandLinks.legalEntity)}.<br />
                  All rights reserved.
                </p>
                <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 18px">
                  <tr>${[
                    socialIcon(
                      brandLinks.social.linkedin,
                      mailAssets.socialLinkedIn.dataUri,
                      mailAssets.socialLinkedIn.alt,
                    ),
                    socialIcon(
                      brandLinks.social.x,
                      mailAssets.socialX.dataUri,
                      mailAssets.socialX.alt,
                    ),
                    socialIcon(
                      brandLinks.social.instagram,
                      mailAssets.socialInstagram.dataUri,
                      mailAssets.socialInstagram.alt,
                    ),
                  ].join('')}
                  </tr>
                </table>
                <p style="margin:0;font-size:12px;line-height:1.6;font-family:${font.sans};color:${brand.muted}">
                  Need help?
                  <a class="email-link" href="${esc(brandLinks.supportUrl)}" target="_blank"
                     style="color:${brand.orange};font-weight:600;text-decoration:none">Contact Support</a>
                </p>
              </td>
            </tr>`;
}
