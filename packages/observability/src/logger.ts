import { pino, type Logger, type LoggerOptions } from 'pino';
import type { RuntimeConfig } from '@rook/config';

/**
 * Structured logging for every Rook service.
 *
 * Two properties matter more than anything else here:
 *
 *  1. Logs are JSON in production so they can be queried, and human-readable
 *     in development so they can be skimmed.
 *  2. Secrets never reach the log, even accidentally. Redaction is applied by
 *     path at the logger level rather than trusted to each call site, because
 *     one careless `log.info({ user })` is all it takes to leak a password
 *     hash into permanent storage.
 */

/**
 * Paths scrubbed from every log line.
 *
 * Presigned URLs are included deliberately: they are bearer credentials for
 * object storage, so a log aggregator holding them is a privilege escalation
 * path. We log the asset id instead.
 */
const REDACTED_PATHS = [
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
  'sessionToken',
  '*.sessionToken',
  'tokenHash',
  '*.tokenHash',
  'pepper',
  '*.pepper',
  'secret',
  '*.secret',
  'accessKeyId',
  '*.accessKeyId',
  'secretAccessKey',
  '*.secretAccessKey',
  'authorization',
  '*.authorization',
  'uploadUrl',
  '*.uploadUrl',
  'downloadUrl',
  '*.downloadUrl',
  'signedUrl',
  '*.signedUrl',
  'req.headers.authorization',
  'req.headers.cookie',
  'request.headers.authorization',
  'headers.authorization',
  'headers.cookie',
] as const;

export interface LoggerFactoryOptions {
  /** Appears as `service` on every line, e.g. `api`, `realtime`. */
  readonly service: string;
  readonly runtime: Pick<RuntimeConfig, 'logLevel' | 'logPretty' | 'isProduction'>;
  /** Extra static fields, e.g. an instance id for multi-instance deployments. */
  readonly bindings?: Record<string, string | number | boolean>;
}

export type { Logger };

/** Builds the root logger for a service. Child loggers come off this. */
export function createLogger(options: LoggerFactoryOptions): Logger {
  const { service, runtime, bindings } = options;

  const base: LoggerOptions = {
    level: runtime.logLevel,
    base: {
      service,
      // Lets you tell instances apart once more than one is running.
      pid: process.pid,
      ...bindings,
    },
    redact: {
      paths: [...REDACTED_PATHS],
      censor: '[redacted]',
    },
    // ISO timestamps beat epoch millis when a human is reading the log.
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    // Errors serialise with message, stack and cause instead of becoming `{}`.
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
  };

  if (runtime.logPretty && !runtime.isProduction) {
    return pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,service',
          messageFormat: '[{service}] {msg}',
          singleLine: false,
        },
      },
    });
  }

  return pino(base);
}

/**
 * Normalises a thrown value into something loggable.
 *
 * JavaScript lets you throw anything, and `String(error)` on a plain object
 * yields `[object Object]`, which is worse than useless in an incident.
 */
export function toLogError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === 'string') return new Error(error);
  return new Error(`Non-error thrown: ${JSON.stringify(error)}`);
}

/** The paths this logger redacts. Exported so tests can assert coverage. */
export const redactedPaths: readonly string[] = REDACTED_PATHS;
