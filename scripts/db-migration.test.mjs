import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('migration receives the frozen validated manifest from outside deployment source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bonde-migration-test-'));
  try {
    const source = join(dir, 'source');
    mkdirSync(join(source, 'node_modules/prisma/build'), { recursive: true });
    const observed = join(dir, 'observed.json');
    writeFileSync(
      join(source, 'node_modules/prisma/build/index.js'),
      `require('node:fs').writeFileSync(process.env.TEST_OBSERVED, JSON.stringify({ database: process.env.DATABASE_URL, direct: process.env.DIRECT_URL, args: process.argv.slice(2) }));`,
    );
    const manifest = {
      version: 1,
      project: { kind: 'backend' },
      required: ['DATABASE_URL', 'DIRECT_URL', 'SUPABASE_URL'],
      shared: {},
      production: {},
      preview: {
        DATABASE_URL: 'postgresql://user:old-password@db.sandbox.supabase.co/postgres',
        DIRECT_URL: 'postgresql://user:old-password@db.sandbox.supabase.co/postgres',
        SUPABASE_URL: 'https://sandbox.supabase.co',
      },
    };
    const prepared = structuredClone(manifest);
    prepared.preview.DATABASE_URL = prepared.preview.DATABASE_URL.replace(
      'old-password',
      'new-password',
    );
    prepared.preview.DIRECT_URL = prepared.preview.DIRECT_URL.replace(
      'old-password',
      'new-password',
    );
    const preparedFile = join(dir, 'prepared.json');
    writeFileSync(preparedFile, JSON.stringify(prepared), { mode: 0o600 });
    const run = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./db-migration.mjs', import.meta.url)),
        'deploy',
        '--environment',
        'preview',
      ],
      {
        cwd: source,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_ACTIONS: 'true',
          BONDE_ENV_JSON: JSON.stringify(manifest),
          BONDE_PREPARED_ENV_FILE: preparedFile,
          TEST_OBSERVED: observed,
        },
      },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(readFileSync(observed, 'utf8')), {
      database: prepared.preview.DATABASE_URL,
      direct: prepared.preview.DIRECT_URL,
      args: ['migrate', 'deploy'],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
