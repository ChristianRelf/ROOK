import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { Redis } from 'ioredis';
import type { AppContext } from './context.js';
import { registerErrorHandler, registerRequestContext } from './plugins/core.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCommunityRoutes } from './routes/communities.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerMessageRoutes } from './routes/messages.js';

/**
 * Builds the HTTP server.
 *
 * Separated from the entrypoint so tests can build an app against a throwaway
 * database and drive it with `app.inject()` — no port binding, no process
 * lifecycle.
 */
export async function buildApp(context: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    // Our own logger handles request logging, with redaction configured.
    // Fastify's would duplicate it without the redaction.
    logger: false,
    // Trust the proxy's forwarded headers only where one is actually in front
    // of us. Enabling this unconditionally would let any client spoof its IP
    // via X-Forwarded-For and defeat per-IP rate limiting.
    trustProxy: context.config.runtime.isProduction,
    // A JSON body this large is already pathological; media never comes
    // through here.
    bodyLimit: 256 * 1024,
    // Ids are assigned in our own hook so they can be validated.
    genReqId: () => '',
    disableRequestLogging: true,
  });

  registerRequestContext(app, context);
  registerErrorHandler(app, context);

  // --- Security headers ----------------------------------------------------
  await app.register(helmet, {
    // The API serves only JSON. A restrictive CSP costs nothing here and
    // protects the error pages and any future browsable endpoint.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    // HSTS only makes sense once traffic is actually HTTPS.
    hsts: context.config.runtime.isProduction,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  // --- CORS ----------------------------------------------------------------
  await app.register(cors, {
    /**
     * An explicit allow-list from configuration, never a wildcard and never a
     * reflected origin. The Tauri webview reports one of the `tauri://`
     * origins; the Vite dev server reports `http://localhost:1420`.
     */
    origin: (origin, callback) => {
      // Requests with no Origin header are not browser cross-origin requests
      // (native clients, curl, server-to-server), so there is nothing for CORS
      // to protect and nothing to reflect.
      if (origin === undefined) {
        callback(null, true);
        return;
      }

      if (context.config.http.corsAllowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      context.logger.warn({ origin }, 'rejected cross-origin request');
      callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 600,
  });

  // --- Rate limiting -------------------------------------------------------
  //
  // Backed by Redis so limits are shared across API instances. An in-memory
  // limiter would silently multiply every limit by the instance count, which
  // is the kind of thing that only shows up under the load it was meant to
  // prevent.
  await app.register(rateLimit, {
    global: true,
    max: context.config.rateLimit.global.max,
    timeWindow: context.config.rateLimit.global.windowMs,
    redis: new Redis(context.config.redis.url, {
      keyPrefix: `${context.config.redis.keyPrefix}ratelimit:`,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    }),
    // Keyed per authenticated user where available, falling back to IP.
    keyGenerator: (request) => request.identity?.user.id ?? request.ip,
    // Health and metrics must stay reachable while a client is being limited,
    // or a traffic spike takes the instance out of rotation.
    allowList: (request) => request.url.startsWith('/health') || request.url === '/metrics',
    // Returned through the standard error envelope rather than a plugin-shaped
    // body, so the client has exactly one error format to handle.
    errorResponseBuilder: (request, limitContext) => ({
      statusCode: 429,
      error: {
        code: 'rate_limited',
        message: 'Too many requests. Please slow down.',
        retryAfterSeconds: Math.ceil(limitContext.ttl / 1000),
        requestId: String(request.id),
      },
    }),
  });

  // --- Routes --------------------------------------------------------------
  registerHealthRoutes(app, context);
  registerAuthRoutes(app, context);
  registerCommunityRoutes(app, context);
  registerMessageRoutes(app, context);
  registerMediaRoutes(app, context);

  await app.ready();
  return app;
}
