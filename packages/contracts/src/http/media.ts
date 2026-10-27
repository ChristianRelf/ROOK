import { z } from 'zod';
import { mediaAssetIdSchema } from '../ids.js';
import {
  mediaAssetSchema,
  mediaAssetWithUrlsSchema,
  mediaContentTypeSchema,
} from '../entities/media.js';
import { isoTimestampSchema } from '../primitives.js';

/**
 * Request and response contracts for `/v1/media/*`.
 *
 * The upload flow is three calls, and the shape exists to keep file bytes off
 * the API entirely:
 *
 *   1. POST /v1/media/uploads    authorise, reserve an id, get a signed PUT
 *   2. PUT  <uploadUrl>          client uploads straight to object storage
 *   3. POST /v1/media/uploads/:id/confirm   verify the object, queue processing
 *
 * Proxying bytes through Node would make the API the bottleneck and its memory
 * the limit on file size. The signed-URL hop means the API only ever handles
 * metadata.
 */

export const createUploadRequestSchema = z.object({
  /**
   * The client's claim about the file type, used only to reject obvious
   * mismatches early and to set the signed URL's content-type condition.
   *
   * It is never trusted as the asset's real type: after upload the worker
   * reads the actual magic bytes, and a file whose content disagrees with
   * this is failed.
   */
  declaredContentType: mediaContentTypeSchema,
  /**
   * Declared size, checked against the configured maximum before a URL is
   * issued. The real size is verified from storage at confirm time, so a
   * client that understates it gains nothing.
   */
  declaredByteSize: z.number().int().positive(),
  /**
   * Original filename, kept only for display.
   *
   * Never used to build a storage key or a filesystem path: that is how a
   * name like `../../etc/passwd` turns into a traversal bug. Storage keys are
   * derived from the asset id alone.
   */
  filename: z.string().trim().min(1).max(255).optional(),
});

export type CreateUploadRequest = z.infer<typeof createUploadRequestSchema>;

export const createUploadResponseSchema = z.object({
  assetId: mediaAssetIdSchema,
  /**
   * Short-lived presigned PUT URL. Treated as a credential: never logged,
   * never persisted.
   */
  uploadUrl: z.url(),
  /** Headers the client must send with the PUT for the signature to match. */
  requiredHeaders: z.record(z.string(), z.string()),
  expiresAt: isoTimestampSchema,
  maxByteSize: z.number().int().positive(),
});

export type CreateUploadResponse = z.infer<typeof createUploadResponseSchema>;

export const confirmUploadResponseSchema = z.object({
  asset: mediaAssetSchema,
});

export type ConfirmUploadResponse = z.infer<typeof confirmUploadResponseSchema>;

export const mediaAssetResponseSchema = z.object({
  asset: mediaAssetWithUrlsSchema,
});

export type MediaAssetResponse = z.infer<typeof mediaAssetResponseSchema>;
