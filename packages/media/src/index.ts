/**
 * `@rook/media` — object storage access, content verification and image
 * processing.
 *
 * Both the API and the media worker depend on this package, but on different
 * parts of it: the API presigns and verifies, the worker decodes and
 * re-encodes. Sharp is only reached through `ImageProcessorPort`, so the API
 * process never loads the native image library.
 */

export {
  createS3Storage,
  sanitiseFilename,
  ObjectTooLargeError,
  type ObjectStoragePort,
  type ObjectMetadata,
  type PresignedUpload,
} from './storage.js';

export {
  detectImageType,
  isAllowedContentType,
  SIGNATURE_BYTES,
  type DetectedImageType,
} from './detect.js';

export {
  createImageProcessor,
  variantSpecs,
  UnprocessableImageError,
  type ImageProcessorPort,
  type ProcessedImage,
  type ProcessedVariant,
  type VariantSpec,
} from './processor.js';
