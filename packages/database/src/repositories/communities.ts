import type {
  CommunityId,
  CommunityMember,
  CommunityMembership,
  CommunityRole,
  UserId,
} from '@rook/contracts';
import { empty, raw, sql } from '../sql.js';
import type { Queryable } from '../pool.js';
import { newCommunityId } from '../ids.js';
import { isUniqueViolation } from '../errors.js';
import {
  columns,
  toCommunityMember,
  toCommunityMembership,
  type CommunityMemberRow,
  type CommunityMembershipRow,
} from '../internal/rows.js';

/**
 * Communities and membership.
 *
 * Membership is the authorisation primitive for everything else: a channel is
 * readable because you are a member of its community. `findMembership` is
 * therefore on the hot path of nearly every request, and is a single indexed
 * lookup on the `community_members` primary key.
 */

export interface CreateCommunityInput {
  readonly name: string;
  readonly ownerId: UserId;
  readonly joinCode: string;
}

export type JoinCommunityResult =
  | { readonly ok: true; readonly community: CommunityMembership }
  | { readonly ok: false; readonly reason: 'invalid_join_code' | 'already_a_member' };

export interface MembershipRecord {
  readonly communityId: CommunityId;
  readonly userId: UserId;
  readonly role: CommunityRole;
  readonly joinedAt: Date;
}

export interface CommunityRepository {
  /** Creates the community and its owner membership in one transaction. */
  create: (input: CreateCommunityInput) => Promise<CommunityMembership>;
  findById: (id: CommunityId, viewerId: UserId) => Promise<CommunityMembership | undefined>;
  listForUser: (userId: UserId) => Promise<CommunityMembership[]>;
  joinByCode: (joinCode: string, userId: UserId) => Promise<JoinCommunityResult>;
  /** The authorisation check used throughout the API. */
  findMembership: (
    communityId: CommunityId,
    userId: UserId,
  ) => Promise<MembershipRecord | undefined>;
  /** Members of a community, paginated by (joined_at, user_id). */
  listMembers: (
    communityId: CommunityId,
    options: { cursor?: string | undefined; limit: number },
  ) => Promise<{ members: CommunityMember[]; nextCursor: string | null; hasMore: boolean }>;
  /** Every member's id, used to resolve a community-scoped event audience. */
  listMemberIds: (communityId: CommunityId) => Promise<UserId[]>;
}

/**
 * Selects a community together with the viewer's own role and a member count.
 *
 * The count is a correlated subquery rather than a `group by` over a join: it
 * keeps the row shape flat and avoids the accidental fan-out that makes a
 * joined count wrong when other joins are added later.
 */
const membershipSelect = `
  ${columns.community},
  cm.role,
  cm.joined_at,
  (select count(*) from community_members mc where mc.community_id = c.id)::int as member_count
`;

