import {
  asChannelId,
  asCommunityId,
  asMediaAssetId,
  asMessageId,
  asUserId,
  type Channel,
  type Community,
  type CommunityMember,
  type CommunityMembership,
  type CommunityRole,
  type CurrentUser,
  type MediaAsset,
  type MediaStatus,
  type MediaVariant,
  type MediaVariantName,
  type Message,
  type PublicUser,
} from '@rook/contracts';

/**
 * Row shapes as PostgreSQL returns them, and the mappers to contract types.
 *
 * Keeping this in one place means the snake_case-to-camelCase translation and
 * the `Date`-to-ISO-string conversion happen exactly once per entity, rather
 * than being re-derived (and eventually diverging) in each repository method.
 *
 * Mapping is explicit rather than automatic. A spread-and-rename helper would
 * be shorter, but then adding a column to a table would silently add it to the
 * API response â€" including, one day, `password_hash`. Listing every field
 * means exposure is always a deliberate edit.
 */

/**
 * Normalises a Postgres timestamp to an ISO-8601 string.
 *
 * Accepts both a `Date` and a string, because the same column reaches us two
 * different ways. A plain `select` of a `timestamptz` is parsed into a `Date`
 * by the driver -- but a column nested inside `json_agg`/`json_build_object`
 * (how message attachments and media variants are fetched, to avoid an N+1)
 * is serialised by *PostgreSQL* into JSON, and arrives as an ISO string. The
 * mapper has to handle both or attachment loading throws.
 */
const toIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const toIsoOrNull = (value: Date | string | null): string | null =>
  value === null ? null : toIso(value);

export interface UserRow {
  id: string;
  username: string;
  email: string;
  display_name: string;
  avatar_asset_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Row shape for an author joined onto another entity, prefixed to avoid collisions. */
export interface AuthorColumns {
  author_id: string;
  author_username: string;
  author_display_name: string;
  author_avatar_asset_id: string | null;
  author_created_at: Date;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: asUserId(row.id),
    username: row.username,
    displayName: row.display_name,
    avatarAssetId: row.avatar_asset_id === null ? null : asMediaAssetId(row.avatar_asset_id),
    createdAt: toIso(row.created_at),
  };
}

/** Includes the email address, so only ever returned to the user themselves. */
export function toCurrentUser(row: UserRow): CurrentUser {
  return {
    ...toPublicUser(row),
    email: row.email,
    updatedAt: toIso(row.updated_at),
  };
}

export function toAuthor(row: AuthorColumns): PublicUser {
  return {
    id: asUserId(row.author_id),
    username: row.author_username,
    displayName: row.author_display_name,
    avatarAssetId:
      row.author_avatar_asset_id === null ? null : asMediaAssetId(row.author_avatar_asset_id),
    createdAt: toIso(row.author_created_at),
  };
}

export interface CommunityRow {
  id: string;
  name: string;
  join_code: string;
  icon_asset_id: string | null;
  owner_id: string;
  created_at: Date;
  updated_at: Date;
}

export function toCommunity(row: CommunityRow): Community {
  return {
    id: asCommunityId(row.id),
    name: row.name,
    joinCode: row.join_code,
    iconAssetId: row.icon_asset_id === null ? null : asMediaAssetId(row.icon_asset_id),
    ownerId: asUserId(row.owner_id),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export interface CommunityMembershipRow extends CommunityRow {
  role: string;
  joined_at: Date;
  member_count: number;
}

export function toCommunityMembership(row: CommunityMembershipRow): CommunityMembership {
  return {
    ...toCommunity(row),
    role: row.role as CommunityRole,
    joinedAt: toIso(row.joined_at),
    memberCount: row.member_count,
  };
}

export interface CommunityMemberRow extends UserRow {
  role: string;
  joined_at: Date;
}

export function toCommunityMember(row: CommunityMemberRow): CommunityMember {
  return {
    user: toPublicUser(row),
    role: row.role as CommunityRole,
    joinedAt: toIso(row.joined_at),
  };
}

export interface ChannelRow {
  id: string;
  community_id: string;
  kind: string;
  name: string;
  topic: string | null;
  position: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export function toChannel(row: ChannelRow): Channel {
  return {
    id: asChannelId(row.id),
    communityId: asCommunityId(row.community_id),
    // Only 'text' exists today, and the check constraint guarantees it.
    kind: 'text',
    name: row.name,
    topic: row.topic,
    position: row.position,
    createdBy: asUserId(row.created_by),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export interface MediaVariantRow {
  name: string;
  content_type: string;
  width: number;
  height: number;
  byte_size: number;
}

export function toMediaVariant(row: MediaVariantRow): MediaVariant {
  return {
    name: row.name as MediaVariantName,
    contentType: row.content_type,
    width: row.width,
    height: row.height,
    byteSize: row.byte_size,
  };
}

export interface MediaAssetRow {
  id: string;
  owner_id: string;
  status: string;
  content_type: string | null;
  byte_size: number | null;
  width: number | null;
  height: number | null;
  failure_reason: string | null;
  // `Date | string`: a direct select yields a Date, a json_agg'd column an
  // ISO string. See `toIso`.
  created_at: Date | string;
  updated_at: Date | string;
  /** Aggregated in SQL via json_agg, so one query serves an asset and its variants. */
  variants: MediaVariantRow[] | null;
}

export function toMediaAsset(row: MediaAssetRow): MediaAsset {
  return {
    id: asMediaAssetId(row.id),
    ownerId: asUserId(row.owner_id),
    status: row.status as MediaStatus,
    contentType: row.content_type,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height,
    variants: (row.variants ?? []).map(toMediaVariant),
    failureReason: row.failure_reason,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export interface MessageRow extends AuthorColumns {
  id: string;
  channel_id: string;
  content: string | null;
  created_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
  /** Aggregated attachments, avoiding a per-message follow-up query. */
  attachments: MediaAssetRow[] | null;
}

export function toMessage(row: MessageRow): Message {
  return {
    id: asMessageId(row.id),
    channelId: asChannelId(row.channel_id),
    author: toAuthor(row),
    content: row.content,
    attachments: (row.attachments ?? []).map(toMediaAsset),
    createdAt: toIso(row.created_at),
    editedAt: toIsoOrNull(row.edited_at),
    deletedAt: toIsoOrNull(row.deleted_at),
  };
}

/**
 * Column lists, named once and reused.
 *
 * `select *` is avoided everywhere: it would pull `password_hash` into memory
 * on every user read, and it makes the mapper's assumptions invisible. Naming
 * the columns also means adding one to a table cannot change a query's shape
 * without someone editing this file.
 */
export const columns = {
  user: `
    u.id, u.username, u.email, u.display_name, u.avatar_asset_id,
    u.created_at, u.updated_at
  `,
  author: `
    a.id            as author_id,
    a.username      as author_username,
    a.display_name  as author_display_name,
    a.avatar_asset_id as author_avatar_asset_id,
    a.created_at    as author_created_at
  `,
  community: `
    c.id, c.name, c.join_code, c.icon_asset_id, c.owner_id,
    c.created_at, c.updated_at
  `,
  channel: `
    ch.id, ch.community_id, ch.kind, ch.name, ch.topic, ch.position,
    ch.created_by, ch.created_at, ch.updated_at
  `,
  mediaAsset: `
    ma.id, ma.owner_id, ma.status, ma.content_type, ma.byte_size,
    ma.width, ma.height, ma.failure_reason, ma.created_at, ma.updated_at
  `,
} as const;
