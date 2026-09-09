import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

const DOCS_PATH = 'api/docs';
const API_VERSION = '0.1.0';

export interface SwaggerOptions {
  nodeEnv: string;
  publicUrl: string;
}

/**
 * Mounts the OpenAPI document + Swagger UI. Intentionally a no-op in
 * `production` — API documentation is a development convenience only.
 */
export function configureSwagger(app: INestApplication, options: SwaggerOptions): void {
  if (options.nodeEnv === 'production') return;

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Bonde API')
    .setDescription(
      'Shared REST backend for the Bonde admin dashboard and mobile app. ' +
        'Authenticate against Supabase Auth directly, then send ' +
        '`Authorization: Bearer <access token>` to protected endpoints. ' +
        'RBAC roles (`USER`, `ADMIN`, `SUPER_ADMIN`) come from the token\u2019s `app_metadata.role`.',
    )
    .setVersion(API_VERSION)
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Supabase access token' },
      'access-token',
    )
    .addServer(options.publicUrl)
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup(DOCS_PATH, app, document, {
    swaggerOptions: { persistAuthorization: true },
  });
}
