import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Redis } from 'ioredis';
import { loadRealtimeGatewayConfig } from '@rook/config';
import {
  createHealthRegistry,
  createLogger,
  createMetrics,
  createShutdownManager,
  renderMetrics,
} from '@rook/observability';
import { createDatabaseClient, createRepositories, sql } from '@rook/database';
import { createSessionAuthenticator, createSessionTokenService } from '@rook/auth';
import { closeCodes, type ChannelId, type CurrentUser } from '@rook/contracts';
import { handleConnection } from './connection.js';
import { createSubscriptionRegistry } from './subscriptions.js';
import { createPresenceTracker } from './presence.js';
import { createOutboxRelay } from './relay.js';

/**
 * The realtime gateway.
 *
 * Runs two things in one process:
 *
 *   1. The WebSocket server that delivers events to clients.
 *   2. The outbox relay that moves committed events from PostgreSQL to Redis.
 *
 * They are co-located because the relay is part of event delivery and
 * `for update skip locked` makes it safe to run one per gateway instance — N
 * gateways means N relays sharing the work, not N copies of it. Splitting the
 * relay into its own deployment is a configuration change, not a rewrite; see
 * docs/scaling.md.
 *
 * The gateway holds no durable state. Everything a reconnecting client needs
 * is in PostgreSQL, which is what lets any instance serve any client and lets
 * an instance be replaced without coordination.
 */
