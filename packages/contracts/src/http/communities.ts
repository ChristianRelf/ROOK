import { z } from 'zod';
import {
  communityMemberSchema,
  communityMembershipSchema,
  communityRoleSchema,
} from '../entities/community.js';
import { channelSchema } from '../entities/channel.js';
import { channelCategorySchema } from '../entities/category.js';
import {
  channelNameSchema,
  channelTopicSchema,
  communityNameSchema,
  limits,
  positionSchema,
} from '../primitives.js';
import { categoryIdSchema, channelIdSchema, userIdSchema } from '../ids.js';
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
  /** Omit to create the channel uncategorised, at the top of the sidebar. */
  categoryId: categoryIdSchema.optional(),
});

export type CreateChannelRequest = z.infer<typeof createChannelRequestSchema>;

/**
 * Editing a channel.
 *
 * `topic` and `categoryId` are nullable rather than merely optional, and the
 * distinction carries meaning: absent means "leave unchanged", while an
 * explicit `null` means "clear it". Without that, there is no way to remove a
 * topic or move a channel out of its category — the usual trap in a PATCH
 * where every field is optional.
 */
export const updateChannelRequestSchema = z
  .object({
    name: channelNameSchema.optional(),
    topic: channelTopicSchema.nullable().optional(),
    categoryId: categoryIdSchema.nullable().optional(),
    position: positionSchema.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    error: 'Provide at least one field to change.',
  });

export type UpdateChannelRequest = z.infer<typeof updateChannelRequestSchema>;

/**
 * Reordering channels, optionally moving them between categories.
 *
 * One request for the whole operation, for the same reason as category
 * reordering: a drag produces many position changes at once, and applying them
 * one at a time means every intermediate state is a wrong ordering that other
 * clients would briefly see.
 */
export const reorderChannelsRequestSchema = z.object({
  channels: z
    .array(
      z.object({
        channelId: channelIdSchema,
        categoryId: categoryIdSchema.nullable(),
        position: positionSchema,
      }),
    )
    .max(500),
});

export type ReorderChannelsRequest = z.infer<typeof reorderChannelsRequestSchema>;

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
  /**
   * Total members, returned with every page.
   *
   * The sidebar header shows a count, and showing the length of the pages
   * loaded so far would make the number climb as the user scrolls — which
   * reads as a bug rather than as pagination.
   */
  totalCount: z.number().int().nonnegative(),
});

export type MemberListResponse = z.infer<typeof memberListResponseSchema>;

/**
 * Changing a member's role.
 *
 * `owner` is absent from the assignable set deliberately. Transferring
 * ownership is a different operation with different consequences — the current
 * owner stops being the owner — and folding it into a role dropdown is how an
 * admin gives away a community by misclicking. It is out of scope here, and
 * the enum says so rather than a comment on a route.
 */
export const assignableRoleSchema = z.enum(['admin', 'member']);
export type AssignableRole = z.infer<typeof assignableRoleSchema>;

export const updateMemberRoleRequestSchema = z.object({
  role: assignableRoleSchema,
});

export type UpdateMemberRoleRequest = z.infer<typeof updateMemberRoleRequestSchema>;

export const memberResponseSchema = z.object({
  member: communityMemberSchema,
});

export type MemberResponse = z.infer<typeof memberResponseSchema>;

export const removeMemberResponseSchema = z.object({
  removedUserId: userIdSchema,
});

export type RemoveMemberResponse = z.infer<typeof removeMemberResponseSchema>;

/**
 * Everything the sidebar needs for one community, in one request.
 *
 * Channels and categories are fetched together because rendering either alone
 * is impossible: a channel list without its categories has nowhere to put the
 * channels, and two requests mean a frame where the grouping is wrong.
 */
export const channelTreeResponseSchema = z.object({
  categories: z.array(channelCategorySchema),
  channels: z.array(channelSchema),
});

export type ChannelTreeResponse = z.infer<typeof channelTreeResponseSchema>;

export { communityRoleSchema };
