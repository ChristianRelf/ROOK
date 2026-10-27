import {
  type CategoryId,
  type Channel,
  type ChannelCategory,
  type ChannelId,
  type CommunityId,
  type CommunityMember,
  type CommunityMembership,
  type CommunityRole,
  type UserId,
} from '@rook/contracts';
import { can, generateJoinCode } from '@rook/auth';
import { createRepositories, isUniqueViolation, type DatabaseClient } from '@rook/database';
import type { EventPublisher } from './events.js';

/**
 * Communities, membership and channels.
 *
 * Grouped with messaging because they are the same domain: a channel only
 * means anything as a place messages go, and membership is what authorises
 * reading them. Splitting them into a separate package would add a boundary
 * without a seam behind it.
 *
 * Every method that mutates does so in a transaction together with its outbox
 * event, for the same reason sends do.
 */

export type CreateCommunityResult = { readonly community: CommunityMembership };

export type JoinCommunityResult =
  | { readonly ok: true; readonly community: CommunityMembership }
  | { readonly ok: false; readonly reason: 'invalid_join_code' | 'already_a_member' };

export type CreateChannelResult =
  | { readonly ok: true; readonly channel: Channel }
  | {
      readonly ok: false;
      readonly reason: 'community_not_found' | 'forbidden' | 'name_taken' | 'category_not_found';
    };

export type ListChannelsResult =
  | { readonly ok: true; readonly channels: Channel[] }
  | { readonly ok: false; readonly reason: 'community_not_found' };

/**
 * The sidebar's whole structure in one result.
 *
 * Categories and channels are fetched together because neither renders alone:
 * channels without their categories have nowhere to go, and two round trips
 * mean a frame where the grouping is visibly wrong.
 */
export type ChannelTreeResult =
  | {
      readonly ok: true;
      readonly categories: ChannelCategory[];
      readonly channels: Channel[];
    }
  | { readonly ok: false; readonly reason: 'community_not_found' };

export type ListMembersResult =
  | {
      readonly ok: true;
      readonly members: CommunityMember[];
      readonly nextCursor: string | null;
      readonly hasMore: boolean;
      readonly totalCount: number;
    }
  | { readonly ok: false; readonly reason: 'community_not_found' };

export interface CommunityService {
  create: (options: { name: string; ownerId: UserId }) => Promise<CreateCommunityResult>;
  join: (options: { joinCode: string; userId: UserId }) => Promise<JoinCommunityResult>;
  listForUser: (userId: UserId) => Promise<CommunityMembership[]>;
  get: (communityId: CommunityId, viewerId: UserId) => Promise<CommunityMembership | undefined>;
  createChannel: (options: {
    communityId: CommunityId;
    name: string;
    topic: string | undefined;
    categoryId: CategoryId | undefined;
    createdBy: UserId;
  }) => Promise<CreateChannelResult>;
  listChannels: (communityId: CommunityId, viewerId: UserId) => Promise<ListChannelsResult>;
  /** Categories and channels together, which is what the sidebar renders. */
  channelTree: (communityId: CommunityId, viewerId: UserId) => Promise<ChannelTreeResult>;
  listMembers: (options: {
    communityId: CommunityId;
    viewerId: UserId;
    cursor: string | undefined;
    limit: number;
  }) => Promise<ListMembersResult>;
  /** Channel ids a user may subscribe to, used by the realtime gateway. */
  listSubscribableChannelIds: (userId: UserId) => Promise<ChannelId[]>;
}

/** Attempts before giving up on a join-code collision. */
const JOIN_CODE_ATTEMPTS = 5;

