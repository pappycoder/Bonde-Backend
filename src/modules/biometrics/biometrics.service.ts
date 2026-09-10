import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';

interface PagedOptions {
  page?: number;
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Self-service biometric enrollments. Only the verification public key is
 * stored — biometric data never leaves the device secure enclave. A user can
 * register one enrollment per physical deviceId.
 */
@Injectable()
export class BiometricsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, options: PagedOptions = {}) {
    const page = options.page ?? 1;
    const pageSize = Math.min(options.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const where: Prisma.BiometricDeviceWhereInput = { userId };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.biometricDevice.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.biometricDevice.count({ where }),
    ]);

    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  }

  async get(userId: string, deviceId: string) {
    const device = await this.prisma.biometricDevice.findFirst({
      where: { id: deviceId, userId },
    });
    if (!device) throw new NotFoundException('Biometric device not found');
    return device;
  }

  async create(
    userId: string,
    dto: { deviceId: string; deviceName: string; biometricType: string; publicKey: string },
  ) {
    try {
      return await this.prisma.biometricDevice.create({
        data: {
          id: randomUUID(),
          userId,
          deviceId: dto.deviceId,
          deviceName: dto.deviceName,
          biometricType: dto.biometricType as never,
          publicKey: dto.publicKey,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('This device is already enrolled');
      }
      throw error;
    }
  }

  async update(userId: string, deviceId: string, dto: { deviceName?: string; isActive?: boolean }) {
    await this.get(userId, deviceId);
    const data: Prisma.BiometricDeviceUpdateInput = {};
    if (dto.deviceName !== undefined) data.deviceName = dto.deviceName;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    return this.prisma.biometricDevice.update({ where: { id: deviceId }, data });
  }

  async remove(userId: string, deviceId: string) {
    await this.get(userId, deviceId);
    await this.prisma.biometricDevice.delete({ where: { id: deviceId } });
    return { deleted: true as const, id: deviceId };
  }
}
