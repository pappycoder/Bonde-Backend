import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { JoinWaitlistDto } from './marketing.dto.js';

const details = {
  email: 'ada@example.com',
  firstName: 'Ada',
  lastName: 'Okafor',
  phone: '08012345678',
};

async function errors(body: Record<string, unknown>) {
  return validate(plainToInstance(JoinWaitlistDto, body));
}

describe('JoinWaitlistDto', () => {
  it.each(['email', 'firstName', 'lastName', 'phone'])('requires %s', async (field) => {
    const body: Record<string, unknown> = { ...details };
    delete body[field];
    expect((await errors(body)).map((error) => error.property)).toContain(field);
  });

  it.each(['08012345678', '+2348012345678', '(080) 1234-5678', '+234 (801) 234-5678'])(
    'accepts %s',
    async (phone) => {
      expect(await errors({ ...details, phone })).toEqual([]);
    },
  );

  it('trims names, normalizes email and preserves local leading zeroes', async () => {
    const dto = plainToInstance(JoinWaitlistDto, {
      ...details,
      firstName: ' Ada ',
      lastName: ' Okafor ',
      email: ' Ada@Example.com ',
      phone: '(080) 1234-5678',
    });
    expect(await validate(dto)).toEqual([]);
    expect(dto).toMatchObject(details);
  });

  it.each([
    { firstName: ' ' },
    { lastName: '' },
    { firstName: 'a'.repeat(256) },
    { lastName: 'a'.repeat(256) },
    { firstName: 123 },
    { lastName: ['Ada'] },
    { firstName: null },
    { phone: '123456' },
    { phone: '+1234567890123456' },
    { phone: '080letters123' },
    { phone: '++2348012345678' },
    { phone: 8012345678 },
    { phone: null },
    { email: 'invalid' },
  ])('rejects invalid details %j', async (invalid) => {
    expect(await errors({ ...details, ...invalid })).not.toEqual([]);
  });

  it('accepts names at the maximum length', async () => {
    expect(
      await errors({ ...details, firstName: 'A'.repeat(255), lastName: 'B'.repeat(255) }),
    ).toEqual([]);
  });
});
