import { describe, expect, it, vi } from 'vitest';
import { NotificationType } from '@prisma/client';
import { ActivityService } from './activity.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ENTITY_ID = '22222222-2222-4222-8222-222222222222';

const BASE_ENTRY = {
  userId: USER_ID,
  action: 'card.update',
  entityType: 'card',
  entityId: ENTITY_ID,
};

function makeService() {
  const audit = { record: vi.fn(async () => undefined) };
  const notifications = { create: vi.fn(async () => undefined) };
  const service = new ActivityService(audit as never, notifications as never);
  return { service, audit, notifications };
}

describe('ActivityService.record', () => {
  it('forwards the entry to the audit trail and skips notifications when notify is omitted', async () => {
    const { service, audit, notifications } = makeService();
    await service.record(BASE_ENTRY);

    expect(audit.record).toHaveBeenCalledWith(BASE_ENTRY);
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('records the audit entry plus a SYSTEM notification by default', async () => {
    const { service, audit, notifications } = makeService();
    await service.record({ ...BASE_ENTRY, notify: { title: 'Card updated', content: 'Done.' } });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'card.update', entityType: 'card', entityId: ENTITY_ID }),
    );
    expect(notifications.create).toHaveBeenCalledWith({
      targetUserId: USER_ID,
      title: 'Card updated',
      content: 'Done.',
      type: NotificationType.SYSTEM,
      metadata: { action: 'card.update', entityType: 'card', entityId: ENTITY_ID },
    });
  });

  it('honours an explicit notification type and keeps audit metadata out of the notification', async () => {
    const { service, notifications } = makeService();
    await service.record({
      ...BASE_ENTRY,
      metadata: { amount: '2500.00' },
      notify: { type: NotificationType.TRANSACTION, title: 'Tx', content: 'Recorded.' },
    });

    expect(notifications.create).toHaveBeenCalledWith({
      targetUserId: USER_ID,
      title: 'Tx',
      content: 'Recorded.',
      type: NotificationType.TRANSACTION,
      metadata: { action: 'card.update', entityType: 'card', entityId: ENTITY_ID },
    });
  });
});
