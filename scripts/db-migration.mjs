import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { validateDeployment } from './env-vercel.mjs';

const [command, ...args] = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};
let env = { ...process.env },
  cli;
if (command === 'create' || command === 'check') {
  const url =
    command === 'check'
      ? process.env.TEST_DATABASE_URL || 'postgresql://bonde:bonde@127.0.0.1:5433/bonde'
      : process.env.MIGRATION_DATABASE_URL;
  if (!url || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname))
    throw new Error(
      'Migration creation/checks require an explicit local disposable database; hosted databases are never reset',
    );
  env.DATABASE_URL = url;
  env.DIRECT_URL = url;
  if (command === 'check')
    cli = [
      'migrate',
      'diff',
      '--from-config-datasource',
      '--to-schema',
      'prisma/schema.prisma',
      '--exit-code',
    ];
  else {
    const name = flag('name', '');
    if (!/^[a-z][a-z0-9_]{2,60}$/.test(name))
      throw new Error('Provide --name lower_case_migration_name');
    cli = ['migrate', 'dev', '--create-only', '--name', name];
  }
} else if (command === 'deploy') {
  const target = flag('environment', 'preview');
  const preparedFile =
    process.env.GITHUB_ACTIONS === 'true'
      ? process.env.BONDE_PREPARED_ENV_FILE || '.env.vercel.json'
      : '.env.vercel.json';
  const manifest = JSON.parse(process.env.BONDE_ENV_JSON || readFileSync(preparedFile, 'utf8'));
  // prepare writes selected GitHub credential overrides into the local manifest.
  if (process.env.BONDE_ENV_JSON && process.env.GITHUB_ACTIONS === 'true') {
    const prepared = JSON.parse(readFileSync(preparedFile, 'utf8'));
    manifest[target] = prepared[target];
  }
  env = { ...env, ...validateDeployment(manifest, target) };
  cli = ['migrate', 'deploy'];
} else
  throw new Error('Commands: create --name <name>, check, deploy --environment preview|production');
const result = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', ...cli], {
  env,
  stdio: 'inherit',
});
process.exitCode = result.status ?? 1;
