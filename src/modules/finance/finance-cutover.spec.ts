import { ThresholdsController } from '../thresholds/thresholds.controller.js';
import { KycController } from '../kyc/kyc.controller.js';
import { ChatsController } from '../chats/chats.controller.js';
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { AccountsController } from '../accounts/accounts.controller.js';
import { WalletsController } from '../wallets/wallets.controller.js';
import { CardsController } from '../cards/cards.controller.js';
import { TransactionsController } from '../transactions/transactions.controller.js';
import { ApprovalsController } from '../transactions/approvals.controller.js';
import { AdminConsoleController } from '../admin-console/admin-console.controller.js';
import { FundingController } from '../funding/funding.controller.js';

const routes = (controller: { prototype: object }) =>
  Object.getOwnPropertyNames(controller.prototype)
    .filter((name) => name !== 'constructor')
    .map((name) => {
      const method = (controller.prototype as Record<string, object>)[name];
      return {
        path: Reflect.getMetadata(PATH_METADATA, method),
        method: Reflect.getMetadata(METHOD_METADATA, method),
      };
    })
    .filter((row) => row.method !== undefined);

describe('Exclusive finance cutover', () => {
  it.each([
    KycController,
    ThresholdsController,
    AccountsController,
    WalletsController,
    CardsController,
    TransactionsController,
    ApprovalsController,
  ])('%s exposes presentation reads only', (controller) => {
    expect(routes(controller).length).toBeGreaterThan(0);
    expect(routes(controller).every((route) => route.method === RequestMethod.GET)).toBe(true);
  });
  it('removes direct credentials and provider mutation aliases', () => {
    expect(
      routes(CardsController).some((route) =>
        /credentials|fund|withdraw|sync|pause|resume|issued|cancel/.test(route.path),
      ),
    ).toBe(false);
    expect(routes(FundingController).some((route) => route.path === 'withdrawals')).toBe(false);
    expect(routes(ChatsController).some((route) => /checkout/.test(route.path))).toBe(false);
  });
  it('prevents administrators from changing a purchase approval outside the financial command path', () => {
    expect(
      routes(AdminConsoleController).some((route) => route.path === 'transactions/:id/approval'),
    ).toBe(false);
  });
});
