import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwksService, JWKS, jwksFromConfig } from './services/jwks.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './services/auth.service.js';
import { AuthTokensService } from './services/auth-tokens.service.js';
import { SUPABASE_AUTH_BODY, SupabaseAuthClient } from './supabase/supabase-auth.client.js';
import { OtpModule } from '../otp/otp.module.js';
import { AuditLogModule } from '../audit/audit-log.module.js';
import type { AppConfig } from '../../config/configuration.js';

@Module({
  imports: [OtpModule, AuditLogModule],
  controllers: [AuthController],
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
    AuthService,
  ],
  exports: [JwksService, SUPABASE_AUTH_BODY],
})
export class AuthModule {}
