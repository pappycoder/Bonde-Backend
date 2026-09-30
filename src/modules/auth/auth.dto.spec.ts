import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RefreshDto } from './auth.dto.js';

/** Mirrors main.ts's `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })`. */
async function errorsFor(refreshToken: unknown) {
  return validate(plainToInstance(RefreshDto, { refreshToken }));
}

describe('RefreshDto', () => {
  // The refresh token is opaque and provider-owned. GoTrue's current tokens
  // come back around 12 characters, so the 20-character minimum that used to
  // sit here 400'd every real refresh before the request reached the provider.
  // The e2e suite missed it because its fake token was `rt-<email>`, long
  // enough to clear the old floor.
  it("accepts GoTrue's current short refresh token", async () => {
    expect(await errorsFor('Ab3-x9Yt2Qp1')).toEqual([]);
  });

  it('still rejects a missing token', async () => {
    const errors = await errorsFor('');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('refreshToken');
  });
});
