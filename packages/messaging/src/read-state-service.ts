import type { ChannelId, ChannelUnread, MessageId, UnreadSummary, UserId } from '@rook/contracts';
import { createRepositories, type DatabaseClient } from '@rook/database';

/**
 * Read state: unread counts and the per-channel read position.
 *
 * Thin by design. The interesting work — deriving counts from a stored
 * position with a bounded cost — is a single query in the repository, and the
 * only thing this layer adds is the per-community rollup the sidebar rail
 * needs and the membership check that keeps a read position from being written
 * for a channel the caller cannot see.
 *
 * Nothing here is transactional or published as an event. Read state is
 * per-user and private: nobody else is waiting to be told where you have read
 * up to, so paying for an outbox row per channel open would be waste.
 */

export type MarkReadResult =
  | { readonly ok: true; readonly unread: ChannelUnread }
  | { readonly ok: false; readonly reason: 'channel_not_found' };

export interface ReadStateService {
  summary: (userId: UserId) => Promise<UnreadSummary>;
  markRead: (options: {
    userId: UserId;
    channelId: ChannelId;
    lastReadMessageId: MessageId;
  }) => Promise<MarkReadResult>;
  setMuted: (options: {
    userId: UserId;
    channelId: ChannelId;
    muted: boolean;
  }) => Promise<MarkReadResult>;
}

export function createReadStateService(options: { readonly db: DatabaseClient }): ReadStateService {
  const { db } = options;

  return {
    async summary(userId) {
      const repos = createRepositories(db);
      const channels = await repos.readState.summarise(userId);

      // Rolled up here rather than on the client. The rail needs one dot and
      // one count per community, and having each client re-derive them from
      // the channel list means every client has to agree on what "muted"
      // excludes — a rule that belongs in one place.
      const byCommunity = new Map<string, { hasUnread: boolean; mentionCount: number }>();

      for (const channel of channels) {
        const current = byCommunity.get(channel.communityId) ?? {
          hasUnread: false,
          mentionCount: 0,
        };

        // A muted channel keeps its own unread styling but contributes nothing
        // to the community badge. That is the entire point of muting: the
        // channel stops demanding attention from the rail.
        if (!channel.muted) {
          current.hasUnread = current.hasUnread || channel.unreadCount > 0;
          current.mentionCount += channel.mentionCount;
        }

        byCommunity.set(channel.communityId, current);
      }

      return {
        channels: channels.map(({ communityId: _communityId, ...unread }) => unread),
        communities: [...byCommunity.entries()].map(([communityId, rollup]) => ({
          communityId: communityId as UnreadSummary['communities'][number]['communityId'],
          hasUnread: rollup.hasUnread,
          mentionCount: rollup.mentionCount,
        })),
        computedAt: new Date().toISOString(),
      };
    },

    async markRead({ userId, channelId, lastReadMessageId }) {
      const repos = createRepositories(db);

      // The membership join inside `findAccessible` is the authorisation
      // check. Without it, a read position could be written for any channel id
      // — harmless in itself, but it would let someone confirm which channel
      // ids exist by watching which writes succeed.
      const access = await repos.channels.findAccessible(channelId, userId);
      if (access === undefined) return { ok: false, reason: 'channel_not_found' };

      await repos.readState.markRead({ userId, channelId, lastReadMessageId });

      const unread = await repos.readState.forChannel(userId, channelId);
      if (unread === undefined) {
        // The channel was removed between the write and the read-back.
        return { ok: false, reason: 'channel_not_found' };
      }

      return { ok: true, unread };
    },

    async setMuted({ userId, channelId, muted }) {
      const repos = createRepositories(db);

      const access = await repos.channels.findAccessible(channelId, userId);
      if (access === undefined) return { ok: false, reason: 'channel_not_found' };

      await repos.readState.setMuted({ userId, channelId, muted });

      const unread = await repos.readState.forChannel(userId, channelId);
      if (unread === undefined) return { ok: false, reason: 'channel_not_found' };

      return { ok: true, unread };
    },
  };
}
