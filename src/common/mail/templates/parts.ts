/**
 * Small building blocks shared by the email templates. Everything rendered
 * into HTML passes through `esc()` so dynamic values (names, codes, account
 * numbers, merchant names) can never break out of the markup.
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

export function heading(text: string): string {
  return `<h1 style="margin:0 0 8px;font-size:26px;line-height:1.3;color:#101828;font-weight:700">${esc(text)}</h1>`;
}

export function lead(text: string): string {
  return `<p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#475467">${esc(text)}</p>`;
}

export function paragraph(text: string): string {
  return `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#344054">${esc(text)}</p>`;
}

export function infoRow(label: string, value: string | null | undefined): string {
  return `
    <tr>
      <td style="padding:10px 16px;border-top:1px solid #E8EAEF;border-bottom:1px solid #E8EAEF;font-size:13px;color:#667085;width:40%">${esc(label)}</td>
      <td style="padding:10px 16px;border-top:1px solid #E8EAEF;border-bottom:1px solid #E8EAEF;font-size:15px;color:#101828;font-weight:600">${esc(value ?? '—')}</td>
    </tr>`;
}

export function note(text: string): string {
  return `<p style="margin:20px 0 0;font-size:13px;line-height:1.5;color:#667085">${esc(text)}</p>`;
}
