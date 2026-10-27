import { communityRoleRank, type CommunityRole } from './entities/community.js';

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
 * This lives in `contracts` rather than in `auth` so the desktop client can
 * resolve the *same* rules the server enforces. That is what keeps the UI from
 * offering an action the API will refuse — a button that fails on click reads
 * as a bug, not as a permission boundary. It costs nothing to share: these are
 * pure functions over an enum, with no dependency on hashing, tokens or a
 * database, so including them in the client bundle pulls in nothing else.
 *
 * Sharing them is safe because they are not the enforcement point. The server
 * runs these checks against a membership it looked up itself; the client runs
 * them against a role the server told it about, purely to decide what to draw.
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
  'category:create',
  'category:update',
  'category:delete',
  'member:manage_roles',
  'member:kick',
  'invite:create',
  'invite:revoke',
  'audit_log:view',
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

  // Categories are sidebar structure for the whole community, so unlike
  // creating a channel this is an admin concern: one member reorganising
  // everyone else's sidebar is not a small change.
  'category:create': 'admin',
  'category:update': 'admin',
  'category:delete': 'admin',

  // Moderation. `member:kick` is admin, but see `canManageMember` below: rank
  // alone is not sufficient, because an admin must not be able to kick a peer.
  'member:manage_roles': 'admin',
  'member:kick': 'admin',

  // Any member may invite, matching how small communities actually work, but
  // only an admin may revoke someone else's invite.
  'invite:create': 'member',
  'invite:revoke': 'admin',

  // The log records administrative action, so it is readable by the people who
  // can take it. Exposing it to every member would turn "who demoted me" into
  // a question the UI answers, which is a moderation problem, not a feature.
  'audit_log:view': 'admin',

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

/**
 * Whether `actor` may act on `target` within the same community.
 *
 * This is the rule that a minimum-rank check cannot express, and the one that
 * matters most once there is a role management UI: an admin outranks a member,
 * but **not another admin**. Without a strict-inequality check, any admin could
 * demote or remove every other admin, and the first disagreement between two
 * admins becomes a race to click first. The owner is above everyone, and
 * nobody — including the owner — may act on themselves through this path.
 *
 * Self-action is excluded so the UI never offers "demote yourself" or "kick
 * yourself" as an administrative action. Leaving a community voluntarily is a
 * separate operation with separate confirmation.
 */
export function canManageMember(
  actor: { role: CommunityRole; userId: string },
  target: { role: CommunityRole; userId: string },
): boolean {
  if (actor.userId === target.userId) return false;
  // The owner cannot be demoted or removed by anyone: ownership transfer is a
  // deliberate, separate operation and is out of scope in this release.
  if (target.role === 'owner') return false;
  return communityRoleRank[actor.role] > communityRoleRank[target.role];
}

/**
 * Whether `actor` may assign `role`.
 *
 * Granting a role at or above your own is refused, so an admin cannot promote
 * someone to a position from which they could then act on the admin who
 * promoted them. `owner` is unassignable here by construction — it is not in
 * the assignable set the contract exposes — but the rank check covers it
 * regardless, so a hand-written request cannot sneak it past.
 */
export function canAssignRole(actorRole: CommunityRole, role: CommunityRole): boolean {
  if (!can({ role: actorRole }, 'member:manage_roles')) return false;
  return communityRoleRank[actorRole] > communityRoleRank[role];
}

/** The capabilities a role holds, for sending to the client to drive the UI. */
export function capabilitiesFor(role: CommunityRole): Capability[] {
  return capabilities.filter((capability) => can({ role }, capability));
}
