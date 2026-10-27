import {
  type ChannelId,
  type CommunityRole,
  type MediaAssetId,
  type Message,
  type MessageId,
  type PaginationDirection,
  type UserId,
} from '@rook/contracts';
import { canDeleteMessage, canEditMessage } from '@rook/auth';
import {
  createRepositories,
  decodeOptionalCursor,
  InvalidCursorError,
  type DatabaseClient,
  type MessagePage,
} from '@rook/database';
import type { EventPublisher } from './events.js';

/**
 * Message domain logic.
 *
 * This is where the ordering guarantee the spec asks for actually lives:
 * **persist, then publish — in one transaction.** A send does three things
 * atomically:
 *
 *   1. insert the message (or find the existing one for a repeated
 *      idempotency key),
 *   2. attach its media,
 *   3. write the `message.created` event to the outbox.
 *
 * If any step fails the whole thing rolls back, so there is never an event for
 * a message that does not exist, nor a message nobody was told about. The relay
 * publishes from the outbox only after the commit.
 *
 * The service knows nothing about HTTP. It returns discriminated results and
 * lets the transport decide status codes, which is what makes these flows
 * testable without a server.
 */

export type SendFailure =
  | 'channel_not_found'
  | 'not_a_member'
  | 'forbidden'
  | 'attachment_not_found'
  | 'attachment_not_ready';

export type SendResult =
  | { readonly ok: true; readonly message: Message; readonly created: boolean }
  | { readonly ok: false; readonly reason: SendFailure };

export type EditResult =
  | { readonly ok: true; readonly message: Message }
  | { readonly ok: false; readonly reason: 'message_not_found' | 'forbidden' | 'not_a_member' };

export type DeleteResult =
  | { readonly ok: true; readonly messageId: MessageId; readonly deletedAt: string }
  | { readonly ok: false; readonly reason: 'message_not_found' | 'forbidden' | 'not_a_member' };

export type HistoryResult =
  | { readonly ok: true; readonly page: MessagePage }
  | {
      readonly ok: false;
      readonly reason: 'channel_not_found' | 'not_a_member' | 'invalid_cursor';
    };

export interface SendMessageCommand {
  readonly channelId: ChannelId;
  readonly authorId: UserId;
  readonly content: string | undefined;
  readonly attachmentIds: readonly MediaAssetId[];
  readonly idempotencyKey: string;
}

export interface MessageService {
  send: (command: SendMessageCommand) => Promise<SendResult>;
  edit: (options: {
    messageId: MessageId;
    viewerId: UserId;
    content: string;
  }) => Promise<EditResult>;
  remove: (options: { messageId: MessageId; viewerId: UserId }) => Promise<DeleteResult>;
  history: (options: {
    channelId: ChannelId;
    viewerId: UserId;
    cursor: string | undefined;
    direction: PaginationDirection;
    limit: number;
  }) => Promise<HistoryResult>;
}

