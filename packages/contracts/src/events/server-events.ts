import { z } from 'zod';
import {
  categoryIdSchema,
  channelIdSchema,
  communityIdSchema,
  messageIdSchema,
  userIdSchema,
} from '../ids.js';
import { channelSchema } from '../entities/channel.js';
import { channelCategorySchema } from '../entities/category.js';
import { communityRoleSchema } from '../entities/community.js';
import { messageSchema } from '../entities/message.js';
import { mediaAssetSchema } from '../entities/media.js';
import { publicUserSchema } from '../entities/user.js';
import { errorCodeSchema } from '../errors.js';
import { isoTimestampSchema } from '../primitives.js';
import { PROTOCOL_VERSION } from './protocol.js';

/**
 * Events the gateway sends to clients.
 *
 * How this fits the durability model, since it is the part most easily got
 * wrong: Postgres is the source of truth and these events are a *notification*
 * layer. Every durable event is written to a transactional outbox in the same
 * transaction as the change itself, then relayed to Redis and fanned out here.
 * So an event cannot describe a change that was rolled back.
 *
 * The converse — an event that never arrives because the client was offline —
 * is handled by the client refetching history over HTTP on reconnect, not by
 * replaying a socket log. Events are therefore idempotent by id: applying
 * `message.created` for a message already in the store is a no-op. That is
 * what lets a reconnect be safe without deduplication state on the server.
 */

/** Fields on every server event. */
const envelopeFields = {
  v: z.literal(PROTOCOL_VERSION),
  /** When the gateway emitted it. For diagnostics, not for ordering. */
  ts: isoTimestampSchema,
} as const;

/**
 * Sent once `identify` succeeds. Until a client receives this, it must assume
 * nothing about its subscriptions.
 */
export const readyEventSchema = z.object({
  ...envelopeFields,
  type: z.literal('ready'),
  userId: userIdSchema,
  /** Which gateway instance served this socket; useful in multi-instance logs. */
  instanceId: z.string().min(1),
  /** Client must send a heartbeat at least this often. */
  heartbeatIntervalMs: z.number().int().positive(),
  subscribedChannelIds: z.array(channelIdSchema),
});

export const heartbeatAckEventSchema = z.object({
  ...envelopeFields,
  type: z.literal('heartbeat.ack'),
});

/** Confirms a subscription change, including channels that were refused. */
export const subscriptionsEventSchema = z.object({
  ...envelopeFields,
  type: z.literal('subscriptions'),
  subscribedChannelIds: z.array(channelIdSchema),
  /**
   * Channels the client asked for but may not access. Named explicitly so the
   * client can drop them rather than wait forever for events that will never
   * come.
   */
  rejectedChannelIds: z.array(channelIdSchema),
});

export const messageCreatedEventSchema = z.object({
  ...envelopeFields,
  type: z.literal('message.created'),
  channelId: channelIdSchema,
  message: messageSchema,
});

export const messageUpdatedEventSchema = z.object({
  ...envelopeFields,
  type: z.literal('message.updated'),
  channelId: channelIdSchema,
  message: messageSchema,
});

/**
 * Carries only ids, not the message body.
 *
 * Re-sending content on delete would put deleted text back on the wire to
 * clients that had never loaded it.
 */
export const messageDeletedEventSchema = z.object({
  ...envelopeFields,
  type: z.literal('message.deleted'),
  channelId: channelIdSchema,
  messageId: messageIdSchema,
  deletedAt: isoTimestampSchema,
});

export const channelCreatedEventSchema = z.object({
  ...envelopeFields,
  type: z.literal('channel.created'),
  communityId: communityIdSchema,
  channel: channelSchema,
});

export const channelUpdatedEventSchema = z.object({
  ...envelopeFields,
  type: z.literal('channel.updated'),
  communityId: communityIdSchema,
  channel: channelSchema,
});

export const channelDeletedEventSchema = z.object({
  ...envelopeFields,
  type: z.literal('channel.deleted'),
  communityId: communityIdSchema,
  channelId: channelIdSchema,
});

export const categoryCreatedEventSchema = z.object({
  ...envelopeFields,
  type: z.literal('category.created'),
  communityId: communityIdSchema,
  category: channelCategorySchema,
});

export const categoryUpdatedEventSchema = z.object({
  ...envelopeFields,
  type: z.literal('category.updated'),
  communityId: communityIdSchema,
  category: channelCategorySchema,
});

