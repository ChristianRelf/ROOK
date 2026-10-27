import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  communityIdSchema,
  createChannelRequestSchema,
  createCommunityRequestSchema,
  joinCommunityRequestSchema,
  memberListQuerySchema,
} from '@rook/contracts';
import type { AppContext } from '../context.js';
import { HttpProblem, problems } from '../http-error.js';
import { createRequireAuth, identityOf } from '../plugins/core.js';
import { parseBody, parseParams, parseQuery } from '../validate.js';

/** Route parameters, validated so a malformed id is a 400 and not a 500. */
const communityParamsSchema = z.object({ communityId: communityIdSchema });

/**
 * `/v1/communities/*`
 *
 * Every handler resolves membership server-side. A community id in a URL grants
 * nothing on its own — and when the caller is not a member the response is the
 * same "not found" a non-existent community gets, so the endpoint cannot be
 * used to enumerate which ids exist.
 */
export function registerCommunityRoutes(app: FastifyInstance, context: AppContext): void {
  const requireAuth = createRequireAuth(context);

  app.get('/v1/communities', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = identityOf(request);
    const communities = await context.communities.listForUser(user.id);
    return reply.send({ communities });
  });

  app.post('/v1/communities', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = identityOf(request);
    const body = parseBody(createCommunityRequestSchema, request.body);

    const result = await context.communities.create({ name: body.name, ownerId: user.id });
    return reply.status(201).send({ community: result.community });
  });

  app.post('/v1/communities/join', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = identityOf(request);
    const body = parseBody(joinCommunityRequestSchema, request.body);

    const result = await context.communities.join({ joinCode: body.joinCode, userId: user.id });

    if (!result.ok) {
      if (result.reason === 'already_a_member') {
        // Reported distinctly so the client can navigate to the community
        // rather than showing an error for something that is already true.
        throw new HttpProblem('already_a_member', 'You are already in that community.');
      }
      throw new HttpProblem('invalid_join_code', 'That join code is not valid.');
    }

    return reply.send({ community: result.community });
  });

  app.get('/v1/communities/:communityId', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = identityOf(request);
    const { communityId } = parseParams(communityParamsSchema, request.params);

    const community = await context.communities.get(communityId, user.id);
    if (community === undefined) {
      throw problems.communityNotFound();
    }

    return reply.send({ community });
  });

  app.get(
    '/v1/communities/:communityId/members',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { user } = identityOf(request);
      const { communityId } = parseParams(communityParamsSchema, request.params);
      const query = parseQuery(memberListQuerySchema, request.query);

      const result = await context.communities.listMembers({
        communityId,
        viewerId: user.id,
        cursor: query.cursor,
        limit: query.limit,
      });

      if (!result.ok) {
        throw problems.communityNotFound();
      }

      return reply.send({
        members: result.members,
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      });
    },
  );

  app.get(
    '/v1/communities/:communityId/channels',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { user } = identityOf(request);
      const { communityId } = parseParams(communityParamsSchema, request.params);

      const result = await context.communities.listChannels(communityId, user.id);
      if (!result.ok) {
        throw problems.communityNotFound();
      }

      return reply.send({ channels: result.channels });
    },
  );

  app.post(
    '/v1/communities/:communityId/channels',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { user } = identityOf(request);
      const { communityId } = parseParams(communityParamsSchema, request.params);
      const body = parseBody(createChannelRequestSchema, request.body);

      const result = await context.communities.createChannel({
        communityId,
        name: body.name,
        topic: body.topic,
        createdBy: user.id,
      });

      if (!result.ok) {
        switch (result.reason) {
          case 'community_not_found':
            throw problems.communityNotFound();
          case 'forbidden':
            throw problems.forbidden('You cannot create channels in that community.');
          case 'name_taken':
            throw new HttpProblem('conflict', 'A channel with that name already exists.');
        }
      }

      return reply.status(201).send({ channel: result.channel });
    },
  );
}
