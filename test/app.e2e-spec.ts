import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { afterAll } from 'vitest';
import { AppModule } from './../src/app.module.js';
import { AppConfig } from './../src/config/configuration.js';
import { JwksService } from './../src/modules/auth/services/jwks.service.js';
import { configureSwagger } from './../src/common/swagger.js';
import { REDIS_CLIENT } from './../src/common/redis/redis.module.js';
import type { RedisClient } from './../src/common/redis/redis-client.interface.js';
import { Redis } from 'ioredis';

/**
 * This smoke file runs on its OWN Redis database (db 13) so the rate-limiting
 * describe never shares counters with the other suites. Restored in afterAll.
 */
const ORIGINAL_REDIS_URL = process.env.REDIS_URL;
process.env.REDIS_URL = 'redis://localhost:6379/13';

afterAll(() => {
  if (ORIGINAL_REDIS_URL === undefined) {
    delete process.env.REDIS_URL;
  } else {
    process.env.REDIS_URL = ORIGINAL_REDIS_URL;
  }
});

/**
 * The Redis client connects asynchronously after `app.init()`. Requests fired
 * before it reaches `ready` fall back to the per-process memory counter, which
 * is silently abandoned once the client connects — so a burst straddling the
 * switch would under-count and never 429. Await readiness to keep the
 * rate-limit counters on a single (Redis) store.
 */
async function waitForRedisReady(client: RedisClient, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await client.ping();
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }
  throw new Error('Redis did not become ready before timeout');
}

/** Wipe a scratch Redis DB so rate-limit counters always start from zero. */
async function flushDb(db: number): Promise<void> {
  const redis = new Redis({ host: '127.0.0.1', port: 6379, db });
  try {
    await redis.flushdb();
  } finally {
    await redis.quit();
  }
}

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
    const config = moduleFixture.get<ConfigService<AppConfig, true>>(ConfigService);
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
    process.env.REDIS_URL = 'redis://localhost:6379/13';
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

/**
 * Rate limiting: the global `default` throttler rejects traffic past the
 * configured limit (env-tuned low here) with a uniform 429.
 */
describe('App (e2e) — rate limiting', () => {
  let app: INestApplication;
  // Own scratch DB so this describe never inherits counters from other
  // describes/files on the shared DB and is order-independent.
  const RATE_DB = 'redis://localhost:6379/12';

  beforeEach(async () => {
    process.env.REDIS_URL = RATE_DB;
    await flushDb(12);
    process.env.THROTTLE_LIMIT = '3';
    process.env.THROTTLE_BLOCK_DURATION = '60000';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
    await waitForRedisReady(moduleFixture.get<RedisClient>(REDIS_CLIENT));
  });

  afterEach(async () => {
    process.env.REDIS_URL = 'redis://localhost:6379/13';
    delete process.env.THROTTLE_LIMIT;
    delete process.env.THROTTLE_BLOCK_DURATION;
    await app.close();
  });

  it('allows requests under the limit, then returns uniform 429', async () => {
    const server = app.getHttpServer();
    for (let i = 0; i < 3; i++) {
      await request(server).get('/health/ready').expect(200);
    }

    const blocked = await request(server).get('/health/ready').expect(429);
    expect(blocked.body).toMatchObject({
      statusCode: 429,
      error: 'ThrottlerException',
    });
    expect(Array.isArray(blocked.body.message)).toBe(true);
  });
});

/**
 * Storage: the signed-URL endpoints are auth-protected, enforce the bucket/
 * path guardrails, and proxy their Supabase calls through a stubbed `fetch`
 * (the e2e app boots against `example.supabase.co`, so no real Storage API
 * is hit).
 */
describe('App (e2e) — storage', () => {
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
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();

    const jwks = app.get(JwksService);
    vi.spyOn(jwks, 'verify').mockResolvedValue({
      userId: 'u-123',
      email: 'me@bonde.app',
      phone: null,
      role: 'ADMIN',
      appMetadata: { role: 'ADMIN' },
      userMetadata: {},
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              signedUrl: '/object/upload/sign/bonde-avatars/u-123%2Favatar.jpeg?token=t',
            }),
            { status: 200 },
          ),
      ),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await app.close();
  });

  it('POST /storage/upload-url without a token → 401', () => {
    return request(app.getHttpServer()).post('/storage/upload-url').send({}).expect(401);
  });

  it('POST /storage/upload-url returns a signed upload URL', async () => {
    const server = app.getHttpServer();
    const uploadUrl = `${process.env.SUPABASE_URL!}/storage/v1/object/upload/sign/bonde-avatars/u-123%2Favatar.jpeg?token=t`;

    const res = await request(server)
      .post('/storage/upload-url')
      .set('Authorization', 'Bearer valid-token')
      .send({ bucket: 'bonde-avatars', path: 'u-123/avatar.jpeg', contentType: 'image/jpeg' })
      .expect(201);

    expect(res.body).toMatchObject({
      bucket: 'bonde-avatars',
      path: 'u-123/avatar.jpeg',
      method: 'PUT',
      uploadUrl,
      headers: { 'content-type': 'image/jpeg' },
      expiresIn: 900,
    });
  });

  it('POST /storage/upload-url rejects unknown buckets → 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/storage/upload-url')
      .set('Authorization', 'Bearer valid-token')
      .send({ bucket: 'bonde-unknown', path: 'u/a.jpg', contentType: 'image/jpeg' })
      .expect(400);

    expect(res.body.statusCode).toBe(400);
  });

  it('POST /storage/upload-url rejects unsafe paths → 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/storage/upload-url')
      .set('Authorization', 'Bearer valid-token')
      .send({ bucket: 'bonde-avatars', path: '../etc/passwd', contentType: 'image/jpeg' })
      .expect(400);

    expect(res.body).toMatchObject({
      statusCode: 400,
      error: 'BadRequestException',
    });
  });

  it('POST /storage/upload-url rejects disallowed content types → 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/storage/upload-url')
      .set('Authorization', 'Bearer valid-token')
      .send({ bucket: 'bonde-avatars', path: 'u-1/notes.txt', contentType: 'text/plain' })
      .expect(400);

    expect(res.body.statusCode).toBe(400);
  });

  it('GET /storage/signed-url returns a signed read URL', async () => {
    const res = await request(app.getHttpServer())
      .get('/storage/signed-url')
      .set('Authorization', 'Bearer valid-token')
      .query({ bucket: 'bonde-avatars', path: 'u-123/avatar.jpeg', expiresIn: 60 })
      .expect(200);

    expect(res.body).toMatchObject({
      bucket: 'bonde-avatars',
      path: 'u-123/avatar.jpeg',
      expiresIn: 60,
      signedUrl: expect.stringContaining(`${process.env.SUPABASE_URL!}/storage/v1/object/upload/`),
    });
  });

  it('GET /storage/public-url serves public buckets and rejects private ones', async () => {
    const server = app.getHttpServer();

    const publicRes = await request(server)
      .get('/storage/public-url')
      .set('Authorization', 'Bearer valid-token')
      .query({ bucket: 'bonde-avatars', path: 'u-123/avatar.jpeg' })
      .expect(200);
    expect(publicRes.body.publicUrl).toBe(
      `${process.env.SUPABASE_URL!}/storage/v1/object/public/bonde-avatars/u-123/avatar.jpeg`,
    );

    const privateRes = await request(server)
      .get('/storage/public-url')
      .set('Authorization', 'Bearer valid-token')
      .query({ bucket: 'bonde-kyc-docs', path: 'u-123/kyc.pdf' })
      .expect(400);
    expect(privateRes.body.statusCode).toBe(400);
  });
});
