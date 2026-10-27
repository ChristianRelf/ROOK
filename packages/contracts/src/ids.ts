import { z } from 'zod';

/**
 * Branded identifier types.
 *
 * Every id in Rook is a UUID string, which means the compiler would otherwise
 * happily accept `getChannel(userId)`. Branding costs nothing at runtime — the
 * values are still plain strings on the wire and in Postgres — but it makes
 * that class of mix-up a compile error.
 *
 * Ids are generated as UUIDv7 so they sort by creation time, which is what
 * makes them usable as pagination cursors and as a future partition key. The
 * schemas below validate UUID shape without pinning the version, since the
 * version is an implementation detail that may change.
 */

declare const brandSymbol: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brandSymbol]: B };

export type UserId = Brand<string, 'UserId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type CommunityId = Brand<string, 'CommunityId'>;
export type ChannelId = Brand<string, 'ChannelId'>;
export type MessageId = Brand<string, 'MessageId'>;
export type MediaAssetId = Brand<string, 'MediaAssetId'>;
export type EventId = Brand<string, 'EventId'>;

/** Builds a branded UUID schema with an error message naming the field. */
const brandedUuid = <B extends string>(label: string) =>
  z.uuid({ error: `${label} must be a UUID` }).transform((value) => value as Brand<string, B>);

export const userIdSchema = brandedUuid<'UserId'>('userId');
export const sessionIdSchema = brandedUuid<'SessionId'>('sessionId');
export const communityIdSchema = brandedUuid<'CommunityId'>('communityId');
export const channelIdSchema = brandedUuid<'ChannelId'>('channelId');
export const messageIdSchema = brandedUuid<'MessageId'>('messageId');
export const mediaAssetIdSchema = brandedUuid<'MediaAssetId'>('mediaAssetId');
export const eventIdSchema = brandedUuid<'EventId'>('eventId');

/**
 * Casts a plain string to a branded id without validation.
 *
 * Only for values already known to be ids — rows read back from Postgres,
 * or ids this process just generated. Anything arriving from a client must go
 * through the schema instead.
 */
export const asUserId = (value: string): UserId => value as UserId;
export const asSessionId = (value: string): SessionId => value as SessionId;
export const asCommunityId = (value: string): CommunityId => value as CommunityId;
export const asChannelId = (value: string): ChannelId => value as ChannelId;
export const asMessageId = (value: string): MessageId => value as MessageId;
export const asMediaAssetId = (value: string): MediaAssetId => value as MediaAssetId;
export const asEventId = (value: string): EventId => value as EventId;
