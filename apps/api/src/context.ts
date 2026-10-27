import { Redis } from 'ioredis';
import type { ApiConfig } from '@rook/config';
import {
  createHealthRegistry,
  createLogger,
  createMetrics,
  type HealthRegistry,
  type Logger,
  type MetricsBundle,
} from '@rook/observability';
import {
  createDatabaseClient,
  createRepositories,
  sql,
  type DatabaseClient,
  type Repositories,
} from '@rook/database';
import {
  createPasswordHasher,
  createSessionAuthenticator,
  createSessionTokenService,
  type PasswordHasher,
  type SessionAuthenticator,
  type SessionTokenService,
} from '@rook/auth';
import {
  createAdministrationService,
  createCommunityService,
  createEventPublisher,
  createMediaService,
  createMessageService,
  createReadStateService,
  type AdministrationService,
  type CommunityService,
  type MediaService,
  type MessageService,
  type ReadStateService,
} from '@rook/messaging';
import { createS3Storage, detectImageType, type ObjectStoragePort } from '@rook/media';
import { createQueue, type QueuePort } from '@rook/queue';
import type { CurrentUser } from '@rook/contracts';
import { createAccountService, type AccountService } from './services/account-service.js';

/**
 * The API's dependency graph, constructed once at boot.
 *
 * Explicit construction rather than a DI container: the graph is small enough
 * to read top to bottom, and the order below *is* the shutdown order reversed,
 * which is what the shutdown manager relies on.
 *
 * Everything a route needs hangs off this object, so a route never reaches for
 * a module-level singleton and tests can build a context against a throwaway
 * database.
 */
export interface AppContext {
  readonly config: ApiConfig;
  readonly logger: Logger;
  readonly metrics: MetricsBundle;
  readonly health: HealthRegistry;
  readonly db: DatabaseClient;
  readonly redis: Redis;
  readonly repositories: Repositories;
  readonly storage: ObjectStoragePort;
  readonly queue: QueuePort;
  readonly tokens: SessionTokenService;
  readonly passwords: PasswordHasher;
  readonly authenticator: SessionAuthenticator<CurrentUser>;
  readonly accounts: AccountService;
  readonly messages: MessageService;
  readonly communities: CommunityService;
  readonly administration: AdministrationService;
  readonly readState: ReadStateService;
  readonly media: MediaService;
  close: () => Promise<void>;
}

export function createAppContext(config: ApiConfig): AppContext {
  const logger = createLogger({
    service: 'api',
    runtime: config.runtime,
  });

  const metrics = createMetrics({ service: 'api' });
  const health = createHealthRegistry();

  const db = createDatabaseClient({
    config: config.database,
    logger,
    onQueryDuration: (operation, seconds) => {
      metrics.databaseQueryDuration.observe({ operation }, seconds);
    },
  });

  const redis = new Redis(config.redis.url, {
    keyPrefix: config.redis.keyPrefix,
    // Fail fast on a dead Redis rather than queueing commands forever: an
    // unbounded offline queue turns a Redis outage into memory growth.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 2,
    lazyConnect: false,
  });

  redis.on('error', (error) => {
    // Redis is used for rate limits and typing indicators, neither of which
    // is durable, so the API degrades rather than failing outright.
    logger.error({ err: error }, 'redis client error');
  });

  const repositories = createRepositories(db);
  const storage = createS3Storage({ config: config.storage, logger });
  const queue = createQueue({ redis: config.redis, queue: config.queue, logger });

  const tokens = createSessionTokenService(config.session);
  const passwords = createPasswordHasher(config.session);

  const authenticator = createSessionAuthenticator<CurrentUser>({
    tokens,
    findSessionByTokenHash: async (tokenHash) => {
      const found = await repositories.sessions.findActiveByTokenHash(tokenHash);
      if (found === undefined) return undefined;

      return {
        sessionId: found.session.id,
        user: found.user,
        expiresAt: found.session.expiresAt,
      };
    },
  });

  const events = createEventPublisher(repositories.outbox);

  const accounts = createAccountService({
    db,
    repositories,
    passwords,
    tokens,
    config: config.session,
    logger,
  });

  const messages = createMessageService({ db, events });
  const communities = createCommunityService({ db, events });
  const administration = createAdministrationService({ db, events });
  const readState = createReadStateService({ db });

  const media = createMediaService({
    db,
    storage,
    config: config.media,
    events,
    enqueueProcessing: async (assetId) => {
      // Deduplicated on the asset id, so a client retrying `confirm` cannot
      // queue the same processing work twice.
      await queue.enqueue('media.process', { assetId }, { deduplicationId: assetId });
    },
    detectContentType: detectImageType,
  });

  // --- Readiness checks -----------------------------------------------------
  //
  // Critical dependencies fail readiness; the rest only degrade it. Postgres is
  // critical because nothing works without it. Redis is not: losing it costs
  // rate limiting and typing indicators, and taking every instance out of
  // rotation over that would be a worse outage than the degradation.

  health.register({
    name: 'postgres',
    critical: true,
    timeoutMs: 2000,
    run: async () => {
      // Cheapest possible round trip that proves a connection can be checked
      // out of the pool and the server answers.
      await db.query(sql`select 1`, 'health.postgres');
    },
  });

  health.register({
    name: 'redis',
    critical: false,
    timeoutMs: 2000,
    run: async () => {
      await redis.ping();
    },
  });

  health.register({
    name: 'object-storage',
    critical: false,
    timeoutMs: 3000,
    run: async () => {
      // A head on a key that will not exist. We are checking that the endpoint
      // answers and our credentials are accepted, not that anything is there —
      // so "not found" is a pass and only a thrown error is a failure.
      await storage.head('health/probe');
    },
  });

  return {
    config,
    logger,
    metrics,
    health,
    db,
    redis,
    repositories,
    storage,
    queue,
    tokens,
    passwords,
    authenticator,
    accounts,
    messages,
    communities,
    administration,
    readState,
    media,
    async close() {
      // Reverse construction order.
      await queue.close();
      redis.disconnect();
      await db.close();
    },
  };
}
