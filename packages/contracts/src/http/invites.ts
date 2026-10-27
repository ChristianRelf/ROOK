import { z } from 'zod';
import { communityInviteSchema, invitePreviewSchema } from '../entities/invite.js';
import { communityMembershipSchema } from '../entities/community.js';
import { inviteCodeSchema } from '../primitives.js';

/** Request and response contracts for `/v1/communities/:communityId/invites`. */

/**
 * Expiry is expressed as a duration, not an absolute instant.
 *
 * A client sending `expiresAt` would be asserting what time it is, and a
 * device with a skewed clock would create an invite that is already expired or
 * lasts a week longer than intended. The server adds the duration to its own
 * clock, which is the only one that matters for the expiry check.
 */
export const inviteDurationSchema = z.enum(['30m', '6h', '12h', '1d', '7d', '30d', 'never']);

export type InviteDuration = z.infer<typeof inviteDurationSchema>;

/** Seconds per duration option; `never` has no expiry. */
export const inviteDurationSeconds: Readonly<Record<InviteDuration, number | null>> = {
  '30m': 30 * 60,
  '6h': 6 * 60 * 60,
  '12h': 12 * 60 * 60,
  '1d': 24 * 60 * 60,
  '7d': 7 * 24 * 60 * 60,
  '30d': 30 * 24 * 60 * 60,
  never: null,
};

export const createInviteRequestSchema = z.object({
  /** Defaults to seven days, matching the common case of inviting a person. */
  expiresIn: inviteDurationSchema.default('7d'),
  /** Omit for unlimited uses. */
  maxUses: z.number().int().min(1).max(1000).optional(),
});

export type CreateInviteRequest = z.infer<typeof createInviteRequestSchema>;

export const inviteResponseSchema = z.object({
  invite: communityInviteSchema,
});

export type InviteResponse = z.infer<typeof inviteResponseSchema>;

export const inviteListResponseSchema = z.object({
  invites: z.array(communityInviteSchema),
});

export type InviteListResponse = z.infer<typeof inviteListResponseSchema>;

/**
 * Looking up a code before accepting it.
 *
 * Deliberately readable by someone who is not a member — that is the whole
 * point of an invite — so the response carries only what a join prompt needs.
 * It is also why this endpoint is rate limited harder than the rest: it is the
 * one place where an unauthenticated-ish caller can probe for valid codes.
 */
export const invitePreviewResponseSchema = z.object({
  invite: invitePreviewSchema,
});

export type InvitePreviewResponse = z.infer<typeof invitePreviewResponseSchema>;

export const acceptInviteRequestSchema = z.object({
  code: inviteCodeSchema,
});

export type AcceptInviteRequest = z.infer<typeof acceptInviteRequestSchema>;

export const acceptInviteResponseSchema = z.object({
  community: communityMembershipSchema,
});

export type AcceptInviteResponse = z.infer<typeof acceptInviteResponseSchema>;
