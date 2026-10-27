import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { PROTOCOL_VERSION, transportChannels, type ChannelId, type UserId } from '@rook/contracts';
import { toLogError, type Logger } from '@rook/observability';

/**
 * Typing indicators.
 *
 * Kept deliberately separate from durable message history, because the two
 * have opposite requirements. A typing indicator is worthless a few seconds
 * later, is generated several times per sentence, and nobody cares if one is
 * lost. Routing it through PostgreSQL and the outbox would mean a durable
 * write â€" and a WAL record, and index maintenance â€" per keystroke.
 *
 * So typing lives entirely in Redis:
 *
 *   * A short TTL key records that someone is typing. It expires on its own,
 *     which is why there is no "stopped typing" message: a client that closes
 *     mid-sentence cannot leave a stuck indicator behind.
 *
 *   * The notification is published straight to the same Redis channel the
 *     outbox relay uses, so gateways deliver it over the existing fan-out
 *     without a second mechanism.
 *
 * The debounce matters at the protocol level too: a client sends `typing` on
 * each keystroke, and without it a fast typist would publish 60 messages a
 * minute per channel.
 */

/** How long an indicator lasts before expiring on its own. */
const TYPING_TTL_SECONDS = 6;

/** Minimum gap between republishing for the same user and channel. */
const TYPING_DEBOUNCE_MS = 2500;

export interface PresenceTracker {
  /** Records and announces that a user is typing. Debounced internally. */
  markTyping: (channelId: ChannelId, userId: UserId) => Promise<void>;
  /** Users currently typing in a channel, for a client that just connected. */
  listTyping: (channelId: ChannelId) => Promise<UserId[]>;
}

export function createPresenceTracker(options: {
  /** Issues the SET/SCAN commands for typing keys. May carry a key prefix. */
  readonly redis: Redis;
  /**
   * Publishes the notification. Deliberately a separate, unprefixed client:
   * a channel name is not a key, and mixing the two invites a mismatch
   * between what is published and what gateways subscribe to.
   */
  readonly publisher: Redis;
  readonly logger: Logger;
}): PresenceTracker {
  const { redis, publisher, logger } = options;

  /** Local debounce, so one socket's keystrokes do not flood Redis. */
  const lastPublished = new Map<string, number>();

  return {
    async markTyping(channelId, userId) {
      const debounceKey = `${channelId}:${userId}`;
      const now = Date.now();
      const previous = lastPublished.get(debounceKey) ?? 0;

      // Refresh the TTL on every keystroke so the indicator does not lapse
      // mid-sentence, but only re-announce on the debounce interval.
      const key = `typing:${channelId}:${userId}`;

      try {
        await redis.set(key, '1', 'EX', TYPING_TTL_SECONDS);
      } catch (error) {
        // Presence is best-effort. Losing it must never surface to the user.
        logger.debug({ err: toLogError(error) }, 'could not record typing state');
        return;
      }

      if (now - previous < TYPING_DEBOUNCE_MS) return;
      lastPublished.set(debounceKey, now);

      // Keep the debounce map from growing without bound on a long-lived
      // gateway: drop entries that are well past their useful life.
      if (lastPublished.size > 10_000) {
        for (const [entryKey, at] of lastPublished) {
          if (now - at > TYPING_TTL_SECONDS * 1000) lastPublished.delete(entryKey);
        }
      }

      const event = {
        // Published in the same envelope shape the relay uses, so gateways
        // need only one delivery path. The id is a UUID like any other
        // event id -- the envelope schema requires it, and a gateway discards
        // anything that does not validate.
        id: randomUUID(),
        type: 'typing',
        audience: { scope: 'channel', channelId },
        payload: {
          v: PROTOCOL_VERSION,
          ts: new Date(now).toISOString(),
          type: 'typing',
          channelId,
          userId,
          expiresAt: new Date(now + TYPING_TTL_SECONDS * 1000).toISOString(),
        },
        occurredAt: new Date(now).toISOString(),
        // Suppressed on the typist's own connections: they know.
        originUserId: userId,
      };

      try {
        await publisher.publish(transportChannels.channel(channelId), JSON.stringify(event));
      } catch (error) {
        logger.debug({ err: toLogError(error) }, 'could not publish typing event');
      }
    },

    async listTyping(channelId) {
      try {
        // A SCAN over a narrow prefix. Not KEYS, which blocks the server for
        // the duration of the scan.
        const pattern = `typing:${channelId}:*`;
        const found: UserId[] = [];
        let cursor = '0';

        do {
          const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
          cursor = next;

          for (const key of keys) {
            const userId = key.split(':').pop();
            if (userId !== undefined) found.push(userId as UserId);
          }
        } while (cursor !== '0');

        return found;
      } catch (error) {
        logger.debug({ err: toLogError(error) }, 'could not list typing state');
        return [];
      }
    },
  };
}
