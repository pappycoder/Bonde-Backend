import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  normalize,
  effective,
  mergePulled,
  pushPlan,
  validateDeployment,
  databaseIdentity,
} from './env-vercel.mjs';
const base = () => ({
  version: 1,
  project: { kind: 'backend' },
  required: [],
  shared: { OPENAI_API_KEY: 'shared-secret' },
  preview: {},
  production: {},
});
test('empty values never enter create/update plans and valid false/zero values survive', () => {
  const m = normalize({ ...base(), preview: { EMPTY: '', NULL: null, FLAG: false, COUNT: 0 } });
  assert.deepEqual(effective(m, 'preview'), {
    OPENAI_API_KEY: 'shared-secret',
    FLAG: 'false',
    COUNT: '0',
  });
  assert(!pushPlan(m, ['preview']).some((r) => ['EMPTY', 'NULL'].includes(r.key)));
  assert(!JSON.stringify(pushPlan(m, ['preview'])).includes('shared-secret'));
});
test('environment overrides shared values without leaking preview-only keys to production', () => {
  const m = normalize({
    ...base(),
    preview: { OPENAI_API_KEY: 'preview-key', SUDO_API_KEY: 'sandbox-only' },
  });
  assert.equal(effective(m, 'preview').OPENAI_API_KEY, 'preview-key');
  assert.equal(effective(m, 'production').OPENAI_API_KEY, 'shared-secret');
  assert.equal(effective(m, 'production').SUDO_API_KEY, undefined);
});
test('database, banking, auth and encryption variables cannot be shared', () => {
  for (const key of [
    'DATABASE_URL',
    'NEXT_PUBLIC_API_URL',
    'DIRECT_URL',
    'SUDO_API_KEY',
    'SAFE_HAVEN_PRIVATE_KEY',
    'CARD_ENCRYPTION_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'FINANCE_JOB_TOKEN',
  ]) {
    assert.throws(() => normalize({ ...base(), shared: { [key]: '' } }), /cannot be shared/);
  }
});
test('pulling protected secrets preserves local values and records unreadable names', () => {
  const m = { ...base(), preview: { DATABASE_URL: 'local-known-value' } };
  mergePulled(m, 'preview', {
    DATABASE_URL: '[SENSITIVE]',
    DIRECT_URL: '[SENSITIVE]',
    PUBLIC_URL: 'https://api.example.com',
    VERCEL_TOKEN: 'ignore',
  });
  assert.equal(m.preview.DATABASE_URL, 'local-known-value');
  assert.equal(m.preview.DIRECT_URL, '');
  assert.equal(m.preview.VERCEL_TOKEN, undefined);
  assert.deepEqual(m._meta.unreadable.preview, ['DATABASE_URL', 'DIRECT_URL']);
  assert(!JSON.stringify(m).includes('[SENSITIVE]'));
});
test('placeholder secrets cannot be pushed as credential values', () => {
  assert.throws(
    () => normalize({ ...base(), preview: { OPENAI_API_KEY: '[SENSITIVE]' } }),
    /placeholder/,
  );
});
test('production deployment fails before mutation if required configuration is empty', () => {
  assert.throws(
    () => validateDeployment({ ...base(), required: ['DATABASE_URL'] }, 'production'),
    /Missing production/,
  );
});
function databaseManifest() {
  return {
    ...base(),
    required: ['DATABASE_URL', 'DIRECT_URL', 'SUPABASE_URL'],
    preview: {
      DATABASE_URL: 'postgresql://postgres.stage:password@aws.pooler.supabase.com:6543/postgres',
      SUPABASE_URL: 'https://stage.supabase.co',
    },
    production: {
      DATABASE_URL: 'postgresql://postgres.prod:password@aws.pooler.supabase.com:6543/postgres',
      DIRECT_URL: 'postgresql://postgres:password@db.prod.supabase.co:5432/postgres',
      SUPABASE_URL: 'https://prod.supabase.co',
    },
  };
}
test('identifies the same Supabase database through pooled/direct connections and ignores password changes', () => {
  const m = databaseManifest();
  assert.equal(
    databaseIdentity(m.production.DATABASE_URL),
    databaseIdentity(m.production.DIRECT_URL),
  );
  assert.equal(
    databaseIdentity('postgresql://user:one@db.example.com/app'),
    databaseIdentity('postgresql://other:two@db.example.com:5432/app'),
  );
  assert(validateDeployment(m, 'production'));
});
test('production cannot use staging database with different credentials', () => {
  const m = databaseManifest();
  m.production.DATABASE_URL = m.preview.DATABASE_URL;
  m.production.DIRECT_URL = 'postgresql://postgres:other@db.stage.supabase.co:5432/postgres';
  assert.throws(() => validateDeployment(m, 'production'), /distinct/);
});
test('migration and runtime URLs cannot point at different databases', () => {
  const m = databaseManifest();
  m.production.DIRECT_URL = 'postgresql://postgres:password@db.other.supabase.co/postgres';
  assert.throws(() => validateDeployment(m, 'production'), /same database/);
});
test('mobile manifests cannot carry server credentials', () => {
  assert.throws(
    () =>
      normalize({
        ...base(),
        project: { kind: 'mobile' },
        shared: {},
        preview: { OPENAI_API_KEY: 'secret' },
      }),
    /Unsupported mobile/,
  );
});

test('explicit prepared file takes precedence over the original CI secret', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bonde-env-test-'));
  try {
    const file = join(dir, '.env.vercel.json');
    const output = join(dir, 'export.env');
    const m = {
      ...base(),
      project: { kind: 'web' },
      shared: {},
      required: ['PUBLIC_URL'],
      preview: { PUBLIC_URL: 'https://old.example.com' },
    };
    const env = {
      ...process.env,
      BONDE_ENV_JSON: JSON.stringify(m),
      BONDE_PUBLIC_URL: 'https://new.example.com',
      GITHUB_ENV: join(dir, 'github-env'),
      GITHUB_REF_NAME: 'staging',
    };
    const script = new URL('./env-vercel.mjs', import.meta.url).pathname;
    const prepared = spawnSync(process.execPath, [script, 'prepare', '--environment', 'preview'], {
      cwd: dir,
      env,
      encoding: 'utf8',
    });
    assert.equal(prepared.status, 0, prepared.stderr);
    delete env.BONDE_PUBLIC_URL;
    const exported = spawnSync(
      process.execPath,
      [script, 'export', '--environment', 'preview', '--file', file, '--output', output],
      { cwd: dir, env, encoding: 'utf8' },
    );
    assert.equal(exported.status, 0, exported.stderr);
    assert.match(readFileSync(output, 'utf8'), /new\.example\.com/);
    assert.doesNotMatch(readFileSync(output, 'utf8'), /old\.example\.com/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
