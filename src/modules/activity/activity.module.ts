import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit/audit-log.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ActivityService } from './activity.service.js';

/**
 * Composes audit + in-app notifications into one call for feature mutations.
 * `record(...)` always writes the append-only audit entry and, when `notify`
 * is supplied, also pushes a notification into the acting user's feed.
 */
@Module({
  imports: [AuditLogModule, NotificationsModule],
  providers: [ActivityService],
  exports: [ActivityService],
})
export class ActivityModule {}
