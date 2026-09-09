import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/configuration.js';
import {
  STORAGE_BUCKETS,
  type PublicUrlResult,
  type SignUploadUrlOptions,
  type SignedUploadUrlResult,
  type SignedUrlResult,
  type SignUrlOptions,
  type StorageBucketDefinition,
  type StorageBucketName,
  type UploadOptions,
} from './storage.types.js';

const FETCH_TIMEOUT_MS = 10_000;
const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENTS = 100;
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Thin client over the Supabase Storage REST API (`{SUPABASE_URL}/storage/v1`)
 * using the **service-role key** (server-only — never exposed to clients).
 *
 * The service owns the security guardrails: bucket must be in the catalog,
 * paths are validated segment-by-segment (no `..`, no leading `/`, no spaces),
 * content-types must be allowed for the bucket, declared sizes must fit the
 * bucket cap, and signed-URL lifetimes are clamped to the bucket's bounds.
 *
 * Outages fail closed as `ServiceUnavailableException` — blob storage is a
 * write-path dependency, so the API must not act as if an upload succeeded.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger('StorageService');
  private readonly baseUrl: string;
  private readonly serviceRoleKey: string;

  constructor(config: ConfigService<AppConfig, true>) {
    const supabase = config.get('supabase');
    this.baseUrl = `${supabase.url}/storage/v1`;
    this.serviceRoleKey = supabase.serviceRoleKey;
  }

  getBucket(name: StorageBucketName): StorageBucketDefinition {
    const bucket = STORAGE_BUCKETS[name];
    if (!bucket) throw new BadRequestException(`Unknown storage bucket: "${name}"`);
    return bucket;
  }

  private validatePath(bucket: StorageBucketName, path: string): string {
    if (!path || path.length > MAX_PATH_LENGTH) {
      throw new BadRequestException('Storage path is empty or too long');
    }
    if (path.startsWith('/') || path.includes('\\')) {
      throw new BadRequestException('Storage path must be relative (no leading slash)');
    }
    const segments = path.split('/');
    if (segments.length > MAX_SEGMENTS) {
      throw new BadRequestException('Storage path has too many segments');
    }
    for (const segment of segments) {
      if (!SEGMENT_PATTERN.test(segment)) {
        throw new BadRequestException(`Invalid storage path segment: "${segment}"`);
      }
    }
    return segments.map(encodeURIComponent).join('/');
  }

  private clampExpiresIn(bucket: StorageBucketDefinition, expiresIn?: number): number {
    if (expiresIn === undefined) return bucket.defaultExpiresIn;
    if (!Number.isInteger(expiresIn) || expiresIn <= 0) {
      throw new BadRequestException('expiresIn must be a positive integer (seconds)');
    }
    return Math.min(Math.max(expiresIn, bucket.minExpiresIn), bucket.maxExpiresIn);
  }

  private assertContentType(bucket: StorageBucketDefinition, contentType: string): void {
    if (!contentType || !bucket.allowedContentTypes.includes(contentType)) {
      throw new BadRequestException(
        `Content type "${contentType}" is not allowed for bucket "${bucket.name}"`,
      );
    }
  }

  private assertSize(bucket: StorageBucketDefinition, size?: number): void {
    if (size !== undefined && (!Number.isInteger(size) || size < 1 || size > bucket.maxBytes)) {
      throw new BadRequestException(
        `Declared size must be between 1 and ${bucket.maxBytes} bytes for bucket "${bucket.name}"`,
      );
    }
  }

  /** Short-lived PUT URL so clients upload straight to Supabase (no proxy). */
  async signUploadUrl(
    bucketName: StorageBucketName,
    path: string,
    options: SignUploadUrlOptions,
  ): Promise<SignedUploadUrlResult> {
    const bucket = this.getBucket(bucketName);
    const encodedPath = this.validatePath(bucketName, path);
    this.assertContentType(bucket, options.contentType);
    this.assertSize(bucket, options.size);
    const expiresIn = this.clampExpiresIn(bucket, options.expiresIn);

    const body: unknown = await this.request(`/object/upload/sign/${bucketName}/${encodedPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn }),
    });

    const signedUrl = this.extractSignedPath(body);
    const uploadUrl = signedUrl.startsWith('http') ? signedUrl : `${this.baseUrl}${signedUrl}`;
    return {
      bucket: bucketName,
      path,
      method: 'PUT',
      uploadUrl,
      headers: { 'content-type': options.contentType },
      expiresIn,
    };
  }

  /** Short-lived GET URL for a private object (or public object read without auth). */
  async signDownloadUrl(
    bucketName: StorageBucketName,
    path: string,
    options: SignUrlOptions = {},
  ): Promise<SignedUrlResult> {
    const bucket = this.getBucket(bucketName);
    const encodedPath = this.validatePath(bucketName, path);
    const expiresIn = this.clampExpiresIn(bucket, options.expiresIn);

    const body: unknown = await this.request(`/object/sign/${bucketName}/${encodedPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn }),
    });

    const signedPath = this.extractSignedPath(body);
    return {
      bucket: bucketName,
      path,
      signedUrl: signedPath.startsWith('http') ? signedPath : `${this.baseUrl}${signedPath}`,
      expiresIn,
    };
  }

  /** Public stable URL for objects in public buckets (no auth, no expiry). */
  getPublicUrl(bucketName: StorageBucketName, path: string): PublicUrlResult {
    const bucket = this.getBucket(bucketName);
    const encodedPath = this.validatePath(bucketName, path);
    if (!bucket.public) {
      throw new BadRequestException(`Bucket "${bucketName}" is not public`);
    }
    return {
      bucket: bucketName,
      path,
      publicUrl: `${this.baseUrl}/object/public/${bucketName}/${encodedPath}`,
    };
  }

  /** Server-side upload (admin/trusted flows; mobile uses `signUploadUrl`). */
  async upload(
    bucketName: StorageBucketName,
    path: string,
    data: Buffer,
    contentType: string,
    options: UploadOptions = {},
  ): Promise<void> {
    const bucket = this.getBucket(bucketName);
    const encodedPath = this.validatePath(bucketName, path);
    this.assertContentType(bucket, contentType);

    const headers: Record<string, string> = { 'Content-Type': contentType };
    if (options.upsert) headers['x-upsert'] = 'true';

    await this.request(`/object/${bucketName}/${encodedPath}`, {
      method: 'POST',
      headers,
      body: new Uint8Array(data),
    });
  }

  async remove(bucketName: StorageBucketName, path: string): Promise<void> {
    this.getBucket(bucketName);
    const encodedPath = this.validatePath(bucketName, path);
    await this.request('/object/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [`${bucketName}/${encodedPath}`] }),
    });
  }

  async list(
    bucketName: StorageBucketName,
    prefix?: string,
  ): Promise<{ name: string; id?: string }[]> {
    this.getBucket(bucketName);
    let encodedPrefix: string | undefined;
    if (prefix) {
      encodedPrefix = this.validatePath(bucketName, prefix);
    }
    const body: unknown = await this.request(`/object/list/${bucketName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prefix: encodedPrefix ?? '',
        limit: 1000,
        offset: 0,
        sortBy: { column: 'name', order: 'asc' },
      }),
    });
    return Array.isArray(body)
      ? (body as { name?: string; id?: string }[]).filter(
          (entry): entry is { name: string; id?: string } => typeof entry?.name === 'string',
        )
      : [];
  }

  /** Idempotently create a catalog bucket; resolves `true` when it was created. */
  async ensureBucket(bucketName: StorageBucketName): Promise<boolean> {
    const bucket = this.getBucket(bucketName);

    let exists = true;
    try {
      await this.request(`/bucket/${bucketName}`, { method: 'GET' });
    } catch (error) {
      if (error instanceof NotFoundException) {
        exists = false;
      } else if (error instanceof HttpException) {
        throw error;
      } else {
        throw new ServiceUnavailableException('Storage is unreachable');
      }
    }
    if (exists) return false;

    await this.request('/bucket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: bucket.name,
        public: bucket.public,
        file_size_limit: bucket.maxBytes,
        allowed_mime_types: bucket.allowedContentTypes,
      }),
    });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Internal HTTP plumbing
  // ---------------------------------------------------------------------------

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.serviceRoleKey}`,
      apikey: this.serviceRoleKey,
    };
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await globalThis.fetch(`${this.baseUrl}${path}`, {
        ...init,
        ...(init.body instanceof Uint8Array || typeof init.body === 'string'
          ? { body: init.body }
          : {}),
        signal: controller.signal,
        headers: { ...this.authHeaders(), ...(init.headers as Record<string, string> | undefined) },
      });
    } catch (error) {
      this.logger.error(`Storage ${init.method ?? 'GET'} ${path} failed`, (error as Error).stack);
      throw new ServiceUnavailableException('Storage is unreachable');
    } finally {
      clearTimeout(timer);
    }

    let body: unknown = null;
    if (response.status !== 204) {
      body = await response.json().catch(() => null);
    }
    if (!response.ok) this.throwForStatus(response.status, body);
    return body;
  }

  private extractSignedPath(body: unknown): string {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const value = record.signedUrl ?? record.signedURL ?? record.signed_url;
    if (typeof value !== 'string' || value.length === 0) {
      throw new ServiceUnavailableException('Storage returned an invalid signed URL');
    }
    return value;
  }

  private throwForStatus(status: number, body: unknown): never {
    const detail = this.messageFrom(body) ?? `Storage request failed (HTTP ${status})`;
    switch (status) {
      case 400:
      case 422:
        throw new BadRequestException(detail);
      case 401:
      case 403:
        throw new ForbiddenException(detail);
      case 404:
        throw new NotFoundException(detail);
      case 409:
        throw new ConflictException(detail);
      default:
        this.logger.error(`Storage returned HTTP ${status}: ${detail}`);
        throw new ServiceUnavailableException('Storage is unavailable');
    }
  }

  private messageFrom(body: unknown): string | undefined {
    if (!body || typeof body !== 'object') return undefined;
    const record = body as Record<string, unknown>;
    if (typeof record.message === 'string') return record.message;
    if (Array.isArray(record.message)) {
      const first = record.message[0];
      if (typeof first === 'string') return first;
    }
    return undefined;
  }
}
