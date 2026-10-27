import { z } from 'zod';
import { channelCategorySchema } from '../entities/category.js';
import { categoryIdSchema } from '../ids.js';
import { categoryNameSchema, positionSchema } from '../primitives.js';

/** Request and response contracts for `/v1/communities/:communityId/categories`. */

export const createCategoryRequestSchema = z.object({
  name: categoryNameSchema,
});

export type CreateCategoryRequest = z.infer<typeof createCategoryRequestSchema>;

/**
 * Both fields optional, at least one required.
 *
 * A PATCH with an empty body is almost always a client bug — it would write an
 * audit entry recording that nothing changed — so it is rejected rather than
 * accepted as a no-op.
 */
export const updateCategoryRequestSchema = z
  .object({
    name: categoryNameSchema.optional(),
    position: positionSchema.optional(),
  })
  .refine((value) => value.name !== undefined || value.position !== undefined, {
    error: 'Provide a name or a position to change.',
  });

export type UpdateCategoryRequest = z.infer<typeof updateCategoryRequestSchema>;

export const categoryResponseSchema = z.object({
  category: channelCategorySchema,
});

export type CategoryResponse = z.infer<typeof categoryResponseSchema>;

export const categoryListResponseSchema = z.object({
  categories: z.array(channelCategorySchema),
});

export type CategoryListResponse = z.infer<typeof categoryListResponseSchema>;

/**
 * Reordering the whole sidebar in one request.
 *
 * One call rather than a PATCH per moved item: a drag that shifts ten channels
 * would otherwise be ten requests racing each other, and the intermediate
 * states are all invalid orderings. The server applies the list as given,
 * inside one transaction, so the sidebar is never half-reordered.
 */
export const reorderCategoriesRequestSchema = z.object({
  categoryIds: z.array(categoryIdSchema).max(100),
});

export type ReorderCategoriesRequest = z.infer<typeof reorderCategoriesRequestSchema>;
