import type {
  ChannelId,
  MediaAssetId,
  Message,
  MessageId,
  PaginationDirection,
  UserId,
} from '@rook/contracts';
import { empty, raw, sortDirection, sql } from '../sql.js';
import type { Queryable } from '../pool.js';
import { newMessageId } from '../ids.js';
import { encodeCursor } from '../cursor.js';
import { toMessage, type MessageRow } from '../internal/rows.js';

/**
 * Message persistence: history reads, sends, edits and deletes.
 *
 * Two things here are the core of the whole data design.
 *
 * **Cursor pagination.** History is read with `where channel_id = $1 and
 * id < $cursor order by id desc limit $n`, which the composite index
 * `(channel_id, id desc)` satisfies with a backwards index scan straight to
 * the cursor. Cost is proportional to the page size, not to how deep into
 * history you are — unlike `offset`, which walks and discards every preceding
 * row, and which also duplicates or skips rows when new messages arrive
 * mid-scroll.
 *
 * **One query per page, not one per message.** Author and attachments are
 * resolved in the same statement: the author by join, the attachments by a
 * lateral aggregate. The obvious alternative, mapping over messages and
 * fetching each one's attachments, turns a 50-message page into 51 queries.
 * The lateral keeps it at one regardless of page size.
 */

/**
 * Message rows with their author and attachments, as one flat row shape.
 *
 * The attachment aggregate runs per message inside a LATERAL rather than as a
 * top-level join, so attachments cannot fan out and duplicate message rows.
 */
const messageSelect = `
  m.id, m.channel_id, m.content, m.created_at, m.edited_at, m.deleted_at,
  m.mentions_everyone,
  mentioned.mentioned_user_ids,
  a.id              as author_id,
  a.username        as author_username,
  a.display_name    as author_display_name,
  a.avatar_asset_id as author_avatar_asset_id,
  a.created_at      as author_created_at,
  att.attachments
`;

const messageFrom = `
  from messages m
  join users a on a.id = m.author_id
  left join lateral (
    select json_agg(
             json_build_object(
               'id', ma.id,
               'owner_id', ma.owner_id,
               'status', ma.status,
               'content_type', ma.content_type,
               'byte_size', ma.byte_size,
               'width', ma.width,
               'height', ma.height,
               'failure_reason', ma.failure_reason,
               'created_at', ma.created_at,
               'updated_at', ma.updated_at,
               'variants', (
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
               )
             )
             order by att_link.position
           ) as attachments
    from message_attachments att_link
    join media_assets ma on ma.id = att_link.asset_id
    where att_link.message_id = m.id
  ) att on true
  -- Mentions aggregated per message in their own lateral, for the same reason
  -- as attachments: a top-level join would fan out and duplicate message rows,
  -- and a follow-up query per message would be an N+1 on history loads.
  left join lateral (
    select array_agg(mm.user_id) as mentioned_user_ids
    from message_mentions mm
    where mm.message_id = m.id
  ) mentioned on true
`;

export interface SendMessageInput {
  readonly channelId: ChannelId;
  readonly authorId: UserId;
  readonly content: string | null;
  readonly attachmentIds: readonly MediaAssetId[];
  readonly idempotencyKey: string;
  /**
   * Usernames the content mentions, parsed by the caller.
   *
   * Passed in rather than parsed here so the repository stays free of content
   * interpretation, and so the service and the client share one tokeniser (see
   * `parseMentions` in @rook/contracts). Names that do not resolve to a member
   * of this channel's community are dropped by the insert below.
   */
  readonly mentionUsernames: readonly string[];
  readonly mentionsEveryone: boolean;
}

export interface SendMessageResult {
  readonly message: Message;
  /**
   * False when this exact request had already been persisted, i.e. the
   * idempotency key matched an existing row.
   *
   * Callers use this to avoid publishing a duplicate realtime event for a
   * retried send.
   */
  readonly created: boolean;
}

