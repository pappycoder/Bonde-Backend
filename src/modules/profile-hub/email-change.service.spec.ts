import { describe, expect, it, vi } from 'vitest';
import { EmailChangeService } from './email-change.service.js';
function setup() {
  const db = {
    profile: {
      findUnique: vi.fn(async () => null),
      update: vi.fn(async ({ data }) => ({ email: data.email })),
    },
  };
  const passcode = { validate: vi.fn(async () => undefined) };
  const auth = {
    requestEmailChange: vi.fn(async () => undefined),
    getUser: vi.fn(async () => ({
      id: 'owner',
      email: 'verified@example.com',
      emailConfirmed: true,
    })),
  };
  return {
    db,
    auth,
    passcode,
    service: new EmailChangeService(db as never, passcode as never, auth as never),
  };
}
describe('Email changes', () => {
  it('requests provider confirmation without changing the stored email', async () => {
    const f = setup();
    expect(await f.service.request('owner', 'bearer', 'NEW@example.com', '1234')).toEqual({
      confirmationRequired: true,
    });
    expect(f.auth.requestEmailChange).toHaveBeenCalledWith('bearer', 'new@example.com');
    expect(f.db.profile.update).not.toHaveBeenCalled();
  });
  it('synchronizes only the provider’s confirmed email for the same identity', async () => {
    const f = setup();
    f.auth.getUser.mockResolvedValueOnce({
      id: 'owner',
      email: 'pending@example.com',
      emailConfirmed: false,
    });
    await expect(f.service.sync('owner')).rejects.toThrow('Confirm');
    f.auth.getUser.mockResolvedValueOnce({
      id: 'foreign',
      email: 'foreign@example.com',
      emailConfirmed: true,
    });
    await expect(f.service.sync('owner')).rejects.toThrow();
    expect(f.db.profile.update).not.toHaveBeenCalled();
    expect(await f.service.sync('owner')).toEqual({ email: 'verified@example.com' });
  });
});
