import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  acceptInviteRequestSchema,
  auditLogQuerySchema,
  categoryIdSchema,
  channelIdSchema,
  communityIdSchema,
  createCategoryRequestSchema,
  createInviteRequestSchema,
  inviteCodeSchema,
  inviteIdSchema,
  reorderCategoriesRequestSchema,
  reorderChannelsRequestSchema,
  updateCategoryRequestSchema,
  updateChannelRequestSchema,
  updateMemberRoleRequestSchema,
  userIdSchema,
} from '@rook/contracts';
import type { AuthorizationFailure } from '@rook/messaging';
import type { AppContext } from '../context.js';
import { HttpProblem, problems } from '../http-error.js';
import { createRequireAuth, identityOf } from '../plugins/core.js';
import { parseBody, parseParams, parseQuery } from '../validate.js';

/**
 * Community administration endpoints: categories, channel structure, roles,
 * invites and the audit log.
 *
 * Split from `communities.ts` so the read-mostly member-facing routes stay
 * readable on their own. The authorisation shape is different too: every route
 * here resolves a capability in the service rather than only membership, and
 * all of them share the same two failure mappings — which is why that mapping
 * lives in one function below instead of being repeated fifteen times.
 */

const communityParamsSchema = z.object({ communityId: communityIdSchema });
const categoryParamsSchema = communityParamsSchema.extend({ categoryId: categoryIdSchema });
const channelParamsSchema = communityParamsSchema.extend({ channelId: channelIdSchema });
const memberParamsSchema = communityParamsSchema.extend({ userId: userIdSchema });
const inviteParamsSchema = communityParamsSchema.extend({ inviteId: inviteIdSchema });
const inviteCodeParamsSchema = z.object({ code: inviteCodeSchema });

/**
 * Maps the authorisation failures every administration result can carry.
 *
 * `community_not_found` is returned for a non-member even when the community
 * exists — see the service's `authorize`. Keeping the mapping here means no
 * route can accidentally turn that into a 403 and leak the community's
 * existence.
 */
function throwAuthorizationProblem(reason: AuthorizationFailure, action: string): never {
  if (reason === 'community_not_found') {
    throw problems.communityNotFound();
  }
  throw problems.forbidden(`You do not have permission to ${action}.`);
}

