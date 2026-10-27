import type { CategoryId, Channel, ChannelId, CommunityId, UserId } from '@rook/contracts';
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
  readonly categoryId?: CategoryId | undefined;
  readonly createdBy: UserId;
}

export type CreateChannelResult =
  | { readonly ok: true; readonly channel: Channel }
  | { readonly ok: false; readonly reason: 'name_taken' | 'category_not_found' };

/**
 * Fields a channel edit may change.
 *
 * `topic` and `categoryId` distinguish absent from null: absent leaves the
 * value alone, null clears it. Collapsing the two would make it impossible to
 * remove a topic or move a channel out of a category.
 */
export interface UpdateChannelInput {
  readonly name?: string | undefined;
  readonly topic?: string | null | undefined;
  readonly categoryId?: CategoryId | null | undefined;
  readonly position?: number | undefined;
}

export type UpdateChannelResult =
  | { readonly ok: true; readonly channel: Channel }
  | { readonly ok: false; readonly reason: 'not_found' | 'name_taken' | 'category_not_found' };

/** One channel's place in the sidebar, for a bulk reorder. */
export interface ChannelPlacement {
  readonly channelId: ChannelId;
  readonly categoryId: CategoryId | null;
  readonly position: number;
}

/** A channel plus the authorisation context resolved with it. */
export interface AccessibleChannel {
  readonly channel: Channel;
  readonly communityId: CommunityId;
  readonly role: string;
}

export interface ChannelRepository {
  create: (input: CreateChannelInput) => Promise<CreateChannelResult>;
  update: (
    communityId: CommunityId,
    channelId: ChannelId,
    input: UpdateChannelInput,
  ) => Promise<UpdateChannelResult>;
  /** Hard-deletes the channel; messages cascade. Returns false if it was absent. */
  remove: (communityId: CommunityId, channelId: ChannelId) => Promise<boolean>;
  /** Applies a whole sidebar ordering in one statement. */
  reorder: (communityId: CommunityId, placements: readonly ChannelPlacement[]) => Promise<void>;
  listForCommunity: (communityId: CommunityId) => Promise<Channel[]>;
  countForCommunity: (communityId: CommunityId) => Promise<number>;
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

      // Resolved *before* the insert, not after.
      //
      // The insert below resolves the category through a subquery, which
      // yields null for a category belonging to another community. Detecting
      // that afterwards and returning a failure left the channel committed:
      // returning a result from inside a transaction is not an error, so
      // nothing rolled back and the caller was told a channel had not been
      // created that in fact had. Checking first means the failure path writes
      // nothing at all.
      if (input.categoryId !== undefined) {
        const category = await db.query<{ id: string }>(
          sql`
            select cat.id from channel_categories cat
            where cat.id = ${input.categoryId} and cat.community_id = ${input.communityId}
          `,
          'channels.resolveCategory',
        );

        if (category.rows[0] === undefined) {
          return { ok: false, reason: 'category_not_found' };
        }
      }

