import { Module } from '@nestjs/common';
import { AiCreditsService } from './ai-credits.service.js';
@Module({ providers: [AiCreditsService], exports: [AiCreditsService] })
export class AiCreditsModule {}
