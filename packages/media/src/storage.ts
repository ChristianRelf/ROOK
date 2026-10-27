import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageConfig } from '@rook/config';
import type { Logger } from '@rook/observability';

/**
 * Object storage, behind a port.
 *
 * The interface is deliberately small — presign, head, get, put, delete — and
 * says nothing about S3. That is what lets the same code run against SeaweedFS
 * locally and S3, R2 or B2 in production, and it keeps the media worker
 * testable with an in-memory implementation.
 *
 * Nothing outside this file imports the AWS SDK.
 */

export interface ObjectMetadata {
  readonly contentType: string | undefined;
  readonly byteSize: number;
  readonly etag: string | undefined;
}

export interface PresignedUpload {
  readonly url: string;
  /**
   * Headers the client must send for the signature to verify.
   *
   * Returned explicitly because a presigned PUT only matches if the client
   * reproduces the signed headers exactly — a mismatch is a 403 that is
   * otherwise very hard to diagnose from the client side.
   */
  readonly requiredHeaders: Record<string, string>;
  readonly expiresAt: Date;
}

export interface ObjectStoragePort {
  /** A short-lived URL the client may PUT exactly one object to. */
  presignUpload: (options: {
    key: string;
    contentType: string;
    /**
     * Exact byte length the client will upload, taken from its declaration.
     *
     * Signed into the request, so where the storage backend enforces it the
     * client cannot upload a different amount than was authorised. The size
     * is verified again from storage at confirm time, because not every
     * S3-compatible implementation enforces a signed Content-Length.
     */
    contentLength: number;
    expiresInSeconds: number;
  }) => Promise<PresignedUpload>;

  /** A short-lived URL for reading. Used for authorised delivery. */
  presignDownload: (options: {
    key: string;
    expiresInSeconds: number;
    downloadFilename?: string | undefined;
  }) => Promise<{ url: string; expiresAt: Date }>;

  /** Metadata without transferring the body. Undefined when absent. */
  head: (key: string) => Promise<ObjectMetadata | undefined>;

  /**
   * Reads an object into memory, refusing anything larger than `maxByteSize`.
   *
   * The limit is enforced while streaming rather than after, so a storage
   * object that is larger than its recorded size cannot exhaust the worker's
   * heap.
   */
  getBytes: (key: string, maxByteSize: number) => Promise<Buffer>;

  /**
   * Reads only the first `byteCount` bytes, via an HTTP range request.
   *
   * Used to sniff an image's magic bytes at confirm time. Deliberately
   * distinct from `getBytes`: that method caps the *total* object size and
   * throws when it is exceeded, which is exactly the wrong behaviour when the
   * intent is to peek at the start of a large file.
   */
  readPrefix: (key: string, byteCount: number) => Promise<Buffer>;

  put: (options: { key: string; body: Buffer; contentType: string }) => Promise<void>;

  delete: (key: string) => Promise<void>;
}

export class ObjectTooLargeError extends Error {
  constructor(
    readonly key: string,
    readonly limit: number,
  ) {
    super(`Object ${key} exceeds the ${limit} byte limit`);
    this.name = 'ObjectTooLargeError';
  }
}

