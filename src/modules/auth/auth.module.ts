import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwksService, JWKS, jwksFromConfig } from './services/jwks.service.js';
import { AuthController } from './auth.controller.js';
import { AuthSessionsController } from './auth-sessions.controller.js';
import { AuthService } from './services/auth.service.js';
import { AuthSessionsService } from './services/auth-sessions.service.js';
import { AuthTokensService } from './services/auth-tokens.service.js';
import { MfaChallengeService } from './services/mfa-challenge.service.js';
import { TwoFactorService } from './services/two-factor.service.js';
import { UserProvisioningService } from './services/user-provisioning.service.js';
import { SUPABASE_AUTH_BODY, SupabaseAuthClient } from './supabase/supabase-auth.client.js';
import { OtpModule } from '../otp/otp.module.js';
import { AuditLogModule } from '../audit/audit-log.module.js';
import { RedisModule } from '../../common/redis/redis.module.js';
import type { AppConfig } from '../../config/configuration.js';

@Module({
  imports: [OtpModule, AuditLogModule, RedisModule],
  controllers: [AuthController, AuthSessionsController],
  providers: [
    {
      provide: JWKS,
      useFactory: jwksFromConfig,
      inject: [ConfigService],
    },
    JwksService,
    {
      provide: SUPABASE_AUTH_BODY,
      useFactory: (config: ConfigService<AppConfig, true>) => new SupabaseAuthClient(config),
      inject: [ConfigService],
    },
    AuthTokensService,
    AuthSessionsService,
    TwoFactorService,
    MfaChallengeService,
    UserProvisioningService,
    AuthService,
  ],
  exports: [JwksService, SUPABASE_AUTH_BODY, UserProvisioningService],
})
export class AuthModule {}
