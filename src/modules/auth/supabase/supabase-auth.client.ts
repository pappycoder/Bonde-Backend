import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../../config/configuration.js';

/**
 * Domain of failure surfaced by the identity provider. The auth service maps
 * these to HTTP semantics; unknown upsides degrade to `PROVIDER` (502).
 */
export type AuthProviderErrorCode =
  'USER_EXISTS' | 'INVALID_CREDENTIALS' | 'EMAIL_NOT_CONFIRMED' | 'NOT_FOUND' | 'PROVIDER';

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
  user: SupabaseUser;
}

export interface SupabaseAuthGateway {
  /** Create an auth.users row via the Admin API. */
  signUp(input: { email: string; password: string; fullName: string }): Promise<SupabaseUser>;
  /** Password grant against GoTrue (anon key only). */
  signInWithPassword(email: string, password: string): Promise<SupabaseSession>;
  /** Refresh-token grant against GoTrue (anon key only). */
  refresh(refreshToken: string): Promise<SupabaseSession>;
  /** Confirm an email via the Admin API. */
  confirmEmail(userId: string): Promise<void>;
  /** Set a new password via the Admin API. */
  setPassword(userId: string, password: string): Promise<void>;
}

/** Binding token — tests replace it with an in-memory fake. */
export const SUPABASE_AUTH_BODY = Symbol('SUPABASE_AUTH_BODY');

const REQUEST_TIMEOUT_MS = 10_000;

const ERROR_CODE_MAP: Record<string, AuthProviderErrorCode> = {
  email_exists: 'USER_EXISTS',
  user_already_exists: 'USER_EXISTS',
  users_email_address_already_exist: 'USER_EXISTS',
  invalid_credentials: 'INVALID_CREDENTIALS',
  email_not_confirmed: 'EMAIL_NOT_CONFIRMED',
  user_not_found: 'NOT_FOUND',
};

interface GoTrueUser {
  id: string;
  email: string;
  phone?: string | null;
  email_confirmed_at?: string | null;
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
  }): Promise<SupabaseUser> {
    const user = await this.request<GoTrueUser>('/admin/users', {
      method: 'POST',
      useServiceRole: true,
      body: {
        email: input.email,
        password: input.password,
        email_confirm: false,
        user_metadata: { full_name: input.fullName },
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
      user: this.toUser(session.user),
    };
  }

  private async request<T>(
    path: string,
    init: { method: 'POST' | 'PUT'; useServiceRole: boolean; body: Record<string, unknown> },
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
        body: JSON.stringify(init.body),
        signal: controller.signal,
      });

      const body = (await this.parseBody(response)) as GoTrueUser | GoTrueTokenResponse | null;
      if (!response.ok) {
        throw this.toProviderError(response.status, body as { code?: string; msg?: string });
      }
      return body as T;
    } catch (error) {
      if (error instanceof AuthProviderError) throw error;
      throw new AuthProviderError('PROVIDER', 'Identity provider unreachable');
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
    body: { code?: string; msg?: string } | null,
  ): AuthProviderError {
    const code = ERROR_CODE_MAP[body?.code ?? ''];
    const message = body?.msg ?? body?.code ?? `Provider returned ${status}`;
    return new AuthProviderError(code ?? 'PROVIDER', message);
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
