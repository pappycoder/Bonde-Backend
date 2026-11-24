import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import configuration from '../dist/config/configuration.js';
import { SudoClient, SafeHavenClient, ProviderError } from '../dist/modules/finance/providers.js';

const settings = configuration();
if (
  settings.finance.environment !== 'sandbox' ||
  settings.finance.sudoBaseUrl !== 'https://api.sandbox.sudo.cards' ||
  settings.finance.safeHavenBaseUrl !== 'https://api.sandbox.safehavenmfb.com'
) {
  throw new Error('Only the explicit Sudo and Safe Haven sandbox endpoints are permitted');
}
const config = new ConfigService(settings);
const sudo = new SudoClient(config),
  safe = new SafeHavenClient(config);
const checks = [];
class PreflightBlocked extends Error {}
async function check(name, action) {
  try {
    checks.push({ name, status: 'PASS', ...(await action()) });
  } catch (error) {
    checks.push({
      name,
      status: 'BLOCKED',
      reason:
        error instanceof ProviderError
          ? `Provider HTTP ${error.status || 'unreachable'}`
          : error instanceof PreflightBlocked
            ? error.message
            : 'Provider access or credential validation failed',
    });
  }
}
await check('Safe Haven sandbox authentication and banks', async () => {
  const banks = await safe.banks();
  if (!Array.isArray(banks) || !banks.length)
    throw new PreflightBlocked('No bank catalog returned');
  return { bankCount: banks.length };
});
await check('Safe Haven sandbox treasury', async () => {
  const accounts = await safe.call('/accounts?isSubAccount=false&page=0&limit=100');
  if (!Array.isArray(accounts)) throw new PreflightBlocked('Invalid account catalog');
  const account = accounts.find(
    (row) => row.accountNumber === settings.finance.treasuryAccountNumber,
  );
  if (!account) throw new PreflightBlocked('Configured treasury account not found');
  if (Number(account.availableBalance ?? 0) <= 0)
    throw new PreflightBlocked('Sandbox treasury has no available funds');
  return { treasuryFound: true, treasuryHasBalance: Number(account.availableBalance ?? 0) > 0 };
});
await check('Safe Haven sandbox VAS catalog', async () => {
  const services = await safe.call('/vas/services');
  if (!Array.isArray(services) || !services.length)
    throw new PreflightBlocked('No service catalog returned');
  return { serviceCount: services.length };
});
await check('Sudo sandbox settlement accounts', async () => {
  const accounts = await sudo.call('/accounts?page=1&limit=100');
  if (!Array.isArray(accounts) || !accounts.length)
    throw new PreflightBlocked('No Sudo sandbox settlement accounts exist');
  return {
    accountCount: accounts.length,
    ngnAccountCount: accounts.filter((row) => row.currency === 'NGN').length,
  };
});
await check('Sudo sandbox funding gateway', async () => {
  if (!settings.finance.ngnFundingSourceId) throw new PreflightBlocked('Missing funding source');
  const source = await sudo.call(
    `/fundingsources/${encodeURIComponent(settings.finance.ngnFundingSourceId)}`,
  );
  if (
    source.type !== 'gateway' ||
    source.status !== 'active' ||
    source.jitGateway?.authorizeByDefault !== false ||
    source.jitGateway?.url !== `${settings.publicUrl.replace(/\/$/, '')}/api/finance/webhooks/sudo`
  ) {
    throw new PreflightBlocked(
      'An active gateway with authorizeByDefault=false and a matching public callback is required',
    );
  }
  return { gatewayValidated: true };
});
const missing = ['SAFE_HAVEN_BANK_CODE', 'SUDO_NGN_SETTLEMENT_ID', 'FINANCE_API_URL'].filter(
  (name) => !process.env[name],
);
if (!settings.publicUrl.startsWith('https://'))
  missing.push('PUBLIC_URL (public HTTPS callback origin)');
console.log(JSON.stringify({ environment: 'sandbox', checks, missing }, null, 2));
if (checks.some((check) => check.status !== 'PASS') || missing.length) process.exitCode = 1;
