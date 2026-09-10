import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
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
 */
export async function setup(): Promise<void> {
  await deployMigrations();
  await seedLocalDatabase();
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
