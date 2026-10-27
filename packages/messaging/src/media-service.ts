import type { MediaAsset, MediaAssetId, MediaVariantName, UserId } from '@rook/contracts';
import type { MediaConfig } from '@rook/config';
import { createRepositories, storageKeyFor, type DatabaseClient } from '@rook/database';
import type { ObjectStoragePort } from '@rook/media';
import type { EventPublisher } from './events.js';

/**
 * Media upload authorisation and confirmation.
 *
 * The API never touches file bytes. This service authorises an upload, hands
 * back a presigned URL, and later verifies what the client actually stored.
 * Decoding and re-encoding happen in the worker, so a large upload cannot tie
 * up a request handler or put the file in the API's heap.
 *
 * Confirmation is the security-critical step. At that point the client claims
 * "I uploaded it", and we check against storage rather than taking its word:
 *
 *   * the object exists at the key we authorised;
 *   * its real size is within the configured limit;
 *   * its leading bytes identify an allowed image format.
 *
 * Only then does the asset move to `uploaded` and a processing job get queued.
 */

export type AuthorizeUploadResult =
  | {
      readonly ok: true;
      readonly assetId: MediaAssetId;
      readonly uploadUrl: string;
      readonly requiredHeaders: Record<string, string>;
      readonly expiresAt: string;
      readonly maxByteSize: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'upload_too_large' | 'unsupported_media_type';
    };

export type ConfirmUploadResult =
  | { readonly ok: true; readonly asset: MediaAsset; readonly queued: boolean }
  | {
      readonly ok: false;
      readonly reason:
        'not_found' | 'object_missing' | 'upload_too_large' | 'unsupported_media_type';
    };

export interface MediaService {
  authorizeUpload: (options: {
    ownerId: UserId;
    declaredContentType: string;
    declaredByteSize: number;
    filename: string | undefined;
  }) => Promise<AuthorizeUploadResult>;

  confirmUpload: (options: {
    assetId: MediaAssetId;
    ownerId: UserId;
  }) => Promise<ConfirmUploadResult>;

  /**
   * An asset the viewer owns, with fresh presigned download URLs.
   *
   * Returns the asset for *any* status, with URLs only when it is `ready`.
   * A `failed` asset has to be visible to its owner -- otherwise the
   * `failureReason` the worker recorded can never be shown, and a failed
   * upload is indistinguishable from one still in progress.
   */
  getWithUrls: (options: { assetId: MediaAssetId; viewerId: UserId }) => Promise<
    | {
        readonly ok: true;
        readonly asset: MediaAsset;
        readonly urls: Partial<Record<MediaVariantName, string>>;
        readonly urlsExpireAt: string | null;
      }
    | { readonly ok: false; readonly reason: 'not_found' }
  >;
}

/** How many leading bytes to read when verifying the format. */
const SIGNATURE_READ_BYTES = 32;

