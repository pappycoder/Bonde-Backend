import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  deliveryAddressSelect,
  type CreateDeliveryAddressDto,
  type DeliveryAddressInputDto,
  type DeliveryContext,
  type SavedAddressDto,
} from './delivery-address.dto.js';

/** Hard cap on saved addresses per user; the self-service list is small by design. */
export const MAX_SAVED_ADDRESSES = 10;

type AddressFields = Pick<
  Prisma.DeliveryAddressUncheckedCreateInput,
  | 'recipientName'
  | 'recipientPhone'
  | 'street'
  | 'addressLine2'
  | 'city'
  | 'region'
  | 'lga'
  | 'country'
  | 'postalCode'
>;

@Injectable()
export class DeliveryAddressService {
  constructor(private readonly prisma: PrismaService) {}

  /** The default address plus its recipient, falling back to the profile for legacy rows. */
  async context(userId: string): Promise<DeliveryContext> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: userId },
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
    if (!profile) throw new NotFoundException('Profile not found');
    const deliveryAddress: SavedAddressDto | null = profile.deliveryAddresses[0] ?? null;
    return {
      deliveryAddress,
      recipient: {
        name: deliveryAddress?.recipientName || profile.fullName,
        phone: deliveryAddress?.recipientPhone || profile.phone,
      },
    };
  }

  /** The caller's saved addresses, default first then most recently updated. */
  async list(userId: string): Promise<SavedAddressDto[]> {
    await this.context(userId);
    return this.prisma.deliveryAddress.findMany({
      where: { userId },
      select: deliveryAddressSelect,
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    });
  }

  async create(userId: string, dto: CreateDeliveryAddressDto): Promise<SavedAddressDto> {
    await this.context(userId);
    return this.prisma.$transaction(async (tx) => {
      const total = await tx.deliveryAddress.count({ where: { userId } });
      if (total >= MAX_SAVED_ADDRESSES)
        throw new ConflictException(
          `You can save at most ${MAX_SAVED_ADDRESSES} delivery addresses`,
        );
      const isDefault = total === 0 || dto.setAsDefault === true;
      if (isDefault)
        await tx.deliveryAddress.updateMany({ where: { userId }, data: { isDefault: false } });
      return tx.deliveryAddress.create({
        data: { id: randomUUID(), userId, ...fields(dto), isDefault },
        select: deliveryAddressSelect,
      });
    });
  }

  async update(userId: string, id: string, dto: DeliveryAddressInputDto): Promise<SavedAddressDto> {
    await this.getOwned(userId, id);
    return this.prisma.deliveryAddress.update({
      where: { id },
      data: fields(dto),
      select: deliveryAddressSelect,
    });
  }

  async remove(userId: string, id: string): Promise<{ deleted: true; id: string }> {
    const existing = await this.getOwned(userId, id);
    await this.prisma.deliveryAddress.delete({ where: { id } });
    if (!existing.isDefault) return { deleted: true, id };
    // Keep payment instructions deterministic: promote the newest survivor.
    const next = await this.prisma.deliveryAddress.findFirst({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    });
    if (next)
      await this.prisma.deliveryAddress.update({
        where: { id: next.id },
        data: { isDefault: true },
      });
    return { deleted: true, id };
  }

  async makeDefault(userId: string, id: string): Promise<SavedAddressDto> {
    await this.getOwned(userId, id);
    return this.prisma.$transaction(async (tx) => {
      await tx.deliveryAddress.updateMany({ where: { userId }, data: { isDefault: false } });
      return tx.deliveryAddress.update({
        where: { id },
        data: { isDefault: true },
        select: deliveryAddressSelect,
      });
    });
  }

  /** Ownership check that never leaks existence: foreign and unknown ids both 404. */
  private async getOwned(userId: string, id: string) {
    const address = await this.prisma.deliveryAddress.findFirst({ where: { id, userId } });
    if (!address) throw new NotFoundException('Delivery address not found');
    return address;
  }
}

/** Strip non-column members (e.g. `setAsDefault`) before writing. */
function fields(dto: DeliveryAddressInputDto): AddressFields {
  const {
    recipientName,
    recipientPhone,
    street,
    addressLine2,
    city,
    region,
    lga,
    country,
    postalCode,
  } = dto;
  return {
    recipientName,
    recipientPhone,
    street,
    addressLine2,
    city,
    region,
    lga,
    country,
    postalCode,
  };
}
