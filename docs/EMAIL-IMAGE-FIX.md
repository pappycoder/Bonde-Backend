# Email image compatibility — 23 October 2026

The existing 560px layout, colours, typography, message copy and links remain in place. No provider or authentication flow changed.

## Findings and cause

Inspected all nine template renderers (including both verification purposes), shared layout/footer, source PNGs, asset generator, public website configuration, backend environment configuration and Resend delivery code. Compared ChurchOS's `company-email.templates.ts` white presentation-table logo container.

All existing email graphics were already standard `<img>` PNGs; there were no React icons, inline SVGs, icon fonts or masks to replace. However, templates emitted base64 data URLs and delivery only replaced them when optional hosting configuration was present. That fallback is incompatible with clients that strip data images. Configuring only `MAIL_LOGO_URL` left social icons embedded. The local environment currently has a working `MAIL_ASSET_BASE_URL`, so this fallback does **not** establish the cause of any particular already-delivered message. Recipient-side blocking cannot be diagnosed without the received message/client settings.

The transparent orange wordmark previously sat directly on the dark header and tint/dark footer. It remains transparent against those existing surfaces, per the user’s request to remove the white backing. The social icons used CSS margin inside a fixed-height link for vertical positioning; their containing table cells now handle centring.

## Changes

- Every new template renders absolute public HTTPS PNG sources from the shared asset registry. The default folder is the existing public Supabase `logo` bucket, not a new host. `MAIL_ASSET_BASE_URL` still overrides all sources; `MAIL_LOGO_URL` remains a logo-only override when no base override is set. Social images always have public sources.
- Delivery also resolves old embedded sources, escapes URL attributes and rejects non-HTTPS, loopback, credential-bearing or query-token image URLs. Availability and access policies must still be checked when changing hosts.
- Both logo placements use transparent PNGs directly on the existing header/footer, without a white background or padded container. Widths remain 132px and 104px; automatic height preserves each PNG's proportions. Header height attribute is 42px, matching the current 200×63 hosted logo at that width.
- Social marks retain 14px image dimensions and existing 28px orange containers, links and accessible names. Important verification and support information remains text. Original embedded PNG source artifacts are retained for regeneration, never used as sources in newly rendered HTML.

## Public asset verification

Anonymous HTTPS GETs, with no cookies or credentials, returned HTTP 200, no redirect, `Content-Type: image/png`, and valid PNG signatures for every deployed URL on 23 October 2026:

| URL | Dimensions | Bytes |
| --- | --- | --- |
| https://emnfjlqdgnavrshpqqis.supabase.co/storage/v1/object/public/logo/logo.png | 200×63 | 3851 |
| https://emnfjlqdgnavrshpqqis.supabase.co/storage/v1/object/public/logo/linkedin.png | 19×19 | 274 |
| https://emnfjlqdgnavrshpqqis.supabase.co/storage/v1/object/public/logo/x.png | 18×18 | 299 |
| https://emnfjlqdgnavrshpqqis.supabase.co/storage/v1/object/public/logo/instagram.png | 19×19 | 388 |

These were image bodies, not HTML/login pages. Visual inspection confirmed a transparent orange logo and white social glyphs; the orange logo remains visible against the existing header/footer and glyphs against the existing orange cells. No asset uploads or hosting changes were needed.

## Validation and previews

- Format and lint passed; all 725 unit tests passed, including 77 focused mail tests for public sources, override precedence, unsafe URLs, explicit dimensions and transparent logos.
- `pnpm build` passed. The host uses Node 26 while this project declares Node 22.
- `pnpm check` reached e2e setup but could not complete: local Postgres at port 5433 and Redis at 6379 both refused connections; Docker Desktop's daemon socket was unavailable. No e2e success is claimed.
- `pnpm build && node scripts/preview-mail.mjs` regenerates ten standalone HTML previews with fictional data under `docs/previews/emails`.
- Chromium checked all ten samples at 375px and 720px using the exact PNG bytes fetched anonymously from the deployed URLs. All 100 image instances loaded, had matching aspect ratios, and there was no horizontal overflow. Per-template screenshots and `layout-checks.json` are in that folder. Browser previews are not an Outlook/Gmail inbox rendering test.
- Separate mobile dark-mode and blocked-image previews confirm the transparent logo appearance and the continued readability of verification/support text when images are unavailable. A recipient can still deliberately block remote images; no implementation can force every email client to load them.
- Live image-test email sent through the existing `MailService` to the authorised `lucasdeekay98@gmail.com`. Resend accepted it on 23 October 2026 at 10:06 WAT (09:06 UTC), message ID `01a16803-187b-7011-baa5-b4d2deafbe4a`. All four final PNG URLs were anonymously rechecked immediately before sending. Subject: `[Test] Bonde email image preview`. Provider acceptance does not confirm inbox delivery or remote-image loading. A copy is saved as `docs/previews/emails/live-image-test.html`. The 77 focused mail tests, lint, formatting and build passed again after removing the white logo backing. No application deployment was performed; the new templates require the normal backend deployment to affect newly sent mail. Existing delivered emails are unchanged.
