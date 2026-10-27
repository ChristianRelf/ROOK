import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { channelIdSchema, markReadRequestSchema, muteChannelRequestSchema } from '@rook/contracts';
import type { AppContext } from '../context.js';
import { problems } from '../http-error.js';
import { createRequireAuth, identityOf } from '../plugins/core.js';
import { parseBody, parseParams } from '../validate.js';

const channelParamsSchema = z.object({ channelId: channelIdSchema });

/**
 * Read state: `/v1/unread` and `/v1/channels/:channelId/read`.
 *
 * Read state is per-user and private, so none of this is published as an
 * event: nobody else is waiting to hear where you have read up to. A client
 * with several windows open reconciles through the summary on reconnect, which
 * is cheap because the summary is one query.
 *
 * `markRead` is called often — once per channel the user looks at — so it is
 * deliberately a single upsert and a single read-back, with no transaction. A
 * lost write here costs one stale badge until the next summary, which is the
 * right trade for something on the path of every click in the sidebar.
 */
export function registerReadStateRoutes(app: FastifyInstance, context: AppContext): void {
  const requireAuth = createRequireAuth(context);

  app.get('/v1/unread', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = identityOf(request);
    const summary = await context.readState.summary(user.id);
    return reply.send(summary);
  });

  app.post('/v1/channels/:channelId/read', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = identityOf(request);
    const { channelId } = parseParams(channelParamsSchema, request.params);
    const body = parseBody(markReadRequestSchema, request.body);

    const result = await context.readState.markRead({
      userId: user.id,
      channelId,
      lastReadMessageId: body.lastReadMessageId,
    });

    if (!result.ok) throw problems.channelNotFound();

    return reply.send({ unread: result.unread });
  });

  app.post('/v1/channels/:channelId/mute', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = identityOf(request);
    const { channelId } = parseParams(channelParamsSchema, request.params);
    const body = parseBody(muteChannelRequestSchema, request.body);

    const result = await context.readState.setMuted({
      userId: user.id,
      channelId,
      muted: body.muted,
    });

    if (!result.ok) throw problems.channelNotFound();

    return reply.send({ unread: result.unread });
  });
}
