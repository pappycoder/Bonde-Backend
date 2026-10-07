/**
 * Result of a single identifier check against the KYC provider.
 *
 * `raw` is provider metadata safe to persist (references, status strings). It
 * must never contain the submitted identifier.
 */
export interface KycProviderResult {
  verified: boolean;
  reference?: string;
  message?: string;
  raw?: Record<string, unknown>;
}

/**
 * Provider surface the KYC service talks to. Injected under the `KYC_PROVIDER`
 * token — e2e swaps it for an in-memory fake while the real service runs on top.
 */
export interface KycProvider {
  verifyBvn(bvn: string): Promise<KycProviderResult>;
}

/** Binding token — tests replace it with a fake. */
export const KYC_PROVIDER = Symbol('KYC_PROVIDER');

/**
 * Domain of failure surfaced by the KYC provider. The service maps these to
 * HTTP semantics: `CONFIG` → 503, `VALIDATION` → 400, `PROVIDER` → 502.
 */
export type KycProviderErrorCode = 'CONFIG' | 'VALIDATION' | 'PROVIDER';

export class KycProviderError extends Error {
  constructor(
    readonly code: KycProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'KycProviderError';
  }
}