export function registerAdministrationRoutes(app: FastifyInstance, context: AppContext): void {
  const requireAuth = createRequireAuth(context);

  /**
   * Invite lookup and acceptance are rate limited well below the global
   * allowance.
   *
   * These are the only endpoints where the input is a short secret that can be
   * guessed, so they are the only ones where a per-user request budget is
   * doing real work rather than just politeness. 12 base64url characters is
   * far too much entropy to brute force regardless, but a tight limit means an
   * attempt is also loud.
   */
  const inviteLookupRateLimit = {
    rateLimit: {
      max: 20,
      timeWindow: 60_000,
      keyGenerator: (request: { identity?: { user: { id: string } }; ip: string }) =>
        request.identity?.user.id ?? request.ip,
    },
  };

  // --- Categories ----------------------------------------------------------

  app.get(
    '/v1/communities/:communityId/categories',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { user } = identityOf(request);
      const { communityId } = parseParams(communityParamsSchema, request.params);

      const result = await context.communities.channelTree(communityId, user.id);
      if (!result.ok) throw problems.communityNotFound();

      return reply.send({ categories: result.categories });
    },
  );

  app.post(
    '/v1/communities/:communityId/categories',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { user } = identityOf(request);
      const { communityId } = parseParams(communityParamsSchema, request.params);
      const body = parseBody(createCategoryRequestSchema, request.body);

      const result = await context.administration.createCategory({
        communityId,
        name: body.name,
        actorId: user.id,
      });

      if (!result.ok) {
        switch (result.reason) {
          case 'name_taken':
            throw new HttpProblem('conflict', 'A category with that name already exists.');
          case 'limit_reached':
            throw new HttpProblem(
              'conflict',
              'This community already has the maximum number of categories.',
            );
          default:
            throwAuthorizationProblem(result.reason, 'create categories here');
        }
      }

      return reply.status(201).send({ category: result.category });
    },
  );

  app.patch(
    '/v1/communities/:communityId/categories/:categoryId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { user } = identityOf(request);
      const { communityId, categoryId } = parseParams(categoryParamsSchema, request.params);
      const body = parseBody(updateCategoryRequestSchema, request.body);

      const result = await context.administration.updateCategory({
        communityId,
        categoryId,
        name: body.name,
        position: body.position,
        actorId: user.id,
      });

      if (!result.ok) {
        switch (result.reason) {
          case 'not_found':
            throw problems.notFound('That category');
          case 'name_taken':
            throw new HttpProblem('conflict', 'A category with that name already exists.');
          default:
            throwAuthorizationProblem(result.reason, 'edit categories here');
        }
      }

      return reply.send({ category: result.category });
    },
  );

  app.delete(
    '/v1/communities/:communityId/categories/:categoryId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { user } = identityOf(request);
      const { communityId, categoryId } = parseParams(categoryParamsSchema, request.params);

      const result = await context.administration.deleteCategory({
        communityId,
        categoryId,
        actorId: user.id,
      });

      if (!result.ok) {
        if (result.reason === 'not_found') throw problems.notFound('That category');
        throwAuthorizationProblem(result.reason, 'delete categories here');
      }

      return reply.send({ categoryId: result.categoryId });
    },
  );

  app.post(
    '/v1/communities/:communityId/categories/reorder',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { user } = identityOf(request);
      const { communityId } = parseParams(communityParamsSchema, request.params);
      const body = parseBody(reorderCategoriesRequestSchema, request.body);

      const result = await context.administration.reorderCategories({
        communityId,
        categoryIds: body.categoryIds,
        actorId: user.id,
      });

      if (!result.ok) throwAuthorizationProblem(result.reason, 'reorder categories here');

      // 204: the client already has the ordering it just sent, so echoing the
      // whole tree back would be a payload nobody reads.
      return reply.status(204).send();
    },
  );

  // --- Channel structure ---------------------------------------------------

  app.patch(
    '/v1/communities/:communityId/channels/:channelId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { user } = identityOf(request);
      const { communityId, channelId } = parseParams(channelParamsSchema, request.params);
      const body = parseBody(updateChannelRequestSchema, request.body);

      const result = await context.administration.updateChannel({
        communityId,
        channelId,
        name: body.name,
        topic: body.topic,
        categoryId: body.categoryId,
        position: body.position,
        actorId: user.id,
      });

      if (!result.ok) {
        switch (result.reason) {
          case 'not_found':
            throw problems.channelNotFound();
          case 'name_taken':
            throw new HttpProblem('conflict', 'A channel with that name already exists.');
          case 'category_not_found':
            throw problems.notFound('That category');
          default:
            throwAuthorizationProblem(result.reason, 'edit channels here');
        }
      }

      return reply.send({ channel: result.channel });
    },
  );

  app.delete(
    '/v1/communities/:communityId/channels/:channelId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { user } = identityOf(request);
      const { communityId, channelId } = parseParams(channelParamsSchema, request.params);

      const result = await context.administration.deleteChannel({
        communityId,
        channelId,
        actorId: user.id,
      });

      if (!result.ok) {
        switch (result.reason) {
          case 'not_found':
            throw problems.channelNotFound();
          case 'last_channel':
            throw new HttpProblem(
              'conflict',
              'A community needs at least one channel. Create another before deleting this one.',
            );
          default:
            throwAuthorizationProblem(result.reason, 'delete channels here');
        }
      }

      return reply.send({ channelId: result.channelId });
    },
  );

  app.post(
    '/v1/communities/:communityId/channels/reorder',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { user } = identityOf(request);
      const { communityId } = parseParams(communityParamsSchema, request.params);
      const body = parseBody(reorderChannelsRequestSchema, request.body);

      const result = await context.administration.reorderChannels({
        communityId,
        placements: body.channels,
        actorId: user.id,
      });

      if (!result.ok) throwAuthorizationProblem(result.reason, 'reorder channels here');

      return reply.status(204).send();
    },
  );

  // --- Roles and membership ------------------------------------------------

  app.patch(
    '/v1/communities/:communityId/members/:userId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { user } = identityOf(request);
      const { communityId, userId } = parseParams(memberParamsSchema, request.params);
      const body = parseBody(updateMemberRoleRequestSchema, request.body);

      const result = await context.administration.setMemberRole({
        communityId,
        targetUserId: userId,
        role: body.role,
        actorId: user.id,
      });

      if (!result.ok) {
        if (result.reason === 'member_not_found') throw problems.notFound('That member');
        if (result.reason === 'forbidden') {
          // Named specifically, because the general "no permission" wording
          // would be confusing to an admin who *does* hold the capability and
          // is being refused for ranking reasons.
          throw new HttpProblem(
            'insufficient_role',
            'You cannot change the role of someone at or above your own.',
          );
        }
        throwAuthorizationProblem(result.reason, 'manage roles here');
      }

      return reply.send({ member: result.member });
    },
  );

  app.delete(
    '/v1/communities/:communityId/members/:userId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { user } = identityOf(request);
      const { communityId, userId } = parseParams(memberParamsSchema, request.params);

      const result = await context.administration.removeMember({
        communityId,
        targetUserId: userId,
        actorId: user.id,
      });

      if (!result.ok) {
        if (result.reason === 'member_not_found') throw problems.notFound('That member');
        if (result.reason === 'forbidden') {
          throw new HttpProblem(
            'insufficient_role',
            'You cannot remove someone at or above your own role.',
          );
        }
        throwAuthorizationProblem(result.reason, 'remove members here');
      }

      return reply.send({ removedUserId: result.removedUserId });
    },
  );

  // --- Invites -------------------------------------------------------------

  app.get(
    '/v1/communities/:communityId/invites',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { user } = identityOf(request);
      const { communityId } = parseParams(communityParamsSchema, request.params);

      const result = await context.administration.listInvites({ communityId, actorId: user.id });
      if (!result.ok) throwAuthorizationProblem(result.reason, 'view invites here');

      return reply.send({ invites: result.invites });
    },
  );

  app.post(
    '/v1/communities/:communityId/invites',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { user } = identityOf(request);
      const { communityId } = parseParams(communityParamsSchema, request.params);
      const body = parseBody(createInviteRequestSchema, request.body);

      const result = await context.administration.createInvite({
        communityId,
        expiresIn: body.expiresIn,
        maxUses: body.maxUses,
        actorId: user.id,
      });

      if (!result.ok) {
        if (result.reason === 'limit_reached') {
          throw new HttpProblem(
            'conflict',
            'This community already has the maximum number of active invites. Revoke one first.',
          );
        }
        throwAuthorizationProblem(result.reason, 'create invites here');
      }

      return reply.status(201).send({ invite: result.invite });
    },
  );

  app.delete(
    '/v1/communities/:communityId/invites/:inviteId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { user } = identityOf(request);
      const { communityId, inviteId } = parseParams(inviteParamsSchema, request.params);

      const result = await context.administration.revokeInvite({
        communityId,
        inviteId,
        actorId: user.id,
      });

      if (!result.ok) {
        if (result.reason === 'not_found') throw problems.notFound('That invite');
        throwAuthorizationProblem(result.reason, 'revoke that invite');
      }

      return reply.send({ invite: result.invite });
    },
  );

  /**
   * Resolving a code, for the join prompt.
   *
   * Not scoped under a community, because the caller does not know which
   * community the code belongs to — finding that out is the point. Still
   * requires a signed-in user: there is no anonymous browsing in this release,
   * and an authenticated caller gives the rate limiter something stable to key
   * on.
   */
  app.get(
    '/v1/invites/:code',
    { preHandler: requireAuth, config: inviteLookupRateLimit },
    async (request, reply) => {
      const { code } = parseParams(inviteCodeParamsSchema, request.params);

      const result = await context.administration.previewInvite(code);
      if (!result.ok) {
        throw new HttpProblem('invalid_join_code', 'That invite link is not valid any more.');
      }

      return reply.send({ invite: result.invite });
    },
  );

  app.post(
    '/v1/invites/accept',
    { preHandler: requireAuth, config: inviteLookupRateLimit },
    async (request, reply) => {
      const { user } = identityOf(request);
      const body = parseBody(acceptInviteRequestSchema, request.body);

      const result = await context.administration.acceptInvite({
        code: body.code,
        userId: user.id,
      });

      if (!result.ok) {
        switch (result.reason) {
          case 'invite_expired':
            throw new HttpProblem('invalid_join_code', 'That invite link has expired.');
          case 'invite_exhausted':
            throw new HttpProblem(
              'invalid_join_code',
              'That invite link has already been used the maximum number of times.',
            );
          case 'invite_revoked':
            throw new HttpProblem('invalid_join_code', 'That invite link has been revoked.');
          case 'invalid_invite':
            throw new HttpProblem('invalid_join_code', 'That invite link is not valid.');
        }
      }

      // 200 rather than 201 when the user was already a member: nothing was
      // created, and a client that re-opens a link it already accepted should
      // navigate rather than see an error.
      return reply.status(result.joined ? 201 : 200).send({ community: result.community });
    },
  );

  // --- Audit log -----------------------------------------------------------

  app.get(
    '/v1/communities/:communityId/audit-log',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { user } = identityOf(request);
      const { communityId } = parseParams(communityParamsSchema, request.params);
      const query = parseQuery(auditLogQuerySchema, request.query);

      const result = await context.administration.listAuditLog({
        communityId,
        actorId: user.id,
        cursor: query.cursor,
        limit: query.limit,
        action: query.action,
        filterActorId: query.actorId,
      });

      if (!result.ok) {
        if (result.reason === 'invalid_cursor') {
          throw new HttpProblem('validation_failed', 'That pagination cursor is not valid.');
        }
        throwAuthorizationProblem(result.reason, 'view the audit log');
      }

      return reply.send({
        entries: result.entries,
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      });
    },
  );
}
