/**
 * Unified object-storage abstraction for attachments. Supports three providers,
 * chosen by `settings.storageProvider`:
 *   - 'gcs'    → Google Cloud Storage (@google-cloud/storage, service-account JSON)
 *   - 's3'     → AWS S3 (@aws-sdk/client-s3)
 *   - 'spaces' → DigitalOcean Spaces (S3-compatible; custom endpoint)
 *
 * Credentials come from decrypted org settings. Throws a clear error when no
 * backend is configured. S3 and Spaces share one code path (the AWS SDK).
 */
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Storage as GcsStorage } from '@google-cloud/storage';
import type { OrganizationSettings, StorageProvider } from '@enlight/shared';

export class StorageNotConfiguredError extends Error {}

export interface StorageBackend {
  provider: StorageProvider;
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  signedDownloadUrl(key: string, filename: string): Promise<string>;
  deleteObject(key: string): Promise<void>;
  /** Round-trip a tiny object to prove credentials + bucket access. */
  testConnection(): Promise<void>;
}

const SIGNED_URL_TTL = 300; // seconds

/** Resolve the storage backend for the org's active provider (or a specific one). */
export function getStorageBackend(
  orgSettings: OrganizationSettings,
  provider?: StorageProvider,
): StorageBackend {
  const p = provider ?? orgSettings.storageProvider ?? 'none';
  if (p === 'none') throw new StorageNotConfiguredError('No storage backend is configured (Settings → Cloud).');
  if (p === 'gcs') return new GcsBackend(orgSettings);
  return new S3Backend(orgSettings, p); // 's3' | 'spaces'
}

export function isStorageConfigured(orgSettings: OrganizationSettings): boolean {
  return (orgSettings.storageProvider ?? 'none') !== 'none';
}

// ── S3 / Spaces ───────────────────────────────────────────────────────────────

class S3Backend implements StorageBackend {
  provider: StorageProvider;
  private client: S3Client;
  private bucket: string;

  constructor(s: OrganizationSettings, provider: 's3' | 'spaces') {
    this.provider = provider;
    const cfg = provider === 's3' ? s.aws : s.digitalocean;
    const accessKeyId = cfg?.accessKeyId ?? '';
    const secretAccessKey = cfg?.secretAccessKey ?? '';
    const region = cfg?.region ?? (provider === 's3' ? 'us-east-1' : 'nyc3');
    this.bucket = cfg?.bucket ?? '';
    if (!accessKeyId || !secretAccessKey || !this.bucket) {
      throw new StorageNotConfiguredError(
        `${provider === 's3' ? 'AWS S3' : 'DigitalOcean Spaces'} is not fully configured (key, secret, bucket).`,
      );
    }
    // Spaces uses a derived endpoint; S3 may use a custom endpoint (MinIO/Wasabi/B2),
    // which requires path-style addressing.
    const customEndpoint = provider === 's3' ? s.aws?.endpoint : undefined;
    this.client = new S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
      ...(provider === 'spaces' ? { endpoint: `https://${region}.digitaloceanspaces.com`, forcePathStyle: false } : {}),
      ...(customEndpoint ? { endpoint: customEndpoint, forcePathStyle: true } : {}),
    });
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async signedDownloadUrl(key: string, filename: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${filename.replace(/"/g, '')}"`,
      }),
      { expiresIn: SIGNED_URL_TTL },
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async testConnection(): Promise<void> {
    const key = `__enlight_test__/${Date.now()}.txt`;
    await this.putObject(key, Buffer.from('ok'), 'text/plain');
    await this.deleteObject(key);
  }
}

// ── Google Cloud Storage ────────────────────────────────────────────────────

class GcsBackend implements StorageBackend {
  provider: StorageProvider = 'gcs';
  private storage: GcsStorage;
  private bucket: string;

  constructor(s: OrganizationSettings) {
    const json = s.gcp?.serviceAccountJson ?? '';
    this.bucket = s.gcp?.storageBucket ?? '';
    if (!json || !this.bucket) {
      throw new StorageNotConfiguredError('Google Cloud Storage is not fully configured (service account + bucket).');
    }
    let creds: { project_id?: string };
    try {
      creds = JSON.parse(json);
    } catch {
      throw new StorageNotConfiguredError('GCP service-account JSON is invalid.');
    }
    const projectId = s.gcp?.projectId || creds.project_id;
    this.storage = new GcsStorage({ credentials: JSON.parse(json), ...(projectId ? { projectId } : {}) });
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.storage.bucket(this.bucket).file(key).save(body, { contentType, resumable: false });
  }

  async signedDownloadUrl(key: string, filename: string): Promise<string> {
    const [url] = await this.storage.bucket(this.bucket).file(key).getSignedUrl({
      action: 'read',
      expires: Date.now() + SIGNED_URL_TTL * 1000,
      responseDisposition: `attachment; filename="${filename.replace(/"/g, '')}"`,
    });
    return url;
  }

  async deleteObject(key: string): Promise<void> {
    await this.storage.bucket(this.bucket).file(key).delete({ ignoreNotFound: true });
  }

  async testConnection(): Promise<void> {
    const key = `__enlight_test__/${Date.now()}.txt`;
    await this.putObject(key, Buffer.from('ok'), 'text/plain');
    await this.deleteObject(key);
  }
}