async function main(): Promise<void> {
  const config = loadRealtimeGatewayConfig();

  // Identifies this instance in logs and in the `ready` event, which is what
  // makes a multi-instance deployment debuggable.
  const instanceId = process.env['INSTANCE_ID'] ?? randomUUID().slice(0, 8);

  const logger = createLogger({
    service: 'realtime',
    runtime: config.runtime,
    bindings: { instanceId },
  });

  const metrics = createMetrics({ service: 'realtime' });
  const health = createHealthRegistry();

  logger.info(
    { host: config.realtime.host, port: config.realtime.port, instanceId },
    'starting rook realtime gateway',
  );

  const db = createDatabaseClient({
    config: config.database,
    logger,
    onQueryDuration: (operation, seconds) =>
      metrics.databaseQueryDuration.observe({ operation }, seconds),
  });

  const repositories = createRepositories(db);

  // Three Redis connections, and they cannot be shared:
  //  - `subscriber` is in subscribe mode, where no other command is allowed;
  //  - `publisher` carries the relay's PUBLISH calls;
  //  - `commands` handles presence keys (SET/SCAN).
  const subscriber = new Redis(config.redis.url, { maxRetriesPerRequest: null });
  const publisher = new Redis(config.redis.url, { enableOfflineQueue: false });
  const commands = new Redis(config.redis.url, {
    keyPrefix: config.redis.keyPrefix,
    enableOfflineQueue: false,
  });

  for (const [name, client] of [
    ['subscriber', subscriber],
    ['publisher', publisher],
    ['commands', commands],
  ] as const) {
    client.on('error', (error) => {
      logger.error({ redisClient: name, err: error }, 'redis error');
    });
  }

  const subscriptions = createSubscriptionRegistry({ subscriber, logger, metrics });
  const presence = createPresenceTracker({ redis: commands, publisher, logger });

  const tokens = createSessionTokenService(config.session);
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

  const relay = createOutboxRelay({
    db,
    publisher,
    config: config.outbox,
    logger,
    metrics,
  });

  // --- Health --------------------------------------------------------------
  health.register({
    name: 'postgres',
    critical: true,
    timeoutMs: 2000,
    run: async () => {
      await db.query(sql`select 1`, 'health.postgres');
    },
  });

  health.register({
    name: 'redis',
    critical: true,
    timeoutMs: 2000,
    // Critical here, unlike in the API: without Redis the gateway cannot
    // receive events at all, so it has nothing to offer a connected client.
    run: async () => {
      await publisher.ping();
    },
  });

  // --- HTTP server ---------------------------------------------------------
  //
  // Serves the health and metrics endpoints, and is what the WebSocket upgrade
  // handshake attaches to.
  const httpServer = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = request.url ?? '/';

    const respond = (status: number, body: unknown, contentType = 'application/json'): void => {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      response.writeHead(status, {
        'content-type': contentType,
        'content-length': Buffer.byteLength(payload),
      });
      response.end(payload);
    };

    if (url === '/health/live') {
      const report = health.liveness();
      respond(report.status === 'healthy' ? 200 : 503, report);
      return;
    }

    if (url === '/health/ready') {
      void health
        .readiness()
        .then((report) => respond(report.status === 'unhealthy' ? 503 : 200, report))
        .catch(() => respond(503, { status: 'unhealthy' }));
      return;
    }

    if (url === '/metrics') {
      metrics.realtimeConnections.set(
        { state: 'subscribed_channels' },
        subscriptions.stats().redisChannels,
      );
      void renderMetrics(metrics.registry)
        .then(({ contentType, body }) => respond(200, body, contentType))
        .catch(() => respond(500, { error: 'metrics unavailable' }));
      return;
    }

    respond(404, { error: { code: 'not_found', message: 'That endpoint does not exist.' } });
  });

  // --- WebSocket server ----------------------------------------------------
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    // Rejects an oversized frame at the protocol level, before it is buffered.
    maxPayload: 64 * 1024,
    // permessage-deflate is off deliberately: for the small JSON frames this
    // protocol sends, compression costs more CPU and memory per connection
    // than it saves in bandwidth, and it is a known source of memory growth
    // with many idle sockets.
    perMessageDeflate: false,
  });

  wss.on('connection', (socket, request) => {
    // An Origin check on upgrade: browsers do not apply CORS to WebSockets,
    // so without this any page could open a socket to the gateway and, with a
    // stolen token, read a user's messages.
    const origin = request.headers.origin;
    if (origin !== undefined && !config.realtime.allowedOrigins.includes(origin)) {
      logger.warn({ origin }, 'rejected websocket upgrade from disallowed origin');
      socket.close(closeCodes.authenticationFailed, 'origin not allowed');
      return;
    }

    handleConnection(socket, {
      config: config.realtime,
      logger,
      metrics,
      subscriptions,
      presence,
      instanceId,
      authenticate: async (token) => {
        // The identify frame carries the raw token, not an Authorization
        // header, so it goes straight to the authenticator.
        const result = await authenticator.authenticate(token);
        return result.ok ? result.identity.user : undefined;
      },
      listAccessibleChannelIds: async (userId) => {
        const channels = await repositories.channels.listAccessibleForUser(userId);
        return channels.map((channel) => channel.id as ChannelId);
      },
      listCommunityIds: async (userId) => {
        const communities = await repositories.communities.listForUser(userId);
        return communities.map((community) => community.id);
      },
    });
  });

  // --- Lifecycle -----------------------------------------------------------
  const shutdown = createShutdownManager({
    logger,
    graceMs: config.runtime.shutdownGraceMs,
  });

  shutdown.register({
    name: 'infrastructure',
    run: async () => {
      await subscriptions.close();
      publisher.disconnect();
      commands.disconnect();
      await db.close();
    },
  });

  shutdown.register({ name: 'outbox-relay', run: () => relay.stop() });

  shutdown.register({
    name: 'websocket-server',
    run: async () => {
      health.setShuttingDown(true);

      // Tell clients this is a normal redeploy, so they reconnect promptly
      // instead of treating it as an error and backing off.
      for (const client of wss.clients) {
        client.close(closeCodes.goingAway, 'server shutting down');
      }

      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.realtime.port, config.realtime.host, () => resolve());
  });

  relay.start();

  logger.info(
    { url: `ws://${config.realtime.host}:${config.realtime.port}/ws` },
    'rook realtime gateway listening',
  );

  shutdown.listen();
}

await main().catch((error: unknown) => {
  process.stderr.write(
    `rook-realtime failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
