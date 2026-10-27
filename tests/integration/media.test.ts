import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { createEventPublisher, createMediaService } from '@rook/messaging';
import {
  createImageProcessor,
  createS3Storage,
  detectImageType,
  type ObjectStoragePort,
} from '@rook/media';
import { storageKeyFor } from '@rook/database';
import { createLogger } from '@rook/observability';
import type { MediaAssetId } from '@rook/contracts';
import { createHarness, createTestUser, type TestHarness, type TestUser } from './setup/harness.js';

/**
 * Integration tests for the media pipeline against real object storage.
 *
 * What only a real backend can verify: that a presigned URL actually accepts
 * an upload, that the signature is enforced, that a range request returns the
 * header bytes, and that an unsigned request is refused. Those are properties
 * of the storage implementation, not of our code, and they have broken before
 * (the AWS SDK's default checksum header silently invalidates presigned PUTs).
 */

let harness: TestHarness;
let user: TestUser;
let storage: ObjectStoragePort;
let service: ReturnType<typeof createMediaService>;
let queued: string[];

beforeAll(async () => {
  harness = createHarness();
  user = await createTestUser(harness);

  const logger = createLogger({
    service: 'test',
    runtime: { ...harness.config.runtime, logLevel: 'fatal', logPretty: false },
  });

  storage = createS3Storage({ config: harness.config.storage, logger });
  queued = [];

  service = createMediaService({
    db: harness.db,
    storage,
    config: harness.config.media,
    events: createEventPublisher(harness.repositories.outbox),
    // Recorded rather than enqueued: the worker is not under test here, and
    // the assertion is that confirmation queues exactly once.
    enqueueProcessing: (assetId) => {
      queued.push(assetId);
      return Promise.resolve();
    },
    detectContentType: detectImageType,
  });
});

afterAll(async () => {
  await harness.close();
});

async function makePng(width = 400, height = 300): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 90, b: 160 } },
  })
    .png()
    .toBuffer();
}

