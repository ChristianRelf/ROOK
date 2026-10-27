import { z } from 'zod';
import { cursorSchema, limits, paginationDirectionSchema } from '../primitives.js';

/**
 * Cursor pagination.
 *
 * Offset pagination is not offered anywhere in this API. Two reasons, and both
 * bite at exactly the scale this project is aiming at:
 *
 *   1. `OFFSET 50000` makes Postgres walk and discard 50,000 rows.
 *   2. In a channel receiving messages while you page, offsets shift under
 *      you, so rows are duplicated or skipped between pages.
 *
 * A cursor is a position in a stable ordering, so neither happens. Because
 * message ids are UUIDv7 and sort by creation time, the id is the cursor.
 */

export const paginationQuerySchema = z.object({
  /** Opaque; comes from a previous response's `nextCursor`/`previousCursor`. */
  cursor: cursorSchema.optional(),
  /**
   * `before` walks backwards into history (the common case when scrolling up);
   * `after` walks forwards, used to catch up after a reconnect.
   */
  direction: paginationDirectionSchema.default('before'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(limits.messagePageMax)
    .default(limits.messagePageDefault),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/**
 * A page of results.
 *
 * `hasMore` is computed by fetching one row beyond the limit, which is cheaper
 * and more accurate than a separate `COUNT(*)` over the whole channel.
 */
export const pageSchema = <ItemSchema extends z.ZodType>(item: ItemSchema) =>
  z.object({
    items: z.array(item),
    /** Pass back as `cursor` with `direction=before` to continue backwards. */
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  });

export interface Page<Item> {
  items: Item[];
  nextCursor: string | null;
  hasMore: boolean;
}
