import type { CommunityId, CommunityInvite, InviteId, UserId } from '@rook/contracts';
import { raw, sql } from '../sql.js';
import type { Queryable } from '../pool.js';
import { newInviteId } from '../ids.js';
import { isUniqueViolation } from '../errors.js';
import { columns, toCommunityInvite, type CommunityInviteRow } from '../internal/rows.js';

/**
 * Invite persistence.
 *
 * `consume` is the method that carries the weight here. Validating an invite
 * and then incrementing its use count as two statements is a classic race: two
 * people redeem the last use of a one-use invite at the same time, both read
 * `uses = 0`, and both get in. So the check and the increment are a single
 * conditional UPDATE — the `where` clause *is* the validation, and Postgres
 * row locking makes exactly one of the two concurrent updates match.
 *
 * Expiry is evaluated with `now()` in SQL rather than a timestamp passed in
 * from the application, so the decision is made against the database's clock.
 * With several API instances, each with its own slightly skewed clock, that is
 * the only reading all of them agree on.
 */

export interface CreateInviteInput {
  readonly communityId: CommunityId;
  readonly code: string;
  readonly createdBy: UserId;
  readonly expiresAt: Date | null;
  readonly maxUses: number | null;
}

export type ConsumeInviteResult =
  | { readonly ok: true; readonly communityId: CommunityId; readonly inviteId: InviteId }
  | { readonly ok: false; readonly reason: 'invalid' | 'expired' | 'exhausted' | 'revoked' };

/** What an invite resolves to for someone who is not a member yet. */
export interface InvitePreviewRecord {
  readonly inviteId: InviteId;
  readonly communityId: CommunityId;
  readonly communityName: string;
  readonly memberCount: number;
  readonly inviterId: UserId;
  readonly inviterDisplayName: string;
}

export interface InviteRepository {
  create: (input: CreateInviteInput) => Promise<CommunityInvite>;
  listForCommunity: (communityId: CommunityId) => Promise<CommunityInvite[]>;
  findById: (communityId: CommunityId, inviteId: InviteId) => Promise<CommunityInvite | undefined>;
  /** Resolves a code for a join prompt, without consuming a use. */
  preview: (code: string) => Promise<InvitePreviewRecord | undefined>;
  /**
   * The community a code belongs to, whatever state the invite is in.
   *
   * Separate from `preview` because `preview` deliberately ignores spent,
   * expired and revoked invites — and the one caller that needs to look past
   * that is the "are you already a member" check: someone who joined through a
   * one-use link and opens it again must be taken to the community, not told
   * the link is used up.
   */
  findCommunityByCode: (code: string) => Promise<CommunityId | undefined>;
  /** Atomically validates and claims one use. */
  consume: (code: string) => Promise<ConsumeInviteResult>;
  /** Returns undefined when the invite does not exist in this community. */
  revoke: (communityId: CommunityId, inviteId: InviteId) => Promise<CommunityInvite | undefined>;
  /** Active invites only, for enforcing the per-community cap. */
  countActive: (communityId: CommunityId) => Promise<number>;
}

/** Invites that could still admit someone, as a reusable predicate. */
const activePredicate = `
  inv.revoked_at is null
  and (inv.expires_at is null or inv.expires_at > now())
  and (inv.max_uses is null or inv.uses < inv.max_uses)
`;

