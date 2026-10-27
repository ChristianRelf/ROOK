import {
  PROTOCOL_VERSION,
  type CategoryId,
  type Channel,
  type ChannelCategory,
  type ChannelId,
  type CommunityId,
  type CommunityRole,
  type MediaAsset,
  type Message,
  type MessageId,
  type PublicUser,
  type ServerEvent,
  type UserId,
} from '@rook/contracts';
import type { OutboxRepository, Queryable } from '@rook/database';

/**
 * Builds the client-facing events and writes them to the outbox.
 *
 * Every method takes a transaction handle, because an event must be written in
 * the same transaction as the change it describes. That is the whole guarantee
 * of the outbox pattern: the event and the row commit together, so a crash can
 * never leave a committed change that nobody was told about, nor announce a
 * change that was rolled back.
 *
 * The audience is resolved here, once, by the service that knows what changed.
 * Gateways then fan out without needing to re-derive who may see an event.
 */

export interface EventPublisher {
  messageCreated: (tx: Queryable, message: Message, originUserId: UserId) => Promise<void>;
  messageUpdated: (tx: Queryable, message: Message, originUserId: UserId) => Promise<void>;
  messageDeleted: (
    tx: Queryable,
    options: {
      channelId: ChannelId;
      messageId: MessageId;
      deletedAt: string;
      originUserId: UserId;
    },
  ) => Promise<void>;
  channelCreated: (tx: Queryable, channel: Channel, originUserId: UserId) => Promise<void>;
  channelUpdated: (tx: Queryable, channel: Channel, originUserId: UserId) => Promise<void>;
  channelDeleted: (
    tx: Queryable,
    options: { communityId: CommunityId; channelId: ChannelId; originUserId: UserId },
  ) => Promise<void>;
  categoryCreated: (
    tx: Queryable,
    category: ChannelCategory,
    originUserId: UserId,
  ) => Promise<void>;
  categoryUpdated: (
    tx: Queryable,
    category: ChannelCategory,
    originUserId: UserId,
  ) => Promise<void>;
  categoryDeleted: (
    tx: Queryable,
    options: { communityId: CommunityId; categoryId: CategoryId; originUserId: UserId },
  ) => Promise<void>;
  memberUpdated: (
    tx: Queryable,
    options: {
      communityId: CommunityId;
      member: PublicUser;
      role: CommunityRole;
      originUserId: UserId;
    },
  ) => Promise<void>;
  memberRemoved: (
    tx: Queryable,
    options: { communityId: CommunityId; userId: UserId; originUserId: UserId | undefined },
  ) => Promise<void>;
  memberJoined: (
    tx: Queryable,
    options: { communityId: CommunityId; member: PublicUser },
  ) => Promise<void>;
  /** Addressed to the owner's devices: nobody else is waiting on it. */
  mediaUpdated: (tx: Queryable, asset: MediaAsset) => Promise<void>;
}

/** Shared envelope fields. `ts` is when the event was built, for diagnostics. */
function envelope(): { v: typeof PROTOCOL_VERSION; ts: string } {
  return { v: PROTOCOL_VERSION, ts: new Date().toISOString() };
}

