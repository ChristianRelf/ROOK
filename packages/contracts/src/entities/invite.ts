import { z } from 'zod';
import { communityIdSchema, inviteIdSchema, userIdSchema } from '../ids.js';
import { inviteCodeSchema, isoTimestampSchema } from '../primitives.js';
import { publicUserSchema } from './user.js';

/**
 * Invite links.
 *
 * A community's `joinCode` is permanent and cannot be withdrawn, which makes it
 * the wrong tool for inviting one person to one conversation. An invite is the
 * revocable, expiring, optionally use-limited alternative.
 *
 * `uses` is a count rather than a list of who joined: membership already
 * records that, and the audit log records which invite admitted them. Keeping
 * a per-user list here would duplicate both and invite them to disagree.
 */

export const communityInviteSchema = z.object({
  id: inviteIdSchema,
  communityId: communityIdSchema,
  code: inviteCodeSchema,
  /** Resolved so the management list can show who created each invite. */
  createdBy: publicUserSchema,
  /** Null means the invite never expires. */
  expiresAt: isoTimestampSchema.nullable(),
  /** Null means unlimited uses. */
  maxUses: z.number().int().positive().nullable(),
  uses: z.number().int().nonnegative(),
  revokedAt: isoTimestampSchema.nullable(),
  createdAt: isoTimestampSchema,
  /**
   * Resolved server-side rather than left to the client.
   *
   * "Can this still be used" depends on the current time, the use count and
   * the revocation state at once, and a client that computes it from a cached
   * row gets it wrong the moment the row goes stale.
   */
  active: z.boolean(),
});

export type CommunityInvite = z.infer<typeof communityInviteSchema>;

/**
 * What an invite code resolves to before it is accepted.
 *
 * Returned to someone who is not a member yet, so it carries only what a
 * join prompt needs — never the member list, the channel list or the
 * permanent join code.
 */
export const invitePreviewSchema = z.object({
  communityId: communityIdSchema,
  communityName: z.string(),
  memberCount: z.number().int().nonnegative(),
  inviterId: userIdSchema,
  inviterDisplayName: z.string(),
});

export type InvitePreview = z.infer<typeof invitePreviewSchema>;
