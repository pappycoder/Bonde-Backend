/**
 * Footer social glyphs: white marks on a transparent background, rendered at
 * 2x (56x56) for the 28px circles in the footer. Committed as base64 data URIs
 * so the footer works with zero external requests out of the box — Gmail and
 * Outlook strip `data:` images, so `MailService` rewrites them to
 * `${MAIL_ASSET_BASE_URL}/<file>` when that base URL is configured.
 *
 * Regenerate with `scripts/build-mail-assets.mjs` (no extra dependencies).
 */
const linkedInDataUri =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADgAAAA4CAYAAACohjseAAABFklEQVR42u3a6wmEMBAEYEuwhCvBEq4kS0gnlmAJKSElWMKW' +
  'MIeQ4yQELz7A7GYG8kuUfGSVqNt1jPEA6AGMAGYAgucjcS7rnPqrMFcJag/rDkMBDAAC9GSd63AEJ9AX+YuMZRmgN2G3XGM9' +
  'a4/bWz0xAJTsKsbHrpWMOeBsCDjngGfLc4n3rq+pTHPAy/VeE/IuoK/1KXznCg6WV/CL9PFehEVglSGQwF/em5Fu1Kfk+Jkx' +
  'PQpMruGLNr7H3k0dgQQSSCCBBBKoABgnWzJeWoHF2z8CCSSQQAIJJJBAAgksiN+M9BfckhwvTdicszwNVPPhVwz5pMlf2Oab' +
  'EGy3kZhvBGqilct8M14T7ZRNNMQ20dLMKMkHKeRCF1v0b80AAAAASUVORK5CYII=';

const xDataUri =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADgAAAA4CAYAAACohjseAAAA9UlEQVR42u2agQ3DIAwEGSUjMAKjsFlGZISvKqWqVKWKiAHb' +
  'H98A8Z9CCBhSCoIgCAIZADKAAmAzkGU7suRRD9zxpQGoinL1yPBhH/HmzqhKcmdkyUML/lMNyL0p0vHeNCUv5Jp4XrgoMFVy' +
  'WW0NyeU1VxZUGzUrCmt+EtMDqMvNDGJGbkYgc3Ijg5mVGxHQvJwkqBu5O4HdyfUEdyvXIelXTijpQ+6mpC+5TkmfcvSC1EOU' +
  'epKh/k1Q/+ipl2rUi23q7RL1hpe6ZUHddKJuG1I3fqlb99SHL9THZ/QHoE84wua+hJDYr5H8vEnOi0BBEATBk3kBDvXxQB9M' +
  'c2cAAAAASUVORK5CYII=';

const instagramDataUri =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADgAAAA4CAYAAACohjseAAABpklEQVR42u1abRGEIBA1ghGIYAQiGIEINjECEYxghItwEYzw' +
  'bpzhh+eAuoCAuG/mfp2y+9xlv6BpGAwGo0QAkABGADOABfGxmLVXGTIlMQXgi/RYZao7iXUAPsiPVYcuNrn+JjcMcd8+JjkX' +
  'tPlf3OAxwqytD+T3MdzSZrnpDlInZCeHJbuQhW17TmWM3Mq2J2MuphJaTNyqlyUVTInIbfecdjyzd9evTxLfQySy3Klcx3OS' +
  'ImjcR8uErnnpw1qi60gRNEcNx5Fd1JG+ZoqQJbV7Xg0yB9ZeKAL+UHDB76dnTILmSw/G7be/IdQzshIE0J6UWdtyr30UQY/O' +
  'w6tDyELQWO7j2Qa1TyCoXc2qKSDkQdOsiyboSNSa+DFEyQQHao1oseRQMsGZWuVbuoP5SQTlhXckE2QX5SDDaYIT/WtKteqL' +
  '7Ve0S69oeEsfWWQdOnmmJNLQKdvYkKBj0Ngwy+A3MN+SBr9ZRveBFZOkLpLl8OWibmGHL03m47NkelV9ANq84Qi7qf0Swo5k' +
  'nddIAjqE51wEsmz0+q5yOYqB+i7jMRgMBgU/KJ1wiKtxe7wAAAAASUVORK5CYII=';

export const socialDataUris = {
  linkedin: linkedInDataUri,
  x: xDataUri,
  instagram: instagramDataUri,
} as const;
