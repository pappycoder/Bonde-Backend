import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../../config/configuration.js';

/**
 * Domain of failure surfaced by the identity provider. The auth service maps
 * these to HTTP semantics; unknown upsides degrade to `PROVIDER` (502).
 */
export type AuthProviderErrorCode =
  | 'USER_EXISTS'
  | 'INVALID_CREDENTIALS'
  | 'EMAIL_NOT_CONFIRMED'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'CONFIG'
  | 'PROVIDER';

/** Identity-provider failure with a normalized, mappable code. */
export class AuthProviderError extends Error {
  constructor(
    readonly code: AuthProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthProviderError';
  }
}

export interface SupabaseUser {
  id: string;
  email: string;
  phone: string | null;
  emailConfirmed: boolean;
}

export interface SupabaseSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  /** GoTrue `session_id` — stable per issued token pair, absent on older payloads. */
  sessionId: string | null;
  user: SupabaseUser;
}

export interface SupabaseAuthGateway {
  /** Create an auth.users row via the Admin API. */
  signUp(input: {
    email: string;
    password: string;
    fullName: string;
    /** Bonde role, written to `app_metadata.role` (never user_metadata). */
    role?: 'USER' | 'ADMIN' | 'SUPER_ADMIN';
    /** Pre-confirm the address (invite links are the email proof). */
    emailConfirm?: boolean;
  }): Promise<SupabaseUser>;
  /** Password grant against GoTrue (anon key only). */
  signInWithPassword(email: string, password: string): Promise<SupabaseSession>;
  /** Refresh-token grant against GoTrue (anon key only). */
  refresh(refreshToken: string): Promise<SupabaseSession>;
  /** Confirm an email via the Admin API. */
  confirmEmail(userId: string): Promise<void>;
  /** Set a new password via the Admin API. */
  setPassword(userId: string, password: string): Promise<void>;
  /**
   * Merge display metadata (name, avatar) into `auth.users.user_metadata` via
   * the Admin API so the JWT + any new session reflect profile edits.
   */
  updateUserMetadata(userId: string, metadata: Record<string, unknown>): Promise<void>;
}

/** Binding token — tests replace it with an in-memory fake. */
export const SUPABASE_AUTH_BODY = Symbol('SUPABASE_AUTH_BODY');

const REQUEST_TIMEOUT_MS = 10_000;

const ERROR_CODE_MAP: Partial<Record<string, AuthProviderErrorCode>> = {
  email_exists: 'USER_EXISTS',
  user_already_exists: 'USER_EXISTS',
  users_email_address_already_exist: 'USER_EXISTS',
  invalid_credentials: 'INVALID_CREDENTIALS',
  invalid_grant: 'INVALID_CREDENTIALS',
  email_not_confirmed: 'EMAIL_NOT_CONFIRMED',
  user_not_found: 'NOT_FOUND',
  validation_failed: 'VALIDATION',
  weakpassworderror: 'VALIDATION',
  weak_password: 'VALIDATION',
  email_address_invalid: 'VALIDATION',
  invalid_email: 'VALIDATION',
  invalid_email_address: 'VALIDATION',
  invalid_jwt: 'CONFIG',
  signup_disabled: 'CONFIG',
  signups_disabled: 'CONFIG',
};

/**
 * GoTrue's error envelope. `code` is the HTTP status mirrored as a *number* in
 * current versions, with the meaningful token in `error_code`; older builds put
 * a string token in `code`. Typing `code` as a string is what hid the crash
 * below from the compiler.
 */
interface GoTrueErrorBody {
  code?: string | number;
  error_code?: string;
  msg?: string;
  error?: string;
  error_description?: string;
}

interface GoTrueUser {
  id: string;
  email: string;
  phone?: string | null;
  email_confirmed_at?: string | null;
  session_id?: string | null;
}

interface GoTrueTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: GoTrueUser;
}

/**
 * Minimal GoTrue REST client. Registration + password changes go through the
 * **Admin API** (service-role key, server-only, deterministic `email_confirm`);
 * login/refresh use the public **token endpoint** with the anon key. This is
 * the only place in the app that talks to Supabase Auth — the global
 * `SupabaseAuthGuard` keeps verifying JWTs against the JWKS endpoint.
 */
@Injectable()
export class SupabaseAuthClient implements SupabaseAuthGateway {
  private readonly baseUrl: string;
  private readonly anonKey: string;
  private readonly serviceRoleKey: string;

  constructor(config: ConfigService<AppConfig, true>) {
    const supabase = config.get('supabase');
    this.baseUrl = `${supabase.url.replace(/\/+$/, '')}/auth/v1`;
    this.anonKey = supabase.anonKey;
    this.serviceRoleKey = supabase.serviceRoleKey;
  }

