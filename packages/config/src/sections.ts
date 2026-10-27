import { z } from 'zod';
import { envBoolean, envInt, envList, envSecret, envUrl } from './primitives.js';

/**
 * Configuration is split into sections, and each service validates only the
 * sections it actually uses.
 *
 * That matters operationally: the media worker should not refuse to boot
 * because REALTIME_PORT is malformed, and the realtime gateway should not need
 * S3 credentials in its environment at all. Narrow validation also keeps the
 * blast radius of a bad deploy smaller.
 *
 * Each section pairs a Zod schema over raw env vars with a `build` step that
 * maps SCREAMING_CASE into a structured, camelCase object. Call sites read
 * `config.database.poolMax`; nothing outside this package reads process.env.
 */

export interface Section<Schema extends z.ZodType, Built> {
  readonly name: string;
  readonly schema: Schema;
  readonly build: (env: z.output<Schema>) => Built;
}

/** Keeps `build`'s parameter inferred from the schema instead of restated. */
function defineSection<Schema extends z.ZodType, Built>(
  name: string,
  schema: Schema,
  build: (env: z.output<Schema>) => Built,
): Section<Schema, Built> {
  return { name, schema, build };
}

const logLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

export const runtimeSection = defineSection(
  'runtime',
  z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(logLevels).default('info'),
    LOG_PRETTY: envBoolean.default(false),
    SHUTDOWN_GRACE_SECONDS: envInt({ min: 0, max: 300 }).default(15),
  }),
  (env) => ({
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    logLevel: env.LOG_LEVEL,
    logPretty: env.LOG_PRETTY,
    shutdownGraceMs: env.SHUTDOWN_GRACE_SECONDS * 1000,
  }),
);

export const databaseSection = defineSection(
  'database',
  z.object({
    DATABASE_URL: envUrl(['postgres:', 'postgresql:']),
    DATABASE_POOL_MAX: envInt({ min: 1, max: 1000 }).default(10),
    DATABASE_POOL_IDLE_TIMEOUT_MS: envInt({ min: 1000 }).default(30_000),
    DATABASE_CONNECTION_TIMEOUT_MS: envInt({ min: 100 }).default(5_000),
    DATABASE_STATEMENT_TIMEOUT_MS: envInt({ min: 100 }).default(10_000),
    DATABASE_SSL: envBoolean.default(false),
  }),
  (env) => ({
    url: env.DATABASE_URL,
    poolMax: env.DATABASE_POOL_MAX,
    idleTimeoutMs: env.DATABASE_POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMs: env.DATABASE_CONNECTION_TIMEOUT_MS,
    statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    ssl: env.DATABASE_SSL,
  }),
);

export const redisSection = defineSection(
  'redis',
  z.object({
    REDIS_URL: envUrl(['redis:', 'rediss:']),
    REDIS_KEY_PREFIX: z.string().default('rook:'),
  }),
  (env) => ({
    url: env.REDIS_URL,
    keyPrefix: env.REDIS_KEY_PREFIX,
  }),
);

export const sessionSection = defineSection(
  'session',
  z.object({
    SESSION_TTL_SECONDS: envInt({ min: 60 }).default(2_592_000),
    SESSION_TOKEN_PEPPER: envSecret(32),
    ARGON2_MEMORY_KIB: envInt({ min: 8192 }).default(19_456),
    ARGON2_TIME_COST: envInt({ min: 1, max: 20 }).default(2),
    ARGON2_PARALLELISM: envInt({ min: 1, max: 16 }).default(1),
  }),
  (env) => ({
    ttlSeconds: env.SESSION_TTL_SECONDS,
    tokenPepper: env.SESSION_TOKEN_PEPPER,
    argon2: {
      memoryCost: env.ARGON2_MEMORY_KIB,
      timeCost: env.ARGON2_TIME_COST,
      parallelism: env.ARGON2_PARALLELISM,
    },
  }),
);

