import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import { FirebasePushDispatcher } from './firebase-push.dispatcher.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { PUSH_DISPATCHER } from './push-dispatcher.interface.js';

@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    {
      provide: PUSH_DISPATCHER,
      useFactory: (config: ConfigService<AppConfig, true>) =>
        new FirebasePushDispatcher(config),
      inject: [ConfigService],
    },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