export function createInviteRepository(db: Queryable): InviteRepository {
  async function load(
    communityId: CommunityId,
    inviteId: InviteId,
  ): Promise<CommunityInvite | undefined> {
    const result = await db.query<CommunityInviteRow>(
      sql`
        select ${raw(columns.invite)}
        from community_invites inv
        join users cu on cu.id = inv.created_by
        where inv.id = ${inviteId} and inv.community_id = ${communityId}
      `,
      'invites.findById',
    );

    const row = result.rows[0];
    return row === undefined ? undefined : toCommunityInvite(row, new Date());
  }

  return {
    async create(input) {
      const id = newInviteId();

      try {
        await db.query(
          sql`
            insert into community_invites (
              id, community_id, code, created_by, expires_at, max_uses
            )
            values (
              ${id},
              ${input.communityId},
              ${input.code},
              ${input.createdBy},
              ${input.expiresAt},
              ${input.maxUses}
            )
          `,
          'invites.create',
        );
      } catch (error) {
        if (isUniqueViolation(error, 'community_invites_code_key')) {
          // 72 bits of entropy makes this effectively unreachable. Surfaced as
          // a thrown error rather than retried in a loop, because reaching it
          // means the code generator is broken, and silently retrying would
          // hide that.
          throw new Error('invite code collided; the code generator may be misconfigured', {
            cause: error,
          });
        }
        throw error;
      }

      const created = await load(input.communityId, id);
      if (created === undefined) {
        throw new Error('invite was created but could not be read back');
      }
      return created;
    },

    async listForCommunity(communityId) {
      const result = await db.query<CommunityInviteRow>(
        sql`
          select ${raw(columns.invite)}
          from community_invites inv
          join users cu on cu.id = inv.created_by
          where inv.community_id = ${communityId}
          order by inv.id desc
        `,
        'invites.listForCommunity',
      );

      // One `now` for the whole page, so two invites expiring in the same
      // millisecond cannot be reported inconsistently within one response.
      const now = new Date();
      return result.rows.map((row) => toCommunityInvite(row, now));
    },

    findById: load,

    async findCommunityByCode(code) {
      const result = await db.query<{ community_id: string }>(
        sql`select inv.community_id from community_invites inv where inv.code = ${code}`,
        'invites.findCommunityByCode',
      );

      const row = result.rows[0];
      return row === undefined ? undefined : (row.community_id as CommunityId);
    },

    async preview(code) {
      const result = await db.query<{
        invite_id: string;
        community_id: string;
        community_name: string;
        member_count: number;
        inviter_id: string;
        inviter_display_name: string;
      }>(
        sql`
          select inv.id            as invite_id,
                 c.id              as community_id,
                 c.name            as community_name,
                 (select count(*) from community_members cm where cm.community_id = c.id)::int
                                   as member_count,
                 u.id              as inviter_id,
                 u.display_name    as inviter_display_name
          from community_invites inv
          join communities c on c.id = inv.community_id
          join users u on u.id = inv.created_by
          where inv.code = ${code} and ${raw(activePredicate)}
        `,
        'invites.preview',
      );

      const row = result.rows[0];
      if (row === undefined) return undefined;

      return {
        inviteId: row.invite_id as InviteId,
        communityId: row.community_id as CommunityId,
        communityName: row.community_name,
        memberCount: row.member_count,
        inviterId: row.inviter_id as UserId,
        inviterDisplayName: row.inviter_display_name,
      };
    },

    async consume(code) {
      // The whole validation is the `where` clause, so the check and the
      // increment cannot be separated. Two concurrent redemptions of a
      // one-use invite serialise on the row: the second finds `uses` already
      // at `max_uses` and matches nothing.
      const claimed = await db.query<{ id: string; community_id: string }>(
        sql`
          update community_invites as inv
          set uses = inv.uses + 1
          where inv.code = ${code} and ${raw(activePredicate)}
          returning inv.id, inv.community_id
        `,
        'invites.consume',
      );

      const row = claimed.rows[0];
      if (row !== undefined) {
        return {
          ok: true,
          communityId: row.community_id as CommunityId,
          inviteId: row.id as InviteId,
        };
      }

      // Nothing was claimed. Read the row back to say *why*, so the client can
      // distinguish "that link has expired" from "that link is not valid" —
      // which are very different things to tell someone holding a link.
      const existing = await db.query<{
        revoked_at: Date | null;
        expires_at: Date | null;
        max_uses: number | null;
        uses: number;
      }>(
        sql`
          select inv.revoked_at, inv.expires_at, inv.max_uses, inv.uses
          from community_invites inv
          where inv.code = ${code}
        `,
        'invites.consumeDiagnose',
      );

      const detail = existing.rows[0];
      if (detail === undefined) return { ok: false, reason: 'invalid' };
      if (detail.revoked_at !== null) return { ok: false, reason: 'revoked' };
      if (detail.expires_at !== null && detail.expires_at.getTime() <= Date.now()) {
        return { ok: false, reason: 'expired' };
      }
      if (detail.max_uses !== null && detail.uses >= detail.max_uses) {
        return { ok: false, reason: 'exhausted' };
      }

      // The invite became usable again between the update and this read, which
      // cannot happen with the current fields. Reported as invalid rather than
      // retried, so a caller never loops here.
      return { ok: false, reason: 'invalid' };
    },

    async revoke(communityId, inviteId) {
      // Idempotent: revoking an already-revoked invite keeps the original
      // timestamp rather than moving it, so the audit log and the row agree.
      const result = await db.query<{ id: string }>(
        sql`
          update community_invites as inv
          set revoked_at = coalesce(inv.revoked_at, now())
          where inv.id = ${inviteId} and inv.community_id = ${communityId}
          returning inv.id
        `,
        'invites.revoke',
      );

      if (result.rows[0] === undefined) return undefined;
      return load(communityId, inviteId);
    },

    async countActive(communityId) {
      const result = await db.query<{ count: number }>(
        sql`
          select count(*)::int as count
          from community_invites inv
          where inv.community_id = ${communityId} and ${raw(activePredicate)}
        `,
        'invites.countActive',
      );

      return result.rows[0]?.count ?? 0;
    },
  };
}
