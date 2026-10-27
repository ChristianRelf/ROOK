import type { Redis } from 'ioredis';
import {
  transportChannels,
  transportEnvelopeSchema,
  type TransportEnvelope,
  type UserId,
} from '@rook/contracts';
import { toLogError, type Logger, type MetricsBundle } from '@rook/observability';

/**
 * Routes events from Redis to the sockets on *this* instance.
 *
 * The design point: a gateway subscribes only to the Redis channels its
 * connected clients actually care about, and unsubscribes as soon as the last
 * interested socket goes away. An instance serving ten users therefore never
 * deserialises traffic for the rest of the system.
 *
 * The alternative — one firehose channel with filtering in the gateway — means
 * every instance pays to parse every event, which is exactly the thing that
 * stops you adding instances to shed load.
 *
 * Reference counting is what makes that safe: two sockets watching the same
 * channel share one Redis subscription, and it is dropped only when both are
 * gone.
 */

export type EnvelopeHandler = (envelope: TransportEnvelope) => void;

export interface SubscriptionRegistry {
  /** Subscribes this instance to a channel's events, if not already. */
  addChannel: (channelId: string, handler: EnvelopeHandler) => Promise<void>;
  removeChannel: (channelId: string, handler: EnvelopeHandler) => Promise<void>;
  addCommunity: (communityId: string, handler: EnvelopeHandler) => Promise<void>;
  removeCommunity: (communityId: string, handler: EnvelopeHandler) => Promise<void>;
  addUser: (userId: UserId, handler: EnvelopeHandler) => Promise<void>;
  removeUser: (userId: UserId, handler: EnvelopeHandler) => Promise<void>;
  close: () => Promise<void>;
  /** Diagnostics: how many Redis channels this instance holds. */
  stats: () => { redisChannels: number; handlers: number };
}

export function createSubscriptionRegistry(options: {
  /** Must be a dedicated connection: a subscriber cannot issue other commands. */
  readonly subscriber: Redis;
  readonly logger: Logger;
  readonly metrics: MetricsBundle;
}): SubscriptionRegistry {
  const { subscriber, logger, metrics } = options;

  /** Redis channel -> the local handlers interested in it. */
  const handlers = new Map<string, Set<EnvelopeHandler>>();

  subscriber.on('message', (redisChannel: string, raw: string) => {
    const listeners = handlers.get(redisChannel);
    if (listeners === undefined || listeners.size === 0) {
      // Can happen briefly between the last socket closing and the
      // unsubscribe taking effect. Not an error.
      return;
    }

    let envelope: TransportEnvelope;
    try {
      const parsed: unknown = JSON.parse(raw);
      // Validated even though we published it ourselves: during a rolling
      // deploy an older gateway can receive an envelope written by a newer
      // API, and a schema change must fail here rather than halfway through
      // a handler.
      envelope = transportEnvelopeSchema.parse(parsed);
    } catch (error) {
      logger.error(
        { redisChannel, err: toLogError(error) },
        'discarding malformed transport envelope',
      );
      return;
    }

    for (const listener of listeners) {
      try {
        listener(envelope);
      } catch (error) {
        // One socket's failure must not stop delivery to the others.
        logger.error(
          { redisChannel, eventId: envelope.id, err: toLogError(error) },
          'event handler threw',
        );
      }
    }
  });

  /** Subscribes to `redisChannel` on the first interested handler. */
  async function add(redisChannel: string, handler: EnvelopeHandler): Promise<void> {
    const existing = handlers.get(redisChannel);

    if (existing !== undefined) {
      existing.add(handler);
      return;
    }

    handlers.set(redisChannel, new Set([handler]));
    await subscriber.subscribe(redisChannel);
    logger.debug({ redisChannel }, 'subscribed');
  }

  /** Unsubscribes once the last interested handler has gone. */
  async function remove(redisChannel: string, handler: EnvelopeHandler): Promise<void> {
    const existing = handlers.get(redisChannel);
    if (existing === undefined) return;

    existing.delete(handler);
    if (existing.size > 0) return;

    handlers.delete(redisChannel);
    try {
      await subscriber.unsubscribe(redisChannel);
      logger.debug({ redisChannel }, 'unsubscribed');
    } catch (error) {
      // Losing an unsubscribe only wastes a little bandwidth; the handler set
      // is already gone so nothing is delivered.
      logger.warn({ redisChannel, err: toLogError(error) }, 'unsubscribe failed');
    }
  }

  return {
    addChannel: (channelId, handler) => add(transportChannels.channel(channelId), handler),
    removeChannel: (channelId, handler) => remove(transportChannels.channel(channelId), handler),
    addCommunity: (communityId, handler) => add(transportChannels.community(communityId), handler),
    removeCommunity: (communityId, handler) =>
      remove(transportChannels.community(communityId), handler),
    addUser: (userId, handler) => add(transportChannels.user(userId), handler),
    removeUser: (userId, handler) => remove(transportChannels.user(userId), handler),

    async close() {
      handlers.clear();
      await subscriber.quit();
    },

    stats() {
      let total = 0;
      for (const set of handlers.values()) total += set.size;

      metrics.realtimeConnections.set({ state: 'subscribed_channels' }, handlers.size);
      return { redisChannels: handlers.size, handlers: total };
    },
  };
}
