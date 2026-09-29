import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { BroadcastsService } from './broadcasts.service.js';

const ACTOR_ID = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

function makeHarness(activeIds: string[] = [USER_A, USER_B]) {
  const created: Array<{ data: Array<Record<string, unknown>> }> = [];
  const broadcastRows: Array<Record<string, unknown>> = [];

  const prisma = {
    profile: { findMany: vi.fn(async () => activeIds.map((id) => ({ id }))) },
    notification: {
      createMany: vi.fn(async (args: { data: Array<Record<string, unknown>> }) => {
        created.push(args);
        return { count: args.data.length };
      }),
    },
    broadcast: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        broadcastRows.push(data);
        return data;
      }),
      findMany: vi.fn(async () => [
        {
          id: 'bc-1',
          title: 'Scheduled maintenance',
          body: 'We will be down for 30 minutes.',
          recipientCount: 2,
          sentBy: ACTOR_ID,
          createdAt: new Date('2026-09-26T12:00:00.000Z'),
          sender: { fullName: 'Olivia Martin' },
        },
      ]),
      count: vi.fn(async () => 1),
    },
    $transaction: vi.fn(async (arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => unknown)(prisma)
        : Promise.all(arg as Array<Promise<unknown>>),
    ),
  };

  const audit = { record: vi.fn(async () => undefined) };
  const service = new BroadcastsService(prisma as never, audit as never);
  return { service, prisma, audit, created, broadcastRows };
}

describe('BroadcastsService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('writes one notification row per active profile inside one transaction', async () => {
    const { service, prisma, audit, created, broadcastRows } = makeHarness();

    const result = await service.send(
      { title: 'Scheduled maintenance', body: 'We will be down for 30 minutes.' },
      ACTOR_ID,
    );

    expect(result).toMatchObject({
      status: 'sent',
      recipientCount: 2,
      title: 'Scheduled maintenance',
    });
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(prisma.profile.findMany).toHaveBeenCalledWith({
      where: { emailVerified: true },
      select: { id: true },
    });

    const rows = created.flatMap((call) => call.data);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.userId).sort()).toEqual([USER_A, USER_B].sort());
    for (const row of rows) {
      expect(row).toMatchObject({
        title: 'Scheduled maintenance',
        content: 'We will be down for 30 minutes.',
        type: 'SYSTEM',
      });
      expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
      expect((row.metadata as { broadcastId: string }).broadcastId).toBe(result.id);
    }

    // Send record + every chunk land in one transaction.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const [promises] = prisma.$transaction.mock.calls[0] as [unknown[]];
    expect(promises).toHaveLength(2);
    expect(broadcastRows[0]).toMatchObject({ recipientCount: 2, sentBy: ACTOR_ID });

    expect(audit.record).toHaveBeenCalledWith({
      userId: ACTOR_ID,
      action: 'admin.broadcast.send',
      entityType: 'broadcast',
      entityId: result.id,
      metadata: { title: 'Scheduled maintenance', recipientCount: 2 },
    });
  });

  it('stays in-app: rows are bulk-inserted, never fanned out per user', async () => {
    const { service, prisma } = makeHarness();

    await service.send({ title: 'Heads up', body: 'New limits are live.' }, ACTOR_ID);

    // The fake has no `notification.create`, so a per-recipient call (the
    // push-dispatching NotificationsService.create path) would throw. Bulk
    // insert means in-app only, with no device or inbox fan-out.
    expect(prisma.notification.create).toBeUndefined();
    expect(prisma.notification.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.notification.createMany.mock.calls[0]![0]).toMatchObject({
      skipDuplicates: true,
    });
  });

  it('chunks large audiences instead of one giant statement', async () => {
    const many = Array.from({ length: 2500 }, (_, i) => `user-${i}@bonde.ai`);
    const { service, prisma } = makeHarness(many);

    const result = await service.send({ title: 'Big news', body: 'Something happened.' }, ACTOR_ID);

    expect(result.recipientCount).toBe(2500);
    expect(prisma.notification.createMany).toHaveBeenCalledTimes(3);
    const sizes = prisma.notification.createMany.mock.calls.map(
      (call) => (call[0] as { data: unknown[] }).data.length,
    );
    expect(sizes).toEqual([1000, 1000, 500]);
    // 3 chunks + the send record, still one transaction.
    const [transactionArgs] = prisma.$transaction.mock.calls[0] as [unknown[]];
    expect(transactionArgs).toHaveLength(4);
  });

  it('400s when there is nobody to reach', async () => {
    const { service, prisma, audit } = makeHarness([]);

    await expect(
      service.send({ title: 'Nobody home', body: 'This should not go out.' }, ACTOR_ID),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('lists sent broadcasts newest first with the sender name', async () => {
    const { service, prisma } = makeHarness();

    const page = await service.list({});

    expect(page).toMatchObject({ total: 1, page: 1, pageSize: 20, totalPages: 1 });
    expect(page.items[0]).toMatchObject({
      title: 'Scheduled maintenance',
      senderName: 'Olivia Martin',
      recipientCount: 2,
    });
    expect(page.items[0].createdAt).toBe('2026-09-26T12:00:00.000Z');
    expect(prisma.broadcast.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' }, skip: 0, take: 20 }),
    );
  });

  it('searches title and body, case-insensitively', async () => {
    const { service, prisma } = makeHarness();

    await service.list({ q: 'maint' });

    expect(prisma.broadcast.findMany.mock.calls[0]![0]).toMatchObject({
      where: {
        OR: [
          { title: { contains: 'maint', mode: 'insensitive' } },
          { body: { contains: 'maint', mode: 'insensitive' } },
        ],
      },
    });
  });

  it('clamps paging to the shared envelope bounds', async () => {
    const { service, prisma } = makeHarness();

    const page = await service.list({ page: 0, pageSize: 5000 });

    expect(page).toMatchObject({ page: 1, pageSize: 100 });
    expect(prisma.broadcast.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 100 }),
    );
  });
});
