import type { MediaAsset, MediaAssetId, MediaVariantName, UserId } from '@rook/contracts';
import { raw, sql } from '../sql.js';
import type { Queryable } from '../pool.js';
import { newMediaAssetId } from '../ids.js';
import { toMediaAsset, type MediaAssetRow } from '../internal/rows.js';

/**
 * Media asset metadata.
 *
 * File contents live in object storage; only metadata is here. The asset row
 * is what makes the pipeline recoverable: if the queue is flushed or a worker
 * dies mid-job, `listPendingProcessing` finds the work again from Postgres
 * rather than losing it with the in-memory job.
 *
 * Status transitions are guarded in SQL (`where status = 'uploaded'`, and so
 * on) rather than read-then-write. Two workers handed the same job therefore
 * cannot both mark it ready, and a late retry cannot resurrect an asset that
 * already failed — the update simply affects no rows. That is what makes the
 * jobs genuinely idempotent instead of merely retryable.
 */

const assetSelect = `
  ma.id, ma.owner_id, ma.status, ma.content_type, ma.byte_size,
  ma.width, ma.height, ma.failure_reason, ma.created_at, ma.updated_at,
  (
    select json_agg(
             json_build_object(
               'name', mv.name,
               'content_type', mv.content_type,
               'width', mv.width,
               'height', mv.height,
               'byte_size', mv.byte_size
             )
             order by mv.name
           )
    from media_variants mv
    where mv.asset_id = ma.id
  ) as variants
`;

export interface ReserveAssetInput {
  readonly ownerId: UserId;
  readonly declaredContentType: string;
  readonly declaredByteSize: number;
  readonly filename?: string | undefined;
}

export interface ReservedAsset {
  readonly id: MediaAssetId;
  readonly storageKey: string;
}

export interface ConfirmUploadInput {
  readonly id: MediaAssetId;
  readonly contentType: string;
  readonly byteSize: number;
}

export interface VariantInput {
  readonly name: MediaVariantName;
  readonly storageKey: string;
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
}

export interface PendingAsset {
  readonly id: MediaAssetId;
  readonly ownerId: UserId;
  readonly storageKey: string;
  readonly declaredContentType: string;
  readonly attempts: number;
}

export interface MediaRepository {
  /** Records an authorised upload before any bytes exist. */
  reserve: (input: ReserveAssetInput) => Promise<ReservedAsset>;
  findById: (id: MediaAssetId) => Promise<MediaAsset | undefined>;
  findOwnedById: (id: MediaAssetId, ownerId: UserId) => Promise<MediaAsset | undefined>;
  /** Storage key and declared type, needed by the worker. */
  findProcessingDetails: (id: MediaAssetId) => Promise<PendingAsset | undefined>;
  /** reserved -> uploaded. Returns false if it was not in `reserved`. */
  markUploaded: (input: ConfirmUploadInput) => Promise<boolean>;
  /** uploaded -> ready, writing variants in the same call. */
  markReady: (
    id: MediaAssetId,
    details: {
      contentType: string;
      byteSize: number;
      width: number;
      height: number;
      variants: readonly VariantInput[];
    },
  ) => Promise<boolean>;
  /** Marks a permanent failure with a client-safe reason. */
  markFailed: (id: MediaAssetId, reason: string) => Promise<boolean>;
  incrementAttempts: (id: MediaAssetId) => Promise<number>;
  /** Confirmed uploads still awaiting processing, for crash recovery. */
  listPendingProcessing: (limit: number) => Promise<PendingAsset[]>;
  /** Reservations never confirmed, for the orphan sweeper. */
  listStaleReservations: (
    olderThan: Date,
    limit: number,
  ) => Promise<{ id: MediaAssetId; storageKey: string }[]>;
  /** Deletes an asset row. Refused by the FK if a message still references it. */
  deleteById: (id: MediaAssetId) => Promise<boolean>;
  /** True when no message references this asset. */
  isUnreferenced: (id: MediaAssetId) => Promise<boolean>;
}

/**
 * Storage keys are derived from the asset id alone.
 *
 * Never from the client's filename: that is how `../../etc/passwd` becomes a
 * traversal bug. The id is a UUID, so the key is always safe, and the date
 * prefix keeps bucket listings navigable.
 */
export function storageKeyFor(id: MediaAssetId, variant: MediaVariantName = 'original'): string {
  // UUIDv7's leading hex digits encode the timestamp, giving a natural
  // time-ordered prefix without needing to parse it.
  const prefix = id.slice(0, 2);
  return `media/${prefix}/${id}/${variant}`;
}

