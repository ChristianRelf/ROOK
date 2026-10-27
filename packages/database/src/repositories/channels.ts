import type { Channel, ChannelId, CommunityId, UserId } from '@rook/contracts';
import { raw, sql } from '../sql.js';
import type { Queryable } from '../pool.js';
import { newChannelId } from '../ids.js';
import { isUniqueViolation } from '../errors.js';
import { columns, toChannel, type ChannelRow } from '../internal/rows.js';

/**
 * Channel persistence.
 *
 * `findAccessible` is the one method worth reading closely. It resolves the
 * channel and verifies the caller's membership in a single query, returning
 * the community id and role alongside it.
 *
 * Doing both at once is deliberate. The alternative — load the channel, then
 * check membership — is two round trips on the hottest path in the API, and it
 * invites the bug where one call site forgets the second step and quietly
 * serves a channel to a non-member.
 */

export interface CreateChannelInput {
  readonly communityId: CommunityId;
  readonly name: string;
  readonly topic?: string | undefined;
  readonly createdBy: UserId;
}

export type CreateChannelResult =
  | { readonly ok: true; readonly channel: Channel }
  | { readonly ok: false; readonly reason: 'name_taken' };

/** A channel plus the authorisation context resolved with it. */
export interface AccessibleChannel {
  readonly channel: Channel;
  readonly communityId: CommunityId;
  readonly role: string;
}

export interface ChannelRepository {
  create: (input: CreateChannelInput) => Promise<CreateChannelResult>;
  listForCommunity: (communityId: CommunityId) => Promise<Channel[]>;
  /** Returns undefined when the channel does not exist *or* the user is not a member. */
  findAccessible: (channelId: ChannelId, userId: UserId) => Promise<AccessibleChannel | undefined>;
  findById: (channelId: ChannelId) => Promise<Channel | undefined>;
  /**
   * Every channel the user may access, across all their communities, in one
   * query.
   *
   * Exists so the realtime gateway can validate a subscription request without
   * a query per community — the obvious loop over "my communities" then
   * "channels in each" is an N+1 on the gateway's connect path, which is the
   * worst place for one.
   */
  listAccessibleForUser: (userId: UserId) => Promise<Channel[]>;
}

export function createChannelRepository(db: Queryable): ChannelRepository {
  return {
    async create(input) {
      const id = newChannelId();

      try {
        const result = await db.query<ChannelRow>(
          sql`
            insert into channels as ch (id, community_id, name, topic, position, created_by)
            values (
              ${id},
              ${input.communityId},
              ${input.name},
              ${input.topic ?? null},
              -- Append to the end of the sidebar. Computed in SQL so two
              -- concurrent creates cannot both read the same max position.
              coalesce(
                (select max(c2.position) + 1 from channels c2 where c2.community_id = ${input.communityId}),
                0
              ),
              ${input.createdBy}
            )
            returning ${raw(columns.channel)}
          `,
          'channels.create',
        );

        const row = result.rows[0];
        if (row === undefined) {
          throw new Error('insert into channels returned no row');
        }
        return { ok: true, channel: toChannel(row) };
      } catch (error) {
        if (isUniqueViolation(error, 'channels_community_name_key')) {
          return { ok: false, reason: 'name_taken' };
        }
        throw error;
      }
    },

    async listForCommunity(communityId) {
      const result = await db.query<ChannelRow>(
        sql`
          select ${raw(columns.channel)}
          from channels ch
          where ch.community_id = ${communityId}
          order by ch.position asc, ch.id asc
        `,
        'channels.listForCommunity',
      );

      return result.rows.map(toChannel);
    },

    async findAccessible(channelId, userId) {
      // The join to community_members *is* the authorisation check: no row
      // comes back unless the caller is a member.
      const result = await db.query<ChannelRow & { role: string }>(
        sql`
          select ${raw(columns.channel)}, cm.role
          from channels ch
          join community_members cm
            on cm.community_id = ch.community_id and cm.user_id = ${userId}
          where ch.id = ${channelId}
        `,
        'channels.findAccessible',
      );

      const row = result.rows[0];
      if (row === undefined) return undefined;

      const channel = toChannel(row);
      return { channel, communityId: channel.communityId, role: row.role };
    },

    async findById(channelId) {
      const result = await db.query<ChannelRow>(
        sql`select ${raw(columns.channel)} from channels ch where ch.id = ${channelId}`,
        'channels.findById',
      );

      const row = result.rows[0];
      return row === undefined ? undefined : toChannel(row);
    },

    async listAccessibleForUser(userId) {
      // The membership join is again the authorisation check: a channel only
      // appears if the user is a member of its community.
      const result = await db.query<ChannelRow>(
        sql`
          select ${raw(columns.channel)}
          from channels ch
          join community_members cm
            on cm.community_id = ch.community_id and cm.user_id = ${userId}
          order by ch.community_id asc, ch.position asc, ch.id asc
        `,
        'channels.listAccessibleForUser',
      );

      return result.rows.map(toChannel);
    },
  };
}