/** Uploads bytes to a presigned URL exactly as a client would. */
async function uploadViaPresignedUrl(
  url: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<number> {
  const response = await fetch(url, {
    method: 'PUT',
    headers,
    body: new Uint8Array(body),
  });
  return response.status;
}

describe('upload authorisation', () => {
  it('issues a working presigned URL and verifies the stored object', async () => {
    const png = await makePng();

    const authorised = await service.authorizeUpload({
      ownerId: user.user.id,
      declaredContentType: 'image/png',
      declaredByteSize: png.byteLength,
      filename: 'photo.png',
    });

    expect(authorised.ok).toBe(true);
    if (!authorised.ok) return;

    // A plain PUT with no credentials: the signature in the URL is the
    // credential. This is the step the SDK's checksum default used to break.
    const status = await uploadViaPresignedUrl(
      authorised.uploadUrl,
      authorised.requiredHeaders,
      png,
    );
    expect(status).toBe(200);

    const confirmed = await service.confirmUpload({
      assetId: authorised.assetId,
      ownerId: user.user.id,
    });

    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;

    expect(confirmed.asset.status).toBe('uploaded');
    // Detected from the bytes, and sized from storage rather than the client.
    expect(confirmed.asset.contentType).toBe('image/png');
    expect(confirmed.asset.byteSize).toBe(png.byteLength);
    expect(confirmed.queued).toBe(true);
    expect(queued).toContain(authorised.assetId);
  });

  it('refuses a file over the configured limit before signing anything', async () => {
    const result = await service.authorizeUpload({
      ownerId: user.user.id,
      declaredContentType: 'image/png',
      declaredByteSize: harness.config.media.maxUploadBytes + 1,
      filename: 'huge.png',
    });

    expect(!result.ok && result.reason).toBe('upload_too_large');
  });

  it('refuses a content type that is not allowed', async () => {
    const result = await service.authorizeUpload({
      ownerId: user.user.id,
      declaredContentType: 'application/pdf',
      declaredByteSize: 1024,
      filename: 'doc.pdf',
    });

    expect(!result.ok && result.reason).toBe('unsupported_media_type');
  });

  it('derives the storage key from the asset id, never the filename', async () => {
    // A traversal attempt in the filename must have no effect on the key.
    const authorised = await service.authorizeUpload({
      ownerId: user.user.id,
      declaredContentType: 'image/png',
      declaredByteSize: 1024,
      filename: '../../../etc/passwd',
    });

    expect(authorised.ok).toBe(true);
    if (!authorised.ok) return;

    const expected = storageKeyFor(authorised.assetId);
    expect(expected).toContain(authorised.assetId);
    expect(expected).not.toContain('..');
    expect(expected).not.toContain('passwd');
    // And the signed URL points at that derived key.
    expect(new URL(authorised.uploadUrl).pathname).toContain(authorised.assetId);
  });
});

describe('confirmation', () => {
  it('rejects a confirm when nothing was uploaded', async () => {
    const authorised = await service.authorizeUpload({
      ownerId: user.user.id,
      declaredContentType: 'image/png',
      declaredByteSize: 1024,
      filename: 'never-uploaded.png',
    });
    if (!authorised.ok) throw new Error('authorise failed');

    const result = await service.confirmUpload({
      assetId: authorised.assetId,
      ownerId: user.user.id,
    });

    expect(!result.ok && result.reason).toBe('object_missing');
  });

  it('rejects content that disagrees with the declared type', async () => {
    // The case an extension or MIME check misses entirely: an HTML file
    // uploaded under image/png.
    const html = Buffer.from('<html><script>alert(1)</script></html>', 'utf8');

    const authorised = await service.authorizeUpload({
      ownerId: user.user.id,
      declaredContentType: 'image/png',
      declaredByteSize: html.byteLength,
      filename: 'not-really.png',
    });
    if (!authorised.ok) throw new Error('authorise failed');

    await uploadViaPresignedUrl(authorised.uploadUrl, authorised.requiredHeaders, html);

    const result = await service.confirmUpload({
      assetId: authorised.assetId,
      ownerId: user.user.id,
    });

    expect(!result.ok && result.reason).toBe('unsupported_media_type');

    // And the rejected object is removed rather than left in the bucket.
    await expect(storage.head(storageKeyFor(authorised.assetId))).resolves.toBeUndefined();
  });

  it('will not let one user confirm an upload they do not own', async () => {
    const other = await createTestUser(harness);
    const png = await makePng(100, 100);

    const authorised = await service.authorizeUpload({
      ownerId: user.user.id,
      declaredContentType: 'image/png',
      declaredByteSize: png.byteLength,
      filename: 'mine.png',
    });
    if (!authorised.ok) throw new Error('authorise failed');

    await uploadViaPresignedUrl(authorised.uploadUrl, authorised.requiredHeaders, png);

    const result = await service.confirmUpload({
      assetId: authorised.assetId,
      ownerId: other.user.id,
    });

    expect(!result.ok && result.reason).toBe('not_found');
  });

  it('is idempotent: a repeated confirm queues no second job', async () => {
    const png = await makePng(120, 120);

    const authorised = await service.authorizeUpload({
      ownerId: user.user.id,
      declaredContentType: 'image/png',
      declaredByteSize: png.byteLength,
      filename: 'twice.png',
    });
    if (!authorised.ok) throw new Error('authorise failed');

    await uploadViaPresignedUrl(authorised.uploadUrl, authorised.requiredHeaders, png);

    const first = await service.confirmUpload({
      assetId: authorised.assetId,
      ownerId: user.user.id,
    });
    const second = await service.confirmUpload({
      assetId: authorised.assetId,
      ownerId: user.user.id,
    });

    expect(first.ok && first.queued).toBe(true);
    expect(second.ok).toBe(true);
    // The retried confirm must not duplicate the processing work.
    expect(second.ok && second.queued).toBe(false);

    const enqueuedForAsset = queued.filter((id) => id === authorised.assetId);
    expect(enqueuedForAsset).toHaveLength(1);
  });
});

describe('storage behaviour', () => {
  it('reads only the requested prefix via a range request', async () => {
    const png = await makePng(500, 500);

    const authorised = await service.authorizeUpload({
      ownerId: user.user.id,
      declaredContentType: 'image/png',
      declaredByteSize: png.byteLength,
      filename: 'range.png',
    });
    if (!authorised.ok) throw new Error('authorise failed');

    await uploadViaPresignedUrl(authorised.uploadUrl, authorised.requiredHeaders, png);

    const prefix = await storage.readPrefix(storageKeyFor(authorised.assetId), 32);

    // 32 bytes of a much larger object: the whole point of readPrefix, since
    // sniffing the header must not download megabytes.
    expect(prefix.byteLength).toBe(32);
    expect(png.byteLength).toBeGreaterThan(1000);
    expect(detectImageType(prefix)).toBe('image/png');
  });

  it('refuses an unsigned request, proving the bucket is private', async () => {
    const png = await makePng(80, 80);

    const authorised = await service.authorizeUpload({
      ownerId: user.user.id,
      declaredContentType: 'image/png',
      declaredByteSize: png.byteLength,
      filename: 'private.png',
    });
    if (!authorised.ok) throw new Error('authorise failed');

    await uploadViaPresignedUrl(authorised.uploadUrl, authorised.requiredHeaders, png);

    const key = storageKeyFor(authorised.assetId);
    const unsigned = await fetch(
      `${harness.config.storage.publicEndpoint}/${harness.config.storage.mediaBucket}/${key}`,
    );

    // Anything but 200: the object must not be readable without a signature.
    expect(unsigned.status).not.toBe(200);
  });

  it('issues a download URL that works and then expires', async () => {
    const png = await makePng(90, 90);

    const authorised = await service.authorizeUpload({
      ownerId: user.user.id,
      declaredContentType: 'image/png',
      declaredByteSize: png.byteLength,
      filename: 'download.png',
    });
    if (!authorised.ok) throw new Error('authorise failed');

    await uploadViaPresignedUrl(authorised.uploadUrl, authorised.requiredHeaders, png);
    const key = storageKeyFor(authorised.assetId);

    const signed = await storage.presignDownload({ key, expiresInSeconds: 300 });
    const ok = await fetch(signed.url);
    expect(ok.status).toBe(200);

    const shortLived = await storage.presignDownload({ key, expiresInSeconds: 1 });
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const expired = await fetch(shortLived.url);

    // An expired signature must be refused, or the TTL means nothing.
    expect(expired.status).not.toBe(200);
  });
});

describe('processing', () => {
  it('produces variants, strips metadata, and records them', async () => {
    const processor = createImageProcessor(harness.config.media);

    // A JPEG carrying EXIF, which is where phone photos keep GPS data.
    const withExif = await sharp({
      create: { width: 900, height: 600, channels: 3, background: { r: 5, g: 5, b: 5 } },
    })
      .withExif({ IFD0: { Copyright: 'integration-test' } })
      .jpeg()
      .toBuffer();

    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const processed = await processor.process(withExif);

    expect(processed.contentType).toBe('image/jpeg');
    expect(processed.width).toBe(900);
    expect(processed.variants.map((variant) => variant.name).sort()).toEqual([
      'preview',
      'thumbnail',
    ]);

    const thumbnail = processed.variants.find((variant) => variant.name === 'thumbnail');
    expect(thumbnail?.width).toBe(256);

    // Re-encoded from decoded pixels, so no source metadata survives.
    const outputMetadata = await sharp(thumbnail?.body as Buffer).metadata();
    expect(outputMetadata.exif).toBeUndefined();
    expect(outputMetadata.format).toBe('webp');
  });

  it('records a ready asset with its variants and issues URLs for them', async () => {
    const png = await makePng(600, 400);

    const authorised = await service.authorizeUpload({
      ownerId: user.user.id,
      declaredContentType: 'image/png',
      declaredByteSize: png.byteLength,
      filename: 'ready.png',
    });
    if (!authorised.ok) throw new Error('authorise failed');

    await uploadViaPresignedUrl(authorised.uploadUrl, authorised.requiredHeaders, png);
    await service.confirmUpload({ assetId: authorised.assetId, ownerId: user.user.id });

    // Stand in for the worker: process and record, as it would.
    const processor = createImageProcessor(harness.config.media);
    const processed = await processor.process(png);

    const variants = [];
    for (const variant of processed.variants) {
      const key = storageKeyFor(authorised.assetId, variant.name);
      await storage.put({ key, body: variant.body, contentType: variant.contentType });
      variants.push({
        name: variant.name,
        storageKey: key,
        contentType: variant.contentType,
        width: variant.width,
        height: variant.height,
        byteSize: variant.byteSize,
      });
    }

    await harness.repositories.media.markReady(authorised.assetId, {
      contentType: processed.contentType,
      byteSize: processed.byteSize,
      width: processed.width,
      height: processed.height,
      variants,
    });

    const result = await service.getWithUrls({
      assetId: authorised.assetId,
      viewerId: user.user.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.asset.status).toBe('ready');
    expect(result.asset.variants).toHaveLength(2);
    expect(result.urlsExpireAt).not.toBeNull();

    // The URLs must actually serve the variant bytes.
    const thumbnailUrl = result.urls.thumbnail;
    expect(thumbnailUrl).toBeDefined();

    const fetched = await fetch(thumbnailUrl as string);
    expect(fetched.status).toBe(200);
    const bytes = Buffer.from(await fetched.arrayBuffer());
    expect((await sharp(bytes).metadata()).format).toBe('webp');
  });

  it('shows a failed asset to its owner, with a reason and no URLs', async () => {
    // Otherwise `failureReason` is unreachable and a failed upload looks
    // identical to one still processing.
    const reserved = await harness.repositories.media.reserve({
      ownerId: user.user.id,
      declaredContentType: 'image/png',
      declaredByteSize: 1024,
      filename: 'broken.png',
    });

    await harness.repositories.media.markFailed(
      reserved.id,
      'file is not a supported image format',
    );

    const result = await service.getWithUrls({
      assetId: reserved.id,
      viewerId: user.user.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.asset.status).toBe('failed');
    expect(result.asset.failureReason).toBe('file is not a supported image format');
    expect(Object.keys(result.urls)).toHaveLength(0);
    expect(result.urlsExpireAt).toBeNull();
  });

  it('hides an asset from a user who does not own it', async () => {
    const other = await createTestUser(harness);
    const reserved = await harness.repositories.media.reserve({
      ownerId: user.user.id,
      declaredContentType: 'image/png',
      declaredByteSize: 1024,
      filename: 'private.png',
    });

    const result = await service.getWithUrls({
      assetId: reserved.id,
      viewerId: other.user.id,
    });

    expect(!result.ok && result.reason).toBe('not_found');
  });

  it('reports an unknown asset as not found', async () => {
    const result = await service.getWithUrls({
      assetId: crypto.randomUUID() as MediaAssetId,
      viewerId: user.user.id,
    });

    expect(!result.ok && result.reason).toBe('not_found');
  });
});
