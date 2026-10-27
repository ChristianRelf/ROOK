import {
  inviteDurationSeconds,
  limits,
  type AssignableRole,
  type AuditAction,
  type AuditLogEntry,
  type AuditTargetType,
  type CategoryId,
  type Channel,
  type ChannelCategory,
  type ChannelId,
  type CommunityId,
  type CommunityInvite,
  type CommunityMember,
  type CommunityMembership,
  type CommunityRole,
  type InviteDuration,
  type InviteId,
  type InvitePreview,
  type UserId,
} from '@rook/contracts';
import { can, canAssignRole, canManageMember, generateInviteCode } from '@rook/auth';
import {
  createRepositories,
  decodeOptionalCursor,
  InvalidCursorError,
  type ChannelPlacement,
  type DatabaseClient,
  type Queryable,
} from '@rook/database';
import type { EventPublisher } from './events.js';

/**
 * Community administration: categories, channel structure, roles, invites and
 * the audit log.
 *
 * Split from `CommunityService` because the two have different shapes. That
 * one answers "what can this member see"; this one is a set of privileged
 * mutations, and every single one of them shares the same three-step pattern:
 *
 *   1. resolve the actor's membership and check the capability,
 *   2. perform the change and write the audit entry **in one transaction**,
 *   3. publish the realtime event from inside that same transaction.
 *
 * Step 2 is the reason this is a service and not a set of route handlers. An
 * audit log written outside the transaction can record a change that rolled
 * back, or miss one that committed — and either makes the log worthless as a
 * record. Keeping the pattern in one file means there is one place to check
 * that no mutation escapes it.
 *
 * Every method returns a discriminated result rather than throwing. The
 * transport maps those to status codes, which is what lets these flows be
 * tested without an HTTP server.
 */

// --- Result types ----------------------------------------------------------

/** Shared by every operation that first has to resolve the actor's rights. */
export type AuthorizationFailure = 'community_not_found' | 'forbidden';

export type AdminResult<Value, Failure extends string = never> =
  | ({ readonly ok: true } & Value)
  | { readonly ok: false; readonly reason: AuthorizationFailure | Failure };

export type CategoryResult = AdminResult<
  { category: ChannelCategory },
  'name_taken' | 'limit_reached'
>;
export type CategoryMutationResult = AdminResult<
  { category: ChannelCategory },
  'name_taken' | 'not_found'
>;
export type CategoryDeleteResult = AdminResult<{ categoryId: CategoryId }, 'not_found'>;
export type ChannelMutationResult = AdminResult<
  { channel: Channel },
  'not_found' | 'name_taken' | 'category_not_found'
>;
export type ChannelDeleteResult = AdminResult<
  { channelId: ChannelId },
  'not_found' | 'last_channel'
>;
/**
 * A reorder has nothing to return but success.
 *
 * Written out rather than built from `AdminResult`, whose value parameter is
 * intersected with `{ ok: true }` — an empty-object type there resolves to
 * something no concrete value satisfies.
 */
export type ReorderResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: AuthorizationFailure };
export type MemberRoleResult = AdminResult<{ member: CommunityMember }, 'member_not_found'>;
export type MemberRemoveResult = AdminResult<{ removedUserId: UserId }, 'member_not_found'>;
export type InviteResult = AdminResult<{ invite: CommunityInvite }, 'limit_reached'>;
export type InviteListResult = AdminResult<{ invites: CommunityInvite[] }>;
export type InviteRevokeResult = AdminResult<{ invite: CommunityInvite }, 'not_found'>;
export type AuditListResult = AdminResult<
  { entries: AuditLogEntry[]; nextCursor: string | null; hasMore: boolean },
  'invalid_cursor'
>;

export type InvitePreviewResult =
  | { readonly ok: true; readonly invite: InvitePreview }
  | { readonly ok: false; readonly reason: 'invalid_invite' };

export type AcceptInviteResult =
  | { readonly ok: true; readonly community: CommunityMembership; readonly joined: boolean }
  | {
      readonly ok: false;
      readonly reason: 'invalid_invite' | 'invite_expired' | 'invite_exhausted' | 'invite_revoked';
    };

