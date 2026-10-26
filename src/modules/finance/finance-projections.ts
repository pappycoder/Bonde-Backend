import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

/** A card allocation return is a wallet credit, not external income or a purchase. */
export async function projectAllocationReturn(
  tx: Prisma.TransactionClient,
  data: {
    userId: string;
    cardId: string;
    currency: string;
    amount: Prisma.Decimal;
    reference: string;
    operationId?: string;
  },
) {
  const wallet = await tx.wallet.findFirstOrThrow({ where: { account: { userId: data.userId } } });
  await tx.transaction.create({
    data: {
      id: data.operationId ?? randomUUID(),
      userId: data.userId,
      walletId: wallet.id,
      cardId: data.cardId,
      type: 'TRANSFER',
      status: 'SUCCESS',
      approvalStatus: 'APPROVED',
      amount: data.amount,
      currency: data.currency,
      description: 'Closed card allocation returned to wallet',
      metadata: {
        live: true,
        kind: 'RETURN',
        direction: 'CREDIT',
        reference: data.reference,
        fee: '0.00',
        ...(data.operationId ? { operationId: data.operationId } : {}),
      },
    },
  });
}