export function createEventPublisher(outbox: OutboxRepository): EventPublisher {
  return {
    async messageCreated(tx, message, originUserId) {
      const payload: ServerEvent = {
        ...envelope(),
        type: 'message.created',
        channelId: message.channelId,
        message,
      };

      await outbox.enqueue(tx, {
        type: 'message.created',
        // Channel scope: only people watching this channel need it.
        audience: { scope: 'channel', channelId: message.channelId },
        payload,
        originUserId,
      });
    },

    async messageUpdated(tx, message, originUserId) {
      const payload: ServerEvent = {
        ...envelope(),
        type: 'message.updated',
        channelId: message.channelId,
        message,
      };

      await outbox.enqueue(tx, {
        type: 'message.updated',
        audience: { scope: 'channel', channelId: message.channelId },
        payload,
        originUserId,
      });
    },

    async messageDeleted(tx, options) {
      const payload: ServerEvent = {
        ...envelope(),
        type: 'message.deleted',
        channelId: options.channelId,
        messageId: options.messageId,
        deletedAt: options.deletedAt,
      };

      await outbox.enqueue(tx, {
        type: 'message.deleted',
        audience: { scope: 'channel', channelId: options.channelId },
        payload,
        originUserId: options.originUserId,
      });
    },

    async channelCreated(tx, channel, originUserId) {
      const payload: ServerEvent = {
        ...envelope(),
        type: 'channel.created',
        communityId: channel.communityId,
        channel,
      };

      await outbox.enqueue(tx, {
        type: 'channel.created',
        // Community scope: a new channel must reach members who are not
        // subscribed to it yet — they cannot be, it did not exist.
        audience: { scope: 'community', communityId: channel.communityId },
        payload,
        originUserId,
      });
    },

    async channelUpdated(tx, channel, originUserId) {
      const payload: ServerEvent = {
        ...envelope(),
        type: 'channel.updated',
        communityId: channel.communityId,
        channel,
      };

      await outbox.enqueue(tx, {
        type: 'channel.updated',
        audience: { scope: 'community', communityId: channel.communityId },
        payload,
        originUserId,
      });
    },

    async channelDeleted(tx, options) {
      const payload: ServerEvent = {
        ...envelope(),
        type: 'channel.deleted',
        communityId: options.communityId,
        channelId: options.channelId,
      };

      await outbox.enqueue(tx, {
        type: 'channel.deleted',
        // Community scope, not channel scope. A channel-scoped event would be
        // published to a Redis channel that every client is about to stop
        // listening to, and members who were not viewing it would never learn
        // it is gone.
        audience: { scope: 'community', communityId: options.communityId },
        payload,
        // Not suppressed for the deleter: their own sidebar has to lose the
        // row too, and unlike an optimistic send there is nothing on screen
        // that would flicker.
        originUserId: undefined,
      });
    },

    async categoryCreated(tx, category, originUserId) {
      const payload: ServerEvent = {
        ...envelope(),
        type: 'category.created',
        communityId: category.communityId,
        category,
      };

      await outbox.enqueue(tx, {
        type: 'category.created',
        audience: { scope: 'community', communityId: category.communityId },
        payload,
        originUserId,
      });
    },

    async categoryUpdated(tx, category, originUserId) {
      const payload: ServerEvent = {
        ...envelope(),
        type: 'category.updated',
        communityId: category.communityId,
        category,
      };

      await outbox.enqueue(tx, {
        type: 'category.updated',
        audience: { scope: 'community', communityId: category.communityId },
        payload,
        originUserId,
      });
    },

    async categoryDeleted(tx, options) {
      const payload: ServerEvent = {
        ...envelope(),
        type: 'category.deleted',
        communityId: options.communityId,
        categoryId: options.categoryId,
      };

      await outbox.enqueue(tx, {
        type: 'category.deleted',
        audience: { scope: 'community', communityId: options.communityId },
        payload,
        originUserId: undefined,
      });
    },

    async memberUpdated(tx, options) {
      const payload: ServerEvent = {
        ...envelope(),
        type: 'member.updated',
        communityId: options.communityId,
        member: options.member,
        role: options.role,
      };

      await outbox.enqueue(tx, {
        type: 'member.updated',
        audience: { scope: 'community', communityId: options.communityId },
        payload,
        // Delivered to the actor as well. The member list shows roles, so the
        // admin who made the change needs the same refresh everyone else gets.
        originUserId: undefined,
      });
    },

    async memberRemoved(tx, options) {
      const payload: ServerEvent = {
        ...envelope(),
        type: 'member.removed',
        communityId: options.communityId,
        userId: options.userId,
      };

      await outbox.enqueue(tx, {
        type: 'member.removed',
        audience: { scope: 'community', communityId: options.communityId },
        payload,
        originUserId: undefined,
      });
    },

    async memberJoined(tx, options) {
      const payload: ServerEvent = {
        ...envelope(),
        type: 'member.joined',
        communityId: options.communityId,
        member: options.member,
      };

      await outbox.enqueue(tx, {
        type: 'member.joined',
        audience: { scope: 'community', communityId: options.communityId },
        payload,
        // Not suppressed for the joiner: they want confirmation they are in.
        originUserId: undefined,
      });
    },

    async mediaUpdated(tx, asset) {
      const payload: ServerEvent = {
        ...envelope(),
        type: 'media.updated',
        asset,
      };

      await outbox.enqueue(tx, {
        type: 'media.updated',
        // User scope: processing results go to the uploader's own devices.
        audience: { scope: 'user', userId: asset.ownerId },
        payload,
        // Delivered to the owner's other devices *and* the one that uploaded,
        // since the uploading client is waiting for the thumbnail.
        originUserId: undefined,
      });
    },
  };
}
