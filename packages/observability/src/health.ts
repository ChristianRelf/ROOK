/**
 * Health checking, split into the two questions an orchestrator actually asks:
 *
 *   liveness   "is this process broken and in need of a restart?"
 *   readiness  "should this instance receive traffic right now?"
 *
 * Conflating them causes outages. If a dependency check is wired into
 * liveness, a brief Postgres blip restarts every API instance at once, turning
 * a degraded minute into a cold-start stampede. So liveness stays local to the
 * process, and only readiness consults dependencies.
 */

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface HealthCheckResult {
  readonly status: HealthStatus;
  /** Short, safe-to-expose explanation. Never include connection strings. */
  readonly detail?: string;
  readonly durationMs: number;
}

export interface HealthCheck {
  readonly name: string;
  /**
   * `critical: false` lets a dependency fail without making the instance
   * unready — appropriate for things the service can degrade around, such as
   * the metrics store, but not for Postgres.
   */
  readonly critical: boolean;
  readonly timeoutMs: number;
  run: () => Promise<void>;
}

export interface HealthReport {
  readonly status: HealthStatus;
  readonly checks: Readonly<Record<string, HealthCheckResult>>;
  readonly checkedAt: string;
}

export interface HealthRegistry {
  register: (check: HealthCheck) => void;
  /** Dependency-aware. Use for `/health/ready` and load-balancer probes. */
  readiness: () => Promise<HealthReport>;
  /** Process-local only. Use for `/health/live`. */
  liveness: () => HealthReport;
  /** Flips readiness to unhealthy during graceful shutdown. */
  setShuttingDown: (shuttingDown: boolean) => void;
}

/** Rejects if `promise` has not settled within `timeoutMs`. */
async function withTimeout(promise: Promise<void>, timeoutMs: number, name: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`health check "${name}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // A pending health-check timer must not keep the process alive.
    timer.unref();
  });

  try {
    await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createHealthRegistry(): HealthRegistry {
  const checks = new Map<string, HealthCheck>();
  const startedAt = Date.now();
  let shuttingDown = false;

  return {
    register(check) {
      if (checks.has(check.name)) {
        throw new Error(`Health check "${check.name}" is already registered`);
      }
      checks.set(check.name, check);
    },

    setShuttingDown(value) {
      shuttingDown = value;
    },

    liveness() {
      // The process is alive if it can answer. Deliberately dependency-free.
      return {
        status: shuttingDown ? 'unhealthy' : 'healthy',
        checks: {
          process: {
            status: shuttingDown ? 'unhealthy' : 'healthy',
            detail: shuttingDown ? 'shutting down' : `up for ${Date.now() - startedAt}ms`,
            durationMs: 0,
          },
        },
        checkedAt: new Date().toISOString(),
      };
    },

    async readiness() {
      if (shuttingDown) {
        return {
          status: 'unhealthy',
          checks: {
            process: { status: 'unhealthy', detail: 'shutting down', durationMs: 0 },
          },
          checkedAt: new Date().toISOString(),
        };
      }

      // Checks run concurrently: readiness probes have tight deadlines, and
      // serialising three 5s timeouts would blow past them.
      const entries = await Promise.all(
        [...checks.values()].map(async (check): Promise<[string, HealthCheckResult, boolean]> => {
          const start = performance.now();
          try {
            await withTimeout(check.run(), check.timeoutMs, check.name);
            return [
              check.name,
              { status: 'healthy', durationMs: Math.round(performance.now() - start) },
              check.critical,
            ];
          } catch (error) {
            const detail = error instanceof Error ? error.message : 'check failed';
            return [
              check.name,
              {
                status: check.critical ? 'unhealthy' : 'degraded',
                detail,
                durationMs: Math.round(performance.now() - start),
              },
              check.critical,
            ];
          }
        }),
      );

      const results: Record<string, HealthCheckResult> = {};
      let status: HealthStatus = 'healthy';

      for (const [name, result, critical] of entries) {
        results[name] = result;
        if (result.status === 'unhealthy' && critical) {
          status = 'unhealthy';
        } else if (result.status !== 'healthy' && status === 'healthy') {
          status = 'degraded';
        }
      }

      return { status, checks: results, checkedAt: new Date().toISOString() };
    },
  };
}
