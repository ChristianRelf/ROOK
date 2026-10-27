import type { FastifyInstance } from 'fastify';
import {
  loginRequestSchema,
  registerRequestSchema,
  updateProfileRequestSchema,
  type MediaAssetId,
} from '@rook/contracts';
import type { AppContext } from '../context.js';
import { HttpProblem, problems } from '../http-error.js';
import { createRequireAuth, identityOf } from '../plugins/core.js';
import { parseBody } from '../validate.js';

/**
 * `/v1/auth/*`
 *
 * Registration and login are rate-limited per IP more tightly than the rest of
 * the API: they are the endpoints worth brute-forcing, and they are the most
 * expensive per request because each one runs Argon2.
 */
export function registerAuthRoutes(app: FastifyInstance, context: AppContext): void {
  const requireAuth = createRequireAuth(context);

  const authRateLimit = {
    rateLimit: {
      max: context.config.rateLimit.auth.max,
      timeWindow: context.config.rateLimit.auth.windowMs,
    },
  };

  app.post('/v1/auth/register', { config: authRateLimit }, async (request, reply) => {
    const body = parseBody(registerRequestSchema, request.body);

    const result = await context.accounts.register({
      username: body.username,
      email: body.email,
      password: body.password,
      displayName: body.displayName,
      userAgent: request.headers['user-agent'],
    });

    if (!result.ok) {
      // Registration does disclose that a username is taken — it has to, or
      // the user cannot pick a different one. Login remains silent.
      throw new HttpProblem(
        result.reason,
        result.reason === 'username_taken'
          ? 'That username is already taken.'
          : 'An account with that email already exists.',
      );
    }

    return reply.status(201).send({
      token: result.token,
      expiresAt: result.expiresAt.toISOString(),
      user: result.user,
    });
  });

  app.post('/v1/auth/login', { config: authRateLimit }, async (request, reply) => {
    const body = parseBody(loginRequestSchema, request.body);

    const result = await context.accounts.login({
      identifier: body.identifier,
      password: body.password,
      userAgent: request.headers['user-agent'],
    });

    if (!result.ok) {
      throw problems.invalidCredentials();
    }

    return reply.send({
      token: result.token,
      expiresAt: result.expiresAt.toISOString(),
      user: result.user,
    });
  });

  app.post('/v1/auth/logout', { preHandler: requireAuth }, async (request, reply) => {
    const { sessionId } = identityOf(request);
    await context.accounts.logout(sessionId);

    // 204: the client discards its token; there is nothing to return.
    return reply.status(204).send();
  });

  app.get('/v1/auth/me', { preHandler: requireAuth }, async (request, reply) => {
    // The session lookup already loaded the user, so this needs no further
    // query — it is the client's way to validate a stored token on launch.
    const { user } = identityOf(request);
    return reply.send({ user });
  });

  app.patch('/v1/auth/me', { preHandler: requireAuth }, async (request, reply) => {
    const { user } = identityOf(request);
    const body = parseBody(updateProfileRequestSchema, request.body);

    // An avatar must be an asset this user owns and that finished processing.
    // Without this check a client could point its avatar at any asset id.
    if (body.avatarAssetId !== undefined && body.avatarAssetId !== null) {
      const asset = await context.repositories.media.findOwnedById(
        body.avatarAssetId as MediaAssetId,
        user.id,
      );

      if (asset === undefined) {
        throw problems.notFound('That image');
      }
      if (asset.status !== 'ready') {
        throw new HttpProblem('media_not_ready', 'That image is still being processed.');
      }
    }

    const updated = await context.accounts.updateProfile(user.id, {
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(body.avatarAssetId !== undefined
        ? { avatarAssetId: body.avatarAssetId as MediaAssetId | null }
        : {}),
    });

    if (updated === undefined) {
      throw problems.notFound('Your account');
    }

    return reply.send({ user: updated });
  });
}