  async signUp(input: {
    email: string;
    password: string;
    fullName: string;
    role?: 'USER' | 'ADMIN' | 'SUPER_ADMIN';
    emailConfirm?: boolean;
  }): Promise<SupabaseUser> {
    const user = await this.request<GoTrueUser>('/admin/users', {
      method: 'POST',
      useServiceRole: true,
      body: {
        email: input.email,
        password: input.password,
        email_confirm: input.emailConfirm ?? false,
        user_metadata: { full_name: input.fullName },
        ...(input.role ? { app_metadata: { role: input.role } } : {}),
      },
    });
    return this.toUser(user);
  }

  async signInWithPassword(email: string, password: string): Promise<SupabaseSession> {
    return this.token({ grant_type: 'password', email, password });
  }

  async refresh(refreshToken: string): Promise<SupabaseSession> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async confirmEmail(userId: string): Promise<void> {
    await this.request<GoTrueUser>(`/admin/users/${userId}`, {
      method: 'PUT',
      useServiceRole: true,
      body: { email_confirm: true },
    });
  }

  async setPassword(userId: string, password: string): Promise<void> {
    await this.request<GoTrueUser>(`/admin/users/${userId}`, {
      method: 'PUT',
      useServiceRole: true,
      body: { password },
    });
  }

  async updateUserMetadata(userId: string, metadata: Record<string, unknown>): Promise<void> {
    // Read-merge-write so unrelated keys in user_metadata are never dropped.
    const current = await this.request<{ user_metadata?: Record<string, unknown> }>(
      `/admin/users/${userId}`,
      { method: 'GET', useServiceRole: true },
    );
    await this.request<GoTrueUser>(`/admin/users/${userId}`, {
      method: 'PUT',
      useServiceRole: true,
      body: { user_metadata: { ...current.user_metadata, ...metadata } },
    });
  }

  private async token(body: Record<string, unknown>): Promise<SupabaseSession> {
    const session = await this.request<GoTrueTokenResponse>('/token', {
      method: 'POST',
      useServiceRole: false,
      body,
    });
    return {
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresIn: session.expires_in,
      sessionId: session.user.session_id ?? null,
      user: this.toUser(session.user),
    };
  }

  private async request<T>(
    path: string,
    init: {
      method: 'GET' | 'POST' | 'PUT';
      useServiceRole: boolean;
      body?: Record<string, unknown>;
    },
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: {
          apikey: this.anonKey,
          'content-type': 'application/json',
          ...(init.useServiceRole ? { authorization: `Bearer ${this.serviceRoleKey}` } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });

      const body = (await this.parseBody(response)) as GoTrueUser | GoTrueTokenResponse | null;
      if (!response.ok) {
        throw this.toProviderError(response.status, body as GoTrueErrorBody, init.useServiceRole);
      }
      return body as T;
    } catch (error) {
      if (error instanceof AuthProviderError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new AuthProviderError('PROVIDER', `Identity provider unreachable: ${detail}`);
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

  private toProviderError(
    status: number,
    body: GoTrueErrorBody | null,
    useServiceRole: boolean,
  ): AuthProviderError {
    const message = this.messageOf(status, body);
    // `error_code` first: current GoTrue puts the token there and mirrors the
    // HTTP status in a numeric `code`, so `(body.code).toLowerCase()` threw a
    // TypeError that the caller rewrapped as "provider unreachable" — every 4xx
    // and 5xx from GoTrue was reported as an outage, whatever the real cause.
    const token = body?.error_code ?? body?.code ?? body?.error ?? '';
    const known = ERROR_CODE_MAP[String(token).toLowerCase()];
    if (known) return new AuthProviderError(known, message);

    if (useServiceRole) {
      if (status === 401) return new AuthProviderError('CONFIG', message);
      if (status === 400 || status === 422) return new AuthProviderError('VALIDATION', message);
    } else {
      if (status === 400 || status === 401)
        return new AuthProviderError('INVALID_CREDENTIALS', message);
    }
    return new AuthProviderError('PROVIDER', message);
  }

  private messageOf(status: number, body: GoTrueErrorBody | null): string {
    const detail =
      body?.msg ?? body?.error_description ?? body?.error ?? body?.error_code ?? body?.code;
    return detail ? `GoTrue ${status}: ${String(detail)}` : `GoTrue returned ${status}`;
  }

  private toUser(user: GoTrueUser): SupabaseUser {
    return {
      id: user.id,
      email: user.email,
      phone: user.phone ?? null,
      emailConfirmed: Boolean(user.email_confirmed_at),
    };
  }
}
