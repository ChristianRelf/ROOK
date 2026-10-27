import { z } from 'zod';
import { channelIdSchema, mediaAssetIdSchema, messageIdSchema, userIdSchema } from '../ids.js';
import { isoTimestampSchema, messageContentSchema } from '../primitives.js';
import { publicUserSchema } from './user.js';
import { mediaAssetSchema } from './media.js';

/**
 * Messages.
 *
 * The author is embedded rather than referenced by id alone. History loads
 * would otherwise need a second round trip to resolve names, and the obvious
 * fix for that — resolving per message — is exactly the N+1 pattern the
 * repository layer is built to avoid. The join happens once, in SQL.
 *
 * A deleted message is returned as a tombstone, not omitted. Clients that are
 * already displaying it need to be told it is gone, and removing it from the
 * page silently would make cursor pagination inconsistent.
 */

export const messageSchema = z.object({
  id: messageIdSchema,
  channelId: channelIdSchema,
  author: publicUserSchema,
  /** Null for a deleted message; the row is kept as a tombstone. */
  content: messageContentSchema.nullable(),
  attachments: z.array(mediaAssetSchema),
  /**
   * Users this message mentions, resolved at write time.
   *
   * Resolved on the server rather than re-parsed by every client: the set is
   * what drives unread mention counts, so the client's rendering and the
   * server's badge have to agree on it. Re-deriving it from the text in two
   * places is how they stop agreeing.
   */
  mentionedUserIds: z.array(userIdSchema),
  /** `@everyone`, which counts as a mention for every member of the community. */
  mentionsEveryone: z.boolean(),
  createdAt: isoTimestampSchema,
  /** Set only when the author has edited the message. */
  editedAt: isoTimestampSchema.nullable(),
  deletedAt: isoTimestampSchema.nullable(),
});

export type Message = z.infer<typeof messageSchema>;

/**
 * A message as it exists on the client before the server has acknowledged it.
 *
 * Kept in the contracts package because the delivery-state vocabulary has to
 * match what the API and realtime layers actually guarantee. `failed` is a
 * real, surfaced state: the spec requires delivery failures to be visible
 * rather than retried forever in silence.
 */
export const messageDeliveryStateSchema = z.enum(['pending', 'sent', 'failed']);
export type MessageDeliveryState = z.infer<typeof messageDeliveryStateSchema>;

export const pendingMessageSchema = z.object({
  /** The idempotency key, which doubles as the optimistic local id. */
  idempotencyKey: z.uuid(),
  channelId: channelIdSchema,
  authorId: userIdSchema,
  content: messageContentSchema,
  attachmentIds: z.array(mediaAssetIdSchema),
  state: messageDeliveryStateSchema,
  createdAt: isoTimestampSchema,
  /** Safe-to-display reason when `state` is `failed`. */
  failureReason: z.string().max(256).nullable(),
});

export type PendingMessage = z.infer<typeof pendingMessageSchema>;
