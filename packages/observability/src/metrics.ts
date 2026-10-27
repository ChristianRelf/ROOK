import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';

/**
 * Prometheus metrics, scraped from each service's `/metrics` endpoint.
 *
 * Uses @prometheus-io/client, the maintained continuation of prom-client
 * (which now reports itself deprecated in favour of it). The API is the same.
 *
 * Every service gets its own `Registry` rather than using the global default,
 * so a test can build a registry, assert on it and throw it away without
 * leaking state into the next test.
 *
 * The metric set is deliberately small. These are the numbers you actually
 * need to answer "is it up, is it slow, is it losing work":
 *
 *   - HTTP request rate, status mix and latency
 *   - WebSocket connection count and events delivered
 *   - Outbox backlog, which is the clearest signal that realtime delivery is
 *     falling behind durable writes
 *   - Media job outcomes, so failed processing is visible without reading logs
 */

export interface MetricsBundle {
  readonly registry: Registry;
  readonly httpRequests: Counter<'method' | 'route' | 'status'>;
  readonly httpDuration: Histogram<'method' | 'route' | 'status'>;
  readonly realtimeConnections: Gauge<'state'>;
  readonly realtimeEvents: Counter<'event' | 'direction'>;
  readonly realtimeDropped: Counter<'reason'>;
  /** `never` because this gauge carries no labels of its own. */
  readonly outboxBacklog: Gauge<never>;
  readonly outboxPublished: Counter<'topic'>;
  readonly mediaJobs: Counter<'outcome'>;
  readonly mediaJobDuration: Histogram<'variant'>;
  readonly databaseQueryDuration: Histogram<'operation'>;
}

export function createMetrics(options: { service: string }): MetricsBundle {
  const registry = new Registry();
  registry.setDefaultLabels({ service: options.service });

  // Event-loop lag, heap use, GC pauses. Cheap, and the first thing you want
  // when a Node service goes unresponsive.
  collectDefaultMetrics({ register: registry });

  const httpRequests = new Counter({
    name: 'rook_http_requests_total',
    help: 'HTTP requests handled, by method, route template and status code.',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [registry],
  });

  const httpDuration = new Histogram({
    name: 'rook_http_request_duration_seconds',
    help: 'HTTP request latency in seconds.',
    labelNames: ['method', 'route', 'status'] as const,
    // Tuned for an interactive chat API: most calls should land in the first
    // few buckets, and anything past 1s is worth investigating.
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  const realtimeConnections = new Gauge({
    name: 'rook_realtime_connections',
    help: 'Current WebSocket connections held by this instance, by state.',
    labelNames: ['state'] as const,
    registers: [registry],
  });

  const realtimeEvents = new Counter({
    name: 'rook_realtime_events_total',
    help: 'Realtime events sent to or received from clients.',
    labelNames: ['event', 'direction'] as const,
    registers: [registry],
  });

  const realtimeDropped = new Counter({
    name: 'rook_realtime_dropped_total',
    help: 'Connections closed by the server, by reason (backpressure, rate limit, auth).',
    labelNames: ['reason'] as const,
    registers: [registry],
  });

  const outboxBacklog = new Gauge({
    name: 'rook_outbox_backlog',
    help: 'Committed outbox rows not yet published to the realtime transport.',
    registers: [registry],
  });

  const outboxPublished = new Counter({
    name: 'rook_outbox_published_total',
    help: 'Outbox rows successfully published, by topic.',
    labelNames: ['topic'] as const,
    registers: [registry],
  });

  const mediaJobs = new Counter({
    name: 'rook_media_jobs_total',
    help: 'Media processing jobs by outcome (completed, failed, retried, skipped).',
    labelNames: ['outcome'] as const,
    registers: [registry],
  });

  const mediaJobDuration = new Histogram({
    name: 'rook_media_job_duration_seconds',
    help: 'Time spent processing a media asset, by variant produced.',
    labelNames: ['variant'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [registry],
  });

  const databaseQueryDuration = new Histogram({
    name: 'rook_database_query_duration_seconds',
    help: 'Database query latency by named operation.',
    labelNames: ['operation'] as const,
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 5],
    registers: [registry],
  });

  return {
    registry,
    httpRequests,
    httpDuration,
    realtimeConnections,
    realtimeEvents,
    realtimeDropped,
    outboxBacklog,
    outboxPublished,
    mediaJobs,
    mediaJobDuration,
    databaseQueryDuration,
  };
}

/** Renders the registry in the Prometheus text exposition format. */
export async function renderMetrics(
  registry: Registry,
): Promise<{ contentType: string; body: string }> {
  return { contentType: registry.contentType, body: await registry.metrics() };
}
