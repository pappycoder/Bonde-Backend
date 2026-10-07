import { KycProviderError, type KycProvider, type KycProviderResult } from './kyc.types.js';

const REQUEST_TIMEOUT_MS = 10_000;

/** Fields Dojah returns for a matched BVN that prove the record is real. */
const CORE_FIELDS = ['first_name', 'last_name', 'date_of_birth'] as const;

interface DojahVerifyPayload {
  entity?: Record<string, unknown> | null;
  data?: Record<string, unknown> | null;
  error?: string | null;
  message?: string | null;
}

/**
 * Dojah KYC client. Bearer + AppId authenticated against the configured
 * credentials; every call carries a 10s timeout. This is the only place that
 * talks to Dojah directly. `GET /api/v1/kyc/bvn` requires only the BVN (the
 * firstName/lastName/dob params are optional and unused here — we do not
 * name-match); Dojah returns a matching `entity` on success and an error
 * otherwise.
 */
export class DojahKycClient implements KycProvider {
  private readonly baseUrl: string;
  private readonly appId: string;
  private readonly secretKey: string;

  constructor(config: { baseUrl: string; appId: string; secretKey: string }) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.appId = config.appId;
    this.secretKey = config.secretKey;
  }

  verifyBvn(bvn: string): Promise<KycProviderResult> {
    return this.verify('/api/v1/kyc/bvn', bvn);
  }

  private async verify(path: string, bvn: string): Promise<KycProviderResult> {
    if (!this.appId || !this.secretKey) {
      // Fail closed rather than reporting a false success.
      throw new KycProviderError('CONFIG', 'KYC provider is not configured');
    }

    const query = new URLSearchParams({ bvn }).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.baseUrl}${path}?${query}`, {
        method: 'GET',
        headers: {
          Authorization: this.secretKey,
          AppId: this.appId,
        },
        signal: controller.signal,
      });

      const payload = (await this.parseBody(response)) as DojahVerifyPayload | null;
      if (!response.ok) {
        throw new KycProviderError(
          response.status === 401 || response.status === 403 ? 'CONFIG' : 'PROVIDER',
          payload?.error ?? payload?.message ?? 'KYC provider rejected the request',
        );
      }

      const entity = payload?.entity ?? payload?.data ?? null;
      // Dojah has no boolean "verified": a match is proven by a non-empty entity
      // carrying the person's core fields. A lookup that finds nothing returns no
      // such entity, so this rejects empty/partial responses.
      const verified =
        entity != null && CORE_FIELDS.every((field) => isPresent(entity[field])) && !payload?.error;
      const reference = entity && typeof entity.id === 'string' ? entity.id : undefined;
      return {
        verified,
        reference,
        message: payload?.message ?? payload?.error ?? undefined,
        raw: { provider: 'dojah', entityStatus: entity?.['status'] ?? null },
      };
    } catch (error) {
      if (error instanceof KycProviderError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new KycProviderError('PROVIDER', `KYC provider unreachable: ${detail}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async parseBody(response: Response): Promise<unknown | null> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
}

function isPresent(value: unknown): boolean {
  return typeof value === 'string' ? value.trim().length > 0 : value != null;
}
