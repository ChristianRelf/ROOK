import type { CategoryId, ChannelCategory, CommunityId, UserId } from '@rook/contracts';
import { raw, sql } from '../sql.js';
import type { Queryable } from '../pool.js';
import { newCategoryId } from '../ids.js';
import { isUniqueViolation } from '../errors.js';
import { columns, toChannelCategory, type ChannelCategoryRow } from '../internal/rows.js';

/**
 * Channel category persistence.
 *
 * The only part worth reading closely is `reorder`. Positions are rewritten
 * from the supplied order in a single statement rather than one update per
 * category, because a drag that moves one item changes the position of every
 * item after it — and issuing those as separate statements means every
 * intermediate state is an ordering nobody asked for, visible to any client
 * that reads between them.
 */

export interface CreateCategoryInput {
  readonly communityId: CommunityId;
  readonly name: string;
  readonly createdBy: UserId;
}

export type CreateCategoryResult =
  | { readonly ok: true; readonly category: ChannelCategory }
  | { readonly ok: false; readonly reason: 'name_taken' };

export interface UpdateCategoryInput {
  readonly name?: string | undefined;
  readonly position?: number | undefined;
}

export type UpdateCategoryResult =
  | { readonly ok: true; readonly category: ChannelCategory }
  | { readonly ok: false; readonly reason: 'not_found' | 'name_taken' };

export interface CategoryRepository {
  create: (input: CreateCategoryInput) => Promise<CreateCategoryResult>;
  listForCommunity: (communityId: CommunityId) => Promise<ChannelCategory[]>;
  /** Scoped by community so a category id from elsewhere cannot be edited. */
  findById: (
    communityId: CommunityId,
    categoryId: CategoryId,
  ) => Promise<ChannelCategory | undefined>;
  update: (
    communityId: CommunityId,
    categoryId: CategoryId,
    input: UpdateCategoryInput,
  ) => Promise<UpdateCategoryResult>;
  /** Returns false when the category did not exist in this community. */
  remove: (communityId: CommunityId, categoryId: CategoryId) => Promise<boolean>;
  /** Rewrites positions from the given order, in one statement. */
  reorder: (communityId: CommunityId, categoryIds: readonly CategoryId[]) => Promise<void>;
  countForCommunity: (communityId: CommunityId) => Promise<number>;
}

export function createCategoryRepository(db: Queryable): CategoryRepository {
  async function load(
    communityId: CommunityId,
    categoryId: CategoryId,
  ): Promise<ChannelCategory | undefined> {
    const result = await db.query<ChannelCategoryRow>(
      sql`
        select ${raw(columns.category)}
        from channel_categories cat
        where cat.id = ${categoryId} and cat.community_id = ${communityId}
      `,
      'categories.findById',
    );

    const row = result.rows[0];
    return row === undefined ? undefined : toChannelCategory(row);
  }

  return {
    async create(input) {
      const id = newCategoryId();

      try {
        const result = await db.query<ChannelCategoryRow>(
          sql`
            insert into channel_categories as cat (id, community_id, name, position, created_by)
            values (
              ${id},
              ${input.communityId},
              ${input.name},
              -- Appended at the end. Computed in SQL so two concurrent creates
              -- cannot both read the same max position and collide.
              coalesce(
                (select max(c2.position) + 1
                 from channel_categories c2
                 where c2.community_id = ${input.communityId}),
                0
              ),
              ${input.createdBy}
            )
            returning ${raw(columns.category)}
          `,
          'categories.create',
        );

        const row = result.rows[0];
        if (row === undefined) {
          throw new Error('insert into channel_categories returned no row');
        }
        return { ok: true, category: toChannelCategory(row) };
      } catch (error) {
        if (isUniqueViolation(error, 'channel_categories_community_name_key')) {
          return { ok: false, reason: 'name_taken' };
        }
        throw error;
      }
    },

    async listForCommunity(communityId) {
      const result = await db.query<ChannelCategoryRow>(
        sql`
          select ${raw(columns.category)}
          from channel_categories cat
          where cat.community_id = ${communityId}
          order by cat.position asc, cat.id asc
        `,
        'categories.listForCommunity',
      );

      return result.rows.map(toChannelCategory);
    },

    findById: load,

    async update(communityId, categoryId, input) {
      // `coalesce(param, column)` rather than building the SET list
      // conditionally: one statement, one plan, and no branch where a field is
      // accidentally omitted from both the SQL and the parameter list.
      try {
        const result = await db.query<ChannelCategoryRow>(
          sql`
            update channel_categories as cat
            set name = coalesce(${input.name ?? null}, cat.name),
                position = coalesce(${input.position ?? null}::integer, cat.position),
                updated_at = now()
            where cat.id = ${categoryId} and cat.community_id = ${communityId}
            returning ${raw(columns.category)}
          `,
          'categories.update',
        );

        const row = result.rows[0];
        if (row === undefined) return { ok: false, reason: 'not_found' };
        return { ok: true, category: toChannelCategory(row) };
      } catch (error) {
        if (isUniqueViolation(error, 'channel_categories_community_name_key')) {
          return { ok: false, reason: 'name_taken' };
        }
        throw error;
      }
    },

    async remove(communityId, categoryId) {
      // The channels inside are not deleted: the foreign key is
      // `on delete set null`, so they become uncategorised. Deleting a
      // category must never be a way to delete conversations by accident.
      const result = await db.query(
        sql`
          delete from channel_categories
          where id = ${categoryId} and community_id = ${communityId}
        `,
        'categories.remove',
      );

      return result.rowCount > 0;
    },

    async reorder(communityId, categoryIds) {
      if (categoryIds.length === 0) return;

      // `with ordinality` turns the supplied array into (id, index) pairs, so
      // the whole reordering is one UPDATE ... FROM. The community predicate is
      // still applied, so an id from another community in the list is ignored
      // rather than silently reparented.
      await db.query(
        sql`
          update channel_categories as cat
          set position = ordered.position - 1, updated_at = now()
          from unnest(${[...categoryIds]}::uuid[]) with ordinality as ordered(id, position)
          where cat.id = ordered.id and cat.community_id = ${communityId}
        `,
        'categories.reorder',
      );
    },

    async countForCommunity(communityId) {
      const result = await db.query<{ count: number }>(
        sql`
          select count(*)::int as count
          from channel_categories cat
          where cat.community_id = ${communityId}
        `,
        'categories.countForCommunity',
      );

      return result.rows[0]?.count ?? 0;
    },
  };
}
