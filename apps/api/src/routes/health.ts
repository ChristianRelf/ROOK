import type { FastifyInstance } from 'fastify';
import { renderMetrics } from '@rook/observability';
import type { AppContext } from '../context.js';

/**
 * Operational endpoints. Unauthenticated, because a probe cannot hold a
 * session — so each one is careful to disclose nothing useful to an attacker.
 *
 *   GET /health/live    is the process broken? (restart signal)
 *   GET /health/ready   should it receive traffic? (load-balancer signal)
 *   GET /metrics        Prometheus exposition
 *
 * The liveness/readiness split matters: wiring a dependency check into
 * liveness means a brief Postgres blip restarts every instance at once,
 * turning a degraded minute into a cold-start stampede.
 */
export function registerHealthRoutes(app: FastifyInstance, context: AppContext): void {
  app.get('/health/live', async (_request, reply) => {
    const report = context.health.liveness();
    // 503 while draining, so a load balancer stops sending work before the
    // process actually goes away.
    return reply.status(report.status === 'healthy' ? 200 : 503).send(report);
  });

  app.get('/health/ready', async (_request, reply) => {
    const report = await context.health.readiness();

    // `degraded` still serves traffic: a non-critical dependency being down
    // is not a reason to take the instance out of rotation.
    const status = report.status === 'unhealthy' ? 503 : 200;
    return reply.status(status).send(report);
  });

  /**
   * Prometheus metrics.
   *
   * Unauthenticated and therefore intended to be reachable only from inside
   * the deployment network. Exposing it publicly would leak request volumes
   * and error rates; see docs/operations.md.
   */
  app.get('/metrics', async (_request, reply) => {
    // Refreshed at scrape time rather than on a timer: the value is only ever
    // read here, so computing it on demand avoids a pointless background query.
    try {
      const backlog = await context.repositories.outbox.backlogSize();
      context.metrics.outboxBacklog.set(backlog);
    } catch (error) {
      // A metrics endpoint must not fail because one gauge could not be
      // refreshed — the rest of the registry is still worth serving.
      context.logger.warn({ err: error }, 'could not refresh outbox backlog gauge');
    }

    const { contentType, body } = await renderMetrics(context.metrics.registry);
    return reply.header('content-type', contentType).send(body);
  });

  /** Minimal service identity, useful for smoke-checking a deployment. */
  app.get('/', async (_request, reply) =>
    reply.send({
      service: 'rook-api',
      status: 'ok',
    }),
  );
}
