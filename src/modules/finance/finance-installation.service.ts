import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class FinanceInstallation implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}
  async onModuleInit() {
    const c = this.config.get('finance');
    if (!c.enabled) return;
    await this.prisma.financeInstallation.createMany({
      data: [{ id: 'installation', environment: c.environment }],
      skipDuplicates: true,
    });
    const installation = await this.prisma.financeInstallation.findUniqueOrThrow({
      where: { id: 'installation' },
    });
    if (installation.environment !== c.environment)
      throw new Error(
        'Finance environment does not match this database. Use a separate database for sandbox and production.',
      );
  }
}
