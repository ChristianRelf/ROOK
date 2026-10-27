import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { MediaConfig } from '@rook/config';
import { detectImageType, isAllowedContentType } from './detect.js';
import { createImageProcessor, UnprocessableImageError } from './processor.js';
import { sanitiseFilename } from './storage.js';

const config: MediaConfig = {
  maxUploadBytes: 10 * 1024 * 1024,
  maxImagePixels: 50_000_000,
  maxImageDimension: 10_000,
  allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  uploadUrlTtlSeconds: 300,
  downloadUrlTtlSeconds: 900,
  orphanCleanupAfterSeconds: 3600,
};

/** Builds a real encoded image, so the tests exercise actual decode paths. */
async function makeImage(
  format: 'png' | 'jpeg' | 'webp' | 'gif',
  width = 64,
  height = 48,
): Promise<Buffer> {
  const base = sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } },
  });

  switch (format) {
    case 'png':
      return base.png().toBuffer();
    case 'jpeg':
      return base.jpeg().toBuffer();
    case 'webp':
      return base.webp().toBuffer();
    case 'gif':
      return base.gif().toBuffer();
  }
}

describe('detectImageType', () => {
  it('identifies each supported format from its magic bytes', async () => {
    expect(detectImageType(await makeImage('png'))).toBe('image/png');
    expect(detectImageType(await makeImage('jpeg'))).toBe('image/jpeg');
    expect(detectImageType(await makeImage('webp'))).toBe('image/webp');
    expect(detectImageType(await makeImage('gif'))).toBe('image/gif');
  });

  it('returns undefined for things that are not supported images', () => {
    for (const payload of [
      Buffer.from('<!DOCTYPE html><script>alert(1)</script>', 'utf8'),
      Buffer.from('%PDF-1.7\n', 'utf8'),
      Buffer.from('MZ\x90\x00', 'binary'),
      Buffer.from([0x50, 0x4b, 0x03, 0x04]), // zip
      Buffer.alloc(0),
      Buffer.from([0x00]),
    ]) {
      expect(detectImageType(payload)).toBeUndefined();
    }
  });

  it('does not accept a bare RIFF header as WebP', () => {
    // RIFF is shared with WAV and AVI, so the WEBP marker at offset 8 must
    // also be present.
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from('WAVE', 'ascii'),
    ]);
    expect(detectImageType(wav)).toBeUndefined();
  });

  it('ignores a misleading extension or declared type entirely', () => {
    // An HTML file named avatar.png is the stored-XSS case this guards.
    const html = Buffer.from('<html><body>not an image</body></html>', 'utf8');
    expect(detectImageType(html)).toBeUndefined();
    expect(isAllowedContentType(detectImageType(html), config.allowedMimeTypes)).toBe(false);
  });
});

describe('isAllowedContentType', () => {
  it('rejects a real image whose format this deployment does not accept', () => {
    // Detection and policy are separate concerns.
    expect(isAllowedContentType('image/gif', ['image/png', 'image/jpeg'])).toBe(false);
    expect(isAllowedContentType('image/png', ['image/png', 'image/jpeg'])).toBe(true);
    expect(isAllowedContentType(undefined, ['image/png'])).toBe(false);
  });
});