export interface AdministrationService {
  // Categories
  createCategory: (options: {
    communityId: CommunityId;
    name: string;
    actorId: UserId;
  }) => Promise<CategoryResult>;
  updateCategory: (options: {
    communityId: CommunityId;
    categoryId: CategoryId;
    name?: string | undefined;
    position?: number | undefined;
    actorId: UserId;
  }) => Promise<CategoryMutationResult>;
  deleteCategory: (options: {
    communityId: CommunityId;
    categoryId: CategoryId;
    actorId: UserId;
  }) => Promise<CategoryDeleteResult>;
  reorderCategories: (options: {
    communityId: CommunityId;
    categoryIds: readonly CategoryId[];
    actorId: UserId;
  }) => Promise<ReorderResult>;

  // Channels
  updateChannel: (options: {
    communityId: CommunityId;
    channelId: ChannelId;
    name?: string | undefined;
    topic?: string | null | undefined;
    categoryId?: CategoryId | null | undefined;
    position?: number | undefined;
    actorId: UserId;
  }) => Promise<ChannelMutationResult>;
  deleteChannel: (options: {
    communityId: CommunityId;
    channelId: ChannelId;
    actorId: UserId;
  }) => Promise<ChannelDeleteResult>;
  reorderChannels: (options: {
    communityId: CommunityId;
    placements: readonly ChannelPlacement[];
    actorId: UserId;
  }) => Promise<ReorderResult>;

  // Roles and membership
  setMemberRole: (options: {
    communityId: CommunityId;
    targetUserId: UserId;
    role: AssignableRole;
    actorId: UserId;
  }) => Promise<MemberRoleResult>;
  removeMember: (options: {
    communityId: CommunityId;
    targetUserId: UserId;
    actorId: UserId;
  }) => Promise<MemberRemoveResult>;

  // Invites
  createInvite: (options: {
    communityId: CommunityId;
    expiresIn: InviteDuration;
    maxUses: number | undefined;
    actorId: UserId;
  }) => Promise<InviteResult>;
  listInvites: (options: {
    communityId: CommunityId;
    actorId: UserId;
  }) => Promise<InviteListResult>;
  revokeInvite: (options: {
    communityId: CommunityId;
    inviteId: InviteId;
    actorId: UserId;
  }) => Promise<InviteRevokeResult>;
  /** Readable without membership: that is what an invite link is for. */
  previewInvite: (code: string) => Promise<InvitePreviewResult>;
  acceptInvite: (options: { code: string; userId: UserId }) => Promise<AcceptInviteResult>;

  // Audit log
  listAuditLog: (options: {
    communityId: CommunityId;
    actorId: UserId;
    cursor: string | undefined;
    limit: number;
    action: AuditAction | undefined;
    filterActorId: string | undefined;
  }) => Promise<AuditListResult>;
}

