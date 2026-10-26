import { Module } from '@nestjs/common';
import { CardAccessService } from './card-access.service.js';
import { CardsController } from './cards.controller.js';
import { CardsService } from './cards.service.js';

@Module({
  providers: [CardsService, CardAccessService],
  exports: [CardsService],
  controllers: [CardsController],
})
export class CardsModule {}
