import { communityRoleRank, type CommunityRole } from '@rook/contracts';

/**
 * Capability resolution.
 *
 * Every authorisation decision in the API goes through `can()`. The point is
 * not that the current rules are complicated — they are not — but that they
 * live in exactly one place, so:
 *
 *   * a route cannot invent its own interpretation of what "admin" means;
 *   * the rules are unit-testable without a database or an HTTP server;
 *   * replacing the role enum with granular permission bits later changes this
 *     file and nothing else.
 *
 * Roles are ordered (`member` < `admin` < `owner`), so most rules reduce to a
 * minimum-rank check. The exceptions are the capabilities where ownership of
 * the *object* matters more than rank — editing your own message, for example.
 */

export const capabilities = [
  'community:view',
  'community:invite',
  'community:update',
  'community:delete',
  'channel:view',
  'channel:create',
  'channel:update',
  'channel:delete',
  'message:read',
  'message:send',
  'message:edit_own',
  'message:delete_own',
  'message:delete_any',
  'media:upload',
] as const;

export type Capability = (typeof capabilities)[number];

/** Minimum role required for each capability. */
const minimumRole: Readonly<Record<Capability, CommunityRole>> = {
  'community:view': 'member',
  'community:invite': 'member',
  'community:update': 'admin',
  'community:delete': 'owner',

  'channel:view': 'member',
  // Deliberately 'member', matching how small communities actually work: the
  // alternative makes a three-person community wait on its owner to add a
  // channel. Tightening it later is a one-word change here.
  'channel:create': 'member',
  'channel:update': 'admin',
  'channel:delete': 'admin',

  'message:read': 'member',
  'message:send': 'member',
  'message:edit_own': 'member',
  'message:delete_own': 'member',
  // Moderation: removing someone else's message.
  'message:delete_any': 'admin',

  'media:upload': 'member',
};

/** The caller's authorisation context for a community. */
export interface AuthorizationContext {
  readonly role: CommunityRole;
}

export function hasAtLeastRole(role: CommunityRole, required: CommunityRole): boolean {
  return communityRoleRank[role] >= communityRoleRank[required];
}

/** True when a member with `context.role` may perform `capability`. */
export function can(context: AuthorizationContext, capability: Capability): boolean {
  return hasAtLeastRole(context.role, minimumRole[capability]);
}

/**
 * Whether the caller may edit a specific message.
 *
 * Editing is author-only regardless of role: an admin rewriting someone
 * else's words would be worse than deleting them, because the result still
 * carries the original author's name. Deletion is the moderation tool.
 */
export function canEditMessage(
  context: AuthorizationContext,
  options: { authorId: string; viewerId: string; isDeleted: boolean },
): boolean {
  if (options.isDeleted) return false;
  if (options.authorId !== options.viewerId) return false;
  return can(context, 'message:edit_own');
}

/** Deletable by its author, or by a moderator with `message:delete_any`. */
export function canDeleteMessage(
  context: AuthorizationContext,
  options: { authorId: string; viewerId: string; isDeleted: boolean },
): boolean {
  if (options.isDeleted) return false;

  if (options.authorId === options.viewerId) {
    return can(context, 'message:delete_own');
  }
  return can(context, 'message:delete_any');
}

/** The capabilities a role holds, for sending to the client to drive the UI. */
export function capabilitiesFor(role: CommunityRole): Capability[] {
  return capabilities.filter((capability) => can({ role }, capability));
}
