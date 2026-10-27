import type { Logger } from 'pino';
import { toLogError } from './logger.js';

/**
 * Graceful shutdown, in the order that avoids dropping work:
 *
 *   1. Mark readiness unhealthy, so load balancers stop sending new traffic.
 *   2. Stop accepting new work (close the HTTP listener, pause the queue).
 *   3. Let in-flight work finish, up to the grace period.
 *   4. Close outbound resources: database pool, Redis, S3 clients.
 *
 * Hooks run in reverse registration order, so a resource registered after the
 * thing that depends on it is still torn down after it. Registration order
 * therefore mirrors construction order at the call site.
 *
 * A hard deadline sits over the whole sequence: if any hook hangs, the process
 * still exits rather than lingering until an orchestrator kills it. A stuck
 * SIGTERM handler is one of the easier ways to turn a rolling deploy into an
 * outage.
 */

export interface ShutdownHook {
  readonly name: string;
  run: () => Promise<void> | void;
}

export interface ShutdownManagerOptions {
  readonly logger: Logger;
  /** Total time allowed for all hooks before the process exits anyway. */
  readonly graceMs: number;
  /** Seam for tests; defaults to `process.exit`. */
  readonly exit?: (code: number) => void;
  /** Seam for tests; defaults to the real process signal handlers. */
  readonly signals?: readonly NodeJS.Signals[];
}

export interface ShutdownManager {
  /** Hooks are torn down in reverse registration order. */
  register: (hook: ShutdownHook) => void;
  /** Idempotent: a second signal while draining does not re-enter. */
  shutdown: (reason: string, exitCode?: number) => Promise<void>;
  /** Installs SIGTERM/SIGINT and unhandled-rejection handlers. */
  listen: () => void;
  readonly isShuttingDown: boolean;
}

export function createShutdownManager(options: ShutdownManagerOptions): ShutdownManager {
  const { logger, graceMs } = options;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const signals = options.signals ?? (['SIGTERM', 'SIGINT'] as const);

  const hooks: ShutdownHook[] = [];
  let shuttingDown = false;

  async function runHooks(): Promise<void> {
    for (const hook of [...hooks].reverse()) {
      const start = performance.now();
      try {
        await hook.run();
        logger.debug(
          { hook: hook.name, durationMs: Math.round(performance.now() - start) },
          'shutdown hook complete',
        );
      } catch (error) {
        // One failed hook must not prevent the rest from running: the pool
        // still needs closing even if the socket server misbehaved.
        logger.error(
          { hook: hook.name, err: toLogError(error) },
          'shutdown hook failed; continuing',
        );
      }
    }
  }

  const manager: ShutdownManager = {
    get isShuttingDown() {
      return shuttingDown;
    },

    register(hook) {
      hooks.push(hook);
    },

    async shutdown(reason, exitCode = 0) {
      if (shuttingDown) {
        logger.warn({ reason }, 'shutdown already in progress');
        return;
      }
      shuttingDown = true;
      logger.info({ reason, graceMs, hooks: hooks.length }, 'shutting down');

      let hardDeadline: NodeJS.Timeout | undefined;
      const deadline = new Promise<'timeout'>((resolve) => {
        hardDeadline = setTimeout(() => resolve('timeout'), graceMs);
        hardDeadline.unref();
      });

      const outcome = await Promise.race([runHooks().then(() => 'done' as const), deadline]);
      if (hardDeadline !== undefined) clearTimeout(hardDeadline);

      if (outcome === 'timeout') {
        logger.error({ graceMs }, 'graceful shutdown exceeded its grace period; exiting anyway');
        exit(exitCode === 0 ? 1 : exitCode);
        return;
      }

      logger.info({ reason }, 'shutdown complete');
      exit(exitCode);
    },

    listen() {
      for (const signal of signals) {
        process.on(signal, () => {
          void manager.shutdown(`received ${signal}`, 0);
        });
      }

      // An unhandled rejection means we reached a state the code did not
      // account for. Draining and exiting is safer than continuing in it.
      process.on('unhandledRejection', (reason) => {
        logger.fatal({ err: toLogError(reason) }, 'unhandled promise rejection');
        void manager.shutdown('unhandled rejection', 1);
      });

      process.on('uncaughtException', (error) => {
        logger.fatal({ err: error }, 'uncaught exception');
        void manager.shutdown('uncaught exception', 1);
      });
    },
  };

  return manager;
}
