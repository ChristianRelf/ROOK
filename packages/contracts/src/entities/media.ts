import { z } from 'zod';
import { mediaAssetIdSchema, userIdSchema } from '../ids.js';
import { isoTimestampSchema } from '../primitives.js';

/**
 * Media assets.
 *
 * An asset's lifecycle is explicit in its status, because the client has to
 * render each state differently and "no variants yet" is not the same thing as
 * "processing failed":
 *
 *   reserved   upload authorised, bytes not yet confirmed
 *   uploaded   object verified in storage, queued for processing
 *   ready      variants generated and recorded
 *   failed     processing failed permanently after exhausting retries
 *
 * Statuses only ever move forward. There is no path back from `ready`, which
 * is what lets the client cache a ready asset indefinitely.
 */

export const mediaStatusSchema = z.enum(['reserved', 'uploaded', 'ready', 'failed']);
export type MediaStatus = z.infer<typeof mediaStatusSchema>;

/** Content types the pipeline accepts. Verified from magic bytes, not headers. */
export const mediaContentTypeSchema = z.enum([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);
export type MediaContentType = z.infer<typeof mediaContentTypeSchema>;

/**
 * Named derivative sizes.
 *
 * A fixed set rather than arbitrary on-demand dimensions: it keeps the
 * processing cost per asset bounded and known, and means a caller cannot turn
 * the worker into a resize-anything service.
 */
export const mediaVariantNameSchema = z.enum(['thumbnail', 'preview', 'original']);
export type MediaVariantName = z.infer<typeof mediaVariantNameSchema>;

export const mediaVariantSchema = z.object({
  name: mediaVariantNameSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  byteSize: z.number().int().nonnegative(),
  contentType: z.string().min(1),
});

export type MediaVariant = z.infer<typeof mediaVariantSchema>;

export const mediaAssetSchema = z.object({
  id: mediaAssetIdSchema,
  ownerId: userIdSchema,
  status: mediaStatusSchema,
  /** Detected from content. Absent until the upload has been verified. */
  contentType: z.string().min(1).nullable(),
  byteSize: z.number().int().nonnegative().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  variants: z.array(mediaVariantSchema),
  /**
   * Safe-to-display reason when `status` is `failed`, e.g. "not a supported
   * image". Never carries internal detail such as a storage key or stack.
   */
  failureReason: z.string().max(256).nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});

export type MediaAsset = z.infer<typeof mediaAssetSchema>;

/**
 * An asset plus short-lived download URLs, as returned when a client asks to
 * view it. URLs are generated per request and expire, so they are never
 * cached in the database or logged.
 *
 * `urls` is empty for any status other than `ready`, and `urlsExpireAt` is
 * then null. The endpoint still returns the asset in that case -- that is how
 * a client learns an upload is `failed` and reads its `failureReason`, rather
 * than polling an error response and guessing.
 */
export const mediaAssetWithUrlsSchema = mediaAssetSchema.extend({
  urls: z.record(mediaVariantNameSchema, z.url()),
  urlsExpireAt: isoTimestampSchema.nullable(),
});

export type MediaAssetWithUrls = z.infer<typeof mediaAssetWithUrlsSchema>;
