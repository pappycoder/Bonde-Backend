import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import { ConfigService } from '@nestjs/config';
import * as helmet from 'helmet';
import hpp from 'hpp';
import { AppModule } from './app.module.js';
import { AppConfig } from './config/configuration.js';
import { configureSwagger } from './common/swagger.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });

  const config = app.get(ConfigService<AppConfig, true>);
  const nodeEnv = config.get('nodeEnv');
  const port = config.get('port');
  const corsOrigins = config.get('corsOrigins');

  // ---- Structured logging ------------------------------------------------
  app.useLogger(app.get(PinoLogger));

  // ---- Security headers --------------------------------------------------
  // The callable is only exposed as the module `default` export (helmet 8 ships
  // dual .d.cts/.d.mts without a named export), so go through the namespace to
  // typecheck under both ESM and CJS resolution.
  app.use(helmet.default());

  // ---- HTTP Parameter Pollution protection --------------------------------
  app.use(hpp());

  // ---- Trust proxy (for rate-limiting behind reverse proxies) --------------
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // ---- CORS ---------------------------------------------------------------
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    maxAge: 86400,
  });

  // ---- Global prefix ------------------------------------------------------
  app.setGlobalPrefix('api');

  // ---- Global validation pipe ---------------------------------------------
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // ---- Global exception filter --------------------------------------------
  // Registered via APP_FILTER provider in AppModule so it participates in the
  // DI container and consistently handles all exceptions (incl. 404/405).

  // ---- Swagger / OpenAPI docs (non-production only) ------------------------
  configureSwagger(app, { nodeEnv, publicUrl: config.get('publicUrl') });

  // ---- Start server -------------------------------------------------------
  await app.listen(port);

  const logger = new Logger('Bootstrap');
  logger.log(`Bonde API running on http://localhost:${port} [${nodeEnv}]`);
}

void bootstrap();
