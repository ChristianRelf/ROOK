import sharp from 'sharp';
import type { MediaConfig } from '@rook/config';
import type { MediaVariantName } from '@rook/contracts';
import { detectImageType, isAllowedContentType, type DetectedImageType } from './detect.js';

/**
 * Image processing with Sharp.
 *
 * Sharp (libvips) rather than ImageMagick or a Rust service: it is the
 * maintained default for Node, it streams rather than buffering whole
 * decompressed frames, and it exposes the header-level limits this code needs.
 * The spec asks for one processing stack, so there is no Rust equivalent to
 * keep in sync.
 *
 * What this module defends against, in order of how likely it is to matter:
 *
 *   1. **Decompression bombs.** A 20 KB PNG can declare 50,000 x 50,000
 *      pixels and expand to tens of gigabytes when decoded. Dimensions are
 *      read from the header and rejected *before* any pixel is decoded.
 *
 *   2. **Type confusion.** The type is taken from the magic bytes, never from
 *      the client. A declared `image/png` that is actually something else
 *      fails here.
 *
 *   3. **Metadata leakage.** EXIF on a phone photo routinely carries GPS
 *      coordinates. Every variant is re-encoded from raw pixels, which drops
 *      all metadata rather than trying to scrub fields selectively.
 *
 *   4. **Malformed input reaching the decoder.** Sharp runs with a pixel
 *      ceiling so a crafted file cannot allocate without bound even if it
 *      passes the header checks.
 */

export interface VariantSpec {
  readonly name: MediaVariantName;
  /** Longest-edge bound. The image is never enlarged past its original size. */
  readonly maxEdge: number;
  readonly quality: number;
}

/**
 * The fixed variant set.
 *
 * Deliberately not caller-specified: a closed set keeps per-asset cost known
 * and stops the worker from becoming a resize-anything service.
 */
export const variantSpecs: readonly VariantSpec[] = [
  // Message list and avatars. Small enough to load many at once.
  { name: 'thumbnail', maxEdge: 256, quality: 72 },
  // Inline display when a message is expanded.
  { name: 'preview', maxEdge: 1280, quality: 82 },
];

export interface ProcessedVariant {
  readonly name: MediaVariantName;
  readonly body: Buffer;
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
}

export interface ProcessedImage {
  readonly contentType: DetectedImageType;
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly variants: readonly ProcessedVariant[];
}

/**
 * A rejection the user should see, as opposed to an internal fault.
 *
 * The distinction drives retry behaviour: this is permanent and must not be
 * retried, because the bytes will never become valid. An infrastructure error
 * is a different class and should be retried.
 */
export class UnprocessableImageError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UnprocessableImageError';
  }
}

export interface ImageProcessorPort {
  process: (bytes: Buffer) => Promise<ProcessedImage>;
}

export function createImageProcessor(config: MediaConfig): ImageProcessorPort {
  return {
    async process(bytes) {
      if (bytes.byteLength === 0) {
        throw new UnprocessableImageError('file is empty');
      }
      if (bytes.byteLength > config.maxUploadBytes) {
        throw new UnprocessableImageError(
          `file is larger than the ${config.maxUploadBytes} byte limit`,
        );
      }

      // 1. Type from content, not from anything the client said.
      const detected = detectImageType(bytes);
      if (!isAllowedContentType(detected, config.allowedMimeTypes)) {
        throw new UnprocessableImageError('file is not a supported image format');
      }

      // 2. Header-only metadata read. Cheap, and happens before any decode.
      const { width, height } = await readDimensions(bytes);

      if (width === undefined || height === undefined || width < 1 || height < 1) {
        throw new UnprocessableImageError('image has no usable dimensions');
      }

      // 3. Decompression-bomb guards, enforced from the header.
      if (width > config.maxImageDimension || height > config.maxImageDimension) {
        throw new UnprocessableImageError(
          `image is larger than ${config.maxImageDimension}px on one side (${width}x${height})`,
        );
      }
      if (width * height > config.maxImagePixels) {
        throw new UnprocessableImageError(
          `image has too many pixels (${width * height}, limit ${config.maxImagePixels})`,
        );
      }

      // 4. Produce variants, each re-encoded from decoded pixels so no source
      //    metadata survives.
      const variants: ProcessedVariant[] = [];

      for (const spec of variantSpecs) {
        const variant = await renderVariant(bytes, spec, {
          sourceWidth: width,
          sourceHeight: height,
          maxImagePixels: config.maxImagePixels,
        });
        variants.push(variant);
      }

      return {
        contentType: detected,
        width,
        height,
        byteSize: bytes.byteLength,
        variants,
      };
    },
  };
}

/**
 * Reads the image header for its dimensions.
 *
 * `limitInputPixels: false` is deliberate and is *not* a weakened guard.
 * `metadata()` parses only the header and allocates no pixel buffer, so it is
 * safe on untrusted input. Leaving Sharp's limit enabled here would make it
 * reject an oversized image during this call, surfacing as the generic
 * "Input image exceeds pixel limit" instead of our specific message naming
 * the actual dimensions â€" which is the difference between a user understanding
 * why their photo was refused and not.
 *
 * The real enforcement is unchanged and happens twice afterwards: the explicit
 * dimension and pixel-count checks in `process`, and `limitInputPixels` on the
 * decode in `renderVariant`, which is the call that would actually allocate.
 */
async function readDimensions(
  bytes: Buffer,
): Promise<{ width: number | undefined; height: number | undefined }> {
  try {
    const metadata = await sharp(bytes, { limitInputPixels: false }).metadata();
    return { width: metadata.width, height: metadata.height };
  } catch (error) {
    throw new UnprocessableImageError(
      `image could not be read: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

async function renderVariant(
  bytes: Buffer,
  spec: VariantSpec,
  source: { sourceWidth: number; sourceHeight: number; maxImagePixels: number },
): Promise<ProcessedVariant> {
  // WebP for every variant: it is well supported, and standardising the
  // output format means the client never has to branch on the input type.
  // Animation is deliberately not preserved â€" an animated GIF becomes a still
  // thumbnail, which is a documented limitation rather than an oversight.
  const pipeline = sharp(bytes, {
    limitInputPixels: source.maxImagePixels,
    // Reading a single frame keeps memory bounded for animated input.
    pages: 1,
  })
    // Honours the EXIF orientation flag before that metadata is discarded,
    // so a portrait phone photo is not rendered sideways.
    .rotate()
    .resize({
      width: spec.maxEdge,
      height: spec.maxEdge,
      fit: 'inside',
      // Never upscale: a 64px avatar should stay 64px rather than become a
      // blurry 256px one.
      withoutEnlargement: true,
    })
    .webp({ quality: spec.quality, effort: 4 });

  // By this point the format has been identified and the size guards have
  // passed, so any failure here is the *bytes* being unusable -- a truncated
  // file, a corrupt chunk, a mislabelled frame. That is permanent: retrying
  // cannot turn bad bytes into good ones, and classifying it as transient
  // would mean five retries with backoff before giving up on every corrupt
  // upload.
  // Inferred rather than annotated: sharp's output type is only reachable
  // through its namespace, which a default import does not expose.
  const { data, info } = await pipeline
    .toBuffer({ resolveWithObject: true })
    .catch((error: unknown) => {
      throw new UnprocessableImageError(
        `image could not be decoded: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    });

  return {
    name: spec.name,
    body: data,
    contentType: 'image/webp',
    width: info.width,
    height: info.height,
    byteSize: data.byteLength,
  };
}
