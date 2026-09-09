/**
 * Storage catalog: the only buckets the API knows about.
 *
 * Every upload/download must reference one of these — unknown buckets are
 * rejected before any HTTP call leaves the server. Avatars live in a public
 * bucket (objects readable without a signed URL); KYC documents and chat
 * files stay private and are only reachable via short-lived signed URLs.
 */
export type StorageBucketName = 'bonde-avatars' | 'bonde-kyc-docs' | 'bonde-chat-files';

export interface StorageBucketDefinition {
  name: StorageBucketName;
  public: boolean;
  maxBytes: number;
  allowedContentTypes: string[];
  minExpiresIn: number;
  maxExpiresIn: number;
  defaultExpiresIn: number;
}

export const STORAGE_BUCKETS: Record<StorageBucketName, StorageBucketDefinition> = {
  'bonde-avatars': {
    name: 'bonde-avatars',
    public: true,
    maxBytes: 5 * 1024 * 1024,
    allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp'],
    minExpiresIn: 60,
    maxExpiresIn: 3600,
    defaultExpiresIn: 900,
  },
  'bonde-kyc-docs': {
    name: 'bonde-kyc-docs',
    public: false,
    maxBytes: 10 * 1024 * 1024,
    allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    minExpiresIn: 60,
    maxExpiresIn: 3600,
    defaultExpiresIn: 600,
  },
  'bonde-chat-files': {
    name: 'bonde-chat-files',
    public: false,
    maxBytes: 15 * 1024 * 1024,
    allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    minExpiresIn: 60,
    maxExpiresIn: 3600,
    defaultExpiresIn: 600,
  },
};

export const STORAGE_BUCKET_NAMES: StorageBucketName[] = Object.keys(
  STORAGE_BUCKETS,
) as StorageBucketName[];

/** Options for `StorageService.signUploadUrl`. */
export interface SignUploadUrlOptions {
  contentType: string;
  size?: number;
  expiresIn?: number;
}

/** Options for `StorageService.signDownloadUrl`. */
export interface SignUrlOptions {
  expiresIn?: number;
}

/** Options for server-side `StorageService.upload`. */
export interface UploadOptions {
  expiresIn?: number;
  upsert?: boolean;
}

export interface SignedUploadUrlResult {
  bucket: StorageBucketName;
  path: string;
  method: 'PUT';
  uploadUrl: string;
  headers: Record<string, string>;
  expiresIn: number;
}

export interface SignedUrlResult {
  bucket: StorageBucketName;
  path: string;
  signedUrl: string;
  expiresIn: number;
}

export interface PublicUrlResult {
  bucket: StorageBucketName;
  path: string;
  publicUrl: string;
}
