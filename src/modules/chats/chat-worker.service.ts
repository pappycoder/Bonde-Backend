import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { shouldRunBackgroundJobs } from '../../common/runtime.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ChatRepliesService } from './chat-replies.service.js';

@Injectable()
export class ChatWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly replies: ChatRepliesService,
  ) {}
  onModuleInit() {
    if (!shouldRunBackgroundJobs()) return;
    this.timer = setInterval(() => void this.run().catch(() => undefined), 5000);
    this.timer.unref();
  }
  onModuleDestroy() {
    clearInterval(this.timer);
  }
  async run() {
    if (this.running) return;
    this.running = true;
    try {
      const queued = await this.prisma.aiChatTurn.findMany({
        where: { status: 'RESERVED', leaseUntil: { gt: new Date() } },
        take: 5,
        orderBy: { createdAt: 'asc' },
      });
      await Promise.allSettled(
        queued.map((t) => this.replies.respond(t.userId, t.chatId, t.messageId)),
      );
    } finally {
      this.running = false;
    }
  }
}
