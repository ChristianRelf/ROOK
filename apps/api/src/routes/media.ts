import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createUploadRequestSchema, mediaAssetIdSchema } from '@rook/contracts';
import type { AppContext } from '../context.js';
import { HttpProblem, problems } from '../http-error.js';
import { createRequireAuth, identityOf } from '../plugins/core.js';
import { parseBody, parseParams } from '../validate.js';

const assetParamsSchema = z.object({ assetId: mediaAssetIdSchema });

/**
 * `/v1/media/*`
 *
 * Three steps, and no file bytes ever reach this process:
 *
 *   POST /v1/media/uploads              authorise, reserve, return a signed PUT
 *   PUT  <uploadUrl>                    client uploads straight to storage
 *   POST /v1/media/uploads/:id/confirm  verify the object, queue processing
 *
 * The signed-URL hop is what keeps the API from becoming the bottleneck for
 * large files, and keeps its memory off the critical path.
 */
export function registerMediaRoutes(app: FastifyInstance, context: AppContext): void {
  const requireAuth = createRequireAuth(context);

  const uploadRateLimit = {
    rateLimit: {
      max: context.config.rateLimit.upload.max,
      timeWindow: context.config.rateLimit.upload.windowMs,
      keyGenerator: (request: { identity?: { user: { id: string } }; ip: string }) =>
        request.identity?.user.id ?? request.ip,
    },
  };

  app.post(
    '/v1/media/uploads',
    { preHandler: requireAuth, config: uploadRateLimit },
    async (request, reply) => {
      const { user } = identityOf(request);
      const body = parseBody(createUploadRequestSchema, request.body);

      const result = await context.media.authorizeUpload({
        ownerId: user.id,
        declaredContentType: body.declaredContentType,
        declaredByteSize: body.declaredByteSize,
        filename: body.filename,
      });

      if (!result.ok) {
        if (result.reason === 'upload_too_large') {
          throw new HttpProblem(
            'upload_too_large',
            `That file is larger than the ${Math.floor(
              context.config.media.maxUploadBytes / 1024 / 1024,
            )} MB limit.`,
          );
        }
        throw new HttpProblem(
          'unsupported_media_type',
          'That file type is not supported. Images only.',
        );
      }

      // The upload URL is returned to the client but never logged: it is a
      // bearer credential for the bucket. The logger redacts `uploadUrl`
      // by path as a second line of defence.
      return reply.status(201).send({
        assetId: result.assetId,
        uploadUrl: result.uploadUrl,
        requiredHeaders: result.requiredHeaders,
        expiresAt: result.expiresAt,
        maxByteSize: result.maxByteSize,
      });
    },
  );

  app.post(
    '/v1/media/uploads/:assetId/confirm',
    { preHandler: requireAuth, config: uploadRateLimit },
    async (request, reply) => {
      const { user } = identityOf(request);
      const { assetId } = parseParams(assetParamsSchema, request.params);

      const result = await context.media.confirmUpload({ assetId, ownerId: user.id });

      if (!result.ok) {
        switch (result.reason) {
          case 'not_found':
            throw problems.notFound('That upload');
          case 'object_missing':
            throw new HttpProblem(
              'conflict',
              'No file was found for that upload. Try uploading again.',
            );
          case 'upload_too_large':
            throw new HttpProblem('upload_too_large', 'That file is larger than the limit.');
          case 'unsupported_media_type':
            // Reached when the stored bytes disagree with what was declared —
            // the check that makes a renamed `.png` useless.
            throw new HttpProblem('unsupported_media_type', 'That file is not a supported image.');
        }
      }

      return reply.send({ asset: result.asset });
    },
  );

  app.get('/v1/media/:assetId', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = identityOf(request);
    const { assetId } = parseParams(assetParamsSchema, request.params);

    const result = await context.media.getWithUrls({ assetId, viewerId: user.id });

    if (!result.ok) {
      throw problems.notFound('That image');
    }

    // Returned for every status, not just `ready`. A client polling an upload
    // needs to see `failed` and its reason here; a 409 would leave it unable
    // to tell failure from "still working".
    //
    // URLs are generated per request and expire, so they are never cached in
    // the database. The client re-requests when they lapse.
    return reply.send({
      asset: { ...result.asset, urls: result.urls, urlsExpireAt: result.urlsExpireAt },
    });
  });
}