export function createCommunityService(options: {
  readonly db: DatabaseClient;
  readonly events: EventPublisher;
}): CommunityService {
  const { db, events } = options;

  return {
    async create({ name, ownerId }) {
      // The code is low-entropy by design (it is meant to be read aloud), so
      // collisions are possible. Retry on the unique violation rather than
      // pre-checking, which would be a race.
      for (let attempt = 1; attempt <= JOIN_CODE_ATTEMPTS; attempt += 1) {
        try {
          const community = await db.transaction('communities.create', async (tx) => {
            const repos = createRepositories(tx);
            return repos.communities.create({
              name,
              ownerId,
              joinCode: generateJoinCode(),
            });
          });

          return { community };
        } catch (error) {
          if (
            isUniqueViolation(error, 'communities_join_code_key') &&
            attempt < JOIN_CODE_ATTEMPTS
          ) {
            continue;
          }
          throw error;
        }
      }

      throw new Error(`Could not allocate a unique join code after ${JOIN_CODE_ATTEMPTS} attempts`);
    },

    async join({ joinCode, userId }) {
      return db.transaction('communities.join', async (tx) => {
        const repos = createRepositories(tx);

        const result = await repos.communities.joinByCode(joinCode.trim(), userId);
        if (!result.ok) {
          return { ok: false, reason: result.reason };
        }

        const member = await repos.users.findPublicById(userId);
        if (member !== undefined) {
          await events.memberJoined(tx, {
            communityId: result.community.id,
            member,
          });
        }

        await repos.audit.append(tx, {
          communityId: result.community.id,
          actorId: userId,
          actorLabel: member?.displayName ?? 'New member',
          action: 'member.joined',
          targetType: 'member',
          targetId: userId,
          targetLabel: member?.displayName ?? null,
          // Distinguishes the permanent code from an invite link, which is the
          // difference an admin reviewing the log cares about.
          metadata: { via: 'join_code' },
        });

        return { ok: true, community: result.community };
      });
    },

    listForUser(userId) {
      return createRepositories(db).communities.listForUser(userId);
    },

    get(communityId, viewerId) {
      return createRepositories(db).communities.findById(communityId, viewerId);
    },

    async createChannel({ communityId, name, topic, categoryId, createdBy }) {
      const repos = createRepositories(db);

      const membership = await repos.communities.findMembership(communityId, createdBy);
      if (membership === undefined) {
        // Same response as a missing community: a non-member must not be able
        // to probe for which community ids exist.
        return { ok: false, reason: 'community_not_found' };
      }

      if (!can({ role: membership.role }, 'channel:create')) {
        return { ok: false, reason: 'forbidden' };
      }

      return db.transaction('channels.create', async (tx) => {
        const txRepos = createRepositories(tx);

        const created = await txRepos.channels.create({
          communityId,
          name,
          topic,
          categoryId,
          createdBy,
        });

        if (!created.ok) {
          return { ok: false, reason: created.reason };
        }

        // Logged here rather than only in the administration service, because
        // creating a channel is a member-level action that still changes the
        // community's structure — the log would have a hole in it otherwise.
        const creator = await txRepos.users.findPublicById(createdBy);
        await txRepos.audit.append(tx, {
          communityId,
          actorId: createdBy,
          actorLabel: creator?.displayName ?? 'Unknown member',
          action: 'channel.created',
          targetType: 'channel',
          targetId: created.channel.id,
          targetLabel: created.channel.name,
        });

        await events.channelCreated(tx, created.channel, createdBy);
        return { ok: true, channel: created.channel };
      });
    },

    async listChannels(communityId, viewerId) {
      const repos = createRepositories(db);

      const membership = await repos.communities.findMembership(communityId, viewerId);
      if (membership === undefined) {
        return { ok: false, reason: 'community_not_found' };
      }

      const channels = await repos.channels.listForCommunity(communityId);
      return { ok: true, channels };
    },

    async listMembers({ communityId, viewerId, cursor, limit }) {
      const repos = createRepositories(db);

      const membership = await repos.communities.findMembership(communityId, viewerId);
      if (membership === undefined) {
        return { ok: false, reason: 'community_not_found' };
      }

      const page = await repos.communities.listMembers(communityId, { cursor, limit });
      return {
        ok: true,
        members: page.members,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        totalCount: page.totalCount,
      };
    },

    async channelTree(communityId, viewerId) {
      const repos = createRepositories(db);

      const membership = await repos.communities.findMembership(communityId, viewerId);
      if (membership === undefined) {
        return { ok: false, reason: 'community_not_found' };
      }

      // Two queries rather than one join: a join would repeat every category
      // row once per channel in it, and the client needs the empty categories
      // too — an outer join that produced them would need null-channel rows
      // filtered back out.
      const [categories, channels] = await Promise.all([
        repos.categories.listForCommunity(communityId),
        repos.channels.listForCommunity(communityId),
      ]);

      return { ok: true, categories, channels };
    },

    async listSubscribableChannelIds(userId) {
      // A single joined query, not a loop over communities: this runs on the
      // gateway's connect path, where an N+1 would scale with how many
      // communities a user has joined.
      const channels = await createRepositories(db).channels.listAccessibleForUser(userId);
      return channels.map((channel) => channel.id);
    },
  };
}

/** Re-exported so callers can reason about roles without importing contracts. */
export type { CommunityRole };
