import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { isQueryCanceled } from '@rook/database';
import { toLogError } from '@rook/observability';
import type { CurrentUser, SessionId } from '@rook/contracts';
import { parseBearerToken } from '@rook/auth';
import type { AppContext } from '../context.js';
import { HttpProblem, problems, toFieldErrors } from '../http-error.js';

/**
 * Cross-cutting request handling: request ids, metrics, the error envelope and
 * authentication.
 *
 * These are registered before any route, so nothing can accidentally serve a
 * request without them.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireAuth`. Present only on authenticated routes. */
    identity?: { user: CurrentUser; sessionId: SessionId };
  }
}

/**
 * Attaches a request id and records timing.
 *
 * The id is echoed in the response header and in the error envelope, so a user
 * reporting a problem can quote something that appears in the logs.
 */
export function registerRequestContext(app: FastifyInstance, context: AppContext): void {
  app.addHook('onRequest', (request, reply, done) => {
    // Honour an inbound id so a trace survives a proxy, but only if it looks
    // like one — an arbitrary client string would end up in every log line.
    const inbound = request.headers['x-request-id'];
    const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
    const requestId =
      candidate !== undefined && /^[A-Za-z0-9_-]{8,64}$/u.test(candidate)
        ? candidate
        : randomUUID();

    request.id = requestId;
    void reply.header('x-request-id', requestId);
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    // The route template, not the concrete URL: labelling metrics with
    // `/v1/channels/<uuid>/messages` would create unbounded label cardinality.
    const route = request.routeOptions.url ?? 'unmatched';
    const labels = {
      method: request.method,
      route,
      status: String(reply.statusCode),
    };

    context.metrics.httpRequests.inc(labels);
    context.metrics.httpDuration.observe(labels, reply.elapsedTime / 1000);
    done();
  });
}

/**
 * Reads a 4xx status off an unknown thrown value.
 *
 * Fastify's framework errors (unparseable JSON, oversized body) carry a
 * `statusCode`, but the error handler is typed `unknown`, so this narrows
 * rather than asserting. Returns undefined for anything that is not a
 * client-error status, which routes it to the generic 500 path.
 */
function clientErrorStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) {
    return undefined;
  }

  const status = (error as { statusCode?: unknown }).statusCode;
  if (typeof status !== 'number' || status < 400 || status >= 500) {
    return undefined;
  }

  return status;
}

/**
 * Translates everything thrown by a route into the single error envelope.
 *
 * The important property: an unexpected error is logged in full and returned
 * as a generic 500. Internal detail — stack traces, constraint names, driver
 * messages — never crosses into a response body, because that detail is how an
 * attacker learns the schema.
 */
export function registerErrorHandler(app: FastifyInstance, context: AppContext): void {
  app.setErrorHandler((error, request, reply) => {
    const requestId = String(request.id);

    if (error instanceof HttpProblem) {
      // Expected, already-safe errors. Logged at warn, since a 4xx is usually
      // a client problem rather than ours.
      context.logger.warn(
        { requestId, code: error.code, status: error.status, path: request.url },
        error.message,
      );

      return reply.status(error.status).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.fields !== undefined ? { fields: error.fields } : {}),
          ...(error.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: error.retryAfterSeconds }
            : {}),
          requestId,
        },
      });
    }

    // A Zod error escaping a route means validation was done somewhere other
    // than the helpers; still return a useful 400 rather than a 500.
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'validation_failed',
          message: 'Some fields need correcting.',
          fields: toFieldErrors(error),
          requestId,
        },
      });
    }

    // Fastify's own body-parse and payload-size failures. The handler receives
    // an `unknown`, so the status is read through a guard rather than asserted.
    const clientStatus = clientErrorStatusOf(error);
    if (clientStatus !== undefined) {
      const code = clientStatus === 413 ? 'payload_too_large' : 'malformed_request';
      return reply.status(clientStatus).send({
        error: {
          code,
          message:
            clientStatus === 413
              ? 'That request was too large.'
              : 'That request could not be understood.',
          requestId,
        },
      });
    }

    // The statement timeout fired. A 503 is more honest than a 500: the
    // request may well succeed on retry.
    if (isQueryCanceled(error)) {
      context.logger.error({ requestId, path: request.url }, 'query cancelled by timeout');
      return reply.status(503).send({
        error: {
          code: 'service_unavailable',
          message: 'That took too long. Please try again.',
          requestId,
        },
      });
    }

    context.logger.error(
      { requestId, path: request.url, method: request.method, err: toLogError(error) },
      'unhandled error',
    );

    return reply.status(500).send({
      error: {
        code: 'internal_error',
        message: 'Something went wrong. Please try again.',
        requestId,
      },
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: {
        code: 'not_found',
        message: 'That endpoint does not exist.',
        requestId: String(request.id),
      },
    }),
  );
}

/**
 * Builds the `preHandler` that authenticates a request.
 *
 * Applied per route rather than globally, so an endpoint is authenticated
 * because it says so — there is no global default that a new public route
 * silently inherits or that a typo in a path-matching rule silently removes.
 */
export function createRequireAuth(context: AppContext) {
  return async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const token = parseBearerToken(request.headers.authorization);
    const result = await context.authenticator.authenticate(token);

    if (!result.ok) {
      throw problems.unauthenticated();
    }

    request.identity = {
      user: result.identity.user,
      sessionId: result.identity.sessionId as SessionId,
    };

    // Activity timestamp, rate-limited internally to one write a minute so an
    // active client does not generate a write per request.
    void context.repositories.sessions
      .touch(result.identity.sessionId as SessionId)
      .catch((error: unknown) => {
        // Non-essential bookkeeping: never fail a request over it.
        context.logger.debug({ err: toLogError(error) }, 'session touch failed');
      });
  };
}

/** Reads the authenticated identity, or throws if the route is misconfigured. */
export function identityOf(request: FastifyRequest): { user: CurrentUser; sessionId: SessionId } {
  const identity = request.identity;
  if (identity === undefined) {
    // Means a handler expecting auth was registered without `requireAuth`.
    // Failing loudly beats serving the request as anonymous.
    throw new Error('Route requires authentication but no identity was attached');
  }
  return identity;
}