export interface MessagePage {
  readonly messages: Message[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface MessageRepository {
  /** Idempotent on (channelId, authorId, idempotencyKey). */
  send: (input: SendMessageInput) => Promise<SendMessageResult>;
  findById: (id: MessageId) => Promise<Message | undefined>;
  /** A page of history. Items are always returned oldest-first. */
  listPage: (
    channelId: ChannelId,
    options: {
      cursorId?: string | undefined;
      direction: PaginationDirection;
      limit: number;
    },
  ) => Promise<MessagePage>;
  /**
   * Edits content and re-resolves its mentions.
   *
   * Re-resolving matters: adding someone's name in an edit should notify them,
   * and removing it should stop a stale mention badge pointing at a message
   * that no longer mentions them.
   *
   * Returns undefined if the message is missing or deleted.
   */
  edit: (
    id: MessageId,
    content: string,
    mentions: { usernames: readonly string[]; everyone: boolean },
  ) => Promise<Message | undefined>;
  /** Soft-deletes, leaving a tombstone. Returns the deletion time. */
  softDelete: (id: MessageId) => Promise<{ deletedAt: Date } | undefined>;
}

export function createMessageRepository(db: Queryable): MessageRepository {
  async function requireById(id: MessageId, context: string): Promise<Message> {
    const message = await loadById(id);
    if (message === undefined) {
      throw new Error(`${context}: message ${id} could not be read back`);
    }
    return message;
  }

  async function loadById(id: MessageId): Promise<Message | undefined> {
    const result = await db.query<MessageRow>(
      sql`select ${raw(messageSelect)} ${raw(messageFrom)} where m.id = ${id}`,
      'messages.findById',
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toMessage(row);
  }

  return {
    async send(input) {
      const id = newMessageId();

      // `on conflict do nothing` makes the insert idempotent without a
      // pre-check, and without the race a pre-check would have. An empty
      // result means the key was already used, so we return the original row
      // rather than creating a second message.
      const inserted = await db.query<{ id: string }>(
        sql`
          insert into messages (
            id, channel_id, author_id, content, idempotency_key, mentions_everyone
          )
          values (
            ${id}, ${input.channelId}, ${input.authorId}, ${input.content},
            ${input.idempotencyKey}, ${input.mentionsEveryone}
          )
          on conflict (channel_id, author_id, idempotency_key) do nothing
          returning id
        `,
        'messages.send',
      );

      const insertedRow = inserted.rows[0];

      if (insertedRow === undefined) {
        // Retry of an earlier successful send.
        const existing = await db.query<{ id: string }>(
          sql`
            select m.id from messages m
            where m.channel_id = ${input.channelId}
              and m.author_id = ${input.authorId}
              and m.idempotency_key = ${input.idempotencyKey}
          `,
          'messages.findByIdempotencyKey',
        );

        const existingId = existing.rows[0]?.id;
        if (existingId === undefined) {
          // The conflicting row vanished between the two statements, which
          // should be impossible: messages are never hard-deleted.
          throw new Error('message insert conflicted but no existing row was found');
        }

        return {
          message: await requireById(existingId as MessageId, 'messages.send(retry)'),
          created: false,
        };
      }

      if (input.mentionUsernames.length > 0) {
        // Usernames are resolved to ids *in the insert*, joined through
        // community_members. That join is the authorisation check: mentioning
        // someone who is not a member of this channel's community inserts
        // nothing, so a mention can never notify a stranger or be used to probe
        // whether a username exists.
        //
        // The author is excluded because a message never mentions its own
        // sender into their own unread badge.
        await db.query(
          sql`
            insert into message_mentions (message_id, user_id, channel_id)
            select ${id}, u.id, ${input.channelId}
            from unnest(${[...input.mentionUsernames]}::text[]) as m(username)
            join users u on u.username = m.username
            join channels ch on ch.id = ${input.channelId}
            join community_members cm
              on cm.community_id = ch.community_id and cm.user_id = u.id
            where u.id <> ${input.authorId}
            on conflict (message_id, user_id) do nothing
          `,
          'messages.attachMentions',
        );
      }

      if (input.attachmentIds.length > 0) {
        // One statement for all attachments, with ordinality preserving the
        // order the user attached them in.
        await db.query(
          sql`
            insert into message_attachments (message_id, asset_id, position)
            select ${id}, asset_id, ordinality - 1
            from unnest(${[...input.attachmentIds]}::uuid[]) with ordinality as t(asset_id, ordinality)
          `,
          'messages.attachAssets',
        );
      }

      return { message: await requireById(id, 'messages.send'), created: true };
    },

    findById: loadById,

    async listPage(channelId, options) {
      // Read one more row than asked for: its presence is what `hasMore`
      // reports, which avoids a separate count over the channel.
      const fetchLimit = options.limit + 1;

      // Walking back through history reads descending from the cursor;
      // catching up after a reconnect reads ascending.
      const scanDescending = options.direction === 'before';

      const cursorFilter =
        options.cursorId === undefined
          ? empty
          : scanDescending
            ? sql`and m.id < ${options.cursorId}`
            : sql`and m.id > ${options.cursorId}`;

      const result = await db.query<MessageRow>(
        sql`
          select ${raw(messageSelect)}
          ${raw(messageFrom)}
          where m.channel_id = ${channelId}
          ${cursorFilter}
          order by m.id ${sortDirection(scanDescending ? 'desc' : 'asc')}
          limit ${fetchLimit}
        `,
        'messages.listPage',
      );

      const hasMore = result.rows.length > options.limit;
      const page = hasMore ? result.rows.slice(0, options.limit) : result.rows;

      // The cursor continues in the scan direction, so it is taken from the
      // last row read — before the rows are reordered for the response.
      const cursorRow = page[page.length - 1];

      // Always hand back oldest-first so the client can append or prepend
      // without reversing, whichever direction it asked for.
      const ordered = scanDescending ? [...page].reverse() : page;

      return {
        messages: ordered.map(toMessage),
        nextCursor: hasMore && cursorRow !== undefined ? encodeCursor(cursorRow.id) : null,
        hasMore,
      };
    },

    async edit(id, content, mentions) {
      const result = await db.query<{ channel_id: string; author_id: string }>(
        sql`
          update messages
          set content = ${content},
              edited_at = now(),
              mentions_everyone = ${mentions.everyone}
          where id = ${id} and deleted_at is null
          returning channel_id, author_id
        `,
        'messages.edit',
      );

      const row = result.rows[0];
      if (row === undefined) return undefined;

      // Replace rather than merge: a name removed from the text must lose its
      // mention row, which a merge would leave behind for ever.
      await db.query(
        sql`delete from message_mentions where message_id = ${id}`,
        'messages.clearMentions',
      );

      if (mentions.usernames.length > 0) {
        await db.query(
          sql`
            insert into message_mentions (message_id, user_id, channel_id)
            select ${id}, u.id, ${row.channel_id}
            from unnest(${[...mentions.usernames]}::text[]) as m(username)
            join users u on u.username = m.username
            join channels ch on ch.id = ${row.channel_id}
            join community_members cm
              on cm.community_id = ch.community_id and cm.user_id = u.id
            where u.id <> ${row.author_id}
            on conflict (message_id, user_id) do nothing
          `,
          'messages.reattachMentions',
        );
      }

      return loadById(id);
    },

    async softDelete(id) {
      // Content is cleared, not just flagged: a deleted message should not
      // remain readable in the database. The row survives as a tombstone so
      // clients are told it is gone and pagination stays consistent.
      const result = await db.query<{ deleted_at: Date }>(
        sql`
          update messages
          set deleted_at = now(), content = null, mentions_everyone = false
          where id = ${id} and deleted_at is null
          returning deleted_at
        `,
        'messages.softDelete',
      );

      const row = result.rows[0];
      if (row === undefined) return undefined;

      // Mentions go with the content. A deleted message must not keep showing
      // as an unread mention — there would be nothing to read when you got
      // there, which is the most confusing possible badge.
      await db.query(
        sql`delete from message_mentions where message_id = ${id}`,
        'messages.clearMentionsOnDelete',
      );

      return { deletedAt: row.deleted_at };
    },
  };
}