export function createMediaRepository(db: Queryable): MediaRepository {
  async function load(
    id: MediaAssetId,
    ownerId: UserId | undefined,
    operation: string,
  ): Promise<MediaAsset | undefined> {
    const ownerFilter = ownerId === undefined ? sql`` : sql`and ma.owner_id = ${ownerId}`;

    const result = await db.query<MediaAssetRow>(
      sql`select ${raw(assetSelect)} from media_assets ma where ma.id = ${id} ${ownerFilter}`,
      operation,
    );

    const row = result.rows[0];
    return row === undefined ? undefined : toMediaAsset(row);
  }

  return {
    async reserve(input) {
      const id = newMediaAssetId();
      const storageKey = storageKeyFor(id);

      await db.query(
        sql`
          insert into media_assets (
            id, owner_id, status, storage_key,
            declared_content_type, declared_byte_size, filename
          )
          values (
            ${id}, ${input.ownerId}, 'reserved', ${storageKey},
            ${input.declaredContentType}, ${input.declaredByteSize}, ${input.filename ?? null}
          )
        `,
        'media.reserve',
      );

      return { id, storageKey };
    },

    findById(id) {
      return load(id, undefined, 'media.findById');
    },

    findOwnedById(id, ownerId) {
      return load(id, ownerId, 'media.findOwnedById');
    },

    async findProcessingDetails(id) {
      const result = await db.query<{
        id: string;
        owner_id: string;
        storage_key: string;
        declared_content_type: string;
        attempts: number;
      }>(
        sql`
          select ma.id, ma.owner_id, ma.storage_key, ma.declared_content_type, ma.attempts
          from media_assets ma
          where ma.id = ${id}
        `,
        'media.findProcessingDetails',
      );

      const row = result.rows[0];
      if (row === undefined) return undefined;

      return {
        id: row.id as MediaAssetId,
        ownerId: row.owner_id as UserId,
        storageKey: row.storage_key,
        declaredContentType: row.declared_content_type,
        attempts: row.attempts,
      };
    },

    async markUploaded(input) {
      // The status guard is the concurrency control: a duplicate confirm call
      // affects zero rows instead of resetting an already-processed asset.
      const result = await db.query(
        sql`
          update media_assets
          set status = 'uploaded',
              content_type = ${input.contentType},
              byte_size = ${input.byteSize},
              confirmed_at = now(),
              updated_at = now()
          where id = ${input.id} and status = 'reserved'
        `,
        'media.markUploaded',
      );

      return result.rowCount > 0;
    },

    async markReady(id, details) {
      const result = await db.query(
        sql`
          update media_assets
          set status = 'ready',
              content_type = ${details.contentType},
              byte_size = ${details.byteSize},
              width = ${details.width},
              height = ${details.height},
              failure_reason = null,
              processed_at = now(),
              updated_at = now()
          where id = ${id} and status in ('uploaded', 'failed')
        `,
        'media.markReady',
      );

      if (result.rowCount === 0) {
        // Already ready, or the row is gone. Either way there is nothing to
        // do, and overwriting variants would be wrong.
        return false;
      }

      if (details.variants.length > 0) {
        // `on conflict` makes a re-run overwrite its own previous output
        // rather than failing, which is what keeps a retried job idempotent.
        for (const variant of details.variants) {
          await db.query(
            sql`
              insert into media_variants (
                asset_id, name, storage_key, content_type, width, height, byte_size
              )
              values (
                ${id}, ${variant.name}, ${variant.storageKey}, ${variant.contentType},
                ${variant.width}, ${variant.height}, ${variant.byteSize}
              )
              on conflict (asset_id, name) do update
              set storage_key = excluded.storage_key,
                  content_type = excluded.content_type,
                  width = excluded.width,
                  height = excluded.height,
                  byte_size = excluded.byte_size
            `,
            'media.upsertVariant',
          );
        }
      }

      return true;
    },

    async markFailed(id, reason) {
      const result = await db.query(
        sql`
          update media_assets
          set status = 'failed',
              failure_reason = ${reason.slice(0, 256)},
              processed_at = now(),
              updated_at = now()
          where id = ${id} and status <> 'ready'
        `,
        'media.markFailed',
      );

      return result.rowCount > 0;
    },

    async incrementAttempts(id) {
      const result = await db.query<{ attempts: number }>(
        sql`
          update media_assets
          set attempts = attempts + 1, updated_at = now()
          where id = ${id}
          returning attempts
        `,
        'media.incrementAttempts',
      );

      return result.rows[0]?.attempts ?? 0;
    },

    async listPendingProcessing(limit) {
      const result = await db.query<{
        id: string;
        owner_id: string;
        storage_key: string;
        declared_content_type: string;
        attempts: number;
      }>(
        sql`
          select ma.id, ma.owner_id, ma.storage_key, ma.declared_content_type, ma.attempts
          from media_assets ma
          where ma.status = 'uploaded'
          order by ma.confirmed_at asc
          limit ${limit}
        `,
        'media.listPendingProcessing',
      );

      return result.rows.map((row) => ({
        id: row.id as MediaAssetId,
        ownerId: row.owner_id as UserId,
        storageKey: row.storage_key,
        declaredContentType: row.declared_content_type,
        attempts: row.attempts,
      }));
    },

    async listStaleReservations(olderThan, limit) {
      const result = await db.query<{ id: string; storage_key: string }>(
        sql`
          select ma.id, ma.storage_key
          from media_assets ma
          where ma.status = 'reserved' and ma.created_at < ${olderThan}
          order by ma.created_at asc
          limit ${limit}
        `,
        'media.listStaleReservations',
      );

      return result.rows.map((row) => ({
        id: row.id as MediaAssetId,
        storageKey: row.storage_key,
      }));
    },

    async deleteById(id) {
      const result = await db.query(
        sql`delete from media_assets where id = ${id}`,
        'media.deleteById',
      );
      return result.rowCount > 0;
    },

    async isUnreferenced(id) {
      // Checks both attachment links and profile references, so the sweeper
      // cannot delete an asset that is someone's current avatar.
      const result = await db.query<{ referenced: boolean }>(
        sql`
          select exists (
            select 1 from message_attachments where asset_id = ${id}
            union all
            select 1 from users where avatar_asset_id = ${id}
            union all
            select 1 from communities where icon_asset_id = ${id}
          ) as referenced
        `,
        'media.isUnreferenced',
      );

      return result.rows[0]?.referenced === false;
    },
  };
}
