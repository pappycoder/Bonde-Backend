import { esc } from './parts.js';

/**
 * A big, spaced-out digits block for one-time codes. Letters are spread so the
 * user can read them back, in a light bordered box matching the card style.
 */
export function codeBox(code: string): string {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td align="center" style="background-color:#FBFBFC;border:1px solid #E8EAEF;border-radius:12px;padding:22px 16px">
          <span style="font-family:'SF Mono',ui-monospace,Menlo,Consolas,monospace;font-size:30px;font-weight:600;color:#101828;letter-spacing:12px;padding-left:12px">${esc(code)}</span>
        </td>
      </tr>
    </table>`;
}
