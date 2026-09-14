import type { MockInstance } from 'vitest';
import { INestApplication, InjectionToken, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/configuration.js';
import { JwksService } from '../src/modules/auth/services/jwks.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { configureSwagger } from '../src/common/swagger.js';
import { REDIS_CLIENT } from '../src/common/redis/redis.module.js';
import type { RedisClient } from '../src/common/redis/redis-client.interface.js';
import type { AuthPrincipal, BondeRole } from '../src/modules/auth/principal/auth-principal.js';
import { SEED_USER_EMAIL, SEED_USER_ID, SEED_USER_PHONE, TEST_DB_URL } from './db.js';

export * from './db.js';

const DEFAULT_PRINCIPAL: AuthPrincipal = {
  userId: SEED_USER_ID,
  email: SEED_USER_EMAIL,
  phone: SEED_USER_PHONE,
  role: 'USER',
  appMetadata: {},
  userMetadata: {},
};

export interface BootE2EOptions {
  /** Replace providers before boot — e.g. `{ token: OTP_SENDER, useValue: stub }`. */
  overrides?: Array<{ token: InjectionToken; useValue: unknown }>;
}

export interface BootedE2EApp {
  app: INestApplication;
  server: ReturnType<INestApplication['getHttpServer']>;
  prisma: PrismaService;
  verify: MockInstance;
  setPrincipal: (overrides?: Partial<AuthPrincipal>) => AuthPrincipal;
  role: (role: BondeRole) => AuthPrincipal;
  /** HTTP client that injects a valid Bearer token (verifier is mocked). */
  http: AuthedHttp;
  /** Bare supertest client, for asserting unauthenticated behavior. */
  raw: ReturnType<typeof request>;
  close: () => Promise<void>;
}

const REQUEST_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

export interface AuthedHttp {
  get: (url: string) => request.Test;
  post: (url: string) => request.Test;
  put: (url: string) => request.Test;
  patch: (url: string) => request.Test;
  delete: (url: string) => request.Test;
  head: (url: string) => request.Test;
  options: (url: string) => request.Test;
}

/** Wraps a supertest instance so every verb request carries a bearer token. */
function withAuthHeader(raw: ReturnType<typeof request>): AuthedHttp {
  return new Proxy(raw as object, {
    get: (target, prop, receiver) => {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (typeof prop !== 'string' || !REQUEST_VERBS.has(prop)) return value.bind(target);
      return (...args: unknown[]) =>
        (value as (...a: unknown[]) => request.Test)
          .apply(target, args)
          .set('Authorization', 'Bearer test-token');
    },
  }) as unknown as AuthedHttp;
}

/**
 * Root Flushing between suites happens at the storage level; within a suite the
 * throttler counters must land on a single store. Requests fired before the
 * Redis client reaches `ready` fall back to the per-process memory counter,
 * which is silently abandoned once the client connects — a burst straddling the
 * switch under-counts and rate-limit assertions flake. Await readiness so every
 * suite that boots via `bootE2EApp` counts on Redis from the first request.
 */
async function waitForRedisReady(client: RedisClient, timeoutMs = 30_000): Promise<void> {
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

/**
 * Boots the full AppModule for e2e, pointed at the local test Postgres, with a
 * mockable JWKS verifier. Call `setPrincipal(...)` / `role(...)` after booting
 * to control the authenticated principal (defaults to the seeded user). Note:
 * env overrides are applied at boot (before module compile) so the ConfigModule
 * and PrismaService pick them up.
 */
export async function bootE2EApp(options: BootE2EOptions = {}): Promise<BootedE2EApp> {
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.DIRECT_URL = TEST_DB_URL;

  let builder = Test.createTestingModule({ imports: [AppModule] });
  for (const override of options.overrides ?? []) {
    builder = builder.overrideProvider(override.token).useValue(override.useValue);
  }
  const moduleFixture: TestingModule = await builder.compile();

  const app = moduleFixture.createNestApplication({
    rawBody: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  const config = moduleFixture.get<ConfigService<AppConfig, true>>(ConfigService);
  configureSwagger(app, { nodeEnv: config.get('nodeEnv'), publicUrl: config.get('publicUrl') });
  await app.init();
  await waitForRedisReady(app.get<RedisClient>(REDIS_CLIENT));

  const prisma = app.get(PrismaService);
  const jwks = app.get(JwksService);
  const verify = vi.spyOn(jwks, 'verify');
  const setPrincipal = (overrides: Partial<AuthPrincipal> = {}): AuthPrincipal => {
    const principal = { ...DEFAULT_PRINCIPAL, ...overrides };
    verify.mockResolvedValue(principal);
    return principal;
  };
  const role = (bondeRole: BondeRole): AuthPrincipal =>
    setPrincipal({ role: bondeRole, appMetadata: { role: bondeRole } });
  setPrincipal();

  const server = app.getHttpServer();
  return {
    app,
    server,
    prisma,
    verify,
    setPrincipal,
    role,
    http: withAuthHeader(request(server)),
    raw: request(server),
    close: async () => {
      verify.mockRestore();
      await app.close();
    },
  };
}