export const httpSection = defineSection(
  'http',
  z.object({
    API_HOST: z.string().min(1).default('127.0.0.1'),
    API_PORT: envInt({ min: 1, max: 65_535 }).default(4000),
    API_PUBLIC_URL: envUrl(['http:', 'https:']),
    CORS_ALLOWED_ORIGINS: envList,
  }),
  (env) => ({
    host: env.API_HOST,
    port: env.API_PORT,
    publicUrl: env.API_PUBLIC_URL,
    corsAllowedOrigins: env.CORS_ALLOWED_ORIGINS,
  }),
);

export const realtimeSection = defineSection(
  'realtime',
  z.object({
    REALTIME_HOST: z.string().min(1).default('127.0.0.1'),
    REALTIME_PORT: envInt({ min: 1, max: 65_535 }).default(4001),
    REALTIME_HEARTBEAT_INTERVAL_MS: envInt({ min: 1000 }).default(25_000),
    REALTIME_HEARTBEAT_TIMEOUT_MS: envInt({ min: 2000 }).default(60_000),
    REALTIME_MAX_FRAMES_PER_WINDOW: envInt({ min: 1 }).default(120),
    REALTIME_RATE_WINDOW_MS: envInt({ min: 1000 }).default(10_000),
    REALTIME_MAX_BUFFERED_BYTES: envInt({ min: 16_384 }).default(1_048_576),
    /**
     * Shared with the API deliberately: a client origin allowed to call the
     * API is the same one allowed to open a socket, and keeping them in one
     * variable stops the two lists drifting apart. Browsers do not apply CORS
     * to WebSocket upgrades, so the gateway has to check Origin itself.
     */
    CORS_ALLOWED_ORIGINS: envList,
  }),
  (env) => ({
    host: env.REALTIME_HOST,
    port: env.REALTIME_PORT,
    heartbeatIntervalMs: env.REALTIME_HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs: env.REALTIME_HEARTBEAT_TIMEOUT_MS,
    maxFramesPerWindow: env.REALTIME_MAX_FRAMES_PER_WINDOW,
    rateWindowMs: env.REALTIME_RATE_WINDOW_MS,
    maxBufferedBytes: env.REALTIME_MAX_BUFFERED_BYTES,
    allowedOrigins: env.CORS_ALLOWED_ORIGINS,
  }),
);

export const storageSection = defineSection(
  'storage',
  z.object({
    S3_ENDPOINT: envUrl(['http:', 'https:']),
    S3_PUBLIC_ENDPOINT: envUrl(['http:', 'https:']).optional(),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_BUCKET_MEDIA: z.string().min(3).max(63),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_FORCE_PATH_STYLE: envBoolean.default(true),
  }),
  (env) => ({
    endpoint: env.S3_ENDPOINT,
    // Presigned URLs must be reachable by the client, which may resolve a
    // different host than the services themselves do.
    publicEndpoint: env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT,
    region: env.S3_REGION,
    mediaBucket: env.S3_BUCKET_MEDIA,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  }),
);

export const mediaSection = defineSection(
  'media',
  z.object({
    MEDIA_MAX_UPLOAD_BYTES: envInt({ min: 1024 }).default(10_485_760),
    MEDIA_MAX_IMAGE_PIXELS: envInt({ min: 10_000 }).default(50_000_000),
    MEDIA_MAX_IMAGE_DIMENSION: envInt({ min: 64 }).default(10_000),
    MEDIA_ALLOWED_MIME_TYPES: envList.default(['image/png', 'image/jpeg', 'image/webp']),
    MEDIA_UPLOAD_URL_TTL_SECONDS: envInt({ min: 30, max: 3600 }).default(300),
    MEDIA_DOWNLOAD_URL_TTL_SECONDS: envInt({ min: 30, max: 604_800 }).default(900),
    MEDIA_ORPHAN_CLEANUP_AFTER_SECONDS: envInt({ min: 60 }).default(3_600),
  }),
  (env) => ({
    maxUploadBytes: env.MEDIA_MAX_UPLOAD_BYTES,
    maxImagePixels: env.MEDIA_MAX_IMAGE_PIXELS,
    maxImageDimension: env.MEDIA_MAX_IMAGE_DIMENSION,
    allowedMimeTypes: env.MEDIA_ALLOWED_MIME_TYPES,
    uploadUrlTtlSeconds: env.MEDIA_UPLOAD_URL_TTL_SECONDS,
    downloadUrlTtlSeconds: env.MEDIA_DOWNLOAD_URL_TTL_SECONDS,
    orphanCleanupAfterSeconds: env.MEDIA_ORPHAN_CLEANUP_AFTER_SECONDS,
  }),
);

