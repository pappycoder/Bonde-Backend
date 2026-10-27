import { DeliveryAddressController } from './delivery-address.controller.js';
import { DeliveryAddressService } from './delivery-address.service.js';
import { Module } from '@nestjs/common';
import { ProfilesController } from './profiles.controller.js';
import { ProfilesService } from './profiles.service.js';
import { ActivityModule } from '../activity/activity.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [ActivityModule, AuthModule],
  controllers: [ProfilesController, DeliveryAddressController],
  providers: [ProfilesService, DeliveryAddressService],
  exports: [ProfilesService, DeliveryAddressService],
})
export class ProfilesModule {}