export function createMessageService(options: {
  readonly db: DatabaseClient;
  readonly events: EventPublisher;
}): MessageService {
  const { db, events } = options;

  return {
    async send(command) {
      // Authorisation is resolved before the transaction opens, so the
      // transaction stays short — it holds no locks while we check membership.
      const access = await createRepositories(db).channels.findAccessible(
        command.channelId,
        command.authorId,
      );

      if (access === undefined) {
        // Deliberately indistinguishable from a non-existent channel: telling
        // a non-member that a channel exists is itself a disclosure.
        return { ok: false, reason: 'channel_not_found' };
      }

      const role = access.role as CommunityRole;
      if (role !== 'owner' && role !== 'admin' && role !== 'member') {
        return { ok: false, reason: 'forbidden' };
      }

      // Attachments must belong to the sender and be fully processed. Without
      // the ownership check, a client could attach someone else's asset by id.
      if (command.attachmentIds.length > 0) {
        const repos = createRepositories(db);

        for (const assetId of command.attachmentIds) {
          const asset = await repos.media.findOwnedById(assetId, command.authorId);
          if (asset === undefined) {
            return { ok: false, reason: 'attachment_not_found' };
          }
          if (asset.status !== 'ready') {
            return { ok: false, reason: 'attachment_not_ready' };
          }
        }
      }

      return db.transaction('messages.send', async (tx) => {
        const repos = createRepositories(tx);

        const result = await repos.messages.send({
          channelId: command.channelId,
          authorId: command.authorId,
          content: command.content ?? null,
          attachmentIds: command.attachmentIds,
          idempotencyKey: command.idempotencyKey,
        });

        // Only publish for a genuinely new message. A retried send with the
        // same idempotency key returns the original row, and re-publishing
        // would deliver the same message to every client a second time.
        if (result.created) {
          await events.messageCreated(tx, result.message, command.authorId);
        }

        return { ok: true, message: result.message, created: result.created };
      });
    },

    async edit({ messageId, viewerId, content }) {
      const repos = createRepositories(db);

      const existing = await repos.messages.findById(messageId);
      if (existing === undefined) {
        return { ok: false, reason: 'message_not_found' };
      }

      const access = await repos.channels.findAccessible(existing.channelId, viewerId);
      if (access === undefined) {
        return { ok: false, reason: 'message_not_found' };
      }

      // A tombstone is reported as missing rather than forbidden: it is gone,
      // and "you do not have permission" would be a misleading thing to tell
      // the author of a message they themselves deleted.
      if (existing.deletedAt !== null) {
        return { ok: false, reason: 'message_not_found' };
      }

      const allowed = canEditMessage(
        { role: access.role as CommunityRole },
        {
          authorId: existing.author.id,
          viewerId,
          isDeleted: existing.deletedAt !== null,
        },
      );

      if (!allowed) {
        return { ok: false, reason: 'forbidden' };
      }

      return db.transaction('messages.edit', async (tx) => {
        const txRepos = createRepositories(tx);
        const updated = await txRepos.messages.edit(messageId, content);

        if (updated === undefined) {
          // Deleted between the check and the update.
          return { ok: false, reason: 'message_not_found' };
        }

        await events.messageUpdated(tx, updated, viewerId);
        return { ok: true, message: updated };
      });
    },

    async remove({ messageId, viewerId }) {
      const repos = createRepositories(db);

      const existing = await repos.messages.findById(messageId);
      if (existing === undefined) {
        return { ok: false, reason: 'message_not_found' };
      }

      const access = await repos.channels.findAccessible(existing.channelId, viewerId);
      if (access === undefined) {
        return { ok: false, reason: 'message_not_found' };
      }

      // Same reasoning as edit: deleting an already-deleted message is a
      // no-op on something that no longer exists.
      if (existing.deletedAt !== null) {
        return { ok: false, reason: 'message_not_found' };
      }

      const allowed = canDeleteMessage(
        { role: access.role as CommunityRole },
        {
          authorId: existing.author.id,
          viewerId,
          isDeleted: existing.deletedAt !== null,
        },
      );

      if (!allowed) {
        return { ok: false, reason: 'forbidden' };
      }

      return db.transaction('messages.delete', async (tx) => {
        const txRepos = createRepositories(tx);
        const deleted = await txRepos.messages.softDelete(messageId);

        if (deleted === undefined) {
          return { ok: false, reason: 'message_not_found' };
        }

        const deletedAt = deleted.deletedAt.toISOString();
        await events.messageDeleted(tx, {
          channelId: existing.channelId,
          messageId,
          deletedAt,
          originUserId: viewerId,
        });

        return { ok: true, messageId, deletedAt };
      });
    },

    async history({ channelId, viewerId, cursor, direction, limit }) {
      const repos = createRepositories(db);

      const access = await repos.channels.findAccessible(channelId, viewerId);
      if (access === undefined) {
        return { ok: false, reason: 'channel_not_found' };
      }

      let cursorId: string | undefined;
      try {
        cursorId = decodeOptionalCursor(cursor);
      } catch (error) {
        if (error instanceof InvalidCursorError) {
          return { ok: false, reason: 'invalid_cursor' };
        }
        throw error;
      }

      const page = await repos.messages.listPage(channelId, { cursorId, direction, limit });
      return { ok: true, page };
    },
  };
}
