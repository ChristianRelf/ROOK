import { v7 as uuidv7 } from 'uuid';
import {
  asChannelId,
  asCommunityId,
  asEventId,
  asMediaAssetId,
  asMessageId,
  asSessionId,
  asUserId,
  type ChannelId,
  type CommunityId,
  type EventId,
  type MediaAssetId,
  type MessageId,
  type SessionId,
  type UserId,
} from '@rook/contracts';

/**
 * Identifier generation.
 *
 * Everything is UUIDv7: 48 bits of Unix milliseconds followed by random bits.
 * Three properties follow from that, and all three are load-bearing here:
 *
 *   1. **Sortable.** Lexicographic byte order equals creation order, so
 *      `order by id desc` on messages is chronological with no separate
 *      timestamp column in the index.
 *
 *   2. **Index-friendly.** Inserts land at the right-hand edge of the B-tree
 *      rather than scattering across it, as UUIDv4 does. That keeps the index
 *      compact and write amplification low — the single biggest reason not to
 *      use v4 for a high-volume message table.
 *
 *   3. **Partition-ready.** The embedded timestamp means a future time-range
 *      partitioning scheme can be derived from the key itself.
 *
 * Ids are generated in the application, not by Postgres, so a message id is
 * known before the insert: it can be logged, returned to an optimistic client,
 * and written into the outbox event in the same transaction.
 */

export const newUserId = (): UserId => asUserId(uuidv7());
export const newSessionId = (): SessionId => asSessionId(uuidv7());
export const newCommunityId = (): CommunityId => asCommunityId(uuidv7());
export const newChannelId = (): ChannelId => asChannelId(uuidv7());
export const newMessageId = (): MessageId => asMessageId(uuidv7());
export const newMediaAssetId = (): MediaAssetId => asMediaAssetId(uuidv7());
export const newEventId = (): EventId => asEventId(uuidv7());

/**
 * Extracts the creation time embedded in a UUIDv7.
 *
 * Useful for diagnostics and for deriving a partition from an id without a
 * database round trip. Returns undefined for any other UUID version, since
 * the bits mean something different there.
 */
export function timestampFromUuidV7(uuid: string): Date | undefined {
  const hex = uuid.replace(/-/gu, '');
  if (hex.length !== 32) return undefined;

  // Version nibble is the 13th hex digit.
  if (hex[12] !== '7') return undefined;

  const milliseconds = Number.parseInt(hex.slice(0, 12), 16);
  if (!Number.isFinite(milliseconds)) return undefined;

  return new Date(milliseconds);
}
