import { z } from 'zod';
import {
  communityMemberSchema,
  communityMembershipSchema,
  communityRoleSchema,
} from '../entities/community.js';
import { channelSchema } from '../entities/channel.js';
import {
  channelNameSchema,
  channelTopicSchema,
  communityNameSchema,
  limits,
} from '../primitives.js';
import { cursorSchema } from '../primitives.js';

/** Request and response contracts for `/v1/communities/*`. */

export const createCommunityRequestSchema = z.object({
  name: communityNameSchema,
});

export type CreateCommunityRequest = z.infer<typeof createCommunityRequestSchema>;

/**
 * Joining is by code rather than open discovery.
 *
 * There is no public community directory in this release, and that is a
 * deliberate omission rather than an oversight: a listing endpoint would need
 * its own abuse and privacy design, which is out of scope here.
 */
export const joinCommunityRequestSchema = z.object({
  joinCode: z.string().trim().min(4).max(64),
});

export type JoinCommunityRequest = z.infer<typeof joinCommunityRequestSchema>;

export const communityResponseSchema = z.object({
  community: communityMembershipSchema,
});

export type CommunityResponse = z.infer<typeof communityResponseSchema>;

export const communityListResponseSchema = z.object({
  communities: z.array(communityMembershipSchema),
});

export type CommunityListResponse = z.infer<typeof communityListResponseSchema>;

export const createChannelRequestSchema = z.object({
  name: channelNameSchema,
  topic: channelTopicSchema.optional(),
});

export type CreateChannelRequest = z.infer<typeof createChannelRequestSchema>;

export const channelResponseSchema = z.object({
  channel: channelSchema,
});

export type ChannelResponse = z.infer<typeof channelResponseSchema>;

export const channelListResponseSchema = z.object({
  channels: z.array(channelSchema),
});

export type ChannelListResponse = z.infer<typeof channelListResponseSchema>;

/**
 * Member lists are paginated even though communities start small. A sidebar
 * that loads every member of a 50,000-member community is a failure mode worth
 * designing out before it exists, not after.
 */
export const memberListQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(limits.memberPageMax).default(limits.memberPageDefault),
});

export type MemberListQuery = z.infer<typeof memberListQuerySchema>;

export const memberListResponseSchema = z.object({
  members: z.array(communityMemberSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export type MemberListResponse = z.infer<typeof memberListResponseSchema>;

export { communityRoleSchema };