export function createS3Storage(options: {
  readonly config: StorageConfig;
  readonly logger: Logger;
}): ObjectStoragePort {
  const { config, logger } = options;

  const credentials = {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  };

  /**
   * Shared client settings.
   *
   * `requestChecksumCalculation: 'WHEN_REQUIRED'` is load-bearing, not a
   * tuning knob. Since v3.729 the SDK adds a checksum header to PutObject by
   * default. For a *presigned* PUT that checksum is computed when the URL is
   * signed — with no body present — so the signature commits to the digest of
   * nothing. The client then uploads real bytes and storage rejects it with
   * `BadDigest`. Setting this to WHEN_REQUIRED keeps the SDK from injecting a
   * checksum the client cannot possibly satisfy.
   */
  const clientDefaults = {
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  } as const;

  // Two clients, because presigned URLs must be signed against the host the
  // *client* will reach, while ordinary calls go to the host the service
  // reaches. These differ whenever storage sits on a private network.
  const internalClient = new S3Client({ ...clientDefaults, endpoint: config.endpoint });

  const signingClient =
    config.publicEndpoint === config.endpoint
      ? internalClient
      : new S3Client({ ...clientDefaults, endpoint: config.publicEndpoint });

  return {
    async presignUpload({ key, contentType, contentLength, expiresInSeconds }) {
      // ContentType is part of the signature, so the client cannot upload a
      // different type than was authorised without invalidating the URL.
      const command = new PutObjectCommand({
        Bucket: config.mediaBucket,
        Key: key,
        ContentType: contentType,
        // Signing the length pins the upload to the authorised size where the
        // backend enforces it. Verified again at confirm time regardless.
        ContentLength: contentLength,
      });

      const url = await getSignedUrl(signingClient, command, { expiresIn: expiresInSeconds });

      // Never logged: a presigned URL is a bearer credential for the bucket.
      logger.debug({ key, expiresInSeconds }, 'issued presigned upload URL');

      return {
        url,
        requiredHeaders: {
          'Content-Type': contentType,
        },
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
      };
    },

    async presignDownload({ key, expiresInSeconds, downloadFilename }) {
      const command = new GetObjectCommand({
        Bucket: config.mediaBucket,
        Key: key,
        // Forces a download with a safe name when the caller asks for one.
        ...(downloadFilename !== undefined
          ? {
              ResponseContentDisposition: `attachment; filename="${sanitiseFilename(
                downloadFilename,
              )}"`,
            }
          : {}),
      });

      const url = await getSignedUrl(signingClient, command, { expiresIn: expiresInSeconds });

      return { url, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) };
    },

    async head(key) {
      try {
        const result = await internalClient.send(
          new HeadObjectCommand({ Bucket: config.mediaBucket, Key: key }),
        );

        return {
          contentType: result.ContentType,
          byteSize: result.ContentLength ?? 0,
          etag: result.ETag,
        };
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    },

    async getBytes(key, maxByteSize) {
      const result = await internalClient.send(
        new GetObjectCommand({ Bucket: config.mediaBucket, Key: key }),
      );

      if (result.Body === undefined) {
        throw new Error(`Object ${key} has no body`);
      }

      // Enforced while reading, not after. Trusting Content-Length and then
      // buffering the whole stream is how a worker gets OOM-killed by an
      // object that is bigger than it claims.
      const chunks: Buffer[] = [];
      let total = 0;

      // The SDK types the web stream loosely, so it is narrowed once here
      // rather than letting `any` spread through the chunk loop.
      const stream = result.Body.transformToWebStream() as ReadableStream<Uint8Array>;
      const reader = stream.getReader();

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value === undefined) continue;

          total += value.byteLength;
          if (total > maxByteSize) {
            throw new ObjectTooLargeError(key, maxByteSize);
          }
          chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        }
      } finally {
        // Releasing the lock lets the underlying connection be torn down
        // promptly when we abandon an oversized object.
        reader.releaseLock();
      }

      return Buffer.concat(chunks);
    },

    async readPrefix(key, byteCount) {
      const result = await internalClient.send(
        new GetObjectCommand({
          Bucket: config.mediaBucket,
          Key: key,
          // Inclusive range, so N bytes means 0..N-1.
          Range: `bytes=0-${byteCount - 1}`,
        }),
      );

      if (result.Body === undefined) {
        throw new Error(`Object ${key} has no body`);
      }

      const bytes = await result.Body.transformToByteArray();
      return Buffer.from(bytes);
    },

    async put({ key, body, contentType }) {
      await internalClient.send(
        new PutObjectCommand({
          Bucket: config.mediaBucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ContentLength: body.byteLength,
        }),
      );
    },

    async delete(key) {
      try {
        await internalClient.send(
          new DeleteObjectCommand({ Bucket: config.mediaBucket, Key: key }),
        );
      } catch (error) {
        // Deleting something that is already gone is the desired end state,
        // and the orphan sweeper relies on this being safe to retry.
        if (isNotFound(error)) return;
        throw error;
      }
    },
  };
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const candidate = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };

  return (
    candidate.name === 'NotFound' ||
    candidate.name === 'NoSuchKey' ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

/**
 * Strips anything from a filename that could escape a quoted header value or
 * a directory.
 *
 * The name is only ever used for presentation, never to build a storage key,
 * but it still reaches a response header — so quotes, control characters and
 * path separators have to go.
 */
export function sanitiseFilename(filename: string): string {
  const base = filename.replace(/[\\/]/gu, '_');
  return (
    base
      .replace(/[\p{Cc}"]/gu, '')
      .replace(/^\.+/u, '')
      .slice(0, 200)
      .trim() || 'download'
  );
}