export const queueSection = defineSection(
  'queue',
  z.object({
    QUEUE_PREFIX: z.string().min(1).default('rook-jobs'),
    QUEUE_MEDIA_CONCURRENCY: envInt({ min: 1, max: 64 }).default(4),
    QUEUE_JOB_ATTEMPTS: envInt({ min: 1, max: 20 }).default(5),
    QUEUE_JOB_BACKOFF_MS: envInt({ min: 100 }).default(2_000),
  }),
  (env) => ({
    prefix: env.QUEUE_PREFIX,
    mediaConcurrency: env.QUEUE_MEDIA_CONCURRENCY,
    jobAttempts: env.QUEUE_JOB_ATTEMPTS,
    jobBackoffMs: env.QUEUE_JOB_BACKOFF_MS,
  }),
);

export const outboxSection = defineSection(
  'outbox',
  z.object({
    OUTBOX_POLL_INTERVAL_MS: envInt({ min: 25 }).default(250),
    OUTBOX_BATCH_SIZE: envInt({ min: 1, max: 5000 }).default(200),
    OUTBOX_RETENTION_SECONDS: envInt({ min: 60 }).default(86_400),
  }),
  (env) => ({
    pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
    batchSize: env.OUTBOX_BATCH_SIZE,
    retentionSeconds: env.OUTBOX_RETENTION_SECONDS,
  }),
);

export const rateLimitSection = defineSection(
  'rateLimit',
  z.object({
    RATE_LIMIT_AUTH_MAX: envInt({ min: 1 }).default(10),
    RATE_LIMIT_AUTH_WINDOW_MS: envInt({ min: 1000 }).default(60_000),
    RATE_LIMIT_MESSAGE_MAX: envInt({ min: 1 }).default(30),
    RATE_LIMIT_MESSAGE_WINDOW_MS: envInt({ min: 1000 }).default(10_000),
    RATE_LIMIT_UPLOAD_MAX: envInt({ min: 1 }).default(20),
    RATE_LIMIT_UPLOAD_WINDOW_MS: envInt({ min: 1000 }).default(60_000),
    RATE_LIMIT_GLOBAL_MAX: envInt({ min: 1 }).default(300),
    RATE_LIMIT_GLOBAL_WINDOW_MS: envInt({ min: 1000 }).default(60_000),
  }),
  (env) => ({
    auth: { max: env.RATE_LIMIT_AUTH_MAX, windowMs: env.RATE_LIMIT_AUTH_WINDOW_MS },
    message: { max: env.RATE_LIMIT_MESSAGE_MAX, windowMs: env.RATE_LIMIT_MESSAGE_WINDOW_MS },
    upload: { max: env.RATE_LIMIT_UPLOAD_MAX, windowMs: env.RATE_LIMIT_UPLOAD_WINDOW_MS },
    global: { max: env.RATE_LIMIT_GLOBAL_MAX, windowMs: env.RATE_LIMIT_GLOBAL_WINDOW_MS },
  }),
);

export type RuntimeConfig = ReturnType<typeof runtimeSection.build>;
export type DatabaseConfig = ReturnType<typeof databaseSection.build>;
export type RedisConfig = ReturnType<typeof redisSection.build>;
export type SessionConfig = ReturnType<typeof sessionSection.build>;
export type HttpConfig = ReturnType<typeof httpSection.build>;
export type RealtimeConfig = ReturnType<typeof realtimeSection.build>;
export type StorageConfig = ReturnType<typeof storageSection.build>;
export type MediaConfig = ReturnType<typeof mediaSection.build>;
export type QueueConfig = ReturnType<typeof queueSection.build>;
export type OutboxConfig = ReturnType<typeof outboxSection.build>;
export type RateLimitConfig = ReturnType<typeof rateLimitSection.build>;
