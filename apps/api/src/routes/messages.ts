import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  channelIdSchema,
  editMessageRequestSchema,
  messageIdSchema,
  paginationQuerySchema,
  sendMessageRequestSchema,
} from '@rook/contracts';
import type { AppContext } from '../context.js';
import { HttpProblem, problems } from '../http-error.js';
import { createRequireAuth, identityOf } from '../plugins/core.js';
import { parseBody, parseParams, parseQuery } from '../validate.js';

const channelParamsSchema = z.object({ channelId: channelIdSchema });
const messageParamsSchema = z.object({ messageId: messageIdSchema });

/**
 * `/v1/channels/:channelId/messages` and `/v1/messages/:messageId`
 *
 * Sends go over HTTP rather than the WebSocket, deliberately. A send has to be
 * persisted, may fail validation, may be a retry of an earlier attempt, and
 * needs to report all of that precisely — which is what status codes and an
 * idempotency key give you. The socket is for delivery.
 *
 * The response to a send is the persisted message, so the client replaces its
 * optimistic copy with the authoritative row (real id, server timestamp)
 * rather than guessing.
 */
export function registerMessageRoutes(app: FastifyInstance, context: AppContext): void {
  const requireAuth = createRequireAuth(context);

  /**
   * Per-user rather than per-IP: several people behind one NAT must not
   * exhaust each other's allowance.
   */
  const sendRateLimit = {
    rateLimit: {
      max: context.config.rateLimit.message.max,
      timeWindow: context.config.rateLimit.message.windowMs,
      keyGenerator: (request: { identity?: { user: { id: string } }; ip: string }) =>
        request.identity?.user.id ?? request.ip,
    },
  };

  app.get(
    '/v1/channels/:channelId/messages',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { user } = identityOf(request);
      const { channelId } = parseParams(channelParamsSchema, request.params);
      const query = parseQuery(paginationQuerySchema, request.query);

      const result = await context.messages.history({
        channelId,
        viewerId: user.id,
        cursor: query.cursor,
        direction: query.direction,
        limit: query.limit,
      });

      if (!result.ok) {
        if (result.reason === 'invalid_cursor') {
          throw new HttpProblem('validation_failed', 'That pagination cursor is not valid.');
        }
        throw problems.channelNotFound();
      }

      return reply.send({
        messages: result.page.messages,
        nextCursor: result.page.nextCursor,
        hasMore: result.page.hasMore,
      });
    },
  );

  app.post(
    '/v1/channels/:channelId/messages',
    { preHandler: requireAuth, config: sendRateLimit },
    async (request, reply) => {
      const { user } = identityOf(request);
      const { channelId } = parseParams(channelParamsSchema, request.params);
      const body = parseBody(sendMessageRequestSchema, request.body);

      const result = await context.messages.send({
        channelId,
        authorId: user.id,
        content: body.content,
        attachmentIds: body.attachmentIds,
        idempotencyKey: body.idempotencyKey,
      });

      if (!result.ok) {
        switch (result.reason) {
          case 'channel_not_found':
          case 'not_a_member':
            throw problems.channelNotFound();
          case 'forbidden':
            throw problems.forbidden('You cannot post in that channel.');
          case 'attachment_not_found':
            throw problems.notFound('One of those attachments');
          case 'attachment_not_ready':
            throw new HttpProblem(
              'media_not_ready',
              'An attachment is still being processed. Try again in a moment.',
            );
        }
      }

      // 201 for a new message, 200 when an idempotency key matched an existing
      // one. Both return the same body, so a client that ignores the
      // distinction still behaves correctly — but one that honours it can tell
      // a successful retry from a fresh send.
      return reply.status(result.created ? 201 : 200).send({ message: result.message });
    },
  );

  app.patch('/v1/messages/:messageId', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = identityOf(request);
    const { messageId } = parseParams(messageParamsSchema, request.params);
    const body = parseBody(editMessageRequestSchema, request.body);

    const result = await context.messages.edit({
      messageId,
      viewerId: user.id,
      content: body.content,
    });

    if (!result.ok) {
      if (result.reason === 'forbidden') {
        throw problems.forbidden('You can only edit your own messages.');
      }
      throw problems.messageNotFound();
    }

    return reply.send({ message: result.message });
  });

  app.delete('/v1/messages/:messageId', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = identityOf(request);
    const { messageId } = parseParams(messageParamsSchema, request.params);

    const result = await context.messages.remove({ messageId, viewerId: user.id });

    if (!result.ok) {
      if (result.reason === 'forbidden') {
        throw problems.forbidden('You cannot delete that message.');
      }
      throw problems.messageNotFound();
    }

    return reply.send({ messageId: result.messageId, deletedAt: result.deletedAt });
  });
}
