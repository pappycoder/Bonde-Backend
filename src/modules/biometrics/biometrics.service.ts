import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { parsePaging, toPageResult } from '../../common/paging/paging.js';
import {
  buildFilterWhere,
  type FilterFieldSpec,
  parseFilterEntries,
} from '../../common/paging/filter.js';
import { qWhere } from '../../common/paging/search.js';
import { PrismaService } from '../../prisma/prisma.service.js';

interface PagedOptions {
  page?: number;
  pageSize?: number;
  q?: string;
  filter?: string | string[];
}

const BIOMETRIC_FILTER_FIELDS: Record<string, FilterFieldSpec> = {
  biometricType: { kind: 'enum' },
  isActive: { kind: 'boolean' },
};

/**
 * Self-service biometric enrollments. Only the verification public key is
 * stored — biometric data never leaves the device secure enclave. A user can
 * register one enrollment per physical deviceId.
 */
@Injectable()
export class BiometricsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, options: PagedOptions = {}) {
    const { page, pageSize, skip, take } = parsePaging(options.page, options.pageSize);
    const where = {
      userId,
      ...buildFilterWhere(parseFilterEntries(options.filter), BIOMETRIC_FILTER_FIELDS),
      ...qWhere(options.q, ['deviceName', 'deviceId']),
    } as Prisma.BiometricDeviceWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.biometricDevice.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.biometricDevice.count({ where }),
    ]);

    return toPageResult(items, total, page, pageSize);
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
