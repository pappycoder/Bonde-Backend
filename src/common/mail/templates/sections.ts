import { codeBox } from './code-box.js';
import { esc } from './parts.js';
import { brand, font } from './theme.js';

/**
 * A declarative description of an email body.
 *
 * Renderers return a list of these instead of hand-concatenating HTML, so
 * every Bonde email is assembled the same way and a new block is a one-line
 * addition. All user-controlled text passes through `esc()` here, which is the
 * single chokepoint keeping a name or a code from breaking out of the markup.
 *
 * Every coloured element carries a class as well as its inline colour: the
 * inline value is the light-mode default for clients that ignore `<style>`, and
 * the class is the hook `layout.ts` needs to repaint it in dark mode.
 */
export type EmailSection =
  | { kind: 'lead'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'code'; code: string }
  | { kind: 'facts'; rows: EmailFact[] }
  | { kind: 'bullets'; items: string[] }
  /**
   * A text link. Used where the link *is* the content (the invite join URL) —
   * not a styled CTA button, which this design system does not use.
   */
  | { kind: 'link'; text: string; url: string }
  | { kind: 'divider' };

/** One label/value pair. A nullish value renders as an em dash. */
export interface EmailFact {
  label: string;
  value: string | null | undefined;
}

/** Renders one section to HTML. */
export function renderSection(section: EmailSection): string {
  switch (section.kind) {
    case 'lead':
      return `<p class="email-muted" style="margin:0 0 20px;font-size:15px;line-height:1.6;font-family:${font.sans};color:${brand.muted}">${esc(section.text)}</p>`;

    case 'paragraph':
      return `<p class="email-ink" style="margin:0 0 16px;font-size:15px;line-height:1.6;font-family:${font.sans};color:${brand.ink}">${esc(section.text)}</p>`;

    case 'note':
      return `<p class="email-muted" style="margin:0;font-size:13px;line-height:1.5;font-family:${font.sans};color:${brand.muted}">${esc(section.text)}</p>`;

    case 'code':
      return codeBox(section.code);

    case 'facts':
      return factsTable(section.rows);

    case 'bullets':
      return `<ul class="email-ink" style="margin:0 0 4px;padding:0 0 0 20px;font-size:15px;line-height:1.7;font-family:${font.sans};color:${brand.ink}">
${section.items.map((item) => `<li style="margin:0 0 4px">${esc(item)}</li>`).join('\n')}
        </ul>`;

    case 'link':
      // `word-break` matters: join links are long and single-use, so a
      // client-side truncation would leave the recipient unable to complete
      // the action.
      return `<p style="margin:0 0 20px;font-size:15px;line-height:1.6;font-family:${font.sans};word-break:break-all;overflow-wrap:break-word">
              <a class="email-link" href="${esc(section.url)}" target="_blank"
                 style="color:${brand.orange};font-weight:600;text-decoration:none">${esc(section.text)}</a>
            </p>`;

    case 'divider':
      return `<div class="email-divider" style="height:1px;line-height:1px;font-size:0;background-color:${brand.border}">&nbsp;</div>`;
  }
}

/** Renders a whole body, joining the sections with no extra wrapper. */
export function renderSections(sections: EmailSection[]): string {
  return sections.map(renderSection).join('\n');
}

/** Two-column label/value table, used for account, card and limit details. */
function factsTable(rows: EmailFact[]): string {
  if (rows.length === 0) return '';
  const cells = rows
    .map(
      (row) => `
                    <tr>
                      <td class="email-muted" style="padding:11px 16px;border-bottom:1px solid ${brand.border};font-size:13px;line-height:1.4;font-family:${font.sans};color:${brand.muted};width:42%">${esc(row.label)}</td>
                      <td class="email-ink" style="padding:11px 16px;border-bottom:1px solid ${brand.border};font-size:15px;line-height:1.4;font-family:${font.sans};color:${brand.ink};font-weight:600">${esc(row.value ?? '—')}</td>
                    </tr>`,
    )
    .join('');
  return `
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px">
${cells}
                  </table>`;
}
