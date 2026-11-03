import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateDeliveryAddressDto,
  DeliveryAddressInputDto,
  deliveryAddressSelect,
} from './delivery-address.dto.js';
import { DeliveryAddressService, MAX_SAVED_ADDRESSES } from './delivery-address.service.js';

const address = {
  recipientName: 'Abiodun Oseni',
  recipientPhone: '09034688362',
  street: '10 Test Road',
  addressLine2: '',
  city: 'Lagos',
  region: 'Lagos',
  lga: 'Ikorodu',
  country: 'Nigeria',
  postalCode: '00100',
};
const savedRow = { id: 'addr-1', ...address, isDefault: true };

function setup() {
  const prisma = {
    profile: {
      findUnique: vi.fn(async () => ({
        fullName: 'Amina Sule',
        phone: '+2348000000001',
        deliveryAddresses: [savedRow],
      })),
    },
    deliveryAddress: {
      findMany: vi.fn(async () => [savedRow]),
      findFirst: vi.fn(async () => savedRow),
      count: vi.fn(async () => 1),
      create: vi.fn(async () => savedRow),
      update: vi.fn(async () => savedRow),
      updateMany: vi.fn(async () => ({ count: 1 })),
      delete: vi.fn(async () => undefined),
    },
    $transaction: vi.fn(async (fn: (tx: never) => Promise<unknown>) => fn(prisma as never)),
  };
  return { prisma, service: new DeliveryAddressService(prisma as never) };
}

describe('delivery address context', () => {
  it('reads only the owner default and prefers the address recipient', async () => {
    const { service, prisma } = setup();
    expect(await service.context('owner')).toEqual({
      deliveryAddress: savedRow,
      recipient: { name: 'Abiodun Oseni', phone: '09034688362' },
    });
    expect(prisma.profile.findUnique).toHaveBeenCalledWith({
      where: { id: 'owner' },
      select: {
        fullName: true,
        phone: true,
        deliveryAddresses: {
          select: deliveryAddressSelect,
          orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
          take: 1,
        },
      },
    });
  });
  it('falls back to profile details when a migrated row has no recipient', async () => {
    const { service, prisma } = setup();
    prisma.profile.findUnique.mockResolvedValue({
      fullName: 'Amina Sule',
      phone: '+2348000000001',
      deliveryAddresses: [{ ...savedRow, recipientName: '', recipientPhone: '' }],
    } as never);
    expect(await service.context('owner')).toMatchObject({
      recipient: { name: 'Amina Sule', phone: '+2348000000001' },
    });
  });
  it('returns a null address and profile recipient when none are saved', async () => {
    const { service, prisma } = setup();
    prisma.profile.findUnique.mockResolvedValue({
      fullName: 'Amina Sule',
      phone: null,
      deliveryAddresses: [],
    } as never);
    expect(await service.context('owner')).toEqual({
      deliveryAddress: null,
      recipient: { name: 'Amina Sule', phone: null },
    });
  });
  it('rejects a missing profile', async () => {
    const { service, prisma } = setup();
    prisma.profile.findUnique.mockResolvedValue(null as never);
    await expect(service.context('missing')).rejects.toThrow('Profile not found');
  });
});

