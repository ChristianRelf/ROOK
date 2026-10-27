import type { ChannelId, ChannelUnread, CommunityId, MessageId, UserId } from '@rook/contracts';
import { limits } from '@rook/contracts';
import { sql } from '../sql.js';
import type { Queryable } from '../pool.js';

/**
 * Read state and unread counts.
 *
 * The stored value is a *position*, not a count: one row per (user, channel)
 * holding the last message that user has seen. Every number the sidebar renders
 * is derived from that boundary when it is asked for.
 *
 * That choice is the whole design, so it is worth stating why. A stored counter
 * has to be incremented by every write path (send, realtime fan-out, backfill)
 * and decremented by every read path, and the first path that forgets leaves a
 * channel showing "3" for ever with no way to clear it. A derived count cannot
 * disagree with the messages it describes, because it *is* the messages.
 *
 * The cost of deriving it is bounded in two ways:
 *
 *   * Counting stops at `limits.unreadBadgeMax + 1` per channel, via a LATERAL
 *     with its own LIMIT. A channel with 40,000 unread messages therefore costs
 *     the same to summarise as one with four — the query reads 100 rows and
 *     stops. The badge says "99+" rather than a number nobody reads anyway.
 *
 *   * Both counts are resolved for every channel in one statement. The obvious
 *     alternative, a query per channel, is an N+1 on the path that runs on
 *     every launch and every reconnect.
 *
 * A channel with no read-state row is treated as *fully unread*, not fully
 * read. For a channel someone has never opened that is the honest answer, and
 * it is also the safe default: the failure mode is a badge that should not be
 * there, not a missed mention.
 */

/** The boundary used when no read-state row exists, i.e. "everything is unread". */
const UNREAD_FROM_BEGINNING = '00000000-0000-0000-0000-000000000000';

export interface ChannelUnreadRecord extends ChannelUnread {
  readonly communityId: CommunityId;
}

export interface ReadStateRepository {
  /**
   * Unread state for every channel the user can see, in one query.
   *
   * Scoped by membership, so it cannot report on a channel the user has lost
   * access to — a stale badge for a community someone was removed from.
   */
  summarise: (userId: UserId) => Promise<ChannelUnreadRecord[]>;
  /** Upserts the read position. Never moves it backwards. */
  markRead: (options: {
    userId: UserId;
    channelId: ChannelId;
    lastReadMessageId: MessageId;
  }) => Promise<void>;
  setMuted: (options: { userId: UserId; channelId: ChannelId; muted: boolean }) => Promise<void>;
  /** One channel's unread state, for the response to `markRead`. */
  forChannel: (userId: UserId, channelId: ChannelId) => Promise<ChannelUnread | undefined>;
}

interface UnreadRow {
  channel_id: string;
  community_id: string;
  last_read_message_id: string | null;
  muted: boolean;
  unread_count: number;
  mention_count: number;
}

/**
 * The shared body of both unread queries.
 *
 * Written once and parameterised by the channel predicate, so the summary and
 * the single-channel read cannot drift apart — if they counted differently,
 * marking a channel read would make the sidebar disagree with itself.
 */
function unreadQuery(options: {
  readonly userId: UserId;
  readonly channelId?: ChannelId | undefined;
}) {
  const cap = limits.unreadBadgeMax + 1;

  const channelFilter =
    options.channelId === undefined ? sql`` : sql`and ch.id = ${options.channelId}`;

  return sql`
    select ch.id                                    as channel_id,
           ch.community_id                          as community_id,
           rs.last_read_message_id                  as last_read_message_id,
           coalesce(rs.muted, false)                as muted,
           coalesce(unread.count, 0)::int           as unread_count,
           coalesce(mentions.count, 0)::int         as mention_count
    from channels ch
    join community_members cm
      on cm.community_id = ch.community_id and cm.user_id = ${options.userId}
    left join channel_read_state rs
      on rs.channel_id = ch.id and rs.user_id = ${options.userId}

    -- Counting is capped inside the lateral, so cost is bounded by the cap
    -- rather than by how far behind the user is.
    left join lateral (
      select count(*) as count
      from (
        select 1
        from messages m
        where m.channel_id = ch.id
          and m.id > coalesce(rs.last_read_message_id, ${UNREAD_FROM_BEGINNING}::uuid)
          -- Your own messages are never unread to you, and a tombstone is not
          -- something to come back and read.
          and m.author_id <> ${options.userId}
          and m.deleted_at is null
        limit ${cap}
      ) capped
    ) unread on true

    left join lateral (
      select count(*) as count
      from (
        select 1
        from messages m
        where m.channel_id = ch.id
          and m.id > coalesce(rs.last_read_message_id, ${UNREAD_FROM_BEGINNING}::uuid)
          and m.author_id <> ${options.userId}
          and m.deleted_at is null
          and (
            m.mentions_everyone
            or exists (
              select 1 from message_mentions mm
              where mm.message_id = m.id and mm.user_id = ${options.userId}
            )
          )
        limit ${cap}
      ) capped
    ) mentions on true

    where true ${channelFilter}
  `;
}

export function createReadStateRepository(db: Queryable): ReadStateRepository {
  function toUnread(row: UnreadRow): ChannelUnreadRecord {
    const capped = row.unread_count > limits.unreadBadgeMax;

    return {
      channelId: row.channel_id as ChannelId,
      communityId: row.community_id as CommunityId,
      unreadCount: capped ? limits.unreadBadgeMax : row.unread_count,
      hasMoreThanCount: capped,
      // Mentions are capped by the same lateral, but the cap is far above any
      // realistic count, so it is reported as-is rather than as "99+".
      mentionCount: Math.min(row.mention_count, limits.unreadBadgeMax),
      lastReadMessageId:
        row.last_read_message_id === null ? null : (row.last_read_message_id as MessageId),
      muted: row.muted,
    };
  }

  return {
    async summarise(userId) {
      const result = await db.query<UnreadRow>(unreadQuery({ userId }), 'readState.summarise');
      return result.rows.map(toUnread);
    },

    async forChannel(userId, channelId) {
      const result = await db.query<UnreadRow>(
        unreadQuery({ userId, channelId }),
        'readState.forChannel',
      );

      const row = result.rows[0];
      return row === undefined ? undefined : toUnread(row);
    },

    async markRead({ userId, channelId, lastReadMessageId }) {
      // `greatest` is what stops the position moving backwards. Without it, two
      // devices reading the same channel would fight: the one that was scrolled
      // further back would keep resetting the other's position and resurrect
      // messages the user has already read.
      //
      // Ids are UUIDv7, so `greatest` over uuid is chronological order.
      await db.query(
        sql`
          insert into channel_read_state (user_id, channel_id, last_read_message_id, last_read_at)
          values (${userId}, ${channelId}, ${lastReadMessageId}, now())
          on conflict (user_id, channel_id) do update
          set last_read_message_id = greatest(
                channel_read_state.last_read_message_id,
                excluded.last_read_message_id
              ),
              last_read_at = now()
        `,
        'readState.markRead',
      );
    },

    async setMuted({ userId, channelId, muted }) {
      await db.query(
        sql`
          insert into channel_read_state (user_id, channel_id, muted)
          values (${userId}, ${channelId}, ${muted})
          on conflict (user_id, channel_id) do update
          set muted = excluded.muted
        `,
        'readState.setMuted',
      );
    },
  };
}
