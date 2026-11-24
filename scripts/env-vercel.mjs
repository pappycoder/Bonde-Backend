import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const sections = ['shared', 'preview', 'production'];
const isolated =
  /^(DATABASE_URL|DIRECT_URL|SUPABASE_.*|REDIS_URL|AUTH_TOKEN_SECRET|CARD_ENCRYPTION_KEY|MFA_ENCRYPTION_KEY|KYC_HASH_SECRET|FINANCE_.*|SUDO_.*|SAFE_HAVEN_.*|FIREBASE_.*|NEXT_PUBLIC_.*API_URL|API_URL|SOCKET_URL|APP_ENV|PUBLIC_URL|ADMIN_APP_URL|CORS_ORIGINS)$/;
const reserved = /^(VERCEL(?:_|$)|GITHUB_|NX_|TURBO_|CI$|PATH$|HOME$|NODE_OPTIONS$)/;
const mobileKeys = new Set(['API_URL', 'SUPABASE_URL', 'SOCKET_URL', 'APP_ENV']);
const forbiddenPublic =
  /(SERVICE_ROLE|PRIVATE_KEY|ENCRYPTION_KEY|TOKEN_SECRET|DATABASE_URL|DIRECT_URL)/;
const placeholder = (v) => /\[SENSITIVE\]|\[REDACTED\]|\$\{/.test(v);
const nonempty = (v) => v !== undefined && v !== null && String(v).trim() !== '';
export function normalize(manifest) {
  if (manifest.version !== 1 || !manifest.project?.kind)
    throw new Error('Expected version 1 and project.kind');
  for (const scope of sections) {
    if (!manifest[scope] || typeof manifest[scope] !== 'object' || Array.isArray(manifest[scope]))
      throw new Error(`Missing ${scope} object`);
    for (const [key, raw] of Object.entries(manifest[scope])) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key) || reserved.test(key))
        throw new Error(`Unsupported variable name: ${key}`);
      if (manifest.project.kind === 'mobile' && !mobileKeys.has(key))
        throw new Error(`Unsupported mobile build variable: ${key}`);
      if (raw !== null && !['string', 'boolean', 'number'].includes(typeof raw))
        throw new Error(`Expected a scalar value for ${key}`);
      const value = raw === null ? '' : String(raw);
      if (placeholder(value))
        throw new Error(`Unreadable/placeholder value cannot be synced: ${key}`);
      if (scope === 'shared' && isolated.test(key))
        throw new Error(`Environment-specific variable cannot be shared: ${key}`);
      if (
        (manifest.project.kind === 'mobile' ||
          key.startsWith('NEXT_PUBLIC_') ||
          key.startsWith('PUBLIC_')) &&
        forbiddenPublic.test(key)
      )
        throw new Error(`Server credential cannot enter a public build: ${key}`);
      manifest[scope][key] = value;
    }
  }
  return manifest;
}
export function effective(manifest, target) {
  if (!['preview', 'production'].includes(target))
    throw new Error('Environment must be preview or production');
  const result = {};
  for (const section of [manifest.shared, manifest[target]])
    for (const [key, value] of Object.entries(section))
      if (nonempty(value)) result[key] = String(value);
  return result;
}
export function databaseIdentity(value) {
  const u = new URL(value);
  const direct = u.hostname.match(/^db\.([^.]+)\.supabase\.(?:co|com)$/);
  const pool = /\.pooler\.supabase\.com$/.test(u.hostname)
    ? decodeURIComponent(u.username).split('.').slice(1).join('.')
    : '';
  const identity =
    direct || pool
      ? `supabase:${direct?.[1] || pool}`
      : `${u.hostname}:${u.port || '5432'}${u.pathname}`;
  return createHash('sha256').update(identity).digest('hex');
}
export function validateDeployment(manifest, target) {
  const vars = effective(normalize(manifest), target);
  const required = manifest.required ?? [];
  const missing = required.filter((key) => !nonempty(vars[key]));
  if (missing.length)
    throw new Error(`Missing ${target} deployment variables: ${missing.join(', ')}`);
  for (const key of [
    'API_URL',
    'PUBLIC_URL',
    'SUPABASE_URL',
    'NEXT_PUBLIC_APP_URL',
    'NEXT_PUBLIC_SITE_URL',
  ]) {
    if (!nonempty(vars[key])) continue;
    let url;
    try {
      url = new URL(vars[key]);
    } catch {
      throw new Error(`Invalid deployment URL: ${key}`);
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      ['localhost', '127.0.0.1'].includes(url.hostname)
    )
      throw new Error(`Deployment URL must be public HTTPS without credentials: ${key}`);
  }
  if (manifest.project.kind === 'backend') {
    const runtime = databaseIdentity(vars.DATABASE_URL),
      direct = databaseIdentity(vars.DIRECT_URL);
    if (runtime !== direct)
      throw new Error('DATABASE_URL and DIRECT_URL must identify the same database');
    const staging = nonempty(manifest.preview.DATABASE_URL)
      ? databaseIdentity(manifest.preview.DATABASE_URL)
      : manifest._meta?.stagingDatabaseFingerprint;
    if (target === 'production' && (!staging || staging === runtime))
      throw new Error('Production requires a database distinct from the recorded staging database');
    const stagingAuth = manifest.preview.SUPABASE_URL || manifest._meta?.stagingSupabaseUrl;
    if (
      target === 'production' &&
      (!stagingAuth || new URL(stagingAuth).hostname === new URL(vars.SUPABASE_URL).hostname)
    )
      throw new Error('Production requires a separate Supabase Auth project');
    if (vars.FINANCE_ENABLED === 'true' || vars.SERVICE_PURCHASES_ENABLED === 'true') {
      if (vars.FINANCE_ENVIRONMENT !== (target === 'preview' ? 'sandbox' : 'production'))
        throw new Error('Payment provider environment does not match deployment environment');
    }
  }
  return vars;
}
export function formatEnvValue(value) {
  const text = String(value);
  if (!text.includes('\0')) {
    // dotenv quoting is not JSON escaping. Only use a representation whose
    // parsed value is identical, including embedded quotes and backslashes.
    for (const candidate of [text, `'${text}'`, `"${text}"`, `\`${text}\``]) {
      if (parseEnv(`BONDE_VALUE=${candidate}\n`).BONDE_VALUE === text) return candidate;
    }
  }
  throw new Error('Value cannot be represented safely in a .env file; use the JSON manifest');
}
function cli(args, options = {}) {
  if (args[0] === 'vercel' && process.env.VERCEL_TOKEN)
    args = [...args, '--token', process.env.VERCEL_TOKEN];
  const result = spawnSync(args[0], args.slice(1), {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${args[0]} ${args[1]} failed; no values logged (check login, project access and CLI version)`,
    );
  return result.stdout;
}
function save(file, manifest) {
  writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
}
export function mergePulled(manifest, target, values) {
  const unreadable = [];
  for (const [key, value] of Object.entries(values)) {
    if (reserved.test(key)) continue;
    const scope = Object.hasOwn(manifest.shared, key) ? 'shared' : target;
    if (placeholder(value)) {
      if (!Object.hasOwn(manifest[scope], key)) manifest[scope][key] = '';
      unreadable.push(key);
      continue;
    }
    if (nonempty(value)) manifest[scope][key] = value;
    else if (!Object.hasOwn(manifest[scope], key)) manifest[scope][key] = '';
  }
  manifest._meta ??= {};
  manifest._meta.unreadable ??= {};
  manifest._meta.unreadable[target] = unreadable;
  return normalize(manifest);
}
function targetArgs(manifest) {
  if (manifest.project.kind === 'mobile')
    throw new Error('Mobile has no Vercel deployment; use env:export for build configuration');
  if (!manifest.project.id || !manifest.project.orgId)
    throw new Error('Vercel project.id and project.orgId are required');
  return ['--project', manifest.project.id, '--scope', manifest.project.orgId];
}
export function pushPlan(manifest, targets) {
  normalize(manifest);
  return targets.flatMap((target) =>
    Object.keys(effective(manifest, target))
      .sort()
      .map((key) => ({ target, key })),
  );
}
export async function main(argv = process.argv.slice(2)) {
  const [command = 'plan', ...args] = argv;
  const option = (key, fallback) => {
    const i = args.indexOf(`--${key}`);
    return i < 0 ? fallback : args[i + 1];
  };
  const target = option('environment', 'preview');
  const targets = target === 'all' ? ['preview', 'production'] : [target];
  if (targets.some((t) => !['preview', 'production'].includes(t)))
    throw new Error('Environment must be preview, production or all');
  const file = resolve(option('file', '.env.vercel.json'));
  const template = resolve('.env.vercel.example.json');
  if (command === 'init') {
    if (existsSync(file))
      throw new Error('Environment manifest already exists; it was not overwritten');
    save(file, normalize(JSON.parse(readFileSync(template, 'utf8'))));
    console.log('Created private .env.vercel.json with empty values');
    return;
  }
  // Explicit files let subsequent CI steps use the validated, overridden manifest saved by prepare.
  const source = args.includes('--file')
    ? readFileSync(file, 'utf8')
    : process.env.BONDE_ENV_JSON || readFileSync(file, 'utf8');
  const manifest = normalize(JSON.parse(source));
  if (existsSync(template)) {
    const policy = JSON.parse(readFileSync(template, 'utf8'));
    if (manifest.project.kind !== policy.project.kind || manifest.project.id !== policy.project.id)
      throw new Error('Manifest project does not match this repository template');
    if ((policy.required ?? []).some((key) => !(manifest.required ?? []).includes(key)))
      throw new Error('Manifest cannot remove required variables from the repository policy');
  }
  if (command === 'prepare') {
    if (
      process.env.GITHUB_REPOSITORY &&
      process.env.GITHUB_REPOSITORY !== manifest.project.repository
    )
      throw new Error('Manifest belongs to a different repository');
    if (process.env.VERCEL_PROJECT_ID && process.env.VERCEL_PROJECT_ID !== manifest.project.id)
      throw new Error('GitHub and manifest Vercel project IDs differ');
    const branch = process.env.GITHUB_REF_NAME;
    if (
      branch &&
      (branch === 'main' ? target !== 'production' : branch !== 'staging' || target !== 'preview')
    )
      throw new Error('Deployment environment does not match the protected branch');
  }

  if (command === 'validate') {
    for (const t of targets) if (args.includes('--deployment')) validateDeployment(manifest, t);
    console.log(
      'Environment manifest valid' +
        (args.includes('--deployment') ? ` for ${target} deployment` : ''),
    );
    return;
  }
  if (command === 'plan') {
    for (const row of pushPlan(manifest, targets)) console.log(`${row.target}: ${row.key}`);
    console.log('Only names shown; empty values are skipped, never deleted.');
    return;
  }
  if (command === 'pull') {
    const scope = targetArgs(manifest);
    const from = option('from', undefined);
    if (from && (target !== 'preview' || from !== 'production'))
      throw new Error(
        '--from production is only supported for importing legacy values into preview',
      );
    const dir = mkdtempSync(join(tmpdir(), 'bonde-env-'));
    try {
      for (const t of targets) {
        const path = join(dir, `${t}.env`);
        cli(['vercel', 'env', 'pull', path, '--environment', from || t, '--yes', ...scope]);
        mergePulled(manifest, t, parseEnv(readFileSync(path, 'utf8')));
        console.log(
          `Pulled ${from || t} into ${t}; protected secret values retained locally or left empty`,
        );
      }
      if (nonempty(manifest.preview.DATABASE_URL))
        manifest._meta.stagingDatabaseFingerprint = databaseIdentity(manifest.preview.DATABASE_URL);
      if (nonempty(manifest.preview.SUPABASE_URL))
        manifest._meta.stagingSupabaseUrl = manifest.preview.SUPABASE_URL;
      save(file, manifest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return;
  }
  if (command === 'push') {
    const scope = targetArgs(manifest);
    if (args.includes('--deployment')) for (const t of targets) validateDeployment(manifest, t);
    const plan = pushPlan(manifest, targets); // Validate the whole plan before any remote mutation.
    if (args.includes('--dry-run')) {
      for (const row of plan) console.log(`${row.target}: ${row.key}`);
      return;
    }
    // A pre-existing multi-environment record must not be overwritten through
    // a single-target request, which could rotate another environment too.
    const existing =
      JSON.parse(cli(['vercel', 'env', 'ls', '--format', 'json', ...scope])).envs ?? [];
    for (const row of plan)
      if (
        existing.some(
          (entry) =>
            entry.key === row.key && entry.target?.includes(row.target) && entry.target.length > 1,
        )
      )
        throw new Error(
          `Split the existing multi-environment Vercel record before syncing: ${row.key}`,
        );
    for (const { target: t, key } of plan) {
      const value = effective(manifest, t)[key];
      const isPublic = key.startsWith('NEXT_PUBLIC_') || key.startsWith('PUBLIC_');
      cli(
        [
          'vercel',
          'env',
          'add',
          key,
          '--environment',
          t,
          '--force',
          '--yes',
          '--type',
          isPublic ? 'config' : 'secret',
          ...scope,
        ],
        { input: value },
      );
      console.log(`Synced ${t}: ${key}`);
    }
    return;
  }
  if (command === 'github') {
    if (!manifest.project.repository) throw new Error('project.repository is required');
    for (const t of targets) {
      const environment = t === 'preview' ? 'staging' : 'production';
      const scoped = structuredClone(manifest);
      if (nonempty(manifest.preview.DATABASE_URL)) {
        scoped._meta ??= {};
        scoped._meta.stagingDatabaseFingerprint = databaseIdentity(manifest.preview.DATABASE_URL);
        scoped._meta.stagingSupabaseUrl = manifest.preview.SUPABASE_URL;
      }
      const other = t === 'preview' ? 'production' : 'preview';
      scoped[other] = Object.fromEntries(Object.keys(scoped[other]).map((key) => [key, '']));
      cli(
        [
          'gh',
          'secret',
          'set',
          'BONDE_ENV_JSON',
          '--repo',
          manifest.project.repository,
          '--env',
          environment,
        ],
        { input: JSON.stringify(scoped) },
      );
      const vars = effective(manifest, t);
      for (const key of [
        'DATABASE_URL',
        'DIRECT_URL',
        'SUPABASE_URL',
        'SUPABASE_ANON_KEY',
        'SUPABASE_SERVICE_ROLE_KEY',
      ]) {
        if (nonempty(vars[key]))
          cli(
            [
              'gh',
              'secret',
              'set',
              key,
              '--repo',
              manifest.project.repository,
              '--env',
              environment,
            ],
            { input: vars[key] },
          );
      }
      for (const [key, value] of Object.entries({
        VERCEL_ORG_ID: manifest.project.orgId,
        VERCEL_PROJECT_ID: manifest.project.id,
        STAGING_DOMAIN: manifest.project.stagingDomain,
      })) {
        if (nonempty(value))
          cli(
            [
              'gh',
              'variable',
              'set',
              key,
              '--repo',
              manifest.project.repository,
              '--env',
              environment,
            ],
            { input: value },
          );
      }
      console.log(
        `Synced GitHub ${environment} configuration; empty database credentials were skipped`,
      );
    }
    return;
  }
  if (command === 'export' || command === 'prepare') {
    if (targets.length !== 1) throw new Error('Export selects exactly one environment');
    // CI credentials may be supplied independently as environment-scoped GitHub secrets.
    for (const key of manifest.required ?? [])
      if (nonempty(process.env[`BONDE_${key}`]))
        manifest[target][key] = process.env[`BONDE_${key}`];
    const vars =
      args.includes('--deployment') || command === 'prepare'
        ? validateDeployment(manifest, target)
        : effective(manifest, target);
    if (command === 'prepare') {
      for (const value of Object.values(vars))
        console.log(
          '::add-mask::' +
            value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A'),
        );
      if (!process.env.GITHUB_ENV) throw new Error('prepare requires GITHUB_ENV');
      const lines =
        Object.entries(vars)
          .map(([key, value]) => {
            const delimiter = `BONDE_${randomUUID()}`;
            return `${key}<<${delimiter}\n${value}\n${delimiter}`;
          })
          .join('\n') + '\n';
      writeFileSync(process.env.GITHUB_ENV, lines, { flag: 'a' });
      save(file, manifest);
    } else {
      const output = option('output', undefined);
      if (!output) throw new Error('Export requires --output (values never print to stdout)');
      if (resolve(output) === file) throw new Error('Cannot overwrite the manifest');
      const data =
        Object.entries(vars)
          .map(([k, v]) => `${k}=${formatEnvValue(v)}`)
          .join('\n') + '\n';
      writeFileSync(output, data, { mode: 0o600 });
      chmodSync(output, 0o600);
    }
    console.log(`Prepared ${target} configuration without logging values`);
    return;
  }
  throw new Error('Commands: init, pull, push, plan, validate, export, prepare, github');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
