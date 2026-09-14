import { Module } from '@nestjs/common';
import { CardsController } from './cards.controller.js';
import { CardsService } from './cards.service.js';
import { IssuedCardsService } from './issued-cards.service.js';
import { ActivityModule } from '../activity/activity.module.js';
import { FlutterwaveModule } from '../flutterwave/flutterwave.module.js';
import { TransactionsModule } from '../transactions/transactions.module.js';

@Module({
  imports: [ActivityModule, FlutterwaveModule, TransactionsModule],
  controllers: [CardsController],
  providers: [CardsService, IssuedCardsService],
  exports: [CardsService, IssuedCardsService],
})
export class CardsModule {}