export function createMediaService(options: {
  readonly db: DatabaseClient;
  readonly storage: ObjectStoragePort;
  readonly config: MediaConfig;
  readonly events: EventPublisher;
  /** Enqueues processing. Separate so the service does not depend on BullMQ. */
  readonly enqueueProcessing: (assetId: MediaAssetId) => Promise<void>;
  /** Injected so the detector stays in @rook/media. */
  readonly detectContentType: (bytes: Buffer) => string | undefined;
}): MediaService {
  const { db, storage, config, enqueueProcessing, detectContentType } = options;

  return {
    async authorizeUpload({ ownerId, declaredContentType, declaredByteSize, filename }) {
      // Cheap checks first, before anything is written or signed. The declared
      // values are not trusted â€" they are just enough to refuse the obviously
      // invalid without a round trip to storage.
      if (declaredByteSize > config.maxUploadBytes) {
        return { ok: false, reason: 'upload_too_large' };
      }
      if (!config.allowedMimeTypes.includes(declaredContentType)) {
        return { ok: false, reason: 'unsupported_media_type' };
      }

      const reserved = await createRepositories(db).media.reserve({
        ownerId,
        declaredContentType,
        declaredByteSize,
        filename,
      });

      const upload = await storage.presignUpload({
        key: reserved.storageKey,
        contentType: declaredContentType,
        contentLength: declaredByteSize,
        expiresInSeconds: config.uploadUrlTtlSeconds,
      });

      return {
        ok: true,
        assetId: reserved.id,
        uploadUrl: upload.url,
        requiredHeaders: upload.requiredHeaders,
        expiresAt: upload.expiresAt.toISOString(),
        maxByteSize: config.maxUploadBytes,
      };
    },

    async confirmUpload({ assetId, ownerId }) {
      const repos = createRepositories(db);

      // Scoped to the owner, so one user cannot confirm another's reservation.
      const asset = await repos.media.findOwnedById(assetId, ownerId);
      if (asset === undefined) {
        return { ok: false, reason: 'not_found' };
      }

      // Already confirmed: return current state rather than erroring, so a
      // client retrying a confirm after a dropped response succeeds.
      if (asset.status !== 'reserved') {
        return { ok: true, asset, queued: false };
      }

      const storageKey = storageKeyFor(assetId);

      const head = await storage.head(storageKey);
      if (head === undefined) {
        // The client said it uploaded but nothing is there. Left as
        // `reserved` so the orphan sweeper cleans it up.
        return { ok: false, reason: 'object_missing' };
      }

      // The real size, from storage. This is what makes understating
      // `declaredByteSize` pointless.
      if (head.byteSize > config.maxUploadBytes) {
        await repos.media.markFailed(assetId, 'file is larger than the upload limit');
        await storage.delete(storageKey);
        return { ok: false, reason: 'upload_too_large' };
      }

      // Format from the actual leading bytes, never from the client's claim
      // or from the Content-Type it set on the PUT.
      // A range request for just the header: the object may legitimately be
      // megabytes, and we only need its first few bytes to identify it.
      const signature = await storage.readPrefix(storageKey, SIGNATURE_READ_BYTES);
      const detected = detectContentType(signature);

      if (detected === undefined || !config.allowedMimeTypes.includes(detected)) {
        await repos.media.markFailed(assetId, 'file is not a supported image format');
        await storage.delete(storageKey);
        return { ok: false, reason: 'unsupported_media_type' };
      }

      const moved = await repos.media.markUploaded({
        id: assetId,
        contentType: detected,
        byteSize: head.byteSize,
      });

      if (!moved) {
        // Another confirm won the race. Its job is already queued.
        const current = await repos.media.findOwnedById(assetId, ownerId);
        return current === undefined
          ? { ok: false, reason: 'not_found' }
          : { ok: true, asset: current, queued: false };
      }

      // Enqueued after the status change commits, so the worker cannot pick
      // the job up before the row says `uploaded`. If this throws, the asset
      // stays `uploaded` and the recovery sweeper re-queues it â€" which is why
      // the worker also scans for pending assets on startup.
      await enqueueProcessing(assetId);

      const updated = await repos.media.findOwnedById(assetId, ownerId);
      if (updated === undefined) {
        return { ok: false, reason: 'not_found' };
      }

      return { ok: true, asset: updated, queued: true };
    },

    async getWithUrls({ assetId, viewerId }) {
      // Owner-scoped for this release. Attachments are resolved through the
      // message that carries them, which is itself membership-checked; a
      // shared-asset permission model is documented as future work.
      const asset = await createRepositories(db).media.findOwnedById(assetId, viewerId);
      if (asset === undefined) {
        return { ok: false, reason: 'not_found' };
      }

      // Reserved, uploaded or failed: hand back the asset so the client can
      // render its state, but issue no URLs -- there is nothing to serve yet.
      if (asset.status !== 'ready') {
        return { ok: true, asset, urls: {}, urlsExpireAt: null };
      }

      const urls: Partial<Record<MediaVariantName, string>> = {};
      let expiresAt = new Date();

      for (const variant of asset.variants) {
        const signed = await storage.presignDownload({
          key: storageKeyFor(assetId, variant.name),
          expiresInSeconds: config.downloadUrlTtlSeconds,
        });
        urls[variant.name] = signed.url;
        expiresAt = signed.expiresAt;
      }

      return { ok: true, asset, urls, urlsExpireAt: expiresAt.toISOString() };
    },
  };
}
