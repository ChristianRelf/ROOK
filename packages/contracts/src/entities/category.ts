import { z } from 'zod';
import { categoryIdSchema, communityIdSchema, userIdSchema } from '../ids.js';
import { categoryNameSchema, isoTimestampSchema, positionSchema } from '../primitives.js';

/**
 * Channel categories.
 *
 * Structure only: a category groups channels in the sidebar and carries no
 * permissions of its own. That is a deliberate narrowing — per-category
 * permission overrides are the single biggest source of "why can't I see this
 * channel" confusion in systems that have them, and adding them later is
 * additive, whereas taking them away is not.
 *
 * A channel with no category sorts above every category, which matches how a
 * server looks before anyone has organised it.
 */

export const channelCategorySchema = z.object({
  id: categoryIdSchema,
  communityId: communityIdSchema,
  name: categoryNameSchema,
  /** Manual ordering within the sidebar; ties break by id. */
  position: positionSchema,
  createdBy: userIdSchema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});

export type ChannelCategory = z.infer<typeof channelCategorySchema>;
