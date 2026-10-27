/**
 * Content-type detection from the file's actual bytes.
 *
 * Neither the client-supplied MIME type nor the filename extension is ever
 * trusted. Both are attacker-controlled, and a `.png` extension on an HTML
 * file served back to a browser is a stored-XSS primitive. The only thing that
 * decides an asset's type here is its leading bytes.
 *
 * Signatures are checked by hand rather than with a library, because the
 * accepted set is four formats and the checks are a few bytes each. That keeps
 * the trust boundary small and auditable, and avoids pulling a dependency that
 * detects 200 formats we deliberately refuse.
 */

export type DetectedImageType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** Longest signature we inspect; enough for a RIFF/WEBP header. */
export const SIGNATURE_BYTES = 16;

function startsWith(buffer: Buffer, bytes: readonly number[], offset = 0): boolean {
  if (buffer.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => buffer[offset + index] === byte);
}

/**
 * Identifies an image from its magic bytes, or returns undefined.
 *
 * Undefined means "not one of the four formats we accept" — including the case
 * where it is a valid image of some other format. Anything unrecognised is
 * rejected rather than passed to the decoder.
 */
export function detectImageType(buffer: Buffer): DetectedImageType | undefined {
  // PNG: \x89 P N G \r \n \x1a \n
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }

  // JPEG: FF D8 FF. The fourth byte varies by encoder, so it is not checked.
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }

  // GIF: "GIF87a" or "GIF89a"
  if (
    startsWith(buffer, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(buffer, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return 'image/gif';
  }

  // WebP: "RIFF" .... "WEBP" — both halves must match, since RIFF alone is
  // also used by WAV and AVI.
  if (
    startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'image/webp';
  }

  return undefined;
}

/**
 * Checks a detected type against the configured allow-list.
 *
 * Both checks are needed: detection says what the bytes are, the allow-list
 * says what this deployment accepts. They are separate so a deployment can
 * narrow the set without changing the detector.
 */
export function isAllowedContentType(
  detected: string | undefined,
  allowed: readonly string[],
): detected is DetectedImageType {
  return detected !== undefined && allowed.includes(detected);
}
