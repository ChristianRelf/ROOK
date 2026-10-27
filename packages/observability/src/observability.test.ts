import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { createHealthRegistry } from './health.js';
import { createShutdownManager } from './shutdown.js';
import { createMetrics, renderMetrics } from './metrics.js';

/** Silences log output while still exercising the real logger code paths. */
const silentLogger = pino({ level: 'silent' });

describe('health registry', () => {
  it('reports healthy when every check passes', async () => {
    const registry = createHealthRegistry();
    registry.register({
      name: 'postgres',
      critical: true,
      timeoutMs: 100,
      run: () => Promise.resolve(),
    });

    const report = await registry.readiness();
    expect(report.status).toBe('healthy');
    expect(report.checks['postgres']?.status).toBe('healthy');
  });

  it('is unhealthy when a critical dependency fails', async () => {
    const registry = createHealthRegistry();
    registry.register({
      name: 'postgres',
      critical: true,
      timeoutMs: 100,
      run: () => Promise.reject(new Error('connection refused')),
    });

    const report = await registry.readiness();
    expect(report.status).toBe('unhealthy');
    expect(report.checks['postgres']?.detail).toBe('connection refused');
  });

  it('is only degraded when a non-critical dependency fails', async () => {
    // The distinction that keeps a non-essential outage from taking the
    // instance out of rotation entirely.
    const registry = createHealthRegistry();
    registry.register({
      name: 'postgres',
      critical: true,
      timeoutMs: 100,
      run: () => Promise.resolve(),
    });
    registry.register({
      name: 'object-storage',
      critical: false,
      timeoutMs: 100,
      run: () => Promise.reject(new Error('endpoint unreachable')),
    });

    const report = await registry.readiness();
    expect(report.status).toBe('degraded');
    expect(report.checks['object-storage']?.status).toBe('degraded');
  });

  it('times out a hanging check instead of hanging the probe', async () => {
    const registry = createHealthRegistry();
    registry.register({
      name: 'stalled',
      critical: true,
      timeoutMs: 20,
      // Never settles: models a dependency that accepted the connection and
      // then went silent, which a naive probe waits on forever.
      run: () => new Promise<void>(() => undefined),
    });

    const report = await registry.readiness();
    expect(report.status).toBe('unhealthy');
    expect(report.checks['stalled']?.detail).toContain('timed out');
  });

  it('keeps liveness independent of dependency health', async () => {
    const registry = createHealthRegistry();
    registry.register({
      name: 'postgres',
      critical: true,
      timeoutMs: 50,
      run: () => Promise.reject(new Error('down')),
    });

    // A database outage must not cause an orchestrator to restart the process.
    expect(registry.liveness().status).toBe('healthy');
    expect((await registry.readiness()).status).toBe('unhealthy');
  });

  it('fails readiness once shutdown has begun', async () => {
    const registry = createHealthRegistry();
    registry.setShuttingDown(true);

    const report = await registry.readiness();
    expect(report.status).toBe('unhealthy');
    expect(registry.liveness().status).toBe('unhealthy');
  });

  it('rejects a duplicate check name', () => {
    const registry = createHealthRegistry();
    const check = {
      name: 'postgres',
      critical: true,
      timeoutMs: 50,
      run: () => Promise.resolve(),
    };
    registry.register(check);
    expect(() => registry.register(check)).toThrow(/already registered/);
  });
});

describe('shutdown manager', () => {
  it('runs hooks in reverse registration order', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const manager = createShutdownManager({ logger: silentLogger, graceMs: 1000, exit });

    manager.register({ name: 'pool', run: () => void order.push('pool') });
    manager.register({ name: 'server', run: () => void order.push('server') });

    await manager.shutdown('test');

    // The server stops accepting connections before the pool it depends on
    // is closed.
    expect(order).toEqual(['server', 'pool']);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('continues after a failing hook and still exits', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const manager = createShutdownManager({ logger: silentLogger, graceMs: 1000, exit });

    manager.register({ name: 'pool', run: () => void order.push('pool') });
    manager.register({
      name: 'broken',
      run: () => Promise.reject(new Error('close failed')),
    });

    await manager.shutdown('test');

    expect(order).toEqual(['pool']);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits non-zero when hooks exceed the grace period', async () => {
    const exit = vi.fn();
    const manager = createShutdownManager({ logger: silentLogger, graceMs: 20, exit });

    manager.register({ name: 'stuck', run: () => new Promise<void>(() => undefined) });

    await manager.shutdown('test');

    // A hung hook must not keep the process alive indefinitely.
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('ignores a second shutdown request while draining', async () => {
    const run = vi.fn(() => Promise.resolve());
    const exit = vi.fn();
    const manager = createShutdownManager({ logger: silentLogger, graceMs: 1000, exit });
    manager.register({ name: 'once', run });

    await manager.shutdown('first');
    await manager.shutdown('second');

    expect(run).toHaveBeenCalledTimes(1);
    expect(manager.isShuttingDown).toBe(true);
  });
});

describe('metrics', () => {
  it('exposes registered metrics in Prometheus format', async () => {
    const metrics = createMetrics({ service: 'api' });
    metrics.httpRequests.inc({ method: 'GET', route: '/health/ready', status: '200' });
    metrics.outboxBacklog.set(7);

    const { contentType, body } = await renderMetrics(metrics.registry);

    expect(contentType).toContain('text/plain');
    expect(body).toContain('rook_http_requests_total');
    // Every sample carries the service default label.
    expect(body).toContain('rook_outbox_backlog{service="api"} 7');
    expect(body).toContain(
      'rook_http_requests_total{method="GET",route="/health/ready",status="200",service="api"} 1',
    );
  });

  it('keeps registries isolated between services', async () => {
    const api = createMetrics({ service: 'api' });
    const realtime = createMetrics({ service: 'realtime' });

    api.outboxBacklog.set(5);
    realtime.outboxBacklog.set(1);

    // Two services in one process (as in tests, or a combined dev runner)
    // must not see each other's numbers.
    await expect(api.registry.metrics()).resolves.toContain('rook_outbox_backlog{service="api"} 5');
    await expect(realtime.registry.metrics()).resolves.toContain(
      'rook_outbox_backlog{service="realtime"} 1',
    );
    await expect(realtime.registry.metrics()).resolves.not.toContain('service="api"');
  });
});