      try {
        const result = await db.query<ChannelRow>(
          sql`
            insert into channels as ch (
              id, community_id, name, topic, category_id, position, created_by
            )
            values (
              ${id},
              ${input.communityId},
              ${input.name},
              ${input.topic ?? null},
              -- Resolved through a subquery rather than taken on trust: it
              -- constrains the category to this community, so a category id
              -- belonging to another community inserts null instead of
              -- reparenting a channel across communities.
              (select cat.id from channel_categories cat
                where cat.id = ${input.categoryId ?? null}
                  and cat.community_id = ${input.communityId}),
              -- Append to the end of its own group. Computed in SQL so two
              -- concurrent creates cannot both read the same max position.
              coalesce(
                (select max(c2.position) + 1 from channels c2
                  where c2.community_id = ${input.communityId}
                    and c2.category_id is not distinct from ${input.categoryId ?? null}),
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

    async update(communityId, channelId, input) {
      // `moveCategory` separates "set the category to null" from "leave it
      // alone": both arrive as null in the parameter, and only the flag
      // distinguishes them.
      const moveCategory = input.categoryId !== undefined;
      const nextCategoryId = input.categoryId ?? null;
      const changeTopic = input.topic !== undefined;

      // Checked before the update for the same reason as in `create`:
      // detecting it from the result would mean the name and topic changes had
      // already been applied to a row we are about to report as a failure.
      if (nextCategoryId !== null) {
        const category = await db.query<{ id: string }>(
          sql`
            select cat.id from channel_categories cat
            where cat.id = ${nextCategoryId} and cat.community_id = ${communityId}
          `,
          'channels.resolveCategoryForUpdate',
        );

        if (category.rows[0] === undefined) {
          return { ok: false, reason: 'category_not_found' };
        }
      }

      try {
        const result = await db.query<ChannelRow>(
          sql`
            update channels as ch
            set name = coalesce(${input.name ?? null}, ch.name),
                topic = case
                          when ${changeTopic} then ${input.topic ?? null}
                          else ch.topic
                        end,
                category_id = case
                                when ${moveCategory} then (
                                  select cat.id from channel_categories cat
                                  where cat.id = ${nextCategoryId}
                                    and cat.community_id = ${communityId}
                                )
                                else ch.category_id
                              end,
                position = coalesce(${input.position ?? null}::integer, ch.position),
                updated_at = now()
            where ch.id = ${channelId} and ch.community_id = ${communityId}
            returning ${raw(columns.channel)}
          `,
          'channels.update',
        );

        const row = result.rows[0];
        if (row === undefined) return { ok: false, reason: 'not_found' };

        return { ok: true, channel: toChannel(row) };
      } catch (error) {
        if (isUniqueViolation(error, 'channels_community_name_key')) {
          return { ok: false, reason: 'name_taken' };
        }
        throw error;
      }
    },

    async remove(communityId, channelId) {
      // A hard delete, and messages cascade with it. Unlike a message, a
      // channel gets no tombstone: there is nothing useful for a client to
      // display about a channel that is gone, and leaving an empty shell in
      // every sidebar would be worse than removing it.
      const result = await db.query(
        sql`delete from channels where id = ${channelId} and community_id = ${communityId}`,
        'channels.remove',
      );

      return result.rowCount > 0;
    },

    async reorder(communityId, placements) {
      if (placements.length === 0) return;

      // Three parallel arrays rather than a json payload: `unnest` over arrays
      // of known types keeps the reorder one statement with a stable plan and
      // avoids a json parse per row.
      const channelIds = placements.map((placement) => placement.channelId);
      const categoryIds = placements.map((placement) => placement.categoryId);
      const positions = placements.map((placement) => placement.position);

      await db.query(
        sql`
          update channels as ch
          set category_id = (
                select cat.id from channel_categories cat
                where cat.id = ordered.category_id and cat.community_id = ${communityId}
              ),
              position = ordered.position,
              updated_at = now()
          from unnest(
                 ${channelIds}::uuid[],
                 ${categoryIds}::uuid[],
                 ${positions}::integer[]
               ) as ordered(channel_id, category_id, position)
          where ch.id = ordered.channel_id and ch.community_id = ${communityId}
        `,
        'channels.reorder',
      );
    },

    async countForCommunity(communityId) {
      const result = await db.query<{ count: number }>(
        sql`
          select count(*)::int as count from channels ch
          where ch.community_id = ${communityId}
        `,
        'channels.countForCommunity',
      );

      return result.rows[0]?.count ?? 0;
    },

    async listForCommunity(communityId) {
      const result = await db.query<ChannelRow>(
        sql`
          select ${raw(columns.channel)}
          from channels ch
          left join channel_categories cat on cat.id = ch.category_id
          where ch.community_id = ${communityId}
          -- Uncategorised channels first (a null category sorts before any
          -- category position), then by the category's own order, then by the
          -- channel's position within it.
          order by cat.position asc nulls first, cat.id asc nulls first,
                   ch.position asc, ch.id asc
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
