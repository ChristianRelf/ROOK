import type { z } from 'zod';
import { ConfigError } from './errors.js';
import { loadDotenv } from './dotenv.js';
import {
  databaseSection,
  httpSection,
  mediaSection,
  outboxSection,
  queueSection,
  rateLimitSection,
  realtimeSection,
  redisSection,
  runtimeSection,
  sessionSection,
  storageSection,
  type Section,
} from './sections.js';

export { ConfigError } from './errors.js';
export { loadDotenv, resetDotenvForTesting } from './dotenv.js';
export type {
  DatabaseConfig,
  HttpConfig,
  MediaConfig,
  OutboxConfig,
  QueueConfig,
  RateLimitConfig,
  RealtimeConfig,
  RedisConfig,
  RuntimeConfig,
  SessionConfig,
  StorageConfig,
} from './sections.js';

/** Raw environment source. Narrower than `process.env` so tests can fake it. */
export type EnvSource = Record<string, string | undefined>;

type AnySection = Section<z.ZodType, unknown>;
type BuiltOf<S> = S extends Section<z.ZodType, infer Built> ? Built : never;

/**
 * Validates one section and maps it to its structured form.
 *
 * Zod issues are flattened into `VARIABLE_NAME: reason` lines, because the
 * person reading the crash log is looking for which variable to fix.
 */
function parseSection<Schema extends z.ZodType, Built>(
  section: Section<Schema, Built>,
  env: EnvSource,
): Built {
  const result = section.schema.safeParse(env);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const variable = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      const missing =
        issue.code === 'invalid_type' &&
        'received' in issue &&
        (issue as { received?: unknown }).received === 'undefined';
      return `${variable}: ${missing ? 'is required but not set' : issue.message}`;
    });
    throw new ConfigError(section.name, issues);
  }

  return section.build(result.data);
}

/**
 * Validates several sections in one pass and returns their results as a tuple,
 * so a single failure report lists every problem across all of them. One bad
 * `.env` should produce one complete error, not a restart-and-retry loop.
 */
function parseSections<const Sections extends readonly AnySection[]>(
  sections: Sections,
  env: EnvSource,
): { -readonly [K in keyof Sections]: BuiltOf<Sections[K]> } {
  const built: unknown[] = [];
  const issues: string[] = [];

  for (const section of sections) {
    try {
      built.push(parseSection(section, env));
    } catch (error) {
      if (error instanceof ConfigError) {
        issues.push(...error.issues.map((issue) => `[${section.name}] ${issue}`));
        continue;
      }
      throw error;
    }
  }

  if (issues.length > 0) {
    throw new ConfigError('environment', issues);
  }

  return built as { -readonly [K in keyof Sections]: BuiltOf<Sections[K]> };
}

/**
 * Loads the environment file (development only) and returns the raw source.
 * Every loader below funnels through here.
 */
function prepareEnv(env?: EnvSource): EnvSource {
  if (env !== undefined) return env;
  loadDotenv();
  return process.env;
}

/**
 * The HTTP API touches every subsystem: it authenticates, reads and writes
 * Postgres, issues presigned URLs, enqueues media jobs and writes the outbox.
 */
export function loadApiConfig(env?: EnvSource) {
  const [runtime, http, database, redis, session, storage, media, queue, rateLimit, outbox] =
    parseSections(
      [
        runtimeSection,
        httpSection,
        databaseSection,
        redisSection,
        sessionSection,
        storageSection,
        mediaSection,
        queueSection,
        rateLimitSection,
        outboxSection,
      ] as const,
      prepareEnv(env),
    );

  return { runtime, http, database, redis, session, storage, media, queue, rateLimit, outbox };
}

/**
 * The gateway authenticates sockets and authorises channel access, so it needs
 * Postgres and the session secret — but no storage or queue access.
 */
export function loadRealtimeGatewayConfig(env?: EnvSource) {
  const [runtime, realtime, database, redis, session, outbox] = parseSections(
    [
      runtimeSection,
      realtimeSection,
      databaseSection,
      redisSection,
      sessionSection,
      // The gateway hosts the outbox relay, so it needs the relay's settings.
      outboxSection,
    ] as const,
    prepareEnv(env),
  );

  return { runtime, realtime, database, redis, session, outbox };
}

/** The worker never serves HTTP, so it validates no HTTP settings. */
export function loadMediaWorkerConfig(env?: EnvSource) {
  const [runtime, database, redis, storage, media, queue, outbox] = parseSections(
    [
      runtimeSection,
      databaseSection,
      redisSection,
      storageSection,
      mediaSection,
      queueSection,
      // The worker owns outbox pruning, so it needs the retention window.
      outboxSection,
    ] as const,
    prepareEnv(env),
  );

  return { runtime, database, redis, storage, media, queue, outbox };
}

/** Migrations and seeds need nothing but a database connection. */
export function loadMigrationConfig(env?: EnvSource) {
  const [runtime, database] = parseSections(
    [runtimeSection, databaseSection] as const,
    prepareEnv(env),
  );

  return { runtime, database };
}

export type ApiConfig = ReturnType<typeof loadApiConfig>;
export type RealtimeGatewayConfig = ReturnType<typeof loadRealtimeGatewayConfig>;
export type MediaWorkerConfig = ReturnType<typeof loadMediaWorkerConfig>;
export type MigrationConfig = ReturnType<typeof loadMigrationConfig>;
