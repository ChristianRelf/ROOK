import { z } from 'zod';
import { channelIdSchema } from '../ids.js';
import { protocolVersionSchema } from './protocol.js';

/**
 * Frames the client sends to the gateway.
 *
 * This set is intentionally tiny. Messages are sent over HTTP, not over the
 * socket, so that persistence and its error handling live on one well-tested
 * path with real status codes — the socket is for *receiving*. The only thing
 * a client may write through the socket is a typing indicator, which is
 * ephemeral by nature and never touches Postgres.
 *
 * Every inbound frame is validated and authorised before it is acted on.
 */

/** Must be the first frame; the socket is unauthenticated until it arrives. */
export const identifyFrameSchema = z.object({
  type: z.literal('identify'),
  protocolVersion: protocolVersionSchema,
  /**
   * The session token, sent in the first frame rather than the query string.
   *
   * Query strings end up in access logs and proxy logs; a frame body does not.
   */
  token: z.string().min(1),
  /** Channels to subscribe to immediately, saving a round trip on open. */
  channelIds: z.array(channelIdSchema).max(200).default([]),
});

export const heartbeatFrameSchema = z.object({
  type: z.literal('heartbeat'),
});

export const subscribeFrameSchema = z.object({
  type: z.literal('subscribe'),
  channelIds: z.array(channelIdSchema).min(1).max(200),
});

export const unsubscribeFrameSchema = z.object({
  type: z.literal('unsubscribe'),
  channelIds: z.array(channelIdSchema).min(1).max(200),
});

/**
 * Typing indicator.
 *
 * Deliberately fire-and-forget with no acknowledgement and no persistence.
 * It expires on a timer held in Redis, so a client that disconnects
 * mid-sentence does not leave a stuck "…is typing" forever.
 */
export const typingFrameSchema = z.object({
  type: z.literal('typing'),
  channelId: channelIdSchema,
});

export const clientFrameSchema = z.discriminatedUnion('type', [
  identifyFrameSchema,
  heartbeatFrameSchema,
  subscribeFrameSchema,
  unsubscribeFrameSchema,
  typingFrameSchema,
]);

export type ClientFrame = z.infer<typeof clientFrameSchema>;
export type IdentifyFrame = z.infer<typeof identifyFrameSchema>;
export type SubscribeFrame = z.infer<typeof subscribeFrameSchema>;
export type TypingFrame = z.infer<typeof typingFrameSchema>;