export function createAdministrationService(options: {
  readonly db: DatabaseClient;
  readonly events: EventPublisher;
}): AdministrationService {
  const { db, events } = options;

  /**
   * Resolves the actor's membership and checks one capability.
   *
   * A non-member gets `community_not_found`, not `forbidden`, and that is
   * deliberate: confirming a community exists to someone who is not in it
   * turns every admin endpoint into a way to enumerate community ids. A member
   * who simply lacks the role does get `forbidden`, because they already know
   * the community exists.
   */
  async function authorize(
    communityId: CommunityId,
    actorId: UserId,
    capability: Parameters<typeof can>[1],
  ): Promise<
    | { ok: true; role: CommunityRole; actorLabel: string }
    | { ok: false; reason: AuthorizationFailure }
  > {
    const repos = createRepositories(db);

    const membership = await repos.communities.findMembership(communityId, actorId);
    if (membership === undefined) {
      return { ok: false, reason: 'community_not_found' };
    }

    if (!can({ role: membership.role }, capability)) {
      return { ok: false, reason: 'forbidden' };
    }

    // The actor's display name is snapshotted into every audit entry, so it is
    // resolved once here rather than per write.
    const actor = await repos.users.findPublicById(actorId);

    return {
      ok: true,
      role: membership.role,
      actorLabel: actor?.displayName ?? 'Unknown member',
    };
  }

  /** Writes one audit entry. Always called inside the mutation's transaction. */
  async function audit(
    tx: Queryable,
    input: {
      communityId: CommunityId;
      actorId: UserId;
      actorLabel: string;
      action: AuditAction;
      targetType: AuditTargetType;
      targetId?: string | null;
      targetLabel?: string | null;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    await createRepositories(tx).audit.append(tx, {
      communityId: input.communityId,
      actorId: input.actorId,
      actorLabel: input.actorLabel,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      targetLabel: input.targetLabel ?? null,
      metadata: input.metadata ?? {},
    });
  }

  return {
    // --- Categories ------------------------------------------------------

    async createCategory({ communityId, name, actorId }) {
      const auth = await authorize(communityId, actorId, 'category:create');
      if (!auth.ok) return auth;

      // Capped before the insert rather than relying on a constraint: the cap
      // exists to keep a sidebar usable, and a clear refusal is better than a
      // database error surfacing as a 500.
      const existing = await createRepositories(db).categories.countForCommunity(communityId);
      if (existing >= limits.categoriesPerCommunity) {
        return { ok: false, reason: 'limit_reached' };
      }

      return db.transaction('categories.create', async (tx) => {
        const repos = createRepositories(tx);

        const created = await repos.categories.create({ communityId, name, createdBy: actorId });
        if (!created.ok) return { ok: false, reason: created.reason };

        await audit(tx, {
          communityId,
          actorId,
          actorLabel: auth.actorLabel,
          action: 'category.created',
          targetType: 'category',
          targetId: created.category.id,
          targetLabel: created.category.name,
        });

        await events.categoryCreated(tx, created.category, actorId);
        return { ok: true, category: created.category };
      });
    },

    async updateCategory({ communityId, categoryId, name, position, actorId }) {
      const auth = await authorize(communityId, actorId, 'category:update');
      if (!auth.ok) return auth;

      // Read first so the audit entry can record what the name changed *from*.
      // "Renamed to General" is much less useful than "Renamed Chat to General"
      // when you are trying to work out what someone did.
      const before = await createRepositories(db).categories.findById(communityId, categoryId);
      if (before === undefined) return { ok: false, reason: 'not_found' };

      return db.transaction('categories.update', async (tx) => {
        const repos = createRepositories(tx);

        const updated = await repos.categories.update(communityId, categoryId, { name, position });
        if (!updated.ok) return { ok: false, reason: updated.reason };

        // Only logged when something a person would care about changed.
        // Reordering produces a position change on every item in the list, and
        // logging each one would bury every meaningful entry.
        if (name !== undefined && name !== before.name) {
          await audit(tx, {
            communityId,
            actorId,
            actorLabel: auth.actorLabel,
            action: 'category.updated',
            targetType: 'category',
            targetId: categoryId,
            targetLabel: updated.category.name,
            metadata: { from: before.name, to: updated.category.name },
          });
        }

        await events.categoryUpdated(tx, updated.category, actorId);
        return { ok: true, category: updated.category };
      });
    },

    async deleteCategory({ communityId, categoryId, actorId }) {
      const auth = await authorize(communityId, actorId, 'category:delete');
      if (!auth.ok) return auth;

      const before = await createRepositories(db).categories.findById(communityId, categoryId);
      if (before === undefined) return { ok: false, reason: 'not_found' };

      return db.transaction('categories.delete', async (tx) => {
        const repos = createRepositories(tx);

        const removed = await repos.categories.remove(communityId, categoryId);
        if (!removed) return { ok: false, reason: 'not_found' };

        await audit(tx, {
          communityId,
          actorId,
          actorLabel: auth.actorLabel,
          action: 'category.deleted',
          targetType: 'category',
          targetId: categoryId,
          targetLabel: before.name,
        });

        await events.categoryDeleted(tx, { communityId, categoryId, originUserId: actorId });
        return { ok: true, categoryId };
      });
    },

    async reorderCategories({ communityId, categoryIds, actorId }) {
      const auth = await authorize(communityId, actorId, 'category:update');
      if (!auth.ok) return auth;

      await db.transaction('categories.reorder', async (tx) => {
        const repos = createRepositories(tx);
        await repos.categories.reorder(communityId, categoryIds);

        // Reordering emits an update for each category rather than its own
        // event type. Clients already refetch the tree on `category.updated`,
        // so a dedicated event would add a case to every client for no
        // behavioural difference.
        for (const category of await repos.categories.listForCommunity(communityId)) {
          await events.categoryUpdated(tx, category, actorId);
        }
      });

      return { ok: true };
    },

    // --- Channels ---------------------------------------------------------

    async updateChannel({ communityId, channelId, name, topic, categoryId, position, actorId }) {
      const auth = await authorize(communityId, actorId, 'channel:update');
      if (!auth.ok) return auth;

      const repos = createRepositories(db);
      const before = await repos.channels.findById(channelId);
      if (before === undefined || before.communityId !== communityId) {
        return { ok: false, reason: 'not_found' };
      }

      return db.transaction('channels.update', async (tx) => {
        const txRepos = createRepositories(tx);

        const updated = await txRepos.channels.update(communityId, channelId, {
          name,
          topic,
          categoryId,
          position,
        });
        if (!updated.ok) return { ok: false, reason: updated.reason };

        const changes: Record<string, unknown> = {};
        if (name !== undefined && name !== before.name) {
          changes['name'] = { from: before.name, to: updated.channel.name };
        }
        if (topic !== undefined && (topic ?? null) !== before.topic) {
          changes['topic'] = { from: before.topic, to: updated.channel.topic };
        }
        if (categoryId !== undefined && (categoryId ?? null) !== before.categoryId) {
          changes['categoryId'] = { from: before.categoryId, to: updated.channel.categoryId };
        }

        // A position-only change is a drag, not an edit worth logging.
        if (Object.keys(changes).length > 0) {
          await audit(tx, {
            communityId,
            actorId,
            actorLabel: auth.actorLabel,
            action: 'channel.updated',
            targetType: 'channel',
            targetId: channelId,
            targetLabel: updated.channel.name,
            metadata: changes,
          });
        }

        await events.channelUpdated(tx, updated.channel, actorId);
        return { ok: true, channel: updated.channel };
      });
    },

    async deleteChannel({ communityId, channelId, actorId }) {
      const auth = await authorize(communityId, actorId, 'channel:delete');
      if (!auth.ok) return auth;

      const repos = createRepositories(db);
      const before = await repos.channels.findById(channelId);
      if (before === undefined || before.communityId !== communityId) {
        return { ok: false, reason: 'not_found' };
      }

      // A community with no channels has no conversation and no obvious way
      // back to one except the create dialog, which is a state worth refusing
      // rather than recovering from.
      const channelCount = await repos.channels.countForCommunity(communityId);
      if (channelCount <= 1) {
        return { ok: false, reason: 'last_channel' };
      }

      return db.transaction('channels.delete', async (tx) => {
        const txRepos = createRepositories(tx);

        const removed = await txRepos.channels.remove(communityId, channelId);
        if (!removed) return { ok: false, reason: 'not_found' };

        await audit(tx, {
          communityId,
          actorId,
          actorLabel: auth.actorLabel,
          action: 'channel.deleted',
          targetType: 'channel',
          targetId: channelId,
          targetLabel: before.name,
        });

        await events.channelDeleted(tx, { communityId, channelId, originUserId: actorId });
        return { ok: true, channelId };
      });
    },

    async reorderChannels({ communityId, placements, actorId }) {
      const auth = await authorize(communityId, actorId, 'channel:update');
      if (!auth.ok) return auth;

      await db.transaction('channels.reorder', async (tx) => {
        const repos = createRepositories(tx);
        await repos.channels.reorder(communityId, placements);

        for (const channel of await repos.channels.listForCommunity(communityId)) {
          await events.channelUpdated(tx, channel, actorId);
        }
      });

      return { ok: true };
    },

    // --- Roles and membership --------------------------------------------

    async setMemberRole({ communityId, targetUserId, role, actorId }) {
      const auth = await authorize(communityId, actorId, 'member:manage_roles');
      if (!auth.ok) return auth;

      const repos = createRepositories(db);
      const target = await repos.communities.findMember(communityId, targetUserId);
      if (target === undefined) return { ok: false, reason: 'member_not_found' };

      // Two separate checks, and both are needed.
      //
      // `canManageMember` stops an admin acting on a peer or on the owner —
      // without it, any admin could demote every other admin, and the first
      // disagreement between two admins becomes a race to click first.
      //
      // `canAssignRole` stops an actor granting a role at or above their own,
      // which would otherwise let an admin create someone able to act on them.
      if (
        !canManageMember(
          { role: auth.role, userId: actorId },
          { role: target.role, userId: targetUserId },
        )
      ) {
        return { ok: false, reason: 'forbidden' };
      }
      if (!canAssignRole(auth.role, role)) {
        return { ok: false, reason: 'forbidden' };
      }

      if (target.role === role) {
        // Already there. Returned as success with no audit entry: logging a
        // change that did not happen makes the log harder to read, and failing
        // would make an idempotent retry look like an error.
        return { ok: true, member: target };
      }

      return db.transaction('members.setRole', async (tx) => {
        const txRepos = createRepositories(tx);

        const updated = await txRepos.communities.setMemberRole(communityId, targetUserId, role);
        if (updated === undefined) return { ok: false, reason: 'member_not_found' };

        await audit(tx, {
          communityId,
          actorId,
          actorLabel: auth.actorLabel,
          action: 'member.role_changed',
          targetType: 'member',
          targetId: targetUserId,
          targetLabel: updated.user.displayName,
          metadata: { from: target.role, to: role },
        });

        await events.memberUpdated(tx, {
          communityId,
          member: updated.user,
          role: updated.role,
          originUserId: actorId,
        });

        return { ok: true, member: updated };
      });
    },

    async removeMember({ communityId, targetUserId, actorId }) {
      const auth = await authorize(communityId, actorId, 'member:kick');
      if (!auth.ok) return auth;

      const repos = createRepositories(db);
      const target = await repos.communities.findMember(communityId, targetUserId);
      if (target === undefined) return { ok: false, reason: 'member_not_found' };

      if (
        !canManageMember(
          { role: auth.role, userId: actorId },
          { role: target.role, userId: targetUserId },
        )
      ) {
        return { ok: false, reason: 'forbidden' };
      }

      return db.transaction('members.remove', async (tx) => {
        const txRepos = createRepositories(tx);

        const removed = await txRepos.communities.removeMember(communityId, targetUserId);
        if (!removed) return { ok: false, reason: 'member_not_found' };

        await audit(tx, {
          communityId,
          actorId,
          actorLabel: auth.actorLabel,
          action: 'member.removed',
          targetType: 'member',
          targetId: targetUserId,
          targetLabel: target.user.displayName,
          metadata: { role: target.role },
        });

        await events.memberRemoved(tx, {
          communityId,
          userId: targetUserId,
          originUserId: actorId,
        });

        return { ok: true, removedUserId: targetUserId };
      });
    },

    // --- Invites ----------------------------------------------------------

    async createInvite({ communityId, expiresIn, maxUses, actorId }) {
      const auth = await authorize(communityId, actorId, 'invite:create');
      if (!auth.ok) return auth;

      const active = await createRepositories(db).invites.countActive(communityId);
      if (active >= limits.invitesPerCommunity) {
        return { ok: false, reason: 'limit_reached' };
      }

      // The duration is resolved against *this server's* clock, not the
      // client's. A device with a skewed clock would otherwise create an
      // invite that is already expired or lasts far longer than intended.
      const seconds = inviteDurationSeconds[expiresIn];
      const expiresAt = seconds === null ? null : new Date(Date.now() + seconds * 1000);

      return db.transaction('invites.create', async (tx) => {
        const repos = createRepositories(tx);

        const invite = await repos.invites.create({
          communityId,
          code: generateInviteCode(),
          createdBy: actorId,
          expiresAt,
          maxUses: maxUses ?? null,
        });

        await audit(tx, {
          communityId,
          actorId,
          actorLabel: auth.actorLabel,
          action: 'invite.created',
          targetType: 'invite',
          targetId: invite.id,
          // The code itself is deliberately not logged. An audit log readable
          // by every admin should not double as a list of live invite codes.
          targetLabel: null,
          metadata: { expiresAt: invite.expiresAt, maxUses: invite.maxUses },
        });

        return { ok: true, invite };
      });
    },

    async listInvites({ communityId, actorId }) {
      // Readable by anyone who may create one, so a member can see and revoke
      // their own links. The route filters the list to the caller's own invites
      // when they are not an admin.
      const auth = await authorize(communityId, actorId, 'invite:create');
      if (!auth.ok) return auth;

      const invites = await createRepositories(db).invites.listForCommunity(communityId);

      const visible = can({ role: auth.role }, 'invite:revoke')
        ? invites
        : invites.filter((invite) => invite.createdBy.id === actorId);

      return { ok: true, invites: visible };
    },

    async revokeInvite({ communityId, inviteId, actorId }) {
      const repos = createRepositories(db);

      const membership = await repos.communities.findMembership(communityId, actorId);
      if (membership === undefined) return { ok: false, reason: 'community_not_found' };

      const existing = await repos.invites.findById(communityId, inviteId);
      if (existing === undefined) return { ok: false, reason: 'not_found' };

      // Your own invite is always yours to withdraw; anyone else's needs the
      // admin capability. Without the first half, a member could create a link
      // and then have no way to take it back.
      const isOwnInvite = existing.createdBy.id === actorId;
      if (!isOwnInvite && !can({ role: membership.role }, 'invite:revoke')) {
        return { ok: false, reason: 'forbidden' };
      }

      const actor = await repos.users.findPublicById(actorId);

      return db.transaction('invites.revoke', async (tx) => {
        const txRepos = createRepositories(tx);

        const revoked = await txRepos.invites.revoke(communityId, inviteId);
        if (revoked === undefined) return { ok: false, reason: 'not_found' };

        await audit(tx, {
          communityId,
          actorId,
          actorLabel: actor?.displayName ?? 'Unknown member',
          action: 'invite.revoked',
          targetType: 'invite',
          targetId: inviteId,
          targetLabel: null,
          metadata: { createdBy: existing.createdBy.username, uses: existing.uses },
        });

        return { ok: true, invite: revoked };
      });
    },

    async previewInvite(code) {
      const preview = await createRepositories(db).invites.preview(code);
      if (preview === undefined) {
        // One reason for every failure here, unlike `acceptInvite`. This
        // endpoint is reachable with any code, so distinguishing "expired"
        // from "never existed" would turn it into an oracle for which codes
        // are real. Accepting a code you hold can afford to be specific.
        return { ok: false, reason: 'invalid_invite' };
      }

      return {
        ok: true,
        invite: {
          communityId: preview.communityId,
          communityName: preview.communityName,
          memberCount: preview.memberCount,
          inviterId: preview.inviterId,
          inviterDisplayName: preview.inviterDisplayName,
        },
      };
    },

    async acceptInvite({ code, userId }) {
      const repos = createRepositories(db);

      // Checked before consuming a use, so re-opening a link you have already
      // accepted does not burn another use of a limited invite.
      //
      // Resolved with `findCommunityByCode` rather than `preview`, because
      // `preview` only returns *usable* invites. Someone who joined through a
      // one-use link and then opens it again would otherwise fall through to
      // `consume`, which correctly reports the link as exhausted — and tells a
      // member of the community that they cannot get in.
      const invitedCommunityId = await repos.invites.findCommunityByCode(code);
      if (invitedCommunityId !== undefined) {
        const existing = await repos.communities.findById(invitedCommunityId, userId);
        if (existing !== undefined) {
          return { ok: true, community: existing, joined: false };
        }
      }

      // Validate-and-claim in one statement; see `invites.consume`. Two people
      // redeeming the last use of a one-use invite cannot both get in.
      const consumed = await repos.invites.consume(code);
      if (!consumed.ok) {
        switch (consumed.reason) {
          case 'expired':
            return { ok: false, reason: 'invite_expired' };
          case 'exhausted':
            return { ok: false, reason: 'invite_exhausted' };
          case 'revoked':
            return { ok: false, reason: 'invite_revoked' };
          case 'invalid':
            return { ok: false, reason: 'invalid_invite' };
        }
      }

      const { communityId, inviteId } = consumed;

      return db.transaction('invites.accept', async (tx) => {
        const txRepos = createRepositories(tx);

        const joined = await txRepos.communities.joinById(communityId, userId);

        if (!joined.ok) {
          // The only remaining case is a membership created between the check
          // above and here. Reported as success, because it is: the user is in
          // the community they were invited to.
          const existing = await txRepos.communities.findById(communityId, userId);
          if (existing === undefined) {
            throw new Error('invite was consumed but membership could not be resolved');
          }
          return { ok: true, community: existing, joined: false };
        }

        const member = await txRepos.users.findPublicById(userId);
        if (member !== undefined) {
          await events.memberJoined(tx, { communityId, member });
        }

        await txRepos.audit.append(tx, {
          communityId,
          actorId: userId,
          actorLabel: member?.displayName ?? 'New member',
          action: 'member.joined',
          targetType: 'member',
          targetId: userId,
          targetLabel: member?.displayName ?? null,
          // Records which invite admitted them, which is the question the log
          // actually gets asked after someone unwelcome turns up.
          metadata: { via: 'invite', inviteId },
        });

        return { ok: true, community: joined.community, joined: true };
      });
    },

    // --- Audit log --------------------------------------------------------

    async listAuditLog({ communityId, actorId, cursor, limit, action, filterActorId }) {
      const auth = await authorize(communityId, actorId, 'audit_log:view');
      if (!auth.ok) return auth;

      let cursorId: string | undefined;
      try {
        cursorId = decodeOptionalCursor(cursor);
      } catch (error) {
        if (error instanceof InvalidCursorError) {
          return { ok: false, reason: 'invalid_cursor' };
        }
        throw error;
      }

      const page = await createRepositories(db).audit.listPage(communityId, {
        cursorId,
        limit,
        action,
        actorId: filterActorId,
      });

      return {
        ok: true,
        entries: page.entries,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    },
  };
}
