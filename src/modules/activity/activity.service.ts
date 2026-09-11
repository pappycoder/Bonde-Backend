import { Injectable } from '@nestjs/common';
import { NotificationType, Prisma } from '@prisma/client';
import { AuditLogService, type AuditLogEntryInput } from '../audit/audit-log.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';

export interface ActivityNotification {
  type?: NotificationType;
  title: string;
  content: string;
}

export interface ActivityEntry extends Omit<AuditLogEntryInput, 'userId'> {
  /** Actor. Unlike AuditLogEntryInput, always present here. */
  userId: string;
  /** When supplied, also pushes an in-app notification into the user's feed. */
  notify?: ActivityNotification;
}

/**
 * One-call wrapper used by feature mutations: always records the append-only
 * audit entry and, when `notify` is supplied, creates an in-app notification
 * for the acting user. Audit-only call sites (admin CRUD, auth provisioning,
 * chats) keep using `AuditLogService` directly.
 */
@Injectable()
export class ActivityService {
  constructor(
    private readonly audit: AuditLogService,
    private readonly notifications: NotificationsService,
  ) {}

  async record(entry: ActivityEntry): Promise<void> {
    const { notify, ...auditEntry } = entry;
    await this.audit.record(auditEntry);
    if (notify) {
      await this.notifications.create({
        targetUserId: entry.userId,
        title: notify.title,
        content: notify.content,
        type: notify.type ?? NotificationType.SYSTEM,
        metadata: {
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
        } satisfies Prisma.InputJsonValue,
      });
    }
  }
}
