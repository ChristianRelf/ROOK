import { z } from 'zod';
import { categoryIdSchema, channelIdSchema, communityIdSchema, userIdSchema } from '../ids.js';
import {
  channelNameSchema,
  channelTopicSchema,
  isoTimestampSchema,
  positionSchema,
} from '../primitives.js';

/**
 * Channels.
 *
 * Only `text` exists in this release. The kind is modelled as an enum rather
 * than a boolean so adding `voice` later is an additive change that old
 * clients can skip over, instead of a breaking reinterpretation of a flag.
 */

export const channelKindSchema = z.enum(['text']);
export type ChannelKind = z.infer<typeof channelKindSchema>;

export const channelSchema = z.object({
  id: channelIdSchema,
  communityId: communityIdSchema,
  kind: channelKindSchema,
  name: channelNameSchema,
  topic: channelTopicSchema.nullable(),
  /**
   * The category this channel sits under, or null for an uncategorised
   * channel. Uncategorised channels sort above every category, which is what a
   * community looks like before anyone has organised it.
   */
  categoryId: categoryIdSchema.nullable(),
  /** Manual ordering within its category; ties break by id. */
  position: positionSchema,
  createdBy: userIdSchema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});

export type Channel = z.infer<typeof channelSchema>;