describe('image processor', () => {
  const processor = createImageProcessor(config);

  it('produces a thumbnail and a preview from a PNG', async () => {
    const result = await processor.process(await makeImage('png', 800, 600));

    expect(result.contentType).toBe('image/png');
    expect(result.width).toBe(800);
    expect(result.height).toBe(600);

    const names = result.variants.map((v) => v.name);
    expect(names).toEqual(['thumbnail', 'preview']);

    const thumbnail = result.variants.find((v) => v.name === 'thumbnail');
    expect(thumbnail?.contentType).toBe('image/webp');
    // Fitted inside a 256px box, preserving aspect ratio.
    expect(thumbnail?.width).toBe(256);
    expect(thumbnail?.height).toBe(192);
    expect(thumbnail?.byteSize).toBeGreaterThan(0);
  });

  it('standardises every variant to WebP regardless of input format', async () => {
    for (const format of ['png', 'jpeg', 'webp', 'gif'] as const) {
      const result = await processor.process(await makeImage(format, 400, 400));
      for (const variant of result.variants) {
        expect(variant.contentType).toBe('image/webp');
      }
    }
  });

  it('never enlarges an image past its original size', async () => {
    // A 64px avatar must not become a blurry 256px one.
    const result = await processor.process(await makeImage('png', 64, 64));
    const thumbnail = result.variants.find((v) => v.name === 'thumbnail');

    expect(thumbnail?.width).toBe(64);
    expect(thumbnail?.height).toBe(64);
  });

  it('strips EXIF metadata, including GPS coordinates', async () => {
    // The privacy case: phone photos routinely carry location.
    const withExif = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .withExif({ IFD0: { Copyright: 'rook-test', Artist: 'somebody' } })
      .jpeg()
      .toBuffer();

    // Confirm the fixture really does carry metadata, or the assertion below
    // would pass for the wrong reason.
    const sourceMetadata = await sharp(withExif).metadata();
    expect(sourceMetadata.exif).toBeDefined();

    const result = await processor.process(withExif);
    const thumbnail = result.variants.find((v) => v.name === 'thumbnail');
    const outputMetadata = await sharp(thumbnail!.body).metadata();

    expect(outputMetadata.exif).toBeUndefined();
  });

  it('rejects a file that is not an image', async () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>', 'utf8');

    await expect(processor.process(html)).rejects.toThrow(UnprocessableImageError);
    await expect(processor.process(html)).rejects.toThrow(/not a supported image format/);
  });

  it('rejects an empty file', async () => {
    await expect(processor.process(Buffer.alloc(0))).rejects.toThrow(/empty/);
  });

  it('rejects a file over the configured byte limit', async () => {
    const tiny = createImageProcessor({ ...config, maxUploadBytes: 100 });
    await expect(tiny.process(await makeImage('png', 400, 400))).rejects.toThrow(/byte limit/);
  });

  it('rejects an image exceeding the dimension limit before decoding it', async () => {
    // The decompression-bomb guard. A small file can declare enormous
    // dimensions, so this is checked from the header.
    const narrow = createImageProcessor({ ...config, maxImageDimension: 100 });

    await expect(narrow.process(await makeImage('png', 500, 50))).rejects.toThrow(
      /larger than 100px/,
    );
  });

  it('rejects an image exceeding the pixel-count limit', async () => {
    // Catches a shape that passes the per-side check but is still huge
    // overall, e.g. 9000x9000 under a 10000px side limit.
    const limited = createImageProcessor({ ...config, maxImagePixels: 10_000 });

    await expect(limited.process(await makeImage('png', 200, 200))).rejects.toThrow(
      /too many pixels/,
    );
  });

  it('reports a rejection as permanent rather than retryable', async () => {
    // UnprocessableImageError is the signal the worker uses to fail the asset
    // instead of retrying bytes that will never become valid.
    const error = await processor
      .process(Buffer.from('nope', 'utf8'))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnprocessableImageError);
  });
});

describe('sanitiseFilename', () => {
  it('strips path separators so a name cannot traverse directories', () => {
    expect(sanitiseFilename('../../etc/passwd')).toBe('.._.._etc_passwd'.replace(/^\.+/u, ''));
    expect(sanitiseFilename('a/b/c.png')).toBe('a_b_c.png');
    expect(sanitiseFilename('C:\\windows\\system32')).toBe('C:_windows_system32');
  });

  it('strips quotes and control characters that would break the header', () => {
    expect(sanitiseFilename('evil".png')).toBe('evil.png');
    expect(sanitiseFilename('bad\r\nname.png')).toBe('badname.png');
  });

  it('falls back to a safe default when nothing usable remains', () => {
    expect(sanitiseFilename('...')).toBe('download');
    expect(sanitiseFilename('"')).toBe('download');
  });

  it('bounds the length', () => {
    expect(sanitiseFilename('a'.repeat(500)).length).toBeLessThanOrEqual(200);
  });
});
