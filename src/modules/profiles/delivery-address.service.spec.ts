import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DeliveryAddressService } from './delivery-address.service.js';
import { DeliveryAddressDto, deliveryAddressSelect } from './delivery-address.dto.js';

const address = {
  street: '10 Test Road',
  addressLine2: '',
  city: 'London',
  region: 'London',
  country: 'United Kingdom',
  postalCode: 'SW1A 1AA',
};
function setup() {
  const prisma = {
    profile: {
      findUnique: vi.fn(async () => ({
        fullName: 'Amina Sule',
        phone: '+2348000000001',
        deliveryAddress: address,
      })),
    },
    deliveryAddress: { upsert: vi.fn(async () => address) },
  };
  return { prisma, service: new DeliveryAddressService(prisma as never) };
}
describe('delivery addresses', () => {
  it('reads only the current owner and returns structured recipient details', async () => {
    const { service, prisma } = setup();
    expect(await service.context('owner')).toEqual({
      deliveryAddress: address,
      recipient: { name: 'Amina Sule', phone: '+2348000000001' },
    });
    expect(prisma.profile.findUnique).toHaveBeenCalledWith({
      where: { id: 'owner' },
      select: { fullName: true, phone: true, deliveryAddress: { select: deliveryAddressSelect } },
    });
  });
  it('returns null for an existing profile without an address', async () => {
    const { service, prisma } = setup();
    prisma.profile.findUnique.mockResolvedValue({
      fullName: 'Amina',
      phone: null,
      deliveryAddress: null,
    } as never);
    expect(await service.get('owner')).toBeNull();
  });
  it('rejects a missing profile without creating an address', async () => {
    const { service, prisma } = setup();
    prisma.profile.findUnique.mockResolvedValue(null as never);
    await expect(service.save('missing', address)).rejects.toThrow('Profile not found');
    expect(prisma.deliveryAddress.upsert).not.toHaveBeenCalled();
  });
  it('replaces only the owner address and retains textual postal codes', async () => {
    const { service, prisma } = setup();
    await service.save('owner', { ...address, postalCode: '00100' });
    expect(prisma.deliveryAddress.upsert).toHaveBeenCalledWith({
      where: { userId: 'owner' },
      create: { userId: 'owner', ...address, postalCode: '00100' },
      update: { ...address, postalCode: '00100' },
      select: deliveryAddressSelect,
    });
  });
});
describe('delivery address validation', () => {
  it('trims fields and defaults omitted optional address lines to empty strings', async () => {
    const dto = plainToInstance(DeliveryAddressDto, {
      street: ' 10 Test Road ',
      city: ' Lagos ',
      region: ' Lagos ',
      country: ' Nigeria ',
    });
    expect(await validate(dto)).toEqual([]);
    expect(dto).toMatchObject({
      street: '10 Test Road',
      country: 'Nigeria',
      addressLine2: '',
      postalCode: '',
    });
  });
  it.each(['street', 'city', 'region', 'country'])('requires %s', async (field) => {
    const dto = plainToInstance(DeliveryAddressDto, { ...address, [field]: ' ' });
    expect((await validate(dto)).map((e) => e.property)).toContain(field);
  });
  it.each([
    { street: 'x'.repeat(256) },
    { city: 'x'.repeat(101) },
    { country: 42 },
    { postalCode: 12345 },
    { addressLine2: null },
    { postalCode: 'x'.repeat(33) },
  ])('rejects invalid address fields %j', async (invalid) => {
    expect(
      await validate(plainToInstance(DeliveryAddressDto, { ...address, ...invalid })),
    ).not.toEqual([]);
  });
  it('rejects an owner supplied by the caller', async () => {
    expect(
      await validate(plainToInstance(DeliveryAddressDto, { ...address, userId: 'other' }), {
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    ).not.toEqual([]);
  });
});