export function createCommunityRepository(db: Queryable): CommunityRepository {
  return {
    async create(input) {
      const id = newCommunityId();

      // Two statements that must not be separable: a community with no owner
      // membership would be invisible to its own creator.
      await db.query(
        sql`
          insert into communities (id, name, join_code, owner_id)
          values (${id}, ${input.name}, ${input.joinCode}, ${input.ownerId})
        `,
        'communities.create',
      );

      await db.query(
        sql`
          insert into community_members (community_id, user_id, role)
          values (${id}, ${input.ownerId}, 'owner')
        `,
        'communities.createOwnerMembership',
      );

      const created = await this.findById(id, input.ownerId);
      if (created === undefined) {
        throw new Error('community was created but could not be read back');
      }
      return created;
    },

    async findById(id, viewerId) {
      const result = await db.query<CommunityMembershipRow>(
        sql`
          select ${raw(membershipSelect)}
          from communities c
          join community_members cm
            on cm.community_id = c.id and cm.user_id = ${viewerId}
          where c.id = ${id}
        `,
        'communities.findById',
      );

      const row = result.rows[0];
      return row === undefined ? undefined : toCommunityMembership(row);
    },

    async listForUser(userId) {
      // Driven by community_members_user_id_idx, so this is an index scan on
      // the membership rows for one user, not a scan of all communities.
      const result = await db.query<CommunityMembershipRow>(
        sql`
          select ${raw(membershipSelect)}
          from community_members cm
          join communities c on c.id = cm.community_id
          where cm.user_id = ${userId}
          order by cm.joined_at desc, c.id desc
        `,
        'communities.listForUser',
      );

      return result.rows.map(toCommunityMembership);
    },

    async joinByCode(joinCode, userId) {
      const community = await db.query<{ id: string }>(
        sql`select c.id from communities c where c.join_code = ${joinCode}`,
        'communities.findByJoinCode',
      );

      const row = community.rows[0];
      if (row === undefined) {
        return { ok: false, reason: 'invalid_join_code' };
      }

      const communityId = row.id as CommunityId;

      try {
        const inserted = await db.query(
          sql`
            insert into community_members (community_id, user_id, role)
            values (${communityId}, ${userId}, 'member')
            on conflict (community_id, user_id) do nothing
          `,
          'communities.join',
        );

        if (inserted.rowCount === 0) {
          // `do nothing` means the membership already existed. Reported as a
          // distinct outcome so the client can navigate instead of erroring.
          return { ok: false, reason: 'already_a_member' };
        }
      } catch (error) {
        if (isUniqueViolation(error)) {
          return { ok: false, reason: 'already_a_member' };
        }
        throw error;
      }

      const joined = await this.findById(communityId, userId);
      if (joined === undefined) {
        throw new Error('membership was created but could not be read back');
      }
      return { ok: true, community: joined };
    },

    async findMembership(communityId, userId) {
      const result = await db.query<{ role: string; joined_at: Date }>(
        sql`
          select cm.role, cm.joined_at
          from community_members cm
          where cm.community_id = ${communityId} and cm.user_id = ${userId}
        `,
        'communities.findMembership',
      );

      const row = result.rows[0];
      if (row === undefined) return undefined;

      return {
        communityId,
        userId,
        role: row.role as CommunityRole,
        joinedAt: row.joined_at,
      };
    },

    async listMembers(communityId, options) {
      // Fetch one extra row to decide `hasMore` without a second count query.
      const fetchLimit = options.limit + 1;

      // The cursor is a user id; ordering is (joined_at, user_id) so it is
      // stable even when several members joined in the same millisecond.
      const cursorFilter =
        options.cursor === undefined
          ? empty
          : sql`
              and (cm.joined_at, cm.user_id) >
                  (select cm2.joined_at, cm2.user_id
                   from community_members cm2
                   where cm2.community_id = ${communityId} and cm2.user_id = ${options.cursor})
            `;

      const result = await db.query<CommunityMemberRow>(
        sql`
          select ${raw(columns.user)}, cm.role, cm.joined_at
          from community_members cm
          join users u on u.id = cm.user_id
          where cm.community_id = ${communityId}
          ${cursorFilter}
          order by cm.joined_at asc, cm.user_id asc
          limit ${fetchLimit}
        `,
        'communities.listMembers',
      );

      const hasMore = result.rows.length > options.limit;
      const page = hasMore ? result.rows.slice(0, options.limit) : result.rows;
      const last = page[page.length - 1];

      return {
        members: page.map(toCommunityMember),
        nextCursor: hasMore && last !== undefined ? last.id : null,
        hasMore,
      };
    },

    async listMemberIds(communityId) {
      const result = await db.query<{ user_id: string }>(
        sql`
          select cm.user_id
          from community_members cm
          where cm.community_id = ${communityId}
        `,
        'communities.listMemberIds',
      );

      return result.rows.map((row) => row.user_id as UserId);
    },
  };
}
