import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { JwksService } from './../src/auth/jwks.service.js';
import { configureSwagger } from './../src/common/swagger.js';

/**
 * E2E smoke tests.
 *
 * NOTE: These tests boot the full AppModule, which requires configured
 * environment (Supabase, DB, Redis) — see .env.example. They exercise the app
 * WITHOUT the bootstrap-level global prefix / security middleware that lives in
 * src/main.ts, so routes are hit relative to each controller.
 */
describe('App (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    const config = moduleFixture.get(ConfigService);
    configureSwagger(app, {
      nodeEnv: config.get('nodeEnv'),
      publicUrl: config.get('publicUrl'),
    });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET / → Hello World!', () => {
    return request(app.getHttpServer()).get('/').expect(200).expect('Hello World!');
  });

  it('GET /health → healthy (redis up)', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.info.redis.status).toBe('up');
  });

  it('GET /health/ready → ready', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(res.body.status).toBe('ready');
  });

  it('unknown route → uniform JSON 404', async () => {
    const res = await request(app.getHttpServer()).get('/does-not-exist').expect(404);
    expect(res.body).toMatchObject({
      statusCode: 404,
      error: 'NotFoundException',
      message: ['Route not found'],
    });
  });

  it('GET /auth/me without a token → uniform JSON 401', async () => {
    const res = await request(app.getHttpServer()).get('/auth/me').expect(401);
    expect(res.body).toMatchObject({
      statusCode: 401,
      error: 'UnauthorizedException',
      message: ['Missing bearer token'],
    });
  });

  it('GET /auth/me with an invalid bearer token → 401', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', 'Bearer not-a-real-token')
      .expect(401);
    expect(res.body.statusCode).toBe(401);
  });

  it('GET /auth/me returns the verified principal', async () => {
    const jwks = app.get(JwksService);
    vi.spyOn(jwks, 'verify').mockResolvedValue({
      userId: 'u-123',
      email: 'me@bonde.app',
      phone: '+2348000000000',
      role: 'ADMIN',
      appMetadata: { role: 'ADMIN' },
      userMetadata: {},
    });

    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', 'Bearer valid-token')
      .expect(200);

    expect(res.body).toMatchObject({
      userId: 'u-123',
      email: 'me@bonde.app',
      role: 'ADMIN',
    });
  });

  it('GET /api/docs-json → OpenAPI 3 document', async () => {
    const res = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    expect(res.body).toMatchObject({
      openapi: expect.stringMatching(/^3\./),
      info: expect.objectContaining({ title: 'Bonde API' }),
      paths: expect.objectContaining({
        '/auth/me': expect.anything(),
        '/health': expect.anything(),
      }),
      components: expect.objectContaining({
        securitySchemes: expect.objectContaining({
          'access-token': expect.anything(),
        }),
      }),
    });
  });

  it('GET /api/docs → Swagger UI page', async () => {
    const res = await request(app.getHttpServer()).get('/api/docs').expect(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('swagger-ui');
  });
});

/**
 * Resilience: the API must stay up when Redis is unreachable. Rate limiting
 * fails open to per-process memory limits and the health endpoint reports a
 * 503 (degraded) instead of crashing every request with a 500.
 */
describe('App (e2e) — Redis outage', () => {
  let app: INestApplication;
  const DEAD_REDIS = 'redis://127.0.0.1:6399';

  beforeEach(async () => {
    process.env.REDIS_URL = DEAD_REDIS;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  afterEach(async () => {
    delete process.env.REDIS_URL;
    await app.close();
  });

  it('GET /auth/me without a token → 401 (not 500)', () => {
    return request(app.getHttpServer()).get('/auth/me').expect(401);
  });

  it('GET /health/ready → 200 (does not depend on Redis)', () => {
    return request(app.getHttpServer()).get('/health/ready').expect(200);
  });

  it('GET /health → 503 reporting the failing dependency', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(503);
    expect(res.body).toMatchObject({
      statusCode: 503,
      error: 'ServiceUnavailableException',
    });
    expect(res.body.message.length).toBeGreaterThan(0);
  });
});
