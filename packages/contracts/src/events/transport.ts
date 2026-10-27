import { z } from 'zod';
import { channelIdSchema, communityIdSchema, eventIdSchema, userIdSchema } from '../ids.js';
import { isoTimestampSchema } from '../primitives.js';
import { durableEventTypes, serverEventSchema } from './server-events.js';

/**
 * The internal envelope that moves events between services.
 *
 * This is the contract between the API (which writes events) and the realtime
 * gateways (which deliver them) — not something a client ever sees. It is
 * defined here so both sides validate against the same schema instead of
 * agreeing informally on a JSON shape.
 *
 * The envelope exists because the gateway needs routing information that the
 * client-facing event does not carry. A gateway holding 10,000 sockets must
 * decide who gets a given event without querying Postgres, so the audience is
 * stated up front.
 */

/**
 * Who should receive an event.
 *
 * Resolved once, by the service that produced the event, rather than by every
 * gateway independently — one authorisation decision instead of N.
 */
export const eventAudienceSchema = z.discriminatedUnion('scope', [
  /** Everyone subscribed to a channel: the common case for messages. */
  z.object({ scope: z.literal('channel'), channelId: channelIdSchema }),
  /** Every member of a community: channel creation, member joins. */
  z.object({ scope: z.literal('community'), communityId: communityIdSchema }),
  /** One user across all their devices: media processing results. */
  z.object({ scope: z.literal('user'), userId: userIdSchema }),
]);

export type EventAudience = z.infer<typeof eventAudienceSchema>;

/**
 * Event types that travel over this transport.
 *
 * A superset of the durable types: `typing` is published straight to Redis by
 * the gateway without ever touching PostgreSQL, but it rides the same envelope
 * so gateways need only one delivery path. The distinction between the two is
 * recorded by `durableEventTypes`, which is what the outbox is limited to.
 */
export const transportEventTypeSchema = z.enum([...durableEventTypes, 'typing']);

export type TransportEventType = z.infer<typeof transportEventTypeSchema>;

export const transportEnvelopeSchema = z.object({
  /**
   * Unique per event, assigned when the outbox row is written.
   *
   * Lets a gateway drop a duplicate if Redis delivers one twice, and gives
   * logs a single id that follows an event from commit to client.
   */
  id: eventIdSchema,
  type: transportEventTypeSchema,
  audience: eventAudienceSchema,
  /** Exactly what the client receives, already validated against its schema. */
  payload: serverEventSchema,
  /** When the originating transaction committed, not when it was relayed. */
  occurredAt: isoTimestampSchema,
  /**
   * Excluded from delivery on this user's own connections.
   *
   * The sender already applied the change optimistically, so echoing it back
   * causes a visible flicker as the message is replaced by an identical one.
   */
  originUserId: userIdSchema.nullable(),
});

export type TransportEnvelope = z.infer<typeof transportEnvelopeSchema>;

/**
 * Redis channel naming.
 *
 * Per-audience channels rather than one firehose: a gateway subscribes only to
 * what its connected clients care about, so an instance serving ten users does
 * not deserialise every event in the system. This is the mechanism that lets
 * gateways scale horizontally.
 */
export const transportChannels = {
  channel: (channelId: string) => `rook:events:channel:${channelId}`,
  community: (communityId: string) => `rook:events:community:${communityId}`,
  user: (userId: string) => `rook:events:user:${userId}`,
} as const;

/** The Redis channel an envelope must be published to. */
export function transportChannelFor(audience: EventAudience): string {
  switch (audience.scope) {
    case 'channel':
      return transportChannels.channel(audience.channelId);
    case 'community':
      return transportChannels.community(audience.communityId);
    case 'user':
      return transportChannels.user(audience.userId);
  }
}
