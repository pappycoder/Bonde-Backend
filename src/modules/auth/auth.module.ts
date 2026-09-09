import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwksService, JWKS, jwksFromConfig } from './services/jwks.service.js';
import { AuthController } from './auth.controller.js';

@Module({
  controllers: [AuthController],
  providers: [
    {
      provide: JWKS,
      useFactory: jwksFromConfig,
      inject: [ConfigService],
    },
    JwksService,
  ],
  exports: [JwksService],
})
export class AuthModule {}
