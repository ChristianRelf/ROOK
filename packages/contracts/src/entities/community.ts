import { z } from 'zod';
import { communityIdSchema, mediaAssetIdSchema, userIdSchema } from '../ids.js';
import { communityNameSchema, isoTimestampSchema } from '../primitives.js';
import { publicUserSchema } from './user.js';

/**
 * Communities and membership.
 *
 * Roles are a deliberately small fixed set for this release: `owner`, `admin`,
 * `member`. A general permission-bit system is explicitly out of scope, but
 * every capability check goes through a single resolver (see `@rook/auth`), so
 * replacing the enum with granular permissions later touches one module rather
 * than every route.
 */

export const communityRoleSchema = z.enum(['owner', 'admin', 'member']);
export type CommunityRole = z.infer<typeof communityRoleSchema>;

/** Ordered weakest to strongest, for comparisons like "at least admin". */
export const communityRoleRank: Readonly<Record<CommunityRole, number>> = {
  member: 0,
  admin: 1,
  owner: 2,
};

export const communitySchema = z.object({
  id: communityIdSchema,
  name: communityNameSchema,
  /**
   * Short human-readable code used to join without an invite system, e.g.
   * `bright-harbour-41`. Invites are future work; this keeps the join flow
   * real without pretending to be an access-control feature.
   */
  joinCode: z.string().min(4).max(64),
  iconAssetId: mediaAssetIdSchema.nullable(),
  ownerId: userIdSchema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});

export type Community = z.infer<typeof communitySchema>;

/** A community as returned to a member, with their own role resolved. */
export const communityMembershipSchema = communitySchema.extend({
  role: communityRoleSchema,
  joinedAt: isoTimestampSchema,
  memberCount: z.number().int().nonnegative(),
});

export type CommunityMembership = z.infer<typeof communityMembershipSchema>;

export const communityMemberSchema = z.object({
  user: publicUserSchema,
  role: communityRoleSchema,
  joinedAt: isoTimestampSchema,
});

export type CommunityMember = z.infer<typeof communityMemberSchema>;
