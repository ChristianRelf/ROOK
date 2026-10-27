import { z } from 'zod';
import { channelIdSchema, communityIdSchema, messageIdSchema } from '../ids.js';
import { isoTimestampSchema } from '../primitives.js';

/**
 * Unread state.
 *
 * Counts are *derived* from a stored read position, never stored themselves.
 * The stored value is "the last message this user has seen in this channel";
 * everything the sidebar renders is computed from that boundary on read.
 *
 * That is the difference between a badge that is occasionally wrong and one
 * that cannot be. A stored counter has to be incremented by every write path
 * and decremented by every read path, and the first path that forgets leaves a
 * channel permanently showing "3" — the single most common bug in this feature.
 *
 * Counts are capped server-side (see `limits.unreadBadgeMax`) so a channel
 * with 40,000 unread messages costs the same to summarise as one with four.
 */

export const channelUnreadSchema = z.object({
  channelId: channelIdSchema,
  /**
   * Unread messages, capped. `hasMoreThanCount` says the real number is
   * higher, which is what lets the badge render "99+" honestly.
   */
  unreadCount: z.number().int().nonnegative(),
  hasMoreThanCount: z.boolean(),
  /**
   * Unread messages that mention the viewer, directly or via `@everyone`.
   *
   * Tracked separately because it drives a different affordance: an unread
   * channel is bolded, a channel that mentions you gets a red count. Collapsing
   * the two makes a busy server unusable, since everything is always unread.
   */
  mentionCount: z.number().int().nonnegative(),
  /** Null when the user has never opened the channel. */
  lastReadMessageId: messageIdSchema.nullable(),
  muted: z.boolean(),
});

export type ChannelUnread = z.infer<typeof channelUnreadSchema>;

/**
 * Unread state for every channel the viewer can see, in one response.
 *
 * One request rather than one per channel: a client with 200 channels must not
 * open 200 connections to draw its sidebar, and the counts have to be
 * consistent with each other for the community-level totals to add up.
 */
export const unreadSummarySchema = z.object({
  channels: z.array(channelUnreadSchema),
  /** Per-community rollups, so the rail does not re-derive them. */
  communities: z.array(
    z.object({
      communityId: communityIdSchema,
      /** True when any unmuted channel has unread messages. */
      hasUnread: z.boolean(),
      /** Mentions across the community's unmuted channels. */
      mentionCount: z.number().int().nonnegative(),
    }),
  ),
  /** When the server computed this, for diagnosing a stale sidebar. */
  computedAt: isoTimestampSchema,
});

export type UnreadSummary = z.infer<typeof unreadSummarySchema>;
