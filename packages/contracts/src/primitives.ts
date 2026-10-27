import { z } from 'zod';

/**
 * Shared scalars, defined once so the client and the server cannot disagree.
 *
 * The desktop app validates with these before sending, and the API validates
 * with the same objects on receipt. Client-side validation is purely a UX
 * affordance; the server never trusts it.
 */

/** Field limits, also enforced by database constraints. Keep the two in sync. */
export const limits = {
  usernameMin: 3,
  usernameMax: 32,
  displayNameMin: 1,
  displayNameMax: 64,
  passwordMin: 12,
  passwordMax: 256,
  communityNameMin: 2,
  communityNameMax: 64,
  channelNameMin: 1,
  channelNameMax: 64,
  channelTopicMax: 512,
  categoryNameMin: 1,
  categoryNameMax: 64,
  inviteCodeMin: 6,
  inviteCodeMax: 32,
  messageContentMax: 4000,
  /** Default page size for message history. */
  messagePageDefault: 50,
  messagePageMax: 100,
  memberPageDefault: 50,
  memberPageMax: 200,
  auditPageDefault: 50,
  auditPageMax: 100,
  /**
   * Distinct user mentions one message may notify.
   *
   * Bounded so a single message cannot write a mention row per member of a
   * large community and badge everyone at once.
   */
  mentionsPerMessage: 20,
  /** Active invites one community may hold at a time. */
  invitesPerCommunity: 50,
  /** Categories one community may hold. */
  categoriesPerCommunity: 50,
  /** Above this, the sidebar shows "99+" rather than a wider badge. */
  unreadBadgeMax: 99,
} as const;

/**
 * Usernames are the stable mention handle, so the character set is narrow:
 * lowercase letters, digits, underscore and period. Mixed case is folded to
 * lowercase so `Ada` and `ada` cannot both exist and be confused for one
 * another; the display name carries presentation.
 */
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(limits.usernameMin, `must be at least ${limits.usernameMin} characters`)
  .max(limits.usernameMax, `must be at most ${limits.usernameMax} characters`)
  .regex(/^[a-z0-9._]+$/u, 'may contain only lowercase letters, digits, underscores and periods')
  .refine((value) => !value.startsWith('.') && !value.endsWith('.'), {
    error: 'may not start or end with a period',
  })
  .refine((value) => !value.includes('..'), {
    error: 'may not contain consecutive periods',
  });

/** Free-form presentation name. Permissive, but not blank or padded. */
export const displayNameSchema = z
  .string()
  .trim()
  .min(limits.displayNameMin, 'must not be empty')
  .max(limits.displayNameMax, `must be at most ${limits.displayNameMax} characters`)
  // Control characters would let a name break terminal output and log lines.
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), {
    error: 'must not contain control characters',
  });

/**
 * Password policy: length only.
 *
 * A 12-character minimum with no composition rules is deliberate. Mandatory
 * symbol-and-digit rules push people toward predictable substitutions, while
 * length is what actually resists guessing. The maximum exists so a very long
 * input cannot be used to make Argon2 hashing expensive.
 */
export const passwordSchema = z
  .string()
  .min(limits.passwordMin, `must be at least ${limits.passwordMin} characters`)
  .max(limits.passwordMax, `must be at most ${limits.passwordMax} characters`);

export const communityNameSchema = z
  .string()
  .trim()
  .min(limits.communityNameMin)
  .max(limits.communityNameMax);

/**
 * Channel names follow the familiar `#general` convention: lowercase, with
 * hyphens instead of spaces. Normalising here means two members cannot create
 * `General` and `general` and wonder why messages are split.
 */
export const channelNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(limits.channelNameMin)
  .max(limits.channelNameMax)
  .regex(/^[a-z0-9-]+$/u, 'may contain only lowercase letters, digits and hyphens')
  .refine((value) => !value.startsWith('-') && !value.endsWith('-'), {
    error: 'may not start or end with a hyphen',
  });

export const channelTopicSchema = z.string().trim().max(limits.channelTopicMax);

/**
 * Category names are presentation only, so they are permissive where channel
 * names are not: a category is a heading in the sidebar, never part of a URL
 * or a mention, so there is nothing for a slug to protect.
 */
export const categoryNameSchema = z
  .string()
  .trim()
  .min(limits.categoryNameMin, 'must not be empty')
  .max(limits.categoryNameMax, `must be at most ${limits.categoryNameMax} characters`)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), {
    error: 'must not contain control characters',
  });

/**
 * Invite codes.
 *
 * URL-safe base64 characters so a code can be pasted into a link unescaped,
 * and case-sensitive so a shorter code carries the same entropy. Unlike a join
 * code, this is never meant to be read aloud -- it is meant to be copied.
 */
export const inviteCodeSchema = z
  .string()
  .trim()
  .min(limits.inviteCodeMin)
  .max(limits.inviteCodeMax)
  .regex(/^[A-Za-z0-9_-]+$/u, 'is not a valid invite code');

/** Non-negative ordering position within a sidebar list. */
export const positionSchema = z.number().int().nonnegative();

/**
 * Message body.
 *
 * Trimmed and required to be non-empty, so a message of only whitespace is
 * rejected rather than rendering as a blank row. Content is stored and
 * returned verbatim — never pre-rendered to HTML — so the client is the only
 * place that decides how to display it, and injection has no server-side
 * surface.
 */
export const messageContentSchema = z
  .string()
  .trim()
  .min(1, 'must not be empty')
  .max(limits.messageContentMax, `must be at most ${limits.messageContentMax} characters`);

/**
 * Client-generated idempotency key for sends.
 *
 * The client keeps the same key across retries, so a message delivered twice
 * because of a flaky network resolves to one row instead of a duplicate.
 */
export const idempotencyKeySchema = z.uuid({ error: 'idempotencyKey must be a UUID' });

/** ISO-8601 instants on the wire; `timestamptz` in Postgres. */
export const isoTimestampSchema = z.iso.datetime({ offset: true });

/**
 * Opaque pagination cursor.
 *
 * Opaque on purpose: it currently encodes a message id, but keeping clients
 * from parsing it leaves room to add a shard or partition hint later without
 * breaking them.
 */
export const cursorSchema = z.string().min(1).max(256);

export const paginationDirectionSchema = z.enum(['before', 'after']);
export type PaginationDirection = z.infer<typeof paginationDirectionSchema>;