/**
 * A category was removed.
 *
 * Carries no channel list: deleting a category leaves its channels in place as
 * uncategorised, and the client refetches the tree rather than trying to
 * reparent rows from an event. Reparenting locally would be a second source of
 * truth for sidebar structure.
 */
export const categoryDeletedEventSchema = z.object({
  ...envelopeFields,
  type: z.literal('category.deleted'),
  communityId: communityIdSchema,
  categoryId: categoryIdSchema,
});

/**
 * A member's role changed.
 *
 * Delivered to the whole community, not just the affected member: role is
 * visible in the member list, so everyone's sidebar is stale until they are
 * told. The affected user's own client also uses it to re-evaluate which
 * administrative affordances to show.
 */
export const memberUpdatedEventSchema = z.object({
  ...envelopeFields,
  type: z.literal('member.updated'),
  communityId: communityIdSchema,
  member: publicUserSchema,
  role: communityRoleSchema,
});

/**
 * A member left or was removed.
 *
 * The same event for both, because the distinction is in the audit log rather
 * than in what every client has to do about it — remove the row from the
 * member list. The removed user's own client additionally drops the community.
 */
export const memberRemovedEventSchema = z.object({
  ...envelopeFields,
  type: z.literal('member.removed'),
  communityId: communityIdSchema,
  userId: userIdSchema,
});

export const memberJoinedEventSchema = z.object({
  ...envelopeFields,
  type: z.literal('member.joined'),
  communityId: communityIdSchema,
  member: publicUserSchema,
});

/**
 * Typing indicator, with an expiry instead of a matching "stopped" event.
 *
 * A stop event is unreliable — the client may close before sending it — so the
 * indicator is self-expiring and the client clears it on a timer.
 */
export const typingEventSchema = z.object({
  ...envelopeFields,
  type: z.literal('typing'),
  channelId: channelIdSchema,
  userId: userIdSchema,
  expiresAt: isoTimestampSchema,
});

/**
 * An asset finished (or failed) processing. Lets an already-rendered message
 * swap a placeholder for a thumbnail without a refetch.
 */
export const mediaUpdatedEventSchema = z.object({
  ...envelopeFields,
  type: z.literal('media.updated'),
  asset: mediaAssetSchema,
});

/**
 * A problem with something the client sent.
 *
 * `fatal` tells the client whether to stop or carry on, so it does not have to
 * infer that from the code.
 */
export const errorEventSchema = z.object({
  ...envelopeFields,
  type: z.literal('error'),
  code: errorCodeSchema,
  message: z.string(),
  fatal: z.boolean(),
});

export const serverEventSchema = z.discriminatedUnion('type', [
  readyEventSchema,
  heartbeatAckEventSchema,
  subscriptionsEventSchema,
  messageCreatedEventSchema,
  messageUpdatedEventSchema,
  messageDeletedEventSchema,
  channelCreatedEventSchema,
  channelUpdatedEventSchema,
  channelDeletedEventSchema,
  categoryCreatedEventSchema,
  categoryUpdatedEventSchema,
  categoryDeletedEventSchema,
  memberJoinedEventSchema,
  memberUpdatedEventSchema,
  memberRemovedEventSchema,
  typingEventSchema,
  mediaUpdatedEventSchema,
  errorEventSchema,
]);

export type ServerEvent = z.infer<typeof serverEventSchema>;
export type ServerEventType = ServerEvent['type'];

export type ReadyEvent = z.infer<typeof readyEventSchema>;
export type MessageCreatedEvent = z.infer<typeof messageCreatedEventSchema>;
export type MessageUpdatedEvent = z.infer<typeof messageUpdatedEventSchema>;
export type MessageDeletedEvent = z.infer<typeof messageDeletedEventSchema>;
export type TypingEvent = z.infer<typeof typingEventSchema>;
export type MediaUpdatedEvent = z.infer<typeof mediaUpdatedEventSchema>;

/**
 * Event types that originate from a durable database change and therefore
 * travel through the outbox.
 *
 * `typing`, `heartbeat.ack`, `ready` and `subscriptions` are excluded: they
 * are ephemeral or connection-scoped, and routing them through Postgres would
 * mean a database write per keystroke.
 */
export const durableEventTypes = [
  'message.created',
  'message.updated',
  'message.deleted',
  'channel.created',
  'channel.updated',
  'channel.deleted',
  'category.created',
  'category.updated',
  'category.deleted',
  'member.joined',
  'member.updated',
  'member.removed',
  'media.updated',
] as const satisfies readonly ServerEventType[];

export type DurableEventType = (typeof durableEventTypes)[number];

export const durableEventTypeSchema = z.enum(durableEventTypes);
