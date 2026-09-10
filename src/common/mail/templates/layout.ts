import { brand, logoDataUri } from './assets/logo.js';

export interface LayoutOptions {
  /** Hidden preview text shown in the inbox list. */
  preheader: string;
  /** Hero heading shown under the logo. */
  headline: string;
  /** Rendered section HTML (hero + body + any code box / rows). */
  body: string;
  /** Optional friendly sender line above the headline. */
  eyebrow?: string;
}

const HEADER = `
    <tr>
      <td align="center" style="padding:36px 24px 12px;background-color:${brand.card}">
        <img src="${logoDataUri}" alt="Bonde" width="132" height="41"
             style="display:block;width:132px;height:41px;border:0;outline:none;text-decoration:none" />
      </td>
    </tr>`;

/**
 * Shared frame for every Bonde transactional email. Table-based + inline-CSS
 * for email-client compatibility, max-width 600px, mobile friendly. The logo
 * is a transparent data-URI (no external fetch), orange wordmark on white.
 */
export function emailLayout(options: LayoutOptions): string {
  const eyebrow = options.eyebrow
    ? `<div style="font-size:12px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:${brand.orange};margin:0 0 10px">${options.eyebrow}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <title>${options.preheader}</title>
  </head>
  <body style="margin:0;padding:0;background-color:${brand.soft};color:${brand.ink};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${options.preheader}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${brand.soft}">
      <tr>
        <td align="center" style="padding:24px 12px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%">
            ${HEADER}
            <tr>
              <td style="background-color:${brand.card};padding:24px 32px 20px;border:1px solid ${brand.border};border-top:0;border-radius:0 0 16px 16px;box-shadow:0 10px 30px rgba(16,24,40,0.04)">
                <div style="font-size:26px;line-height:1.3;font-weight:700;color:${brand.ink};margin:0 0 8px">${options.headline}</div>
                ${eyebrow}
                ${options.body}
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:22px 24px 8px;font-size:12px;line-height:1.6;color:#98A2B3">
                Bonde — your money, your way.<br />
                Have questions? Reply to this email and we’ll help.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