describe('saved address management', () => {
  it('lists the owner addresses, default first then newest', async () => {
    const { service, prisma } = setup();
    expect(await service.list('owner')).toEqual([savedRow]);
    expect(prisma.deliveryAddress.findMany).toHaveBeenCalledWith({
      where: { userId: 'owner' },
      select: deliveryAddressSelect,
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    });
  });
  it('makes the first saved address the default and supplies its own id', async () => {
    const { service, prisma } = setup();
    prisma.deliveryAddress.count.mockResolvedValue(0 as never);
    await service.create('owner', { ...address, setAsDefault: false });
    const data = prisma.deliveryAddress.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ userId: 'owner', ...address, isDefault: true });
    expect(data.id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('honors setAsDefault by clearing the previous default', async () => {
    const { service, prisma } = setup();
    await service.create('owner', { ...address, setAsDefault: true });
    expect(prisma.deliveryAddress.updateMany).toHaveBeenCalledWith({
      where: { userId: 'owner' },
      data: { isDefault: false },
    });
    expect(prisma.deliveryAddress.create.mock.calls[0][0].data).toMatchObject({ isDefault: true });
  });
  it('rejects creating beyond the saved-address cap', async () => {
    const { service, prisma } = setup();
    prisma.deliveryAddress.count.mockResolvedValue(MAX_SAVED_ADDRESSES as never);
    await expect(service.create('owner', address)).rejects.toThrow('at most 10');
    expect(prisma.deliveryAddress.create).not.toHaveBeenCalled();
  });
  it('updates only an owned address with the supplied fields', async () => {
    const { service, prisma } = setup();
    await service.update('owner', 'addr-1', address);
    expect(prisma.deliveryAddress.findFirst).toHaveBeenCalledWith({
      where: { id: 'addr-1', userId: 'owner' },
    });
    expect(prisma.deliveryAddress.update).toHaveBeenCalledWith({
      where: { id: 'addr-1' },
      data: address,
      select: deliveryAddressSelect,
    });
  });
  it('answers 404 for an address the caller does not own', async () => {
    const { service, prisma } = setup();
    prisma.deliveryAddress.findFirst.mockResolvedValue(null as never);
    await expect(service.update('other', 'addr-1', address)).rejects.toThrow('not found');
    await expect(service.remove('other', 'addr-1')).rejects.toThrow('not found');
    expect(prisma.deliveryAddress.update).not.toHaveBeenCalled();
    expect(prisma.deliveryAddress.delete).not.toHaveBeenCalled();
  });
  it('promotes a survivor when the default is deleted', async () => {
    const { service, prisma } = setup();
    await service.remove('owner', 'addr-1');
    expect(prisma.deliveryAddress.delete).toHaveBeenCalledWith({ where: { id: 'addr-1' } });
    expect(prisma.deliveryAddress.update).toHaveBeenCalledWith({
      where: { id: 'addr-1' },
      data: { isDefault: true },
    });
  });
  it('keeps the default untouched when a non-default address is deleted', async () => {
    const { service, prisma } = setup();
    prisma.deliveryAddress.findFirst.mockResolvedValue({ ...savedRow, isDefault: false } as never);
    await service.remove('owner', 'addr-1');
    expect(prisma.deliveryAddress.update).not.toHaveBeenCalled();
  });
  it('moves the default flag to the chosen address', async () => {
    const { service, prisma } = setup();
    await service.makeDefault('owner', 'addr-1');
    expect(prisma.deliveryAddress.updateMany).toHaveBeenCalledWith({
      where: { userId: 'owner' },
      data: { isDefault: false },
    });
    expect(prisma.deliveryAddress.update).toHaveBeenCalledWith({
      where: { id: 'addr-1' },
      data: { isDefault: true },
      select: deliveryAddressSelect,
    });
  });
});

describe('delivery address validation', () => {
  it('trims fields and defaults omitted optional address lines to empty strings', async () => {
    const dto = plainToInstance(DeliveryAddressInputDto, {
      recipientName: ' Abiodun Oseni ',
      recipientPhone: ' 09034688362 ',
      street: ' 10 Test Road ',
      city: ' Lagos ',
      region: ' Lagos ',
      lga: ' Ikorodu ',
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
  it.each(['recipientName', 'recipientPhone', 'street', 'city', 'region', 'lga', 'country'])(
    'requires %s',
    async (field) => {
      const dto = plainToInstance(DeliveryAddressInputDto, { ...address, [field]: ' ' });
      expect((await validate(dto)).map((e) => e.property)).toContain(field);
    },
  );
  it.each([
    { recipientPhone: 'not-a-phone' },
    { recipientPhone: '090' },
    { recipientPhone: '+234800000000112233445' },
    { street: 'x'.repeat(256) },
    { city: 'x'.repeat(101) },
    { lga: 42 },
    { country: 42 },
    { postalCode: 12345 },
    { addressLine2: null },
    { postalCode: 'x'.repeat(33) },
  ])('rejects invalid address fields %j', async (invalid) => {
    expect(
      await validate(plainToInstance(DeliveryAddressInputDto, { ...address, ...invalid })),
    ).not.toEqual([]);
  });
  it('rejects a caller-supplied owner or row id', async () => {
    expect(
      await validate(plainToInstance(DeliveryAddressInputDto, { ...address, userId: 'other' }), {
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    ).not.toEqual([]);
    expect(
      await validate(plainToInstance(DeliveryAddressInputDto, { ...address, isDefault: true }), {
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    ).not.toEqual([]);
  });
  it('accepts an explicit setAsDefault only on create', async () => {
    expect(
      await validate(
        plainToInstance(CreateDeliveryAddressDto, { ...address, setAsDefault: true }),
        {
          whitelist: true,
          forbidNonWhitelisted: true,
        },
      ),
    ).toEqual([]);
  });
});
