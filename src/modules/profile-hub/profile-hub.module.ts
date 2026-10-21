import { AuthModule } from '../auth/auth.module.js';
import { EmailChangeService } from './email-change.service.js';
import { Module } from '@nestjs/common';
import { PasscodeModule } from '../passcode/passcode.module.js';
import { ProfileHubController } from './profile-hub.controller.js';
import { ProfileHubService } from './profile-hub.service.js';
@Module({
  imports: [PasscodeModule, AuthModule],
  controllers: [ProfileHubController],
  providers: [ProfileHubService, EmailChangeService],
})
export class ProfileHubModule {}
