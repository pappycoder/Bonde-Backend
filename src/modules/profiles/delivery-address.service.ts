import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  deliveryAddressSelect,
  type DeliveryAddressDto,
  type DeliveryContext,
} from './delivery-address.dto.js';

@Injectable()
export class DeliveryAddressService {
  constructor(private readonly prisma: PrismaService) {}

  async context(userId: string): Promise<DeliveryContext> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: userId },
      select: { fullName: true, phone: true, deliveryAddress: { select: deliveryAddressSelect } },
    });
    if (!profile) throw new NotFoundException('Profile not found');
    return {
      deliveryAddress: profile.deliveryAddress,
      recipient: { name: profile.fullName, phone: profile.phone },
    };
  }

  async get(userId: string): Promise<DeliveryAddressDto | null> {
    return (await this.context(userId)).deliveryAddress;
  }

  async save(userId: string, address: DeliveryAddressDto): Promise<DeliveryAddressDto> {
    await this.context(userId);
    return this.prisma.deliveryAddress.upsert({
      where: { userId },
      create: { userId, ...address },
      update: address,
      select: deliveryAddressSelect,
    });
  }
}
