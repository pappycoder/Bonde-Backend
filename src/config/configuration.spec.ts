import { afterEach, describe, expect, it, vi } from 'vitest';
import configuration from './configuration.js';
import { envValidationSchema } from './env.validation.js';

afterEach(() => vi.unstubAllEnvs());
describe('simple shopping configuration', () => {
  it('defaults to the cheap model and disabled paid capabilities without provider credentials', () => {
    for (const key of [
      'OPENAI_SHOPPING_MODEL',
      'AI_SHOPPING_ENABLED',
      'BRAVE_SEARCH_API_KEY',
      'SHOPPING_MERCHANT_HOSTS',
      'SERVICE_PURCHASES_ENABLED',
    ])
      vi.stubEnv(key, '');
    expect(configuration().shopping).toMatchObject({
      model: 'gpt-6-luna',
      aiEnabled: false,
      braveEnabled: false,
      servicesEnabled: false,
    });
  });
  it('infers search from key and allowlist, independent of the retired switch', () => {
    vi.stubEnv('BRAVE_SEARCH_API_KEY', 'test-key');
    vi.stubEnv('SHOPPING_MERCHANT_HOSTS', ' Shop.Example , second.example ');
    vi.stubEnv('SHOPPING_SEARCH_ENABLED', 'false');
    expect(configuration().shopping).toMatchObject({
      braveEnabled: true,
      merchantHosts: ['shop.example', 'second.example'],
    });
    vi.stubEnv('SHOPPING_MERCHANT_HOSTS', '');
    expect(configuration().shopping.braveEnabled).toBe(false);
  });
  it('validates a minimal setup with optional integrations absent and consistent defaults', () => {
    const result = envValidationSchema.validate({
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_ANON_KEY: 'test-anon',
      SUPABASE_SERVICE_ROLE_KEY: 'test-role',
      AUTH_TOKEN_SECRET: 'x'.repeat(32),
      DATABASE_URL: 'postgresql://test',
      DIRECT_URL: 'postgresql://test',
      RESEND_API_KEY: 'test-mail',
      TERMII_API_KEY: 'test-sms',
      CARD_ENCRYPTION_KEY: 'a'.repeat(64),
      OPENAI_SHOPPING_MODEL: '',
    });
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({
      OPENAI_SHOPPING_MODEL: 'gpt-6-luna',
      SERVICE_PURCHASES_ENABLED: false,
      FINANCE_ENABLED: false,
    });
    expect(envValidationSchema.validate({}).error).toBeDefined();
  });
});
