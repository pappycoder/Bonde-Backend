import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { Redis } from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { seedBaseFixtures, TEST_DB_URL, truncateAll } from './db.js';

const execFileAsync = promisify(execFile);
const PRISMA_BIN = resolve(process.cwd(), 'node_modules/.bin/prisma');
const MAX_ATTEMPTS = 40;
const RETRY_MS = 500;

/**
 * Vitest global setup for DB-backed e2e suites (Vitest 4: `setup` + `teardown`
 * named exports from a single file listed under `globalSetup`).
 *
 * 1. Waits for the dockerized Postgres (port 5433) to accept connections.
 * 2. Applies `prisma migrate deploy` against that local instance.
 * 3. Seeds the baseline fixtures every suite depends on.
 * 4. Flushes the Redis throttler databases so rate-limit counters never leak
 *    between runs (suites pin dedicated DBs: rate-limit scratch=12, app=13,
 *    429-proof=14, OTP=15, auth=16; the shared default is 0).
 */
export async function setup(): Promise<void> {
  await deployMigrations();
  await seedLocalDatabase();
  await flushRedisKeyDatabases();
}

/** Wipes the local test database so a fresh run starts clean. */
export async function teardown(): Promise<void> {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_DB_URL }) });
  try {
    await truncateAll(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

async function deployMigrations(): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await execFileAsync(PRISMA_BIN, ['migrate', 'deploy'], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: TEST_DB_URL, DIRECT_URL: TEST_DB_URL },
        timeout: 60_000,
      });
      return; // migrations applied (or none pending)
    } catch (error) {
      lastError = error;
      await sleep(RETRY_MS);
    }
  }
  throw new Error(
    `e2e globalSetup: could not migrate local Postgres after ${MAX_ATTEMPTS} attempts` +
      (lastError ? ` (${String(lastError)})` : ''),
  );
}

async function seedLocalDatabase(): Promise<void> {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_DB_URL }) });
  try {
    await seedBaseFixtures(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Clear any throttler counters left over from a previous run (Redis counters
 * have a 60s TTL, so back-to-back runs could otherwise 429 a suite's first
 * request). Best-effort: if Redis is down, suites degrade instead of failing.
 */
async function flushRedisKeyDatabases(): Promise<void> {
  for (const db of [0, 10, 12, 13, 14, 15, 16]) {
    let redis: Redis | undefined;
    try {
      redis = new Redis({ host: '127.0.0.1', port: 6379, db });
      await redis.flushdb();
    } catch {
      // Redis unreachable — throttlers/cache degrade at runtime.
    } finally {
      if (redis) {
        await redis.quit().catch(() => redis?.disconnect());
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
